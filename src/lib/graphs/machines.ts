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
import { median } from '../shared/stats';
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
  // Null when the series it ran in were too short to establish a local level.
  //
  // **Each run is compared with its own neighbourhood, not with the series
  // average**, and that is the whole difficulty of the statistic. Machines do not
  // run concurrently: a given push is measured by one worker, so there is no
  // within-push comparison to make, and a machine that happens to have been in
  // rotation during a regression would read as the cause of it. So the baseline
  // is `rollingTrend`'s median — the middle of the 24 pushes centred on this one,
  // the same curve the trend band draws — which moves with every step and drift
  // in the series and leaves only what is peculiar to the worker.
  //
  // Then the median of those ratios, per machine, because one bad job should not
  // convict a machine that is otherwise ordinary.
  //
  // **It understates when the pool is small.** A machine's own runs are part of
  // the window it is compared against, so with two machines alternating, each one
  // pulls the baseline halfway towards itself and the gap between them reads as
  // about half its true size. With a pool of the usual dozens the contamination
  // is a fortieth and not worth correcting for; below about five machines, read
  // the ordering and not the numbers.
  relativeLevel: number | null;
};

export type MachineBreakdown = Omit<MachineCensus, 'machines'> & { machines: MachineLevel[] };

// The census, plus `relativeLevel` for each machine.
//
// Separate from `buildMachineCensus` rather than an option on it because the cost is
// not comparable: this runs a rolling quartile over every push of every series,
// which is why the app caches the band it shares (`AppState.trendCache`) instead
// of deriving it. Nothing in the UI calls this; `perfherder-cli machines` does.
export function buildMachineLevels(
  pushesBySeries: readonly (readonly PushGroup[])[],
  span: Span | null = null,
): MachineBreakdown {
  const census = buildMachineCensus(pushesBySeries, span);
  // Ratios of run mean to local level, gathered per machine across every series.
  const ratios = new Map<string, number[]>();

  for (const pushes of pushesBySeries) {
    const window = pushes.filter((p) => inSpan(p, span));
    // Index-aligned with `window` by construction — one vertex per push — and
    // empty for a series with too few pushes to have a band at all.
    const trend = rollingTrend(window);
    if (trend.length !== window.length) continue;
    for (let i = 0; i < window.length; i++) {
      const level = trend[i].median;
      // A zero or negative local level makes the ratio meaningless rather than
      // large. Rare, but "count of something" metrics do sit at zero for months.
      if (!(level > 0)) continue;
      for (const run of window[i].runs) {
        if (run.machineName === null) continue;
        const list = ratios.get(run.machineName);
        if (list) list.push(run.mean / level);
        else ratios.set(run.machineName, [run.mean / level]);
      }
    }
  }

  return {
    ...census,
    machines: census.machines.map((tally) => {
      const list = ratios.get(tally.name);
      return {
        ...tally,
        relativeLevel: list && list.length > 0 ? median(list) - 1 : null,
      };
    }),
  };
}
