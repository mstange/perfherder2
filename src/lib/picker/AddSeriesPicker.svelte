<script lang="ts">
  import { untrack } from 'svelte';
  import { activityPath, activityTitle, maxBinCount } from './activity';
  import { type Series } from './series';
import { TIME_RANGES } from './pickerOptions';
  import {
    chipToString,
    graphContextState,
    loadSummary,
    SORT_COLUMNS,
    type FilterField,
    type SortColumn,
  } from './filter';
  import { CONTROL_BLOCK_NARROW, foldPickerLoadRow } from '../shared/layout';
  import { PickerState } from './pickerState.svelte';
  import {
    EMPTY_GRAPH_CONTEXT,
    EMPTY_PICKER_VIEW,
    type GraphContext,
    type PickerViewState,
  } from '../urlState';
  import FilterInput from './FilterInput.svelte';
  import CrossIcon from '../shared/CrossIcon.svelte';
  import ChevronIcon from '../shared/ChevronIcon.svelte';

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
  // block, and the button sits in a plain <div>. Same for the two counts beside
  // it, which are read twice each — once per wording.
  const bulk = $derived(picker.bulkAction);
  const matchingLabel = $derived(picker.filteredParents.length.toLocaleString());
  const loadedLabel = $derived(
    picker.combined.filter((r) => !r.isSubtest).length.toLocaleString(),
  );

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

  // ---- The panel too small for its own chrome ---------------------------
  // On a 390px phone the header, the control card and the status row spent 461
  // of 844px before a single row was drawn — eight rows of list, five when a
  // derived filter's chips stacked one per line, and none at all with the
  // keyboard up. The filter box and the list are what the panel is *for*, so
  // everything else gives way to them: the hint paragraph goes, the counts
  // shorten, and the loading group — the repositories and the time range, which
  // are set once and then left alone — folds behind a line that says what it is
  // set to.
  //
  // **The three give way for different reasons, so they ask different
  // questions.** The hint and the counts' wording are about horizontal room, and
  // the hint's rule is a container query in the stylesheet. The fold is about
  // *vertical* room — what folding buys is list — so it asks `foldPickerLoadRow`,
  // which is a floor under the list with the block's own height subtracted; see
  // layout.ts. Asking it about width folded a 596×900 window that had all the
  // room in the world for the block.
  //
  // The width half is measured here rather than left to the container query,
  // because what happens is not only a matter of style: the summary line is a
  // control that either exists or doesn't, and it carries the `aria-expanded`
  // that says so.
  let panelEl = $state<HTMLElement | null>(null);
  let panelWidth = $state(Infinity);
  let panelHeight = $state(Infinity);
  $effect(() => {
    if (!panelEl) return;
    const ro = new ResizeObserver(([entry]) => {
      // Both from the content box, which is what layout.ts's numbers are
      // relative to: the panel's own 16px padding is outside them.
      panelWidth = entry.contentRect.width;
      panelHeight = entry.contentRect.height;
    });
    ro.observe(panelEl);
    return () => ro.disconnect();
  });
  const chromeNarrow = $derived(panelWidth < CONTROL_BLOCK_NARROW);

  // The status row is four things — the counts, the sort control, the bulk button
  // and `Done` — and below about 600px of panel it cannot hold them on one line:
  // measured at the widest realistic labels, `26,298 / 26,298` plus the sort
  // select plus `Add all 26,298` plus `Done` and their gaps come to ~560px, and a
  // wrap costs 44px of list (the number app.css's `select` note measures too).
  //
  // The number is above `CONTROL_BLOCK_NARROW` rather than equal to it because
  // the sort control only exists in the card layout — in the table the row is
  // three items and fits down to the fold. Measured at the three panels this
  // distinguishes: a 390px phone (358px of content) drops both, a 900px window
  // with the panel docked (556) drops both, and an 1100px window (756) keeps
  // everything.
  const STATUS_ROW_ONE_LINE = 600;
  const statusRoomy = $derived(panelWidth >= STATUS_ROW_ONE_LINE);
  const loadFolded = $derived(foldPickerLoadRow(panelWidth, panelHeight));
  // Transient: which repositories to fetch is not a question anyone answers
  // twice in a session, so this starts closed and nothing tries to remember it.
  let loadOpen = $state(false);
  const loadShown = $derived(!loadFolded || loadOpen);

  // ---- Virtual scrolling ------------------------------------------------
  // Broad filters can produce 25k rows; even one expanded parent adds a few
  // hundred subtests. We render only a scroll-window over a flat row list.
  //
  // Every row is exactly `rowHeight` tall, whichever layout it is in. There are
  // two of them because there are two row layouts (see `cardRows` below): one
  // line of cells, or two lines of a card — the Add button and the name, then
  // the attributes. Whichever is in effect is exported to CSS as the
  // `--row-height` custom property on the .picker root, and `tbody td` /
  // `.card-row` use it as an explicit `height`, so the JS-side number and the
  // CSS-side row height cannot drift apart.
  //
  // Vertical centering is driven by `height + vertical-align: middle`, not by
  // text metrics or padding, so changing fonts or badge styling doesn't move
  // rows around. Column widths are pinned via <colgroup> + `table-layout:
  // fixed` so they don't horizontally re-flow as new rows scroll in either.
  const TABLE_ROW_HEIGHT = 36;
  const CARD_ROW_HEIGHT = 80;
  const OVERSCAN = 6;

  // The table's floor, and the width below which it stops being a table at all.
  // Nine columns of badges do not compress: below this the wrapper used to scroll
  // sideways, which on a 390px phone meant Add, Suite/Test, Repo and half of
  // Platform on screen and the other five columns — the platform, the
  // application, the options, every one of them a filter control — reachable only
  // by dragging a horizontal scrollbar that lives inside a vertical one.
  //
  // So below it each row is a card of two lines instead, carrying the same
  // badges. The number is `64em` at the table's 13px, and it is here rather than
  // in the CSS because the JS decides the layout; the stylesheet reads it back
  // out of `--table-min`.
  const TABLE_MIN = 832;
  const cardRows = $derived(panelWidth < TABLE_MIN);
  const rowHeight = $derived(cardRows ? CARD_ROW_HEIGHT : TABLE_ROW_HEIGHT);

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

  const totalHeight = $derived(flatRows.length * rowHeight);
  const startIndex = $derived(
    Math.max(
      0,
      Math.min(
        flatRows.length,
        Math.floor(scrollTop / rowHeight) - OVERSCAN,
      ),
    ),
  );
  const endIndex = $derived(
    Math.max(
      0,
      Math.min(
        flatRows.length,
        Math.ceil((scrollTop + viewportHeight) / rowHeight) + OVERSCAN,
      ),
    ),
  );
  const topPadding = $derived(startIndex * rowHeight);
  const bottomPadding = $derived(Math.max(0, totalHeight - endIndex * rowHeight));
  const visibleWindow = $derived(flatRows.slice(startIndex, endIndex));

  // Placeholder rows for the loading state: as many as fit the scroller, so
  // the block covers the area the real rows will and no more. Reusing
  // `viewportHeight` means it tracks a resized window for free, and — since the
  // header shares the scroller — it also means the loading state carries the
  // same vertical scrollbar the loaded list does, so no column shifts when the
  // rows arrive.
  const skeletonCount = $derived(Math.max(1, Math.floor(viewportHeight / rowHeight)));

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

<!-- The three pieces of a row, declared out here because two layouts render
     them: the table's cells wrap each one in a `<td>`, and the card list puts
     the same three on two lines. Everything that decides what a row *says* is in
     here once — a second copy is how the two would drift. -->

<!-- Every badge is a filter toggle. Same visual as a plain tag, with a "+" cue on
     hover and always when the chip is active. -->
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
    title={active ? `Remove filter ${field}:${value}` : `Filter to only ${field}:${value}`}
    onclick={() => picker.toggleFilterChip(field, value, { fromSubtest })}
  >
    <span>{value}</span>
    <span class="badge-cue" aria-hidden="true">{active ? '×' : '+'}</span>
  </button>
{/snippet}

<!-- The pick control for one row: a button with a verb on it, not a checkbox,
     and it acts on the graph immediately rather than staging behind a footer
     button. User testing found people didn't recognise the checkbox as "the way
     to get this series", and reached for the disclosure caret instead — the only
     control on the row that looked like it led somewhere. See docs/design.md,
     "The row's pick control". Two buttons rather than one that flips label,
     because Add and Remove are not two states of one toggle: each row is only
     ever offered whichever one applies to it. -->
{#snippet pickButton(row: Series, disabled: boolean)}
  {@const color = picker.plotted.get(row.key)}
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
{/snippet}

<!-- Three states in one fixed-size box, so nothing moves as batches land: not
     fetched yet, failed, and answered. The <svg> is always present at the same
     width and height even when it draws nothing — an empty box is what keeps the
     column from twitching row by row. `{@const}` takes no type annotation, so
     `activity` is inferred as `Activity | null` from `activityFor`. -->
{#snippet activityMark(row: Series)}
  {@const activity = picker.activityFor(row)}
  <span class="activity">
    {#if activity === null}
      <span class="runs runs-pending">·</span>
    {:else if 'error' in activity}
      <span class="runs runs-pending" title="Run activity failed: {activity.error}">—</span>
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
        <path d={activityPath(activity.counts, STRIP_W, STRIP_H, activityScaleMax)} />
      {/if}
    </svg>
  </span>
{/snippet}

<!-- A row's attributes, in the table's column order so the two layouts read the
     same way round: what repository, what platform, what application, and the
     options. The card list puts this on its second line. -->
{#snippet attrBadges(row: Series, fromSubtest: boolean)}
  {@render badge('repo', row.repository, 'badge-repo', fromSubtest)}{' '}
  {@render badge('platform', row.platform, 'badge-platform', fromSubtest)}{' '}
  {#if row.application}
    {@render badge('application', row.application, 'badge-app', fromSubtest)}{' '}
  {/if}
  {#each row.options as o}
    {@render badge('option', o, 'badge-option', fromSubtest)}{' '}
  {/each}
{/snippet}

<div class="picker" style:--row-height="{rowHeight}px" style:--table-min="{TABLE_MIN}px" bind:this={panelEl}>
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
      <button type="button" class="btn close" onclick={onclose} aria-label="Close">
        <CrossIcon />
      </button>
    {/if}
  </header>

  {#if picker.metadataError}
    <div class="error">Failed to load metadata: {picker.metadataError}</div>
  {/if}

  <!-- Two groups, one per thing the panel decides, each on one grid row:
       what gets loaded, and what of it is shown. The label rail names the
       group; the right rail holds that group's secondary controls. Which row
       a control belongs on is not a matter of taste — `cacheKey` is
       `repo | subtests | interval`, so repos and the time range are the fetch,
       and everything else is a filter semantic. See docs/design.md, "The
       control block is two groups: what loads, and what shows". -->
  <section class="controls control-grid">
    <span class="control-label">Filter</span>
    <FilterInput
      filter={picker.filter}
      onchange={(next) => {
        picker.filter = next;
      }}
    />
    <div class="control-aside">
      <!-- Both always mounted, both fixed-width labels: the rail must not
           resize as series load or as the filter changes. Disabled is the
           signal, and for "Derive filter" it carries information — disabled
           *because the filter is already the derived one* is the one place the
           panel says the filter and the graph agree.

           Fill it / empty it, on the same object: both labels take "filter" as
           their grammatical object, which is what keeps them from reading as
           actions on the *graph* in a dialog whose whole job is changing the
           graph. See docs/design.md, "Deriving the filter, and clearing it". -->
      <div class="control-aside-line">
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
      <!-- On the filter's row, not the loading one, because that is what it
           is: whether the filter descends into subtests. It only *implies* a
           fatter fetch. See docs/design.md, "'Match inside subtests' is a
           filter semantic; fetching is separate". -->
      <label class="control-toggle">
        <input type="checkbox" bind:checked={picker.matchSubtests} />
        Match inside subtests
      </label>
    </div>

    {#if loadFolded}
      <!-- The load row's one-line stand-in. It states the two things it folded
           away — which repositories, over what window — rather than saying
           "Load from ▾" and making the reader open it to find out, which is the
           tap folding it was meant to save. Same bargain as the graph header's
           collapsed bar; see docs/graphs.md, "A pane too short for the bar". -->
      <button
        type="button"
        class="load-summary"
        aria-expanded={loadOpen}
        aria-controls="picker-load-row"
        onclick={() => (loadOpen = !loadOpen)}
      >
        <span
          >{loadSummary(
            picker.repoChips.filter((r) => picker.selectedRepos.has(r)),
            rangeLabel,
          )}</span
        >
        <ChevronIcon dir={loadOpen ? 'up' : 'down'} />
      </button>
    {/if}

    <span class="control-label" hidden={!loadShown}>Load from</span>
    <div class="chips" id="picker-load-row" hidden={!loadShown}>
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
    <div class="control-aside" hidden={!loadShown}>
      <!-- "last" completes the row's sentence — *load from* these repos, last
           14 days — rather than being a second label in the style of the rail's.
           It is decorative for that reason, and the select carries the real
           name for assistive technology. -->
      <div class="control-aside-line">
        <span class="control-word" aria-hidden="true">last</span>
        <select aria-label="Time range" bind:value={picker.timeRangeSeconds}>
          {#each TIME_RANGES as tr}
            <option value={tr.value}>{tr.label}</option>
          {/each}
        </select>
      </div>
    </div>
  </section>

  <!-- The status row counts the rows below it and acts on them in bulk, so it
       belongs to the list, not to the controls: it sits in the same box, one
       small gap away, rather than floating equidistant between the two. -->
  <div class="list">
  <!-- Both buttons stay mounted even when they have nothing to act on, so the
       status row's height never changes. Disabled is the visual signal.
       Nothing here commits anything any more — rows land on the graph as they
       are clicked — so the primary button just leaves, and Escape or the
       backdrop no longer throw away work the user thought they had done. -->
  <div class="status">
    <!-- The same two numbers either way. Folded, they lose the words that name
         them and keep them in a `title`: at a phone's width this row wrapped to
         two lines, and the pair of counts is the part a reader recognises by
         shape rather than by reading. -->
    {#if chromeNarrow}
      <span title="{matchingLabel} matching of {loadedLabel} loaded"
        >{matchingLabel} / {loadedLabel}</span
      >
    {:else}
      <span>{matchingLabel} matching / {loadedLabel} total</span>
    {/if}
    {#if picker.anyLoading}<span class="loading-note">Loading…</span>{/if}
    <!-- Sorting, for the layout with no column headers to click. It lives on the
         status row because that is the row that belongs to the list (see the
         comment above it), and it is only rendered where the headers are gone —
         two ways to sort on screen at once would be two places to look for the
         current one. `As loaded` is a choice here rather than the third click of
         a cycle. -->
    {#if cardRows}
      <label class="sort-select">
        <span class="control-word">sort</span>
        <select
          aria-label="Sort by"
          value={picker.sort?.column ?? ''}
          onchange={(e) =>
            picker.setSortColumn((e.currentTarget.value || null) as SortColumn | null)}
        >
          <option value="">as loaded</option>
          {#each SORT_COLUMNS as column}
            <option value={column}>{column}</option>
          {/each}
        </select>
        <button
          type="button"
          class="btn btn-compact sort-dir"
          disabled={!picker.sort}
          aria-label={picker.sort?.direction === 'desc' ? 'Sort ascending' : 'Sort descending'}
          title={picker.sort?.direction === 'desc' ? 'Sort ascending' : 'Sort descending'}
          onclick={() => picker.toggleSortDirection()}
        >
          <ChevronIcon size={11} dir={picker.sort?.direction === 'desc' ? 'down' : 'up'} />
        </button>
      </label>
    {/if}
    <!-- Dropped where the row is too tight for four things, which is a narrower
         panel than the one that folds the controls: the counts say what the list
         is and `Done` is the way out, so a running total is what is left to lose.
         At 390px the four of them wrapped to a second line and cost 38px — a whole
         row of list — and the feedback is not gone, since the row a tap acted on
         turns into a tinted `Remove` with the series' own colour on it. -->
    {#if statusRoomy}
      <span class="plotted-count" class:muted={picker.plotted.size === 0}>
        {picker.plotted.size} on the graph
      </span>
    {/if}
    <!-- Right-aligned, and the count is in the label rather than a tooltip:
         "Add all 24,913" has to be able to talk the user out of it. Growing
         the label eats the gap to its left instead of shoving Done sideways.

         Gone with the plotted count on a panel too tight for four things, and it
         is the right one to lose there: plotting seventeen series onto a 390px
         graph is not a thing anyone wants, and both halves of the button have
         another home — a row's own Add is one tap away in the card beside it, and
         the series list's footer carries `Remove all`. -->
    {#if statusRoomy}
      <button
        type="button"
        class="btn bulk"
        disabled={bulk.rows.length === 0}
        onclick={() => (bulk.kind === 'add' ? onadd?.(bulk.rows) : onremove?.(bulk.rows))}
        >{bulk.kind === 'add' ? 'Add all' : 'Remove all'}
        {bulk.rows.length.toLocaleString()}</button
      >
    {/if}
    <button
      type="button"
      class="btn btn-primary done"
      class:trailing={!statusRoomy}
      onclick={() => onclose?.()}>Done</button
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
    aria-busy={picker.listStatus === 'loading'}
  >
    {#if cardRows}
      <!-- The same rows, two lines each, for a panel narrower than the table's
           floor. Divs and not a squeezed table: `table-layout: fixed` exists to
           stop the columns re-flowing as rows scroll past, and there is no column
           arrangement that fits nine of these in a phone's width — see `TABLE_MIN`
           above, and docs/design.md, "A panel a phone wide lists cards, not
           columns". Everything a row says comes from the same three snippets the
           cells use. -->
      <div class="cards" role="list">
        {#if topPadding > 0}
          <div class="spacer" aria-hidden="true" style="height: {topPadding}px"></div>
        {/if}
        {#each visibleWindow as item, i (rowKey(item, startIndex + i))}
          {#if item.kind === 'note'}
            <div class="card-note">{item.message}</div>
          {:else}
            {@const row = item.row}
            {@const isChild = item.kind === 'child'}
            {@const disabled = !isChild && picker.isRowDisabled(row)}
            {@const isExpanded = picker.isRowExpanded(row.key)}
            <div
              class="card-row"
              class:card-child={isChild}
              class:row-disabled={disabled}
              class:plotted={picker.plotted.has(row.key)}
              role="listitem"
            >
              <div class="card-head">
                {@render pickButton(row, disabled)}
                <!-- Kept where the table puts it, at the leading edge of the
                     name: it is the control that says a row has more inside it,
                     and a caret trailing the name reads as decoration. A child
                     row has nothing to expand and gets the indent instead. -->
                {#if !isChild && row.hasSubtests}
                  <button
                    type="button"
                    class="disclose"
                    class:disclose-open={isExpanded}
                    aria-expanded={isExpanded}
                    aria-label={isExpanded ? 'Collapse subtests' : 'Expand subtests'}
                    onclick={() => picker.toggleExpanded(row.key)}>▶</button
                  >
                {/if}
                <!-- The one thing on the card that can still be cut: a long
                     subtest name against the run count and its strip. The strip
                     stays — whether a series has runs at all is why it is on the
                     card — and the `title` carries the full name for the pointers
                     that can show one. -->
                <span class="card-name" title="{row.suite}{row.test ? ` / ${row.test}` : ''}">
                  {#if isChild}
                    {@render badge('test', row.test || row.suite, 'badge-test', true)}
                  {:else}
                    {@render badge('suite', row.suite, 'badge-suite')}{' '}
                    {#if row.test}
                      {@render badge('test', row.test, 'badge-test')}
                    {/if}
                  {/if}
                </span>
                <span class="card-measure">{@render activityMark(row)}</span>
              </div>
              <!-- The unit trails the attributes rather than sharing the first
                   line with the run count, where it was taking ~40px away from
                   the suite name — the one string on the card the panel is
                   actually being searched by. It is a fact about the measurement
                   and not a filter, so it is the one thing on this line that is
                   not a badge. -->
              <div class="card-attrs">
                {@render attrBadges(row, isChild)}<span class="unit">{row.measurementUnit}</span>
              </div>
            </div>
          {/if}
        {/each}
        {#if bottomPadding > 0}
          <div class="spacer" aria-hidden="true" style="height: {bottomPadding}px"></div>
        {/if}
        {#if picker.listStatus === 'loading'}
          {#each Array(skeletonCount) as _, i (i)}
            <div class="card-row skeleton" aria-hidden="true">
              <div class="card-head"><span class="skeleton-bar pulse"></span></div>
              <div class="card-attrs"><span class="skeleton-bar pulse"></span></div>
            </div>
          {/each}
        {:else if picker.listStatus !== 'rows'}
          <p class="empty">
            {#if picker.listStatus === 'no-repos'}
              No repositories selected — open the load line above and check one.
            {:else}
              No matching series.
            {/if}
          </p>
        {/if}
      </div>
    {:else}
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

        {#snippet pickCell(row: Series, disabled: boolean)}
          <td class="col-check">{@render pickButton(row, disabled)}</td>
        {/snippet}

        {#snippet activityCell(row: Series)}
          <td class="col-activity">{@render activityMark(row)}</td>
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
              <td><span class="skeleton-bar pulse"></span></td>
              <td><span class="skeleton-bar pulse"></span></td>
              <td><span class="skeleton-bar pulse"></span></td>
              <td><span class="skeleton-bar pulse"></span></td>
              <td><span class="skeleton-bar pulse"></span></td>
              <td><span class="skeleton-bar pulse"></span></td>
              <td><span class="skeleton-bar pulse"></span></td>
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
    {/if}
  </div>
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
    /* `width` is load-bearing next to the auto margins, and only in one
       direction: an auto margin on the cross axis turns off a flex item's
       stretch, so without it this box is sized to fit its content — and its
       content has a floor, the table's `min-width: 64em`. In a window narrower
       than that the panel stopped shrinking at 866px and simply hung off the
       right-hand edge, taking `Done` and the close button with it and leaving
       Escape as the only way out. With a width to stretch to, the shrink lands
       on `.table-wrap` instead, which has had `overflow: auto` for exactly this
       (see the note there). The pairing still centres the picker on a display
       wide enough for the cap to bite, which is what the margins are for. */
    width: 100%;
    margin: 0 auto;
    /* What `.control-grid`'s narrow rule in app.css measures against. It has to
       be this box rather than the viewport: the panel docks past the sidebar,
       so the two numbers differ by 280px, and on the tier where the sidebar is
       gone they don't. Safe to contain — the width above is definite, so
       nothing inside was sizing this. */
    container: picker-panel / inline-size;
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
  /* Square, and sized rather than padded; the rest comes from `.btn`. */
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
  /* app.css's floor gives this its height but nothing gives it its width, so it
     comes out 32×28: a rectangle where a square was intended. Both axes, then,
     and after the base rule — a media query adds no specificity.

     It costs no list — the header is 32px from its `<h2>` regardless, measured
     with `tools/visual/picker-rollback-costs.mjs` — so this is only about a close
     box in the corner being square rather than being big.

     32 is also `.btn`'s own floor, so a `min-height` here would be redundant —
     but only while the two agree. Raise that floor and this goes back to being a
     32×36 rectangle, silently, because a `height` loses to a larger
     `min-height`. */
  @media (pointer: coarse) {
    .close {
      width: 32px;
      height: 32px;
    }
  }
  .hint code {
    background: var(--bg-subtle);
    padding: 0 3px;
    border-radius: 3px;
    font-size: 12px;
  }
  /* Hidden, not unmounted, so the summary's `aria-controls` points at something
     that exists — and `[hidden]`'s UA rule is zero-specificity, so the class
     rules on these three would otherwise win and the attribute would do nothing.
     Same trap as the graph header's collapsed block. */
  .control-label[hidden],
  .chips[hidden],
  .control-aside[hidden] {
    display: none;
  }
  /* The folded load row's line. A button, because that is what it is, but it
     reads as the text it replaced: full width so the chevron sits at the far
     edge, and quiet enough that the filter box above it stays the loudest thing
     in the card. */
  .load-summary {
    /* Its own row, across every column. Auto-placement puts a grid item in the
       next free cell, which for this one is the *label rail* of the second row —
       and the rail is an `auto` track, so a full-width button in it grew the
       first column and took the width straight out of the filter box beside it.
       Measured at a 656×619 window, which is a panel wide enough to keep the rail
       and short enough to fold: the box lost ~200px. Spanning the row is also what
       it means: the line stands in for a whole group, not for a label. */
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    padding: 4px 8px;
    background: var(--bg-canvas);
    border: 1px solid var(--border-default);
    border-radius: 6px;
    font: inherit;
    color: var(--fg-muted);
    text-align: left;
    cursor: pointer;
  }
  .load-summary:hover {
    color: var(--fg-default);
  }
  .load-summary > span:first-child {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  /* Two groups, one grid row each; the alignment is `.control-grid` in
     app.css, which the graph header shares. What's left here is this block's
     own frame: a card, because it sits inside a panel rather than being one. */
  .controls {
    padding: 12px;
    background: var(--bg-subtle);
    border: 1px solid var(--border-default);
    border-radius: 6px;
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
  select {
    padding: 4px 6px;
    border: 1px solid var(--border-default);
    border-radius: 6px;
    background: var(--bg-canvas);
  }
  /* The list and the line that describes it. A flex column so the scroller
     inside keeps absorbing the leftover height: `flex: 1` + `min-height: 0`
     has to be repeated at every level of the chain, or the innermost item
     sizes to its (25k-row) content and the whole panel scrolls instead. */
  .list {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    gap: 6px;
  }
  /* Wraps, which costs nothing where the row fits — it never has slack to spare
     until the panel is a phone wide — and is the difference between `Done`
     being off the right-hand edge and being on the next line. The two
     `min-width`s below are what make the row too wide to fit before its
     contents are: 27ch of reserved count before the buttons even start. */
  .status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    padding: 0 4px;
  }
  .plotted-count {
    font-weight: 600;
    min-width: 14ch;
    display: inline-block;
  }
  /* Pushed right, away from the counts on the left, so a longer label grows
     into the gap rather than moving Done. The `min-width` covers the usual
     case outright: only five-figure counts exceed it.

     There is no narrow override giving this reservation back, and there was one
     that could never fire: this button and `.plotted-count` beside it are only
     rendered above `STATUS_ROW_ONE_LINE` (600), and the narrow container query is
     below `CONTROL_BLOCK_NARROW` (560). The width where the reservation would
     have cost something is a width where neither element exists. */
  .bulk {
    margin-left: auto;
    min-width: 13ch;
  }
  /* The card list's sort control. A `<select>` and a direction button, sized to
     sit on the status row without pushing `Done` off it. */
  .sort-select {
    display: flex;
    align-items: center;
    gap: 4px;
    cursor: pointer;
  }
  .sort-select select {
    padding: 2px 4px;
    font-size: 12px;
  }
  .sort-dir {
    display: inline-grid;
    place-items: center;
    padding: 2px 6px;
  }
  /* With the bulk button gone, `Done` is what holds the trailing edge. */
  .done.trailing {
    margin-left: auto;
  }
  /* Everything this panel gives up when it is a phone wide. The threshold is
     `CONTROL_BLOCK_NARROW`, which the script reads too — see the note there;
     these are the parts that are only a matter of style.
     **After every rule it overrides**, and it has to be: a container query adds
     no specificity, so this block above `.status` lost its gap to the later
     declaration and the row went on wrapping. Exactly the trap the `@media
     (pointer: coarse)` blocks document, in the other kind of query. */
  @container picker-panel (width < 560px) {
    /* Four lines and ~70px of an 844px screen, spent explaining affordances (a
       badge filters, a caret expands) that a tap discovers in one go. It stays
       where there is room, because on a desktop it costs nothing. */
    .hint {
      display: none;
    }
    /* The status row's own slack, spent to keep everything on it on one line —
       at touch sizes the three items come to 338px, against 335px of row at a
       375px phone, and a 3px overrun costs a whole 44px line of list.
       The inset was aligning the counts with nothing in particular (the
       scroller's edge is 4px further out), and 8px still separates three items
       plainly at this width. What it buys is the `sort` word beside the select:
       hiding that word is the other way to find these 12px, and this is the
       better use of them — a row with a spare 4px of inset and no word for its
       control is a worse row.

       Headroom afterwards is ~13px at 375 and ~28 at 390, or about two more
       digits on each count. Past that it wraps, which is the graceful end. */
    .status {
      gap: 8px;
      padding: 0;
    }
  }
  /* The panel's chrome under a thumb: the three shapes above the list that
     app.css's floor cannot reach, because none of them carries `.btn`. They are
     the panel's own — a pill, a full-width summary line, a sort direction button —
     and this is the layout a phone gets, so all three are targets a finger is
     aiming at. They were the smallest things on the panel at 30, 30 and 25×32.
     After the base rules, since a media query adds no specificity.

     **One property each, and the same 32 as `.btn`.** All three centre their own
     content (`inline-flex`, `flex`, `inline-grid`), so a height is the whole fix
     and none of them needs matching padding — the first version of this block set
     paddings and gaps too, and every one of them was either redundant or paid for
     in width: 12px of chip padding cost a whole line of chips, because
     `mozilla-beta` and `try` then came to 336px against 334px of card. */
  @media (pointer: coarse) {
    /* The pill had collapsed onto its checkbox — 30px tall, the box touching both
       edges of a 999px radius, because 4px of padding was sized around a 13px
       checkbox and the floor grew it. The height is what puts the pill back. */
    .chip {
      min-height: 32px;
    }
    /* The one control that gets the folded group back. */
    .load-summary {
      min-height: 32px;
    }
    /* The only target in the panel that was short in *both* axes. Square, and
       level with the select beside it, so the pair reads as one control.

       Nothing here for the select itself, and there was: it took app.css's 16px
       on the grounds that a control under 16px is iOS's zoom-on-focus bug. A
       `<select>` does not take a caret, so it is not that bug — and 16px cost 23px
       of width in the one row with none to give, which dropped the `sort` word
       beside it. Its 12px now keeps the `min-height` app.css gives every select,
       which was the part it was actually missing: a scoped rule setting only
       `padding` and `font-size` doesn't shadow that. */
    .sort-dir {
      min-width: 32px;
    }
    /* The one control in a *row* worth growing, and the only one that can be:
       a 20×20 caret 6px from a button that puts a series on the graph is a
       mis-tap with a visible consequence. The height is free — the card's head
       line is already as tall as the `.btn-compact` in it — and the width costs
       8px of the suite name, which is the cheapest 8px on the card.

       Scoped to the card head rather than to the panel: the table's own caret
       sits in a 24px column, and the layout a touch device gets on a phone is
       the card list. Same reasoning as the `tbody .btn` exemption below. */
    .card-head .disclose {
      width: 28px;
      height: 32px;
    }
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
    /* A flick that reaches the end of the list stops there, instead of handing
       the rest of the gesture to the document — which on a phone is a rubber-band
       over a page that has nothing to scroll, and on some browsers a pull-to-
       refresh that throws the panel away. */
    overscroll-behavior: contain;
  }
  /* The card list: the same rows as the table, two lines each, for a panel
     narrower than `TABLE_MIN`. See docs/design.md, "A panel a phone wide lists
     cards, not columns".

     Every card is exactly `--row-height` tall and says so, because the
     virtualizer's arithmetic is the same in both layouts and a card that sized
     itself to its content would put every row below it in the wrong place. That
     is also why the attribute line is clamped rather than left to wrap freely: the
     number of options a row carries is not bounded, and one row of three lines
     would desynchronise the whole scroller. */
  .cards {
    display: flex;
    flex-direction: column;
  }
  /* Two lines of badges, which is what `CARD_ROW_HEIGHT` is: a 26px head and two
     20px badge lines inside 8px of padding. Measured against the busiest
     realistic row rather than chosen — speedometer3 on a long android platform
     with five options is the case that used to clip, and it fits. Beyond that the
     clamp cuts the tail, which is the deal the table's columns already made. */
  .card-row {
    height: var(--row-height);
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 2px;
    padding: 0 8px;
    border-bottom: 1px solid var(--border-muted);
    /* The same inheritance trick the table's cells use, so a badge's own
       background sits on the row's colour rather than on the canvas. */
    background-color: inherit;
  }
  .card-head {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  /* The name gets the slack, and the two ends keep their size: a long suite or
     test is what the panel is being searched by. */
  .card-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
  }
  .card-head .pick {
    /* Not the table's full-column width — here the button is one item on a line
       with the name, and 92px of it would leave a phone about twenty characters
       of suite. */
    flex: none;
    width: auto;
  }
  .card-measure {
    display: flex;
    flex: none;
    align-items: center;
    gap: 6px;
  }
  .card-attrs {
    min-width: 0;
    overflow: hidden;
    white-space: normal;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
  }
  /* The `+` cue reserves 10px in every badge so that hovering one can't resize
     it. There is no hover here — this layout exists for touch — so the reserve is
     10px per badge of a line that is already the tightest thing on the card, five
     or six times over. An active chip still shows its `×`, and the badge growing
     by 10px on that tap is a filter change, which redraws the list anyway. */
  .card-row .badge:not(.badge-active) .badge-cue {
    display: none;
  }
  /* Trailing the badges, in the muted monospace the table's unit column uses. */
  .card-attrs .unit {
    margin-left: 2px;
  }
  /* A subtest under its expanded parent: indented, and on the nested surface the
     table's `.subtest-row` uses, so the tree reads the same way in both layouts. */
  .card-child {
    padding-left: 24px;
    background: var(--bg-nested);
  }
  /* One slot tall, like every other row in the flat list — the virtualizer counts
     notes as rows too, and the table's version gets this from `tbody td`'s
     height. Two lines of it fit inside a card's height at a phone's width. */
  .card-note {
    height: var(--row-height);
    box-sizing: border-box;
    display: flex;
    align-items: center;
    overflow: hidden;
    padding: 4px 8px 4px 24px;
    color: var(--fg-muted);
    font-style: italic;
    background: var(--bg-nested);
    border-bottom: 1px solid var(--border-muted);
  }
  .card-row.plotted {
    background: var(--accent-tint);
  }
  .card-row.row-disabled {
    color: var(--fg-subtle);
  }
  .card-row.row-disabled .badge {
    pointer-events: none;
    opacity: 0.55;
  }
  /* One bar per line rather than one per column. Same `.pulse` as everywhere. */
  .card-row.skeleton .skeleton-bar {
    width: 60%;
  }
  .card-row.skeleton .card-attrs .skeleton-bar {
    width: 80%;
    height: 10px;
  }
  table {
    table-layout: fixed;
    width: 100%;
    /* Floor for the whole table so columns never get too cramped. It is also
       the width below which there is no table at all: the script reads the same
       number as `TABLE_MIN` and renders cards instead, so the horizontal
       scrollbar this used to hand out now only appears in the band between the
       floor and whatever the scrollbar itself takes. */
    min-width: var(--table-min);
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
       the virtualizer uses for scrollTop math — see `rowHeight`). Content
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
  /* There is deliberately no coarse exemption for `tbody .btn`, and there was
     one: a table row is exactly `--row-height` = 36px by construction (see
     `rowHeight`), and while the floor was 36 with 6px of block padding, a row's
     `.btn-compact` grew past its own slot and desynchronised the virtualizer. At
     32 it fits, so the exemption went with the 4px — one of three rules that only
     existed to work around the taller floor. `tools/visual/picker-card-pitch.mjs`
     is what checks the rows still sum to `rows × slot`, in both layouts. */
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
     The pulse itself is `.pulse` from app.css, shared with the series card's
     alert-count placeholder — only `opacity` animates, so this costs nothing
     while the main thread is parsing a 22 MB response. */
  .skeleton:hover {
    background: transparent;
  }
  .skeleton-bar {
    display: block;
    width: 70%;
    height: 14px;
    border-radius: 7px;
    background: var(--bg-neutral-muted);
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
