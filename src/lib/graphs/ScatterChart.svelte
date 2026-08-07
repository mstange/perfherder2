<script lang="ts">
  // A canvas scatter plot of several series over a shared time domain.
  //
  // Used for both graphs: the detail graph (axes, connecting lines, click to
  // select, drag to zoom) and the overview graph (no lines, a brush window
  // that drives the detail graph's zoom). The component owns pixels and
  // pointer events only — the arithmetic is in chart.ts, the drawing in
  // chartDraw.ts.

  import { hitTestAll, makeGeometry, makeJitterScale, type Padding, type Range } from '../shared/chart';
  import { hitTestAlertSlots, layoutAlertMarkers } from './annotations';
  import {
    drawAlertHighlight,
    drawBrush,
    drawChart,
    drawHighlights,
    type Highlight,
  } from './chartDraw';
  import type { SeriesEntry } from './appState.svelte';
  import { theme } from '../shared/theme.svelte';

  type Span = { start: number; end: number };

  // Which point a pointer or key event landed on, as indices into the `series`
  // prop and its point set.
  export type ChartHit = { seriesIndex: number; pointIndex: number };

  // Which alert marker, as indices into `series` and that series' `alerts`.
  export type ChartAlertHit = { seriesIndex: number; alertIndex: number };


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
    // The marker whose alert the selection is on, if any. Passed in rather than
    // worked out here for the same reason the point highlights are: the chart
    // holds no selection, and only the caller can say which of its markers the
    // details pane is currently describing.
    selectedAlert?: ChartAlertHit | null;
    // 'select': click picks a point, drag zooms into a time span.
    // 'brush':  drag defines the zoom window shown by the other graph.
    interaction: 'select' | 'brush';
    // Brush window in data coordinates; null means "the whole domain".
    brush?: Span | null;
    // `shift` is the modifier the caller turns into "compare with this" rather
    // than "select this". Reported rather than interpreted: which gesture means
    // what is the app's decision, not the chart's.
    onselect?: (hit: ChartHit | null, modifiers: { shift: boolean }) => void;
    // An alert marker was clicked. Separate from `onselect` because it isn't a
    // point: the caller resolves it to a push and to the alert's own "before",
    // which this component knows nothing about.
    onalertselect?: (hit: ChartAlertHit) => void;
    // The point under the pointer, or null when there isn't one. Fires only on
    // change, so a mousemove inside one dot doesn't re-report it.
    //
    // Carries `shift` for the same reason `onselect` does — it decides what a
    // click would do, and so what ring the caller puts on the dot. Reported on
    // entry rather than only on keydown, so shift held *before* the pointer
    // reached the graph is still accounted for.
    onhover?: (hit: ChartHit | null, modifiers: { shift: boolean }) => void;
    onbrush?: (span: Span | null, live: boolean) => void;
    onkeymove?: (axis: 'run' | 'replicate', delta: number) => void;
    // The keyboard equivalent of shift-clicking: mark the current selection, then
    // walk away from it with the arrow keys. There is no keyboard gesture for
    // "shift-click *that* dot", so the marking has to come first.
    onkeycompare?: () => void;
    // The keyboard equivalent of clicking a marker: step to the next alert
    // after the selection, or (negative) to the one before it.
    onkeyalert?: (delta: number) => void;
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
    selectedAlert = null,
    interaction,
    brush = null,
    onselect,
    onalertselect,
    onhover,
    onbrush,
    onkeymove,
    onkeycompare,
    onkeyalert,
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
  // True while the cursor is over a hittable dot or alert marker, so the cursor
  // can say so.
  let hovering = $state(false);
  // The marker under the pointer. Chart-local because it changes nothing
  // outside the chart — unlike a hovered *dot*, which previews a comparison in
  // the details pane and therefore belongs to AppState.
  let hoveredAlert = $state<ChartAlertHit | null>(null);

  const geom = $derived(makeGeometry(width, height, pad, xDomain, yDomain));
  const effectiveBrush = $derived(pending ?? brush);

  // Where the marks in the margins go, computed once and read three times: by
  // the data layer that paints them, by the overlay that highlights one, and by
  // the hit test. Deriving it here rather than inside each is what guarantees
  // they agree — see annotations.ts, and `jitterOffsetPx` for the same rule
  // applied to the dots.
  const alertSlots = $derived(
    showAlerts ? layoutAlertMarkers(series, geom.xScale, geom) : [],
  );

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
      })),
      alertSlots,
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
    // Last, so they sit over the rings: a marker is what the next click acts
    // on, and the rings describe what previous ones did.
    //
    // Hovered first and selected second, because the only way two highlighted
    // markers overlap is when they are the same one — and then the selected
    // ring has to be what's left on top, or hovering the selected marker would
    // strip the very thing that says it is selected.
    drawMarkerHighlight(ctx, hoveredAlert, 'hovered');
    drawMarkerHighlight(ctx, selectedAlert, 'selected');
  });

  // Both lookups can miss — a repaint can land between the pointer moving and
  // the series list changing under it, and a slot disappears entirely once its
  // marker scrolls out of the zoomed window — and a miss just means no
  // highlight until the next pointer event.
  function drawMarkerHighlight(
    ctx: CanvasRenderingContext2D,
    hit: ChartAlertHit | null,
    kind: 'hovered' | 'selected',
  ): void {
    if (!hit) return;
    const slot = alertSlots.find(
      (s) => s.seriesIndex === hit.seriesIndex && s.alertIndex === hit.alertIndex,
    );
    const entry = series[hit.seriesIndex];
    if (slot && entry) {
      drawAlertHighlight(ctx, geom, slot, entry.color, theme.chartPalette, kind);
    }
  }

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

  // Markers win over dots inside their band. They're a much smaller, more
  // deliberate target than a cloud of replicates, and the band is a strip at
  // the top of the plot where — with the y domain padded — there is rarely a
  // dot to steal. Aiming at a triangle and getting a dot would be the more
  // annoying failure of the two.
  function alertHitAt(px: number, py: number): ChartAlertHit | null {
    return hitTestAlertSlots(alertSlots, geom, px, py);
  }

  function sameAlert(a: ChartAlertHit | null, b: ChartAlertHit | null): boolean {
    if (!a || !b) return a === b;
    return a.seriesIndex === b.seriesIndex && a.alertIndex === b.alertIndex;
  }


  // The last hit handed to `onhover`, so a mousemove that stays inside one dot
  // doesn't re-report it. Without this the parent's derived comparison — a KDE
  // and a rank-sum test — would recompute on every pointer event.
  let lastHoverKey: string | null = null;

  function reportHover(hit: ChartHit | null, shift = false): void {
    const key = hit ? `${hit.seriesIndex}:${hit.pointIndex}` : null;
    if (key === lastHoverKey) return;
    lastHoverKey = key;
    onhover?.(hit, { shift });
  }

  function onPointerMove(e: PointerEvent): void {
    if (!wrapper) return;
    if (!drag) {
      // Hover feedback only matters where a click does something with a
      // point; the overview's clicks are about the window, not the dots.
      if (interaction === 'select') {
        const px = localX(e);
        const py = localY(e);
        const alert = alertHitAt(px, py);
        if (!sameAlert(alert, hoveredAlert)) hoveredAlert = alert;
        // Over a marker the pointer is not over a dot, whatever the dots think:
        // reporting both would light up a comparison preview in the pane at the
        // same time as the marker offers a different one.
        const hit = alert ? null : hitAt(px, py);
        hovering = alert !== null || hit !== null;
        reportHover(hit, e.shiftKey);
      }
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
    // A drag is about the window, not about whatever dot it passes over — but
    // only once it *is* a drag. A hand twitches a pixel between button-down and
    // button-up, and clearing on the first move made the marker under the
    // pointer shrink back to its resting size mid-click and then grow again as
    // the selection landed. `spanFrom` already draws that line at 4px, which is
    // the same line `onPointerUp` uses to tell a click from a zoom; below it
    // this is still a click, and the highlight has to sit still.
    if (pending) {
      hoveredAlert = null;
      reportHover(null);
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
      const px = localX(e);
      const py = localY(e);
      const alert = alertHitAt(px, py);
      if (alert) {
        // Modifiers are ignored: a marker already sets both ends of a
        // comparison, so there is no second thing for shift to mean here.
        onalertselect?.(alert);
        return;
      }
      const hit = hitAt(px, py);
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
    hoveredAlert = null;
  }

  function onPointerLeave(): void {
    hovering = false;
    hoveredAlert = null;
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
      // Shift reverses this one, where it doesn't for `c` and `p`: those two
      // are single actions, and this is a stepper, where "the other direction"
      // is the obvious second half. Upper case *is* shift — the graph takes no
      // text, so there is nothing else 'A' could have meant.
      case 'a':
        onkeyalert?.(1);
        break;
      case 'A':
        onkeyalert?.(-1);
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
