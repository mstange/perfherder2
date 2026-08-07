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

  function handleAdd(series: Series[]) {
    app.addSeries(
      series.map((s) => ({
        repository: s.repository,
        signatureId: s.id,
        frameworkId: s.frameworkId,
      })),
    );
    app.setPickerOpen(false);
  }

  // Takes effect straight away and leaves the panel open — unlike adding,
  // which stages behind the picker's footer button. There is nowhere to stage
  // a removal to: a row whose Remove is pending would have to render as
  // neither on nor off the graph. Leaving the panel open matters because the
  // graph behind it is covered, so closing on remove would look like the
  // dialog had crashed rather than like something had been taken off.
  function handleRemove(series: Series) {
    app.removeSeries({
      repository: series.repository,
      signatureId: series.id,
      frameworkId: series.frameworkId,
    });
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

<!-- `inert` while the panel is open: real modality, so Tab can't wander into
     the graphs behind the overlay. -->
<main inert={app.pickerOpen}>
  <SeriesList {app} />
  <GraphPane {app} />
  <DetailsPane {app} />
</main>

{#if app.pickerOpen}
  <!-- Backdrop. Clicking it dismisses; Escape is handled inside the picker.
       svelte-ignore is deliberate: this is a click target of last resort, not
       a control — everything it does is also reachable from the close button
       and the Escape key. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="overlay"
    onclick={(e) => {
      if (e.target === e.currentTarget) app.setPickerOpen(false);
    }}
  >
    <div class="overlay-panel" role="dialog" aria-modal="true" aria-label="Add series">
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
    grid-template-columns: 280px minmax(0, 1fr) 320px;
    height: 100vh;
    height: 100dvh;
    overflow: hidden;
    background: var(--bg-canvas);
    color: var(--fg-default);
  }
  /* The panel is stretched to exactly the space between the backdrop's
     padding edges — never taller. Everything inside it (see the flex chain
     down to the picker's .table-wrap) shares that fixed budget, so the only
     scrollable element in the dialog is the series table itself. Nothing
     here may grow with content, or the overlay starts scrolling as a whole
     and the sticky table header scrolls out of view with it. */
  .overlay {
    position: fixed;
    inset: 0;
    background: var(--backdrop);
    display: flex;
    align-items: stretch;
    justify-content: center;
    padding: 24px;
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
