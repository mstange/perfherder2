// Client-side change detection: where did this series step, and by how much.
//
// **Pure.** Input is a series' pushes; output is a list of confirmed steps. The
// drawing is chartDraw's, the layout annotations.ts's, the caching
// appState's.
//
// ## Why this exists at all, given alerts.ts
//
// Perfherder's alerts are somebody else's verdict, and they exist only where
// somebody else's threshold fired. The gap that motivates this is recorded in
// graphs-todo.md under "Common alerts": plotting idb-open-many-seq
// `open_duration` on macOS over a year shows nothing at all, while its Windows
// counterpart carries alert #51136 for the very same push. The change hit both
// platforms — macOS moved +2.0% against Windows' +9.9% — and only one of them
// crossed the alerting threshold. The macOS graph is not quiet; it is
// unannotated.
//
// So this is the second opinion, computed from the data on screen: no
// threshold policy, no server round-trip, and it works on any series including
// ones perfherder never analysed.
//
// The prior art is perf.webkit.org's charts view (`public/shared/statistics.js`
// and `public/v3/pages/chart-pane.js`, the "Segmentation with Welch's t-test
// change detection" trend line). The two-stage shape — segment first, then
// confirm each boundary with a test on the points either side — is theirs, as
// is the Schwarz-criterion segmentation with the Birgé–Massart penalty. The
// deviations are listed under "Deviations from perf.webkit.org" below.
//
// ## The unit of analysis is the push mean, not the replicate
//
// This app has something perf.webkit.org doesn't: tens of replicate values per
// build. It is tempting to feed them all in, and it would be wrong. Replicates
// within one build share a machine, a binary and a moment; their spread is much
// tighter than the build-to-build spread that a regression has to be seen
// against. Pooled, a rank-sum test over 20 replicates a side finds *every* pair
// of adjacent pushes "significantly different" — the textbook
// pseudo-replication trap, and it would paint the whole graph.
//
// So the values here are `PushGroup.mean`, one per build: the same number the
// connecting line joins. The replicates still earn their keep — they are what
// makes each of those means precise — but they are not independent samples of
// the thing being tested.

import type { PushGroup } from './graphData';
import {
  changeDirection,
  mannWhitneyU,
  mean,
  relativeChange,
  type EffectSize,
} from '../shared/stats';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

// Birgé and Massart's penalty constant, the value its authors suggest and the
// one perf.webkit.org ships. Larger means fewer segments.
const PENALTY_C = 2.5;

// The segmentation is O(n²) per candidate segment count, so a long series is
// cut into grids of this many pushes and segmented one grid at a time — the
// same bound, and the same reason, as perf.webkit.org's "Grid size" parameter.
// Measured: 3 ms over 340 pushes, 10 ms over 900, 21 ms over 2000 — the last
// two being four grids' worth, so the cost is linear once past this.
//
// **Grid edges are discarded rather than kept as candidates**, which
// perf.webkit.org also does and which was worth rediscovering the hard way. The
// tempting argument is that the confirmation stage is a real test, so an extra
// candidate costs one test and might rescue a change that lands on an edge. It
// doesn't work out: a grid edge is a *guaranteed* extra candidate every 500
// pushes, and on a synthetic series with steps at 225/450/675 the edge at 500
// duly produced a fourth "change" of −1.0% at p = 0.028 out of pure noise. The
// change it might have rescued, meanwhile, is only ever one within MIN_SEGMENT
// of the edge — every other one is found by its own grid's segmentation.
const GRID_SIZE = 500;

// No segment may be shorter than this. Two is the shortest length that has a
// sample variance at all; a single value scores at the variance floor below,
// which is an unbounded discount that one outlier could buy out of nothing.
// (perf.webkit.org allows length-1 segments and special-cases their cost to
// zero, which is the same problem answered with a different constant.)
//
// This does not stop an outlier from being segmented *off* — a two-point
// segment can still absorb one — and it is not meant to. Rejecting the
// boundaries around it is the confirmation stage's job, and a rank-sum test
// over pools that differ by one value does exactly that.
const MIN_SEGMENT = 2;

// Ceiling on the segment count, per grid. Only a bound on worst-case time: the
// search stops early (see `sinceBest`) long before this on real data.
const MAX_SEGMENTS = 32;

// A variance floor, as a fraction of the whole grid's variance. `n·log(σ²)`
// runs away to −∞ as σ² approaches zero, so a run of near-identical values can
// buy an arbitrarily good score. Relative to the series' own variance rather
// than absolute, since these are milliseconds in one series and bytes in the
// next.
const VARIANCE_FLOOR_FRACTION = 1e-6;

// How many pushes either side of a candidate the confirmation test looks at,
// clipped to the neighbouring boundaries so a window never crosses another
// change.
//
// 24 is `PERFHERDER_ALERTS_MAX_BACK_WINDOW` (treeherder/perf/alerts.py), which
// is deliberate rather than coincidental: perfherder's own alert quotes means
// over 12–24 pushes back against 12 forward, and both cards can end up in the
// details pane at once. Sizing this window the same way means the two "before →
// after" pairs are on the same scale, so where they differ it is because the
// two analyses disagree and not because one of them averaged ten times as much
// data as the other.
const WINDOW_PUSHES = 24;

// How sure the test has to be. **Not `SIGNIFICANCE_ALPHA`**, the 0.05 the
// comparison card reports against, and the difference is multiple comparisons:
// the card asks one question about two builds the user picked, while this asks
// one per candidate boundary — up to MAX_SEGMENTS of them per grid — over every
// plotted series, unprompted. At 0.05 that is on the order of one manufactured
// bar per series per range, which for a feature that draws itself by default is
// the difference between a second opinion and a nuisance.
const CHANGE_ALPHA = 0.01;

// Below this many pushes on a side there is no point testing. The two-sided
// Mann-Whitney U is a rank statistic, so with small pools there is a floor on
// the p-value it can reach *however cleanly* the two groups separate: 0.030 at
// 4 against 4 and 0.012 at 5 against 5, both above CHANGE_ALPHA. Six a side is
// the first that can clear it (0.005), so anything less would be rejected by
// arithmetic rather than by evidence — and would waste a test saying so.
const MIN_WINDOW_PUSHES = 6;

// Changes smaller than this are dropped even when the test can see them. With
// enough pushes a rank-sum test will happily certify a 0.05% drift, which is
// true and useless.
//
// Deliberately far below perfherder's own 2% alerting threshold — catching the
// sub-threshold changes perfherder stays quiet about is the whole point (see
// the macOS example above), so a threshold anywhere near theirs would rebuild
// the blind spot this is meant to cover.
const MIN_RELATIVE_CHANGE = 0.005;

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

// Cost of the half-open segment [i, j): `len · log(variance)`, the Gaussian
// contrast that the Schwarz criterion is applied to.
//
// From prefix sums, so a cost is O(1) and the whole DP needs no O(n²) matrix.
// The values are centred on the series mean first — `Σx² − (Σx)²/n` on
// uncentred perf numbers is a catastrophic-cancellation machine, and a series
// sitting at 100 000 with a variance of 1 loses every significant digit of it.
function makeCostFn(values: readonly number[]): (i: number, j: number) => number {
  const n = values.length;
  const centre = mean(values);
  const sums = new Float64Array(n + 1);
  const squares = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const v = values[i] - centre;
    sums[i + 1] = sums[i] + v;
    squares[i + 1] = squares[i] + v * v;
  }
  const varianceOf = (i: number, j: number): number => {
    const len = j - i;
    if (len < 2) return 0;
    const sum = sums[j] - sums[i];
    return Math.max(0, (squares[j] - squares[i] - (sum * sum) / len) / (len - 1));
  };
  const floor = varianceOf(0, n) * VARIANCE_FLOOR_FRACTION;
  return (i, j) => {
    const v = Math.max(varianceOf(i, j), floor);
    // A perfectly flat grid has no floor either, and log(0) is not a cost.
    return v > 0 ? (j - i) * Math.log(v) : 0;
  };
}

// Birgé and Massart's penalization of a k-segment model.
function penalty(k: number, n: number): number {
  return k * (1 + PENALTY_C * Math.log(n / k));
}

// Optimal boundaries for one grid, as `[0, …, n]`. Length k+1 for k segments,
// so a return of `[0, n]` means "no steps here".
//
// Dynamic programming over segment count: `costs[j]` after layer k is the best
// total cost of covering values[0, j) with exactly k segments, and each layer
// is one O(n²) pass. perf.webkit.org re-runs its whole DP once per candidate k,
// which is O(n²k²) overall; running it layer by layer and reading the criterion
// off each layer is O(n²k) for the same answer.
function segmentGrid(values: readonly number[]): number[] {
  const n = values.length;
  if (n < MIN_SEGMENT * 2) return [0, n];

  const cost = makeCostFn(values);
  const maxSegments = Math.min(MAX_SEGMENTS, Math.floor(n / MIN_SEGMENT));
  const beta = Math.log(n) / n;

  let previous = new Float64Array(n + 1).fill(Infinity);
  previous[0] = 0;
  // One backlink layer per k: `backlinks[k-1][j]` is where the last of k
  // segments covering [0, j) starts.
  const backlinks: Int32Array[] = [];

  let bestK = 1;
  let bestCriterion = Infinity;
  // The criterion is not convex in k, so the search doesn't stop at the first
  // step uphill. Three consecutive non-improvements is perf.webkit.org's rule.
  let sinceBest = 0;

  for (let k = 1; k <= maxSegments; k++) {
    const layer = new Float64Array(n + 1).fill(Infinity);
    const from = new Int32Array(n + 1).fill(-1);
    for (let j = k * MIN_SEGMENT; j <= n; j++) {
      let best = Infinity;
      let bestI = -1;
      for (let i = (k - 1) * MIN_SEGMENT; i <= j - MIN_SEGMENT; i++) {
        const head = previous[i];
        if (head === Infinity) continue;
        const total = head + cost(i, j);
        if (total < best) {
          best = total;
          bestI = i;
        }
      }
      layer[j] = best;
      from[j] = bestI;
    }
    backlinks.push(from);
    previous = layer;

    if (layer[n] === Infinity) break;
    const criterion = layer[n] / n + beta * penalty(k, n);
    if (criterion < bestCriterion) {
      bestCriterion = criterion;
      bestK = k;
      sinceBest = 0;
    } else if (++sinceBest >= 3) {
      break;
    }
  }

  const boundaries = new Array<number>(bestK + 1);
  boundaries[bestK] = n;
  let at = n;
  for (let k = bestK; k > 0; k--) {
    at = backlinks[k - 1][at];
    // Can't happen for a k the loop above scored, but a truncated backlink
    // would otherwise produce a boundary list that isn't sorted.
    if (at < 0) return [0, n];
    boundaries[k - 1] = at;
  }
  return boundaries;
}

// Segment boundaries over a whole series, `[0, …, n]`, strictly increasing.
// Grids are segmented independently and their edges dropped; see GRID_SIZE.
export function segmentValues(values: readonly number[], gridSize = GRID_SIZE): number[] {
  const n = values.length;
  if (n < MIN_SEGMENT * 2) return [0, n];
  const boundaries = [0];
  for (let start = 0; start < n; start += gridSize) {
    const end = Math.min(n, start + gridSize);
    const inner = segmentGrid(values.slice(start, end));
    for (let i = 1; i < inner.length - 1; i++) boundaries.push(start + inner[i]);
  }
  boundaries.push(n);
  return boundaries;
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

// One confirmed step in a series, in push-index space.
export type DetectedChange = {
  // Index into the series' `pushes` of the first push *after* the step.
  index: number;
  // The pushes the test compared, as a half-open index range that straddles
  // `index`. Also what the annotation bar spans.
  windowStart: number;
  windowEnd: number;
  beforeCount: number;
  afterCount: number;
  // Push timestamps at `windowStart` and at `windowEnd - 1` — the bar's extent.
  x0: number;
  x1: number;
  // Halfway between the last push before the step and the first one after it:
  // where the change actually happened, as far as this data can say.
  changeX: number;
  // Means of the two windows.
  beforeValue: number;
  afterValue: number;
  // (after − before) / before. Never null and never below MIN_RELATIVE_CHANGE —
  // a candidate that can't produce one isn't returned.
  relativeChange: number;
  // From the metric's direction, never from the sign alone.
  isRegression: boolean;
  // Two-sided Mann-Whitney U over the two windows.
  pValue: number;
  effectSize: EffectSize;
  // The two pushes either side of the step, so a click can pin them as a
  // comparison the way an alert marker does.
  beforePushId: number;
  afterPushId: number;
};

type Confirmation = Pick<
  DetectedChange,
  | 'windowStart'
  | 'windowEnd'
  | 'beforeCount'
  | 'afterCount'
  | 'beforeValue'
  | 'afterValue'
  | 'relativeChange'
  | 'pValue'
  | 'effectSize'
>;

// Does a candidate boundary survive a test on the pushes either side?
//
// A **fixed** window of up to WINDOW_PUSHES a side, clipped to the neighbouring
// boundaries. perf.webkit.org instead grows a window outward from ±2 until its
// t-test turns significant and reports that window — which is optional
// stopping, so the p-value it prints is not the false-positive rate it looks
// like, and the means it prints come from the smallest sample that happened to
// clear the bar rather than from the best one available. A fixed window has one
// pool, one estimate and one p-value, all describing the same thing. What it
// gives up is perf.webkit.org's incidental reading of "how much data it took to
// see this"; the bar's extent here is just the evidence, not a measure of
// confidence.
function confirmChange(
  values: readonly number[],
  at: number,
  lowLimit: number,
  highLimit: number,
): Confirmation | null {
  const windowStart = Math.max(lowLimit, at - WINDOW_PUSHES);
  const windowEnd = Math.min(highLimit, at + WINDOW_PUSHES);
  const beforeCount = at - windowStart;
  const afterCount = windowEnd - at;
  if (beforeCount < MIN_WINDOW_PUSHES || afterCount < MIN_WINDOW_PUSHES) return null;

  const before = values.slice(windowStart, at);
  const after = values.slice(at, windowEnd);
  const test = mannWhitneyU(before, after);
  // `test.significant` is the 0.05 the rest of the app reports against; this
  // wants its own, stricter bar. See CHANGE_ALPHA.
  if (!test || test.pValue >= CHANGE_ALPHA) return null;

  const beforeValue = mean(before);
  const afterValue = mean(after);
  const relative = relativeChange(beforeValue, afterValue);
  if (relative === null || Math.abs(relative) < MIN_RELATIVE_CHANGE) return null;

  return {
    windowStart,
    windowEnd,
    beforeCount,
    afterCount,
    beforeValue,
    afterValue,
    relativeChange: relative,
    pValue: test.pValue,
    effectSize: test.effectSize,
  };
}

// Every step in one series, in time order.
//
// `lowerIsBetter` comes from the signature's own metadata and decides only
// which steps are regressions — never the sign of the delta on its own, for the
// same reason compare.ts refuses to (half of perfherder's metrics are
// higher-is-better).
export function detectChanges(
  pushes: readonly PushGroup[],
  lowerIsBetter: boolean,
): DetectedChange[] {
  if (pushes.length < MIN_WINDOW_PUSHES * 2) return [];
  const values = pushes.map((p) => p.mean);
  const boundaries = segmentValues(values);

  const out: DetectedChange[] = [];
  for (let b = 1; b < boundaries.length - 1; b++) {
    const at = boundaries[b];
    const confirmed = confirmChange(values, at, boundaries[b - 1], boundaries[b + 1]);
    if (!confirmed) continue;
    const before = pushes[at - 1];
    const after = pushes[at];
    out.push({
      ...confirmed,
      index: at,
      x0: pushes[confirmed.windowStart].x,
      x1: pushes[confirmed.windowEnd - 1].x,
      changeX: (before.x + after.x) / 2,
      // `significant` is true by construction here — `confirmChange` returned —
      // so this asks only "which way is bad", and the two values differ by at
      // least MIN_RELATIVE_CHANGE so it can't come back 'none'.
      isRegression:
        changeDirection(
          confirmed.beforeValue,
          confirmed.afterValue,
          lowerIsBetter,
          true,
        ) === 'regression',
      beforePushId: before.pushId,
      afterPushId: after.pushId,
    });
  }
  return out;
}
