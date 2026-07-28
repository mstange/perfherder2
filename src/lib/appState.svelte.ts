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
  placeholderMeta,
  resolvePoint,
  seriesKey,
  type PushGroup,
  type Run,
  type SeriesData,
  type SeriesMeta,
  type SeriesRef,
} from './graphData';
import {
  lowerBound,
  padDomain,
  styleForIndex,
  unionRange,
  type Range,
  type SeriesSymbol,
} from './chart';
import { EMPTY_FILTER, isFilterActive, sameFilter, type Filter } from './filter';
import { attrsForEntry, commonAttrs, commonFilterChips } from './seriesSummary';
import { clampSpan, defaultSpan, presetSpan, roundSpan, type Span } from './timeRange';
import {
  EMPTY_PICKER_VIEW,
  parseViewState,
  serializeViewState,
  type PickerViewState,
  type SelectedPoint,
  type SeriesEntryState,
  type ViewState,
} from './urlState';

// One plotted series: its identity, its color, and whatever we know about it.
export type SeriesEntry = {
  ref: SeriesRef;
  key: string;
  // Color and dot shape both come from the series' position in the list, the
  // way treeherder assigns them — see chart.ts::styleForIndex.
  color: string;
  symbol: SeriesSymbol;
  // Hidden series stay in the list and in the URL, they just aren't drawn or
  // hit-tested. Their color slot is kept, so unhiding doesn't recolor the
  // rest of the graph.
  visible: boolean;
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
  seriesRefs = $state<SeriesEntryState[]>([]);
  range = $state<Span>(defaultSpan(Date.now()));
  // null means "the detail graph shows the whole range".
  zoom = $state<Span | null>(null);
  selectedPoint = $state<SelectedPoint | null>(null);
  pickerOpen = $state(false);
  // The Add-series panel's own state. One object rather than five fields: it
  // arrives from the URL as a unit, the panel reports it back as a unit, and
  // nothing here means anything while the panel is closed.
  pickerView = $state<PickerViewState>(EMPTY_PICKER_VIEW);

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
  // `${repo}|${jobId}` lookups that came back an error. A negative cache, so
  // the pane can say "unavailable" instead of spinning on "loading…" forever,
  // and so the selection effect doesn't retry a lookup that will keep failing.
  private jobLookupFailed = $state(new Set<string>());
  repoInfo = $state(new Map<string, RepositoryInfo>());

  // ---- Derived ----------------------------------------------------------
  series = $derived.by((): SeriesEntry[] =>
    this.seriesRefs.map((ref, i) => {
      const key = dataKey(ref, this.range);
      const loaded = this.seriesCache.get(key);
      const style = styleForIndex(i);
      return {
        ref,
        key: seriesKey(ref),
        color: style.color,
        symbol: style.symbol,
        visible: ref.visible,
        meta: loaded?.meta ?? null,
        data: loaded?.data ?? EMPTY_SERIES_DATA,
        loading: this.loadingKeys.has(key),
        error: this.errorsByKey.get(key) ?? null,
      };
    }),
  );

  // What the graphs actually draw. Everything downstream of here — domains,
  // hit-testing, the "no data" note — works off this, not off `series`.
  visibleSeries = $derived(this.series.filter((s) => s.visible));
  anyLoading = $derived(this.series.some((s) => s.loading));
  loadingCount = $derived(this.series.filter((s) => s.loading).length);
  hasData = $derived(this.visibleSeries.some((s) => s.data.points.length > 0));
  failedSeries = $derived(this.series.filter((s) => s.error !== null));

  // The detail graph's x domain.
  detailSpan = $derived<Span>(this.zoom ?? this.range);

  // Shared y domain across every visible series, over the whole range. The
  // overview graph uses this one.
  fullYDomain = $derived.by((): Range => {
    const e = extentOf(this.visibleSeries, null);
    return padDomain(e.min, e.max);
  });

  // The detail graph rescales y to what's actually in the zoomed window, so
  // zooming in on a flat stretch doesn't leave it as a horizontal line at the
  // bottom of the plot. Treeherder keeps a y zoom in its URL instead; we
  // derive it, which is one less thing to get out of sync.
  detailYDomain = $derived.by((): Range => {
    const e = extentOf(this.visibleSeries, this.detailSpan);
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

  // False when a point is selected but sits outside the zoomed window, so it
  // isn't drawn. Without saying so, the details pane looks like it's showing
  // a point that isn't there.
  selectionInView = $derived.by((): boolean => {
    const sel = this.selection;
    if (!sel) return true;
    if (!sel.entry.visible) return false;
    return sel.run.x >= this.detailSpan.start && sel.run.x <= this.detailSpan.end;
  });

  // Distinguishes the two reasons a selected point might not be on screen, so
  // the details pane can offer the right way out of each.
  selectionHiddenBySeries = $derived(this.selection ? !this.selection.entry.visible : false);

  // Push / job details for the selection, once fetched.
  selectedPush = $derived.by((): Push | null => {
    const sel = this.selection;
    if (!sel) return null;
    return this.pushCache.get(`${sel.entry.ref.repository}|${sel.push.pushId}`) ?? null;
  });

  selectedJob = $derived.by((): Job | null => {
    const sel = this.selection;
    if (!sel || sel.run.jobId === null) return null;
    return this.jobCache.get(`${sel.entry.ref.repository}|${sel.run.jobId}`) ?? null;
  });

  // Why the job details are or aren't on screen. `expired` is the common case
  // for anything older than treeherder's job retention window: the datum's
  // `job_id` is null, so there is nothing to fetch and never will be. Without
  // distinguishing it from `loading`, the pane sat on "loading…" forever.
  selectedJobStatus = $derived.by((): 'loaded' | 'loading' | 'expired' | 'failed' => {
    const sel = this.selection;
    if (!sel) return 'loading';
    if (sel.run.jobId === null) return 'expired';
    if (this.selectedJob) return 'loaded';
    return this.jobLookupFailed.has(`${sel.entry.ref.repository}|${sel.run.jobId}`)
      ? 'failed'
      : 'loading';
  });

  // Which signatures are already on the graph, and in what color, so the
  // picker can mark those rows instead of offering them again. Keyed by
  // `${repository}|${signature id}` — the same recipe as the picker's
  // `Series.key`, which is what makes the lookup work; api.test.ts pins that
  // the two agree. See docs/design.md "Row identity" for why the repository
  // has to be part of it.
  plottedColors = $derived.by(
    (): Map<string, string> => new Map(this.series.map((e) => [e.key, e.color])),
  );

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
        meta: summary ? metaFromSummary(summary) : placeholderMeta(ref),
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

  private async loadJob(repository: string, jobId: number | null): Promise<void> {
    // Nothing to look up for an expired job. Requesting `/jobs/null/` is not
    // harmless either — treeherder answers it with a 500.
    if (jobId === null) return;
    const cacheKey = `${repository}|${jobId}`;
    const key = `job|${cacheKey}`;
    if (
      this.jobCache.has(cacheKey) ||
      this.detailRequests.has(key) ||
      this.jobLookupFailed.has(cacheKey)
    ) {
      return;
    }
    this.detailRequests.add(key);
    try {
      const job = await fetchJob(repository, jobId);
      this.jobCache = new Map(this.jobCache).set(cacheKey, job);
    } catch {
      // As above — but remember the failure, so the pane can report it and
      // the selection effect doesn't reissue the same doomed lookup.
      this.jobLookupFailed = new Set(this.jobLookupFailed).add(cacheKey);
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
      next.push({ ...ref, visible: true });
    }
    this.seriesRefs = next;
    this.syncUrl('push');
  }

  // Hiding keeps the series in the list, its color slot, and the URL — it's
  // "stop drawing this", not "remove it".
  toggleSeriesVisibility(ref: SeriesRef): void {
    this.seriesRefs = this.seriesRefs.map((s) =>
      s.repository === ref.repository && s.signatureId === ref.signatureId
        ? { ...s, visible: !s.visible }
        : s,
    );
    this.syncUrl('push');
  }

  showAllSeries(): void {
    if (this.seriesRefs.every((s) => s.visible)) return;
    this.seriesRefs = this.seriesRefs.map((s) => (s.visible ? s : { ...s, visible: true }));
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

  // Order decides both legend order and color, so reordering is a real
  // user-facing action rather than cosmetics.
  reorderSeries(from: number, to: number): void {
    const n = this.seriesRefs.length;
    if (from < 0 || from >= n) return;
    const target = Math.max(0, Math.min(n - 1, to));
    if (target === from) return;
    const next = [...this.seriesRefs];
    const [moved] = next.splice(from, 1);
    next.splice(target, 0, moved);
    this.seriesRefs = next;
    this.syncUrl('push');
  }

  // The keyboard path; drag-and-drop goes through reorderSeries directly.
  moveSeries(index: number, delta: number): void {
    this.reorderSeries(index, index + delta);
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
    for (const entry of this.visibleSeries) {
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

  // A picker starting point derived from the plotted series: what they have in
  // common as a filter, plus the repositories they live in. Almost always the
  // right place to start: a graph is nearly always one test sliced along one
  // axis, and the series you want to add next is a sibling of the ones already
  // on it. The repositories are part of it so the panel can actually show
  // those siblings instead of whatever its own default happens to be.
  //
  // Note the filter is the intersection over *one or more* series, not the
  // `splitCommonAttrs` version the series list renders — with a single series
  // plotted, that one series is exactly the context to search from.
  //
  // The interval, subtest mode and sort are left unspecified: the panel's own
  // defaults are the right answer, and leaving `matchSubtests` null is what
  // lets a derived `test:` chip turn it on (see PickerState.seed).
  private derivePickerView(): PickerViewState {
    const sets = this.series.map((e) => attrsForEntry(e.ref, e.meta));
    const chips = commonFilterChips(commonAttrs(sets));
    const repos = [...new Set(this.seriesRefs.map((s) => s.repository))];
    return {
      ...EMPTY_PICKER_VIEW,
      filter: chips.length > 0 ? { chips, text: '' } : EMPTY_FILTER,
      // Empty means "nothing plotted to derive from", which is the panel's own
      // default — not "check no repositories".
      repos: repos.length > 0 ? repos : null,
    };
  }

  // The last filter we derived, so we can tell an untouched prefill from one
  // the user has edited. Not `$state`: nothing renders it.
  private pickerFilterSeed: Filter | null = null;

  setPickerOpen(open: boolean): void {
    // Prefill on open, but never over the user's own work: we re-derive only
    // when the filter is empty or is still exactly the prefill we last handed
    // over. The second case is what keeps the prefill following the series
    // list — add a series, reopen, and the filter reflects the new set — while
    // a single edited chip pins it for good.
    //
    // The prefill replaces the whole view, so reopening an untouched panel also
    // returns the interval, subtest mode and sort to their defaults. That's
    // what a panel mounted fresh on every open did before any of this reached
    // the URL, and it keeps "untouched" meaning one thing rather than five.
    if (
      open &&
      (!isFilterActive(this.pickerView.filter) ||
        (this.pickerFilterSeed !== null &&
          sameFilter(this.pickerView.filter, this.pickerFilterSeed)))
    ) {
      const seed = this.derivePickerView();
      this.pickerFilterSeed = seed.filter;
      this.pickerView = seed;
    }
    this.pickerOpen = open;
    this.syncUrl('push');
  }

  // Called as the user works the panel: typing in the filter, toggling a repo,
  // changing the interval, clicking a column header. Always `replace`, never
  // `push` — the panel's controls belong to the history entry that opened it,
  // so the back button steps through graph-level actions instead of walking
  // backwards through keystrokes and knob positions inside one panel session.
  setPickerView(view: PickerViewState): void {
    this.pickerView = view;
    this.syncUrl('replace');
  }

  // ---- URL sync ---------------------------------------------------------
  viewState = $derived<ViewState>({
    series: this.seriesRefs,
    range: { start: this.range.start, end: this.range.end },
    zoom: this.zoom ? { start: this.zoom.start, end: this.zoom.end } : null,
    selected: this.selectedPoint,
    pickerOpen: this.pickerOpen,
    picker: this.pickerView,
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
      this.pickerView = state.picker;
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
    // The connecting line enters and leaves the window between runs that may
    // both sit outside it, and that visible stretch of line has to fit too —
    // otherwise a window whose only content is a line crossing it (or one
    // holding a few high dots from another series) clips the line away.
    // Runs *inside* the window need no special handling: a run's mean lies
    // between its own replicates, which the loop above already covered.
    const line = lineEdgeExtent(s.data.runs, span);
    if (line) {
      if (line.min < min) min = line.min;
      if (line.max > max) max = line.max;
    }
    if (Number.isFinite(min)) ranges.push({ min, max });
  }
  return unionRange(ranges) ?? { min: 0, max: 1 };
}

// Where the run line crosses the two edges of `span`, interpolated between the
// runs bracketing each edge. Null when the line doesn't reach into the window
// from outside on either side.
function lineEdgeExtent(runs: Run[], span: Span): Range | null {
  if (runs.length < 2) return null;
  const edges: number[] = [];
  for (const at of [span.start, span.end]) {
    const i = lowerBound(runs, at);
    // Needs a run on each side: at the ends of the series the line simply
    // stops, and a run exactly on the edge is already a point in the window.
    if (i === 0 || i >= runs.length || runs[i].x === at) continue;
    const a = runs[i - 1];
    const b = runs[i];
    edges.push(a.mean + ((b.mean - a.mean) * (at - a.x)) / (b.x - a.x));
  }
  if (edges.length === 0) return null;
  return { min: Math.min(...edges), max: Math.max(...edges) };
}
