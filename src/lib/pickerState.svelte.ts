// The reactive core of the picker — all `$state` / `$derived` cells, plus the
// actions and effects that mutate them. Kept out of the .svelte file so the
// template stays a thin renderer and every piece here is exercisable without
// a DOM (see pickerState.test.ts for the seams that need pinning).
//
// State-ownership rule (see docs/design.md): if a new piece of UI needs to
// remember something across renders, it belongs on this class. Local
// mid-typing state (like the FilterInput's textValue) stays in the child
// component.

import {
  DEFAULT_REPOS,
  buildOptionMap,
  fetchFrameworks,
  fetchOptionCollections,
  fetchSignatures,
  toSeries,
  type Series,
} from './api';
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

export type ExpansionOverride = 'user-open' | 'user-closed';

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

  // ---- Selection --------------------------------------------------------
  picked = $state(new Map<number, Series>());

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

  // Master checkbox scope: every row the current filter+expansion would
  // render *and* the user can actually pick. Virtual scrolling means most of
  // these aren't in the DOM at any given moment, but they are all "shown to
  // the user" as they scroll — so select-all covers everything the filter
  // has surfaced. Parents that only survived because a child matched
  // (`autoExpanded`) are excluded: their checkboxes are disabled in the
  // template, so select-all mustn't try to include them either.
  pickableRows = $derived.by(() => {
    const rows: Series[] = [];
    for (const p of this.filteredParents) {
      if (!this.autoExpanded.has(p.key)) rows.push(p);
      if (this.isRowExpanded(p.key)) {
        for (const c of this.childrenForParent(p)) rows.push(c);
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
    // Load framework + option-collection maps once. Cannot happen before
    // any repo fetches: `toSeries` needs both maps to enrich signatures.
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
  toggleFilterChip(field: FilterField, value: string): void {
    const chip: FilterChip = { field, value: value.toLowerCase() };
    this.filter = toggleChip(this.filter, chip);
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
