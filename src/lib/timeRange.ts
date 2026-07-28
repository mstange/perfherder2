// Relative time-range presets, resolved to absolute bounds at click time.
//
// The URL only ever carries absolute epoch-ms bounds (see docs/graphs.md), but
// the control the user clicks is still "last 7 days". These helpers convert
// between the two, including working out which preset button to highlight for
// an arbitrary absolute range.

export type TimeRangePreset = { label: string; seconds: number };

// Same set treeherder offers, minus "last day" (too narrow to be useful with
// the overview graph) and plus nothing new.
export const RANGE_PRESETS: TimeRangePreset[] = [
  { label: '2 days', seconds: 2 * 86400 },
  { label: '7 days', seconds: 7 * 86400 },
  { label: '14 days', seconds: 14 * 86400 },
  { label: '30 days', seconds: 30 * 86400 },
  { label: '60 days', seconds: 60 * 86400 },
  { label: '90 days', seconds: 90 * 86400 },
  { label: '1 year', seconds: 365 * 86400 },
];

// Treeherder's default is 14 days; we match it.
export const DEFAULT_RANGE_SECONDS = 14 * 86400;

export type Span = { start: number; end: number };

const MINUTE_MS = 60_000;

// Bounds are snapped to the minute. Sub-minute precision would make every
// reload produce a different URL for the same intent, and would defeat any
// caching that keys on the request URL.
export function presetSpan(seconds: number, nowMs: number): Span {
  const end = Math.ceil(nowMs / MINUTE_MS) * MINUTE_MS;
  return { start: end - seconds * 1000, end };
}

export function defaultSpan(nowMs: number): Span {
  return presetSpan(DEFAULT_RANGE_SECONDS, nowMs);
}

// Which preset (if any) this absolute span still represents. A span counts as
// "last N days" while its end is close enough to now — otherwise a link opened
// an hour later would show no button as active even though nothing changed.
export function matchingPreset(span: Span, nowMs: number): TimeRangePreset | null {
  const tolerance = Math.max(2 * MINUTE_MS, (span.end - span.start) * 0.02);
  if (Math.abs(nowMs - span.end) > tolerance) return null;
  const duration = span.end - span.start;
  for (const preset of RANGE_PRESETS) {
    if (Math.abs(duration - preset.seconds * 1000) <= tolerance) return preset;
  }
  return null;
}

// Human description of an arbitrary span, for the label next to the presets.
export function describeSpan(span: Span): string {
  const fmt = (ms: number) =>
    new Date(ms).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  return `${fmt(span.start)} – ${fmt(span.end)}`;
}

// Clamp `inner` into `outer`, returning null when it covers the whole of it
// (which is how "not zoomed" is represented).
export function clampSpan(inner: Span, outer: Span): Span | null {
  const start = Math.max(inner.start, outer.start);
  const end = Math.min(inner.end, outer.end);
  if (!(start < end)) return null;
  if (start <= outer.start && end >= outer.end) return null;
  return roundSpan({ start, end });
}

// Bounds that come out of a pixel-to-time conversion are fractional. The URL
// only round-trips integers (a fractional bound was silently dropped on
// reload), and sub-millisecond zoom precision is meaningless anyway.
export function roundSpan(span: Span): Span {
  return { start: Math.round(span.start), end: Math.round(span.end) };
}
