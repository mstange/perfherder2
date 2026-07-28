// Canvas drawing for the graphs. Imperative by nature, but kept out of the
// Svelte component so the component is only sizing + events, and so the
// drawing order is readable in one place.
//
// Everything here takes a PlotGeometry from chart.ts; nothing computes its own
// coordinates.

import {
  formatTickValue,
  lowerBound,
  timeTicks,
  valueTicks,
  type PlotGeometry,
  type Range,
  type SeriesShape,
  type SeriesSymbol,
} from './chart';
import type { SeriesData } from './graphData';

export type DrawSeries = {
  color: string;
  symbol: SeriesSymbol;
  data: SeriesData;
};

export type DrawOptions = {
  geom: PlotGeometry;
  xDomain: Range;
  yDomain: Range;
  series: DrawSeries[];
  dotRadius: number;
  // The detail graph joins per-run means; the overview deliberately doesn't
  // (task requirement) — at overview density the lines are just noise.
  showLines: boolean;
  showAxes: boolean;
};

// A highlighted point, in data coordinates.
export type Highlight = { x: number; y: number; color: string };

const AXIS_COLOR = '#d0d7de';
const GRID_COLOR = '#eef1f4';
const TEXT_COLOR = '#57606a';
const FONT = '11px system-ui, sans-serif';

export function drawChart(ctx: CanvasRenderingContext2D, o: DrawOptions): void {
  const { geom } = o;
  ctx.clearRect(0, 0, geom.width, geom.height);

  const vTicks = valueTicks(o.yDomain, Math.max(2, Math.round(geom.plotHeight / 45)));
  const tTicks = timeTicks(o.xDomain, Math.max(2, Math.round(geom.plotWidth / 110)));

  drawGrid(ctx, o, vTicks, tTicks);
  // Clip the data to the plot area: a series can legitimately have points a
  // hair outside the padded y domain, and the overview must not paint over
  // its own axis labels.
  ctx.save();
  ctx.beginPath();
  ctx.rect(geom.x0, geom.y0, geom.plotWidth, geom.plotHeight);
  ctx.clip();
  if (o.showLines) {
    for (const s of o.series) drawRunLine(ctx, o, s);
  }
  for (const s of o.series) drawDots(ctx, o, s);
  ctx.restore();
  if (o.showAxes) drawAxisLabels(ctx, o, vTicks, tTicks);
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  o: DrawOptions,
  vTicks: number[],
  tTicks: { value: number }[],
): void {
  const { geom } = o;
  ctx.strokeStyle = GRID_COLOR;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const v of vTicks) {
    // Half-pixel offset keeps a 1px line crisp instead of a 2px blur.
    const y = Math.round(geom.yScale.toPixel(v)) + 0.5;
    ctx.moveTo(geom.x0, y);
    ctx.lineTo(geom.x1, y);
  }
  if (o.showAxes) {
    for (const t of tTicks) {
      const x = Math.round(geom.xScale.toPixel(t.value)) + 0.5;
      ctx.moveTo(x, geom.y0);
      ctx.lineTo(x, geom.y1);
    }
  }
  ctx.stroke();

  ctx.strokeStyle = AXIS_COLOR;
  ctx.beginPath();
  ctx.rect(geom.x0 + 0.5, geom.y0 + 0.5, geom.plotWidth - 1, geom.plotHeight - 1);
  ctx.stroke();
}

function drawAxisLabels(
  ctx: CanvasRenderingContext2D,
  o: DrawOptions,
  vTicks: number[],
  tTicks: { value: number; label: string }[],
): void {
  const { geom } = o;
  ctx.fillStyle = TEXT_COLOR;
  ctx.font = FONT;

  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of vTicks) {
    ctx.fillText(formatTickValue(v), geom.x0 - 6, geom.yScale.toPixel(v));
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of tTicks) {
    ctx.fillText(t.label, geom.xScale.toPixel(t.value), geom.y1 + 5);
  }
}

// One polyline through the per-run means. Runs outside the x domain are
// skipped except for the one on each side, so the line still enters and
// leaves the plot area instead of stopping at the edge.
function drawRunLine(ctx: CanvasRenderingContext2D, o: DrawOptions, s: DrawSeries): void {
  const runs = s.data.runs;
  if (runs.length < 2) return;
  const lo = Math.max(0, lowerBoundRuns(runs, o.xDomain.min) - 1);
  ctx.strokeStyle = s.color;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1;
  ctx.beginPath();
  let started = false;
  for (let i = lo; i < runs.length; i++) {
    const r = runs[i];
    const x = o.geom.xScale.toPixel(r.x);
    const y = o.geom.yScale.toPixel(r.mean);
    if (started) ctx.lineTo(x, y);
    else {
      ctx.moveTo(x, y);
      started = true;
    }
    if (r.x > o.xDomain.max) break;
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function lowerBoundRuns(runs: { x: number }[], x: number): number {
  let lo = 0;
  let hi = runs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (runs[mid].x < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Shape scaling, so the three symbols carry about the same amount of ink at a
// given `dotRadius`: a square of side 2r covers 4r² against a circle's πr², a
// diamond with half-diagonal r only 2r². Without this the squares read as the
// biggest series on the graph and the diamonds as the smallest.
const SQUARE_HALF_SIDE = 0.886; // √(π)/2
const DIAMOND_HALF_DIAGONAL = 1.253; // √(π/2)

// Trace one symbol as its own subpath. Each ends closed, so a batched path can
// be filled or stroked in one go.
function traceSymbol(
  ctx: CanvasRenderingContext2D,
  shape: SeriesShape,
  x: number,
  y: number,
  r: number,
): void {
  if (shape === 'square') {
    const h = r * SQUARE_HALF_SIDE;
    ctx.rect(x - h, y - h, h * 2, h * 2);
    return;
  }
  if (shape === 'diamond') {
    const d = r * DIAMOND_HALF_DIAGONAL;
    ctx.moveTo(x, y - d);
    ctx.lineTo(x + d, y);
    ctx.lineTo(x, y + d);
    ctx.lineTo(x - d, y);
    ctx.closePath();
    return;
  }
  // `moveTo` first, or the arc is joined to the previous subpath by a line.
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

// All dots of one series in a single path. Batching matters: a 90-day range
// with replicates is easily 20k dots per series, and one fill() beats 20k. An
// outline symbol is the same single path, stroked instead of filled — so it
// costs one extra rasterization pass over the path, not per-dot state changes.
//
// Outline symbols are deliberately *not* filled white the way treeherder fills
// them. Our dots are translucent so that a dense cluster reads as density; an
// opaque fill would turn those clusters into flat blobs, and a translucent
// white one into a milky smear over the series behind.
function drawDots(ctx: CanvasRenderingContext2D, o: DrawOptions, s: DrawSeries): void {
  const points = s.data.points;
  if (points.length === 0) return;
  const { geom } = o;
  const r = o.dotRadius;
  // The widest a symbol reaches from its centre, for the cull below.
  const reach = r * DIAMOND_HALF_DIAGONAL + 1;
  const start = lowerBound(points, o.xDomain.min);
  ctx.globalAlpha = 0.75;
  ctx.beginPath();
  for (let i = start; i < points.length; i++) {
    const p = points[i];
    if (p.x > o.xDomain.max) break;
    const x = geom.xScale.toPixel(p.x);
    const y = geom.yScale.toPixel(p.y);
    // Cheap vertical cull: points can sit outside a zoomed y domain.
    if (y < geom.y0 - reach || y > geom.y1 + reach) continue;
    traceSymbol(ctx, s.symbol.shape, x, y, r);
  }
  if (s.symbol.filled) {
    ctx.fillStyle = s.color;
    ctx.fill();
  } else {
    ctx.strokeStyle = s.color;
    // Thin enough that the hole in the middle survives at the overview's dot
    // size, where a 1.5px stroke would close a 1px-radius ring into a blob.
    ctx.lineWidth = Math.min(1.5, Math.max(0.75, r * 0.5));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// Drawn on the overlay layer, not with the data: the selection moves far more
// often than 100k dots want to be repainted.
export function drawHighlight(
  ctx: CanvasRenderingContext2D,
  geom: PlotGeometry,
  h: Highlight,
  dotRadius: number,
): void {
  const x = geom.xScale.toPixel(h.x);
  const y = geom.yScale.toPixel(h.y);
  // Off-plot selections (a point outside the zoomed window) must not paint
  // over the axes.
  if (x < geom.x0 || x > geom.x1 || y < geom.y0 || y > geom.y1) return;
  ctx.beginPath();
  ctx.arc(x, y, dotRadius + 3, 0, Math.PI * 2);
  ctx.fillStyle = h.color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#1f2328';
  ctx.stroke();
}

// The overview graph dims everything outside the zoomed window and draws a
// handle on each edge.
export function drawBrush(
  ctx: CanvasRenderingContext2D,
  geom: PlotGeometry,
  fromPx: number,
  toPx: number,
): void {
  const lo = Math.max(geom.x0, Math.min(fromPx, toPx));
  const hi = Math.min(geom.x1, Math.max(fromPx, toPx));
  ctx.save();
  ctx.fillStyle = 'rgba(31, 35, 40, 0.10)';
  if (lo > geom.x0) ctx.fillRect(geom.x0, geom.y0, lo - geom.x0, geom.plotHeight);
  if (hi < geom.x1) ctx.fillRect(hi, geom.y0, geom.x1 - hi, geom.plotHeight);

  ctx.strokeStyle = '#0969da';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(lo) + 0.5, geom.y0);
  ctx.lineTo(Math.round(lo) + 0.5, geom.y1);
  ctx.moveTo(Math.round(hi) + 0.5, geom.y0);
  ctx.lineTo(Math.round(hi) + 0.5, geom.y1);
  ctx.stroke();

  ctx.fillStyle = '#0969da';
  const handleH = Math.min(18, geom.plotHeight);
  const handleY = geom.y0 + (geom.plotHeight - handleH) / 2;
  ctx.fillRect(Math.round(lo) - 1.5, handleY, 3, handleH);
  ctx.fillRect(Math.round(hi) - 1.5, handleY, 3, handleH);
  ctx.restore();
}
