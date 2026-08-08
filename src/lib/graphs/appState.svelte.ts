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
import { alertsByPush, alertsForSeries, type SeriesAlert } from './alerts';
import { detectChanges, type DetectedChange } from './changes';
import { profileLinks, type ProfileLink } from './artifacts';
import { fetchTaskArtifactNames } from './artifactsApi';
import type { RepoLinkInfo } from '../shared/links';
import { fetchAlertSummaries } from './alertsApi';
import {
  buildSeriesData,
  EMPTY_SERIES_DATA,
  MEAN_REPLICATE,
  metaFromSummary,
  placeholderMeta,
  pushValues,
  resolvePoint,
  seriesKey,
  type PlotPoints,
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
} from '../shared/chart';
import { buildComparison, type CompareSide, type Comparison } from './compare';
import { MIN_CURVE_VALUES, stableScales, type StableScales } from './distribution';
import { EMPTY_FILTER, isFilterActive, sameFilter, type Filter } from '../picker/filter';
import {
  attrsForEntry,
  commonAttrs,
  commonFilterChips,
  documentTitle,
} from './seriesSummary';
import { theme } from '../shared/theme.svelte';
import { clampSpan, defaultSpan, presetSpan, roundSpan, type Span } from '../shared/timeRange';
import {
  EMPTY_PICKER_VIEW,
  parseViewState,
  serializeViewState,
  type PickerViewState,
  type SelectedPoint,
  type SeriesEntryState,
  type ViewState,
} from '../urlState';

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
  // Which of `data`'s two point sets is in play, per `showReplicates`. Picked
  // once here so that everything downstream — both graphs, the y domains,
  // hit-testing, keyboard stepping, the series list's point count — draws and
  // talks about the same dots without each re-deriving the choice.
  plot: PlotPoints;
  loading: boolean;
  error: string | null;
  // Alerts perfherder raised for this series, on pushes inside the loaded
  // range. Empty until they land, which is deliberate: they're a second fetch,
  // and the graph must not wait for them to draw its dots.
  alerts: readonly SeriesAlert[];
  // Steps this app found in the data itself (changes.ts). Empty while
  // `changeDetection` is off, and empty until the detection has run — which is
  // one frame behind the dots, not a fetch.
  changes: readonly DetectedChange[];
};

// Shared so that every un-fetched series' `alerts` is the same array, and a
// `$derived` recomputation doesn't look like a change to anything downstream.
const EMPTY_ALERTS: readonly SeriesAlert[] = [];
const EMPTY_CHANGES: readonly DetectedChange[] = [];

// Everything the details pane needs about the current selection.
export type Selection = {
  entry: SeriesEntry;
  push: PushGroup;
  run: Run;
  // MEAN_REPLICATE when the run's mean is what's selected.
  replicateIndex: number;
  value: number;
};

// Where the comparison's second end came from. The two behave identically
// downstream, and the details pane renders them differently: a pinned
// comparison is the user's, a hovered one is a preview that disappears when the
// pointer leaves.
export type ComparisonSource = 'pinned' | 'hover';

type LoadedSeries = { meta: SeriesMeta; data: SeriesData };

const DAY_SECONDS = 86400;

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
  // The pinned second end of a comparison, set by shift-clicking a dot.
  comparedPoint = $state<SelectedPoint | null>(null);
  // The dot under the pointer. Not in the URL and not history — it exists to
  // let the pane preview the comparison a shift-click would pin. Cleared when
  // the pointer leaves the graph.
  hoveredPoint = $state<SelectedPoint | null>(null);
  // With replicates on, every replicate of every run is a dot — the default,
  // and the reason we fetch with `replicates=true` at all. Off, each run
  // collapses to one dot at its mean: a 90-day range drops from ~20k dots per
  // series to a few hundred, and a real step in the data stops being buried in
  // scatter. (Still one dot per *run*, so a retriggered push keeps one dot per
  // retrigger, straddling the line's single vertex for that push. Collapsing
  // to one dot per push would need a second sentinel and a push-level
  // selection, and would hide that a build was retriggered at all.) This
  // is a *drawing* choice only; the fetch is unchanged, so toggling it is
  // instant and the details pane can still list a run's individual
  // replicates either way.
  showReplicates = $state(true);
  // Draw the steps this app detects in each series (changes.ts).
  //
  // **On by default**, which is a deliberate departure from how this app treats
  // most interpretation. The justification for building it at all is the gap
  // where perfherder's alerts are silent — a change that never crossed
  // somebody's threshold, on a platform nobody set one for — and a feature that
  // only helps the people who find a checkbox does not close that gap. The bars
  // are quiet enough to earn the default: a 5px strip along the plot floor, in
  // the same red/green vocabulary the alert markers already use, labelled
  // "detected" everywhere it is described so it never claims to be a verdict.
  changeDetection = $state(true);
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

  // Alert summaries per series, keyed the same way as `seriesCache` and pruned
  // with it. A missing entry means "not fetched yet", an empty array "fetched,
  // no alerts" — the graph must be able to tell those apart or it would draw
  // nothing and look identical either way.
  private alertCache = $state(new Map<string, SeriesAlert[]>());
  private alertRequests = new Set<string>();

  // Detected changes per series, keyed and pruned the same way. Cached rather
  // than derived because the segmentation is an O(n²) dynamic program and
  // `series` recomputes for reasons that have nothing to do with the data —
  // a theme flip, a replicate toggle — which would re-run it every time.
  //
  // Never cleared when `changeDetection` goes off, only hidden: turning the
  // switch back on should not pay for the work again.
  private changeCache = $state(new Map<string, DetectedChange[]>());

  pushCache = $state(new Map<string, Push>());
  jobCache = $state(new Map<string, Job>());
  // `${repo}|${jobId}` lookups that came back an error. A negative cache, so
  // the pane can say "unavailable" instead of spinning on "loading…" forever,
  // and so the selection effect doesn't retry a lookup that will keep failing.
  private jobLookupFailed = $state(new Set<string>());

  // Artifact names per task *run*, keyed `${taskId}|${runId}`, with the same
  // negative cache beside it. Not pruned with the series caches: an entry is a
  // dozen short strings, and a selection the user goes back to is the case this
  // is for.
  private artifactCache = $state(new Map<string, string[]>());
  private artifactLookupFailed = $state(new Set<string>());

  repoInfo = $state(new Map<string, RepositoryInfo>());

  // What the link builders need to know about a repository: whether it's hg or
  // git, and where its browser lives. Null until `loadRepositories` lands, and
  // for anything not in the response — every caller falls back to a
  // treeherder-only link in that case rather than guessing a URL.
  //
  // Here rather than in shared/links.ts because it's a lookup into app state;
  // links.ts stays a set of pure builders that take the answer.
  repoLinkFor(repository: string): RepoLinkInfo | null {
    const info = this.repoInfo.get(repository);
    return info ? { name: info.name, dvcs_type: info.dvcs_type, url: info.url } : null;
  }

  // ---- Derived ----------------------------------------------------------
  series = $derived.by((): SeriesEntry[] =>
    this.seriesRefs.map((ref, i) => {
      const key = dataKey(ref, this.range);
      const loaded = this.seriesCache.get(key);
      const style = styleForIndex(i, theme.resolved);
      const data = loaded?.data ?? EMPTY_SERIES_DATA;
      return {
        ref,
        key: seriesKey(ref),
        color: style.color,
        symbol: style.symbol,
        visible: ref.visible,
        meta: loaded?.meta ?? null,
        data,
        plot: this.showReplicates ? data.replicates : data.means,
        loading: this.loadingKeys.has(key),
        error: this.errorsByKey.get(key) ?? null,
        alerts: this.alertCache.get(key) ?? EMPTY_ALERTS,
        changes: this.changeDetection
          ? (this.changeCache.get(key) ?? EMPTY_CHANGES)
          : EMPTY_CHANGES,
      };
    }),
  );

  // What the graphs actually draw. Everything downstream of here — domains,
  // hit-testing, the "no data" note — works off this, not off `series`.
  visibleSeries = $derived(this.series.filter((s) => s.visible));
  anyLoading = $derived(this.series.some((s) => s.loading));
  loadingCount = $derived(this.series.filter((s) => s.loading).length);
  hasData = $derived(this.visibleSeries.some((s) => s.plot.points.length > 0));
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

  // Resolves a URL-level point triple against loaded data. Null when the point
  // isn't in the current range — the link may predate a narrowing, and a
  // phantom selection is worse than none.
  private resolveSelection(point: SelectedPoint | null): Selection | null {
    if (!point) return null;
    const entry = this.series.find(
      (s) => s.ref.repository === point.repository && s.ref.signatureId === point.signatureId,
    );
    if (!entry) return null;
    const resolved = resolvePoint(entry.data, point.datumId, point.replicateIndex);
    if (!resolved) return null;
    return {
      entry,
      push: resolved.push,
      run: resolved.run,
      replicateIndex: resolved.replicateIndex,
      value: resolved.value,
    };
  }

  selection = $derived(this.resolveSelection(this.selectedPoint));

  // The comparison's second end: pinned if there is one, else whatever the
  // pointer is over. Hover only previews *once a selection exists* — with
  // nothing selected there is nothing to compare against, and every mousemove
  // would otherwise light up the pane.
  comparisonSource = $derived.by((): ComparisonSource | null => {
    if (!this.selectedPoint) return null;
    if (this.comparedPoint) return 'pinned';
    return this.hoveredPoint ? 'hover' : null;
  });

  // Both gated on `comparisonSource`, so the ring the graph draws and the
  // comparison the pane describes can never disagree about which end is live.
  comparedSelection = $derived(
    this.resolveSelection(this.comparisonSource === 'pinned' ? this.comparedPoint : null),
  );
  // The dot under the pointer, resolved whether or not it is previewing a
  // comparison. With nothing selected there is no comparison to preview, but the
  // graph still rings it — otherwise the dots give no sign that they are
  // clickable until after the first click.
  hoveredResolved = $derived(this.resolveSelection(this.hoveredPoint));
  hoveredSelection = $derived(this.comparisonSource === 'hover' ? this.hoveredResolved : null);

  // The described comparison, or null when there is no second end — or when the
  // second end *is* the selection, which has nothing to say.
  comparison = $derived.by((): Comparison | null => {
    const a = this.selection;
    const b = this.comparedSelection ?? this.hoveredSelection;
    if (!a || !b) return null;
    return buildComparison(compareSideOf(a), compareSideOf(b));
  });

  // The pin is on the selected point itself, so there is nothing to compare yet.
  //
  // Not a degenerate state to be avoided — it's the whole keyboard path: mark
  // this point, then walk the selection away from it with the arrow keys. It also
  // means arrowing back onto a pinned point doesn't silently throw the pin away.
  // The pane has to explain it, which is what this is for.
  comparisonMarkedHere = $derived(
    !!this.selectedPoint &&
      !!this.comparedPoint &&
      samePoint(this.selectedPoint, this.comparedPoint),
  );

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

  // What both distribution charts in the pane are drawn with. Everything here is a
  // function of the selection, not of whatever the pointer is over, which is the
  // point: the pane redraws on every hover, and letting the two pools on screen
  // decide the scales made the *selected* side move and change height under the
  // reader. Measured over one series' 84 pushes, hovering each in turn against a
  // fixed selection: the axis width swung 12%, the selected pool's median slid 15px
  // across a 260px plot, and the shared density scale swung 19×.
  //
  // `stableScales` is the selected pool's own axis and peak, each with headroom, so
  // a hovered pool inside that headroom changes nothing. One outside it still
  // widens the axis or raises the scale in `buildDistribution` — both distributions
  // have to fit — so this is a *usually*, and distribution.ts records how often,
  // measured, for each headroom size.
  //
  // The band is the other half, and the only part that looks at the zoom window. A
  // series whose pushes straddle MIN_CURVE_VALUES — most with enough replicates for
  // a curve, one with three — grew and shrank by 73px as the pointer moved between
  // them, so the window is scanned for whether any pool the pointer can reach has a
  // curve at all. Where none can (every awsy signature), nothing is reserved and
  // the chart stays compact.
  //
  // "Any pool the pointer can reach" means every *visible* series, not just the
  // selected one. A hover lands on whatever dot is under the pointer, and a
  // comparison across two series is an ordinary thing to want — so an awsy
  // selection plotted beside a talos series can be handed a curve by a hover, and
  // a band scanned only over the selection's own pushes would not have reserved
  // for it. Since ComparisonSection reserves the chart's height from this, an
  // answer of false has to mean nobody can produce one.
  selectionChart = $derived.by((): { scales: StableScales; reserveBand: boolean } | null => {
    const sel = this.selection;
    if (!sel) return null;
    const pool = pushValues(sel.push);
    const span = this.detailSpan;
    let reserveBand = pool.length >= MIN_CURVE_VALUES;
    for (const entry of this.visibleSeries) {
      if (reserveBand) break;
      for (const push of entry.data.pushes) {
        if (push.x < span.start || push.x > span.end) continue;
        let values = 0;
        for (const run of push.runs) values += run.values.length;
        if (values >= MIN_CURVE_VALUES) {
          reserveBand = true;
          break;
        }
      }
    }
    return { scales: stableScales(pool), reserveBand };
  });

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

  // The task run whose artifacts belong to the selection, when we know it. Both
  // fields are optional on `Job` and absent together, so this is the one place
  // that checks — everything downstream takes the pair or nothing.
  private selectedTaskRun = $derived.by((): { taskId: string; runId: number } | null => {
    const job = this.selectedJob;
    if (!job || job.task_id === undefined || job.retry_id === undefined) return null;
    return { taskId: job.task_id, runId: job.retry_id };
  });

  // Firefox Profiler links for the selected run's `profile_*` artifacts. Empty
  // both while the list is in flight and when the task uploaded none; it's
  // `selectedProfilesStatus` that tells those two apart.
  selectedProfiles = $derived.by((): ProfileLink[] => {
    const job = this.selectedJob;
    const run = this.selectedTaskRun;
    if (!job || !run) return [];
    const names = this.artifactCache.get(`${run.taskId}|${run.runId}`);
    if (!names) return [];
    return profileLinks(names, {
      job_type_name: job.job_type_name,
      task_id: run.taskId,
      retry_id: run.runId,
    });
  });

  // `absent` means there is nothing to ask about — no job yet, or a job with no
  // taskcluster metadata — and the pane draws no row at all. The other three
  // mirror `selectedJobStatus`.
  selectedProfilesStatus = $derived.by((): 'absent' | 'loading' | 'loaded' | 'failed' => {
    const run = this.selectedTaskRun;
    if (!run) return 'absent';
    const key = `${run.taskId}|${run.runId}`;
    if (this.artifactCache.has(key)) return 'loaded';
    return this.artifactLookupFailed.has(key) ? 'failed' : 'loading';
  });

  // Which signatures are already on the graph, and in what color, so the
  // picker can mark those rows instead of offering them again. Keyed by
  // `${repository}|${signature id}` — the same recipe as the picker's
  // `Series.key`, which is what makes the lookup work; picker/series.test.ts
  // pins that the two agree. See docs/design.md "Row identity" for why the
  // repository has to be part of it.
  plottedColors = $derived.by(
    (): Map<string, string> => new Map(this.series.map((e) => [e.key, e.color])),
  );

  // What the tab says. Derived from the series rather than fixed in index.html,
  // where it used to name the Add-series dialog no matter what was plotted.
  pageTitle = $derived(
    documentTitle(
      this.series.map((e) => attrsForEntry(e.ref, e.meta)),
      this.pickerOpen,
    ),
  );

  // The alert on the selected build, if perfherder raised one for the selected
  // series. What turns a marker on the graph into something readable.
  selectedAlert = $derived.by((): SeriesAlert | null => {
    const sel = this.selection;
    if (!sel) return null;
    return alertsByPush(sel.entry.alerts).get(sel.push.pushId) ?? null;
  });

  // The step this app detected at the selected build, if there is one. Keyed on
  // the push *after* the change, which is the one a bar's click selects and the
  // one the change is attributed to — the same convention as an alert, which
  // belongs to the push it was raised on rather than to the one before it.
  selectedChange = $derived.by((): DetectedChange | null => {
    const sel = this.selection;
    if (!sel) return null;
    return sel.entry.changes.find((c) => c.afterPushId === sel.push.pushId) ?? null;
  });

  // The push immediately before the selected one in the same series — the
  // details pane's "Since previous" pushlog link needs it, to name the range
  // that landed in between.
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

    // Alerts, once the series they belong to has loaded. Second, not in
    // parallel: placing an alert needs the pushes, and a series that failed or
    // came back empty has nothing to place them on.
    $effect(() => {
      for (const entry of this.series) {
        if (entry.loading || entry.error || entry.data.pushes.length === 0) continue;
        void this.loadAlerts(entry.ref, dataKey(entry.ref, this.range), entry.data);
      }
    });

    // Detect changes in every loaded series we haven't run over yet.
    //
    // Reads `seriesCache` rather than `series`, so it doesn't wake for a theme
    // change or a replicate toggle. It still writes a cell it reads
    // (`changeCache`), so Svelte runs it once more to settle; the second pass
    // finds every key present and does nothing.
    //
    // Synchronous, and cheap enough to be. Measured (node, so ratios rather
    // than absolutes): 1.3 ms at 400 pushes, 3.7 ms at 900, 8.9 ms at 2000 —
    // the proposal stage is O(n) per level of recursion rather than a quadratic
    // dynamic program (changes.ts, "Three stages"). Eight series at a year is
    // therefore a small fraction of one fetch, and it runs after the dots are up.
    $effect(() => {
      if (!this.changeDetection) return;
      const span = this.range;
      const cache = this.seriesCache;
      const found: [string, DetectedChange[]][] = [];
      for (const ref of this.seriesRefs) {
        const key = dataKey(ref, span);
        if (this.changeCache.has(key)) continue;
        const loaded = cache.get(key);
        if (!loaded || loaded.data.pushes.length === 0) continue;
        found.push([key, detectChanges(loaded.data.pushes, loaded.meta.lowerIsBetter)]);
      }
      if (found.length === 0) return;
      const next = new Map(this.changeCache);
      for (const [key, changes] of found) next.set(key, changes);
      this.changeCache = next;
    });

    // Fetch push + job detail for the selection, lazily.
    $effect(() => {
      const sel = this.selection;
      if (!sel) return;
      const repo = sel.entry.ref.repository;
      void this.loadPush(repo, sel.push.pushId);
      void this.loadJob(repo, sel.run.jobId);
    });

    // The selected run's artifact list, in a second step rather than alongside
    // the two above: the task id and run number it needs come out of the job,
    // so this can only start once that lands. Re-runs when it does.
    $effect(() => {
      const run = this.selectedTaskRun;
      if (run) void this.loadArtifacts(run.taskId, run.runId);
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

  // Alerts for one loaded series. `key` is the series-data key, so the result
  // is thrown away by the same prune as the data it was matched against.
  //
  // `alertRequests` is never cleared on failure, only on prune: it marks "we
  // have asked", which is what keeps the effect above — which re-runs on every
  // series change — from reissuing a request that failed. Alerts are decoration
  // on someone else's graph; a missing marker is a smaller harm than a retry
  // loop, and changing the range or the series list is the retry.
  private async loadAlerts(ref: SeriesRef, key: string, data: SeriesData): Promise<void> {
    if (this.alertCache.has(key) || this.alertRequests.has(key)) return;
    this.alertRequests.add(key);
    // Server-side, `timerange` counts back from now, so this asks for
    // everything since the start of our window and lets `alertsForSeries` drop
    // what lands outside it. A day's floor keeps a degenerate range (start in
    // the future, or a few minutes wide) from asking for nothing at all.
    const seconds = Math.max(DAY_SECONDS, (Date.now() - this.range.start) / 1000);
    try {
      const summaries = await fetchAlertSummaries(ref.signatureId, ref.frameworkId, seconds);
      this.alertCache = new Map(this.alertCache).set(
        key,
        alertsForSeries(summaries, ref.signatureId, data),
      );
    } catch {
      // As with pushes and jobs: a failed lookup must not take the graph down.
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

  private async loadArtifacts(taskId: string, runId: number): Promise<void> {
    const cacheKey = `${taskId}|${runId}`;
    const key = `artifacts|${cacheKey}`;
    if (
      this.artifactCache.has(cacheKey) ||
      this.detailRequests.has(key) ||
      this.artifactLookupFailed.has(cacheKey)
    ) {
      return;
    }
    this.detailRequests.add(key);
    try {
      const names = await fetchTaskArtifactNames(taskId, runId);
      this.artifactCache = new Map(this.artifactCache).set(cacheKey, names);
    } catch {
      // As with the job lookup, remembered rather than retried. Artifacts
      // expire a year after the run and the queue answers 404 for good once
      // they have, so a failure here is usually permanent.
      this.artifactLookupFailed = new Set(this.artifactLookupFailed).add(cacheKey);
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

    const alerts = new Map<string, SeriesAlert[]>();
    for (const [key, value] of this.alertCache) {
      if (wanted.has(key)) alerts.set(key, value);
    }
    if (alerts.size !== this.alertCache.size) this.alertCache = alerts;
    for (const key of this.alertRequests) {
      if (!wanted.has(key)) this.alertRequests.delete(key);
    }

    const changes = new Map<string, DetectedChange[]>();
    for (const [key, value] of this.changeCache) {
      if (wanted.has(key)) changes.set(key, value);
    }
    if (changes.size !== this.changeCache.size) this.changeCache = changes;
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

  // Takes one ref or many. Many, because the picker's "Remove all 49" is one
  // user action and has to be one history entry — a loop over the single-ref
  // form would cost 49 Back presses to undo.
  removeSeries(refs: SeriesRef | SeriesRef[]): void {
    const gone = new Set(
      (Array.isArray(refs) ? refs : [refs]).map((r) => `${r.repository}|${r.signatureId}`),
    );
    if (gone.size === 0) return;
    this.seriesRefs = this.seriesRefs.filter(
      (s) => !gone.has(`${s.repository}|${s.signatureId}`),
    );
    // A selection — or a comparison end — belonging to a removed series is now
    // meaningless. `selection` would resolve to null anyway once its data is
    // pruned, but leaving the point in the URL means a Back to the range that
    // still has it would silently resurrect a selection on a series that's gone.
    const belongsToRemoved = (p: SelectedPoint | null) =>
      !!p && gone.has(`${p.repository}|${p.signatureId}`);
    if (belongsToRemoved(this.selectedPoint)) this.selectedPoint = null;
    if (belongsToRemoved(this.comparedPoint)) this.comparedPoint = null;
    this.pruneSeriesCache();
    this.syncUrl('push');
  }

  clearSeries(): void {
    this.seriesRefs = [];
    this.selectedPoint = null;
    this.comparedPoint = null;
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

  setShowReplicates(on: boolean): void {
    if (this.showReplicates === on) return;
    this.showReplicates = on;
    // The selection deliberately survives: a mean selection is still a valid
    // mean selection with replicates drawn, and a replicate selection still
    // names a real value with them hidden. Coercing it either way would lose
    // the point the user was looking at for the sake of tidiness.
    this.syncUrl('push');
  }

  setChangeDetection(on: boolean): void {
    if (this.changeDetection === on) return;
    this.changeDetection = on;
    this.syncUrl('push');
  }

  // A deliberate pick: a click on a dot, or on a value in the details pane.
  // The arrow keys go through `stepSelection` instead, and the difference
  // between the two is the swap below.
  selectPoint(sel: SelectedPoint | null): void {
    // Picking the *pinned* point means "look at that end now", not "throw the
    // pair away", so the two ends trade places. The card doesn't move: base and
    // next are ordered by time, not by which end is selected
    // (compare.ts::sideOrder), so all that changes is the two role labels and
    // the single-point sections below, which follow the click.
    //
    // Without the swap, selection and pin coincide, `comparison` goes null and
    // the pane falls through to `comparisonMarkedHere` — "marked for
    // comparison, now move to another point". That is the keyboard path's
    // middle step, and it's the right thing to say to someone who just pressed
    // `c`; said to someone who built a comparison with the mouse and then
    // clicked one of its two ends, it reads as a nag to do the thing they had
    // already done, and it eats the comparison to say it.
    if (
      sel &&
      this.selectedPoint &&
      this.comparedPoint &&
      samePoint(sel, this.comparedPoint) &&
      !samePoint(sel, this.selectedPoint)
    ) {
      this.comparedPoint = this.selectedPoint;
    }
    this.selectedPoint = sel;
    // Nothing left to compare against. A pin that coincides with the selection
    // is deliberately *not* dropped — see `comparisonMarkedHere`.
    if (!sel) this.comparedPoint = null;
    this.syncUrl('push');
  }

  // The arrow keys walking the selection, which deliberately does *not* swap:
  // the pin is an anchor the user set with `c` and then walked away from, so
  // stepping back onto it has to leave it where it is. Swapping here would drag
  // the anchor along behind the selection — walk right and back and the mark has
  // moved a point, walk again and it has moved another.
  //
  // 'replace' rather than 'push' because holding an arrow key fires at the
  // key-repeat rate, and a history entry per repeat would bury whatever the user
  // actually wants to go back to.
  private stepSelection(sel: SelectedPoint): void {
    this.selectedPoint = sel;
    this.syncUrl('replace');
  }

  // Shift-click, or `c` on the focused graph. Pins the other end of a
  // comparison, or unpins it when the same point is pinned again — the gesture
  // is its own undo.
  //
  // Pinning the *selected* point is allowed, and is how the keyboard path works:
  // mark this point, then arrow away from it. See `comparisonMarkedHere` for the
  // state that produces.
  comparePoint(point: SelectedPoint | null): void {
    const unpin = !!point && !!this.comparedPoint && samePoint(point, this.comparedPoint);
    this.comparedPoint = unpin ? null : point;
    // A pin with no selection is a comparison with one end. `comparisonSource`
    // reports none without a selection, so this used to write `cmp=` to the URL
    // and then display absolutely nothing — until some later plain click sprang
    // a comparison against a dot chosen minutes before, with no way to tell
    // where it came from.
    //
    // Selecting the same point lands in `comparisonMarkedHere`, which the pane
    // already explains ("marked for comparison — now move to another point").
    // That is the keyboard path's middle step, so the two gestures converge on
    // one state instead of shift-click having a silent one of its own. It also
    // keeps the graph honest: the hover ring said this click would pin the dot,
    // and it did.
    if (point && !unpin && !this.selectedPoint) this.selectedPoint = point;
    this.syncUrl('push');
  }

  // "What changed here?" — the question a lone selected point raises and no
  // gesture answers, because shift-clicking the previous push means finding a
  // dot that may be one pixel away from four others (see graphs-todo.md,
  // "Retrigger / delta-vs-previous readouts").
  //
  // The pinned point is the *last* run of that push — its latest retrigger,
  // since a push's runs are ordered by job id — and the comparison pools the whole
  // push either way (compare.ts::poolFor), so the choice only decides which dot
  // wears the ring. The replicate slot carries over exactly as it does when the
  // arrow keys walk a run — like against like, and a mean stays a mean.
  compareWithPreviousPush(): void {
    const sel = this.selection;
    const prev = this.previousPush;
    const run = prev?.runs.at(-1);
    if (!sel || !run) return;
    this.comparePoint({
      repository: sel.entry.ref.repository,
      signatureId: sel.entry.ref.signatureId,
      datumId: run.datumId,
      replicateIndex:
        sel.replicateIndex === MEAN_REPLICATE
          ? MEAN_REPLICATE
          : Math.min(sel.replicateIndex, run.values.length - 1),
    });
  }

  clearComparison(): void {
    if (!this.comparedPoint) return;
    this.comparedPoint = null;
    this.syncUrl('push');
  }

  // Clicking an alert marker, or stepping onto one with the keyboard.
  //
  // An alert is a claim about a *change*, so this sets up both of its ends at
  // once: the alerted push is selected, and the push perfherder measured
  // against is pinned as the comparison. One gesture takes you from "perfherder
  // flagged this" to the comparison card — distributions, rank-sum test, effect
  // size — computed from the replicates this app fetched.
  //
  // Those numbers will not match the alert's, and are not meant to.
  // `prev_value` and `new_value` are averages over a *window* either side of
  // the change — 12 to 24 data points back and 12 forward
  // (`historical_stats`/`forward_stats` in treeherder/perf/alerts.py, sized by
  // PERFHERDER_ALERTS_{MIN_BACK,MAX_BACK,FORE}_WINDOW) — while the comparison
  // card is these two pushes and nothing else. On alert #51605 that is +121%
  // against +194%. The pane labels both, the way it already labels perfherder's
  // t-value apart from its own U test.
  //
  // The pinned end is `prevPushId`, not the previous push on the graph. They
  // differ whenever the series has no data on an intervening push, and pinning
  // the graph's neighbour would put a "before" value in the comparison card
  // that perfherder never used, directly under a card quoting the one it did.
  selectAlert(ref: SeriesRef, alert: SeriesAlert): void {
    this.selectPushPair(ref, alert.pushId, alert.prevPushId);
  }

  // Clicking a detected-change bar, which is the same gesture as clicking an
  // alert marker and does the same thing: the push after the step is selected
  // and the one before it is pinned, so the comparison card spells out in
  // replicates what the bar claims in two segment means.
  //
  // The two will not print the same percentage, and both are right — the same
  // relationship the Alert card has with the comparison card, one step milder.
  // A detected change is a difference of *means over up to 24 pushes a side*
  // (changes.ts, WINDOW_PUSHES) while the comparison is these two builds, so a
  // step buried in noisy data reads much larger between the two adjacent pushes
  // that happen to straddle it than it does between the two levels. The
  // Detected-change card says which it is.
  selectChange(ref: SeriesRef, change: DetectedChange): void {
    this.selectPushPair(ref, change.afterPushId, change.beforePushId);
  }

  // "Select this build, and pin the one it is being measured against" — one
  // gesture, one history entry, both ends of a comparison.
  //
  // `againstPushId` may be outside the loaded range, or expired. The selection
  // still happens and the comparison simply doesn't, which is better than
  // pinning a substitute the finding never used.
  //
  // MEAN_REPLICATE on both ends: these findings are about builds, not about one
  // of a build's twenty-five replicates. The comparison pools the whole push
  // either way (compare.ts::poolFor), so this only decides which dot wears the
  // ring — and the run's mean is where the connecting line already passes.
  private selectPushPair(ref: SeriesRef, pushId: number, againstPushId: number): void {
    const entry = this.series.find(
      (s) => s.ref.repository === ref.repository && s.ref.signatureId === ref.signatureId,
    );
    const run = entry?.data.pushById.get(pushId)?.runs.at(-1);
    if (!entry || !run) return;
    const against = entry.data.pushById.get(againstPushId)?.runs.at(-1);

    const at = (datumId: number): SelectedPoint => ({
      repository: entry.ref.repository,
      signatureId: entry.ref.signatureId,
      datumId,
      replicateIndex: MEAN_REPLICATE,
    });

    // Both ends assigned before a single `syncUrl`. Going through selectPoint
    // and comparePoint would push two history entries for one click, and the
    // back button would land on a half-built comparison nobody asked for.
    this.selectedPoint = at(run.datumId);
    this.comparedPoint = against ? at(against.datumId) : null;
    this.syncUrl('push');
  }

  // The alerts of every visible series, in time order, as (ref, alert) pairs —
  // what the keyboard stepper walks and what the graph's markers are drawn
  // from. Flattened across series because the markers are: two series alerting
  // on nearby pushes interleave on the x axis, and stepping should follow the
  // graph rather than the series list.
  visibleAlerts = $derived.by((): { ref: SeriesRef; alert: SeriesAlert }[] => {
    const out: { ref: SeriesRef; alert: SeriesAlert }[] = [];
    for (const entry of this.visibleSeries) {
      for (const alert of entry.alerts) out.push({ ref: entry.ref, alert });
    }
    out.sort((a, b) => a.alert.x - b.alert.x);
    return out;
  });

  // `A` / `shift-A` on the focused graph: the keyboard's version of clicking a
  // marker. Steps to the next alert after the selected push, or the previous
  // one before it; with nothing selected, enters at the first or last.
  //
  // Deliberately not wrapping, unlike `stepRun`'s clamp: an alert list is short
  // and unevenly spaced, so wrapping from the last alert of the year back to
  // the first reads as a bug rather than as a cycle.
  stepAlert(delta: number): void {
    const alerts = this.visibleAlerts;
    if (alerts.length === 0) return;
    const from = this.selection?.push.x;
    let next: { ref: SeriesRef; alert: SeriesAlert } | undefined;
    if (from === undefined) {
      next = delta > 0 ? alerts[0] : alerts[alerts.length - 1];
    } else if (delta > 0) {
      next = alerts.find((a) => a.alert.x > from);
    } else {
      next = [...alerts].reverse().find((a) => a.alert.x < from);
    }
    if (next) this.selectAlert(next.ref, next.alert);
  }

  // Transient, so no history and no URL — see `hoveredPoint`.
  setHoveredPoint(point: SelectedPoint | null): void {
    this.hoveredPoint = point;
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
    this.stepSelection({
      repository: sel.entry.ref.repository,
      signatureId: sel.entry.ref.signatureId,
      datumId: next.datumId,
      // Keep the replicate slot where possible, so walking a series compares
      // like with like instead of jumping around inside each run. A mean
      // selection stays a mean selection — MEAN_REPLICATE is below every
      // real index, so the clamp leaves it alone.
      replicateIndex:
        sel.replicateIndex === MEAN_REPLICATE
          ? MEAN_REPLICATE
          : Math.min(sel.replicateIndex, next.values.length - 1),
    });
  }

  stepReplicate(delta: number): void {
    const sel = this.selection;
    if (!sel) {
      this.selectFirstPoint();
      return;
    }
    // With replicates hidden there is nothing to walk: every run is one dot,
    // and stepping would park the selection ring on a value that isn't drawn.
    if (!this.showReplicates) return;
    this.stepSelection({
      repository: sel.entry.ref.repository,
      signatureId: sel.entry.ref.signatureId,
      datumId: sel.run.datumId,
      // A mean selection has no slot to step from; enter the list at its
      // first replicate rather than jumping to the last one for a -1 delta.
      replicateIndex:
        sel.replicateIndex === MEAN_REPLICATE
          ? 0
          : clampIndex(sel.replicateIndex + delta, sel.run.values.length),
    });
  }

  private selectFirstPoint(): void {
    for (const entry of this.visibleSeries) {
      const point = entry.plot.points[0];
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
    compared: this.comparedPoint,
    showReplicates: this.showReplicates,
    changeDetection: this.changeDetection,
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
      this.comparedPoint = state.compared;
      this.showReplicates = state.showReplicates;
      this.changeDetection = state.changeDetection;
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

function samePoint(a: SelectedPoint, b: SelectedPoint): boolean {
  return (
    a.repository === b.repository &&
    a.signatureId === b.signatureId &&
    a.datumId === b.datumId &&
    a.replicateIndex === b.replicateIndex
  );
}

// A resolved selection, flattened into what compare.ts asks for. That module is
// deliberately structural about its input so it stays free of the reactive
// layer; this is the one place the two shapes meet.
function compareSideOf(sel: Selection): CompareSide {
  return {
    ref: sel.entry.ref,
    meta: sel.entry.meta,
    color: sel.entry.color,
    push: sel.push,
    run: sel.run,
    replicateIndex: sel.replicateIndex,
    value: sel.value,
  };
}

// Extent of every plotted value, optionally restricted to a time window.
// Points are x-sorted, so the window is a slice found by binary search rather
// than a full scan — this runs on every frame of a zoom drag.
export function extentOf(series: SeriesEntry[], span: Span | null): Range {
  const ranges: Range[] = [];
  for (const s of series) {
    const points = s.plot.points;
    if (points.length === 0) continue;
    if (!span) {
      // The whole-series extent is precomputed at build time.
      ranges.push({ min: s.plot.minY, max: s.plot.maxY });
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
    // The connecting line enters and leaves the window between pushes that may
    // both sit outside it, and that visible stretch of line has to fit too —
    // otherwise a window whose only content is a line crossing it (or one
    // holding a few high dots from another series) clips the line away.
    // Pushes *inside* the window need no special handling: a push mean is an
    // average of its runs' means, each of which lies between its own
    // replicates, so it can't escape whichever dots the loop above covered.
    const line = lineEdgeExtent(s.data.pushes, span);
    if (line) {
      if (line.min < min) min = line.min;
      if (line.max > max) max = line.max;
    }
    if (Number.isFinite(min)) ranges.push({ min, max });
  }
  return unionRange(ranges) ?? { min: 0, max: 1 };
}

// Where the connecting line crosses the two edges of `span`, interpolated
// between the pushes bracketing each edge — the same vertices chartDraw joins,
// so the domain can't disagree with what gets painted. Null when the line
// doesn't reach into the window from outside on either side.
function lineEdgeExtent(pushes: PushGroup[], span: Span): Range | null {
  if (pushes.length < 2) return null;
  const edges: number[] = [];
  for (const at of [span.start, span.end]) {
    const i = lowerBound(pushes, at);
    // Needs a push on each side: at the ends of the series the line simply
    // stops, and a push exactly on the edge is already inside the window.
    if (i === 0 || i >= pushes.length || pushes[i].x === at) continue;
    const a = pushes[i - 1];
    const b = pushes[i];
    edges.push(a.mean + ((b.mean - a.mean) * (at - a.x)) / (b.x - a.x));
  }
  if (edges.length === 0) return null;
  return { min: Math.min(...edges), max: Math.max(...edges) };
}
