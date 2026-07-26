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

  type Props = {
    onadd?: (series: Series[]) => void;
  };
  let { onadd }: Props = $props();

  // User-visible controls.
  let selectedRepos = $state(new Set<string>(DEFAULT_REPOS));
  let includeSubtests = $state(false);
  let timeRangeSeconds = $state(1209600); // 14 days, matches perfherder default.
  let filterText = $state('');
  let selectedPlatforms = $state(new Set<string>()); // empty = all
  let expanded = $state(new Set<string>()); // parent signature_hash values

  // Cached signature responses keyed by "repo|subtests|interval" so toggling
  // options doesn't discard fetched series.
  const cacheKey = (repo: string, sub: boolean, interval: number) =>
    `${repo}|${sub ? 1 : 0}|${interval}`;

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

  // Whenever inputs change, kick off fetches for any missing cache entries.
  $effect(() => {
    if (!metadataReady) return;
    for (const repo of selectedRepos) {
      const key = cacheKey(repo, includeSubtests, timeRangeSeconds);
      if (seriesCache.has(key) || loadingRepos.has(key)) continue;
      loadRepo(repo, includeSubtests, timeRangeSeconds);
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
      const withSub = seriesCache.get(cacheKey(repo, true, timeRangeSeconds));
      const noSub = seriesCache.get(cacheKey(repo, false, timeRangeSeconds));
      const data = withSub ?? noSub;
      if (data) rows.push(...data);
    }
    return rows;
  });

  // Group children by parent signature_hash for O(1) lookup on disclosure.
  const childrenByParent = $derived.by(() => {
    const m = new Map<string, Series[]>();
    for (const r of combined) {
      if (r.isSubtest && r.parentSignature) {
        const arr = m.get(r.parentSignature);
        if (arr) arr.push(r);
        else m.set(r.parentSignature, [r]);
      }
    }
    return m;
  });

  const availablePlatforms = $derived.by(() => {
    const s = new Set<string>();
    for (const r of combined) if (!r.isSubtest) s.add(r.platform);
    return [...s].sort();
  });

  const filterTokens = $derived(
    filterText
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0),
  );

  function matches(row: Series): boolean {
    if (selectedPlatforms.size > 0 && !selectedPlatforms.has(row.platform))
      return false;
    for (const t of filterTokens) {
      if (!row.searchText.includes(t)) return false;
    }
    return true;
  }

  // Top-level rows: not subtests, matching the current filter.
  const filteredParents = $derived.by(() => {
    const out: Series[] = [];
    for (const row of combined) {
      if (row.isSubtest) continue;
      if (matches(row)) out.push(row);
    }
    return out;
  });

  // Cap top-level rendering.
  const RENDER_CAP = 500;
  const visibleParents = $derived(filteredParents.slice(0, RENDER_CAP));
  const overflow = $derived(Math.max(0, filteredParents.length - RENDER_CAP));

  function toggleRepo(repo: string) {
    const next = new Set(selectedRepos);
    if (next.has(repo)) next.delete(repo);
    else next.add(repo);
    selectedRepos = next;
  }

  function togglePlatform(name: string) {
    const next = new Set(selectedPlatforms);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    selectedPlatforms = next;
  }

  function togglePick(row: Series, on: boolean) {
    const next = new Map(picked);
    if (on) next.set(row.id, row);
    else next.delete(row.id);
    picked = next;
  }

  function toggleExpanded(hash: string) {
    const next = new Set(expanded);
    if (next.has(hash)) next.delete(hash);
    else next.add(hash);
    expanded = next;
    // If subtests haven't been loaded yet, opt into fetching them. The $effect
    // above will pick up the change and fetch. The row will show a loading
    // indicator until data arrives.
    if (!includeSubtests) includeSubtests = true;
  }

  function clearPicked() {
    picked = new Map();
  }

  function addPicked() {
    onadd?.([...picked.values()]);
  }

  const anyLoading = $derived(loadingRepos.size > 0);
</script>

<div class="picker">
  <header>
    <h2>Add series</h2>
    <p class="hint">
      One combined list across selected repos — no need to pick a harness or
      platform first. Filter with the search box; expand a row to see its
      subtests.
    </p>
  </header>

  {#if metadataError}
    <div class="error">Failed to load metadata: {metadataError}</div>
  {/if}

  <section class="controls">
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

    <div class="control-row">
      <span class="control-label">Time range</span>
      <select bind:value={timeRangeSeconds}>
        {#each TIME_RANGES as tr}
          <option value={tr.value}>{tr.label}</option>
        {/each}
      </select>

      <label class="toggle">
        <input type="checkbox" bind:checked={includeSubtests} />
        Include subtests
      </label>
    </div>

    <div class="control-row">
      <input
        class="filter"
        type="search"
        placeholder="Filter (space-separated tokens: e.g. 'tp6 linux fission')"
        bind:value={filterText}
      />
    </div>

    {#if availablePlatforms.length > 0 && availablePlatforms.length <= 60}
      <div class="control-row">
        <span class="control-label">Platform</span>
        <div class="chips chips-small">
          {#each availablePlatforms as p}
            <label class="chip" class:chip-on={selectedPlatforms.has(p)}>
              <input
                type="checkbox"
                checked={selectedPlatforms.has(p)}
                onchange={() => togglePlatform(p)}
              />
              <span>{p}</span>
            </label>
          {/each}
        </div>
      </div>
    {/if}
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
    <button
      type="button"
      onclick={clearPicked}
      disabled={picked.size === 0}>Clear</button
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
        <tr>
          <th class="col-check"></th>
          <th class="col-disclose"></th>
          <th>Suite / Test</th>
          <th>Application</th>
          <th>Repo</th>
          <th>Platform</th>
          <th>Options</th>
          <th>Unit</th>
        </tr>
      </thead>
      <tbody>
        {#each visibleParents as row (row.id)}
          {@const children = childrenByParent.get(row.signatureHash) ?? []}
          {@const isExpanded = expanded.has(row.signatureHash)}
          {@const awaitingSubtests =
            isExpanded && row.hasSubtests && children.length === 0}
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
                  onclick={() => toggleExpanded(row.signatureHash)}
                >▶</button>
              {/if}
            </td>
            <td>
              <div class="suite">{row.suite}</div>
              {#if row.test}<div class="test">{row.test}</div>{/if}
              {#if row.tags.length > 0}
                <div class="tag-row">
                  {#each row.tags as t}<span class="badge badge-tag">{t}</span>{' '}{/each}
                </div>
              {/if}
            </td>
            <td>
              {#if row.application}
                <span class="badge badge-app">{row.application}</span>
              {/if}
            </td>
            <td><span class="badge badge-repo">{row.repository}</span></td>
            <td><span class="badge badge-platform">{row.platform}</span></td>
            <td>
              {#each row.options as o}<span class="badge">{o}</span>{' '}{/each}
            </td>
            <td class="unit">{row.measurementUnit}</td>
          </tr>
          {#if isExpanded}
            {#if awaitingSubtests}
              <tr class="subtest-note">
                <td colspan="8">Loading subtests…</td>
              </tr>
            {:else if children.length === 0}
              <tr class="subtest-note">
                <td colspan="8">No subtests in loaded data.</td>
              </tr>
            {:else}
              {#each children as child (child.id)}
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
                    <div class="test">{child.test || child.suite}</div>
                    {#if child.tags.length > 0}
                      <div class="tag-row">
                        {#each child.tags as t}<span class="badge badge-tag">{t}</span>{' '}{/each}
                      </div>
                    {/if}
                  </td>
                  <td>
                    {#if child.application}
                      <span class="badge badge-app">{child.application}</span>
                    {/if}
                  </td>
                  <td><span class="badge badge-repo">{child.repository}</span></td>
                  <td><span class="badge badge-platform">{child.platform}</span></td>
                  <td>
                    {#each child.options as o}<span class="badge">{o}</span>{' '}{/each}
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
  .chips-small .chip {
    font-size: 12px;
    padding: 2px 8px;
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
  }
  .filter {
    flex: 1;
    min-width: 300px;
    padding: 6px 10px;
    font-size: 14px;
    border: 1px solid #d0d7de;
    border-radius: 6px;
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
    /* Reserve enough space that going from "0 selected" → "12 selected"
       doesn't nudge the buttons horizontally either. */
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
    padding: 6px 8px;
    z-index: 1;
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
  .suite {
    font-weight: 600;
  }
  .test {
    color: #57606a;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  .tag-row {
    margin-top: 2px;
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  }
  .badge {
    display: inline-block;
    padding: 1px 6px;
    margin: 1px 0;
    font-size: 11px;
    line-height: 1.4;
    background: #eaeef2;
    color: #24292f;
    border-radius: 4px;
    white-space: nowrap;
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
