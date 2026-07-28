<script lang="ts">
  // Left pane: the plotted series, in the order that decides their colors.
  //
  // A card doesn't spell its series out in full. Whatever every series has in
  // common is hoisted into one header above the list, and each card carries
  // only its own distinguishing attributes — see seriesSummary.ts for why.

  import type { AppState } from './appState.svelte';
  import {
    attrChips,
    attrsForEntry,
    isEmptyAttrs,
    splitCommonAttrs,
    type AttrChip,
    type SeriesAttrs,
  } from './seriesSummary';

  type Props = { app: AppState };
  let { app }: Props = $props();

  // Null for a series we have no real metadata for; `splitCommonAttrs` leaves
  // those out of the intersection rather than letting them collapse it.
  const attrs = $derived(app.series.map((e) => attrsForEntry(e.ref, e.meta)));
  const split = $derived(splitCommonAttrs(attrs));
  const commonChips = $derived(attrChips(split.common));

  // A card shows only the differences, so its hover text spells the series out
  // in full.
  function fullText(a: SeriesAttrs | null): string {
    return a
      ? attrChips(a)
          .map((c) => c.value)
          .join(' · ')
      : '';
  }

  // Drag-to-reorder. Only the handle is `draggable`, so the card's text stays
  // selectable — browsers disable selection inside a draggable element. The
  // ↑/↓ buttons remain the keyboard-reachable equivalent.
  let dragFrom = $state<number | null>(null);
  let dragOver = $state<number | null>(null);

  function onDragStart(e: DragEvent, index: number): void {
    dragFrom = index;
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = 'move';
    // Firefox won't start a drag without data on the transfer.
    e.dataTransfer.setData('text/plain', String(index));
    // Drag the whole card, not the four-pixel handle the pointer is on.
    const card = (e.currentTarget as HTMLElement).closest('.card');
    if (card) e.dataTransfer.setDragImage(card, 20, 20);
  }

  function onDrop(index: number): void {
    if (dragFrom !== null) app.reorderSeries(dragFrom, index);
    dragFrom = null;
    dragOver = null;
  }
</script>

<!-- Shared by the header and the cards, so both read the same way: attributes
     separated by "·", repository in monospace. The explicit `{' '}` is
     load-bearing — Svelte strips whitespace between adjacent elements, and
     without it a copy-paste comes out as "chrome·opt". -->
{#snippet chipRow(chips: AttrChip[])}{#each chips as chip, i}{#if i > 0}<span class="sep"
      >·</span
    >{' '}{/if}<span class="attr {chip.field}">{chip.value}</span>{' '}{/each}{/snippet}

<aside class="series-list">
  <header>
    <h2>Series</h2>
    <button type="button" class="primary" onclick={() => app.setPickerOpen(true)}>
      Add series…
    </button>
  </header>

  {#if split.hasCommon}
    <!-- Outside the scroller: with the differences reduced to a word or two,
         the cards are unreadable without this, so it must not scroll away. -->
    <div class="common">
      <h3>All series share</h3>
      <div class="attrs">{@render chipRow(commonChips)}</div>
    </div>
  {/if}

  <div class="list" role="list">
    {#if app.series.length === 0}
      <p class="empty">
        No series yet. Use <strong>Add series…</strong> to pick tests to plot.
      </p>
    {/if}
    {#each app.series as entry, i (entry.key)}
      {@const own = split.distinct[i]}
      <div
        class="card"
        class:hidden-series={!entry.visible}
        class:dragging={dragFrom === i}
        class:drag-over={dragOver === i && dragFrom !== null && dragFrom !== i}
        role="listitem"
        ondragover={(e) => {
          if (dragFrom === null) return;
          e.preventDefault();
          dragOver = i;
        }}
        ondragleave={() => {
          if (dragOver === i) dragOver = null;
        }}
        ondrop={(e) => {
          e.preventDefault();
          onDrop(i);
        }}
      >
        <!-- The swatch doubles as the show/hide control: it's the thing that
             ties the card to the graph, so it's where you look to ask "is
             this one on?". -->
        <button
          type="button"
          class="swatch"
          class:off={!entry.visible}
          style:--series-color={entry.color}
          aria-pressed={entry.visible}
          title={entry.visible ? 'Hide this series' : 'Show this series'}
          aria-label={entry.visible ? 'Hide this series' : 'Show this series'}
          onclick={() => app.toggleSeriesVisibility(entry.ref)}
        ></button>
        <div class="text">
          <div class="attrs" title={fullText(attrs[i])}>
            {#if own && !isEmptyAttrs(own)}
              {@render chipRow(attrChips(own))}
            {:else}
              <!-- Either the metadata hasn't landed, or two series are
                   identical in every attribute we display (rare, but the card
                   still has to say which one it is). -->
              <span class="pending">signature {entry.ref.signatureId}</span>
            {/if}
          </div>
          <div class="sub">
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
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <span
            class="handle"
            draggable="true"
            title="Drag to reorder"
            aria-hidden="true"
            ondragstart={(e) => onDragStart(e, i)}
            ondragend={() => {
              dragFrom = null;
              dragOver = null;
            }}>⠿</span
          >
          <button
            type="button"
            class="icon up"
            title="Move up"
            aria-label="Move series up"
            disabled={i === 0}
            onclick={() => app.moveSeries(i, -1)}>↑</button
          >
          <button
            type="button"
            class="icon down"
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
  .common {
    padding: 8px 12px;
    border-bottom: 1px solid #d0d7de;
    background: #eef1f4;
  }
  .common h3 {
    margin: 0 0 2px;
    font-size: 11px;
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #8c959f;
  }
  /* Background information: the cards are what the eye should land on. */
  .common .attrs {
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
    grid-template-columns: 12px 1fr auto;
    gap: 8px;
    align-items: start;
    padding: 8px;
    background: #fff;
    border: 1px solid #d0d7de;
    border-radius: 6px;
  }
  .swatch {
    width: 12px;
    height: 12px;
    margin-top: 2px;
    padding: 0;
    border: 1px solid var(--series-color);
    border-radius: 3px;
    background: var(--series-color);
    cursor: pointer;
  }
  .swatch.off {
    /* Hollow, not grey: the color still identifies the series, the fill says
       whether it's being drawn. */
    background: transparent;
  }
  .card.hidden-series .text {
    opacity: 0.55;
  }
  .card.dragging {
    opacity: 0.4;
  }
  .card.drag-over {
    /* An inset outline rather than a border: a border would change the card's
       height and shuffle every card below it mid-drag. */
    outline: 2px solid #0969da;
    outline-offset: -2px;
  }
  .handle {
    display: block;
    width: 20px;
    text-align: center;
    color: #8c959f;
    cursor: grab;
    user-select: none;
    line-height: 1.2;
  }
  .handle:active {
    cursor: grabbing;
  }
  .text {
    min-width: 0;
  }
  .attrs {
    overflow-wrap: anywhere;
  }
  /* The suite and the test are the closest thing a series has to a name, so
     they carry the title weight wherever they end up — which, once the shared
     attributes are hoisted out, is usually the header rather than a card. */
  .attr.suite,
  .attr.test {
    font-weight: 600;
  }
  .attr.repo {
    font-family: ui-monospace, monospace;
    font-size: 12px;
  }
  .sep {
    color: #8c959f;
  }
  .pending {
    color: #57606a;
  }
  .sub {
    color: #57606a;
    font-size: 12px;
  }
  .count {
    /* Reserved width: "loading…" becoming "12,345 points" must not reflow
       the card. */
    display: inline-block;
    min-width: 8.5ch;
    white-space: nowrap;
  }
  .error {
    color: #cf222e;
  }
  /* Two by two rather than a single column: with the shared attributes hoisted
     out, a card's text is often one line, and a four-high stack of controls
     would set the card height all by itself. Placement is explicit so the DOM
     order stays reorder-then-remove for the keyboard. */
  .actions {
    display: grid;
    grid-template-areas:
      'handle remove'
      'up down';
    gap: 2px;
    align-content: start;
  }
  .actions .handle {
    grid-area: handle;
  }
  .actions .up {
    grid-area: up;
  }
  .actions .down {
    grid-area: down;
  }
  .actions .remove {
    grid-area: remove;
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
