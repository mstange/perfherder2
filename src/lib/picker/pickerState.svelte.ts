// The reactive core of the picker — all `$state` / `$derived` cells, plus the
// actions and effects that mutate them. Kept out of the .svelte file so the
// template stays a thin renderer and every piece here is exercisable without
// a DOM (see pickerState.test.svelte.ts for the seams that need pinning).
//
// State-ownership rule (see docs/design.md): if a new piece of UI needs to
// remember something across renders, it belongs on this class. Local
// mid-typing state (like the FilterInput's textValue) stays in the child
// component.

import {
  MAX_IDS_PER_REQUEST,
  activityCacheKey,
  buildActivities,
  chunkIds,
  type Activity,
} from './activity';
import { fetchActivityData } from './activityApi';
import { buildOptionMap, fetchFrameworks, fetchOptionCollections, fetchSignatures } from './signaturesApi';
import { type Series, toSeries } from './series';
import { DEFAULT_REPOS, PINNED_REPOS } from './pickerOptions';
import {
  EMPTY_FILTER,
  cacheKey,
  compareRows,
  cycleSort,
  groupChildrenByParent,
  hasChip,
  isFilterActive,
  matchParentWithChildren,
  matchesRow,
  pickCachedForRepo,
  toggleChip,
  type Filter,
  type FilterChip,
  type FilterField,
  type SortColumn,
  type SortState,
} from './filter';
import type { PickerViewState } from '../urlState';

export type ExpansionOverride = 'user-open' | 'user-closed';

// Long enough that a flung scrollbar doesn't queue a request per frame for
// windows nobody looked at, short enough that a deliberate scroll-and-read
// fills in while the eye is still travelling.
export const ACTIVITY_DEBOUNCE_MS = 150;

// Bounded like the graph caches: scrolling a 25k-row list would otherwise
// accumulate entries for the lifetime of the tab. Eviction is insertion
// order — least recently *fetched*, not least recently read. True read-LRU
// would mean writing to the cache during render, which isn't worth it for a
// decoration; the cost is that scrolling far away and back refetches.
const MAX_ACTIVITY_ENTRIES = 5000;

export class PickerState {
  // ---- User-visible controls --------------------------------------------
  selectedRepos = $state(new Set<string>(DEFAULT_REPOS));
  // Filter semantic only: when on and the filter is active, a parent
  // qualifies if it OR any of its children match, and parents that survived
  // via a child are auto-expanded. The subtests=1 fetch is driven by the
  // derived `needSubtestsFetch` below, so a user expanding a row triggers
  // the fetch without also changing what the filter matches.
  matchSubtests = $state(false);
  timeRangeSeconds = $state(1209600); // 14 days, matches perfherder default.
  filter = $state<Filter>(EMPTY_FILTER);
  sort = $state<SortState | null>(null);
  // Repo chips beyond Perfherder's pinned four, from a seed that named repos
  // it doesn't pin — a graph of mozilla-release series, or a shared link whose
  // `pr=` says so. Without these the repo would still be fetched and its rows
  // still listed, with no chip to explain where they came from. Fixed at seed
  // time rather than derived from `selectedRepos`, so unchecking such a chip
  // doesn't take the chip — and the way back — with it.
  extraRepos = $state<readonly string[]>([]);
  repoChips = $derived([...PINNED_REPOS, ...this.extraRepos]);
  // Explicit user overrides layered over the derived `autoExpanded` set.
  // `user-open` / `user-closed` win over the filter's auto-open, so clicking
  // the caret on an auto-expanded row actually collapses it. Keyed by
  // `Series.key` (`${repo}|${id}`) so aliased signature_hashes don't collapse
  // sibling rows into the same override slot — see docs/design.md
  // "Row identity" for the aliasing modes.
  userExpansion = $state(new Map<string, ExpansionOverride>());

  // ---- Fetch caches -----------------------------------------------------
  seriesCache = $state(new Map<string, Series[]>());
  loadingRepos = $state(new Set<string>());
  errors = $state<string[]>([]);

  // ---- Run activity -----------------------------------------------------
  // How often each row has actually run in the selected range, for the rows a
  // caller says are on screen. Fetched lazily and in batches because the
  // alternative — counts for all ~25k filtered rows — is what makes the
  // column unaffordable, and reveal-on-hover is what makes it useless.
  //
  // `activityCacheKey(row.key, interval)` → the row's answer, or the reason
  // it hasn't got one. An absent entry means "not fetched yet", which is why
  // an idle series has to be stored as `total: 0` rather than left out.
  activityCache = $state(new Map<string, Activity>());
  // Cache keys queued or in flight, so a row isn't requested twice.
  private activityPending = new Set<string>();
  // Rows waiting for the next batch, keyed by `Series.key` to dedupe.
  private activityQueue = new Map<string, Series>();
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  private activityControllers = new Set<AbortController>();

  // ---- Selection --------------------------------------------------------
  picked = $state(new Map<number, Series>());
  // Rows that are already on the graph, `Series.key` → the color they're drawn
  // in. Kept in sync by AddSeriesPicker from AppState.plottedColors. These
  // rows carry their swatch and a Remove button instead of an Add one: adding
  // them again is a no-op, and the series list — the other place removal lives
  // — is behind the overlay and out of reach while the panel is open.
  plotted = $state<ReadonlyMap<string, string>>(new Map());

  // ---- Metadata (framework + option-collection maps) --------------------
  // Framework names aren't shown, but they participate in `searchText` so
  // typing "browsertime" as free text narrows correctly.
  frameworkMap = $state<Map<number, string>>(new Map());
  optionMap = $state<Map<string, string[]>>(new Map());
  metadataReady = $state(false);
  metadataError = $state<string | null>(null);

  // ---- Derived reactive graph ------------------------------------------
  // We need the fatter subtests=1 payload whenever the filter descends into
  // subtests OR the user has manually expanded any row.
  needSubtestsFetch = $derived.by(() => {
    if (this.matchSubtests) return true;
    for (const state of this.userExpansion.values()) {
      if (state === 'user-open') return true;
    }
    return false;
  });

  // Combined series across selected repos. Prefers subtests=1 cache; falls
  // back to subtests=0 so the top-level list stays visible while the fatter
  // fetch is in flight.
  combined = $derived.by(() => {
    const rows: Series[] = [];
    for (const repo of this.selectedRepos) {
      const data = pickCachedForRepo(this.seriesCache, repo, this.timeRangeSeconds);
      if (data) rows.push(...data);
    }
    return rows;
  });

  childrenByParent = $derived(groupChildrenByParent(this.combined));
  filterActive = $derived(isFilterActive(this.filter));

  // Top-level rows and per-parent child bookkeeping. When "Match inside
  // subtests" is on, a parent qualifies if it OR any of its children match;
  // parents that survived via a child are added to `autoExpanded` so the
  // reason for their presence is visible; `matchedChildren` holds the
  // exact subset for each parent so we can hide non-matching siblings.
  private filterResult = $derived.by(() => {
    const parents: Series[] = [];
    const autoExpanded = new Set<string>();
    const matchedChildren = new Map<string, Series[]>();
    for (const row of this.combined) {
      if (row.isSubtest) continue;
      if (this.matchSubtests && this.filterActive) {
        const kids = this.childrenByParent.get(row.key) ?? [];
        const m = matchParentWithChildren(row, kids, this.filter);
        if (!m) continue;
        parents.push(row);
        if (!m.selfMatched) autoExpanded.add(row.key);
        matchedChildren.set(row.key, m.matchedChildren);
      } else if (matchesRow(row, this.filter)) {
        parents.push(row);
      }
    }
    if (this.sort) parents.sort((a, b) => compareRows(a, b, this.sort));
    return { parents, autoExpanded, matchedChildren };
  });

  filteredParents = $derived(this.filterResult.parents);
  autoExpanded = $derived(this.filterResult.autoExpanded);
  anyLoading = $derived(this.loadingRepos.size > 0);

  // What the row list has to say for itself. Three of these look the same from
  // the template — an empty table — and mean very different things, so the
  // distinction is drawn once here rather than as a chain of `{#if}`s.
  //
  // `loading` includes the stretch before `metadataReady`: the fetch effect
  // waits on the framework and option-collection maps, so nothing is in flight
  // yet and `anyLoading` is false. Without that clause the list claimed "no
  // matching series" for the length of two requests it had not yet made. A
  // failed metadata load is excluded — `metadataReady` never becomes true after
  // one, and the panel's error banner is already saying so.
  listStatus = $derived.by((): 'rows' | 'loading' | 'no-repos' | 'no-matches' => {
    if (this.filteredParents.length > 0) return 'rows';
    if (this.anyLoading || (!this.metadataReady && this.metadataError === null)) return 'loading';
    // Nothing is fetched for a repo that isn't checked, so an empty list here
    // is the repo row's doing, not the filter's.
    if (this.selectedRepos.size === 0) return 'no-repos';
    return 'no-matches';
  });

  // Master checkbox scope: every row the current filter+expansion would
  // render *and* the user can actually pick. Virtual scrolling means most of
  // these aren't in the DOM at any given moment, but they are all "shown to
  // the user" as they scroll — so select-all covers everything the filter
  // has surfaced. Parents that only survived because a child matched
  // (`autoExpanded`) are excluded: their checkboxes are disabled in the
  // template, so select-all mustn't try to include them either.
  // Rows already on the graph are excluded too: their control is Remove, not
  // Add, so select-all must not silently count them as picked.
  pickableRows = $derived.by(() => {
    const rows: Series[] = [];
    for (const p of this.filteredParents) {
      if (!this.autoExpanded.has(p.key) && !this.plotted.has(p.key)) rows.push(p);
      if (this.isRowExpanded(p.key)) {
        for (const c of this.childrenForParent(p)) {
          if (!this.plotted.has(c.key)) rows.push(c);
        }
      }
    }
    return rows;
  });
  allPickablePicked = $derived(
    this.pickableRows.length > 0 &&
      this.pickableRows.every((r) => this.picked.has(r.id)),
  );
  somePickablePicked = $derived(
    this.pickableRows.some((r) => this.picked.has(r.id)),
  );

  // True when this row is shown but not directly pickable — a parent that
  // only survived the filter via a matching child. The template greys the
  // row out and disables its checkbox / badge clicks; the disclosure caret
  // stays live so users can still collapse the subtest tree.
  isRowDisabled(row: Series): boolean {
    return !row.isSubtest && this.autoExpanded.has(row.key);
  }

  constructor() {
    // Load framework + option-collection maps once. Must happen before any
    // repo fetch — the effect below waits on `metadataReady` — because
    // `toSeries` needs both maps to enrich signatures.
    void this.loadMetadata();

    // Fetch missing (repo, needSubtestsFetch, interval) tuples.
    $effect(() => {
      if (!this.metadataReady) return;
      for (const repo of this.selectedRepos) {
        const key = cacheKey(repo, this.needSubtestsFetch, this.timeRangeSeconds);
        if (this.seriesCache.has(key) || this.loadingRepos.has(key)) continue;
        void this.loadRepo(repo, this.needSubtestsFetch, this.timeRangeSeconds);
      }
    });

    // Stop paying for activity in a window the user has left. Reading
    // `timeRangeSeconds` is the whole subscription; the first run is a no-op
    // because nothing is in flight yet.
    $effect(() => {
      void this.timeRangeSeconds;
      this.resetActivityRequests();
    });
  }

  private async loadMetadata(): Promise<void> {
    try {
      const [frameworks, ocs] = await Promise.all([
        fetchFrameworks(),
        fetchOptionCollections(),
      ]);
      this.frameworkMap = new Map(frameworks.map((f) => [f.id, f.name]));
      this.optionMap = buildOptionMap(ocs);
      this.metadataReady = true;
    } catch (e) {
      this.metadataError = (e as Error).message;
    }
  }

  private async loadRepo(
    repo: string,
    sub: boolean,
    interval: number,
  ): Promise<void> {
    const key = cacheKey(repo, sub, interval);
    const next = new Set(this.loadingRepos);
    next.add(key);
    this.loadingRepos = next;
    try {
      const raw = await fetchSignatures(repo, interval, sub);
      const series = toSeries(raw, repo, this.frameworkMap, this.optionMap);
      const cache = new Map(this.seriesCache);
      cache.set(key, series);
      this.seriesCache = cache;
    } catch (e) {
      this.errors = [...this.errors, `${repo}: ${(e as Error).message}`];
    } finally {
      const done = new Set(this.loadingRepos);
      done.delete(key);
      this.loadingRepos = done;
    }
  }

  // ---- Run activity fetching --------------------------------------------
  // Null means "not fetched yet" — the caller renders a placeholder rather
  // than a zero, which would be a claim we haven't earned.
  activityFor(row: Series): Activity | null {
    return (
      this.activityCache.get(activityCacheKey(row.key, this.timeRangeSeconds)) ?? null
    );
  }

  // Called from the picker's virtual-scroll effect with the rows currently on
  // screen. Cheap and idempotent: everything already cached or in flight is
  // dropped here, so a scroll that reveals two new rows queues two ids.
  requestActivity(rows: readonly Series[]): void {
    for (const row of rows) {
      const key = activityCacheKey(row.key, this.timeRangeSeconds);
      if (this.activityCache.has(key) || this.activityPending.has(key)) continue;
      this.activityPending.add(key);
      this.activityQueue.set(row.key, row);
    }
    if (this.activityQueue.size === 0 || this.activityTimer !== null) return;
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      this.flushActivityQueue();
    }, ACTIVITY_DEBOUNCE_MS);
  }

  // Abort whatever is in flight and forget what was queued. Called when the
  // interval changes, purely to stop paying for answers about a window the
  // user has left: every cache and pending key carries its interval, so a
  // late response could only ever write an entry nobody reads. This is a
  // bandwidth optimisation, not a correctness mechanism — if it ran late, or
  // not at all, the column would still be right. Nothing here needs to be
  // ordered against the fetch effect.
  private resetActivityRequests(): void {
    for (const c of this.activityControllers) c.abort();
    this.activityControllers.clear();
    this.activityPending.clear();
    this.activityQueue.clear();
    if (this.activityTimer !== null) {
      clearTimeout(this.activityTimer);
      this.activityTimer = null;
    }
  }

  private flushActivityQueue(): void {
    // Captured once: the interval must not change under a batch mid-flight.
    const interval = this.timeRangeSeconds;
    const byRepo = new Map<string, number[]>();
    for (const row of this.activityQueue.values()) {
      const ids = byRepo.get(row.repository);
      if (ids) ids.push(row.id);
      else byRepo.set(row.repository, [row.id]);
    }
    this.activityQueue.clear();
    for (const [repo, ids] of byRepo) {
      for (const chunk of chunkIds(ids, MAX_IDS_PER_REQUEST)) {
        void this.loadActivity(repo, chunk, interval);
      }
    }
  }

  private async loadActivity(
    repo: string,
    ids: number[],
    interval: number,
  ): Promise<void> {
    const controller = new AbortController();
    this.activityControllers.add(controller);
    // The keys these ids will be filed under. Built up front so the failure
    // path marks exactly the same set the success path would have.
    const keys = ids.map((id) => activityCacheKey(`${repo}|${id}`, interval));
    try {
      const response = await fetchActivityData(repo, ids, interval, controller.signal);
      const built = buildActivities(ids, response, Date.now(), interval);
      const entries: [string, Activity][] = [];
      for (const [id, activity] of built) {
        entries.push([activityCacheKey(`${repo}|${id}`, interval), activity]);
      }
      this.mergeActivity(entries);
    } catch (e) {
      // An aborted request isn't a failure to report — the interval moved on.
      if (controller.signal.aborted) return;
      // Per-row and quiet: no entry in `errors`, which is the banner the list
      // uses for "your repos didn't load". This column is decoration on a
      // list that works without it, and must not be why the picker looks
      // broken.
      const message = (e as Error).message;
      this.mergeActivity(keys.map((k): [string, Activity] => [k, { error: message }]));
    } finally {
      this.activityControllers.delete(controller);
      for (const k of keys) this.activityPending.delete(k);
    }
  }

  private mergeActivity(entries: readonly [string, Activity][]): void {
    if (entries.length === 0) return;
    const next = new Map(this.activityCache);
    for (const [k, v] of entries) {
      // Delete before set so a refetched key moves to the end of the
      // insertion order rather than keeping its old position.
      next.delete(k);
      next.set(k, v);
    }
    while (next.size > MAX_ACTIVITY_ENTRIES) {
      const oldest = next.keys().next().value;
      if (oldest === undefined) break;
      next.delete(oldest);
    }
    this.activityCache = next;
  }

  // ---- Read helpers -----------------------------------------------------
  // Which children to show under an expanded parent. When the filter is
  // active AND we're in subtest-matching mode, only render the subset that
  // matched — so a subtest-badge click reveals exactly the row the user
  // clicked instead of 200 siblings.
  childrenForParent(parent: Series): Series[] {
    const all = this.childrenByParent.get(parent.key) ?? [];
    if (!this.matchSubtests || !this.filterActive) return all;
    return this.filterResult.matchedChildren.get(parent.key) ?? all;
  }

  isRowExpanded(key: string): boolean {
    const override = this.userExpansion.get(key);
    if (override) return override === 'user-open';
    return this.autoExpanded.has(key);
  }

  // Children under an expanded parent: sort by the same column so a
  // "sort by unit" ordering carries through into the subtest rows.
  sortedChildren(children: Series[]): Series[] {
    if (!this.sort) return children;
    return [...children].sort((a, b) => compareRows(a, b, this.sort));
  }

  isChipActive(field: FilterField, value: string): boolean {
    return hasChip(this.filter, { field, value: value.toLowerCase() });
  }

  // ---- Mutations --------------------------------------------------------
  // One-time seeding from the app. The panel is mounted fresh every time it
  // opens, so this is where a starting point arrives — either carried in the
  // URL or derived from the series already plotted
  // (AppState.derivePickerView). Not a binding: the picker owns all of this
  // state afterwards and reports it back through `view`.
  //
  // Must be called during setup, before the constructor's fetch effect first
  // runs, so the seeded repos and interval are fetched instead of the defaults.
  seed(view: PickerViewState): void {
    this.filter = view.filter;
    this.sort = view.sort;
    if (view.matchSubtests !== null) {
      this.matchSubtests = view.matchSubtests;
    } else if (view.filter.chips.some((c) => c.field === 'test')) {
      // Parent rows carry no `test` of their own, so a `test:` chip matches
      // nothing unless the filter descends into subtests — the same dead end
      // the `fromSubtest` nudge in `toggleFilterChip` exists to avoid. It's
      // easy to reach here: a filter derived from subtest series always has a
      // `test:` chip. Only for an *unspecified* value: an explicit `psub=0`
      // in a link is the user having unchecked the box, and it wins.
      this.matchSubtests = true;
    }
    // Null means "unspecified", which keeps the defaults. An empty array is
    // different: it's every chip unchecked, and it fetches nothing.
    if (view.repos) {
      this.selectedRepos = new Set(view.repos);
      this.extraRepos = view.repos.filter((r) => !PINNED_REPOS.includes(r));
    }
    if (view.intervalSeconds !== null) this.timeRangeSeconds = view.intervalSeconds;
  }

  // The counterpart to `seed`: everything the URL carries, resolved to the
  // concrete values the controls are actually showing. AddSeriesPicker reports
  // this upward on every change.
  view = $derived<PickerViewState>({
    filter: this.filter,
    repos: [...this.selectedRepos],
    intervalSeconds: this.timeRangeSeconds,
    matchSubtests: this.matchSubtests,
    sort: this.sort,
  });

  onSortHeader(column: SortColumn): void {
    this.sort = cycleSort(this.sort, column);
  }

  toggleRepo(repo: string): void {
    const next = new Set(this.selectedRepos);
    if (next.has(repo)) next.delete(repo);
    else next.add(repo);
    this.selectedRepos = next;
  }

  togglePick(row: Series, on: boolean): void {
    const next = new Map(this.picked);
    if (on) next.set(row.id, row);
    else next.delete(row.id);
    this.picked = next;
  }

  // Flip whichever state the row is currently showing. A single override
  // map handles all four combinations of (auto expanded, user override):
  // the resolved state comes from `isRowExpanded`, and the new override
  // always wins on the next render. `needSubtestsFetch` notices the new
  // `user-open` entry and kicks off the subtests=1 fetch — we do not
  // touch `matchSubtests`, which is now a pure filter semantic.
  toggleExpanded(key: string): void {
    const nextState: ExpansionOverride = this.isRowExpanded(key)
      ? 'user-closed'
      : 'user-open';
    const next = new Map(this.userExpansion);
    next.set(key, nextState);
    this.userExpansion = next;
  }

  clearPicked(): void {
    this.picked = new Map();
  }

  pickedSeries(): Series[] {
    return [...this.picked.values()];
  }

  // Toggle a chip for a badge click. Values are normalized to lowercase so
  // the same field:value pair dedupes correctly regardless of the badge's
  // casing.
  //
  // `fromSubtest` is set by the AddSeriesPicker template when the click
  // originated on a subtest row. In that case we auto-enable `matchSubtests`
  // if it isn't already on: parent rows have no `test` field of their own,
  // so a `test:<subtest-name>` chip added by clicking a subtest badge would
  // otherwise empty the list (no parent could satisfy it). This trip-wire
  // fixes that specific dead-end without changing filter behaviour for
  // chips added from parent rows or typed into the FilterInput. The user
  // can still uncheck the box after the fact if they want to reset.
  toggleFilterChip(
    field: FilterField,
    value: string,
    opts?: { fromSubtest?: boolean },
  ): void {
    const chip: FilterChip = { field, value: value.toLowerCase() };
    const nextFilter = toggleChip(this.filter, chip);
    // Only nudge matchSubtests when we're ADDING a chip from a subtest —
    // not when we're removing one (which would be an odd time to opt in).
    const added = nextFilter.chips.length > this.filter.chips.length;
    this.filter = nextFilter;
    if (added && opts?.fromSubtest && !this.matchSubtests) {
      this.matchSubtests = true;
    }
  }

  toggleSelectAll(): void {
    const next = new Map(this.picked);
    if (this.allPickablePicked) {
      for (const r of this.pickableRows) next.delete(r.id);
    } else {
      for (const r of this.pickableRows) next.set(r.id, r);
    }
    this.picked = next;
  }

  // ---- Read-only lookups for the repo-chip row --------------------------
  // Same "prefer subtests=1, fall back to subtests=0" preference as
  // `combined`, but per-repo — used to render each repo chip's count.
  countForRepoChip(repo: string): number | 'loading' | null {
    const displayed = pickCachedForRepo(
      this.seriesCache,
      repo,
      this.timeRangeSeconds,
    );
    if (displayed) return displayed.filter((s) => !s.isSubtest).length;
    if (
      this.loadingRepos.has(cacheKey(repo, false, this.timeRangeSeconds)) ||
      this.loadingRepos.has(cacheKey(repo, true, this.timeRangeSeconds))
    ) {
      return 'loading';
    }
    return null;
  }
}
