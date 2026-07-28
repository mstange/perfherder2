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
</script>

<svelte:window onpopstate={() => app.onPopState(location.search)} />

<main>
  <SeriesList {app} />
  <GraphPane {app} />
  <DetailsPane {app} />
</main>

{#if app.pickerOpen}
  <div class="overlay" role="dialog" aria-modal="true" aria-label="Add series">
    <div class="overlay-panel">
      <AddSeriesPicker
        onadd={handleAdd}
        onclose={() => app.setPickerOpen(false)}
        initialFilter={app.pickerFilter}
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
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(31, 35, 40, 0.35);
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: 24px;
    overflow: auto;
    z-index: 10;
  }
  .overlay-panel {
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 12px 40px rgba(31, 35, 40, 0.3);
    width: min(1400px, 100%);
  }
</style>
