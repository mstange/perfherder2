<script lang="ts">
  import { untrack } from 'svelte';
  import { activityPath, activityTitle, maxBinCount } from './activity';
  import { type Series } from './series';
import { TIME_RANGES } from './pickerOptions';
  import {
    chipToString,
    graphContextState,
    type FilterField,
    type SortColumn,
  } from './filter';
  import { PickerState } from './pickerState.svelte';
  import {
    EMPTY_GRAPH_CONTEXT,
    EMPTY_PICKER_VIEW,
    type GraphContext,
    type PickerViewState,
  } from '../urlState';
  import FilterInput from './FilterInput.svelte';

  type Props = {
    onadd?: (series: Series[]) => void;
    // Takes rows that are on the graph back off it. The mirror of `onadd`;
    // both take an array so the bulk button can go through the same path as a
    // single row's button, and so one bulk action is one history entry.
    onremove?: (series: Series[]) => void;
    // Set when the picker is shown as an overlay: adds a close button and
    // makes Escape dismiss it.
    onclose?: () => void;
    // Seeded when the panel opens — from the URL, or from what the plotted
    // series have in common — and reported back on every change so the app can
    // keep the URL in sync. The picker is mounted only while the panel is open,
    // so this is how its filter, repos, interval, subtest mode and sort
    // survive a reload.
    initialView?: PickerViewState;
    // What the plotted series have in common, live. Not a seed and not the same
    // thing as `initialView`, which is a snapshot taken on open: this one has to
    // track the graph while the panel is open, because the "Derive filter"
    // button offers it at any moment — including after the metadata that decides
    // what it says has finally arrived.
    graphContext?: GraphContext;
    // Rows already on the graph: `${repository}|${signature id}` → the color
    // it's drawn in. Not a one-time seed like the above — see the effect below.
    plotted?: ReadonlyMap<string, string>;
    onviewchange?: (view: PickerViewState) => void;
  };
  let {
    onadd,
    onremove,
    onclose,
    initialView,
    graphContext = EMPTY_GRAPH_CONTEXT,
    plotted,
    onviewchange,
  }: Props = $props();

  // All shared UI state lives on PickerState. This component is a thin
  // renderer over it. See pickerState.svelte.ts. Named `picker` (not
  // `state`) to avoid shadowing Svelte 5's `$state` rune — the compiler
  // will otherwise interpret `$state(...)` as a store subscription on a
  // variable literally named `state` and blow up at runtime.
  const picker = new PickerState();
  // A one-time seed, not a binding: after mount the picker owns all of this
  // state. `untrack` because reading a prop during setup is what Svelte's
  // state_referenced_locally warning is about, and here it is intentional.
  // This runs before the fetch effect, which `seed` relies on.
  untrack(() => picker.seed(initialView ?? EMPTY_PICKER_VIEW));

  // Report every change upward so the URL can carry it. This fires once on
  // mount too, which is deliberate: it turns whatever the seed left
  // unspecified into the concrete values the controls are showing, so the link
  // says what the panel looks like rather than what it was asked for.
  $effect(() => {
    onviewchange?.(picker.view);
  });

  // Synced rather than seeded once, and it has to be: every Add and Remove
  // changes this set with the panel still open, and a seeded copy would leave
  // rows claiming to be on a graph they'd just left. It's also the whole
  // feedback loop — a row's button flips to Remove because the round trip
  // through AppState comes back through here.
  $effect(() => {
    picker.plotted = plotted ?? new Map();
  });

  // Read three times by the status row's bulk button. Here rather than an
  // `{@const}` in the markup: that tag has to be the immediate child of a
  // block, and the button sits in a plain <div>.
  const bulk = $derived(picker.bulkAction);

  // "Derive filter": what it can do, and what it says it will do. The label
  // can't say what it derives *from*, so every string here does, and each one
  // names the filter as the thing being acted on. See docs/design.md, "Deriving
  // the filter, and clearing it".
  //
  // The chips are spelled out in full — `suite:speedometer3 · platform:…` —
  // because this button replaces the filter rather than adding to it, and the
  // exact text it is about to put in the box is the only honest preview of that.
  const contextState = $derived(
    graphContextState(picker.filter, graphContext.filter, graphContext.repos.length > 0),
  );
  const contextTitle = $derived.by(() => {
    switch (contextState) {
      case 'none':
        return 'Nothing plotted to derive a filter from';
      case 'pending':
        return 'Waiting for the plotted series’ metadata';
      case 'same':
        return 'The filter already matches what the plotted series share';
      case 'apply':
        return `Derive the filter from what the plotted series share: ${graphContext.filter.chips
          .map(chipToString)
          .join(' · ')}`;
    }
  });

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

  // Run-activity strip geometry, in px. Fixed, so a row's activity cell
  // occupies exactly the same space before and after its data arrives.
  const STRIP_W = 72;
  const STRIP_H = 14;

  type FlatRow =
    | { kind: 'parent'; row: Series }
    | { kind: 'child'; row: Series }
    | { kind: 'note'; message: string };

  const flatRows = $derived.by<FlatRow[]>(() => {
    const rows: FlatRow[] = [];
    for (const parent of picker.filteredParents) {
      rows.push({ kind: 'parent', row: parent });
      if (!picker.isRowExpanded(parent.key)) continue;
      const status = picker.subtestStatus(parent);
      if (status === 'loading') {
        rows.push({ kind: 'note', message: 'Loading subtests…' });
      } else if (status === 'failed') {
        rows.push({ kind: 'note', message: 'Subtests failed to load.' });
      } else if (status === 'none') {
        rows.push({ kind: 'note', message: 'No subtests in the selected time range.' });
      } else if (status === 'no-matches') {
        rows.push({ kind: 'note', message: 'No subtests match the current filter.' });
      } else {
        // Says out loud what the tree only implies. Users who expanded a
        // parent tended to assume the subtests were the real, chartable data
        // and the parent was just a folder — then stalled, because no single
        // subtest is the obvious answer to "I want this benchmark". The
        // parent is a signature in its own right; this is where to say so.
        rows.push({
          kind: 'note',
          message: 'The row above is the overall score — these are its individual subtests.',
        });
        for (const child of picker.sortedChildren(picker.childrenForParent(parent))) {
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

  // Placeholder rows for the loading state: as many as fit the scroller, so
  // the block covers the area the real rows will and no more. Reusing
  // `viewportHeight` means it tracks a resized window for free, and — since the
  // header shares the scroller — it also means the loading state carries the
  // same vertical scrollbar the loaded list does, so no column shifts when the
  // rows arrive.
  const skeletonCount = $derived(Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT)));

  // The label the Time range select is showing, for the column header and the
  // hover text. Taken from TIME_RANGES rather than a second abbreviation
  // table, so there is one place where "14 days" is spelled.
  const rangeLabel = $derived(
    TIME_RANGES.find((t) => t.value === picker.timeRangeSeconds)?.label ?? '',
  );

  // Ask for run activity for whatever is on screen. `visibleWindow` already
  // includes the overscan, so this covers the rows about to scroll in too.
  // `requestActivity` drops everything cached or in flight, so this firing on
  // every scroll tick is cheap — and it debounces internally, so a flung
  // scrollbar doesn't queue a request per frame.
  $effect(() => {
    picker.requestActivity(
      visibleWindow.flatMap((item) => (item.kind === 'note' ? [] : [item.row])),
    );
  });

  // One bar-height denominator for every strip on screen, so two rows'
  // strips can be compared by eye — which per-row scaling made impossible
  // (see `activityPath`). Deliberately scoped to the visible window rather
  // than to all filtered rows: the scale then follows what the user can
  // actually see, and it costs a pass over ~30 rows instead of ~25,000. The
  // consequence is that scrolling and filtering rescale the strips, which is
  // the price of the comparison being meaningful in the first place.
  const activityScaleMax = $derived(
    maxBinCount(
      visibleWindow.map((item) =>
        item.kind === 'note' ? null : picker.activityFor(item.row),
      ),
    ),
  );

  function rowKey(item: FlatRow, index: number): string {
    if (item.kind === 'parent') return `p:${item.row.id}`;
    if (item.kind === 'child') return `c:${item.row.id}`;
    return `n:${index}`;
  }
</script>

<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Escape' && onclose) onclose();
  }}
/>

<div class="picker" style:--row-height="{ROW_HEIGHT}px">
  <header>
    <div class="header-text">
      <h2>Add series</h2>
      <p class="hint">
        One combined list across selected repos. Filter by clicking any badge or
        by typing free text / <code>field:value</code> tokens. Expand a row to
        see its subtests.
      </p>
    </div>
    {#if onclose}
      <!-- A drawn cross rather than "×": the glyph's own side bearings and its
           position on the baseline are the font's business, so no amount of
           line-height centres it in a square button across fonts. -->
      <button type="button" class="btn close" onclick={onclose} aria-label="Close">
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <path d="M3.5 3.5 12.5 12.5M12.5 3.5 3.5 12.5" />
        </svg>
      </button>
    {/if}
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
      <!-- Both always mounted, both fixed-width labels: the row must not resize
           as series load or as the filter changes. Disabled is the signal, and
           for "Derive filter" it carries information — disabled *because the
           filter is already the derived one* is the one place the panel says the
           filter and the graph agree.

           Fill it / empty it, on the same object: both labels take "filter" as
           their grammatical object, which is what keeps them from reading as
           actions on the *graph* in a dialog whose whole job is changing the
           graph. See docs/design.md, "Deriving the filter, and clearing it". -->
      <div class="filter-actions">
        <button
          type="button"
          class="btn btn-compact"
          disabled={contextState !== 'apply'}
          title={contextTitle}
          onclick={() => picker.applyGraphContext(graphContext)}>Derive filter</button
        >
        <button
          type="button"
          class="btn btn-compact"
          disabled={!picker.filterActive}
          title="Clear every chip and the search text (keeps repos and time range)"
          onclick={() => picker.clearFilter()}>Clear filter</button
        >
      </div>
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
        {#each picker.repoChips as repo}
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

  <!-- Both buttons stay mounted even when they have nothing to act on, so the
       status row's height never changes. Disabled is the visual signal.
       Nothing here commits anything any more — rows land on the graph as they
       are clicked — so the primary button just leaves, and Escape or the
       backdrop no longer throw away work the user thought they had done. -->
  <div class="status">
    <span>
      {picker.filteredParents.length.toLocaleString()} matching / {picker.combined.filter(
        (r) => !r.isSubtest,
      ).length.toLocaleString()} total
    </span>
    {#if picker.anyLoading}<span class="loading-note">Loading…</span>{/if}
    <span class="plotted-count" class:muted={picker.plotted.size === 0}>
      {picker.plotted.size} on the graph
    </span>
    <!-- Right-aligned, and the count is in the label rather than a tooltip:
         "Add all 24,913" has to be able to talk the user out of it. Growing
         the label eats the gap to its left instead of shoving Done sideways. -->
    <button
      type="button"
      class="btn bulk"
      disabled={bulk.rows.length === 0}
      onclick={() => (bulk.kind === 'add' ? onadd?.(bulk.rows) : onremove?.(bulk.rows))}
      >{bulk.kind === 'add' ? 'Add all' : 'Remove all'}
      {bulk.rows.length.toLocaleString()}</button
    >
    <button type="button" class="btn btn-primary" onclick={() => onclose?.()}>Done</button>
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
    aria-busy={picker.listStatus === 'loading'}
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
        <col class="col-repo-w" />
        <col class="col-platform-w" />
        <col class="col-app-w" />
        <col class="col-options-w" />
        <col class="col-unit-w" />
        <col class="col-activity-w" />
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
          <!-- A word, not the master checkbox that used to live here. A
               checkbox at the head of a column of Add buttons re-teaches the
               control we just replaced; bulk selection moved to the status
               row, next to Clear, which is its inverse. -->
          <th class="col-check">Add</th>
          <th class="col-disclose"></th>
          {@render sortHeader('Suite / Test', 'suite')}
          {@render sortHeader('Repo', 'repo')}
          {@render sortHeader('Platform', 'platform')}
          {@render sortHeader('Application', 'application')}
          {@render sortHeader('Options', 'options')}
          {@render sortHeader('Unit', 'unit')}
          <!-- Not a sortHeader, deliberately: sorting by run count would need
               counts for every one of the ~25k filtered rows, and we fetch
               only the ~29 on screen. See docs/design.md. -->
          <th
            class="col-activity"
            title="Runs recorded in the selected time range. Bar heights share one scale across the rows on screen, so a full-height bar means {activityScaleMax.toLocaleString()} runs in that bin."
          >
            runs ({rangeLabel})
          </th>
        </tr>
      </thead>
      <tbody>
        {#snippet badge(
          field: FilterField,
          value: string,
          cls: string,
          fromSubtest: boolean = false,
        )}
          {@const active = picker.isChipActive(field, value)}
          <button
            type="button"
            class="badge {cls}"
            class:badge-active={active}
            title={active
              ? `Remove filter ${field}:${value}`
              : `Filter to only ${field}:${value}`}
            onclick={() => picker.toggleFilterChip(field, value, { fromSubtest })}
          >
            <span class="badge-text">{value}</span>
            <span class="badge-cue" aria-hidden="true">{active ? '×' : '+'}</span>
          </button>
        {/snippet}

        <!-- The pick control for one row: a button with a verb on it, not a
             checkbox, and it acts on the graph immediately rather than staging
             behind a footer button. User testing found people didn't recognise
             the checkbox as "the way to get this series", and reached for the
             disclosure caret instead — the only control on the row that looked
             like it led somewhere. See docs/design.md, "The row's pick
             control". Two buttons rather than one that flips label, because
             Add and Remove are not two states of one toggle: each row is only
             ever offered whichever one applies to it. -->
        {#snippet pickCell(row: Series, disabled: boolean)}
          {@const color = picker.plotted.get(row.key)}
          <td class="col-check">
            {#if color}
              <button
                type="button"
                class="btn btn-compact pick"
                style:--series-color={color}
                title="Take this series off the graph"
                onclick={() => onremove?.([row])}
              >
                <span class="pick-swatch" aria-hidden="true"></span>
                <span>Remove</span>
              </button>
            {:else}
              <button
                type="button"
                class="btn btn-compact pick"
                {disabled}
                title={disabled
                  ? 'This row is shown because a subtest matched. Widen the filter to add it.'
                  : 'Put this series on the graph'}
                onclick={() => onadd?.([row])}
              >
                <span class="pick-cue" aria-hidden="true">+</span>
                <span>Add</span>
              </button>
            {/if}
          </td>
        {/snippet}

        <!-- Three states in one fixed-size cell, so nothing moves as batches
             land: not fetched yet, failed, and answered. The <svg> is always
             present at the same width and height even when it draws nothing —
             an empty box is what keeps the column from twitching row by row.
             `{@const}` takes no type annotation, so `activity` is inferred as
             `Activity | null` from `activityFor`. -->
        {#snippet activityCell(row: Series)}
          {@const activity = picker.activityFor(row)}
          <td class="col-activity">
            <span class="activity">
              {#if activity === null}
                <span class="runs runs-pending">·</span>
              {:else if 'error' in activity}
                <span class="runs runs-pending" title="Run activity failed: {activity.error}"
                  >—</span
                >
              {:else}
                <span class="runs" title={activityTitle(activity, rangeLabel, Date.now())}
                  >{activity.total.toLocaleString()}</span
                >
              {/if}
              <svg
                class="strip"
                width={STRIP_W}
                height={STRIP_H}
                viewBox="0 0 {STRIP_W} {STRIP_H}"
                aria-hidden="true"
              >
                {#if activity !== null && !('error' in activity)}
                  <path
                    d={activityPath(activity.counts, STRIP_W, STRIP_H, activityScaleMax)}
                  />
                {/if}
              </svg>
            </span>
          </td>
        {/snippet}

        {#if topPadding > 0}
          <tr class="spacer" aria-hidden="true" style="height: {topPadding}px">
            <td colspan="9"></td>
          </tr>
        {/if}
        {#each visibleWindow as item, i (rowKey(item, startIndex + i))}
          {#if item.kind === 'parent'}
            {@const row = item.row}
            {@const parentKey = row.key}
            {@const isExpanded = picker.isRowExpanded(parentKey)}
            {@const disabled = picker.isRowDisabled(row)}
            <tr
              class:row-disabled={disabled}
              class:plotted={picker.plotted.has(parentKey)}
              aria-disabled={disabled}
            >
              {@render pickCell(row, disabled)}
              <td class="col-disclose">
                {#if row.hasSubtests}
                  <button
                    type="button"
                    class="disclose"
                    class:disclose-open={isExpanded}
                    aria-expanded={isExpanded}
                    aria-label={isExpanded ? 'Collapse subtests' : 'Expand subtests'}
                    onclick={() => picker.toggleExpanded(parentKey)}
                  >▶</button>
                {/if}
              </td>
              <td>
                <span class="cell-flow">
                  {@render badge('suite', row.suite, 'badge-suite')}
                  {#if row.test}
                    {@render badge('test', row.test, 'badge-test')}
                  {/if}
                </span>
              </td>
              <td>
                <span class="cell-flow">
                  {@render badge('repo', row.repository, 'badge-repo')}
                </span>
              </td>
              <td>
                <span class="cell-flow">
                  {@render badge('platform', row.platform, 'badge-platform')}
                </span>
              </td>
              <td>
                {#if row.application}
                  <span class="cell-flow">
                    {@render badge('application', row.application, 'badge-app')}
                  </span>
                {/if}
              </td>
              <td>
                <span class="cell-flow">
                  {#each row.options as o}
                    {@render badge('option', o, 'badge-option')}{' '}
                  {/each}
                </span>
              </td>
              <td class="unit"><span class="cell-flow">{row.measurementUnit}</span></td>
              {@render activityCell(row)}
            </tr>
          {:else if item.kind === 'child'}
            {@const child = item.row}
            <tr
              class="subtest-row"
              class:plotted={picker.plotted.has(child.key)}
            >
              {@render pickCell(child, false)}
              <td class="col-disclose"></td>
              <td class="subtest-cell">
                <span class="cell-flow">
                  {@render badge('test', child.test || child.suite, 'badge-test', true)}
                </span>
              </td>
              <td>
                <span class="cell-flow">
                  {@render badge('repo', child.repository, 'badge-repo', true)}
                </span>
              </td>
              <td>
                <span class="cell-flow">
                  {@render badge('platform', child.platform, 'badge-platform', true)}
                </span>
              </td>
              <td>
                {#if child.application}
                  <span class="cell-flow">
                    {@render badge('application', child.application, 'badge-app', true)}
                  </span>
                {/if}
              </td>
              <td>
                <span class="cell-flow">
                  {#each child.options as o}
                    {@render badge('option', o, 'badge-option', true)}{' '}
                  {/each}
                </span>
              </td>
              <td class="unit"><span class="cell-flow">{child.measurementUnit}</span></td>
              {@render activityCell(child)}
            </tr>
          {:else}
            <tr class="subtest-note">
              <td colspan="9">{item.message}</td>
            </tr>
          {/if}
        {/each}
        {#if bottomPadding > 0}
          <tr class="spacer" aria-hidden="true" style="height: {bottomPadding}px">
            <td colspan="9"></td>
          </tr>
        {/if}
        {#if picker.listStatus === 'loading'}
          <!-- Placeholder rows, not one line of centered text: they say "rows
               are coming, and here is the shape of them", they fill the space
               the real rows will occupy so nothing jumps when a 22 MB payload
               lands, and they make a slow fetch look like progress rather than
               like an empty table. Hidden from assistive technology, which
               gets `aria-busy` on the scroller and the status row's
               "Loading…" instead of seven bars per row. -->
          {#each Array(skeletonCount) as _, i (i)}
            <tr class="skeleton" aria-hidden="true">
              <td class="col-check"></td>
              <td class="col-disclose"></td>
              <td><span class="skeleton-bar"></span></td>
              <td><span class="skeleton-bar"></span></td>
              <td><span class="skeleton-bar"></span></td>
              <td><span class="skeleton-bar"></span></td>
              <td><span class="skeleton-bar"></span></td>
              <td><span class="skeleton-bar"></span></td>
              <td><span class="skeleton-bar"></span></td>
            </tr>
          {/each}
        {:else if picker.listStatus !== 'rows'}
          <tr><td colspan="9" class="empty">
            {#if picker.listStatus === 'no-repos'}
              No repositories selected — check one above.
            {:else}
              No matching series.
            {/if}
          </td></tr>
        {/if}
      </tbody>
    </table>
  </div>
</div>

<style>
  /* Fills whatever box the host gives it (the overlay panel stretches to the
     viewport) and never exceeds it: `flex: 1` + `min-height: 0` lets the
     table below shrink instead of pushing the picker past its container. */
  .picker {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    max-width: 1400px;
    margin: 0 auto;
    color: var(--fg-default);
    font: 14px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  }
  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }
  header h2 {
    margin: 0 0 4px;
    font-size: 20px;
  }
  /* Square, and sized rather than padded; the rest comes from `.btn`. An
     `<svg>` is inline, so it sits on the text baseline and leaves descender
     space under itself; the grid centres it in the square instead. */
  .close {
    flex: none;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    padding: 0;
  }
  .hint {
    margin: 0;
    color: var(--fg-muted);
    font-size: 13px;
  }
  .hint code {
    background: var(--bg-subtle);
    padding: 0 3px;
    border-radius: 3px;
    font-size: 12px;
  }
  .controls {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    background: var(--bg-subtle);
    border: 1px solid var(--border-default);
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
  /* `flex: none` so the filter input keeps the slack: these two labels are
     fixed, and the box that grows should be the one holding the chips. */
  .filter-actions {
    display: flex;
    flex: none;
    align-items: center;
    gap: 6px;
    padding-top: 4px;
  }
  .inline-label {
    color: var(--fg-muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .control-label {
    min-width: 80px;
    color: var(--fg-muted);
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
    background: var(--bg-canvas);
    border: 1px solid var(--border-default);
    border-radius: 999px;
    cursor: pointer;
    user-select: none;
  }
  .chip input {
    margin: 0;
  }
  .chip-on {
    background: var(--accent-subtle);
    border-color: var(--accent-muted);
  }
  .chip-count {
    display: inline-block;
    min-width: 4.5em;
    text-align: right;
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    color: var(--fg-muted);
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
    border: 1px solid var(--border-default);
    border-radius: 6px;
    background: var(--bg-canvas);
  }
  .status {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 4px;
  }
  .plotted-count {
    font-weight: 600;
    min-width: 14ch;
    display: inline-block;
  }
  /* Pushed right, away from the counts on the left, so a longer label grows
     into the gap rather than moving Done. The `min-width` covers the usual
     case outright: only five-figure counts exceed it. */
  .bulk {
    margin-left: auto;
    min-width: 13ch;
  }
  .muted {
    color: var(--fg-muted);
    font-weight: 400;
  }
  .loading-note {
    color: var(--fg-muted);
    font-style: italic;
  }
  /* The one scroller in the dialog: it absorbs all the leftover height
     (`flex: 1`) rather than sizing to its (possibly 25k-row) content. The
     `min-height: 0` is what actually allows the shrink — flex items default
     to `min-height: auto`, i.e. their content height, which is how the
     overlay ended up scrolling. */
  .table-wrap {
    flex: 1;
    min-height: 0;
    border: 1px solid var(--border-default);
    border-radius: 6px;
    overflow: auto;
  }
  table {
    table-layout: fixed;
    width: 100%;
    /* Floor for the whole table so columns never get too cramped. Below
       this the wrapper (overflow: auto) shows a horizontal scrollbar. */
    min-width: 64em;
    border-collapse: collapse;
    /* Bounds how far a cell may pour its content out (see `.cell-flow`): at
       the table's own edge, not the scroller's. Without this, a spill past
       the last column counts toward `.table-wrap`'s scrollable width and
       flashes a horizontal scrollbar on hover — which on a platform with
       classic scrollbars also takes a strip of height off the list and
       re-flows the virtualized rows. `clip` rather than `hidden` precisely
       because it does *not* make this a scroll container: `hidden` would
       swallow the wheel events and the horizontal scrolling the `min-width`
       above exists to provide. Verified in both Chrome and Firefox — `clip`
       on a table box is honoured, and the sticky header still sticks. */
    overflow: clip;
    font-size: 13px;
  }
  /* Fixed layout: only the widths on these <col> elements determine the
     column widths — content in the currently rendered virtual window
     can't push columns around during scrolling. Percentages divide the
     table's actual width; the two narrow columns are pinned in px. */
  col.col-check-w    { width: 92px; }
  col.col-disclose-w { width: 24px; }
  col.col-suite-w    { width: 22%; }
  col.col-app-w      { width: 8%; }
  col.col-repo-w     { width: 8%; }
  col.col-platform-w { width: 16%; }
  col.col-options-w  { width: 21%; }
  col.col-unit-w     { width: 6%; }
  /* Fixed rather than a percentage: the count and the strip are both a known
     number of pixels wide, so this column has an actual right answer and no
     reason to breathe with the viewport. The percentages above came down from
     a set summing to 100% to make room — 100% plus a fixed column
     over-specifies the table, and the browser then shrinks the percentage
     columns by whatever it feels like.

     Raising the table's `min-width` to match was tried and reverted: at 1100px
     and above the columns come out identical either way, and below that the
     only effect is to push the panel further past the right edge of a narrow
     window. */
  col.col-activity-w { width: 128px; }
  thead th {
    position: sticky;
    top: 0;
    background: var(--bg-subtle);
    border-bottom: 1px solid var(--border-default);
    text-align: left;
    /* Same fixed-height rule as body cells so the sticky header lines up
       cleanly against the first data row. */
    height: var(--row-height);
    box-sizing: border-box;
    /* No padding: a sortable header fills the cell with a `.sort-btn` that pads
       itself, so `thead th:not(.sortable)` adds the padding back for the rest. */
    padding: 0;
    z-index: 1;
  }
  thead th:not(.sortable) {
    padding: 0 8px;
  }
  .sortable-active {
    background: var(--accent-subtle);
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
    background: var(--bg-overlay-hover);
  }
  .sort-indicator {
    font-size: 9px;
    color: var(--fg-muted);
    opacity: 0.55;
    letter-spacing: -1px;
    font-variant: normal;
  }
  .sortable-active .sort-indicator {
    color: var(--accent-fg);
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
    border-bottom: 1px solid var(--border-muted);
    /* With table-layout: fixed, cells have a definite width, so we must
       clip. Without this, an over-wide badge (e.g. a long platform name)
       would visually overflow into the next column. Lifted on hover; see
       `.cell-flow`. */
    overflow: hidden;
    white-space: nowrap;
    /* Not cosmetic: this is what lets `.cell-flow` back its spill in the
       row's colour (see below). Most row states — plain, and plain hovered —
       are painted on the `<tr>`, leaving the cell transparent, so a cell that
       inherits instead ends up holding the same colour as a *value* that its
       own children can inherit in turn. The states that are painted on the
       cell (`.plotted`, `.subtest-row`) override this and are inherited from
       just the same.

       The alternative was a `--row-bg` custom property declared beside every
       `background` in this file, and it was worse twice over: it's a second
       source of truth that has to be kept in step by hand, and custom
       properties resolve by proximity rather than specificity, so the base
       declaration sitting on `tbody td` quietly beat `tbody tr:hover` and
       backed every hovered row in canvas white. Inheriting the real property
       can't drift and has no levels to get wrong. */
    background-color: inherit;
  }
  tbody tr:hover {
    background: var(--bg-subtle);
  }
  /* Parent rows shown only because a subtest matched. The disclosure caret
     stays live (users need it to collapse the tree), everything else looks
     and behaves inert. */
  tbody tr.row-disabled td {
    color: var(--fg-subtle);
  }
  tbody tr.row-disabled .badge {
    pointer-events: none;
    opacity: 0.55;
  }
  tbody tr.row-disabled .pick:disabled {
    cursor: not-allowed;
  }
  /* Already on the graph. Styled on the cells, not the row, so it also beats
     `.subtest-row td`'s own background. The only row highlight there is now:
     with no staged selection, plotted is the one state a row can be in. */
  tbody tr.plotted td {
    background: var(--accent-tint);
  }
  tbody tr.plotted:hover td {
    background: var(--accent-tint-hover);
  }
  /* Both pick buttons are sized identically and stretched to fill the cell:
     Add, Added and Remove have different label widths, and a column of
     buttons whose left and right edges disagree row to row reads as damage.
     One fixed box means the labels change but nothing moves. */
  .pick {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    width: 100%;
    font-size: 12px;
    line-height: 1.4;
  }
  .pick-cue {
    /* Same reserved width as `.pick-swatch`, so "+ Add" and the swatched
       "Remove" put their labels on the same baseline grid down the column. */
    width: 9px;
    text-align: center;
    opacity: 0.8;
  }
  .pick-swatch {
    width: 9px;
    height: 9px;
    flex: none;
    border: 1px solid var(--series-color);
    border-radius: 3px;
    background: var(--series-color);
  }
  .col-check {
    /* Tighter than the 8px the other cells get: the button inside brings its
       own padding, and the column is paying for a word now. */
    padding: 0 6px;
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
    color: var(--fg-muted);
    background: transparent;
    border: none;
    cursor: pointer;
    transition: transform 0.12s ease;
    user-select: none;
  }
  .disclose:hover {
    color: var(--fg-default);
  }
  .disclose-open {
    transform: rotate(90deg);
  }
  .subtest-row td {
    background: var(--bg-nested);
  }
  .subtest-row:hover td {
    background: var(--bg-nested-hover);
  }
  .subtest-cell {
    padding-left: 24px !important;
  }
  .subtest-note td {
    padding: 4px 8px 4px 40px;
    color: var(--fg-muted);
    font-style: italic;
    background: var(--bg-nested);
  }
  /* An inline box around a cell's whole content run. Two jobs:

     1. It is the hover target that lifts the cell's clip, so a row whose
        options (or 40-character platform name) don't fit can be read
        without widening the column or opening anything. Hovering the cell
        would be easier, but a fixed-width column is mostly empty space in
        most rows, and pouring content out because the pointer crossed the
        blank tail of a cell is noise. The wrapper is exactly as wide as the
        content, and it spans the gaps *between* badges — which nothing else
        does, the badges being separate inline boxes with text nodes between
        them — so the target is "the content", gaps included, and not "the
        cell".
     2. When lifted it carries the row's own background under the spilled
        part, so it covers the neighbouring cells rather than colliding with
        their text.

     The backing is `background-color: inherit`, which lands on the row's
     colour by construction — the cell inherits it from the row (see
     `tbody td`) and the wrapper inherits it from the cell — so there is
     nothing to keep in sync and no state, hovered or plotted or nested, that
     can be missed.

     It is that colour and nothing else: no shadow, no border, nothing that
     says "popover". That is what lets it be unconditional. On the large
     majority of cells, which fit and have nothing to pour, painting the
     row's colour over the row's colour is invisible, so nothing has to know
     whether a given cell actually overflows — which would mean measuring
     every cell in JS on rows being virtualized past at speed. An earlier
     version carried a shadow, and the cost of that was exactly this: it
     fired on every hovered cell and read as a popover opening over cells
     that had nothing to show.

     Geometry is identical hovered and not: the padding and the negative
     margin cancelling it are unconditional, so only paint changes and no
     badge moves under the pointer. The padding is what keeps the spill from
     ending flush against the last badge, where the neighbour's text would
     resume with no gap. */
  .cell-flow {
    display: inline-block;
    vertical-align: middle;
    padding: 0 6px;
    margin: 0 -6px;
    border-radius: 4px;
    background-color: inherit;
  }
  /* `:has()` because the clip lives on the cell but the intent is expressed
     by the content: there's no way for the wrapper to escape an ancestor's
     `overflow: hidden` on its own. */
  tbody td:has(.cell-flow:hover) {
    overflow: visible;
  }
  /* `position` + `z-index` are load-bearing, not polish. Cell backgrounds all
     paint before any cell's inline content, so an unpositioned spill would
     clear the neighbour's background but still end up *under* its badges and
     text. Positioning lifts the wrapper into the positioned layer, above
     both. Above the sticky header's `z-index: 1` too, which is harmless: the
     wrapper only positions itself while hovered, and it can't be hovered
     while the header covers it. */
  tbody td:has(.cell-flow:hover) .cell-flow {
    position: relative;
    z-index: 2;
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
    background: var(--field-option-bg);
    color: var(--field-option-fg);
    border: 1px solid transparent;
    border-radius: 4px;
    white-space: nowrap;
    cursor: pointer;
  }
  .badge:hover {
    filter: brightness(var(--badge-hover-brightness));
  }
  .badge-cue {
    display: inline-block;
    width: 10px;
    text-align: center;
    color: var(--fg-muted);
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
    outline: 2px solid var(--accent-emphasis);
    outline-offset: -2px;
    background: var(--accent-subtle);
    color: var(--accent-on-subtle);
  }
  .badge-active .badge-cue {
    color: var(--danger-fg);
  }
  .badge-repo {
    background: var(--field-repo-bg);
    color: var(--field-repo-fg);
  }
  .badge-platform {
    background: var(--field-platform-bg);
    color: var(--field-platform-fg);
  }
  .badge-app {
    background: var(--field-app-bg);
    color: var(--field-app-fg);
  }
  .badge-option {
    background: var(--field-option-bg);
  }
  .badge-suite {
    background: var(--field-suite-bg);
    color: var(--field-suite-fg);
    font-weight: 600;
  }
  .badge-test {
    background: var(--bg-canvas);
    border-color: var(--border-default);
    color: var(--fg-muted);
    font-family: var(--font-mono);
  }
  .unit {
    color: var(--fg-muted);
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .activity {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
  }
  .runs {
    /* Reserved width, in digits that are all the same width: 6 becoming
       1,204 must not shove the strip sideways. */
    font-variant-numeric: tabular-nums;
    min-width: 5ch;
    text-align: right;
  }
  .runs-pending {
    color: var(--fg-subtle);
  }
  .strip {
    /* Always laid out, even when it draws nothing — the empty box is what
       stops the column twitching as batches land. `block` because an inline
       svg picks up the line box's descender and would sit low in the row. */
    display: block;
    flex: none;
    fill: var(--activity-bar);
  }
  .empty {
    text-align: center;
    color: var(--fg-muted);
    padding: 24px;
  }
  /* Loading placeholders: one grey bar per content column, pulsing together.
     Only `opacity` animates, so this costs nothing while the main thread is
     parsing a 22 MB response. */
  .skeleton:hover {
    background: transparent;
  }
  .skeleton-bar {
    display: block;
    width: 70%;
    height: 14px;
    border-radius: 7px;
    background: var(--bg-neutral-muted);
    animation: skeleton-pulse 1.2s ease-in-out infinite;
  }
  @keyframes skeleton-pulse {
    50% {
      opacity: 0.4;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .skeleton-bar {
      animation: none;
    }
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
    color: var(--danger-fg);
    background: var(--danger-subtle);
    border: 1px solid var(--danger-border);
    padding: 8px 12px;
    border-radius: 6px;
    margin: 0;
    list-style: inside;
  }
</style>
