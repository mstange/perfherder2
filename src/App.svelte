<script lang="ts">
  import AddSeriesPicker from './lib/AddSeriesPicker.svelte';
  import type { Series } from './lib/api';

  let added = $state<Series[]>([]);

  function handleAdd(series: Series[]) {
    added = series;
    // eslint-disable-next-line no-console
    console.log('Added series:', series);
  }
</script>

<main>
  <AddSeriesPicker onadd={handleAdd} />

  {#if added.length > 0}
    <section class="added">
      <h3>{added.length} series would be added to the graph</h3>
      <ul>
        {#each added as s}
          <li>
            <code>{s.repository}</code> / <code>{s.framework}</code> —
            <strong>{s.suite}</strong>
            {#if s.test}<span> · {s.test}</span>{/if}
            <span class="muted"> · {s.platform}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</main>

<style>
  main {
    min-height: 100vh;
    background: #fff;
    color: #1f2328;
  }
  .added {
    max-width: 1400px;
    margin: 0 auto;
    padding: 16px;
    border-top: 1px solid #d0d7de;
    font: 14px/1.4 system-ui, sans-serif;
  }
  .added h3 {
    margin: 0 0 8px;
  }
  .added code {
    background: #f6f8fa;
    padding: 1px 4px;
    border-radius: 3px;
    font-size: 12px;
  }
  .muted {
    color: #57606a;
  }
</style>
