<script lang="ts">
  import { PINNED_REPOS, TIME_RANGES, type Series } from './api';
  import type { FilterField, SortColumn } from './filter';
  import { PickerState } from './pickerState.svelte';
  import FilterInput from './FilterInput.svelte';

  type Props = {
    onadd?: (series: Series[]) => void;
  };
  let { onadd }: Props = $props();

  // All shared UI state lives on PickerState. This component is a thin
  // renderer over it. See pickerState.svelte.ts. Named `picker` (not
  // `state`) to avoid shadowing Svelte 5's `$state` rune — the compiler
  // will otherwise interpret `$state(...)` as a store subscription on a
  // variable literally named `state` and blow up at runtime.
  const picker = new PickerState();

  function addPicked() {
    onadd?.(picker.pickedSeries());
  }

  // ---- Virtual scrolling ------------------------------------------------
  // Broad filters can produce 25k rows; even one expanded parent adds a few
  // hundred subtests. We render only a scroll-window over a flat row list.
  //
  // Rows are constrained to a single visual line. ROW_HEIGHT is exported
  // to CSS as the `--row-height` custom property on the .picker root, and
  // `tbody td` uses it as an explicit `height` — so the JS-side constant
  // and the CSS-side row height cannot drift apart. Vertical centering is
  // driven by `height + vertical-align: middle`, not by text metrics or
  // padding, so changing fonts or badge styling doesn't move rows around.
  // Column widths are pinned via <colgroup> + `table-layout: fixed` so
  // they don't horizontally re-flow as new rows scroll in either.
  const ROW_HEIGHT = 36;
  const OVERSCAN = 6;

  type FlatRow =
    | { kind: 'parent'; row: Series }
    | { kind: 'child'; row: Series }
    | { kind: 'note'; message: string };

  const flatRows = $derived.by<FlatRow[]>(() => {
    const rows: FlatRow[] = [];
    for (const parent of picker.filteredParents) {
      rows.push({ kind: 'parent', row: parent });
      if (!picker.isRowExpanded(parent.key)) continue;
      const allChildren = picker.childrenByParent.get(parent.key) ?? [];
      const children = picker.childrenForParent(parent);
      if (parent.hasSubtests && allChildren.length === 0) {
        rows.push({ kind: 'note', message: 'Loading subtests…' });
      } else if (allChildren.length === 0) {
        rows.push({ kind: 'note', message: 'No subtests in loaded data.' });
      } else if (children.length === 0) {
        rows.push({ kind: 'note', message: 'No subtests match the current filter.' });
      } else {
        for (const child of picker.sortedChildren(children)) {
          rows.push({ kind: 'child', row: child });
        }
      }
    }
    return rows;
  });

  let scrollTop = $state(0);
  let viewportHeight = $state(600);
  let scroller = $state<HTMLDivElement | null>(null);

  function onScroll(e: Event) {
    scrollTop = (e.currentTarget as HTMLDivElement).scrollTop;
  }

  // The `bind:clientHeight` shorthand tripped a Svelte 5 non_reactive_update
  // warning under runes mode. A ResizeObserver keeps `viewportHeight` in
  // sync when the container resizes (window resize, dev-tools open, etc.).
  $effect(() => {
    if (!scroller) return;
    viewportHeight = scroller.clientHeight;
    const ro = new ResizeObserver(() => {
      if (scroller) viewportHeight = scroller.clientHeight;
    });
    ro.observe(scroller);
    return () => ro.disconnect();
  });

  const totalHeight = $derived(flatRows.length * ROW_HEIGHT);
  const startIndex = $derived(
    Math.max(
      0,
      Math.min(
        flatRows.length,
        Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN,
      ),
    ),
  );
  const endIndex = $derived(
    Math.max(
      0,
      Math.min(
        flatRows.length,
        Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
      ),
    ),
  );
  const topPadding = $derived(startIndex * ROW_HEIGHT);
  const bottomPadding = $derived(Math.max(0, totalHeight - endIndex * ROW_HEIGHT));
  const visibleWindow = $derived(flatRows.slice(startIndex, endIndex));

  function rowKey(item: FlatRow, index: number): string {
    if (item.kind === 'parent') return `p:${item.row.id}`;
    if (item.kind === 'child') return `c:${item.row.id}`;
    return `n:${index}`;
  }
</script>

<div class="picker" style:--row-height="{ROW_HEIGHT}px">
  <header>
    <h2>Add series</h2>
    <p class="hint">
      One combined list across selected repos. Filter by clicking any badge or
      by typing free text / <code>field:value</code> tokens. Expand a row to
      see its subtests.
    </p>
  </header>

  {#if picker.metadataError}
    <div class="error">Failed to load metadata: {picker.metadataError}</div>
  {/if}

  <section class="controls">
    <div class="control-row filter-row">
      <span class="control-label">Filter</span>
      <FilterInput
        filter={picker.filter}
        onchange={(next) => {
          picker.filter = next;
        }}
      />
      <div class="time-controls">
        <label class="inline-label" for="time-range-select">Time range</label>
        <select id="time-range-select" bind:value={picker.timeRangeSeconds}>
          {#each TIME_RANGES as tr}
            <option value={tr.value}>{tr.label}</option>
          {/each}
        </select>
        <label class="toggle">
          <input type="checkbox" bind:checked={picker.matchSubtests} />
          Match inside subtests
        </label>
      </div>
    </div>

    <div class="control-row">
      <span class="control-label">Repos</span>
      <div class="chips">
        {#each PINNED_REPOS as repo}
          {@const count = picker.countForRepoChip(repo)}
          <label class="chip" class:chip-on={picker.selectedRepos.has(repo)}>
            <input
              type="checkbox"
              checked={picker.selectedRepos.has(repo)}
              onchange={() => picker.toggleRepo(repo)}
            />
            <span class="chip-name">{repo}</span>
            <span
              class="chip-count"
              class:chip-count-dim={!picker.selectedRepos.has(repo)}
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
      {picker.filteredParents.length.toLocaleString()} matching / {picker.combined.filter(
        (r) => !r.isSubtest,
      ).length.toLocaleString()} total
    </span>
    {#if picker.anyLoading}<span class="loading-note">Loading…</span>{/if}
    <span class="picked-count" class:muted={picker.picked.size === 0}>
      {picker.picked.size} selected
    </span>
    <button
      type="button"
      onclick={() => picker.clearPicked()}
      disabled={picker.picked.size === 0}>Clear</button
    >
    <button
      type="button"
      class="primary"
      onclick={addPicked}
      disabled={picker.picked.size === 0}>Add {picker.picked.size}</button
    >
  </div>

  {#if picker.errors.length > 0}
    <ul class="errors">
      {#each picker.errors as msg}<li>{msg}</li>{/each}
    </ul>
  {/if}

  <div
    class="table-wrap"
    bind:this={scroller}
    onscroll={onScroll}
  >
    <table>
      <!-- Column widths are pinned via `table-layout: fixed` so the columns
           don't re-flow as new rows scroll into view. Percentages divide the
           available width; the `min-width` on the table forces the wrapper
           to scroll horizontally rather than let columns get too cramped. -->
      <colgroup>
        <col class="col-check-w" />
        <col class="col-disclose-w" />
        <col class="col-suite-w" />
        <col class="col-app-w" />
        <col class="col-repo-w" />
        <col class="col-platform-w" />
        <col class="col-options-w" />
        <col class="col-unit-w" />
      </colgroup>
      <thead>
        {#snippet sortHeader(label: string, column: SortColumn)}
          {@const active = picker.sort?.column === column}
          <th
            class="sortable"
            class:sortable-active={active}
            aria-sort={active
              ? picker.sort!.direction === 'asc'
                ? 'ascending'
                : 'descending'
              : 'none'}
          >
            <button
              type="button"
              class="sort-btn"
              onclick={() => picker.onSortHeader(column)}
            >
              <span>{label}</span>
              <span class="sort-indicator" aria-hidden="true">
                {#if active}{picker.sort!.direction === 'asc' ? '▲' : '▼'}{:else}▲▼{/if}
              </span>
            </button>
          </th>
        {/snippet}

        <tr>
          <th class="col-check">
            <input
              type="checkbox"
              checked={picker.allPickablePicked}
              indeterminate={picker.somePickablePicked && !picker.allPickablePicked}
              disabled={picker.pickableRows.length === 0}
              onchange={() => picker.toggleSelectAll()}
              aria-label={picker.allPickablePicked
                ? 'Deselect all shown rows'
                : 'Select all shown rows'}
              title={picker.allPickablePicked
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
          {@const active = picker.isChipActive(field, value)}
          <button
            type="button"
            class="badge {cls}"
            class:badge-active={active}
            title={active
              ? `Remove filter ${field}:${value}`
              : `Filter to only ${field}:${value}`}
            onclick={() => picker.toggleFilterChip(field, value)}
          >
            <span class="badge-text">{value}</span>
            <span class="badge-cue" aria-hidden="true">{active ? '×' : '+'}</span>
          </button>
        {/snippet}

        {#if topPadding > 0}
          <tr class="spacer" aria-hidden="true" style="height: {topPadding}px">
            <td colspan="8"></td>
          </tr>
        {/if}
        {#each visibleWindow as item, i (rowKey(item, startIndex + i))}
          {#if item.kind === 'parent'}
            {@const row = item.row}
            {@const parentKey = row.key}
            {@const isExpanded = picker.isRowExpanded(parentKey)}
            {@const disabled = picker.isRowDisabled(row)}
            <tr
              class:selected={!disabled && picker.picked.has(row.id)}
              class:row-disabled={disabled}
              aria-disabled={disabled}
            >
              <td class="col-check">
                <input
                  type="checkbox"
                  checked={picker.picked.has(row.id)}
                  disabled={disabled}
                  title={disabled
                    ? 'This row is shown because a subtest matched. Widen the filter to pick it.'
                    : undefined}
                  onchange={(e) =>
                    picker.togglePick(
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
                    onclick={() => picker.toggleExpanded(parentKey)}
                  >▶</button>
                {/if}
              </td>
              <td>
                {@render badge('suite', row.suite, 'badge-suite')}
                {#if row.test}
                  {@render badge('test', row.test, 'badge-test')}
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
          {:else if item.kind === 'child'}
            {@const child = item.row}
            <tr class="subtest-row" class:selected={picker.picked.has(child.id)}>
              <td class="col-check">
                <input
                  type="checkbox"
                  checked={picker.picked.has(child.id)}
                  onchange={(e) =>
                    picker.togglePick(
                      child,
                      (e.currentTarget as HTMLInputElement).checked,
                    )}
                />
              </td>
              <td class="col-disclose"></td>
              <td class="subtest-cell">
                {@render badge('test', child.test || child.suite, 'badge-test')}
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
          {:else}
            <tr class="subtest-note">
              <td colspan="8">{item.message}</td>
            </tr>
          {/if}
        {/each}
        {#if bottomPadding > 0}
          <tr class="spacer" aria-hidden="true" style="height: {bottomPadding}px">
            <td colspan="8"></td>
          </tr>
        {/if}
        {#if flatRows.length === 0}
          <tr><td colspan="8" class="empty">
            {#if picker.anyLoading}Loading series…{:else}No matching series.{/if}
          </td></tr>
        {/if}
      </tbody>
    </table>
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
    table-layout: fixed;
    width: 100%;
    /* Floor for the whole table so columns never get too cramped. Below
       this the wrapper (overflow: auto) shows a horizontal scrollbar. */
    min-width: 64em;
    border-collapse: collapse;
    font-size: 13px;
  }
  /* Fixed layout: only the widths on these <col> elements determine the
     column widths — content in the currently rendered virtual window
     can't push columns around during scrolling. Percentages divide the
     table's actual width; the two narrow columns are pinned in px. */
  col.col-check-w    { width: 32px; }
  col.col-disclose-w { width: 24px; }
  col.col-suite-w    { width: 26%; }
  col.col-app-w      { width: 10%; }
  col.col-repo-w     { width: 10%; }
  col.col-platform-w { width: 16%; }
  col.col-options-w  { width: 28%; }
  col.col-unit-w     { width: 10%; }
  thead th {
    position: sticky;
    top: 0;
    background: #f6f8fa;
    border-bottom: 1px solid #d0d7de;
    text-align: left;
    /* Same fixed-height rule as body cells so the sticky header lines up
       cleanly against the first data row. */
    height: var(--row-height);
    box-sizing: border-box;
    padding: 0;
    z-index: 1;
  }
  thead th:not(.sortable) {
    padding: 0 8px;
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
    height: 100%;
    padding: 0 8px;
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
    /* Every cell is exactly one `--row-height` tall (the same constant
       the virtualizer uses for scrollTop math — see ROW_HEIGHT). Content
       is vertically centered inside that fixed box, so we don't depend
       on padding + text metrics coincidentally landing at the right
       height. `padding-block: 0` is critical: any top/bottom padding
       would add to `height` and desync the box from the virtualizer. */
    height: var(--row-height);
    box-sizing: border-box;
    padding: 0 8px;
    vertical-align: middle;
    border-bottom: 1px solid #eaeef2;
    /* With table-layout: fixed, cells have a definite width, so we must
       clip. Without this, an over-wide badge (e.g. a long platform name)
       would visually overflow into the next column. */
    overflow: hidden;
    white-space: nowrap;
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
  /* Parent rows shown only because a subtest matched. The disclosure caret
     stays live (users need it to collapse the tree), everything else looks
     and behaves inert. */
  tbody tr.row-disabled td {
    color: #8c959f;
  }
  tbody tr.row-disabled .badge {
    pointer-events: none;
    opacity: 0.55;
  }
  tbody tr.row-disabled .col-check input {
    cursor: not-allowed;
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
  /* Virtual-scroll spacer rows: their sole job is to occupy vertical space
     for the rows we haven't rendered yet. No borders, no padding, no hover. */
  .spacer td {
    padding: 0;
    border: 0;
    background: transparent;
  }
  .spacer:hover td {
    background: transparent;
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
