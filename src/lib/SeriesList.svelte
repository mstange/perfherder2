<script lang="ts">
  // Left pane: the plotted series, in the order that decides their colors.
  //
  // A card doesn't spell its series out in full. Whatever every series has in
  // common is hoisted into one header above the list, and each card carries
  // only its own distinguishing attributes — see seriesSummary.ts for why.

  import { flip } from 'svelte/animate';
  import type { AppState } from './appState.svelte';
  import {
    autoScrollDelta,
    clampDy,
    dragGeometry,
    dragOffsets,
    dropIndex,
    type CardBox,
    type DragGeometry,
  } from './reorder';
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

  // Drag-to-reorder, on pointer events rather than HTML5 drag-and-drop.
  //
  // The reason for pointer events is the interaction itself: `dragover` fires
  // on the element under the cursor, not continuously, so the best it
  // supports is "highlight the card you're over". With pointer capture we get every
  // position, which is what lets the other cards step aside as the pointer
  // travels. Two things fall out of it for free: no `draggable` attribute
  // anywhere, so text stays selectable everywhere in the card; and touch and
  // pen work, which HTML5 drag never did on mobile.
  //
  // Nothing in the app's state moves until the pointer is released — the drag
  // is purely visual. On release, `reorderSeries` runs and `animate:flip`
  // interpolates each card from wherever it visually was to its new layout
  // slot, so committing the order doesn't jump. The ↑/↓ buttons remain the
  // keyboard-reachable equivalent.
  const FLIP_MS = 160;
  // Auto-scroll geometry, in px. Deliberately gentle: this fires every frame.
  const SCROLL_EDGE = 32;
  const SCROLL_MAX = 12;

  type Drag = { from: number; to: number; offsets: number[] };
  let drag = $state<Drag | null>(null);

  // Measured once per drag. Not `$state`: only `drag` drives rendering.
  let listEl!: HTMLElement;
  let geom: DragGeometry = { from: -1, slots: [], displacement: 0 };
  // The pointer that owns the drag. A second finger landing on another card's
  // handle must not end this one.
  let dragPointer = -1;
  let startY = 0;
  let pointerY = 0;
  let scrollRaf = 0;
  // The scroll range as it was before anything was lifted. A translated card
  // counts towards its scroller's overflow, so the lifted card *grows*
  // `scrollHeight` as it travels — auto-scrolling against a live measurement
  // chases its own tail and runs off the end of the list into empty space.
  let maxScroll = 0;

  // Pointer position in the scroller's content coordinates, so auto-scrolling
  // mid-drag moves the pointer through the content rather than invalidating
  // every measurement.
  function contentY(clientY: number): number {
    return clientY - listEl.getBoundingClientRect().top + listEl.scrollTop;
  }

  function onPointerDown(e: PointerEvent, index: number): void {
    // Left button / touch / pen only, and never while a previous drag is still
    // committing — that would measure a layout that is about to change.
    if (e.button !== 0 || drag) return;
    const listTop = listEl.getBoundingClientRect().top;
    const boxes: CardBox[] = [...listEl.querySelectorAll('.card')].map((card) => {
      const r = card.getBoundingClientRect();
      return { top: r.top - listTop + listEl.scrollTop, height: r.height };
    });
    geom = dragGeometry(boxes, index);
    dragPointer = e.pointerId;
    startY = contentY(e.clientY);
    pointerY = e.clientY;
    maxScroll = Math.max(0, listEl.scrollHeight - listEl.clientHeight);
    drag = { from: index, to: index, offsets: boxes.map(() => 0) };
    // Capture on the handle: every subsequent move/up for this pointer is
    // delivered here, even outside the element, so no window listeners and no
    // cleanup to forget.
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // Suppresses the text selection a press-and-drag would otherwise start.
    e.preventDefault();
    scrollRaf = requestAnimationFrame(autoScroll);
  }

  function onPointerMove(e: PointerEvent): void {
    if (!drag || e.pointerId !== dragPointer) return;
    pointerY = e.clientY;
    updateDrag();
  }

  function updateDrag(): void {
    if (!drag) return;
    // Clamped, so the card can't be dragged out of the list and off the panel.
    const dy = clampDy(geom, contentY(pointerY) - startY);
    const to = dropIndex(geom, dy);
    drag = { from: geom.from, to, offsets: dragOffsets(geom, to, dy) };
  }

  function autoScroll(): void {
    if (!drag) return;
    const rect = listEl.getBoundingClientRect();
    const delta = autoScrollDelta(pointerY, rect.top, rect.bottom, SCROLL_EDGE, SCROLL_MAX);
    if (delta !== 0) {
      const next = Math.min(maxScroll, Math.max(0, listEl.scrollTop + delta));
      if (next !== listEl.scrollTop) {
        listEl.scrollTop = next;
        // The pointer hasn't moved but its content-space position has, so the
        // drag has to be recomputed for the scroll to carry it anywhere.
        updateDrag();
      }
    }
    scrollRaf = requestAnimationFrame(autoScroll);
  }

  function onPointerUp(e: PointerEvent): void {
    if (!drag || e.pointerId !== dragPointer) return;
    const d = drag;
    // Dropping the transforms and committing the order in the same update is
    // what makes `animate:flip` land: it measures the cards where the drag left
    // them and animates to the new layout.
    endDrag();
    if (d.to !== d.from) app.reorderSeries(d.from, d.to);
  }

  // Escape, or the browser taking the gesture away from us (`pointercancel`
  // fires for a scroll or a system gesture claiming the pointer). Both put the
  // cards back where they were: a drag the user didn't finish shouldn't commit
  // an order they were still choosing. Nothing to undo, since the drag never
  // touched app state.
  function cancelDrag(e?: PointerEvent): void {
    if (!drag || (e && e.pointerId !== dragPointer)) return;
    endDrag();
  }

  function endDrag(): void {
    cancelAnimationFrame(scrollRaf);
    dragPointer = -1;
    drag = null;
  }
</script>

<!-- Shared by the header and the cards, so both read the same way: attributes
     separated by "·", repository in monospace. The explicit `{' '}` is
     load-bearing — Svelte strips whitespace between adjacent elements, and
     without it a copy-paste comes out as "chrome·opt". -->
{#snippet chipRow(chips: AttrChip[])}{#each chips as chip, i}{#if i > 0}<span class="sep"
      >·</span
    >{' '}{/if}<span class="attr {chip.field}">{chip.value}</span>{' '}{/each}{/snippet}

<!-- Declarative, so there's no listener lifecycle to get wrong; the handler is
     a no-op unless a drag is in flight. -->
<svelte:window onkeydown={(e) => e.key === 'Escape' && cancelDrag()} />

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

  <div class="list" role="list" bind:this={listEl}>
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
        class:lifted={drag?.from === i}
        class:sliding={drag !== null && drag.from !== i}
        style:transform={drag && drag.offsets[i] ? `translateY(${drag.offsets[i]}px)` : null}
        role="listitem"
        animate:flip={{ duration: FLIP_MS }}
      >
        <!-- The swatch doubles as the show/hide control: it's the thing that
             ties the card to the graph, so it's where you look to ask "is
             this one on?".
             It carries the series' dot *shape* as well as its color, because
             the graph now distinguishes series by both and a legend that only
             showed half of that would make the shapes unreadable. The shape is
             the identity; the fill still means "being drawn" (see `.off`), so
             this deliberately doesn't mirror the symbol's own fill/outline —
             that would collide with the visibility state. -->
        <button
          type="button"
          class="swatch {entry.symbol.shape}"
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
            title="Drag to reorder"
            aria-hidden="true"
            onpointerdown={(e) => onPointerDown(e, i)}
            onpointermove={onPointerMove}
            onpointerup={onPointerUp}
            onpointercancel={cancelDrag}>⠿</span
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
    background: var(--series-color);
    cursor: pointer;
  }
  .swatch.circle {
    border-radius: 50%;
  }
  .swatch.square {
    border-radius: 2px;
  }
  .swatch.diamond {
    /* Rotated rather than clipped, so the 1px border follows the shape. The
       grid slot is 12px wide, so shrink it to keep the corners inside: a
       12px square on the diagonal would be 17px across. */
    width: 9px;
    height: 9px;
    margin: 3px 1px 0;
    border-radius: 1px;
    transform: rotate(45deg);
  }
  .swatch.off {
    /* Hollow, not grey: the color still identifies the series, the fill says
       whether it's being drawn. */
    background: transparent;
  }
  .card.hidden-series .text {
    opacity: 0.55;
  }
  /* The card under the pointer. No transition — it tracks the pointer 1:1, and
     easing it would feel like dragging through treacle. Lifted out of the flow
     visually only: its layout slot stays where it was until the drop. */
  .card.lifted {
    position: relative;
    z-index: 2;
    box-shadow: 0 6px 16px rgba(31, 35, 40, 0.22);
    border-color: #0969da;
    cursor: grabbing;
  }
  /* The cards stepping aside. The transition is scoped to a live drag so it
     can't still be running when the drop commits — `animate:flip` owns the
     transform from that point on, and two mechanisms animating one property
     would fight. */
  .card.sliding {
    transition: transform 140ms ease;
  }
  .handle {
    display: block;
    width: 20px;
    text-align: center;
    color: #8c959f;
    cursor: grab;
    user-select: none;
    line-height: 1.2;
    /* Pointer events only reach us if the browser doesn't claim the gesture
       for scrolling first. */
    touch-action: none;
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
