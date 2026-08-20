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
// `buildMachineCensus` answers who is here, and how much of the graph is
// theirs. That is all the panel needs, so it is a walk over the runs and nothing
// more: it recomputes whenever the zoom moves.
//
// **A run older than treeherder's job retention window has no machine at all**,
// because the name is joined off the job row and expires with it — see
// `Run.machineName`. Those runs are counted rather than dropped: a 6-month range
// is unattributed for its first two months, and a census that silently omitted
// them would have the panel's counts fail to add up to the graph.

import type { PushGroup } from './graphData';
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
