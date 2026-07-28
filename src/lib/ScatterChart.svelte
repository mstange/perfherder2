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
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
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
    if (interaction === 'brush' && effectiveBrush) {
      drawBrush(
        ctx,
        geom,
        geom.xScale.toPixel(effectiveBrush.start),
        geom.xScale.toPixel(effectiveBrush.end),
      );
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

  function onPointerMove(e: PointerEvent): void {
    if (!drag || !canvas) return;
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
      const px = localX(e);
      const py = localY(e);
      const hit = hitTestAll(
        series.map((s) => ({ points: s.data.points })),
        geom.xScale,
        geom.yScale,
        px,
        py,
        HIT_RADIUS,
      );
      onselect?.(hit ? { seriesIndex: hit.seriesIndex, pointIndex: hit.pointIndex } : null);
    } else {
      // Clicking outside the window in the overview clears the zoom.
      onbrush?.(null, false);
    }
  }

  function onPointerCancel(): void {
    drag = null;
    pending = null;
  }

  function onDoubleClick(): void {
    if (interaction === 'select') onbrush?.(null, false);
  }
</script>

<div class="chart" bind:this={wrapper}>
  <canvas
    bind:this={canvas}
    style:width="100%"
    style:height="100%"
    class:brushing={interaction === 'brush'}
    aria-label={ariaLabel}
    onpointerdown={onPointerDown}
    onpointermove={onPointerMove}
    onpointerup={onPointerUp}
    onpointercancel={onPointerCancel}
    ondblclick={onDoubleClick}
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
</style>
