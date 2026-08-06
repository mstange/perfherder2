<script lang="ts">
  // A canvas scatter plot of several series over a shared time domain.
  //
  // Used for both graphs: the detail graph (axes, connecting lines, click to
  // select, drag to zoom) and the overview graph (no lines, a brush window
  // that drives the detail graph's zoom). The component owns pixels and
  // pointer events only — the arithmetic is in chart.ts, the drawing in
  // chartDraw.ts.

  import { hitTestAll, makeGeometry, makeJitterScale, type Padding, type Range } from '../shared/chart';
  import { drawBrush, drawChart, drawHighlights, type Highlight } from './chartDraw';
  import type { SeriesEntry } from './appState.svelte';
  import { theme } from '../shared/theme.svelte';

  type Span = { start: number; end: number };

  // Which point a pointer or key event landed on, as indices into the `series`
  // prop and its point set.
  export type ChartHit = { seriesIndex: number; pointIndex: number };

  type Props = {
    series: SeriesEntry[];
    xDomain: Range;
    yDomain: Range;
    dotRadius?: number;
    showLines?: boolean;
    showAxes?: boolean;
    // Alert markers, on the detail graph only: the overview is 84px tall and
    // may hold a year of pushes, where a row of triangles would be most of what
    // the map shows.
    showAlerts?: boolean;
    // Shared across both graphs so their plot areas line up.
    pad?: Padding;
    // Selection, pinned comparison and hover, in data coordinates. An array
    // rather than one, because up to three of them can be on screen at once and
    // the chart doesn't care which is which — chartDraw's `kind` decides how
    // each is painted.
    highlights?: Highlight[];
    // 'select': click picks a point, drag zooms into a time span.
    // 'brush':  drag defines the zoom window shown by the other graph.
    interaction: 'select' | 'brush';
    // Brush window in data coordinates; null means "the whole domain".
    brush?: Span | null;
    // `shift` is the modifier the caller turns into "compare with this" rather
    // than "select this". Reported rather than interpreted: which gesture means
    // what is the app's decision, not the chart's.
    onselect?: (hit: ChartHit | null, modifiers: { shift: boolean }) => void;
    // The point under the pointer, or null when there isn't one. Fires only on
    // change, so a mousemove inside one dot doesn't re-report it.
    onhover?: (hit: ChartHit | null) => void;
    onbrush?: (span: Span | null, live: boolean) => void;
    onkeymove?: (axis: 'run' | 'replicate', delta: number) => void;
    // The keyboard equivalent of shift-clicking: mark the current selection, then
    // walk away from it with the arrow keys. There is no keyboard gesture for
    // "shift-click *that* dot", so the marking has to come first.
    onkeycompare?: () => void;
    // "Compare the selection with the push before it" — the one pair worth a key
    // of its own, since aiming at a dot in the previous push's cloud is the
    // fiddliest part of the pointer gesture.
    onkeyprevious?: () => void;
    ariaLabel: string;
  };

  let {
    series,
    xDomain,
    yDomain,
    dotRadius = 2,
    showLines = false,
    showAxes = true,
    showAlerts = false,
    pad = { left: 56, right: 12, top: 8, bottom: 20 },
    highlights = [],
    interaction,
    brush = null,
    onselect,
    onhover,
    onbrush,
    onkeymove,
    onkeycompare,
    onkeyprevious,
    ariaLabel,
  }: Props = $props();

  // Click radius. Larger than the dot so small targets are still hittable,
  // but not so large that it grabs a point the user wasn't aiming at.
  const HIT_RADIUS = 8;
  // How close to an edge counts as "grab the edge" rather than "start a new
  // window".
  const EDGE_GRAB_PX = 5;

  let wrapper: HTMLDivElement | undefined = $state();
  // Two layers. The data layer is expensive (100k+ dots is normal) and only
  // changes when the data or the domains do; the overlay carries the brush
  // window and the selection ring, which change on every frame of a drag.
  // Repainting only the overlay is the difference between a 130ms frame and
  // a free one.
  let dataCanvas: HTMLCanvasElement | undefined = $state();
  let overlayCanvas: HTMLCanvasElement | undefined = $state();
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

  // Turns each dot's stored room into a pixel offset. One object for the whole
  // chart, derived rather than recomputed per draw: the dots, the selection rings
  // and the hit test all have to agree on it, and the overlay layer repaints on
  // every frame of a drag.
  const jitter = $derived(makeJitterScale(geom.xScale, dotRadius));

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

  // Size a canvas to its CSS box in device pixels and hand back a context
  // already scaled so callers can work in CSS pixels.
  function prepare(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(width * dpr);
    const bh = Math.round(height * dpr);
    // Assigning width/height reallocates and clears the backing store, so
    // only do it on an actual size change.
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  $effect(() => {
    if (!dataCanvas || width <= 0 || height <= 0) return;
    const ctx = prepare(dataCanvas);
    if (!ctx) return;
    drawChart(ctx, {
      geom,
      xDomain,
      yDomain,
      series: series.map((s) => ({
        color: s.color,
        symbol: s.symbol,
        points: s.plot.points,
        pushes: s.data.pushes,
        alerts: showAlerts ? s.alerts : undefined,
      })),
      dotRadius,
      showLines,
      showAxes,
      // Read inside the effect, so a theme change repaints the canvas — the
      // one thing on the page that CSS can't restyle on its own.
      palette: theme.chartPalette,
      jitter,
    });
  });

  $effect(() => {
    if (!overlayCanvas || width <= 0 || height <= 0) return;
    const ctx = prepare(overlayCanvas);
    if (!ctx) return;
    ctx.clearRect(0, 0, geom.width, geom.height);
    // In brush mode the window is persistent; in select mode it only exists
    // while the user is dragging out a zoom, but it still needs to be visible
    // or the drag has no feedback at all.
    const brushSpan = interaction === 'brush' ? effectiveBrush : pending;
    if (brushSpan) {
      drawBrush(
        ctx,
        geom,
        geom.xScale.toPixel(brushSpan.start),
        geom.xScale.toPixel(brushSpan.end),
        theme.chartPalette,
      );
    }
    if (highlights.length > 0) {
      drawHighlights(ctx, geom, highlights, dotRadius, theme.chartPalette, jitter);
    }
  });

  function localX(e: PointerEvent): number {
    const rect = wrapper!.getBoundingClientRect();
    return e.clientX - rect.left;
  }

  function localY(e: PointerEvent): number {
    const rect = wrapper!.getBoundingClientRect();
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
    if (e.button !== 0 || !wrapper) return;
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
    wrapper.setPointerCapture(e.pointerId);
  }

  function hitAt(px: number, py: number) {
    return hitTestAll(
      series.map((s) => ({ points: s.plot.points })),
      geom.xScale,
      geom.yScale,
      px,
      py,
      HIT_RADIUS,
      jitter,
    );
  }

  // The last hit handed to `onhover`, so a mousemove that stays inside one dot
  // doesn't re-report it. Without this the parent's derived comparison — a KDE
  // and a rank-sum test — would recompute on every pointer event.
  let lastHoverKey: string | null = null;

  function reportHover(hit: ChartHit | null): void {
    const key = hit ? `${hit.seriesIndex}:${hit.pointIndex}` : null;
    if (key === lastHoverKey) return;
    lastHoverKey = key;
    onhover?.(hit);
  }

  function onPointerMove(e: PointerEvent): void {
    if (!wrapper) return;
    if (!drag) {
      // Hover feedback only matters where a click does something with a
      // point; the overview's clicks are about the window, not the dots.
      if (interaction === 'select') {
        const hit = hitAt(localX(e), localY(e));
        hovering = hit !== null;
        reportHover(hit);
      }
      return;
    }
    // A drag is about the window, not about whatever dot it passes over.
    reportHover(null);
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
    if (!drag || !wrapper) return;
    wrapper.releasePointerCapture(e.pointerId);
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
      onselect?.(hit ? { seriesIndex: hit.seriesIndex, pointIndex: hit.pointIndex } : null, {
        shift: e.shiftKey,
      });
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
    // The preview belongs to the pointer being over a dot; leaving the graph
    // ends it, or the pane keeps showing a comparison with nothing on screen to
    // explain where it came from.
    reportHover(null);
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
      case 'c':
      case 'C':
        onkeycompare?.();
        break;
      case 'p':
      case 'P':
        onkeyprevious?.();
        break;
      case 'Escape':
        onselect?.(null, { shift: false });
        break;
      default:
        return;
    }
    // Only reached for keys we handled — otherwise the page scrolls under us.
    e.preventDefault();
  }
</script>

<!-- Events live on the wrapper, not on a canvas, because the overlay layer
     sits on top of the data layer and would otherwise swallow them.

     `role="application"` is right here: the arrow keys belong to the graph,
     and assistive tech should pass them through rather than use them for its
     own navigation. Svelte's a11y rules classify `application` as
     non-interactive and so object to both the tabindex and the listeners —
     the alternative they'd steer us to, wrapping all this in a <button>,
     would have a screen reader announce a scatter plot as a button and imply
     that Enter does something. The suppressions are the lesser evil. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="chart"
  class:brushing={interaction === 'brush'}
  class:hovering
  bind:this={wrapper}
  role="application"
  aria-label={ariaLabel}
  tabindex={interaction === 'select' ? 0 : -1}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerCancel}
  onpointerleave={onPointerLeave}
  ondblclick={onDoubleClick}
  onkeydown={onKeyDown}
>
  <canvas bind:this={dataCanvas}></canvas>
  <canvas bind:this={overlayCanvas}></canvas>
</div>

<style>
  .chart {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 0;
    touch-action: none;
    cursor: crosshair;
  }
  .chart.brushing {
    /* The overview's whole job is horizontal window selection. */
    cursor: col-resize;
  }
  .chart.hovering {
    cursor: pointer;
  }
  .chart:focus-visible {
    outline: 2px solid var(--accent-emphasis);
    outline-offset: -2px;
  }
  canvas {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
