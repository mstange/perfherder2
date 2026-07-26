<script lang="ts">
  import { PINNED_REPOS, TIME_RANGES, type Series } from './api';
  import type { FilterField, SortColumn } from './filter';
  import { PickerState, RENDER_CAP } from './pickerState.svelte';
  import FilterInput from './FilterInput.svelte';

  type Props = {
    onadd?: (series: Series[]) => void;
  };
  let { onadd }: Props = $props();

  // All shared UI state lives on PickerState. This component is a thin
  // renderer over it. See pickerState.svelte.ts.
  const state = new PickerState();

  function addPicked() {
    onadd?.(state.pickedSeries());
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

  {#if state.metadataError}
    <div class="error">Failed to load metadata: {state.metadataError}</div>
  {/if}

  <section class="controls">
    <div class="control-row filter-row">
      <span class="control-label">Filter</span>
      <FilterInput
        filter={state.filter}
        onchange={(next) => (state.filter = next)}
      />
      <div class="time-controls">
        <label class="inline-label" for="time-range-select">Time range</label>
        <select id="time-range-select" bind:value={state.timeRangeSeconds}>
          {#each TIME_RANGES as tr}
            <option value={tr.value}>{tr.label}</option>
          {/each}
        </select>
        <label class="toggle">
          <input type="checkbox" bind:checked={state.matchSubtests} />
          Match inside subtests
        </label>
      </div>
    </div>

    <div class="control-row">
      <span class="control-label">Repos</span>
      <div class="chips">
        {#each PINNED_REPOS as repo}
          {@const count = state.countForRepoChip(repo)}
          <label class="chip" class:chip-on={state.selectedRepos.has(repo)}>
            <input
              type="checkbox"
              checked={state.selectedRepos.has(repo)}
              onchange={() => state.toggleRepo(repo)}
            />
            <span class="chip-name">{repo}</span>
            <span
              class="chip-count"
              class:chip-count-dim={!state.selectedRepos.has(repo)}
            >
              {#if count === 'loading'}…{:else if typeof count === 'number'}{count.toLocaleString()}{:else}&nbsp;{/if}
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
      {state.filteredParents.length.toLocaleString()} matching / {state.combined.filter(
        (r) => !r.isSubtest,
      ).length.toLocaleString()} total
    </span>
    {#if state.anyLoading}<span class="loading-note">Loading…</span>{/if}
    <span class="picked-count" class:muted={state.picked.size === 0}>
      {state.picked.size} selected
    </span>
    <button
      type="button"
      onclick={() => state.clearPicked()}
      disabled={state.picked.size === 0}>Clear</button
    >
    <button
      type="button"
      class="primary"
      onclick={addPicked}
      disabled={state.picked.size === 0}>Add {state.picked.size}</button
    >
  </div>

  {#if state.errors.length > 0}
    <ul class="errors">
      {#each state.errors as msg}<li>{msg}</li>{/each}
    </ul>
  {/if}

  <div class="table-wrap">
    <table>
      <thead>
        {#snippet sortHeader(label: string, column: SortColumn)}
          {@const active = state.sort?.column === column}
          <th
            class="sortable"
            class:sortable-active={active}
            aria-sort={active
              ? state.sort!.direction === 'asc'
                ? 'ascending'
                : 'descending'
              : 'none'}
          >
            <button
              type="button"
              class="sort-btn"
              onclick={() => state.onSortHeader(column)}
            >
              <span>{label}</span>
              <span class="sort-indicator" aria-hidden="true">
                {#if active}{state.sort!.direction === 'asc' ? '▲' : '▼'}{:else}▲▼{/if}
              </span>
            </button>
          </th>
        {/snippet}

        <tr>
          <th class="col-check">
            <input
              type="checkbox"
              checked={state.allRenderedPicked}
              indeterminate={state.someRenderedPicked && !state.allRenderedPicked}
              disabled={state.renderedRows.length === 0}
              onchange={() => state.toggleSelectAll()}
              aria-label={state.allRenderedPicked
                ? 'Deselect all shown rows'
                : 'Select all shown rows'}
              title={state.allRenderedPicked
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
          {@const active = state.isChipActive(field, value)}
          <button
            type="button"
            class="badge {cls}"
            class:badge-active={active}
            title={active
              ? `Remove filter ${field}:${value}`
              : `Filter to only ${field}:${value}`}
            onclick={() => state.toggleFilterChip(field, value)}
          >
            <span class="badge-text">{value}</span>
            <span class="badge-cue" aria-hidden="true">{active ? '×' : '+'}</span>
          </button>
        {/snippet}

        {#each state.visibleParents as row (row.id)}
          {@const parentKey = row.key}
          {@const allChildren = state.childrenByParent.get(parentKey) ?? []}
          {@const children = state.childrenForParent(row)}
          {@const isExpanded = state.isRowExpanded(parentKey)}
          {@const awaitingSubtests =
            isExpanded && row.hasSubtests && allChildren.length === 0}
          <tr class:selected={state.picked.has(row.id)}>
            <td class="col-check">
              <input
                type="checkbox"
                checked={state.picked.has(row.id)}
                onchange={(e) =>
                  state.togglePick(
                    row,
                    (e.currentTarget as HTMLInputElement).checked,
                  )}
              />
            </td>
            <td class="col-disclose">
              {#if row.hasSubtests}
                <button
                  type="button"
                  class="disclose"
                  class:disclose-open={isExpanded}
                  aria-label={isExpanded ? 'Collapse subtests' : 'Expand subtests'}
                  onclick={() => state.toggleExpanded(parentKey)}
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
              {#each state.sortedChildren(children) as child (child.id)}
                <tr class="subtest-row" class:selected={state.picked.has(child.id)}>
                  <td class="col-check">
                    <input
                      type="checkbox"
                      checked={state.picked.has(child.id)}
                      onchange={(e) =>
                        state.togglePick(
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
        {#if state.visibleParents.length === 0}
          <tr><td colspan="8" class="empty">
            {#if state.anyLoading}Loading series…{:else}No matching series.{/if}
          </td></tr>
        {/if}
      </tbody>
    </table>
    {#if state.overflow > 0}
      <div class="overflow-note">
        Showing the first {RENDER_CAP.toLocaleString()} of {state.filteredParents.length.toLocaleString()}.
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
