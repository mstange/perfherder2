// Client-side change detection: where did this series step, and by how much.
//
// **Pure.** Input is a series' pushes; output is a list of confirmed steps. The
// drawing is chartDraw's, the layout annotations.ts's, the caching
// appState's.
//
// ## Every signature named below is a graph you can open
//
// The tuning in this file was not derived; it was measured, on five real series,
// and each of them is one URL in **"The series behind the tuning"** in
// docs/graphs.md — signature id, plotted range, what to expect in it, and which
// decision here it drove. Every `autoland signature NNNNNNN` in the comments
// below is a key into that table. Load the graph before changing the constant it
// justifies: the numbers quoted here were true when they were written and the
// data behind them keeps moving.
//
// ## Why this exists at all, given alerts.ts
//
// Perfherder's alerts are somebody else's verdict, and they exist only where
// somebody else's threshold fired. The gap that motivates this is recorded in
// graphs-todo.md under "Common alerts": plotting idb-open-many-seq
// `open_duration` on macOS (autoland signature 5350956) over a year shows not one
// alert marker, while its Windows counterpart (5350953) carries alert #51136 for
// the same change. Only one of the two crossed an alerting threshold. The macOS
// graph is not quiet; it is unannotated.
//
// **This file is also silent on that macOS series, and the table says why**: the
// same event is ~10.5% there against a per-push noise scale of 12.3% of the
// level, which is p = 0.04 over 24 pushes a side and does not clear CHANGE_ALPHA.
// The case that motivates a design is not automatically a case it fixes, and the
// gap this does close is the one on the installer-size row.
//
// So this is the second opinion, computed from the data on screen: no
// threshold policy, no server round-trip, and it works on any series including
// ones perfherder never analysed.
//
// The prior art is perf.webkit.org's charts view (`public/shared/statistics.js` and
// `public/v3/pages/chart-pane.js`, the "Segmentation with Welch's t-test change
// detection" trend line). The two-stage shape — find where a step might be, then
// test the points either side of it — is theirs. Neither stage is any longer the one
// they use, and the deviations are listed under "Deviations from perf.webkit.org"
// below.
//
// ## Three stages
//
// 1. **Propose**, `candidateBoundaries`. Binary segmentation: split the series at
//    its sharpest CUSUM contrast, recurse into both halves, stop when a stretch is
//    too short or its sharpest split isn't sharp enough. Cheap, parametric, and
//    scored against a scale estimated *inside* each stretch — which is the whole
//    point, and what the Schwarz-criterion dynamic program this replaced could not
//    do at any setting of its penalty.
// 2. **Confirm**, `detectChanges` and `gateChange`. Greedy forward selection: gate
//    every candidate with a rank test on the pushes either side, accept the
//    strongest, make its index a wall that no later pool may cross, and go round
//    again. Nothing but an accepted change is a wall, which is what stops a
//    fenced-off outlier silencing the step beside it, and re-testing every round is
//    what lets a regression and its backout confirm each other.
// 3. **Locate**, `relocateBoundary`. Re-estimate the accepted index as the cut with
//    the cleanest rank separation *for its pool sizes*, because a proposed cut is a
//    mean-based statistic and one bad run walks it — and because a rank separation
//    that ignores its pool sizes is maximised by the smallest pool there is, which
//    walked it further than the outlier ever did.
//
// ## How small is too small comes from the signature, not from here
//
// The one number in this file that isn't a property of the data is how big a step
// has to be to be worth a mark, and it can't be a constant: 0.5% is a fifth of
// awsy's alerting bar and forty times the noise floor of an installer-size series.
// So the caller passes the signature's own `AlertThreshold` — perfherder's, read
// off the summary endpoint, in percent or in the metric's own units — and
// THRESHOLD_FRACTION scales it down to something well below the bar a sheriff sees.
// A signature that declares nothing gets perfherder's global 2%, which lands the
// floor exactly where the old constant was.
//
// ## The unit of analysis is the push mean, not the run and not the replicate
//
// This app has something perf.webkit.org doesn't: tens of replicate values per
// run, and often several runs per push. It is tempting to feed them all in, and
// it would be wrong — but the two levels are not dependent in the same way, and
// the imprecise version of this argument names the wrong confound.
//
// Replicates within one run share everything: a machine, a binary, a moment.
// They are repeated measurements of one number, and pooling them is flagrant —
// a rank-sum test over 20 replicates a side calls *every* adjacent pair of pushes
// different and paints the whole graph.
//
// Runs of one push are the interesting case, because they need not share a
// machine, so machine-to-machine variation is something they *do* sample. What
// every run of a push shares is the binary and the moment — and that is where
// most of the noise lives. Measured over the 65-push plateau before the
// 2026-07-23 step on autoland signature 299010, with robust spreads so that the
// outlier pushes don't set the scale: two runs of the same push differ with an sd
// of 0.039 ms, while push means sitting at the same level differ with an sd of
// 0.056 ms. Netting the run noise out of the second leaves three quarters of the
// variance as build-and-moment — PGO layout luck, infra weather, whatever the
// machines were doing that hour — and no number of retriggers on one push reaches
// it. (Two runs a push is the median here, so this is a two-sample estimate of
// the run term; it is a scale, not a precise decomposition.)
//
// Pooling run values would therefore contribute k values per push but only one
// draw of the term that dominates. That is the clustered-data trap: the effective
// n is the push count, and a test told otherwise reports a p-value it hasn't
// earned. Milder than the replicate version, and the same mistake.
//
// So the values here are `PushGroup.mean`, one per push: the same number the
// connecting line joins. What the runs and replicates earn is the precision of
// that one value — and, as `relocateBoundary` records, a single bad run can still
// drag it, which is an argument for summarising a push more robustly, not for
// unpooling.

import type { AlertThreshold, PushGroup } from './graphData';
import {
  changeDirection,
  mannWhitneyU,
  mean,
  median,
  relativeChange,
  type EffectSize,
  type MannWhitneyResult,
} from '../shared/stats';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

// How many pushes either side of a candidate the confirmation test looks at,
// clipped so that a pool never crosses another change — `wallsAround` for what
// counts as one, and `gateChange` for the stretch bound that goes with it.
//
// 24 is `PERFHERDER_ALERTS_MAX_BACK_WINDOW` (treeherder/perf/alerts.py), which
// is deliberate rather than coincidental: perfherder's own alert quotes means
// over 12–24 pushes back against 12 forward, and both cards can end up in the
// details pane at once. Sizing this window the same way means the two "before →
// after" pairs are on the same scale, so where they differ it is because the
// two analyses disagree and not because one of them averaged ten times as much
// data as the other.
// Exported because the CLI's `step` command measures a change at a point the
// caller names rather than one this file located, and it sizes its windows the
// same way so the two are on one scale — the same argument that ties this
// constant to perfherder's own.
export const WINDOW_PUSHES = 24;

// How sure the test has to be. **Not `SIGNIFICANCE_ALPHA`**, the 0.05 the
// comparison card reports against, and the difference is multiple comparisons:
// the card asks one question about two builds the user picked, while this asks
// one per candidate, on every plotted series, unprompted, and the greedy loop asks
// again each round. At 0.05 that is on the order of one manufactured bar per series
// per range, which for a feature that draws itself by default is the difference
// between a second opinion and a nuisance. CUSUM_THRESHOLD is the other half of the
// same budget: it decides how many candidates this α has to cover, and the two were
// measured together — see the table there.
// Exported for the same reason as WINDOW_PUSHES: `step` reports whether the
// change it measured would have cleared this bar, which is half the answer to
// "why is there no bar on this graph". Reimplementing the comparison there
// would let the two drift, and a tool whose whole claim is that it agrees with
// the app cannot afford a second opinion about the app's own α.
export const CHANGE_ALPHA = 0.01;

// Below this many pushes on a side, don't propose a cut and don't gate one. The
// two-sided Mann-Whitney U is a rank statistic, so *balanced* pools this small have
// a floor on the p-value they can reach however cleanly they separate: 0.030 at 4
// against 4 and 0.012 at 5 against 5, both above CHANGE_ALPHA. Six a side is the
// first that clears it (0.005), so less would be rejected by arithmetic rather than
// by evidence, and would waste a test saying so.
//
// **Only the proposal and the gate observe it.** Where the mark finally goes is
// bounded by `canReachAlpha` instead, which asks the same question of the actual
// pool sizes rather than of a balanced pair — 4 against 10 clears α, and holding the
// estimate to six would leave a step near the edge of the range marked on the wrong
// push. The knock-on is that a step is reported five pushes after it happens rather
// than six: the gate still needs its six a side, but the pool it fires on can
// straddle the step, and the estimate then slides onto it.
const MIN_WINDOW_PUSHES = 6;

// Changes smaller than this fraction of the signature's *own* alerting threshold
// are dropped even when the test can see them. With enough pushes a rank-sum test
// will happily certify a 0.05% drift, which is true and useless.
//
// **A fraction, and of the signature's threshold rather than a constant.** A
// quarter keeps this deliberately far below the bar perfherder alerts at, because
// catching the sub-threshold changes perfherder stays quiet about is the whole
// point (see the macOS example above) and a floor anywhere near theirs would
// rebuild the blind spot this is meant to cover. A quarter of perfherder's *global*
// default of 2% is 0.5%, which is exactly the constant this replaces — so nothing
// moves for a signature that declares no threshold, and this is only ever a change
// for one that does.
//
// Taking it from the signature is what makes the floor mean the same thing across
// frameworks, and the spread is far too wide for any constant to cover: autoland
// signatures declare 2%, 5%, 6% and 10% (talos, browsertime), 0.25% (awsy), 50%
// and 100% (build times), and 100 KB and 1 MB *absolute* (installer and apk size).
// A fixed 0.5% is a fifth of awsy's alerting bar and forty times the noise floor of
// an installer-size series: on autoland signatures 1954909 (`libxul.so`), 1668132
// (`xul.dll`) and 5688441 (`aarch64`) — the installer-size row of the table, one
// week — the entire spread is 0.14% and a real, attributable 340 KB step is 0.18%,
// so every candidate was dropped and the graphs drew nothing at all. That is the
// bug this fixes. `AlertThreshold` is where the two units are described.
const THRESHOLD_FRACTION = 0.25;

// The size a change has to reach before this file will mark it, in whichever
// unit the signature states its threshold in. Exported alongside `clearsFloor`
// so a caller can *report* the floor rather than only test against it — the
// CLI's `step` prints it, since "the step is real but a quarter of the bar"
// and "the step is too noisy to call" are different answers to "why is there no
// bar here" and the reader needs to know which they got.
export function detectionFloor(threshold: AlertThreshold): AlertThreshold {
  return { kind: threshold.kind, value: threshold.value * THRESHOLD_FRACTION };
}

// Does a change clear the floor its signature's threshold sets?
//
// The two kinds are not interchangeable and neither is a fallback for the other:
// `absolute` compares the difference of the two window means in the metric's own
// units, `percentage` compares the relative change. A percentage floor on a
// deterministic size metric admits everything, and an absolute floor on a timing
// metric measured in a different unit admits nothing.
export function clearsFloor(
  threshold: AlertThreshold,
  beforeValue: number,
  afterValue: number,
  relative: number,
): boolean {
  const floor = threshold.value * THRESHOLD_FRACTION;
  return threshold.kind === 'absolute'
    ? Math.abs(afterValue - beforeValue) >= floor
    : Math.abs(relative) * 100 >= floor;
}

// ---------------------------------------------------------------------------
// Proposal
// ---------------------------------------------------------------------------

// A robust spread for one stretch, from successive differences.
//
// `median|xᵢ₊₁ − xᵢ| · 1.4826 / √2` — the MAD-to-sigma factor, and the √2 because
// a difference of two draws has twice the variance of one. Two properties earn it
// over a plain sd of the stretch:
//
//   - **Blind to level changes.** A stretch containing a step has a large sd and
//     the same median difference as one without, which is the point: the scale a
//     step is measured against must not be inflated by the step.
//   - **Blind to a handful of bad pushes.** A median over ~n differences shrugs off
//     the outlier runs CI produces; an sd squares them.
function localScale(values: readonly number[], lo: number, hi: number): number {
  const diffs: number[] = [];
  for (let i = lo + 1; i < hi; i++) diffs.push(Math.abs(values[i] - values[i - 1]));
  return diffs.length ? (median(diffs) * 1.4826) / Math.SQRT2 : 0;
}

// The cut that splits [lo, hi) most sharply, and how sharply, in units of the
// stretch's own scale.
//
// The statistic is the standard CUSUM contrast for a change in mean,
// `|mean(cut, hi) − mean(lo, cut)| · √(n₁n₂/(n₁+n₂)) / scale`: a difference of
// means, weighted so that a split with more data on both sides counts for more,
// divided by what the stretch's own noise would produce. Means come from prefix
// sums, so the whole scan is O(hi − lo).
//
// **Parametric, on purpose, and only here.** This is the cheap scan that decides
// what is worth testing; the test that decides what gets drawn is the rank test in
// `gateChange`, which never sees this number. A Gaussian-flavoured statistic is
// fine for proposing and would not be fine for confirming.
function strongestCut(
  values: readonly number[],
  sums: Float64Array,
  lo: number,
  hi: number,
): { cut: number; statistic: number } | null {
  let bestCut = -1;
  let bestWeighted = 0;
  for (let cut = lo + MIN_WINDOW_PUSHES; cut <= hi - MIN_WINDOW_PUSHES; cut++) {
    const nBefore = cut - lo;
    const nAfter = hi - cut;
    const meanBefore = (sums[cut] - sums[lo]) / nBefore;
    const meanAfter = (sums[hi] - sums[cut]) / nAfter;
    const weighted =
      Math.abs(meanAfter - meanBefore) * Math.sqrt((nBefore * nAfter) / (nBefore + nAfter));
    if (weighted > bestWeighted) {
      bestWeighted = weighted;
      bestCut = cut;
    }
  }
  if (bestCut < 0) return null;
  // The scale is constant across the scan, so dividing at the end rather than
  // inside the loop picks the same cut — and leaves the degenerate case somewhere
  // it can be answered: a stretch of identical values has no scale, and a split of
  // one that isn't flat is as sharp as a split gets.
  const scale = localScale(values, lo, hi);
  const statistic = scale > 0 ? bestWeighted / scale : bestWeighted > 0 ? Infinity : 0;
  return { cut: bestCut, statistic };
}

// How sharp a split has to look before it is worth a test.
//
// Under the null the largest CUSUM over a stretch of n points grows like
// √(2 log n), which is 3.5 at n = 500, and that is the number: the point where the
// sharpest split in a few hundred pushes stops being what noise ordinarily
// produces. It is not the verdict — the confirmation stage has its own α, its own
// effect-size floor and a rank test rather than this Gaussian one — so what this
// controls is how much gets tested, and therefore how much multiple-comparison
// exposure the α is asked to absorb.
//
// Measured over 40 synthetic series of 500 pushes each, and two of the table's
// real signatures — autoland 299010 (tresize) and 5352791 (the wandering
// speedometer3 subtest) — at α = 0.01. "n/m alerts" is how many of perfherder's
// own alerts on that graph got a bar:
//
//   threshold   flat noise   +4% drift   sig 299010   sig 5352791
//   3           2 bars       34 bars     5/6 alerts   6/8 alerts
//   3.5         0 bars       32 bars     5/6 alerts   4/8 alerts
//   4           0 bars       27 bars     5/6 alerts   4/8 alerts
//
// The two alerts 3 finds and 3.5 doesn't are 5352791's +2.09% and −2.08% fifteen
// pushes apart, which cancel and which are invisible among that series' well
// measured pushes — perfherder sees them because it counts its windows in job
// values, so on a series retriggered twelve times a push it is comparing adjacent
// pushes with the runs pooled. Recall measured against alerts that shouldn't be
// there is not recall, and it cost two bars on pure noise, which for something
// drawn by default is the wrong trade. 4 measures the same as 3.5 on both real
// series and is a little quieter on drift; 3.5 is where the theory puts it.
const CUSUM_THRESHOLD = 3.5;

// Every cut worth testing, in ascending order.
//
// Binary segmentation: split the whole series at its sharpest cut, then recurse
// into both halves, stopping when a stretch is too short to test or its sharpest
// cut isn't sharp enough. This replaced a dynamic program that scored a whole
// 500-push grid against a penalised Schwarz criterion, and the reason is
// **locality**, not cost:
//
// The DP chose one segment count for the entire grid, so its sensitivity came from
// the grid's total spread. On autoland signature 5352791 — recorded as
// fixtures/push-means-wandering.json, and the case that drove all of this — the
// level wanders over 65–68 while one push in six carries a single run (robust
// push-mean sd 0.755 against 0.378 for pushes with ten or more). A 6σ step against
// its own neighbourhood is nothing against that, and the DP returned a single
// segment covering everything past push 290: the confirmation stage was never
// offered the boundary, and perfherder's alert stood there unanswered. Loosening
// the penalty constant recovered that one step and could not fix the shape of the
// problem, which is that one number cannot describe a series whose noise varies
// fourfold across it.
//
// Recursion fixes it by construction: each stretch is scored against a scale
// estimated inside that stretch. The first split takes out the biggest move, and
// what was invisible beside it becomes obvious once the halves are scored on their
// own. Cost is O(n) per level of recursion, so a series is O(n·k) rather than the
// DP's O(n²k) — which is why the grid, its size constant, the segment-count
// ceiling and the variance floor are all gone with it.
// A proposed cut, with the stretch it was found in. The stretch matters as much as
// the cut: see `gateChange`, where it bounds that candidate's pool and nobody
// else's.
export type Candidate = {
  cut: number;
  stretchStart: number;
  stretchEnd: number;
};

export function candidateBoundaries(values: readonly number[]): Candidate[] {
  const sums = new Float64Array(values.length + 1);
  for (let i = 0; i < values.length; i++) sums[i + 1] = sums[i] + values[i];

  const out: Candidate[] = [];
  const visit = (lo: number, hi: number): void => {
    if (hi - lo < MIN_WINDOW_PUSHES * 2) return;
    const best = strongestCut(values, sums, lo, hi);
    if (!best || best.statistic < CUSUM_THRESHOLD) return;
    out.push({ cut: best.cut, stretchStart: lo, stretchEnd: hi });
    visit(lo, best.cut);
    visit(best.cut, hi);
  };
  visit(0, values.length);
  return out.sort((a, b) => a.cut - b.cut);
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
  // (after − before) / before. Never null — a candidate whose baseline is zero
  // isn't returned. It can be arbitrarily small when the signature's floor is an
  // absolute one, since then it is `afterValue - beforeValue` that cleared the
  // bar and this is only the way of expressing it.
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
// Could the rank test clear α at these pool sizes at all?
//
// The Mann-Whitney U is a rank statistic, so each pair of pool sizes has a floor on
// the p-value it can produce *however cleanly* the two groups separate: 0.030 at 4
// against 4, 0.012 at 5 against 5, 0.006 at 4 against 10. Asking the test itself —
// two perfectly separated pools of the right sizes — keeps this honest with whatever
// `mannWhitneyU` does about ties and continuity, instead of restating its arithmetic
// here and drifting from it.
function canReachAlpha(nBefore: number, nAfter: number): boolean {
  if (nBefore < 1 || nAfter < 1) return false;
  const before = Array.from({ length: nBefore }, (_, i) => i);
  const after = Array.from({ length: nAfter }, (_, i) => nBefore + i);
  const test = mannWhitneyU(before, after);
  return test !== null && test.pValue < CHANGE_ALPHA;
}

// How far a Cliff's delta computed from these two pool sizes would scatter under
// the null: `√(Var(U) · 4 / (n₁n₂)²)` with `Var(U) = n₁n₂(n₁+n₂+1)/12`, which is
// what the whole expression reduces to.
//
// The *null* deviation rather than a sample one (Cliff's own variance estimator,
// say), for two reasons. It is the same quantity `mannWhitneyU` standardizes by, so
// the penalty and the p-value beside it describe the same scale. And it depends on
// nothing but the two sizes, so it is a property of the split being *considered*
// rather than of how well that split happened to come out — which is what makes it
// a fair charge to levy on every candidate. A real effect scatters less than the
// null, so this over-charges every split a little and the splits it over-charges
// most are the small ones. That is the direction to err in.
function deltaStandardError(n1: number, n2: number): number {
  return Math.sqrt((n1 + n2 + 1) / (3 * n1 * n2));
}

// A proposed cut is not a reliable index. One bad run walks it: observed on
// autoland signature 299010 (tresize, 2026-07-23), where one push's three runs came
// back 8.20 / 6.26 / 8.29 and the boundary landed on *it* rather than on the real
// step eight pushes later, because the segmentation that then proposed cuts scored
// variance and holding that one push out of the pre-step segment was worth more than
// putting it into the post-step one cost. The CUSUM scan that proposes cuts now is
// less easily fooled — a mean shift weighted by pool size, against a median-based
// scale — but it is still a mean, and a single bad push still pulls it.
//
// The confirmation stage can't catch that either way, because a ±24-push window
// straddles the real step from either index: the test says "a step is in here" and
// the index says where, and only the index is wrong. What that cost downstream was
// the notch drawn ten minutes early, a delta understating the step (−3.4% against
// −4.5%, seven pushes still at the old level sitting in the "after" pool) and the
// wrong pair of pushes pinned by a click.
//
// So the index is re-estimated with a rank statistic: the cut that separates the
// window's two sides most cleanly, by the same Mann-Whitney the confirmation runs.
// Ranks don't care *how far* the bad push fell, only that it is one value out of
// place among ~48, so on the fixture above the peak sits on the real step rather
// than on the outlier.
//
// **Cliff's delta, minus one standard error of it**, and the correction is not a
// refinement — without it this walks straight off the end of the window.
//
// Bare δ is a fraction of pairs, so it says nothing about how many pairs it was
// computed from, and it is *maximised at the smallest pool the window allows*. A
// 3-vs-45 split needs only three luckily-low values at one end to separate
// perfectly and score 1.000, which beats the real step's 0.90 every time. Over the
// 92 gated candidates in four of the table's series, bare δ landed on a pool of four
// or fewer a side 8 times, and 4 of those then failed the α re-check below and lost
// the change altogether. On `idb-open-many-seq open_duration` (autoland signature
// 5350953, the Windows row) it cost both failures at once: the 2026-06-23 step that
// perfherder alerted on (#51136) was reported 16 pushes and 21 hours early on a
// 4-vs-44 split, and a second real +4.6% step on 2026-07-30 relocated to a 3-vs-45
// split at p = 0.067 and vanished. Open that graph; both are on it.
//
// The fix is to compare the candidates on the same footing, which means charging
// each one the imprecision of its own estimate: `√((n₁+n₂+1)/(3·n₁·n₂))`, the null
// standard deviation of δ. It is 0.30 at 4-vs-44 and 0.17 at 20-vs-28, so the
// 4-vs-44 split has to separate a sixth of a pair-fraction better to win, and on
// that series it doesn't. The two failures above become 98 (the alert's own push,
// p = 3e-8) and 24-vs-24 at p = 2e-4.
//
// **Not |z|**, which is the other way to weight δ by its precision, and the reason
// is the opposite failure. z is δ *divided* by that deviation, which is a strong
// enough preference for balance to pull the estimate toward the middle of the
// window — and the middle of the window is where the candidate we are trying to get
// away from sits. On the 299010 fixture below, |z| peaks one push short of the step,
// trading a pair of misranked values for a better balanced pool. Subtracting one
// standard error instead leaves splits of comparable size ranked by δ alone, since
// their penalties are within a hair of each other, and only bites when the sizes
// are far apart — which is exactly when the δ estimates aren't comparable.
//
// One standard error is a correction and not a guarantee: where the real step
// separates weakly enough (δ ≈ 0.78 against a perfect 1.000 at 3-vs-45) the tiny
// pool still wins. What it buys is that a *clean* step is no longer beaten by three
// lucky values.
//
// **Estimation, not testing.** The gate stays the test at the proposed cut — the one
// p-value in here that wasn't chosen after looking at the data — so relocation
// cannot add a change this file would not otherwise have found. It moves where a
// change is reported and which numbers describe it. The p-value reported with it
// comes from the split that separates best out of ~40, so it reads as "how cleanly
// do the two sides separate" and not as a false-positive rate.
//
// **Any split the test could reach α at is a candidate location**, which is looser
// than the gate's MIN_WINDOW_PUSHES a side and deliberately so. The proposal stage
// cannot place a cut closer than MIN_WINDOW_PUSHES to the end of the stretch it is
// scanning, so when the step is closer than that — at the start of the plotted
// range, or a few pushes after another change — the sharpest *reachable* cut sits
// beside the step with the step inside one of its pools. Holding the estimate to the
// same floor would leave it there, reporting a real change at the wrong push, with a
// delta diluted by the values on the wrong side of it and a click pinning two
// pushes that are both after the step. Letting it slide to a 5-vs-10 split instead
// reports the step where it is. What bounds the slide is arithmetic rather than a
// constant: `canReachAlpha` asks the rank test itself what the smallest p-value at
// those two pool sizes even is, and a split that could not clear α however cleanly
// it separates is not somewhere to put a mark. That works out at three pushes as the
// hard floor, and the relocated split then has to clear α for real below.
//
// On a tie the cut nearest the candidate wins, the candidate itself included.
// Ties are real: δ saturates at 1 as soon as a split separates the window
// perfectly, and two splits that both do and have the same pool sizes score
// identically, so there is nothing in the data to choose between them and the
// proposal's opinion is as good as any.
// Every split in the window that could be where the step is, each with the
// score above. Exported because "which of these pushes is it?" is a question
// with no answer in the app — a bar is a point estimate and carries no
// interval — and on one real series the detector's estimate sat five hours
// before the push a sheriff's independent alert landed on. The CLI's `locate`
// ranks these, and it has to rank them by *this* score rather than by one of
// its own, or it would be answering a different question from the one the bars
// answer.
export type BoundaryCandidate = {
  // Index of the first push *after* the split, as `DetectedChange.index` is.
  cut: number;
  nBefore: number;
  nAfter: number;
  test: MannWhitneyResult;
  // |Cliff's δ| less one null standard error of it. See above for both halves.
  score: number;
};

export function boundaryCandidates(
  values: readonly number[],
  windowStart: number,
  windowEnd: number,
): BoundaryCandidate[] {
  const out: BoundaryCandidate[] = [];
  for (let cut = windowStart + 1; cut < windowEnd; cut++) {
    const nBefore = cut - windowStart;
    const nAfter = windowEnd - cut;
    if (!canReachAlpha(nBefore, nAfter)) continue;
    const test = mannWhitneyU(values.slice(windowStart, cut), values.slice(cut, windowEnd));
    if (!test) continue;
    out.push({
      cut,
      nBefore,
      nAfter,
      test,
      score: Math.abs(test.cliffsDelta) - deltaStandardError(nBefore, nAfter),
    });
  }
  return out;
}

export function relocateBoundary(
  values: readonly number[],
  windowStart: number,
  windowEnd: number,
  candidate: number,
): number {
  const separation = (cut: number): number => {
    const test = mannWhitneyU(values.slice(windowStart, cut), values.slice(cut, windowEnd));
    if (!test) return -1;
    return Math.abs(test.cliffsDelta) - deltaStandardError(cut - windowStart, windowEnd - cut);
  };
  // The candidate is the incumbent, which is what settles a tie at any distance
  // from it — including a tie with itself. It is scored directly rather than
  // looked up among the candidates, because the proposal may sit at pool sizes
  // `canReachAlpha` rejects and it still has to be the fallback.
  let bestCut = candidate;
  let best = separation(candidate);
  for (const { cut, score } of boundaryCandidates(values, windowStart, windowEnd)) {
    if (
      score > best ||
      (score === best && Math.abs(cut - candidate) < Math.abs(bestCut - candidate))
    ) {
      best = score;
      bestCut = cut;
    }
  }
  return bestCut;
}

// How far a candidate's window may reach on each side: to the nearest *accepted*
// change, or to the end of the series.
//
// A pool must not cross a step, or it averages two levels and describes neither.
// The question is what counts as a step while the answer is still being computed,
// and the version of this that scored candidate boundaries as walls got it wrong:
// the segmentation fences off a bad push readily, and a fenced-off outlier four
// pushes from a real step left the step's window clipped to those four pushes and
// the outlier's clipped to the same four the other way. Both died on the pool-size
// check, so a step with thirty clean pushes either side of it went unmarked because
// something twitched four pushes earlier. Exempting boundaries closer than
// MIN_WINDOW_PUSHES patched the common case and left a band just past it.
//
// Only an *accepted* change is a wall, which is the rule that covers all of it: a
// candidate no test has confirmed has no standing to stop another candidate being
// tested, and the outlier above is never confirmed — it can't be, a rank test over
// pools that differ by one value says so. `detectChanges` therefore confirms
// greedily, walls growing as changes are accepted, which is also what lets a
// candidate that failed against a wide window be retried against a narrow one: a
// regression and its backout are each other's evidence, and each looks like nothing
// until the other is a wall.
function wallsAround(walls: readonly number[], at: number): [number, number] {
  let low = 0;
  let high = walls[walls.length - 1];
  for (const wall of walls) {
    if (wall <= at) low = wall;
    else {
      high = wall;
      break;
    }
  }
  return [low, high];
}

// Does a candidate survive a test on the pushes either side? Two halves, because
// the greedy loop in `detectChanges` runs the first for every candidate on every
// pass and the second only for the one it accepts.
//
// A **fixed** window of up to WINDOW_PUSHES a side, clipped to the walls.
// perf.webkit.org instead grows a window outward from ±2 until its t-test turns
// significant and reports that window — which is optional stopping, so the p-value
// it prints is not the false-positive rate it looks like, and the means it prints
// come from the smallest sample that happened to clear the bar rather than from the
// best one available. A fixed window has one pool, one estimate and one p-value,
// all describing the same thing. What it gives up is perf.webkit.org's incidental
// reading of "how much data it took to see this"; the bar's extent here is just the
// evidence, not a measure of confidence.
type Gate = {
  windowStart: number;
  windowEnd: number;
  test: MannWhitneyResult;
};

function gateChange(
  values: readonly number[],
  candidate: Candidate,
  walls: readonly number[],
): Gate | null {
  const at = candidate.cut;
  const [wallLow, wallHigh] = wallsAround(walls, at);
  // Two different bounds, for two different reasons. The walls are what a pool must
  // not cross — an accepted change means the levels either side of it are not the
  // same thing. The stretch is where this candidate was *found*, and using it keeps
  // the pool inside the region the proposal stage was talking about: a cut that only
  // exists because its parent split took a bigger move out of the way should be
  // tested against the half it lives in, not against both. It is also what lets the
  // two ends of a blip bootstrap each other — see `detectChanges`.
  const windowStart = Math.max(wallLow, candidate.stretchStart, at - WINDOW_PUSHES);
  const windowEnd = Math.min(wallHigh, candidate.stretchEnd, at + WINDOW_PUSHES);
  if (at - windowStart < MIN_WINDOW_PUSHES || windowEnd - at < MIN_WINDOW_PUSHES) return null;

  // At the candidate's own index. See `relocateBoundary` for why the relocated
  // split is not what decides there is a step here.
  const test = mannWhitneyU(values.slice(windowStart, at), values.slice(at, windowEnd));
  // `test.significant` is the 0.05 the rest of the app reports against; this wants
  // its own, stricter bar. See CHANGE_ALPHA.
  if (!test || test.pValue >= CHANGE_ALPHA) return null;
  return { windowStart, windowEnd, test };
}

function describeChange(
  values: readonly number[],
  at: number,
  gate: Gate,
  threshold: AlertThreshold,
): Confirmation | null {
  const { windowStart, windowEnd } = gate;
  const index = relocateBoundary(values, windowStart, windowEnd, at);
  const before = values.slice(windowStart, index);
  const after = values.slice(index, windowEnd);
  const test = index === at ? gate.test : mannWhitneyU(before, after);
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
  //
  // A null `relative` is a zero baseline, and it is dropped whichever kind of
  // floor is in force — not because an absolute floor couldn't judge it, but
  // because `DetectedChange.relativeChange` is what the card leads with and a
  // series stepping off zero has no percentage to print.
  if (relative === null) return null;
  if (!clearsFloor(threshold, beforeValue, afterValue, relative)) return null;

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
// `lowerIsBetter` comes from the signature's own metadata and decides only which
// steps are regressions — never the sign of the delta on its own, for the same
// reason compare.ts refuses to (half of perfherder's metrics are higher-is-better).
//
// The loop is greedy forward selection: gate every candidate against the walls as
// they stand, accept the one with the strongest evidence, make its index a wall,
// and go round again. Three things fall out of it that the previous pass in
// boundary order had to handle by hand or couldn't handle at all:
//
//   - **A candidate that fails against a wide window gets retried against a narrow
//     one.** A regression and its backout dilute each other while both are
//     unconfirmed; accepting either one makes the other visible.
//   - **No unconfirmed candidate can veto a confirmed one.** See `wallsAround` for
//     the fenced-off outlier this fixes, which cost a whole step twice over.
//   - **One step can't be marked twice.** Once accepted, a change is a wall, so a
//     candidate within MIN_WINDOW_PUSHES of it no longer has a pool on that side —
//     which is the same span the neighbourhood dedupe this replaces had to
//     special-case, and it no longer needs a rule about direction to avoid eating a
//     genuine blip: a step at least MIN_WINDOW_PUSHES away still has its pool.
//
// Cost is `O(k²)` gates and `O(k)` relocations for k candidates, against `O(k)`
// gates before. Both are small next to what the proposal stage used to cost: 6 ms
// for the 752-push fixture, which has 32 candidates, where the dynamic program alone
// took 17.
export function detectChanges(
  pushes: readonly PushGroup[],
  lowerIsBetter: boolean,
  threshold: AlertThreshold,
): DetectedChange[] {
  if (pushes.length < MIN_WINDOW_PUSHES * 2) return [];
  const values = pushes.map((p) => p.mean);

  let pending = candidateBoundaries(values);
  const walls = [0, values.length];
  const confirmed: { candidate: Candidate; change: Confirmation }[] = [];

  for (;;) {
    const gated: { candidate: Candidate; gate: Gate }[] = [];
    for (const candidate of pending) {
      const gate = gateChange(values, candidate, walls);
      if (gate) gated.push({ candidate, gate });
    }
    gated.sort((a, b) => a.gate.test.pValue - b.gate.test.pValue);

    // Strongest first, and on to the next if the relocated split or the effect-size
    // floor turns one down — a candidate rejected there stays pending, since a wall
    // accepted later can change the answer.
    let accepted: Candidate | null = null;
    for (const { candidate, gate } of gated) {
      const change = describeChange(values, candidate.cut, gate, threshold);
      if (!change) continue;
      confirmed.push({ candidate, change });
      walls.push(change.index);
      walls.sort((a, b) => a - b);
      accepted = candidate;
      break;
    }
    if (!accepted) break;
    pending = pending.filter((candidate) => candidate !== accepted);
  }

  // Re-describe every change against the *final* walls. A change accepted early was
  // gated before the later ones existed, so its window could reach across a step
  // that is now known to be there, and the numbers on the card — a difference of
  // means, and the pushes the bar spans — would mix two levels. The verdict is not
  // revisited, only the description: an acceptance stands on the test that was run
  // at the time, and if the cleaner pools no longer clear α the original
  // description is what gets reported rather than a card contradicting its own bar.
  //
  // A refinement can in principle move an index, in which case the walls the other
  // changes were re-described against are the pre-refinement ones. Second order, and
  // not worth iterating to fixation over: the narrower window is a subset of the one
  // relocation already searched, so the index only moves if it had landed beyond a
  // wall that appeared later.
  const described = confirmed.map(({ candidate, change }) => {
    // Its own index is in `walls`, and a change is not a wall to itself.
    const others = walls.filter((wall) => wall !== change.index);
    const gate = gateChange(values, candidate, others);
    const refined = gate && describeChange(values, candidate.cut, gate, threshold);
    return refined ?? change;
  });

  return described
    .map((change) => {
      const before = pushes[change.index - 1];
      const after = pushes[change.index];
      return {
        ...change,
        x0: pushes[change.windowStart].x,
        x1: pushes[change.windowEnd - 1].x,
        changeX: after.x,
        // `significant` is true by construction here — `describeChange` returned —
        // so this asks only "which way is bad", and the two values cleared a
        // positive floor so it can't come back 'none'.
        isRegression:
          changeDirection(change.beforeValue, change.afterValue, lowerIsBetter, true) ===
          'regression',
        beforePushId: before.pushId,
        afterPushId: after.pushId,
      };
    })
    // Accepted in evidence order, drawn in time order.
    .sort((a, b) => a.index - b.index);
}
