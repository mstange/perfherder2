// What a series' scatter is *made of*. **Pure.**
//
// Every spread figure the app and the CLI printed before this module was the
// *push mean's* — `series`' `cv`, the distribution legend's `cv` — and on a
// retriggered platform that is the least informative of the three levels a
// measurement has. The noise trial in cli-todo.md is the worked example: a
// series whose push means scatter by 1.50% is made of jobs that scatter by
// 3.24%, and reading "cv 1.5%" as "this test is quiet" gets the remedy exactly
// backwards — the test is noisy and the four retriggers are doing the work.
//
// So this decomposes the three levels the data actually has:
//
//   replicate → run ("job") → push ("build")
//
// and then splits the job level again, because most of it turns out not to be
// the test at all:
//
//   device        which worker the job landed on
//   replicate     the sampling error of a run mean over its own replicates
//   unexplained   what is left: thermal state, background load, the test itself
//
// **The device term is measured out-of-sample, and it is a floor.** Each run is
// corrected by its machine's mean offset computed from every *other* push
// (`leaveOneOutOffsets`), so the figure is the variance a calibration actually
// removes rather than the variance a fit can absorb — 53 offsets fitted to 725
// runs would flatter themselves in-sample. It is a floor for a second reason
// too: a run is compared with a push mean it is one of n parts of, which shrinks
// every offset by (1 − 1/n).
//
// **Two things it deliberately does not do.** It does not correct the values
// anywhere — the app's numbers are the app's, and a corrected series is a series
// nobody measured (see docs/design.md, "Layout stability" for the sibling rule
// about inventing). And it declines the time-of-day question: every run of a
// push is submitted within minutes of the others, so anything shared by a push
// is removed along with the push, and a table of hourly means computed this way
// would be a row of zeroes wearing a conclusion.

import { formatPercent } from '../shared/chart';
import { mean, median, summarize } from '../shared/stats';
import { WINDOW_PUSHES } from './changes';
import type { PushGroup } from './graphData';
import { rollingTrend } from './trend';

// One level of the budget: a spread, and the same spread as a fraction of the
// series' level so it can be compared with another metric's.
export type NoiseTerm = {
  sd: number;
  // sd / level. The level is a mean of run means, never zero for a real
  // measurement, but guarded anyway.
  cv: number;
};

export type NoiseBudget = {
  // The scale everything here is a fraction of: the mean of the run means.
  level: number;
  runs: number;
  // Pushes with two or more runs — the only ones that can say anything about
  // job-to-job scatter, since a single-run push *is* its run.
  retriggeredPushes: number;
  // Median runs per retriggered push. The divisor in the resolution figures,
  // and reported because "a push mean" means something different at 4 and at 12.
  runsPerPush: number;
  // Median replicates per run, for the same reason.
  replicatesPerRun: number;

  // One replicate around its own run's mean. Null when no run has two.
  replicate: NoiseTerm | null;
  // One run around its own push's mean, pooled across pushes. **This is the
  // honest job-to-job figure**, and the one the other two are read against.
  // Null without a retriggered push.
  job: NoiseTerm | null;
  // Push means around the series level. What `series` has always printed, kept
  // under that meaning so the two commands cannot disagree.
  push: NoiseTerm | null;
  // Push means around their *own* rolling local level — the median of the
  // window centred on each, the curve the trend band draws.
  //
  // **This is the one the build term is computed from, and the difference
  // matters.** `push` above includes every real level change in the window: a
  // series that slides 8% over three months has a push-mean scatter dominated by
  // the slide, and calling that "build-to-build" would credit a trend to every
  // build in the range. Deviation from the local level asks the narrower
  // question — does this build differ from its *neighbours* by more than its
  // jobs explain.
  //
  // A sharp step is only partly absorbed, and correctly: the median follows the
  // level on either side of it, and the pushes whose window straddles it sit off
  // their own baseline, which is exactly what "two neighbouring builds differ"
  // means.
  //
  // Null when the range is too short for a rolling window (trend.ts's floor).
  local: NoiseTerm | null;

  // The three parts of `job`. Null together with it.
  device: NoiseTerm | null;
  replicateShare: NoiseTerm | null;
  unexplained: NoiseTerm | null;

  // Build-to-build variance: the *local* push-mean scatter that job noise over
  // `runsPerPush` runs does not account for. **Null when the estimate comes out
  // at or below zero**, which is the interesting answer rather than a failure —
  // it means every wiggle in the line between push means is the job lottery, and
  // only a window (the trend band, a detected step) says anything.
  build: NoiseTerm | null;

  // The smallest difference two single pushes could show as significant, as a
  // fraction of the level: 1.96·√2 · job.sd / √runsPerPush / level. The number a
  // developer about to compare two try pushes wants, and null without a `job`.
  pushPairResolution: number | null;
  // The same over `WINDOW_PUSHES` pushes a side, which is what the change
  // detector and `step` measure over.
  windowResolution: number | null;

  // How many runs carry a machine name at all. The device term is estimated from
  // these; treeherder expires job rows after about four months and the name
  // comes off the job, so a long range has an older half with no attribution.
  attributedRuns: number;
};

// Two-sided z at α = 0.05, times √2 for a difference of two independent means.
const RESOLUTION_Z = 1.959964 * Math.SQRT2;

function term(sd: number, level: number): NoiseTerm {
  return { sd, cv: level !== 0 ? sd / Math.abs(level) : 0 };
}

// Variance around a mean, with (n − 1) — the same convention `summarize` uses,
// for the same reason: these are samples of a noisy process.
function sampleVariance(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  let sum = 0;
  for (const v of values) sum += v;
  const m = sum / values.length;
  let sq = 0;
  for (const v of values) sq += (v - m) * (v - m);
  return sq / (values.length - 1);
}

// Each machine's mean offset from the pushes it ran in, computed *without* one
// run so that run can be corrected by it. Returns a lookup of
// `(machine, datumId) → offset`, which is the honest correction for that run.
//
// The map is built from sums rather than by re-walking per run: a 725-run series
// over 53 machines would otherwise be 38,000 passes for a number that is one
// subtraction away.
function leaveOneOutOffsets(pushes: readonly PushGroup[]): {
  offsetFor: (machine: string, residual: number) => number;
  attributedRuns: number;
} {
  const sum = new Map<string, number>();
  const count = new Map<string, number>();
  let attributedRuns = 0;
  for (const push of pushes) {
    if (push.runs.length < 2) continue;
    const pushMean = mean(push.runs.map((r) => r.mean));
    for (const run of push.runs) {
      if (run.machineName === null) continue;
      attributedRuns += 1;
      sum.set(run.machineName, (sum.get(run.machineName) ?? 0) + (run.mean - pushMean));
      count.set(run.machineName, (count.get(run.machineName) ?? 0) + 1);
    }
  }
  return {
    attributedRuns,
    // A machine seen once has no out-of-sample offset — its only evidence is the
    // run being corrected — so it corrects by nothing rather than by itself.
    offsetFor: (machine, residual) => {
      const n = count.get(machine) ?? 0;
      if (n < 2) return 0;
      return ((sum.get(machine) ?? 0) - residual) / (n - 1);
    },
  };
}

// Pooled variance of a set of groups around their own means, and the same after
// each member has been corrected by its machine's out-of-sample offset. One walk,
// because the two differ only in what is subtracted.
function jobVariances(pushes: readonly PushGroup[]): {
  raw: number | null;
  calibrated: number | null;
  retriggeredPushes: number;
  attributedRuns: number;
} {
  const { offsetFor, attributedRuns } = leaveOneOutOffsets(pushes);
  let rawSq = 0;
  let calSq = 0;
  let df = 0;
  let retriggeredPushes = 0;
  for (const push of pushes) {
    if (push.runs.length < 2) continue;
    retriggeredPushes += 1;
    const pushMean = mean(push.runs.map((r) => r.mean));
    const corrected = push.runs.map((run) =>
      run.machineName === null ? run.mean : run.mean - offsetFor(run.machineName, run.mean - pushMean),
    );
    const correctedMean = mean(corrected);
    for (const run of push.runs) rawSq += (run.mean - pushMean) * (run.mean - pushMean);
    for (const v of corrected) calSq += (v - correctedMean) * (v - correctedMean);
    df += push.runs.length - 1;
  }
  return {
    raw: df > 0 ? rawSq / df : null,
    calibrated: df > 0 ? calSq / df : null,
    retriggeredPushes,
    attributedRuns,
  };
}

// The budget, or null for a series with nothing in the range.
export function buildNoiseBudget(pushes: readonly PushGroup[]): NoiseBudget | null {
  const runs = pushes.flatMap((p) => p.runs);
  if (runs.length === 0) return null;

  const level = mean(runs.map((r) => r.mean));
  const pushMeans = pushes.map((p) => mean(p.runs.map((r) => r.mean)));

  // Replicate scatter is a *mean of variances*, not a variance of the pooled
  // values: pooling would fold in the run-to-run differences this level is
  // supposed to exclude. Mean rather than median because the next line divides
  // it by the replicate count to get a run mean's sampling error, and that
  // relation only holds for the mean — a heavy-tailed run is part of the noise.
  const replicateVars = runs.map((r) => sampleVariance(r.values)).filter((v) => v !== null);
  const replicateVar = replicateVars.length > 0 ? mean(replicateVars) : null;
  const replicatesPerRun = median(runs.map((r) => r.values.length));

  const {
    raw: jobVar,
    calibrated: calibratedVar,
    retriggeredPushes,
    attributedRuns,
  } = jobVariances(pushes);
  const runsPerPush = median(
    pushes.filter((p) => p.runs.length > 1).map((p) => p.runs.length),
  );

  const pushSummary = summarize(pushMeans);
  const pushTerm = pushSummary && pushMeans.length > 1 ? term(pushSummary.stdDev, level) : null;

  // Each push mean against the middle of the window centred on it. The window
  // contains the push itself, at 1/24 of the weight, which is a contamination
  // small enough to leave alone — and much smaller than the trend it removes.
  const trend = rollingTrend(pushes);
  const localDeviations =
    trend.length === pushes.length ? pushMeans.map((m, i) => m - trend[i].median) : [];
  const localVar = sampleVariance(localDeviations);
  const localTerm = localVar !== null ? term(Math.sqrt(localVar), level) : null;

  let job: NoiseTerm | null = null;
  let device: NoiseTerm | null = null;
  let replicateShare: NoiseTerm | null = null;
  let unexplained: NoiseTerm | null = null;
  let build: NoiseTerm | null = null;
  let pushPairResolution: number | null = null;
  let windowResolution: number | null = null;

  if (jobVar !== null) {
    job = term(Math.sqrt(jobVar), level);
    // Out-of-sample, so this cannot exceed the total by fitting — but a
    // correction that helps nothing can come out very slightly negative on
    // rounding, hence the clamp.
    const deviceVar = Math.max(0, jobVar - (calibratedVar ?? jobVar));
    device = term(Math.sqrt(deviceVar), level);
    if (replicateVar !== null && replicatesPerRun > 0) {
      const shareVar = replicateVar / replicatesPerRun;
      replicateShare = term(Math.sqrt(Math.min(shareVar, jobVar)), level);
      unexplained = term(Math.sqrt(Math.max(0, jobVar - deviceVar - shareVar)), level);
    }
    if (runsPerPush > 0) {
      const perPushVar = jobVar / runsPerPush;
      pushPairResolution = (RESOLUTION_Z * Math.sqrt(perPushVar)) / Math.abs(level);
      windowResolution =
        (RESOLUTION_Z * Math.sqrt(perPushVar / WINDOW_PUSHES)) / Math.abs(level);
      // Local push-mean scatter beyond what job noise over this many runs
      // explains. Local, so a step in the middle of the range is not counted as
      // every build differing from every other.
      if (localVar !== null) {
        const buildVar = localVar - perPushVar;
        if (buildVar > 0) build = term(Math.sqrt(buildVar), level);
      }
    }
  }

  return {
    level,
    runs: runs.length,
    retriggeredPushes,
    runsPerPush: Number.isNaN(runsPerPush) ? 0 : runsPerPush,
    replicatesPerRun: Number.isNaN(replicatesPerRun) ? 0 : replicatesPerRun,
    replicate: replicateVar !== null ? term(Math.sqrt(replicateVar), level) : null,
    job,
    push: pushTerm,
    local: localTerm,
    device,
    replicateShare,
    unexplained,
    build,
    pushPairResolution,
    windowResolution,
    attributedRuns,
  };
}

// The one line a collapsed fold shows, and the shortest true summary of the
// table under it.
//
// **The job figure, then what a push pair can resolve.** Those are the two
// numbers that change what a reader does: the first says how noisy the test is
// with the code held still, the second says whether the comparison they are
// about to make can see what they are looking for. The push-mean cv — the number
// every other surface has always shown — is deliberately not the headline,
// because on a retriggered platform it is the first figure divided by the
// retriggers and it reads as "quiet" for a test that is not.
//
// Falls back through what is measurable: a series with no retriggered push has
// no job figure and no resolution, and one with no replicates has neither of
// those nor a replicate figure.
export function noiseHeadline(budget: NoiseBudget): string {
  const parts: string[] = [];
  if (budget.job) parts.push(`jobs ±${formatPercent(budget.job.cv)}`);
  else if (budget.replicate) parts.push(`replicates ±${formatPercent(budget.replicate.cv)}`);
  if (budget.pushPairResolution !== null) {
    parts.push(`a push pair resolves ${formatPercent(budget.pushPairResolution)}`);
  } else if (budget.push) {
    parts.push(`push means ±${formatPercent(budget.push.cv)}`);
  }
  return parts.join(' · ');
}
