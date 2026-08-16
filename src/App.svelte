<script lang="ts">
  // Three-pane shell: series list, graphs, selection details. The Add-series
  // picker opens as an overlay over the lot — it needs the full width for its
  // table, and mounting it lazily keeps its multi-megabyte signature fetch off
  // the critical path for someone opening a shared graph link.

  import AddSeriesPicker from './lib/picker/AddSeriesPicker.svelte';
  import DetailsPane from './lib/graphs/DetailsPane.svelte';
  import GraphPane from './lib/graphs/GraphPane.svelte';
  import SeriesList from './lib/graphs/SeriesList.svelte';
  import ChevronIcon from './lib/shared/ChevronIcon.svelte';
  import Tooltip from './lib/shared/Tooltip.svelte';
  import { AppState } from './lib/graphs/appState.svelte';
  import {
    PANE_LABELS,
    isPaneVisible,
    layoutFor,
    listIsSheet,
    resolvePane,
    switchedPanes,
    type Pane,
  } from './lib/shared/layout';
  import type { Series } from './lib/picker/series';

  const app = new AppState(location.search);

  // Both take effect immediately and leave the panel open. The picker used to
  // stage adds and close on commit; it no longer stages anything, so there is
  // nothing left for closing to mean. Each call is one `syncUrl('push')`, so
  // Back undoes exactly one click — including a bulk one, which is why these
  // hand the whole array down rather than looping.
  const refFor = (s: Series) => ({
    repository: s.repository,
    signatureId: s.id,
    frameworkId: s.frameworkId,
  });

  function handleAdd(series: Series[]) {
    app.addSeries(series.map(refFor));
  }

  function handleRemove(series: Series[]) {
    app.removeSeries(series.map(refFor));
  }

  // Which of the four arrangements the window can afford. The thresholds and
  // the reasoning are in layout.ts; what is here is only the wiring.
  //
  // Driven from JS and published as `data-layout` rather than written as media
  // queries, because two things that are not CSS have to agree with it: which
  // panes the Add-series panel covers (and therefore which are `inert` while it
  // is open — a DOM property no media query can set), and which panes the
  // switcher offers. A media query plus a matching `matchMedia` would be the
  // same numbers written twice, and the failure would be silent.
  //
  // Both axes, because two of the arrangements put a pane in a *row* — see
  // layout.ts, and `resize` fires for either dimension.
  let layout = $state(layoutFor(window.innerWidth, window.innerHeight));
  $effect(() => {
    const measure = () => (layout = layoutFor(window.innerWidth, window.innerHeight));
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });

  // The height the app lays itself out in, when that is not the window's.
  //
  // `100dvh` is the window, and the window is not what an on-screen keyboard
  // takes space from: iOS leaves the layout viewport alone and slides a smaller
  // *visual* viewport around inside it, so a full-height shell keeps its full
  // height and the keyboard simply covers the bottom of it — which, with the
  // Add-series panel open, is the list the panel exists to show. Measured on a
  // 390×844 viewport: a 336px keyboard left the picker's list 2px tall.
  // `interactive-widget` in index.html asks the browser to do this for us and
  // Chrome obliges; this is for the ones that don't.
  //
  // **Gated on the scale, because pinch-zoom shrinks the visual viewport too.**
  // Zooming in on a graph would otherwise re-lay-out the app to the magnified
  // region, which is a rearrangement nobody asked for. A keyboard leaves the
  // scale at 1, so that is the tell.
  let appHeight = $state<number | null>(null);
  $effect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const measure = () => {
      appHeight = vv.scale > 1.01 ? null : Math.round(vv.height);
    };
    measure();
    vv.addEventListener('resize', measure);
    return () => vv.removeEventListener('resize', measure);
  });
  const heightStyle = $derived(appHeight === null ? null : `${appHeight}px`);

  // The panes sharing one cell in this arrangement, and which of them has it.
  // Deliberately not in the URL — it answers "what am I looking at on this
  // screen", not "what am I looking at", and a shared link that forced a
  // companion onto the Selection tab because the sender was on a phone would be
  // a bug.
  const panes = $derived(switchedPanes(layout));
  let requestedPane = $state<Pane>('graph');
  const activePane = $derived(resolvePane(requestedPane, panes));

  // The series list, where it is a sheet rather than a column: one button in the
  // bottom bar opens it over the window, its own close button dismisses it.
  //
  // Local, and not in the URL, for the reason `requestedPane` is: it is a fact
  // about this screen. Reset when the arrangement gives the list a column back,
  // or a resize would leave a sheet's worth of `display: none` sitting over a
  // layout that has nowhere to put it.
  const sheeted = $derived(listIsSheet(layout));
  let listSheetOpen = $state(false);
  $effect(() => {
    if (!sheeted) listSheetOpen = false;
  });

  // A click on the graph *is* a request to see the selection, and where the
  // selection is switched it is a pane the user would otherwise have to go and
  // find. Only on a change of point, so that zooming, hiding a series or
  // toggling a switch — all of which touch the selection without being about it
  // — leave the user where they are.
  //
  // **And the reverse, which used to be `resolvePane`'s job.** A selection can go
  // away without the user asking — removing the last series, a Back that drops
  // the point — and leaving the switcher pressed on a pane that now only says
  // "tap a point" is not what they were reading. Moving it *here*, at the moment
  // the point goes, is what lets a deliberate tap on Selection with nothing
  // selected show the pane and its instruction instead of being swallowed. See
  // `resolvePane`.
  let lastSelected: unknown = app.selectedPoint;
  $effect(() => {
    const selected = app.selectedPoint;
    if (selected !== lastSelected) {
      lastSelected = selected;
      if (selected) {
        if (panes.includes('selection')) requestedPane = 'selection';
      } else if (requestedPane === 'selection') {
        requestedPane = 'graph';
      }
    }
  });

  // The panel covers the graph and the details pane in every arrangement. It
  // covers the series list only when the list isn't beside it — which is where
  // the list is a sheet, and there the panel has the whole window. See
  // docs/design.md, "The Add-series panel docks beside the series list".
  const listCovered = $derived(app.pickerOpen && sheeted);

  // The bottom bar's series button: how many, and in what colors. The dots are a
  // count cue rather than a legend — they say "these lines are what you are
  // looking at", and the swatch that identifies a series by *shape* as well as
  // color is in the list this button opens. Four is where they stop being
  // countable at a glance, and the number beside them is the real answer anyway.
  const MAX_DOTS = 4;
  const seriesDots = $derived(app.series.slice(0, MAX_DOTS).map((e) => e.color));
  const seriesCount = $derived(app.series.length);

  // Send focus back where it came from when the panel closes, so dismissing
  // it doesn't dump the user at the top of the document.
  //
  // `$effect.pre` matters: it runs *before* the DOM update that mounts the
  // picker, so `activeElement` is still the button that opened it. A plain
  // `$effect` would run after the picker's autofocused input had already
  // taken focus, and we'd memorize an element that is about to be destroyed.
  let restoreFocusTo: HTMLElement | null = null;
  $effect.pre(() => {
    if (app.pickerOpen) {
      restoreFocusTo = document.activeElement as HTMLElement | null;
    } else if (restoreFocusTo) {
      const target = restoreFocusTo;
      restoreFocusTo = null;
      // After the DOM settles, or focus lands on the element being removed.
      queueMicrotask(() => target.focus());
    }
  });
</script>

<!-- Escape closes the series sheet, the same exit the Add-series panel gives.
     Not registered conditionally: the handler is a no-op unless the sheet is
     open, and a listener whose lifecycle follows a boolean is a listener to get
     wrong. -->
<svelte:window
  onpopstate={() => app.onPopState(location.search)}
  onkeydown={(e) => {
    if (e.key === 'Escape' && listSheetOpen && !app.pickerOpen) listSheetOpen = false;
  }}
/>

<!-- Declarative rather than an `$effect` writing `document.title`: Svelte
     already owns this element, and the title is a plain function of the state.
     index.html carries a static fallback for the pre-hydration moment. -->
<svelte:head>
  <title>{app.pageTitle}</title>
</svelte:head>

<!-- One slot per pane, and the slot is the grid item. The panes are components
     with scoped styles, so the shell cannot place them directly without
     reaching through `:global` for their class names — which would make every
     rearrangement here depend on a class name three files away. The slot is
     also where `inert` goes: it is a DOM-tree property and grid placement is a
     layout one, and giving each pane its own box lets the two be set
     independently, which is what the narrow case needs. -->
<main
  data-layout={layout}
  data-pane={panes.length > 0 ? activePane : null}
  data-plotted={seriesCount > 0 || null}
  style:height={heightStyle}
>
  {#if sheeted || panes.length > 0}
    <!-- One bar, at whichever edge the arrangement puts it, holding up to two
         things: the button that opens the series sheet, and the switcher for the
         panes that can't be beside each other here. Both are absent in the
         column arrangements, where the list has a column and every pane has a
         cell, so the bar isn't rendered at all.

         One element rather than two grid items because in `narrow-short` both
         are present and both belong at the bottom edge, and two items in one
         grid area stack on top of each other. -->
    <div class="bar" inert={listCovered}>
      {#if sheeted}
        <!-- The series list, demoted to a button that states its count. This is
             the trade the one-column arrangements make: the list is opened once
             a session and the selection is read once per tap, so the selection
             gets a permanent row on screen and the list gets this. See
             layout.ts.

             Full-width where it is alone in the bar, which is a sheet handle and
             is meant to read as one; beside a switcher it shrinks to its
             content. Aria says `expanded`/`controls` rather than `haspopup`: the
             sheet is a region in this document that this button reveals, which
             is what those two describe. -->
        <button
          type="button"
          class="btn list-handle"
          class:sole={panes.length === 0}
          aria-expanded={listSheetOpen}
          aria-controls="series-sheet"
          onclick={() => (listSheetOpen = !listSheetOpen)}
        >
          {#if seriesDots.length > 0}
            <span class="dots" aria-hidden="true">
              {#each seriesDots as color, i (i)}<span class="dot" style:background={color}
                ></span>{/each}
            </span>
          {/if}
          <span class="count">{seriesCount === 0 ? 'No series' : `${seriesCount} series`}</span>
          <ChevronIcon dir={listSheetOpen ? 'down' : 'up'} />
        </button>
      {/if}
      {#if panes.length > 0}
        <!-- Some panes can't be beside each other here, so they take turns and
             this says whose turn it is. A segmented group because it is an
             exclusive choice — the same vocabulary as the graph header's tracks;
             see docs/graphs.md, "The header is two groups". Its contents come
             from `switchedPanes`, which never offers the series list: that is
             the sheet's job now, and the two arrangements that switch anything
             switch exactly the graph and the selection. -->
        <nav class="switcher" aria-label="Pane">
          <div class="btn-group" role="group">
            {#each panes as pane (pane)}
              <button
                type="button"
                class="btn"
                class:btn-selected={activePane === pane}
                aria-pressed={activePane === pane}
                onclick={() => (requestedPane = pane)}
              >
                {PANE_LABELS[pane]}
              </button>
            {/each}
          </div>
        </nav>
      {/if}
    </div>
  {/if}

  <!-- The series list stays live while the panel is open — it's the only place
       the result of an Add or a Remove is visible, and it's the control the
       user will keep using once the panel closes. See docs/design.md, "The
       Add-series panel docks beside the series list". At the one-column widths
       there is no beside, so there it is covered like the rest.

       `data-active` is what every slot uses to say it is on screen, and for this
       one it means two different things by arrangement: a column is always on
       screen, a sheet only while it is open. `onclose` is also what tells the
       list it is a sheet — it renders a close button only when there is
       somewhere for closing to go. -->
  <div
    class="slot slot-list"
    id="series-sheet"
    data-active={(sheeted ? listSheetOpen : true) || null}
    inert={listCovered}
  >
    <SeriesList {app} onclose={sheeted ? () => (listSheetOpen = false) : undefined} />
  </div>
  <div
    class="slot slot-graph"
    data-active={isPaneVisible('graph', activePane, panes) || null}
    inert={app.pickerOpen}
  >
    <GraphPane {app} />
  </div>
  <div
    class="slot slot-details"
    data-active={isPaneVisible('selection', activePane, panes) || null}
    inert={app.pickerOpen}
  >
    <DetailsPane {app} />
  </div>
</main>

{#if app.pickerOpen}
  <!-- Not `aria-modal`, and no click-to-dismiss: with the series list live
       beside it this is a non-modal panel, and a stray click near its edge
       closing it would be a trap rather than an escape hatch. Done, the close
       button and Escape are the ways out. The dim is still here — it's what
       says the graph behind is out of play while the list beside it isn't. -->
  <!-- `data-full` rather than the tier: what decides whether the panel docks past
       the series list or takes the window is whether the list is *there*, which is
       one question (`listIsSheet`) and two tiers. Naming the tiers here would be
       the third place that list has to be kept in step. -->
  <div class="overlay" data-full={sheeted || null} style:height={heightStyle}>
    <div class="overlay-panel" role="dialog" aria-label="Add series">
      <AddSeriesPicker
        onadd={handleAdd}
        onremove={handleRemove}
        onclose={() => app.setPickerOpen(false)}
        initialView={app.pickerView}
        graphContext={app.graphContext}
        plotted={app.plottedColors}
        onviewchange={(v) => app.setPickerView(v)}
      />
    </div>
  </div>
{/if}

<!-- One box for the whole app, positioned from the pointer. Last, and outside
     both the grid and the overlay: it is fixed and above everything, and it must
     not be inside the `inert` wrapper — a tooltip describing the graph behind the
     panel is still worth reading. See docs/design.md, "Tooltips". -->
<Tooltip />

<style>
  main {
    display: grid;
    height: 100vh;
    height: 100dvh;
    /* The notch, the rounded corners and the home indicator. In landscape on a
       phone the plot would otherwise run under the camera housing, and the
       bottom bar under the gesture bar. `env()` resolves to 0 where
       there is no inset and on every browser that doesn't know it, so this costs
       nothing anywhere else — and `border-box` is what keeps the padding inside
       the 100dvh rather than adding to it. */
    box-sizing: border-box;
    padding: env(safe-area-inset-top) env(safe-area-inset-right)
      env(safe-area-inset-bottom) env(safe-area-inset-left);
    overflow: hidden;
    background: var(--bg-canvas);
    color: var(--fg-default);
  }
  /* A grid rather than a block so the pane inside stretches to the slot in both
     axes without the shell naming it. `min-*: 0` because the panes are flex
     columns ending in a scroller, and an `auto` minimum anywhere in that chain
     is what makes a pane size to its content and push the scrollbar off the
     bottom of the window instead of scrolling. */
  .slot {
    display: grid;
    min-width: 0;
    min-height: 0;
  }

  /* Three columns. Fixed side panes, elastic middle: the graph absorbs every
     extra pixel, and the panes must not resize as their content loads. */
  main[data-layout='wide'] {
    grid-template-columns: var(--sidebar-width) minmax(0, 1fr) var(--details-width);
    grid-template-areas: 'list graph details';
  }

  /* Two columns, and the details pane goes under the graph rather than away:
     the graph gains the pane's full 320px of width and pays in height, which is
     the right way round for a time series — it is read across, and the y axis
     is the one that can be squeezed without losing a date.

     The details row is *reserved*, not grown into. Sizing it to its content
     would move the graph under the pointer on the click that fills it, which is
     the thing this app doesn't do (docs/design.md, "Layout stability"); and it
     is the same bargain the wide layout already strikes, where an empty pane
     holds 320px of width open all day. */
  main[data-layout='medium'] {
    grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) min(40%, 320px);
    grid-template-areas:
      'list graph'
      'list details';
  }

  /* Two columns, and the window has no height to stack in: the details pane
     stops being a row and takes turns with the graph in the second column
     instead. The series list is a column exactly as it is in `medium` — width is
     not what is short here — so it is *not* one of the panes taking turns, and
     the switcher sits over the column that is. A landscape phone, or a window
     dragged down to a strip. */
  main[data-layout='short'] {
    grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    grid-template-areas:
      'list bar'
      'list pane';
  }

  /* One column, and it strikes `medium`'s bargain rather than switching: the
     graph over a details row, both on screen, and the series list demoted to a
     sheet behind the bar's button. A phone in portrait.

     This used to be three panes taking turns, which charged the same tap for
     "what did I just select" and "what is plotted" — and made the first one cost
     a round trip on every point the reader looked at.

     The row takes 45% where there is 45% to spare and *everything above the
     graph's floor* where there isn't — `100% - 382px`, being the graph's
     collapsed-header minimum plus the bar. Not `medium`'s fixed 320px cap: a cap
     protects the graph on a tall window and does nothing on a short one, and it is
     the short one that needs protecting here. Both numbers are mirrored in
     layout.ts (`NARROW_DETAILS_ROW_FRACTION`, `NARROW_GRAPH_RESERVE`), which
     computes this tier's threshold from them; a copy that drifts is a threshold
     that has stopped meaning what it says.

     The bar is at the *bottom* in both one-column arrangements, and this is the
     only place in the app that it is. It is the app's primary navigation on the
     device least able to reach the top of its own screen, and a bar along the
     bottom edge is where every phone platform puts one. `short` keeps it on top,
     because there it spans one column of a landscape window rather than the
     window, and nothing about that reach is hard. */
  main[data-layout='narrow'] {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) min(45%, calc(100% - 382px)) auto;
    grid-template-areas:
      'graph'
      'details'
      'bar';
  }
  /* With nothing plotted the details row would be a second empty state under the
     graph's own — "tap a point in the graph" in 360px, below "Nothing plotted
     yet" in 440. So it goes, and the graph takes the window: the same reasoning
     that makes the graph pane a call to action rather than a pair of empty axes
     (graphs.md, "With nothing plotted, the pane is a call to action").

     **This is a layout change that reserving space is supposed to prevent, and
     it is allowed because of where the user is when it happens.** Every path
     between nothing plotted and something plotted runs through the Add-series
     panel or the series sheet, and at this width both of those cover the whole
     window — so the row appears and disappears behind something opaque, never
     under a thumb that was about to tap a point. The bar stays either way, which
     is what keeps the one piece of chrome that is always tappable from moving. */
  main[data-layout='narrow']:not([data-plotted]) {
    grid-template-rows: minmax(0, 1fr) auto;
    grid-template-areas:
      'graph'
      'bar';
  }
  main[data-layout='narrow']:not([data-plotted]) > .slot-details {
    display: none;
  }

  /* One column with no height to stack in: the graph and the details pane go back
     to taking turns, which makes this the only arrangement left that switches
     anything at one column. A window dragged small in both axes, and a phone with
     the keyboard up. The list is a sheet here too — a window this size has even
     less to spare for a pane read once a session — so the bar holds both its
     button and the switcher. */
  main[data-layout='narrow-short'] {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
    grid-template-areas:
      'pane'
      'bar';
  }
  main[data-layout='narrow'] > .bar,
  main[data-layout='narrow-short'] > .bar {
    border-top: 1px solid var(--border-default);
    border-bottom: 0;
  }
  main[data-layout='short'] > .slot-graph,
  main[data-layout='short'] > .slot-details,
  main[data-layout='narrow-short'] > .slot-graph,
  main[data-layout='narrow-short'] > .slot-details {
    grid-area: pane;
  }
  /* The sheet: the list over every row of the grid, and over the bar that opened
     it. It carries its own background because it is the only slot that has
     something behind it, and its own `border-right` would be an edge against the
     window. */
  main[data-layout='narrow'] > .slot-list,
  main[data-layout='narrow-short'] > .slot-list {
    grid-column: 1;
    grid-row: 1 / -1;
    z-index: 5;
    background: var(--bg-canvas);
  }
  /* One rule for every arrangement where a slot can be off screen, and it reads
     the slot's own attribute rather than naming panes: what puts a slot off
     screen differs between them — a turn in the switcher for the graph and the
     details pane, a closed sheet for the list — and `data-active` is where the
     shell has already resolved that difference.

     The inactive slots are taken out with `display: none` rather than
     `visibility` or a `hidden` attribute, because it is also what takes them out
     of the tab order and the accessibility tree, and the bar is the only honest
     way to reach them. The charts come back correctly sized: ScatterChart
     observes its wrapper, so 0×0 and back is a resize like any other. */
  main[data-layout='short'] > .slot:not([data-active]),
  main[data-layout='narrow'] > .slot:not([data-active]),
  main[data-layout='narrow-short'] > .slot:not([data-active]) {
    display: none;
  }

  .slot-list {
    grid-area: list;
  }
  .slot-graph {
    grid-area: graph;
  }
  .slot-details {
    grid-area: details;
  }

  /* The seams. They live here, on the slots, rather than on the panes, because
     which of a pane's sides faces another pane is a fact about the arrangement
     and the arrangement changes: the details pane drew its own `border-left`
     until it moved under the graph, where that edge lands against the series
     list's `border-right` and the two render as one 2px rule. A pane cannot
     know that; the shell is the only thing that does. Exactly one rule per
     seam, on the slot above or to the left of it. */
  main[data-layout='wide'] > .slot-list,
  main[data-layout='medium'] > .slot-list,
  main[data-layout='short'] > .slot-list {
    border-right: 1px solid var(--border-default);
  }
  main[data-layout='wide'] > .slot-details {
    border-left: 1px solid var(--border-default);
  }
  main[data-layout='medium'] > .slot-details,
  main[data-layout='narrow'] > .slot-details {
    border-top: 1px solid var(--border-default);
  }
  /* `narrow-short` draws none: one pane fills the column above the bar, so every
     edge it has is the window's own or the bar's. */

  /* The bar. One box at whichever edge the arrangement puts it, holding the
     series button, the switcher, or both. */
  .bar {
    grid-area: bar;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border-default);
    background: var(--bg-subtle);
  }
  .switcher {
    display: flex;
    flex: 1;
    min-width: 0;
  }
  /* One track across whatever the switcher spans — the rest of the bar in
     `narrow-short`, the graph's column in `short` — with equal segments, so the
     labels don't move as the selected one takes its fill and the targets are as
     big as the width allows. These are the arrangements most likely to be driven
     by a thumb. */
  .switcher .btn-group {
    display: flex;
    flex: 1;
  }
  .switcher .btn {
    flex: 1;
  }

  /* The series sheet's handle. `.btn` for the chrome, plus the three things it
     owns: a row of color dots, the count, and a chevron that points the way the
     sheet moves. It is `.sole` when the bar holds nothing else, where it spans
     the bar and reads as the handle it is; beside a switcher it shrinks to its
     content and the switcher takes the rest. */
  .list-handle {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .list-handle.sole {
    flex: 1;
    /* The chevron to the far edge, the count beside its dots. A handle spanning
       the window with everything bunched at the left reads as a button that
       happens to be wide. */
    justify-content: flex-start;
  }
  .list-handle.sole .count {
    margin-right: auto;
  }
  .list-handle .count {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dots {
    display: flex;
    /* Overlapped rather than spaced: four dots in a row is a legend, four dots
       stacked like coins is one mark that happens to carry four colors — which is
       what this is, the count beside it being the real answer. */
    margin-right: -3px;
  }
  .dot {
    width: 10px;
    height: 10px;
    margin-right: -3px;
    border-radius: 50%;
    /* Against the bar, so overlapping dots stay countable whichever colors land
       next to each other. */
    box-shadow: 0 0 0 1.5px var(--bg-subtle);
  }
  /* The full 44px on a coarse pointer, rather than app.css's 32px floor: these are
     the app's primary navigation, and the controls most often driven by a thumb at
     the far end of its reach. */
  @media (pointer: coarse) {
    .switcher .btn,
    .list-handle {
      min-height: 44px;
    }
  }
  /* Starts where the series list ends, so the list is neither dimmed nor
     covered. The panel is stretched to exactly the space between the
     backdrop's padding edges — never taller. Everything inside it (see the
     flex chain down to the picker's .table-wrap) shares that fixed budget, so
     the only scrollable element in the panel is the series table itself.
     Nothing here may grow with content, or the overlay starts scrolling as a
     whole and the sticky table header scrolls out of view with it. */
  .overlay {
    position: fixed;
    /* `bottom: auto` and a height, rather than pinning both edges: the height is
       what `appHeight` overrides inline when a keyboard has taken the bottom of
       the window, and an over-constrained box (top + bottom + height) resolves by
       silently dropping one of them. Say which. */
    inset: 0 0 auto var(--sidebar-width);
    height: 100dvh;
    /* Docking to the right of the list only means something while the list is
       a column. At the one-column widths it is a sheet, so the panel takes the
       window — which is what it was before it learned to dock, and the reason
       the list's slot goes `inert` at those widths with it. */
    background: var(--backdrop);
    display: flex;
    align-items: stretch;
    /* Left, not centered: docked against the list it reports into. On a
       display wide enough for the 1400px cap to bite, what's left over is
       graph — dimmed, but visible, and better company than empty backdrop. */
    justify-content: flex-start;
    padding: 16px;
    z-index: 10;
  }
  .overlay[data-full] {
    inset: 0 0 auto 0;
    padding: 0;
  }
  .overlay[data-full] .overlay-panel {
    border-radius: 0;
  }
  .overlay-panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    background: var(--bg-canvas);
    border-radius: 8px;
    box-shadow: var(--shadow-overlay);
    width: min(1400px, 100%);
  }
</style>
