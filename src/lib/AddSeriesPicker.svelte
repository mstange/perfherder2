<script lang="ts">
  import {
    DEFAULT_REPOS,
    PINNED_REPOS,
    TIME_RANGES,
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
  import FilterInput from './FilterInput.svelte';

  type Props = {
    onadd?: (series: Series[]) => void;
  };
  let { onadd }: Props = $props();

  // User-visible controls.
  let selectedRepos = $state(new Set<string>(DEFAULT_REPOS));
  // Filter semantic only: when on and the filter is active, a parent
  // qualifies if it OR any of its children match, and parents that survived
  // via a child are auto-expanded. The checkbox drives *only* this — the
  // fatter subtests=1 fetch is triggered by `needSubtestsFetch` below, so
  // manually expanding a row starts that fetch without also changing what
  // the filter matches.
  let matchSubtests = $state(false);
  let timeRangeSeconds = $state(1209600); // 14 days, matches perfherder default.
  let filter = $state<Filter>(EMPTY_FILTER);
  let sort = $state<SortState | null>(null);
  // Explicit user overrides layered over the derived `autoExpanded` set.
  // `user-open` and `user-closed` win over whatever the filter would auto-do,
  // so clicking the caret on an auto-expanded row (to hide the subtests it
  // just revealed) actually collapses it. Keyed by `Series.key`, not by
  // signature_hash alone — two repos can share a hash for the same test.
  let userExpansion = $state(new Map<string, 'user-open' | 'user-closed'>());

  // Cached signature responses.
  let seriesCache = $state(new Map<string, Series[]>());
  let loadingRepos = $state(new Set<string>());
  let errors = $state<string[]>([]);

  // Selection: signature id -> Series.
  let picked = $state(new Map<number, Series>());

  // Metadata (frameworks + option collections). Loaded once.
  //
  // We still fetch framework names — they're not shown in the UI, but they
  // participate in the searchable text (users may type "talos" / "browsertime"
  // as a search token).
  let frameworkMap = $state<Map<number, string>>(new Map());
  let optionMap = $state<Map<string, string[]>>(new Map());
  let metadataReady = $state(false);
  let metadataError = $state<string | null>(null);

  (async () => {
    try {
      const [frameworks, ocs] = await Promise.all([
        fetchFrameworks(),
        fetchOptionCollections(),
      ]);
      frameworkMap = new Map(frameworks.map((f) => [f.id, f.name]));
      optionMap = buildOptionMap(ocs);
      metadataReady = true;
    } catch (e) {
      metadataError = (e as Error).message;
    }
  })();

  // We need the fatter subtests=1 payload whenever the filter descends into
  // subtests (matchSubtests) OR the user has manually expanded any row —
  // either case makes child rows part of what's visible on screen.
  const needSubtestsFetch = $derived.by(() => {
    if (matchSubtests) return true;
    for (const state of userExpansion.values()) {
      if (state === 'user-open') return true;
    }
    return false;
  });

  // Whenever inputs change, kick off fetches for any missing cache entries.
  $effect(() => {
    if (!metadataReady) return;
    for (const repo of selectedRepos) {
      const key = cacheKey(repo, needSubtestsFetch, timeRangeSeconds);
      if (seriesCache.has(key) || loadingRepos.has(key)) continue;
      loadRepo(repo, needSubtestsFetch, timeRangeSeconds);
    }
  });

  async function loadRepo(repo: string, sub: boolean, interval: number) {
    const key = cacheKey(repo, sub, interval);
    const next = new Set(loadingRepos);
    next.add(key);
    loadingRepos = next;
    try {
      const raw = await fetchSignatures(repo, interval, sub);
      const series = toSeries(raw, repo, frameworkMap, optionMap);
      const cache = new Map(seriesCache);
      cache.set(key, series);
      seriesCache = cache;
    } catch (e) {
      errors = [...errors, `${repo}: ${(e as Error).message}`];
    } finally {
      const done = new Set(loadingRepos);
      done.delete(key);
      loadingRepos = done;
    }
  }

  // Combined series across selected repos.
  //
  // A subtests=1 fetch is a strict superset of subtests=0 (it also includes
  // child rows), so we prefer that if loaded, and otherwise fall back to the
  // no-subtests cache. This keeps the list stable when the user first
  // enables "Include subtests" or clicks a disclosure — the top-level rows
  // stay visible while the richer fetch is in flight.
  const combined = $derived.by(() => {
    const rows: Series[] = [];
    for (const repo of selectedRepos) {
      const data = pickCachedForRepo(seriesCache, repo, timeRangeSeconds);
      if (data) rows.push(...data);
    }
    return rows;
  });

  const childrenByParent = $derived(groupChildrenByParent(combined));

  const filterActive = $derived(isFilterActive(filter));

  // Top-level rows and per-parent child bookkeeping.
  //
  // When "Match inside subtests" is on, a parent qualifies if it OR any of
  // its children match the filter. Parents that qualify only through a child
  // are auto-expanded so the reason for their presence is visible. When the
  // filter is active, `matchedChildren` holds the exact subset of children
  // that matched — the caller uses that to hide non-matching siblings under
  // an expanded parent.
  const filterResult = $derived.by(() => {
    const parents: Series[] = [];
    const autoExpanded = new Set<string>();
    const matchedChildren = new Map<string, Series[]>();
    for (const row of combined) {
      if (row.isSubtest) continue;
      if (matchSubtests && filterActive) {
        const kids = childrenByParent.get(row.key) ?? [];
        const m = matchParentWithChildren(row, kids, filter);
        if (!m) continue;
        parents.push(row);
        if (!m.selfMatched) autoExpanded.add(row.key);
        matchedChildren.set(row.key, m.matchedChildren);
      } else if (matchesRow(row, filter)) {
        parents.push(row);
      }
    }
    if (sort) parents.sort((a, b) => compareRows(a, b, sort));
    return { parents, autoExpanded, matchedChildren };
  });

  const filteredParents = $derived(filterResult.parents);
  const autoExpanded = $derived(filterResult.autoExpanded);

  // Cap top-level rendering.
  const RENDER_CAP = 500;
  const visibleParents = $derived(filteredParents.slice(0, RENDER_CAP));
  const overflow = $derived(Math.max(0, filteredParents.length - RENDER_CAP));

  // Which children to show under an expanded parent. When the filter is
  // active and we're in subtest-matching mode, only render the subset that
  // matched — so a subtest-badge click reveals exactly the row the user
  // clicked instead of 200 siblings.
  function childrenForParent(parent: Series): Series[] {
    const all = childrenByParent.get(parent.key) ?? [];
    if (!matchSubtests || !filterActive) return all;
    return filterResult.matchedChildren.get(parent.key) ?? all;
  }

  function isRowExpanded(key: string): boolean {
    const override = userExpansion.get(key);
    if (override) return override === 'user-open';
    return autoExpanded.has(key);
  }

  // Children under an expanded parent: sort by the same column so a
  // "sort by unit" ordering carries through into the subtest rows.
  function sortedChildren(children: Series[]): Series[] {
    if (!sort) return children;
    return [...children].sort((a, b) => compareRows(a, b, sort));
  }

  function onSortHeader(column: SortColumn) {
    sort = cycleSort(sort, column);
  }

  function toggleRepo(repo: string) {
    const next = new Set(selectedRepos);
    if (next.has(repo)) next.delete(repo);
    else next.add(repo);
    selectedRepos = next;
  }

  function togglePick(row: Series, on: boolean) {
    const next = new Map(picked);
    if (on) next.set(row.id, row);
    else next.delete(row.id);
    picked = next;
  }

  function toggleExpanded(key: string) {
    // Flip whichever state the row is currently showing. A single override
    // map handles all four combinations (auto vs. no-auto × override vs. no
    // override): the resolved state comes from `isRowExpanded`, and the new
    // override always wins on the next render. The `needSubtestsFetch`
    // derivation notices the new `user-open` entry and kicks off the
    // subtests=1 fetch — we do not touch `matchSubtests`, which is now a
    // pure filter semantic.
    const nextState = isRowExpanded(key) ? 'user-closed' : 'user-open';
    const next = new Map(userExpansion);
    next.set(key, nextState);
    userExpansion = next;
  }

  function clearPicked() {
    picked = new Map();
  }

  function addPicked() {
    onadd?.([...picked.values()]);
  }

  // Toggle a chip for a badge click. Chip values are normalized to lowercase
  // so the same field:value pair always dedupes correctly regardless of the
  // casing on the badge.
  function toggleFilterChip(field: FilterField, value: string) {
    const chip: FilterChip = { field, value: value.toLowerCase() };
    filter = toggleChip(filter, chip);
  }

  function isActive(field: FilterField, value: string): boolean {
    return hasChip(filter, { field, value: value.toLowerCase() });
  }

  const anyLoading = $derived(loadingRepos.size > 0);

  // Master checkbox scope: every row currently rendered in the DOM (parents
  // plus their visible children when expanded). This maps to "what the user
  // sees" — narrower and safer than "all matches" when the filter has 25k
  // hits and the render cap is 500.
  const renderedRows = $derived.by(() => {
    const rows: Series[] = [];
    for (const p of visibleParents) {
      rows.push(p);
      if (isRowExpanded(p.key)) {
        for (const c of childrenForParent(p)) rows.push(c);
      }
    }
    return rows;
  });
  const allRenderedPicked = $derived(
    renderedRows.length > 0 && renderedRows.every((r) => picked.has(r.id)),
  );
  const someRenderedPicked = $derived(renderedRows.some((r) => picked.has(r.id)));

  function toggleSelectAll() {
    const next = new Map(picked);
    if (allRenderedPicked) {
      for (const r of renderedRows) next.delete(r.id);
    } else {
      for (const r of renderedRows) next.set(r.id, r);
    }
    picked = next;
  }
</script>

<div class="picker">
  <header>
    <h2>Add series</h2>
    <p class="hint">
      One combined list across selected repos. Filter by clicking any badge or
      by typing free text / <code>field:value</code> tokens. Expand a row to
      see its subtests.
    </p>
  </header>

  {#if metadataError}
    <div class="error">Failed to load metadata: {metadataError}</div>
  {/if}

  <section class="controls">
    <div class="control-row filter-row">
      <span class="control-label">Filter</span>
      <FilterInput {filter} onchange={(next) => (filter = next)} />
      <div class="time-controls">
        <label class="inline-label" for="time-range-select">Time range</label>
        <select id="time-range-select" bind:value={timeRangeSeconds}>
          {#each TIME_RANGES as tr}
            <option value={tr.value}>{tr.label}</option>
          {/each}
        </select>
        <label class="toggle">
          <input type="checkbox" bind:checked={matchSubtests} />
          Match inside subtests
        </label>
      </div>
    </div>

    <div class="control-row">
      <span class="control-label">Repos</span>
      <div class="chips">
        {#each PINNED_REPOS as repo}
          {@const displayed =
            seriesCache.get(cacheKey(repo, true, timeRangeSeconds)) ??
            seriesCache.get(cacheKey(repo, false, timeRangeSeconds))}
          {@const loading =
            !displayed &&
            (loadingRepos.has(cacheKey(repo, false, timeRangeSeconds)) ||
              loadingRepos.has(cacheKey(repo, true, timeRangeSeconds)))}
          <label class="chip" class:chip-on={selectedRepos.has(repo)}>
            <input
              type="checkbox"
              checked={selectedRepos.has(repo)}
              onchange={() => toggleRepo(repo)}
            />
            <span class="chip-name">{repo}</span>
            <span class="chip-count" class:chip-count-dim={!selectedRepos.has(repo)}>
              {#if loading}…{:else if displayed}{displayed.filter((s) => !s.isSubtest).length.toLocaleString()}{:else}&nbsp;{/if}
            </span>
          </label>
        {/each}
      </div>
    </div>
  </section>

  <!-- The action buttons stay mounted even when nothing is selected so the
       status row's height never changes. Disabled state is the visual
       signal that no rows are picked. -->
  <div class="status">
    <span>
      {filteredParents.length.toLocaleString()} matching / {combined.filter(
        (r) => !r.isSubtest,
      ).length.toLocaleString()} total
    </span>
    {#if anyLoading}<span class="loading-note">Loading…</span>{/if}
    <span class="picked-count" class:muted={picked.size === 0}>
      {picked.size} selected
    </span>
    <button type="button" onclick={clearPicked} disabled={picked.size === 0}
      >Clear</button
    >
    <button
      type="button"
      class="primary"
      onclick={addPicked}
      disabled={picked.size === 0}>Add {picked.size}</button
    >
  </div>

  {#if errors.length > 0}
    <ul class="errors">
      {#each errors as msg}<li>{msg}</li>{/each}
    </ul>
  {/if}

  <div class="table-wrap">
    <table>
      <thead>
        {#snippet sortHeader(label: string, column: SortColumn)}
          {@const active = sort?.column === column}
          <th
            class="sortable"
            class:sortable-active={active}
            aria-sort={active
              ? sort!.direction === 'asc'
                ? 'ascending'
                : 'descending'
              : 'none'}
          >
            <button
              type="button"
              class="sort-btn"
              onclick={() => onSortHeader(column)}
            >
              <span>{label}</span>
              <span class="sort-indicator" aria-hidden="true">
                {#if active}{sort!.direction === 'asc' ? '▲' : '▼'}{:else}▲▼{/if}
              </span>
            </button>
          </th>
        {/snippet}

        <tr>
          <th class="col-check">
            <input
              type="checkbox"
              checked={allRenderedPicked}
              indeterminate={someRenderedPicked && !allRenderedPicked}
              disabled={renderedRows.length === 0}
              onchange={toggleSelectAll}
              aria-label={allRenderedPicked
                ? 'Deselect all shown rows'
                : 'Select all shown rows'}
              title={allRenderedPicked
                ? 'Deselect all shown rows'
                : 'Select all shown rows'}
            />
          </th>
          <th class="col-disclose"></th>
          {@render sortHeader('Suite / Test', 'suite')}
          {@render sortHeader('Application', 'application')}
          {@render sortHeader('Repo', 'repo')}
          {@render sortHeader('Platform', 'platform')}
          {@render sortHeader('Options', 'options')}
          {@render sortHeader('Unit', 'unit')}
        </tr>
      </thead>
      <tbody>
        {#snippet badge(field: FilterField, value: string, cls: string)}
          {@const active = isActive(field, value)}
          <button
            type="button"
            class="badge {cls}"
            class:badge-active={active}
            title={active
              ? `Remove filter ${field}:${value}`
              : `Filter to only ${field}:${value}`}
            onclick={() => toggleFilterChip(field, value)}
          >
            <span class="badge-text">{value}</span>
            <span class="badge-cue" aria-hidden="true">{active ? '×' : '+'}</span>
          </button>
        {/snippet}

        {#each visibleParents as row (row.id)}
          {@const parentKey = row.key}
          {@const allChildren = childrenByParent.get(parentKey) ?? []}
          {@const children = childrenForParent(row)}
          {@const isExpanded = isRowExpanded(parentKey)}
          {@const awaitingSubtests =
            isExpanded && row.hasSubtests && allChildren.length === 0}
          <tr class:selected={picked.has(row.id)}>
            <td class="col-check">
              <input
                type="checkbox"
                checked={picked.has(row.id)}
                onchange={(e) =>
                  togglePick(row, (e.currentTarget as HTMLInputElement).checked)}
              />
            </td>
            <td class="col-disclose">
              {#if row.hasSubtests}
                <button
                  type="button"
                  class="disclose"
                  class:disclose-open={isExpanded}
                  aria-label={isExpanded ? 'Collapse subtests' : 'Expand subtests'}
                  onclick={() => toggleExpanded(parentKey)}
                >▶</button>
              {/if}
            </td>
            <td>
              {@render badge('suite', row.suite, 'badge-suite')}
              {#if row.test}
                {@render badge('test', row.test, 'badge-test')}
              {/if}
              {#if row.tags.length > 0}
                <div class="tag-row">
                  {#each row.tags as t}
                    {@render badge('tag', t, 'badge-tag')}{' '}
                  {/each}
                </div>
              {/if}
            </td>
            <td>
              {#if row.application}
                {@render badge('application', row.application, 'badge-app')}
              {/if}
            </td>
            <td>{@render badge('repo', row.repository, 'badge-repo')}</td>
            <td>{@render badge('platform', row.platform, 'badge-platform')}</td>
            <td>
              {#each row.options as o}
                {@render badge('option', o, 'badge-option')}{' '}
              {/each}
            </td>
            <td class="unit">{row.measurementUnit}</td>
          </tr>
          {#if isExpanded}
            {#if awaitingSubtests}
              <tr class="subtest-note">
                <td colspan="8">Loading subtests…</td>
              </tr>
            {:else if allChildren.length === 0}
              <tr class="subtest-note">
                <td colspan="8">No subtests in loaded data.</td>
              </tr>
            {:else if children.length === 0}
              <tr class="subtest-note">
                <td colspan="8">No subtests match the current filter.</td>
              </tr>
            {:else}
              {#each sortedChildren(children) as child (child.id)}
                <tr class="subtest-row" class:selected={picked.has(child.id)}>
                  <td class="col-check">
                    <input
                      type="checkbox"
                      checked={picked.has(child.id)}
                      onchange={(e) =>
                        togglePick(
                          child,
                          (e.currentTarget as HTMLInputElement).checked,
                        )}
                    />
                  </td>
                  <td class="col-disclose"></td>
                  <td class="subtest-cell">
                    {@render badge('test', child.test || child.suite, 'badge-test')}
                    {#if child.tags.length > 0}
                      <div class="tag-row">
                        {#each child.tags as t}
                          {@render badge('tag', t, 'badge-tag')}{' '}
                        {/each}
                      </div>
                    {/if}
                  </td>
                  <td>
                    {#if child.application}
                      {@render badge('application', child.application, 'badge-app')}
                    {/if}
                  </td>
                  <td>{@render badge('repo', child.repository, 'badge-repo')}</td>
                  <td>
                    {@render badge('platform', child.platform, 'badge-platform')}
                  </td>
                  <td>
                    {#each child.options as o}
                      {@render badge('option', o, 'badge-option')}{' '}
                    {/each}
                  </td>
                  <td class="unit">{child.measurementUnit}</td>
                </tr>
              {/each}
            {/if}
          {/if}
        {/each}
        {#if visibleParents.length === 0}
          <tr><td colspan="8" class="empty">
            {#if anyLoading}Loading series…{:else}No matching series.{/if}
          </td></tr>
        {/if}
      </tbody>
    </table>
    {#if overflow > 0}
      <div class="overflow-note">
        Showing the first {RENDER_CAP.toLocaleString()} of {filteredParents.length.toLocaleString()}.
        Narrow your filter to see more.
      </div>
    {/if}
  </div>
</div>

<style>
  .picker {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    max-width: 1400px;
    margin: 0 auto;
    color: #1f2328;
    font: 14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  }
  header h2 {
    margin: 0 0 4px;
    font-size: 20px;
  }
  .hint {
    margin: 0;
    color: #57606a;
    font-size: 13px;
  }
  .hint code {
    background: #f6f8fa;
    padding: 0 3px;
    border-radius: 3px;
    font-size: 12px;
  }
  .controls {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    background: #f6f8fa;
    border: 1px solid #d0d7de;
    border-radius: 6px;
  }
  .control-row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .filter-row {
    align-items: flex-start;
  }
  .filter-row .control-label {
    padding-top: 8px;
  }
  .time-controls {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-top: 4px;
  }
  .inline-label {
    color: #57606a;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .control-label {
    min-width: 80px;
    color: #57606a;
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: #fff;
    border: 1px solid #d0d7de;
    border-radius: 999px;
    cursor: pointer;
    user-select: none;
  }
  .chip input {
    margin: 0;
  }
  .chip-on {
    background: #ddf4ff;
    border-color: #54aeff;
  }
  .chip-count {
    display: inline-block;
    min-width: 4.5em;
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    color: #57606a;
  }
  .chip-count-dim {
    opacity: 0.55;
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  select {
    padding: 4px 6px;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    background: #fff;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 4px;
  }
  .picked-count {
    font-weight: 600;
    min-width: 9ch;
    display: inline-block;
  }
  .muted {
    color: #57606a;
    font-weight: 400;
  }
  .loading-note {
    color: #57606a;
    font-style: italic;
  }
  button {
    padding: 4px 12px;
    font: inherit;
    background: #fff;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    cursor: pointer;
  }
  button:disabled {
    color: #8c959f;
    background: #f6f8fa;
    border-color: #d0d7de;
    cursor: not-allowed;
  }
  button.primary {
    background: #1f883d;
    color: #fff;
    border-color: #1f883d;
  }
  button.primary:hover:not(:disabled) {
    background: #1a7f37;
  }
  button.primary:disabled {
    background: #94d3a2;
    color: #ffffffcc;
    border-color: #94d3a2;
  }
  .table-wrap {
    border: 1px solid #d0d7de;
    border-radius: 6px;
    overflow: auto;
    max-height: 70vh;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  thead th {
    position: sticky;
    top: 0;
    background: #f6f8fa;
    border-bottom: 1px solid #d0d7de;
    text-align: left;
    padding: 0;
    z-index: 1;
  }
  thead th:not(.sortable) {
    padding: 6px 8px;
  }
  .sortable {
    /* Ensure the header cell fills so the button occupies it entirely. */
    background: #f6f8fa;
  }
  .sortable-active {
    background: #ddf4ff;
  }
  .sort-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 6px 8px;
    background: transparent;
    border: 0;
    border-radius: 0;
    font: inherit;
    font-weight: 600;
    text-align: left;
    cursor: pointer;
    color: inherit;
  }
  .sort-btn:hover {
    background: rgba(0, 0, 0, 0.04);
  }
  .sort-indicator {
    font-size: 9px;
    color: #57606a;
    opacity: 0.55;
    letter-spacing: -1px;
    font-variant: normal;
  }
  .sortable-active .sort-indicator {
    color: #0969da;
    opacity: 1;
  }
  tbody td {
    padding: 6px 8px;
    border-bottom: 1px solid #eaeef2;
    vertical-align: top;
  }
  tbody tr:hover {
    background: #f6f8fa;
  }
  tbody tr.selected {
    background: #fff8c5;
  }
  tbody tr.selected:hover {
    background: #f7ecac;
  }
  .col-check {
    width: 32px;
  }
  .col-disclose {
    width: 24px;
    padding: 0;
    text-align: center;
  }
  .disclose {
    padding: 0;
    width: 20px;
    height: 20px;
    line-height: 1;
    font-size: 10px;
    color: #57606a;
    background: transparent;
    border: none;
    cursor: pointer;
    transition: transform 0.12s ease;
    user-select: none;
  }
  .disclose:hover {
    color: #1f2328;
  }
  .disclose-open {
    transform: rotate(90deg);
  }
  .subtest-row td {
    background: #fafbfc;
  }
  .subtest-row:hover td {
    background: #f0f3f6;
  }
  .subtest-row.selected td {
    background: #fff8c5;
  }
  .subtest-cell {
    padding-left: 24px !important;
  }
  .subtest-note td {
    padding: 4px 8px 4px 40px;
    color: #57606a;
    font-style: italic;
    background: #fafbfc;
  }
  .tag-row {
    margin-top: 2px;
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  }
  /* Badges are now buttons — same visual as before, but the "+" / "×"
     affordance appears on hover, and always when the chip is active. */
  .badge {
    display: inline-flex;
    align-items: baseline;
    gap: 2px;
    padding: 1px 4px 1px 6px;
    margin: 1px 0;
    font: inherit;
    font-size: 11px;
    line-height: 1.4;
    background: #eaeef2;
    color: #24292f;
    border: 1px solid transparent;
    border-radius: 4px;
    white-space: nowrap;
    cursor: pointer;
  }
  .badge:hover {
    filter: brightness(0.94);
  }
  .badge-cue {
    display: inline-block;
    width: 10px;
    text-align: center;
    color: #57606a;
    font-size: 12px;
    font-weight: 600;
    opacity: 0;
    transition: opacity 0.1s ease;
  }
  .badge:hover .badge-cue,
  .badge-active .badge-cue {
    opacity: 1;
  }
  .badge-active {
    outline: 2px solid #0969da;
    outline-offset: -2px;
    background: #ddf4ff;
    color: #0a4b70;
  }
  .badge-active .badge-cue {
    color: #cf222e;
  }
  .badge-tag {
    background: #ddf4ff;
  }
  .badge-repo {
    background: #ffeff7;
    color: #a4133c;
  }
  .badge-platform {
    background: #eef1ff;
    color: #383f9c;
  }
  .badge-app {
    background: #d1f4ff;
    color: #0a4b70;
  }
  .badge-option {
    background: #eaeef2;
  }
  .badge-suite {
    background: #dafbe1;
    color: #116329;
    font-weight: 600;
  }
  .badge-test {
    background: #fff;
    border-color: #d0d7de;
    color: #57606a;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .unit {
    color: #57606a;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  .empty {
    text-align: center;
    color: #57606a;
    padding: 24px;
  }
  .overflow-note {
    padding: 8px;
    text-align: center;
    color: #57606a;
    background: #f6f8fa;
    border-top: 1px solid #d0d7de;
  }
  .errors,
  .error {
    color: #cf222e;
    background: #ffebe9;
    border: 1px solid #ffcecb;
    padding: 8px 12px;
    border-radius: 6px;
    margin: 0;
    list-style: inside;
  }
</style>
