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
// deviations are listed under "Deviations from perf.webkit.org" below. The third
// stage — re-estimating the confirmed boundary's index with a rank statistic,
// see `relocate` — is not theirs, and exists because a single bad job can walk
// the segmentation's boundary several pushes off the step it found.
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
// change. `windowLimits` is where the clipping happens, and says what
// "neighbouring" has to mean for a short outlier segment not to silence the step
// beside it.
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
  // Index into the series' `pushes` of the first push *after* the step. From the
  // rank relocation below, not from the segmentation's boundary.
  index: number;
  // The pushes the test compared, as a half-open index range containing
  // `index`. Also what the annotation bar spans. It is the *candidate's* window,
  // so `index` sits inside it but not necessarily in the middle of it.
  windowStart: number;
  windowEnd: number;
  beforeCount: number;
  afterCount: number;
  // Push timestamps at `windowStart` and at `windowEnd - 1` — the bar's extent.
  x0: number;
  x1: number;
  // The x of the first push after the step — the vertex where the connecting
  // line kinks.
  //
  // Halfway between that push and the one before it is the honester estimate,
  // since the step happened somewhere in that gap and nothing here can say
  // where, and that is what this was at first. It read as a bug: at a tight
  // zoom half a push gap is minutes wide, so the notch stood visibly beside the
  // kink it was pointing at, and a mark that doesn't line up with the line the
  // reader is looking at doesn't get the benefit of the doubt. The bar is what
  // carries the "somewhere in here" part.
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
  | 'index'
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

// Which cut in this window separates it best? The step's index, re-estimated.
//
// The segmentation answers this with the variance cost, and a single bad job can
// buy the answer. Observed on autoland signature 299010 (tresize, 2026-07-23):
// one push's three runs came back 8.20 / 6.26 / 8.29, and the boundary landed on
// *it* rather than on the real step eight pushes later. Holding that one push
// out of the pre-step segment kept that segment's variance at 0.0028 instead of
// 0.0085, worth ~65 in cost over its 58 pushes, while dropping it into the
// post-step segment cost only ~43 — that segment already spanning the real step,
// so its variance was large either way. One low job won by 17.
//
// The confirmation stage can't catch that, because a ±24-push window straddles
// the real step from either index: the test says "a step is in here" and the
// index says where, and only the index is wrong. What that cost downstream was
// the notch drawn ten minutes early, a delta understating the step (−3.4%
// against −4.5%, seven pushes still at the old level sitting in the "after"
// pool) and the wrong pair of pushes pinned by a click.
//
// So the index is re-estimated with a rank statistic instead: the cut that
// separates the window's two sides most cleanly, by the same Mann-Whitney the
// confirmation runs. Ranks don't care *how far* the bad job fell, only that it is
// one value out of place among ~48, so on the fixture above the peak sits on the
// real step rather than on the outlier. Re-minimizing the variance cost inside
// the window does not work — it picks the outlier again, for the same reason it
// picked it in the first place.
//
// **Cliff's delta and not |z|**, though the two rank the cuts almost identically.
// A z is standardized by a null deviation that grows with `n1 · n2`, so of two
// splits that separate the window equally well it prefers the more balanced one —
// which is a pull toward the middle of the window, and the middle of the window
// is exactly where the candidate we are trying to get away from sits. On a
// fixture whose step is eight pushes off-centre that bias is worth a push: |z|
// peaks one short of the step, trading a pair of misranked values for a better
// balanced pool. δ is a fraction of pairs, so balance doesn't enter into it.
//
// **Estimation, not testing.** The gate stays the test at the segmentation's own
// boundary — the one p-value in here that wasn't chosen after looking at the
// data — so relocation cannot add a change this file would not otherwise have
// found. It moves where a change is reported and which numbers describe it. The
// p-value reported with it comes from the split that separates best out of ~37,
// so it reads as "how cleanly do the two sides separate" and not as a
// false-positive rate.
//
// Cuts stay MIN_WINDOW_PUSHES from both ends of the window, so the estimate
// never rests on fewer pushes than the test itself would accept, and the notch
// stays inside its own bar. A step within six pushes of the window's edge is
// therefore not reachable — but the candidate is at most WINDOW_PUSHES from it to
// begin with, so this bounds an error rather than introducing one.
//
// On a tie the cut nearest the candidate wins, the candidate itself included.
// Ties are real: δ saturates at 1 as soon as a split separates the window
// perfectly, and where two adjacent splits both do there is nothing in the data
// to choose between them, so the segmentation's opinion is as good as any.
export function relocateBoundary(
  values: readonly number[],
  windowStart: number,
  windowEnd: number,
  candidate: number,
): number {
  const separation = (cut: number): number => {
    const test = mannWhitneyU(values.slice(windowStart, cut), values.slice(cut, windowEnd));
    return test ? Math.abs(test.cliffsDelta) : -1;
  };
  // The candidate is the incumbent, which is what settles a tie at any distance
  // from it — including a tie with itself.
  let bestCut = candidate;
  let best = separation(candidate);
  for (let cut = windowStart + MIN_WINDOW_PUSHES; cut <= windowEnd - MIN_WINDOW_PUSHES; cut++) {
    const delta = separation(cut);
    if (
      delta > best ||
      (delta === best && Math.abs(cut - candidate) < Math.abs(bestCut - candidate))
    ) {
      best = delta;
      bestCut = cut;
    }
  }
  return bestCut;
}

// How far a candidate's window may reach on each side: the nearest boundary that
// still leaves MIN_WINDOW_PUSHES between itself and the candidate.
//
// Clipping at a neighbouring boundary is what a window has to do — a pool that
// crosses another step averages two levels and describes neither — but clipping
// at the *immediate* neighbour lets a short outlier segment silence the real step
// beside it. The segmentation isolates a bad push readily (that is what
// MIN_SEGMENT allows it to do, and rejecting the boundaries around it is the
// confirmation stage's job), and when it does that within six pushes of a real
// step, both candidates die on the pool-size check: the step's own window is
// clipped to the four or five pushes between it and the blip, and the blip's is
// clipped to the same handful the other way. Neither says anything, so a step
// with thirty clean pushes either side of it goes unmarked because something
// twitched four pushes earlier. Synthetically reproducible, and the graph's most
// annoying failure is the one where nothing is drawn.
//
// So a boundary closer than MIN_WINDOW_PUSHES is not treated as a wall; the pool
// absorbs the pushes beyond it and reaches for the next boundary instead. This
// is the one place a window can cross a boundary, and what it can cross is at
// most five pushes' worth — a rank test carries five contaminating values out of
// twenty-four without changing its mind, which is exactly why the test is a rank
// test. A boundary with six or more pushes behind it is still a wall.
//
// **What this does not fix**, and graphs-todo.md carries as deferred: a wall at
// exactly MIN_WINDOW_PUSHES leaves a legal pool of six that may still be the
// blip's, one of whose values is the bad push — enough to keep the p-value off
// 0.01 and silence the step anyway. Reproducible from the fixture in
// changes.test.ts ("is not silenced by an outlier segmented off next to the
// step") by moving the step one push further away. The rule that would cover it is
// "only a *confirmed* change is a wall", which means confirming greedily
// strongest-first with the walls growing as it goes, and that is a different
// algorithm rather than a wider constant.
function windowLimits(boundaries: readonly number[], at: number): [number, number] {
  let low = boundaries[0];
  let high = boundaries[boundaries.length - 1];
  for (const boundary of boundaries) {
    if (boundary <= at - MIN_WINDOW_PUSHES) low = boundary;
    else if (boundary >= at + MIN_WINDOW_PUSHES) {
      high = boundary;
      break;
    }
  }
  return [low, high];
}

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
  if (at - windowStart < MIN_WINDOW_PUSHES || windowEnd - at < MIN_WINDOW_PUSHES) return null;

  // The gate, at the segmentation's own boundary. See `relocateBoundary` for why
  // the relocated split is not what decides there is a step here.
  const gate = mannWhitneyU(values.slice(windowStart, at), values.slice(at, windowEnd));
  // `gate.significant` is the 0.05 the rest of the app reports against; this
  // wants its own, stricter bar. See CHANGE_ALPHA.
  if (!gate || gate.pValue >= CHANGE_ALPHA) return null;

  const index = relocateBoundary(values, windowStart, windowEnd, at);
  const before = values.slice(windowStart, index);
  const after = values.slice(index, windowEnd);
  const test = index === at ? gate : mannWhitneyU(before, after);
  // The relocated split has to clear the same bar, which is not a second bite at
  // the apple: requiring *both* splits to pass can only ever remove a change
  // this file would have drawn, never add one. What it buys is a card that never
  // prints a p-value above the α it says it works to — δ chooses the split, and δ
  // is not the p-value, so the two can in principle disagree.
  if (!test || test.pValue >= CHANGE_ALPHA) return null;

  const beforeValue = mean(before);
  const afterValue = mean(after);
  const relative = relativeChange(beforeValue, afterValue);
  // Applied to the relocated split, not to the candidate's: a boundary sitting
  // on an outlier understates its own step, and dropping a change for a delta
  // that only the wrong index made small would be the same bug twice.
  if (relative === null || Math.abs(relative) < MIN_RELATIVE_CHANGE) return null;

  return {
    index,
    windowStart,
    windowEnd,
    beforeCount: index - windowStart,
    afterCount: windowEnd - index,
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
    const [lowLimit, highLimit] = windowLimits(boundaries, at);
    const confirmed = confirmChange(values, at, lowLimit, highLimit);
    if (!confirmed) continue;
    const before = pushes[confirmed.index - 1];
    const after = pushes[confirmed.index];
    out.push({
      ...confirmed,
      x0: pushes[confirmed.windowStart].x,
      x1: pushes[confirmed.windowEnd - 1].x,
      changeX: after.x,
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

  // Two candidates can describe the same step. Their windows overlap — heavily,
  // once a short segment between them has stopped being a wall — so one real step
  // can be the best cut for both, and after relocation they come back on the same
  // push or a couple of pushes apart. Drawn, that is one step marked twice: two
  // notches, two cards in the pane saying nearly the same thing.
  //
  // So a change has to win its neighbourhood. Strongest evidence first, and a
  // change is dropped when one already accepted is within MIN_WINDOW_PUSHES of it
  // *in the same direction* — the same span over which the confirmation stage
  // would have refused to treat them as separable, and the same pool either way.
  //
  // Direction is in the rule because of the case it must not collapse: a
  // regression and the backout five pushes later are two changes, they are
  // supposed to draw two bars, and the only thing that tells them apart from one
  // step counted twice is that they point opposite ways.
  const accepted: DetectedChange[] = [];
  for (const change of [...out].sort((a, b) => a.pValue - b.pValue)) {
    const sameStep = accepted.some(
      (other) =>
        Math.abs(other.index - change.index) < MIN_WINDOW_PUSHES &&
        (other.index === change.index ||
          Math.sign(other.relativeChange) === Math.sign(change.relativeChange)),
    );
    if (!sameStep) accepted.push(change);
  }
  // Sorted at the end because a relocated index no longer has to be in the order
  // its candidate boundary was, let alone in p-value order.
  return accepted.sort((a, b) => a.index - b.index);
}
