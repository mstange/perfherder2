// Which machines produced the points on the graph. **Pure.**
//
// Every performance datum now names the machine its job ran on (graphApi.ts,
// `RawDatum.machine_name`), which makes a question askable that used to need one
// job lookup per dot: *is this scatter the test, or is it one machine?* CI pools
// are not uniform — a worker with a failing power supply, a thermal problem or a
// different silicon stepping shows up as a subset of a series' dots sitting
// systematically off the rest, and until you can tell those dots apart from the
// others they are indistinguishable from noise.
//
// Two answers live here, and they are deliberately different sizes:
//
//   `buildMachineCensus` — who is here, and how much of the graph is theirs.
//     What the graph pane's machine panel lists, so it is a walk over the runs
//     and nothing more: it recomputes whenever the zoom moves.
//   `buildMachineLevels` — and *is one of them off?* A statistic, and a much
//     more expensive one, so it is the CLI's (`perfherder-cli machines`) rather
//     than something the panel computes on every zoom. See `relativeLevel`.
//
// **A run older than treeherder's job retention window has no machine at all**,
// because the name is joined off the job row and expires with it — see
// `Run.machineName`. Those runs are counted rather than dropped: a 6-month range
// is unattributed for its first two months, and a census that silently omitted
// them would have the panel's counts fail to add up to the graph.

import type { PushGroup } from './graphData';
import { rollingTrend } from './trend';
import { mean, median } from '../shared/stats';
import type { Span } from '../shared/timeRange';

// One machine's share of the graph.
export type MachineTally = {
  name: string;
  // Jobs, and values. Both, because they answer different questions and neither
  // implies the other: a machine with 3 runs of 25 replicates has as many dots
  // as one with 25 runs of 3 and is a twenty-fifth of the evidence.
  runs: number;
  points: number;
};

export type MachineCensus = {
  // Sorted by name, numerically aware — so nuc13-9 precedes nuc13-103 whether or
  // not the pool zero-pads, and a list of forty near-identical names reads in the
  // order someone would look for one.
  machines: MachineTally[];
  // Runs whose job has expired, so there is nothing to attribute them to. Not a
  // machine named "unknown": it is one row of arithmetic in the panel's footer,
  // and making it selectable would offer "show me the points from before we
  // started recording this", which is a date range and not a machine.
  unattributedRuns: number;
  unattributedPoints: number;
};

// Sorting a list of machine names the way someone scanning for one would.
function byName(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

// Whether a push falls in the window being described. Null means "all of them",
// which is what the CLI passes and what a graph with no zoom amounts to.
function inSpan(push: PushGroup, span: Span | null): boolean {
  return !span || (push.x >= span.start && push.x <= span.end);
}

// Every machine behind the given pushes, with its share of them.
//
// Takes one push list per series rather than a flat one, because the census is
// about the graph and a graph is several series: one machine runs jobs for every
// signature that targets its platform, so the same name legitimately appears in
// all of them and its counts add up. (Which is also why a focus is one name
// across the whole graph rather than a per-series setting — see
// `AppState.machineFocus`.)
export function buildMachineCensus(
  pushesBySeries: readonly (readonly PushGroup[])[],
  span: Span | null = null,
): MachineCensus {
  const tallies = new Map<string, MachineTally>();
  let unattributedRuns = 0;
  let unattributedPoints = 0;

  for (const pushes of pushesBySeries) {
    for (const push of pushes) {
      if (!inSpan(push, span)) continue;
      for (const run of push.runs) {
        if (run.machineName === null) {
          unattributedRuns++;
          unattributedPoints += run.values.length;
          continue;
        }
        let tally = tallies.get(run.machineName);
        if (!tally) {
          tally = { name: run.machineName, runs: 0, points: 0 };
          tallies.set(run.machineName, tally);
        }
        tally.runs++;
        tally.points += run.values.length;
      }
    }
  }

  return {
    machines: [...tallies.values()].sort((a, b) => byName(a.name, b.name)),
    unattributedRuns,
    unattributedPoints,
  };
}

// A machine's tally plus where its measurements sit relative to everyone else's.
export type MachineLevel = MachineTally & {
  // How far this machine's runs sit from the level around them, as a fraction:
  // 0.064 is "this machine reads 6.4% higher than the graph does where it ran".
  // Null when nothing could be compared.
  //
  // **Each run is compared with the closest thing to a simultaneous
  // measurement**, and there are two of those, in this order:
  //
  //   within-push  the mean of the other runs of its own push. Exactly
  //                contemporaneous — same build, same hour, everything but the
  //                worker — so no step, drift or rotation can confound it. This
  //                is available far more often than the first version of this
  //                module assumed: android hardware pools run four jobs a push
  //                and desktop twelve, and 186 of 187 pushes on the A55 startup
  //                series have two or more (cli-todo.md, the noise trial).
  //   local        the rolling median of the `WINDOW_PUSHES` pushes centred on
  //                it — the curve the app's trend band draws — for the runs
  //                whose push ran once. Moves with every step and drift in the
  //                series and leaves what is peculiar to the worker.
  //
  // The within-push deviation is **corrected for self-inclusion**: a run is one
  // of the n it is being compared against, so its observed deviation is
  // (1 − 1/n) of the truth and is divided back up. That is a known factor rather
  // than the caveat it is for the local baseline, where the machine is one of a
  // pool's worth of runs in the window.
  //
  // Then the median of those ratios, per machine, because one bad job should not
  // convict a machine that is otherwise ordinary.
  relativeLevel: number | null;
  // Which of the two baselines the level came from. `mixed` means both, which
  // happens to a machine that ran in retriggered and single-run pushes alike.
  baseline: 'within-push' | 'local' | 'mixed' | null;
  // How much this machine's own runs scatter around that baseline, as a
  // fraction. **The erratic-worker signal, which a level cannot show**: a device
  // that throttles thermally has an ordinary average and wild jobs, and it sits
  // mid-table by level. Sample sd of the same ratios the level is the median of
  // — not a robust spread, deliberately, since a machine with one wild job is
  // exactly what this column is for. Null below two runs.
  relativeSpread: number | null;
  // The standard error of `relativeLevel`, as a fraction — what says whether a
  // −4% row is a finding or a machine that has run nine times. The asymptotic se
  // of a *median* (√(π/2) ≈ 1.2533 times the mean's), because that is what the
  // level is. Null below two runs.
  levelError: number | null;
};

export type MachineBreakdown = Omit<MachineCensus, 'machines'> & { machines: MachineLevel[] };

// The census, plus `relativeLevel`, its spread and its error for each machine.
//
// Separate from `buildMachineCensus` rather than an option on it because the
// cost is not comparable: where a push ran once this needs a rolling quartile
// over every push of every series, which is why the app caches the band it
// shares (`AppState.trendCache`) instead of deriving it. On a pool that
// retriggers, most of the work is the within-push contrast instead, which is one
// pass and no window at all.
export function buildMachineLevels(
  pushesBySeries: readonly (readonly PushGroup[])[],
  span: Span | null = null,
): MachineBreakdown {
  const census = buildMachineCensus(pushesBySeries, span);
  // Ratios of run mean to the closest thing to a simultaneous measurement,
  // gathered per machine across every series, with which baseline each came
  // from. See `MachineLevel.relativeLevel`.
  const ratios = new Map<string, number[]>();
  const sources = new Map<string, Set<'within-push' | 'local'>>();

  const record = (
    machine: string,
    ratio: number,
    source: 'within-push' | 'local',
  ): void => {
    const list = ratios.get(machine);
    if (list) list.push(ratio);
    else ratios.set(machine, [ratio]);
    const seen = sources.get(machine);
    if (seen) seen.add(source);
    else sources.set(machine, new Set([source]));
  };

  for (const pushes of pushesBySeries) {
    const window = pushes.filter((p) => inSpan(p, span));
    // Only needed for the single-run pushes, but it is one pass over the window
    // and asking for it lazily per push would mean deciding twice.
    //
    // Index-aligned with `window` by construction — one vertex per push — and
    // empty for a series with too few pushes to have a band at all.
    const trend = rollingTrend(window);
    const haveTrend = trend.length === window.length;

    for (let i = 0; i < window.length; i++) {
      const push = window[i];
      const attributed = push.runs.filter((run) => run.machineName !== null);
      if (attributed.length === 0) continue;

      if (push.runs.length > 1) {
        // The contemporaneous contrast. Every run of the push is in the mean,
        // including this one, which is what the (1 − 1/n) correction undoes.
        const n = push.runs.length;
        const pushMean = mean(push.runs.map((run) => run.mean));
        // A zero or negative level makes a ratio meaningless rather than large.
        if (!(pushMean > 0)) continue;
        for (const run of attributed) {
          const deviation = (run.mean - pushMean) / pushMean;
          record(run.machineName as string, 1 + (deviation * n) / (n - 1), 'within-push');
        }
        continue;
      }

      if (!haveTrend) continue;
      const level = trend[i].median;
      if (!(level > 0)) continue;
      for (const run of attributed) {
        record(run.machineName as string, run.mean / level, 'local');
      }
    }
  }

  return {
    ...census,
    machines: census.machines.map((tally) => {
      const list = ratios.get(tally.name);
      if (!list || list.length === 0) {
        return { ...tally, relativeLevel: null, baseline: null, relativeSpread: null, levelError: null };
      }
      const seen = sources.get(tally.name) as Set<'within-push' | 'local'>;
      const spread = list.length > 1 ? sampleSd(list) : null;
      return {
        ...tally,
        relativeLevel: median(list) - 1,
        baseline: seen.size > 1 ? 'mixed' : ([...seen][0] as 'within-push' | 'local'),
        relativeSpread: spread,
        // √(π/2), the asymptotic se of a median against a mean's.
        levelError: spread === null ? null : (1.2533 * spread) / Math.sqrt(list.length),
      };
    }),
  };
}

function sampleSd(values: readonly number[]): number {
  const m = mean(values);
  let sq = 0;
  for (const v of values) sq += (v - m) * (v - m);
  return Math.sqrt(sq / (values.length - 1));
}
