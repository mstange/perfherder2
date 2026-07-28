<script lang="ts">
  // A canvas scatter plot of several series over a shared time domain.
  //
  // Used for both graphs: the detail graph (axes, connecting lines, click to
  // select, drag to zoom) and the overview graph (no lines, a brush window
  // that drives the detail graph's zoom). The component owns pixels and
  // pointer events only — the arithmetic is in chart.ts, the drawing in
  // chartDraw.ts.

  import { hitTestAll, makeGeometry, type Padding, type Range } from './chart';
  import { drawBrush, drawChart } from './chartDraw';
  import type { SeriesEntry } from './appState.svelte';

  type Span = { start: number; end: number };

  type Props = {
    series: SeriesEntry[];
    xDomain: Range;
    yDomain: Range;
    dotRadius?: number;
    showLines?: boolean;
    showAxes?: boolean;
    // Shared across both graphs so their plot areas line up.
    pad?: Padding;
    highlight?: { x: number; y: number; color: string } | null;
    // 'select': click picks a point, drag zooms into a time span.
    // 'brush':  drag defines the zoom window shown by the other graph.
    interaction: 'select' | 'brush';
    // Brush window in data coordinates; null means "the whole domain".
    brush?: Span | null;
    onselect?: (hit: { seriesIndex: number; pointIndex: number } | null) => void;
    onbrush?: (span: Span | null, live: boolean) => void;
    onkeymove?: (axis: 'run' | 'replicate', delta: number) => void;
    ariaLabel: string;
  };

  let {
    series,
    xDomain,
    yDomain,
    dotRadius = 2,
    showLines = false,
    showAxes = true,
    pad = { left: 56, right: 12, top: 8, bottom: 20 },
    highlight = null,
    interaction,
    brush = null,
    onselect,
    onbrush,
    onkeymove,
    ariaLabel,
  }: Props = $props();

  // Click radius. Larger than the dot so small targets are still hittable,
  // but not so large that it grabs a point the user wasn't aiming at.
  const HIT_RADIUS = 8;
  // How close to an edge counts as "grab the edge" rather than "start a new
  // window".
  const EDGE_GRAB_PX = 5;

  let wrapper: HTMLDivElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();
  let width = $state(0);
  let height = $state(0);

  // Drag bookkeeping. `pending` is the in-progress span in data coordinates;
  // while it's non-null it wins over the `brush` prop so the window tracks the
  // cursor even before the parent commits it.
  type Drag =
    | { kind: 'new'; anchor: number }
    | { kind: 'move'; grabOffset: number; width: number }
    | { kind: 'edge'; anchor: number };
  let drag = $state<Drag | null>(null);
  let pending = $state<Span | null>(null);
  // Distinguishes a click from a drag: a plain click in 'select' mode must
  // select a point, not zoom into a zero-width span.
  let dragMoved = false;
  // True while the cursor is over a hittable dot, so the cursor can say so.
  let hovering = $state(false);

  const geom = $derived(makeGeometry(width, height, pad, xDomain, yDomain));
  const effectiveBrush = $derived(pending ?? brush);

  $effect(() => {
    if (!wrapper) return;
    const ro = new ResizeObserver((entries) => {
      const box = entries[0].contentRect;
      width = box.width;
      height = box.height;
    });
    ro.observe(wrapper);
    return () => ro.disconnect();
  });

  $effect(() => {
    if (!canvas || width <= 0 || height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(width * dpr);
    const bh = Math.round(height * dpr);
    // Assigning width/height reallocates and clears the backing store, so
    // only do it on an actual size change — this effect reruns on every frame
    // of a zoom drag.
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawChart(ctx, {
      geom,
      xDomain,
      yDomain,
      series: series.map((s) => ({ color: s.color, data: s.data })),
      dotRadius,
      showLines,
      showAxes,
      highlight,
    });
    // In brush mode the window is persistent; in select mode it only exists
    // while the user is dragging out a zoom, but it still needs to be visible
    // or the drag has no feedback at all.
    const window = interaction === 'brush' ? effectiveBrush : pending;
    if (window) {
      drawBrush(ctx, geom, geom.xScale.toPixel(window.start), geom.xScale.toPixel(window.end));
    }
  });

  function localX(e: PointerEvent): number {
    const rect = canvas!.getBoundingClientRect();
    return e.clientX - rect.left;
  }

  function localY(e: PointerEvent): number {
    const rect = canvas!.getBoundingClientRect();
    return e.clientY - rect.top;
  }

  // Clamp a data-space time to the visible domain, so a drag that leaves the
  // canvas doesn't produce a window wider than the graph.
  function clampX(value: number): number {
    return Math.min(xDomain.max, Math.max(xDomain.min, value));
  }

  function spanFrom(a: number, b: number): Span | null {
    const start = clampX(Math.min(a, b));
    const end = clampX(Math.max(a, b));
    // A drag of a couple of pixels is a mis-click, not a zoom request.
    if (geom.xScale.toPixel(end) - geom.xScale.toPixel(start) < 4) return null;
    return { start, end };
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || !canvas) return;
    const px = localX(e);
    const value = geom.xScale.toValue(px);
    dragMoved = false;

    if (interaction === 'brush' && effectiveBrush) {
      const loPx = geom.xScale.toPixel(effectiveBrush.start);
      const hiPx = geom.xScale.toPixel(effectiveBrush.end);
      if (Math.abs(px - loPx) <= EDGE_GRAB_PX) {
        drag = { kind: 'edge', anchor: effectiveBrush.end };
        pending = effectiveBrush;
      } else if (Math.abs(px - hiPx) <= EDGE_GRAB_PX) {
        drag = { kind: 'edge', anchor: effectiveBrush.start };
        pending = effectiveBrush;
      } else if (px > loPx && px < hiPx) {
        drag = {
          kind: 'move',
          grabOffset: value - effectiveBrush.start,
          width: effectiveBrush.end - effectiveBrush.start,
        };
        pending = effectiveBrush;
      } else {
        drag = { kind: 'new', anchor: value };
      }
    } else {
      drag = { kind: 'new', anchor: value };
    }
    canvas.setPointerCapture(e.pointerId);
  }

  function hitAt(px: number, py: number) {
    return hitTestAll(
      series.map((s) => ({ points: s.data.points })),
      geom.xScale,
      geom.yScale,
      px,
      py,
      HIT_RADIUS,
    );
  }

  function onPointerMove(e: PointerEvent): void {
    if (!canvas) return;
    if (!drag) {
      // Hover feedback only matters where a click does something with a
      // point; the overview's clicks are about the window, not the dots.
      if (interaction === 'select') hovering = hitAt(localX(e), localY(e)) !== null;
      return;
    }
    dragMoved = true;
    const value = geom.xScale.toValue(localX(e));
    if (drag.kind === 'move') {
      // Keep the window's width; slide it, stopping at the domain edges.
      let start = value - drag.grabOffset;
      start = Math.min(Math.max(start, xDomain.min), xDomain.max - drag.width);
      pending = { start, end: start + drag.width };
    } else {
      pending = spanFrom(drag.anchor, value);
    }
    if (interaction === 'brush') onbrush?.(pending, true);
  }

  function onPointerUp(e: PointerEvent): void {
    if (!drag || !canvas) return;
    canvas.releasePointerCapture(e.pointerId);
    const kind = drag.kind;
    const wasDrag = dragMoved && pending !== null;
    const span = pending;
    drag = null;
    pending = null;

    if (wasDrag) {
      onbrush?.(span, false);
      return;
    }
    // A click, not a drag.
    if (interaction === 'select') {
      const hit = hitAt(localX(e), localY(e));
      onselect?.(hit ? { seriesIndex: hit.seriesIndex, pointIndex: hit.pointIndex } : null);
    } else if (kind === 'new') {
      // Clicking the overview *outside* the window clears the zoom. A click
      // inside it (which would have started a move) must not — throwing away
      // the zoom because the user tapped the thing they were about to drag
      // is the kind of surprise that makes people distrust a control.
      onbrush?.(null, false);
    }
  }

  function onPointerCancel(): void {
    drag = null;
    pending = null;
  }

  function onPointerLeave(): void {
    hovering = false;
  }

  function onDoubleClick(): void {
    if (interaction === 'select') onbrush?.(null, false);
  }

  // The graph is focusable so a point can be reached without a pointer.
  // Arrow keys walk the selection; Escape clears it.
  function onKeyDown(e: KeyboardEvent): void {
    if (interaction !== 'select') return;
    switch (e.key) {
      case 'ArrowLeft':
        onkeymove?.('run', -1);
        break;
      case 'ArrowRight':
        onkeymove?.('run', 1);
        break;
      case 'ArrowUp':
        onkeymove?.('replicate', -1);
        break;
      case 'ArrowDown':
        onkeymove?.('replicate', 1);
        break;
      case 'Escape':
        onselect?.(null);
        break;
      default:
        return;
    }
    // Only reached for keys we handled — otherwise the page scrolls under us.
    e.preventDefault();
  }
</script>

<div class="chart" bind:this={wrapper}>
  <canvas
    bind:this={canvas}
    style:width="100%"
    style:height="100%"
    class:brushing={interaction === 'brush'}
    class:hovering
    aria-label={ariaLabel}
    tabindex={interaction === 'select' ? 0 : -1}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerCancel}
    onpointerleave={onPointerLeave}
    ondblclick={onDoubleClick}
    onkeydown={onKeyDown}
  ></canvas>
</div>

<style>
  .chart {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 0;
  }
  canvas {
    display: block;
    touch-action: none;
    cursor: crosshair;
  }
  canvas.brushing {
    /* The overview's whole job is horizontal window selection. */
    cursor: col-resize;
  }
  canvas.hovering {
    cursor: pointer;
  }
  canvas:focus-visible {
    outline: 2px solid #0969da;
    outline-offset: -2px;
  }
</style>
