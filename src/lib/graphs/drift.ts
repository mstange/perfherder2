// Where a series was at the start of the loaded range against where it is at the
// end. **Pure.**
//
// Under `src/lib` rather than `src/cli`, though the CLI is where it was written,
// for the reason cluster.ts gives: dependencies run `src/cli` → `src/lib` and
// never back, and both callers now want it. `series --drift` prints the figure
// and the series-list card shows it, and the two have to be the same figure or
// the tool's whole claim — that its answers are the app's answers — stops
// holding for the one reading the app had no other way to give.
//
// This answers a question the change detector cannot, and deliberately so:
// segmentation looks for steps, and a series that slides 8% over three months
// has no step in it (graphs-todo.md, "Gradual drift is invisible by
// construction"). The case that got it built is signature 5350957 — +10% over six
// months and 1,158 pushes, with zero bars and zero perfherder alerts — where
// everything the app drew was silent about a real regression.
//
// **The window is `WINDOW_PUSHES` a side**, imported rather than chosen, so a
// drift figure and a `step` or `changes` figure are on one scale. Medians rather
// than means, matching the level line's headline and for the reason changes.ts
// keeps raising: one bad push drags a mean.
//
// **It is not detection, and the wording everywhere has to keep saying so.** Two
// medians and a rank test on the ends of the range: the test says the ends are at
// different levels, not that anything stepped between them, and a series with one
// step in the middle drifts by exactly that step. That is why the figure is a
// number on a card rather than a mark on the plot — a span drawn across the graph
// would claim to know the shape of the climb, which this knows nothing about.

import { CHANGE_ALPHA, WINDOW_PUSHES, clearsFloor } from './changes';
import type { AlertThreshold, PushGroup, SeriesMeta } from './graphData';
import { formatPValue, formatSignedPercent, formatValue } from '../shared/chart';
import { mannWhitneyU, median, type MannWhitneyResult } from '../shared/stats';
import { describeSpan } from '../shared/timeRange';

export type DriftWindow = {
  pushCount: number;
  startMs: number | null;
  endMs: number | null;
  median: number;
};

export type DriftSummary = {
  // How many pushes each side actually got. Below `WINDOW_PUSHES` when the range
  // holds too few to give both sides a full one.
  windowPushes: number;
  first: DriftWindow;
  last: DriftWindow;
  // (last − first) / first. Null when the first median is zero.
  deltaFraction: number | null;
  // A rank test on the two windows' push means. It says the ends are at
  // different levels; it says nothing about there being a step between them,
  // which is the whole point of reporting drift separately.
  test: MannWhitneyResult | null;
};

// Null rather than a figure when the range cannot support one: six pushes a side
// is the detector's own minimum for saying anything about a level, and a drift
// computed from three would be a number with no claim behind it.
export function buildDrift(pushes: readonly PushGroup[]): DriftSummary | null {
  const MIN_SIDE = 6;
  if (pushes.length < 2 * MIN_SIDE) return null;
  // Never overlapping: with 30 pushes the windows are 15 a side, not 24.
  const windowPushes = Math.min(WINDOW_PUSHES, Math.floor(pushes.length / 2));
  const first = pushes.slice(0, windowPushes);
  const last = pushes.slice(pushes.length - windowPushes);

  const firstMeans = first.map((p) => p.mean);
  const lastMeans = last.map((p) => p.mean);
  const firstMedian = median(firstMeans);
  const lastMedian = median(lastMeans);

  return {
    windowPushes,
    first: {
      pushCount: first.length,
      startMs: first[0]?.x ?? null,
      endMs: first[first.length - 1]?.x ?? null,
      median: firstMedian,
    },
    last: {
      pushCount: last.length,
      startMs: last[0]?.x ?? null,
      endMs: last[last.length - 1]?.x ?? null,
      median: lastMedian,
    },
    deltaFraction: firstMedian === 0 ? null : (lastMedian - firstMedian) / firstMedian,
    test: mannWhitneyU(firstMeans, lastMeans),
  };
}

// Is this drift worth putting in front of a reader who did not ask for it?
//
// **The CLI does not call this and should not.** `series --drift` was asked for
// by name, so it prints whatever it computed and lets the reader judge — a
// p of 0.4 beside +8% is itself the answer to "is this series drifting". The app
// draws the figure unprompted, on every card, which is a different bargain: a
// badge that appears whenever a noisy series wobbles becomes furniture nobody
// reads, and it would appear on almost every series.
//
// Two bars, both borrowed rather than invented, because a third opinion about
// what counts as a real move is exactly what changes.ts exists to prevent:
//
//   - **The detector's floor** — a quarter of the signature's own alerting
//     threshold (graphs.md, "The floor comes from the signature"). With enough
//     pushes a rank test will certify a 0.05% drift, which is true and useless.
//   - **The detector's α** — `CHANGE_ALPHA`, not `SIGNIFICANCE_ALPHA`, for the
//     multiple-comparisons reason given there: this asks once per plotted series,
//     unprompted, so it pays the same price the bars do.
//
// The consequence to keep in mind when reading a card: absence means "nothing
// worth saying", and that covers three different situations — a flat series, a
// range too short to ask about (`buildDrift` returned null), and a climb the
// series' own noise can't distinguish from flat. Only the CLI separates them.
export function driftWorthReporting(
  drift: DriftSummary,
  threshold: AlertThreshold,
): boolean {
  if (drift.deltaFraction === null) return false;
  if (!drift.test || drift.test.pValue >= CHANGE_ALPHA) return false;
  return clearsFloor(threshold, drift.first.median, drift.last.median, drift.deltaFraction);
}

// Is the climb in the direction that makes the metric worse? Null when there is
// no drift to have a direction, so a caller can't accidentally report "better"
// for a series that didn't move.
export function driftIsRegression(
  drift: DriftSummary,
  lowerIsBetter: boolean,
): boolean | null {
  if (drift.deltaFraction === null || drift.deltaFraction === 0) return null;
  return drift.deltaFraction > 0 === lowerIsBetter;
}

// ---------------------------------------------------------------------------
// The series-list badge
// ---------------------------------------------------------------------------
//
// The figure's UI form, decided in graphs-todo.md before it was built: a number
// on the series-list card beside the change count, not a line on a plot that
// already draws every replicate, and not a span across the graph — see the module
// header for why drawing it would claim more than it knows.
//
// **The percentage goes in the badge and everything else goes in the title.** The
// badge shares one clipped, non-wrapping row with the point count, the alert count
// and the change count (SeriesList.svelte, `.sub`), so a second number there costs
// one of the others. What the row cannot hold, a hover has to: the two medians,
// both windows' dates, and the p-value, because "+10%" on its own is a claim the
// reader has no way to check.

// Short enough for the badge row. Signed, so the direction is in the number, and
// the sign is arithmetic rather than good/bad — the title says which that is.
export function driftBadgeLabel(drift: DriftSummary): string {
  return `${formatSignedPercent(drift.deltaFraction ?? 0)} drift`;
}

// The whole claim, for the hover. Multi-line: a tooltip is the one place in this
// UI with room for the sentence, and the alternative was a badge that said less
// than it meant.
export function driftBadgeTitle(drift: DriftSummary, meta: SeriesMeta | null): string {
  const unit = meta?.measurementUnit ? ` ${meta.measurementUnit}` : '';
  const regression = meta ? driftIsRegression(drift, meta.lowerIsBetter) : null;
  const verdict = regression === null ? '' : ` (${regression ? 'worse' : 'better'})`;
  const window = (w: DriftWindow) =>
    w.startMs === null || w.endMs === null
      ? '?'
      : describeSpan({ start: w.startMs, end: w.endMs });
  return [
    `Drift over the loaded range: ${formatValue(drift.first.median)} → ` +
      `${formatValue(drift.last.median)}${unit}, ` +
      `${formatSignedPercent(drift.deltaFraction ?? 0)}${verdict}`,
    `Medians of ${drift.windowPushes} pushes at each end — ` +
      `${window(drift.first)} against ${window(drift.last)}`,
    drift.test ? `p ${formatPValue(drift.test.pValue)} that the two ends are at the same level` : '',
    'The ends differ; this does not say that anything stepped between them.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}
