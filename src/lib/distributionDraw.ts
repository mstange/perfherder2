// Canvas painting for the details pane's distribution chart. Same split as
// chartDraw.ts: every coordinate comes from a DistributionLayout, and nothing
// here computes its own geometry.

import { formatTickValue, valueTicks } from './chart';
import type {
  DistributionLayout,
  DistributionPlot,
  DistributionSeries,
  StripRow,
} from './distribution';

const AXIS_COLOR = '#d0d7de';
const GRID_COLOR = '#eef1f4';
const TEXT_COLOR = '#57606a';
const RING_COLOR = '#1f2328';
const ROW_TINT = '#f6f8fa';
const FONT = '10px system-ui, sans-serif';
// One line of FONT, for stacking and clamping mode labels.
const LABEL_HEIGHT_PX = 10;

const CURVE_WIDTH = 1.5;
const FILL_ALPHA = 0.16;
const DOT_RADIUS = 2;
const MARKED_RADIUS = 3.5;
const DOT_ALPHA = 0.6;

// One tick per ~64px: enough to read the axis at pane width without the labels
// touching.
const TICK_SPACING_PX = 64;

// Which of the two visual vocabularies a side gets. With one side there is
// nothing to distinguish, so it takes the emphatic one.
//
// The pair is dashed-and-hollow versus solid-and-filled rather than two colors,
// because the commonest comparison — one series across two pushes — has the
// same color on both sides by construction. Colors still differ when the sides
// are different series, which reinforces it rather than carrying it.
function isBaseSide(plot: DistributionPlot, index: number): boolean {
  return plot.series.length > 1 && index === 0;
}

export function drawDistribution(
  ctx: CanvasRenderingContext2D,
  layout: DistributionLayout,
  plot: DistributionPlot,
): void {
  ctx.clearRect(0, 0, layout.width, layout.height);
  const ticks = valueTicks(
    plot.domain,
    Math.max(2, Math.round((layout.x1 - layout.x0) / TICK_SPACING_PX)),
  );
  drawAxis(ctx, layout, ticks);

  plot.series.forEach((side, i) => {
    if (side.density.length > 0) drawCurve(ctx, layout, plot, side, isBaseSide(plot, i));
  });
  plot.series.forEach((side, i) => {
    if (side.density.length > 0) drawModes(ctx, layout, plot, side, i);
  });
  plot.series.forEach((side, i) => {
    const row = layout.rows[i];
    if (!row) return;
    // A tint on the second row, so two adjacent strips read as two rows rather
    // than as one taller cloud. Only with two of them — a lone shaded row would
    // look like it meant something.
    if (i === 1) {
      ctx.fillStyle = ROW_TINT;
      ctx.fillRect(layout.x0, row.y0, layout.x1 - layout.x0, row.y1 - row.y0);
    }
    drawStrip(ctx, layout, side, row, isBaseSide(plot, i));
  });
}

function drawAxis(
  ctx: CanvasRenderingContext2D,
  layout: DistributionLayout,
  ticks: number[],
): void {
  const top = layout.bandY0;
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const t of ticks) {
    // Half-pixel offset keeps a 1px line crisp rather than a 2px blur.
    const x = Math.round(layout.xScale.toPixel(t)) + 0.5;
    ctx.moveTo(x, top);
    ctx.lineTo(x, layout.axisY);
  }
  ctx.stroke();

  ctx.strokeStyle = AXIS_COLOR;
  ctx.beginPath();
  const y = Math.round(layout.axisY) + 0.5;
  ctx.moveTo(layout.x0, y);
  ctx.lineTo(layout.x1, y);
  ctx.stroke();

  ctx.fillStyle = TEXT_COLOR;
  ctx.font = FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of ticks) {
    ctx.fillText(formatTickValue(t), layout.xScale.toPixel(t), layout.axisY + 3);
  }
}

// The density curve, optionally filled down to the band floor. One path for the
// whole grid — at 256 points that's cheap enough to repaint on every hover.
function drawCurve(
  ctx: CanvasRenderingContext2D,
  layout: DistributionLayout,
  plot: DistributionPlot,
  side: DistributionSeries,
  isBase: boolean,
): void {
  const trace = () => {
    ctx.beginPath();
    for (let i = 0; i < plot.grid.length; i++) {
      const x = layout.xScale.toPixel(plot.grid[i]);
      const y = layout.densityScale.toPixel(side.density[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  };

  if (!isBase) {
    trace();
    // Close along the floor so the area reads as mass rather than as a shape.
    ctx.lineTo(layout.xScale.toPixel(plot.grid[plot.grid.length - 1]), layout.bandY1);
    ctx.lineTo(layout.xScale.toPixel(plot.grid[0]), layout.bandY1);
    ctx.closePath();
    ctx.globalAlpha = FILL_ALPHA;
    ctx.fillStyle = side.color;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  trace();
  ctx.strokeStyle = side.color;
  ctx.lineWidth = CURVE_WIDTH;
  ctx.setLineDash(isBase ? [4, 3] : []);
  ctx.stroke();
  ctx.setLineDash([]);
}

// A dashed riser at each detected peak, from the band floor to the curve, with
// the mode's letter above it. The letter is all the chart carries — the value
// and the area share go in the HTML mode list, where they fit (see
// docs/comparison.md).
//
// Nothing is drawn for a single mode. "This distribution has one peak" is what
// the curve already says, and a lone marker labelled A reads as if there were a
// B somewhere. The HTML list applies the same rule, so the two agree about when
// modes are worth mentioning.
function drawModes(
  ctx: CanvasRenderingContext2D,
  layout: DistributionLayout,
  plot: DistributionPlot,
  side: DistributionSeries,
  sideIndex: number,
): void {
  if (side.modes.peakLocs.length < 2) return;
  ctx.strokeStyle = side.color;
  ctx.fillStyle = side.color;
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  ctx.font = FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  side.modes.peakLocs.forEach((loc, i) => {
    const x = Math.round(layout.xScale.toPixel(loc)) + 0.5;
    // The peak's height, read off the grid rather than recomputed: a peak
    // location *is* a grid value, so this is a lookup, not an approximation.
    const top = layout.densityScale.toPixel(side.density[gridIndexOf(plot.grid, loc)] ?? 0);
    ctx.beginPath();
    ctx.moveTo(x, layout.bandY1);
    ctx.lineTo(x, top);
    ctx.stroke();
    // Above the peak, side 1 a line lower so two peaks at the same value don't
    // print their labels on top of each other — but clamped into the band. The
    // tallest peak reaches the band ceiling by construction (it's what sets the
    // density scale), so an unclamped label for it lands off the canvas.
    const labelY = Math.max(
      layout.bandY0 + LABEL_HEIGHT_PX + sideIndex * LABEL_HEIGHT_PX,
      top - 2 - sideIndex * LABEL_HEIGHT_PX,
    );
    ctx.fillText(side.modes.letters[i], x, labelY);
  });
  ctx.setLineDash([]);
}

// The grid is uniform, so a value's index is arithmetic rather than a search.
function gridIndexOf(grid: readonly number[], value: number): number {
  const n = grid.length;
  if (n < 2) return 0;
  const step = (grid[n - 1] - grid[0]) / (n - 1);
  if (!(step > 0)) return 0;
  return Math.max(0, Math.min(n - 1, Math.round((value - grid[0]) / step)));
}

// One side's raw values: a faint baseline, a solid tick at the median, and a dot
// per value offset by its deterministic jitter.
function drawStrip(
  ctx: CanvasRenderingContext2D,
  layout: DistributionLayout,
  side: DistributionSeries,
  row: StripRow,
  isBase: boolean,
): void {
  const amplitude = Math.max(1, (row.y1 - row.y0) / 2 - MARKED_RADIUS - 1);

  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const baseY = Math.round(row.centerY) + 0.5;
  ctx.moveTo(layout.x0, baseY);
  ctx.lineTo(layout.x1, baseY);
  ctx.stroke();

  if (side.summary) {
    // The median, so the shift between two rows is readable without counting
    // dots. Full row height and solid, which is what separates it from the
    // dashed mode risers up in the band.
    const x = Math.round(layout.xScale.toPixel(side.summary.median)) + 0.5;
    ctx.strokeStyle = side.color;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(x, row.y0 + 2);
    ctx.lineTo(x, row.y1 - 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // Every dot in one path, filled or stroked once — the same batching the
  // time-series graph relies on, and for the same reason.
  ctx.beginPath();
  let marked: { x: number; y: number } | null = null;
  for (const dot of side.strip) {
    const x = layout.xScale.toPixel(dot.value);
    const y = row.centerY + dot.jitter * amplitude;
    if (dot.marked) {
      marked = { x, y };
      continue;
    }
    ctx.moveTo(x + DOT_RADIUS, y);
    ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
  }
  ctx.globalAlpha = DOT_ALPHA;
  if (isBase) {
    ctx.strokeStyle = side.color;
    ctx.lineWidth = 1;
    ctx.stroke();
  } else {
    ctx.fillStyle = side.color;
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // The clicked value last and opaque, with the same ring the graphs put around
  // a selection, so the two charts agree about which dot the pane is describing.
  if (marked) {
    ctx.beginPath();
    ctx.arc(marked.x, marked.y, MARKED_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = side.color;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = RING_COLOR;
    ctx.stroke();
  }
}
