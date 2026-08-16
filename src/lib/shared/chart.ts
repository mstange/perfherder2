// Pure chart math: domains, scales, ticks, formatting, hit-testing.
//
// Nothing here touches the DOM or a canvas context, so all of it is unit
// tested. The Svelte components own pixels and drawing; this module owns the
// arithmetic that decides where those pixels go.

import type { SeriesPoint } from '../graphs/graphData';
import type { Theme } from './theme';

// ---------------------------------------------------------------------------
// Domains and scales
// ---------------------------------------------------------------------------

export type Range = { min: number; max: number };

// Linear map from a value domain onto a pixel range. `p0`/`p1` are pixel
// coordinates; for the y axis callers pass them inverted (p0 = bottom).
export type Scale = {
  toPixel(value: number): number;
  toValue(pixel: number): number;
};

export function makeScale(d0: number, d1: number, p0: number, p1: number): Scale {
  // A zero-width domain would divide by zero; centre it instead.
  const span = d1 - d0;
  if (span === 0) {
    const mid = (p0 + p1) / 2;
    return { toPixel: () => mid, toValue: () => d0 };
  }
  const k = (p1 - p0) / span;
  return {
    toPixel: (value) => p0 + (value - d0) * k,
    toValue: (pixel) => d0 + (pixel - p0) / k,
  };
}

// Treeherder pads the y domain by (max-min)/1.8 on each side, leaving the data
// in under half the plot height. We pad by 5% — see docs/graphs.md.
export const Y_PADDING_FRACTION = 0.05;

// `min === max` (a perfectly flat series, or a single point) still needs a
// domain with width. 1% of the value, or 1 unit if the value is 0.
export function padDomain(min: number, max: number, fraction = Y_PADDING_FRACTION): Range {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };
  if (min === max) {
    const pad = Math.abs(min) * 0.01 || 1;
    return { min: min - pad, max: max + pad };
  }
  const pad = (max - min) * fraction;
  return { min: min - pad, max: max + pad };
}

// Union of several extents, ignoring empty ones.
export function unionRange(ranges: Range[]): Range | null {
  let min = Infinity;
  let max = -Infinity;
  for (const r of ranges) {
    if (!Number.isFinite(r.min) || !Number.isFinite(r.max)) continue;
    if (r.min < min) min = r.min;
    if (r.max > max) max = r.max;
  }
  return Number.isFinite(min) ? { min, max } : null;
}

// ---------------------------------------------------------------------------
// Value ticks
// ---------------------------------------------------------------------------

// Nice 1/2/5×10^k step covering [min, max] with roughly `target` ticks.
export function niceStep(span: number, target: number): number {
  if (!(span > 0) || target <= 0) return 1;
  const rough = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const norm = rough / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return step * mag;
}

export function valueTicks(range: Range, target = 5): number[] {
  const step = niceStep(range.max - range.min, target);
  const first = Math.ceil(range.min / step) * step;
  const out: number[] = [];
  // Guard against an absurd tick count if the caller hands us a huge span and
  // a tiny target; 1000 is far beyond any sane axis.
  for (let v = first, n = 0; v <= range.max + step * 1e-9 && n < 1000; v += step, n++) {
    // Re-derive from the index to keep float error from accumulating.
    out.push(round(first + n * step, step));
  }
  return out;
}

// Round to the precision implied by the step, so 0.30000000000000004 prints
// as 0.3.
function round(v: number, step: number): number {
  const decimals = Math.max(0, -Math.floor(Math.log10(step)) + 1);
  return Number(v.toFixed(Math.min(decimals, 20)));
}

// Axis labels: compact for large magnitudes, precise for small ones.
export function formatTickValue(v: number): string {
  const abs = Math.abs(v);
  if (abs === 0) return '0';
  if (abs >= 1e9) return `${trim(v / 1e9)}G`;
  if (abs >= 1e6) return `${trim(v / 1e6)}M`;
  if (abs >= 1e4) return `${trim(v / 1e3)}k`;
  if (abs >= 1) return trim(v);
  return String(Number(v.toPrecision(3)));
}

function trim(v: number): string {
  const s = v.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

// Full precision for the details pane, where the exact number matters.
export function formatValue(v: number): string {
  if (!Number.isFinite(v)) return 'N/A';
  return Number(v.toFixed(2)).toString();
}

// A difference, always signed, so it reads as a change rather than as a value.
// The explicit `+` is the whole point: "95" and "+95" answer different
// questions.
export function formatSignedValue(v: number): string {
  if (!Number.isFinite(v)) return 'N/A';
  const s = formatValue(Math.abs(v));
  // ASCII hyphen, not a typographic minus: `formatValue` and `toFixed` use one
  // everywhere else, and a card that mixes the two ("−26.08" beside "δ -0.20")
  // looks like two different kinds of number.
  //
  // `-0` prints as "0" through formatValue, so take the sign from the input.
  return `${v < 0 ? '-' : '+'}${s}`;
}

// A fraction as a signed percentage. Two decimals below 1%, one below 10%, none
// above: half a percent is a real regression at perf-test scale, and "0%" for
// one would be the wrong kind of tidy.
export function formatSignedPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return 'N/A';
  const pct = Math.abs(fraction) * 100;
  const digits = pct < 1 ? 2 : pct < 10 ? 1 : 0;
  return `${fraction < 0 ? '-' : '+'}${pct.toFixed(digits)}%`;
}

// p-values span orders of magnitude, and past three decimals the exact figure
// stops carrying information anyone acts on.
export function formatPValue(p: number): string {
  if (!Number.isFinite(p)) return 'N/A';
  if (p < 0.001) return '<0.001';
  return p.toFixed(3);
}

// ---------------------------------------------------------------------------
// Time ticks
// ---------------------------------------------------------------------------

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Candidate spacings, coarsest last. Months and years are approximated —
// exact calendar stepping isn't worth the complexity for an axis.
const TIME_STEPS = [
  MINUTE,
  5 * MINUTE,
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
  14 * DAY,
  30 * DAY,
  90 * DAY,
  365 * DAY,
];

export type TimeTick = { value: number; label: string };

export function pickTimeStep(span: number, target: number): number {
  const rough = span / Math.max(1, target);
  for (const step of TIME_STEPS) {
    if (step >= rough) return step;
  }
  return TIME_STEPS[TIME_STEPS.length - 1];
}

// Labels are local-time, since the user is reasoning about "when did this
// regress" in their own day. Below day resolution we show the clock; at or
// above it we show the date.
export function formatTimeTick(ms: number, step: number): string {
  const d = new Date(ms);
  if (step < DAY) {
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    // Include the date on midnight ticks so a multi-day axis stays readable.
    if (hh === '00' && mm === '00') return formatDay(d);
    return `${hh}:${mm}`;
  }
  return formatDay(d);
}

function formatDay(d: Date): string {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function timeTicks(range: Range, target = 8): TimeTick[] {
  const span = range.max - range.min;
  if (!(span > 0)) return [];
  const step = pickTimeStep(span, target);
  // Align to local midnight for day-or-coarser steps so ticks land on day
  // boundaries rather than on an arbitrary offset from the epoch.
  let first: number;
  if (step >= DAY) {
    const d = new Date(range.min);
    d.setHours(0, 0, 0, 0);
    first = d.getTime();
    while (first < range.min) first += step;
  } else {
    const offset = new Date(range.min).getTimezoneOffset() * MINUTE;
    first = Math.ceil((range.min - offset) / step) * step + offset;
  }
  const out: TimeTick[] = [];
  for (let v = first, n = 0; v <= range.max && n < 200; v += step, n++) {
    out.push({ value: v, label: formatTimeTick(v, step) });
  }
  return out;
}

// Absolute timestamps for the details pane. Local time, seconds precision.
export function formatTimestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

// ---------------------------------------------------------------------------
// Jitter
// ---------------------------------------------------------------------------
//
// Both charts scatter dots that would otherwise land on top of each other: the
// distribution strip vertically (every dot shares one axis position), the
// time-series graphs horizontally (every replicate of a run shares its push
// timestamp, so a 25-replicate run draws as one vertical line).

// Deterministic jitter in [-1, 1] from an index and a salt.
//
// Not `Math.random()`. A Svelte `$derived` re-runs whenever anything it reads
// changes, and random jitter would make every dot jump when an unrelated part of
// the state moved. (PerfCompare hit the same thing from the other direction — its
// strip jitter visibly re-rolled while dragging the valley-depth slider — and
// fixed it by hoisting the roll into a `useMemo`.) On the time-series graphs the
// stake is higher than shimmer: the selection ring is drawn from a different code
// path than the dots, so an offset that isn't a pure function of the point's
// identity would put the ring beside the dot it names.
//
// The mix is the finaliser from MurmurHash3, which decorrelates neighbouring
// indices well enough that consecutive equal values don't stack up.
export function jitterAt(index: number, salt: number): number {
  let h = (index * 0x9e3779b1 + salt * 0x85ebca6b) | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad);
  h ^= h >>> 15;
  h = Math.imul(h, 0x735a2d97);
  h ^= h >>> 15;
  return ((h >>> 0) / 0x100000000) * 2 - 1;
}

// How much of the space around a push its own dots may occupy, as the half-width
// of the cloud. Each push measures its distance to the *nearer* of its two
// neighbours, so at 0.3 two adjacent clouds can cover at most 0.6 of the gap
// between them and 40% of it always stays clear — which is what keeps the columns
// readable as separate builds. It is applied in graphData, which owns the push
// structure (`PushGroup.xRoom`), but it lives here so the whole jitter policy
// reads in one place.
export const JITTER_GAP_FRACTION = 0.3;
// Ceiling on that half-width, in dot radii. Zoom in far enough — or land on an
// isolated push after a weekend — and there are hundreds of pixels of room;
// without a cap one build's replicates would smear across a quarter of the plot
// and stop reading as one measurement. Tied to the dot size because the point of
// the spread is to separate dots, and the dots' own size is the scale on which
// "separated" means anything.
export const JITTER_MAX_RADII = 4;

// Turns a point's stored room into pixels. Fixed for a whole repaint, since it
// depends only on the zoom and the dot size — the *per-point* half of the answer
// is `SeriesPoint.xRoom`, because how much room a dot has is a fact about its own
// push and not about the graph.
//
// Why per push rather than one amplitude for the chart: CI landings come in
// bursts. Measured on autoland over one day, the median gap between consecutive
// pushes was four minutes — 4px on a 1500px plot — while the isolated pushes
// either side of it had hours of room each. Any single number derived from that
// distribution is wrong for most of the pushes on screen: the median leaves the
// isolated columns as vertical lines, and anything wider makes the bursts overlap.
export type JitterScale = { pxPerValue: number; maxPx: number };

export function makeJitterScale(xScale: Scale, dotRadius: number): JitterScale {
  return {
    pxPerValue: Math.abs(xScale.toPixel(1) - xScale.toPixel(0)),
    maxPx: dotRadius * JITTER_MAX_RADII,
  };
}

// The horizontal offset of one dot, in pixels. Same call in the draw loop, in the
// hit test and under the selection ring — three places that must agree to the
// pixel, or the graph responds to clicks somewhere other than where it drew.
export function jitterOffsetPx(
  point: { jitter: number; xRoom: number },
  scale: JitterScale,
): number {
  const room = point.xRoom * scale.pxPerValue;
  // `room < maxPx` rather than `Math.min`, because a lone push's `xRoom` is
  // `Infinity` and a degenerate (zero-width) domain has `pxPerValue` 0, whose
  // product is NaN. A failed comparison then falls through to the ceiling, where
  // `Math.min` would have propagated the NaN into every coordinate on the canvas.
  return point.jitter * (room < scale.maxPx ? room : scale.maxPx);
}

// For callers that don't jitter at all — the tests, and anything hit-testing a
// chart drawn without it.
export const NO_JITTER: JitterScale = { pxPerValue: 0, maxPx: 0 };

// Data-space width of `px` pixels under `scale`. Used to widen the x-sorted
// searches that drawing and hit-testing do by the jitter's reach, so a dot the
// jitter has nudged into view is still found.
export function pixelSpan(scale: Scale, px: number): number {
  return Math.abs(scale.toValue(px) - scale.toValue(0));
}

// ---------------------------------------------------------------------------
// Hit-testing
// ---------------------------------------------------------------------------

// Index of the first entry whose x is >= `x`. The array must be x-sorted, which
// buildSeriesData guarantees for both `points` and `runs`.
export function lowerBound(points: readonly { x: number }[], x: number): number {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].x < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export type Hit = {
  seriesIndex: number;
  pointIndex: number;
  // Squared pixel distance from the cursor; the caller compares across series.
  distanceSq: number;
};

// Nearest point to a pixel position, within `radius` pixels. The x-sorted
// order lets us restrict the scan to a time window instead of touching every
// point — with 20k points per series that matters on every mousemove.
//
// `jitter` must be the same scale the dots were drawn with, or the cursor and the
// dots disagree about where the dots are. The scan window widens by its ceiling,
// since a jittered dot can be that much further out than its push is.
export function hitTestSeries(
  points: SeriesPoint[],
  xScale: Scale,
  yScale: Scale,
  px: number,
  py: number,
  radius: number,
  jitter: JitterScale = NO_JITTER,
): { pointIndex: number; distanceSq: number } | null {
  if (points.length === 0) return null;
  const reach = radius + jitter.maxPx;
  const xLo = xScale.toValue(px - reach);
  const xHi = xScale.toValue(px + reach);
  // A reversed x scale would invert the bounds; normalize.
  const lo = lowerBound(points, Math.min(xLo, xHi));
  const hi = lowerBound(points, Math.max(xLo, xHi));
  const rSq = radius * radius;
  let best = -1;
  let bestDist = Infinity;
  for (let i = lo; i <= hi && i < points.length; i++) {
    const dx = xScale.toPixel(points[i].x) + jitterOffsetPx(points[i], jitter) - px;
    const dy = yScale.toPixel(points[i].y) - py;
    const d = dx * dx + dy * dy;
    if (d < bestDist && d <= rSq) {
      bestDist = d;
      best = i;
    }
  }
  return best === -1 ? null : { pointIndex: best, distanceSq: bestDist };
}

// Nearest point across several series. Returns the series index too, so the
// caller can turn it back into a selection.
export function hitTestAll(
  list: { points: SeriesPoint[] }[],
  xScale: Scale,
  yScale: Scale,
  px: number,
  py: number,
  radius: number,
  jitter: JitterScale = NO_JITTER,
): Hit | null {
  let best: Hit | null = null;
  for (let s = 0; s < list.length; s++) {
    const hit = hitTestSeries(list[s].points, xScale, yScale, px, py, radius, jitter);
    if (hit && (!best || hit.distanceSq < best.distanceSq)) {
      best = { seriesIndex: s, pointIndex: hit.pointIndex, distanceSq: hit.distanceSq };
    }
  }
  return best;
}

// The marks in the plot's margins — perfherder's alert triangles and the
// detected-change bars — carry their own dimensions, row layout and hit tests
// in graphs/annotations.ts, for the same reason `jitterOffsetPx` lives beside
// the dots: the draw loop and the hit test have to agree to the pixel.

// ---------------------------------------------------------------------------
// Plot geometry
// ---------------------------------------------------------------------------

export type Padding = { left: number; right: number; top: number; bottom: number };

/**
 * Where to draw a centred axis label so it stays inside the canvas.
 *
 * The x ticks are centred on their value, and the outermost one sits within a
 * hair of the plot's edge — which leaves half a label hanging over a padding of
 * 12px. At a desktop width the last date was clipped by a couple of pixels; at a
 * phone's 390px "Aug 9" lost its 9, which reads as a rendering fault rather than
 * as a tight fit. Clamping the *text* rather than dropping the tick or growing
 * the padding keeps the axis honest: the tick mark stays where its value is, and
 * only the label shifts, by at most half its own width.
 */
export function clampLabelCenter(x: number, textWidth: number, canvasWidth: number): number {
  const half = textWidth / 2;
  if (canvasWidth < textWidth) return canvasWidth / 2;
  return Math.min(Math.max(x, half), canvasWidth - half);
}

export type PlotGeometry = {
  width: number;
  height: number;
  pad: Padding;
  // Plot area in canvas coordinates.
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  plotWidth: number;
  plotHeight: number;
  xScale: Scale;
  yScale: Scale;
};

// The two graphs share their left padding so their plot areas line up
// vertically; that alignment is what makes the overview readable as a map of
// the detail graph.
export function makeGeometry(
  width: number,
  height: number,
  pad: Padding,
  xDomain: Range,
  yDomain: Range,
): PlotGeometry {
  const x0 = pad.left;
  const x1 = Math.max(pad.left + 1, width - pad.right);
  const y0 = pad.top;
  const y1 = Math.max(pad.top + 1, height - pad.bottom);
  return {
    width,
    height,
    pad,
    x0,
    y0,
    x1,
    y1,
    plotWidth: x1 - x0,
    plotHeight: y1 - y0,
    xScale: makeScale(xDomain.min, xDomain.max, x0, x1),
    // Inverted: larger values are higher on screen.
    yScale: makeScale(yDomain.min, yDomain.max, y1, y0),
  };
}

// ---------------------------------------------------------------------------
// Series styles: colors and symbols
// ---------------------------------------------------------------------------

// Treeherder's palette and symbol set, taken from
// `ui/perfherder/perf-helpers/constants.js` (`graphColors`, `graphSymbols`) —
// but **listed in the order treeherder actually hands them out**, which is the
// reverse of how it declares them. It keeps both lists as stacks and calls
// `.pop()` per series in `helpers.js::createGraphData` (and pushes a color back
// when a series is removed), so the first series on a treeherder graph is
// blue-bell with a filled circle, not dark-puce with a hollow diamond.
//
// Colors and symbols advance together, so within the first six series each has
// both a unique color and a unique shape — the same series looks the same here
// as it does on treeherder.
export const SERIES_COLORS = [
  '#464876', // blue-bell
  '#16BCDE', // cerulean
  '#C92D2F', // fire-red
  '#921181', // purple
  '#FFB851', // orange
  '#4C3146', // dark-puce
];

// Half of treeherder's palette is unusable on a dark plot: blue-bell, purple and
// dark-puce all sit around 1.5–2:1 against the dark canvas, which is a series
// you cannot find. So dark mode gets its own six — the *same hues in the same
// order*, lightened to clear 6:1, rather than a different palette. A series
// keeps its identity when you flip the theme, and the first six still read as
// treeherder's blue / cyan / red / purple / orange / mauve.
//
// Cerulean and orange are already light enough and are carried over untouched,
// which also keeps the two most recognisable slots identical across themes.
export const SERIES_COLORS_DARK = [
  '#8f92c8', // blue-bell, lightened
  '#16BCDE', // cerulean
  '#f2686a', // fire-red, lightened
  '#e05fcd', // purple, lightened
  '#FFB851', // orange
  '#c08fb2', // dark-puce, lightened
];

export type SeriesShape = 'circle' | 'square' | 'diamond';
// `filled: false` is treeherder's "outline": drawn as the shape's edge only.
export type SeriesSymbol = { shape: SeriesShape; filled: boolean };

export const SERIES_SYMBOLS: SeriesSymbol[] = [
  { shape: 'circle', filled: true },
  { shape: 'circle', filled: false },
  { shape: 'square', filled: true },
  { shape: 'square', filled: false },
  { shape: 'diamond', filled: true },
  { shape: 'diamond', filled: false },
];

export type SeriesStyle = { color: string; symbol: SeriesSymbol };

// Assigned by position in the series list, so a series keeps its look across
// reloads of the same URL (the URL preserves series order).
//
// Treeherder stops drawing after six series — `createGraphData` leaves the
// seventh with no color and `visible: false`. We plot as many as you add, so
// the two lists have to keep going, and if they simply cycled in lockstep the
// seventh series would be indistinguishable from the first. Advancing the
// symbol one extra step per wrap keeps every (color, symbol) pair unique for
// 36 series while leaving the first six exactly as treeherder pairs them.
//
// The theme picks the palette but not the *position*, so switching to dark mode
// recolors every series in place rather than reshuffling the graph.
export function styleForIndex(index: number, theme: Theme = 'light'): SeriesStyle {
  const i = Math.max(0, Math.floor(index));
  const colors = theme === 'dark' ? SERIES_COLORS_DARK : SERIES_COLORS;
  const wraps = Math.floor(i / colors.length);
  return {
    color: colors[i % colors.length],
    symbol: SERIES_SYMBOLS[(i + wraps) % SERIES_SYMBOLS.length],
  };
}
