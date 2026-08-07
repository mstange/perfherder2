<script lang="ts">
  // Three-pane shell: series list, graphs, selection details. The Add-series
  // picker opens as an overlay over the lot — it needs the full width for its
  // table, and mounting it lazily keeps its multi-megabyte signature fetch off
  // the critical path for someone opening a shared graph link.

  import AddSeriesPicker from './lib/picker/AddSeriesPicker.svelte';
  import DetailsPane from './lib/graphs/DetailsPane.svelte';
  import GraphPane from './lib/graphs/GraphPane.svelte';
  import SeriesList from './lib/graphs/SeriesList.svelte';
  import { AppState } from './lib/graphs/appState.svelte';
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

<main>
  <!-- The series list stays live while the panel is open — it's the only place
       the result of an Add or a Remove is visible, and it's the control the
       user will keep using once the panel closes. See docs/design.md, "The
       Add-series panel docks beside the series list".

       The two panes the panel *does* cover are inert instead, or Tab would
       wander into invisible controls behind it. `display: contents` on the
       wrapper because `inert` is a DOM-tree property while grid placement is a
       layout one: the panes stay direct children of the grid, so nothing about
       the three-column layout changes. -->
  <SeriesList {app} />
  <div class="covered" inert={app.pickerOpen}>
    <GraphPane {app} />
    <DetailsPane {app} />
  </div>
</main>

{#if app.pickerOpen}
  <!-- Not `aria-modal`, and no click-to-dismiss: with the series list live
       beside it this is a non-modal panel, and a stray click near its edge
       closing it would be a trap rather than an escape hatch. Done, the close
       button and Escape are the ways out. The dim is still here — it's what
       says the graph behind is out of play while the list beside it isn't. -->
  <div class="overlay">
    <div class="overlay-panel" role="dialog" aria-label="Add series">
      <AddSeriesPicker
        onadd={handleAdd}
        onremove={handleRemove}
        onclose={() => app.setPickerOpen(false)}
        initialView={app.pickerView}
        plotted={app.plottedColors}
        onviewchange={(v) => app.setPickerView(v)}
      />
    </div>
  </div>
{/if}

<style>
  main {
    display: grid;
    /* Fixed side panes, elastic middle: the graph should absorb every extra
       pixel, and the panes must not resize as their content loads. */
    grid-template-columns: var(--sidebar-width) minmax(0, 1fr) 320px;
    height: 100vh;
    height: 100dvh;
    overflow: hidden;
    background: var(--bg-canvas);
    color: var(--fg-default);
  }
  /* Layout-transparent: its children are the grid items, not it. See the
     markup for why it exists at all. */
  .covered {
    display: contents;
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
