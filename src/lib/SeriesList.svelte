<script lang="ts">
  // Left pane: the plotted series, in the order that decides their colors.

  import type { AppState } from './appState.svelte';
  import { seriesLabel } from './graphData';

  type Props = { app: AppState };
  let { app }: Props = $props();
</script>

<aside class="series-list">
  <header>
    <h2>Series</h2>
    <button type="button" class="primary" onclick={() => app.setPickerOpen(true)}>
      Add series…
    </button>
  </header>

  <div class="list" role="list">
    {#if app.series.length === 0}
      <p class="empty">
        No series yet. Use <strong>Add series…</strong> to pick tests to plot.
      </p>
    {/if}
    {#each app.series as entry, i (entry.key)}
      <div class="card" role="listitem">
        <span class="swatch" style:background={entry.color} aria-hidden="true"></span>
        <div class="text">
          <div class="title" title={entry.meta?.name ?? ''}>
            {entry.meta ? seriesLabel(entry.meta) : `signature ${entry.ref.signatureId}`}
          </div>
          <div class="sub-line">
            {entry.meta?.platform ?? ''}{#if entry.meta?.application}{' · '}{entry.meta
                .application}{/if}
          </div>
          {#if entry.meta?.options}
            <div class="sub-line options">{entry.meta.options}</div>
          {/if}
          <div class="sub">
            <span class="repo">{entry.ref.repository}</span>
            <span class="count">
              {#if entry.loading}
                loading…
              {:else if entry.error}
                <span class="error" title={entry.error}>failed</span>
              {:else}
                {entry.data.points.length.toLocaleString()} points
              {/if}
            </span>
          </div>
        </div>
        <div class="actions">
          <button
            type="button"
            class="icon"
            title="Move up"
            aria-label="Move series up"
            disabled={i === 0}
            onclick={() => app.moveSeries(i, -1)}>↑</button
          >
          <button
            type="button"
            class="icon"
            title="Move down"
            aria-label="Move series down"
            disabled={i === app.series.length - 1}
            onclick={() => app.moveSeries(i, 1)}>↓</button
          >
          <button
            type="button"
            class="icon remove"
            title="Remove series"
            aria-label="Remove series"
            onclick={() => app.removeSeries(entry.ref)}>×</button
          >
        </div>
      </div>
    {/each}
  </div>

  {#if app.series.length > 0}
    <footer>
      <button type="button" onclick={() => app.clearSeries()}>Remove all</button>
    </footer>
  {/if}
</aside>

<style>
  .series-list {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-right: 1px solid #d0d7de;
    background: #f6f8fa;
    font: 13px/1.4 system-ui, sans-serif;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid #d0d7de;
  }
  h2 {
    margin: 0;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #57606a;
  }
  .list {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .empty {
    margin: 4px;
    color: #57606a;
  }
  .card {
    display: grid;
    grid-template-columns: 10px 1fr auto;
    gap: 8px;
    align-items: start;
    padding: 8px;
    background: #fff;
    border: 1px solid #d0d7de;
    border-radius: 6px;
  }
  .swatch {
    width: 10px;
    height: 10px;
    margin-top: 3px;
    border-radius: 2px;
  }
  .text {
    min-width: 0;
  }
  .title {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .sub {
    display: flex;
    justify-content: space-between;
    gap: 6px;
    color: #57606a;
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .sub-line {
    color: #57606a;
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .options {
    color: #8c959f;
  }
  .repo {
    font-family: ui-monospace, monospace;
  }
  .count {
    white-space: nowrap;
  }
  .error {
    color: #cf222e;
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  footer {
    padding: 8px 12px;
    border-top: 1px solid #d0d7de;
  }
  button {
    font: inherit;
    padding: 4px 10px;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    background: #fff;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: #f3f4f6;
  }
  button:disabled {
    opacity: 0.4;
    cursor: default;
  }
  button.primary {
    background: #0969da;
    border-color: #0969da;
    color: #fff;
  }
  button.primary:hover {
    background: #0860c4;
  }
  button.icon {
    padding: 0;
    width: 20px;
    height: 18px;
    line-height: 1;
    font-size: 12px;
  }
  button.remove:hover:not(:disabled) {
    background: #ffebe9;
    border-color: #cf222e;
    color: #cf222e;
  }
</style>
