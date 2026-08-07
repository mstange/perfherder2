// Run activity for a picker row: how many times this series ran in the
// selected time range, and a tiny density strip of when.
//
// Everything here is pure. The network lives in activityApi.ts, the cache and
// the batching in pickerState.svelte.ts, the markup in AddSeriesPicker.svelte
// — so every calculation below is testable without a DOM or a fetch. See
// docs/design.md, "Run activity is fetched for the visible window only".

// How many signature ids may go into one /performance/data/ request.
//
// Not a tuning knob: treeherder's frontend rejects the request before Django
// sees it, with "Request Line is too large (6069 > 4094)". Each id costs
// about 21 bytes of query string, so ~195 is the true ceiling; 150 leaves
// room for the other parameters and for longer ids as they grow.
export const MAX_IDS_PER_REQUEST = 150;

// The strip is ~72px wide, so more bars than this would be sub-pixel.
export const MAX_BINS = 24;

const HOUR = 3600;
const DAY = 86400;

// Bin durations we're willing to use, ascending. Every one has a name a
// tooltip could say out loud, which rules out "the range divided by 24".
const BIN_DURATIONS = [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 4 * DAY, 7 * DAY];

// A row's answer, or the reason it doesn't have one. An absent cache entry
// means "not fetched yet" — distinct from `total: 0`, which is a real answer.
export type Activity =
  | { counts: number[]; total: number; lastRunMs: number | null }
  | { error: string };

// The two fields of a /performance/data/ datum this module needs. Declared
// structurally so activity.ts doesn't have to import from activityApi.ts —
// the dependency runs the other way.
export type ActivityDatumLike = { signature_id: number; push_timestamp: number };

// `Series.key` is already the compound `${repo}|${id}` identity (see series.ts
// for why the numeric id and not the aliasing hash). The interval belongs in
// the key too, so changing the Time range misses rather than showing counts
// for a window the user isn't looking at any more.
export function activityCacheKey(seriesKey: string, intervalSeconds: number): string {
  return `${seriesKey}|${intervalSeconds}`;
}

export function chunkIds(ids: readonly number[], size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

// The *finest* granularity the strip has room for: the smallest duration
// whose bin count fits under MAX_BINS.
export function binDuration(rangeSeconds: number): number {
  for (const d of BIN_DURATIONS) {
    if (Math.ceil(rangeSeconds / d) <= MAX_BINS) return d;
  }
  return BIN_DURATIONS[BIN_DURATIONS.length - 1];
}

export function binCount(rangeSeconds: number): number {
  return Math.max(1, Math.ceil(rangeSeconds / binDuration(rangeSeconds)));
}

// Bins are aligned to the END of the window, not the start.
//
// When the range isn't a whole multiple of the bin duration — 90 days at
// 4-day bins is 22.5 — one bin is partial. Aligning to the start would put
// the short bin last, so the rightmost bar (the one the eye goes to, and the
// one that answers "is this running *now*") would cover half the time of its
// neighbours and read as a decline that isn't there. Aligned to the end, the
// partial bin is the oldest, at the far left, where a slightly short bar
// means nothing.
//
// Both ends clamp rather than drop: the window bound is the server's clock,
// so a datum can sit marginally outside ours, and silently discarding a run
// is worse than putting it in the edge bin.
export function binCounts(
  timestampsMs: readonly number[],
  nowMs: number,
  rangeSeconds: number,
): number[] {
  const bins = binCount(rangeSeconds);
  const binMs = binDuration(rangeSeconds) * 1000;
  const counts = new Array<number>(bins).fill(0);
  for (const ts of timestampsMs) {
    const fromEnd = Math.floor((nowMs - ts) / binMs);
    const idx = Math.min(bins - 1, Math.max(0, bins - 1 - fromEnd));
    counts[idx] += 1;
  }
  return counts;
}

// Turn one /performance/data/ response into one Activity per *requested* id.
//
// Two quirks of that endpoint are handled here, and only here:
//
//  - It keys the response by `signature_hash`, which aliases within a repo
//    (two rows differing only by `application` share one — see series.ts). So
//    a single bucket can hold datums for more than one requested series, and
//    the keys are useless. Every datum carries its own `signature_id`; that
//    is what we group on.
//  - It omits signatures with no data in the window rather than returning
//    them empty. Iterating the *requested* ids rather than the response is
//    what turns that silence into `total: 0` — otherwise an idle row would
//    stay pending forever, which is the one thing it must not do, since
//    "this never runs" is exactly the answer the column exists to give.
export function buildActivities(
  requestedIds: readonly number[],
  response: Record<string, readonly ActivityDatumLike[]>,
  nowMs: number,
  rangeSeconds: number,
): Map<number, Activity> {
  const wanted = new Set(requestedIds);
  const byId = new Map<number, number[]>();
  for (const datums of Object.values(response)) {
    for (const d of datums) {
      if (!wanted.has(d.signature_id)) continue;
      const list = byId.get(d.signature_id);
      // Seconds on this endpoint; /performance/summary/ sends a naive ISO
      // string for the same column. One schema per endpoint, not per table.
      const ms = d.push_timestamp * 1000;
      if (list) list.push(ms);
      else byId.set(d.signature_id, [ms]);
    }
  }

  const out = new Map<number, Activity>();
  for (const id of requestedIds) {
    const timestamps = byId.get(id) ?? [];
    out.set(id, {
      counts: binCounts(timestamps, nowMs, rangeSeconds),
      total: timestamps.length,
      // Response order isn't guaranteed to be chronological, so take the max
      // rather than the last element.
      lastRunMs: timestamps.length > 0 ? Math.max(...timestamps) : null,
    });
  }
  return out;
}

// The tallest bin across a set of rows — the denominator every visible strip
// shares (see `activityPath`). Rows that haven't answered yet, and rows that
// failed, contribute nothing rather than a zero.
export function maxBinCount(activities: Iterable<Activity | null>): number {
  let max = 0;
  for (const activity of activities) {
    if (activity === null || 'error' in activity) continue;
    for (const n of activity.counts) {
      if (n > max) max = n;
    }
  }
  return max;
}

// One SVG path for the whole strip, rather than one <rect> per bar.
//
// A screenful is ~29 rows; at 24 bars each that would be ~700 elements
// churning in and out of the virtual scroller on every scroll tick. One
// <path> per row is one node, takes `fill: currentColor`, needs no
// devicePixelRatio handling and no canvas lifecycle, and is testable as a
// string.
//
// `scaleMax` is the height of a full-height bar, and it is the caller's
// business rather than `Math.max(...counts)`, because per-row scaling made the
// column lie: a job running twice a day and a job running twice an hour both
// drew a full-height strip, so the only thing the strip could be read for was
// *when* a series ran, never *how much* — and comparing two rows, which is the
// whole reason they're in one list, silently compared nothing. One denominator
// for every row on screen costs the caller a pass over the visible window and
// makes bar height mean the same thing twice.
export function activityPath(
  counts: readonly number[],
  width: number,
  height: number,
  scaleMax: number,
): string {
  if (counts.length === 0) return '';
  const max = scaleMax;
  if (max <= 0) return '';
  const slot = width / counts.length;
  // One pixel of gap between bars, but never a zero-width bar.
  const barWidth = Math.max(1, Math.round(slot) - 1);
  const parts: string[] = [];
  for (let i = 0; i < counts.length; i++) {
    const n = counts[i];
    if (n === 0) continue;
    // A bin with any runs at all gets at least 1px: 1 run beside a 500-run
    // neighbour would otherwise round to nothing and claim it never ran. The
    // upper clamp matters now that `max` comes from outside: a row whose
    // activity landed after the scale was computed can exceed it for one
    // frame, and a bar taller than the box would draw outside the viewBox.
    const h = Math.min(height, Math.max(1, Math.round((n / max) * height)));
    const x = Math.round(i * slot);
    parts.push(`M${x} ${height - h}h${barWidth}v${h}h-${barWidth}z`);
  }
  return parts.join(' ');
}

function relativeAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// The hover text. "1,204 runs in 14 days · last run 4 hours ago" — the count
// the column already shows, plus the staleness the strip only implies.
export function activityTitle(
  activity: { counts: number[]; total: number; lastRunMs: number | null },
  rangeLabel: string,
  nowMs: number,
): string {
  if (activity.total === 0) return `No runs in ${rangeLabel}`;
  const runs = `${activity.total.toLocaleString()} run${activity.total === 1 ? '' : 's'}`;
  const head = `${runs} in ${rangeLabel}`;
  if (activity.lastRunMs === null) return head;
  return `${head} · last run ${relativeAge(nowMs - activity.lastRunMs)}`;
}
