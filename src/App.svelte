<script lang="ts">
  // Three-pane shell: series list, graphs, selection details. The Add-series
  // picker opens as an overlay over the lot — it needs the full width for its
  // table, and mounting it lazily keeps its multi-megabyte signature fetch off
  // the critical path for someone opening a shared graph link.

  import AddSeriesPicker from './lib/AddSeriesPicker.svelte';
  import DetailsPane from './lib/DetailsPane.svelte';
  import GraphPane from './lib/GraphPane.svelte';
  import SeriesList from './lib/SeriesList.svelte';
  import { AppState } from './lib/appState.svelte';
  import type { Series } from './lib/api';

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
        onclose={() => app.setPickerOpen(false)}
        initialFilter={app.pickerFilter}
        initialRepos={app.pickerRepos}
        plotted={app.plottedColors}
        onfilterchange={(f) => app.setPickerFilter(f)}
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
    background: #fff;
    color: #1f2328;
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
    background: rgba(31, 35, 40, 0.35);
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
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 12px 40px rgba(31, 35, 40, 0.3);
    width: min(1400px, 100%);
  }
</style>
