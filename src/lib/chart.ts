// Pure chart math: domains, scales, ticks, formatting, hit-testing.
//
// Nothing here touches the DOM or a canvas context, so all of it is unit
// tested. The Svelte components own pixels and drawing; this module owns the
// arithmetic that decides where those pixels go.

import type { SeriesPoint } from './graphData';

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
// Hit-testing
// ---------------------------------------------------------------------------

// Index of the first point whose x is >= `x`. Points must be x-sorted, which
// buildSeriesData guarantees.
export function lowerBound(points: SeriesPoint[], x: number): number {
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
export function hitTestSeries(
  points: SeriesPoint[],
  xScale: Scale,
  yScale: Scale,
  px: number,
  py: number,
  radius: number,
): { pointIndex: number; distanceSq: number } | null {
  if (points.length === 0) return null;
  const xLo = xScale.toValue(px - radius);
  const xHi = xScale.toValue(px + radius);
  // A reversed x scale would invert the bounds; normalize.
  const lo = lowerBound(points, Math.min(xLo, xHi));
  const hi = lowerBound(points, Math.max(xLo, xHi));
  const rSq = radius * radius;
  let best = -1;
  let bestDist = Infinity;
  for (let i = lo; i <= hi && i < points.length; i++) {
    const dx = xScale.toPixel(points[i].x) - px;
    const dy = yScale.toPixel(points[i].y) - py;
    const d = dx * dx + dy * dy;
    if (d < bestDist && d <= rSq) {
      bestDist = d;
      best = i;
    }
  }
  return best === -1 ? null : { pointIndex: best, distanceSq: bestDist };
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

// Treeherder cycles 6 colors crossed with 6 symbols. Symbols are illegible at
// our dot size, so we use a wider color palette instead. The first six are
// treeherder's, so a graph looks familiar; the rest extend it while staying
// distinguishable on white.
export const SERIES_COLORS = [
  '#4C3146',
  '#FFB851',
  '#921181',
  '#C92D2F',
  '#16BCDE',
  '#464876',
  '#1B7F3B',
  '#B36B00',
  '#2B6CB0',
  '#7A3E9D',
  '#0F766E',
  '#9C1C4D',
];

// Assigned by position in the series list, so colors are stable across
// reloads of the same URL (the URL preserves series order).
export function colorForIndex(index: number): string {
  return SERIES_COLORS[index % SERIES_COLORS.length];
}
