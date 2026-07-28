// The reactive core of the graphs view: which series are plotted, over what
// time range, what's selected, and the caches behind all of it.
//
// Same ownership rule as the picker (docs/design.md): shared UI state lives
// here, not in the components. The components read `$derived` values and call
// the mutation methods below.
//
// URL sync is deliberately *not* an `$effect`. Every mutation decides for
// itself whether it should create a history entry — a drag across the
// overview graph must not push fifty of them — and an effect can't see that
// distinction. See `syncUrl`.

import {
  fetchJob,
  fetchPush,
  fetchRepositories,
  fetchSummary,
  type Job,
  type Push,
  type RepositoryInfo,
} from './graphApi';
import {
  buildSeriesData,
  EMPTY_SERIES_DATA,
  metaFromSummary,
  resolvePoint,
  seriesKey,
  type PushGroup,
  type Run,
  type SeriesData,
  type SeriesMeta,
  type SeriesRef,
} from './graphData';
import { colorForIndex, lowerBound, padDomain, unionRange, type Range } from './chart';
import type { Filter } from './filter';
import { clampSpan, defaultSpan, presetSpan, roundSpan, type Span } from './timeRange';
import {
  parseViewState,
  serializeViewState,
  type SelectedPoint,
  type ViewState,
} from './urlState';

// One plotted series: its identity, its color, and whatever we know about it.
export type SeriesEntry = {
  ref: SeriesRef;
  key: string;
  color: string;
  meta: SeriesMeta | null;
  data: SeriesData;
  loading: boolean;
  error: string | null;
};

// Everything the details pane needs about the current selection.
export type Selection = {
  entry: SeriesEntry;
  push: PushGroup;
  run: Run;
  replicateIndex: number;
  value: number;
};

type LoadedSeries = { meta: SeriesMeta; data: SeriesData };

function dataKey(ref: SeriesRef, span: Span): string {
  return `${seriesKey(ref)}|${span.start}|${span.end}`;
}

export class AppState {
  // ---- View state (mirrored in the URL) ---------------------------------
  seriesRefs = $state<SeriesRef[]>([]);
  range = $state<Span>(defaultSpan(Date.now()));
  // null means "the detail graph shows the whole range".
  zoom = $state<Span | null>(null);
  selectedPoint = $state<SelectedPoint | null>(null);
  pickerOpen = $state(false);
  pickerFilter = $state<Filter>({ chips: [], text: '' });

  // ---- Caches -----------------------------------------------------------
  // Keyed by `${repo}|${signatureId}|${rangeStart}|${rangeEnd}`: the tuple
  // that identifies one API response. Entries outside the current (series ×
  // range) set are pruned — see `pruneSeriesCache` for why holding them is
  // not an option.
  private seriesCache = $state(new Map<string, LoadedSeries>());
  private loadingKeys = $state(new Set<string>());
  private errorsByKey = $state(new Map<string, string>());
  // Abort handles for in-flight series fetches, so a range change can cancel
  // requests nobody is waiting for any more. Not reactive: purely bookkeeping.
  private inFlight = new Map<string, AbortController>();
  // Detail lookups that have been issued but haven't landed yet. Without this,
  // the selection effect re-firing before a fetch resolves issues a duplicate.
  private detailRequests = new Set<string>();

  pushCache = $state(new Map<string, Push>());
  jobCache = $state(new Map<string, Job>());
  repoInfo = $state(new Map<string, RepositoryInfo>());

  // ---- Derived ----------------------------------------------------------
  series = $derived.by((): SeriesEntry[] =>
    this.seriesRefs.map((ref, i) => {
      const key = dataKey(ref, this.range);
      const loaded = this.seriesCache.get(key);
      return {
        ref,
        key: seriesKey(ref),
        color: colorForIndex(i),
        meta: loaded?.meta ?? null,
        data: loaded?.data ?? EMPTY_SERIES_DATA,
        loading: this.loadingKeys.has(key),
        error: this.errorsByKey.get(key) ?? null,
      };
    }),
  );

  anyLoading = $derived(this.series.some((s) => s.loading));
  loadingCount = $derived(this.series.filter((s) => s.loading).length);
  hasData = $derived(this.series.some((s) => s.data.points.length > 0));
  failedSeries = $derived(this.series.filter((s) => s.error !== null));

  // The detail graph's x domain.
  detailSpan = $derived<Span>(this.zoom ?? this.range);

  // Shared y domain across every visible series, over the whole range. The
  // overview graph uses this one.
  fullYDomain = $derived.by((): Range => {
    const e = extentOf(this.series, null);
    return padDomain(e.min, e.max);
  });

  // The detail graph rescales y to what's actually in the zoomed window, so
  // zooming in on a flat stretch doesn't leave it as a horizontal line at the
  // bottom of the plot. Treeherder keeps a y zoom in its URL instead; we
  // derive it, which is one less thing to get out of sync.
  detailYDomain = $derived.by((): Range => {
    const e = extentOf(this.series, this.detailSpan);
    return padDomain(e.min, e.max);
  });

  // Resolves the URL-level selection triple against loaded data. Null when
  // nothing is selected or the point isn't in the current range.
  selection = $derived.by((): Selection | null => {
    const sel = this.selectedPoint;
    if (!sel) return null;
    const entry = this.series.find(
      (s) => s.ref.repository === sel.repository && s.ref.signatureId === sel.signatureId,
    );
    if (!entry) return null;
    const resolved = resolvePoint(entry.data, sel.datumId, sel.replicateIndex);
    if (!resolved) return null;
    return {
      entry,
      push: resolved.push,
      run: resolved.run,
      replicateIndex: resolved.replicateIndex,
      value: resolved.value,
    };
  });

  // Push / job details for the selection, once fetched.
  selectedPush = $derived.by((): Push | null => {
    const sel = this.selection;
    if (!sel) return null;
    return this.pushCache.get(`${sel.entry.ref.repository}|${sel.push.pushId}`) ?? null;
  });

  selectedJob = $derived.by((): Job | null => {
    const sel = this.selection;
    if (!sel) return null;
    return this.jobCache.get(`${sel.entry.ref.repository}|${sel.run.jobId}`) ?? null;
  });

  // The push immediately before the selected one in the same series — the
  // "what landed in between" link needs it.
  previousPush = $derived.by((): PushGroup | null => {
    const sel = this.selection;
    if (!sel) return null;
    const pushes = sel.entry.data.pushes;
    const i = pushes.indexOf(sel.push);
    return i > 0 ? pushes[i - 1] : null;
  });

  constructor(search = '', now = Date.now()) {
    this.applyViewState(parseViewState(search), now);

    // Fetch data for every (series, range) pair we don't have yet.
    $effect(() => {
      const span = this.range;
      for (const ref of this.seriesRefs) {
        const key = dataKey(ref, span);
        // The error check is load-bearing: a failed fetch leaves no cache
        // entry, so without it this effect would re-fire on the very state
        // change the failure caused and hammer the API forever. Recovery is
        // the explicit Retry action below.
        if (
          this.seriesCache.has(key) ||
          this.loadingKeys.has(key) ||
          this.errorsByKey.has(key)
        ) {
          continue;
        }
        void this.loadSeries(ref, span, key);
      }
    });

    // Fetch push + job detail for the selection, lazily.
    $effect(() => {
      const sel = this.selection;
      if (!sel) return;
      const repo = sel.entry.ref.repository;
      void this.loadPush(repo, sel.push.pushId);
      void this.loadJob(repo, sel.run.jobId);
    });

    // Repository metadata drives the hg/git-aware pushlog links.
    void this.loadRepositories();
  }

  // ---- Loading ----------------------------------------------------------
  private async loadSeries(ref: SeriesRef, span: Span, key: string): Promise<void> {
    this.loadingKeys = new Set(this.loadingKeys).add(key);
    const controller = new AbortController();
    this.inFlight.set(key, controller);
    try {
      const summary = await fetchSummary(
        ref.repository,
        ref.signatureId,
        ref.frameworkId,
        span.start,
        span.end,
        controller.signal,
      );
      const next = new Map(this.seriesCache);
      // A signature with no data in range still has metadata worth showing in
      // the legend, but the endpoint gives us nothing at all — fall back to a
      // placeholder so the row isn't stuck on "loading".
      next.set(key, {
        meta: summary
          ? metaFromSummary(summary)
          : {
              suite: `signature ${ref.signatureId}`,
              test: '',
              platform: '',
              application: '',
              measurementUnit: '',
              lowerIsBetter: true,
              name: '',
              options: '',
            },
        data: buildSeriesData(summary),
      });
      this.seriesCache = next;
      if (this.errorsByKey.has(key)) {
        const errs = new Map(this.errorsByKey);
        errs.delete(key);
        this.errorsByKey = errs;
      }
    } catch (e) {
      // An abort is us cancelling a fetch nobody wants any more, not a
      // failure to report.
      if (!controller.signal.aborted) {
        this.errorsByKey = new Map(this.errorsByKey).set(key, (e as Error).message);
      }
    } finally {
      this.inFlight.delete(key);
      const done = new Set(this.loadingKeys);
      done.delete(key);
      this.loadingKeys = done;
    }
  }

  private async loadPush(repository: string, pushId: number): Promise<void> {
    const key = `push|${repository}|${pushId}`;
    if (this.pushCache.has(`${repository}|${pushId}`) || this.detailRequests.has(key)) return;
    this.detailRequests.add(key);
    try {
      const push = await fetchPush(repository, pushId);
      this.pushCache = new Map(this.pushCache).set(`${repository}|${pushId}`, push);
    } catch {
      // The details pane degrades to "loading…" rather than showing an error:
      // a failed metadata lookup should never take the graph down with it.
    } finally {
      this.detailRequests.delete(key);
    }
  }

  private async loadJob(repository: string, jobId: number): Promise<void> {
    const key = `job|${repository}|${jobId}`;
    if (this.jobCache.has(`${repository}|${jobId}`) || this.detailRequests.has(key)) return;
    this.detailRequests.add(key);
    try {
      const job = await fetchJob(repository, jobId);
      this.jobCache = new Map(this.jobCache).set(`${repository}|${jobId}`, job);
    } catch {
      // As above.
    } finally {
      this.detailRequests.delete(key);
    }
  }

  // Drop series data that no longer belongs to any (current series, current
  // range) pair, and cancel fetches for it. Without this, every click on a
  // range preset leaves a full set of point arrays behind — megabytes each
  // for a wide range — for the lifetime of the tab.
  //
  // The cost is that going Back to a previous range refetches. That's a
  // predictable trade: bounded memory over a warm back button.
  private pruneSeriesCache(): void {
    const wanted = new Set(this.seriesRefs.map((ref) => dataKey(ref, this.range)));

    for (const [key, controller] of this.inFlight) {
      if (!wanted.has(key)) controller.abort();
    }
    const cache = new Map<string, LoadedSeries>();
    for (const [key, value] of this.seriesCache) {
      if (wanted.has(key)) cache.set(key, value);
    }
    if (cache.size !== this.seriesCache.size) this.seriesCache = cache;

    const errors = new Map<string, string>();
    for (const [key, value] of this.errorsByKey) {
      if (wanted.has(key)) errors.set(key, value);
    }
    if (errors.size !== this.errorsByKey.size) this.errorsByKey = errors;
  }

  private async loadRepositories(): Promise<void> {
    try {
      const repos = await fetchRepositories();
      this.repoInfo = new Map(repos.map((r) => [r.name, r]));
    } catch {
      // Without this the details pane falls back to treeherder-only links.
    }
  }

  // ---- Mutations --------------------------------------------------------
  addSeries(refs: SeriesRef[]): void {
    const next = [...this.seriesRefs];
    for (const ref of refs) {
      if (next.some((s) => s.repository === ref.repository && s.signatureId === ref.signatureId)) {
        continue;
      }
      next.push(ref);
    }
    this.seriesRefs = next;
    this.syncUrl('push');
  }

  removeSeries(ref: SeriesRef): void {
    this.seriesRefs = this.seriesRefs.filter(
      (s) => !(s.repository === ref.repository && s.signatureId === ref.signatureId),
    );
    // A selection belonging to the removed series is now meaningless.
    if (
      this.selectedPoint &&
      this.selectedPoint.repository === ref.repository &&
      this.selectedPoint.signatureId === ref.signatureId
    ) {
      this.selectedPoint = null;
    }
    this.pruneSeriesCache();
    this.syncUrl('push');
  }

  clearSeries(): void {
    this.seriesRefs = [];
    this.selectedPoint = null;
    this.pruneSeriesCache();
    this.syncUrl('push');
  }

  // Move a series up or down the list. Order decides both legend order and
  // color, so this is a real user-facing action rather than cosmetics.
  moveSeries(index: number, delta: number): void {
    const target = index + delta;
    if (index < 0 || index >= this.seriesRefs.length) return;
    if (target < 0 || target >= this.seriesRefs.length) return;
    const next = [...this.seriesRefs];
    [next[index], next[target]] = [next[target], next[index]];
    this.seriesRefs = next;
    this.syncUrl('push');
  }

  setRangePreset(seconds: number, now = Date.now()): void {
    this.setRange(presetSpan(seconds, now));
  }

  setRange(span: Span): void {
    const next = roundSpan(span);
    this.range = next;
    // A zoom expressed in absolute time may fall partly or wholly outside the
    // new range; clamp it, and drop it if it no longer narrows anything.
    this.zoom = this.zoom ? clampSpan(this.zoom, next) : null;
    this.pruneSeriesCache();
    this.syncUrl('push');
  }

  // `live` is true during a drag: update the view, but don't spam history.
  setZoom(span: Span | null, live = false): void {
    this.zoom = span ? clampSpan(span, this.range) : null;
    this.syncUrl(live ? 'replace' : 'push');
  }

  resetZoom(): void {
    this.setZoom(null);
  }

  // `mode` is 'replace' for keyboard stepping: holding an arrow key fires at
  // the key-repeat rate, and a history entry per repeat would bury whatever
  // the user actually wants to go back to.
  selectPoint(sel: SelectedPoint | null, mode: 'push' | 'replace' = 'push'): void {
    this.selectedPoint = sel;
    this.syncUrl(mode);
  }

  // Keyboard navigation. Left/right walk the selected series run by run;
  // up/down walk the replicates inside the current run. Stepping replicate by
  // replicate horizontally would mean twenty presses to cross one push.
  stepRun(delta: number): void {
    const sel = this.selection;
    if (!sel) {
      this.selectFirstPoint();
      return;
    }
    const runs = sel.entry.data.runs;
    const i = runs.indexOf(sel.run);
    if (i === -1) return;
    const next = runs[clampIndex(i + delta, runs.length)];
    this.selectPoint(
      {
        repository: sel.entry.ref.repository,
        signatureId: sel.entry.ref.signatureId,
        datumId: next.datumId,
        // Keep the replicate slot where possible, so walking a series compares
        // like with like instead of jumping around inside each run.
        replicateIndex: Math.min(sel.replicateIndex, next.values.length - 1),
      },
      'replace',
    );
  }

  stepReplicate(delta: number): void {
    const sel = this.selection;
    if (!sel) {
      this.selectFirstPoint();
      return;
    }
    this.selectPoint(
      {
        repository: sel.entry.ref.repository,
        signatureId: sel.entry.ref.signatureId,
        datumId: sel.run.datumId,
        replicateIndex: clampIndex(sel.replicateIndex + delta, sel.run.values.length),
      },
      'replace',
    );
  }

  private selectFirstPoint(): void {
    for (const entry of this.series) {
      const point = entry.data.points[0];
      if (!point) continue;
      this.selectPoint({
        repository: entry.ref.repository,
        signatureId: entry.ref.signatureId,
        datumId: point.datumId,
        replicateIndex: point.replicateIndex,
      });
      return;
    }
  }

  // Clearing the error lets the loading effect pick the series up again.
  retrySeries(ref: SeriesRef): void {
    const key = dataKey(ref, this.range);
    if (!this.errorsByKey.has(key)) return;
    const next = new Map(this.errorsByKey);
    next.delete(key);
    this.errorsByKey = next;
  }

  retryAllFailed(): void {
    if (this.errorsByKey.size === 0) return;
    this.errorsByKey = new Map();
  }

  setPickerOpen(open: boolean): void {
    this.pickerOpen = open;
    this.syncUrl('push');
  }

  // Called as the user types in the picker; replace rather than push so the
  // back button doesn't walk backwards through their keystrokes.
  setPickerFilter(filter: Filter): void {
    this.pickerFilter = filter;
    this.syncUrl('replace');
  }

  // ---- URL sync ---------------------------------------------------------
  viewState = $derived<ViewState>({
    series: this.seriesRefs,
    range: { start: this.range.start, end: this.range.end },
    zoom: this.zoom ? { start: this.zoom.start, end: this.zoom.end } : null,
    selected: this.selectedPoint,
    pickerOpen: this.pickerOpen,
    pickerFilter: this.pickerFilter,
  });

  // Set while applying a state parsed out of the URL, so the resulting
  // mutations don't write it straight back.
  private applying = false;

  syncUrl(mode: 'push' | 'replace'): void {
    if (this.applying || typeof history === 'undefined') return;
    const qs = serializeViewState(this.viewState);
    const url = qs ? `${location.pathname}?${qs}` : location.pathname;
    if (url === location.pathname + location.search) return;
    if (mode === 'push') history.pushState(null, '', url);
    else history.replaceState(null, '', url);
  }

  applyViewState(state: ViewState, now = Date.now()): void {
    this.applying = true;
    try {
      this.seriesRefs = state.series;
      this.range = state.range
        ? { start: state.range.start, end: state.range.end }
        : defaultSpan(now);
      this.zoom = state.zoom ? clampSpan(state.zoom, this.range) : null;
      this.selectedPoint = state.selected;
      this.pickerOpen = state.pickerOpen;
      this.pickerFilter = state.pickerFilter;
    } finally {
      this.applying = false;
    }
    this.pruneSeriesCache();
  }

  // Wired to `popstate` by App.svelte.
  onPopState(search: string): void {
    this.applyViewState(parseViewState(search));
  }
}

function clampIndex(i: number, length: number): number {
  return Math.max(0, Math.min(length - 1, i));
}

// Extent of every plotted value, optionally restricted to a time window.
// Points are x-sorted, so the window is a slice found by binary search rather
// than a full scan — this runs on every frame of a zoom drag.
export function extentOf(series: SeriesEntry[], span: Span | null): Range {
  const ranges: Range[] = [];
  for (const s of series) {
    const points = s.data.points;
    if (points.length === 0) continue;
    if (!span) {
      // The whole-series extent is precomputed at build time.
      ranges.push({ min: s.data.minY, max: s.data.maxY });
      continue;
    }
    const lo = lowerBound(points, span.start);
    let min = Infinity;
    let max = -Infinity;
    for (let i = lo; i < points.length && points[i].x <= span.end; i++) {
      const y = points[i].y;
      if (y < min) min = y;
      if (y > max) max = y;
    }
    if (Number.isFinite(min)) ranges.push({ min, max });
  }
  return unionRange(ranges) ?? { min: 0, max: 1 };
}
