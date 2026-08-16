<script lang="ts">
  // Three-pane shell: series list, graphs, selection details. The Add-series
  // picker opens as an overlay over the lot — it needs the full width for its
  // table, and mounting it lazily keeps its multi-megabyte signature fetch off
  // the critical path for someone opening a shared graph link.

  import AddSeriesPicker from './lib/picker/AddSeriesPicker.svelte';
  import DetailsPane from './lib/graphs/DetailsPane.svelte';
  import GraphPane from './lib/graphs/GraphPane.svelte';
  import SeriesList from './lib/graphs/SeriesList.svelte';
  import Tooltip from './lib/shared/Tooltip.svelte';
  import { AppState } from './lib/graphs/appState.svelte';
  import {
    PANE_LABELS,
    isPaneVisible,
    layoutFor,
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

  // The panes sharing one cell in this arrangement, and which of them has it.
  // Deliberately not in the URL — it answers "what am I looking at on this
  // screen", not "what am I looking at", and a shared link that forced a
  // companion onto the Series tab because the sender was on a phone would be a
  // bug.
  const panes = $derived(switchedPanes(layout));
  let requestedPane = $state<Pane>('graph');
  const activePane = $derived(resolvePane(requestedPane, !!app.selectedPoint, panes));

  // A click on the graph *is* a request to see the selection, and where the
  // selection is switched it is a pane the user would otherwise have to go and
  // find. Only on a change of point, so that zooming, hiding a series or
  // toggling a switch — all of which touch the selection without being about it
  // — leave the user where they are.
  let lastSelected: unknown = app.selectedPoint;
  $effect(() => {
    const selected = app.selectedPoint;
    if (selected !== lastSelected) {
      lastSelected = selected;
      if (selected && panes.includes('selection')) requestedPane = 'selection';
    }
  });

  // The panel covers the graph and the details pane in every arrangement. It
  // covers the series list only when the list isn't beside it — which is the
  // narrow case, where the panel has the whole window. See docs/design.md,
  // "The Add-series panel docks beside the series list".
  const listCovered = $derived(app.pickerOpen && layout === 'narrow');

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

<svelte:window onpopstate={() => app.onPopState(location.search)} />

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
<main data-layout={layout} data-pane={panes.length > 0 ? activePane : null}>
  {#if panes.length > 0}
    <!-- Some panes can't be beside each other here, so they take turns and this
         says whose turn it is. A segmented group because it is an exclusive
         choice — the same vocabulary as the graph header's tracks; see
         docs/graphs.md, "The header is two groups". Its existence and its
         contents both come from `switchedPanes`: at the arrangements where every
         pane has a cell of its own it would be three buttons that do nothing,
         and in `short` the series list is still a column, so it must not be
         offered as a choice. -->
    <nav class="switcher" inert={listCovered} aria-label="Pane">
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

  <!-- The series list stays live while the panel is open — it's the only place
       the result of an Add or a Remove is visible, and it's the control the
       user will keep using once the panel closes. See docs/design.md, "The
       Add-series panel docks beside the series list". At narrow widths there is
       no beside, so there it is covered like the rest. -->
  <div
    class="slot slot-list"
    data-active={isPaneVisible('series', activePane, panes) || null}
    inert={listCovered}
  >
    <SeriesList {app} />
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
  <div class="overlay" data-layout={layout}>
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
      'list switch'
      'list pane';
  }

  /* One pane at a time. All three slots share the cell and the inactive two are
     taken out — `display: none` rather than `visibility` or a `hidden`
     attribute, because it is also what takes them out of the tab order and the
     accessibility tree, and the switcher is the only honest way to reach them.
     The charts come back correctly sized: ScatterChart observes its wrapper, so
     0×0 and back is a resize like any other. */
  main[data-layout='narrow'] {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(0, 1fr);
    grid-template-areas:
      'switch'
      'pane';
  }
  main[data-layout='narrow'] > .slot {
    grid-area: pane;
  }
  main[data-layout='short'] > .slot-graph,
  main[data-layout='short'] > .slot-details {
    grid-area: pane;
  }
  /* One rule for both arrangements that switch, and it reads the slot's own
     attribute rather than naming panes: which slots are sharing a cell is
     `switchedPanes`' answer, and it differs between the two. */
  main[data-layout='short'] > .slot:not([data-active]),
  main[data-layout='narrow'] > .slot:not([data-active]) {
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
  main[data-layout='medium'] > .slot-details {
    border-top: 1px solid var(--border-default);
  }
  /* Narrow draws none: one pane fills the window, so every edge it has is the
     window's own. */

  .switcher {
    grid-area: switch;
    display: flex;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border-default);
    background: var(--bg-subtle);
  }
  /* One track across whatever the switcher spans — the window in `narrow`, the
     graph's column in `short` — with equal segments, so the labels don't move as
     the selected one takes its fill and the targets are as big as the width
     allows. These are the arrangements most likely to be driven by a thumb. */
  .switcher .btn-group {
    display: flex;
    flex: 1;
  }
  .switcher .btn {
    flex: 1;
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
    inset: 0 0 0 var(--sidebar-width);
    /* Docking to the right of the list only means something while the list is
       a column. At narrow widths it is one pane of three, so the panel takes
       the window — which is what it was before it learned to dock, and the
       reason the list's slot goes `inert` at this width with it. */
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
  .overlay[data-layout='narrow'] {
    inset: 0;
    padding: 0;
  }
  .overlay[data-layout='narrow'] .overlay-panel {
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
