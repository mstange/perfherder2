// The report objects. One per command, pure, and the same objects `--json`
// prints and `render.ts` turns into text — so the two can't describe different
// things, which is the failure mode of every tool that formats twice.
//
// Everything statistical in here is delegated: `stats.ts` for the tests,
// `changes.ts` for the steps, `alerts.ts` for perfherder's verdicts,
// `kde.ts`/`distribution.ts` for the densities, `pushlog.ts` for the commits.
// This module decides only what a command *reports*, never how a number is
// computed.

import { alertStatusLabel, summaryStatusLabel, type SeriesAlert } from '../lib/graphs/alerts';
import {
  CHANGE_ALPHA,
  clearsFloor,
  detectChanges,
  detectionFloor,
  type DetectedChange,
} from '../lib/graphs/changes';
import {
  buildComparison,
  comparisonLinks,
  hasDistribution,
  type Comparison,
  type CompareSide,
  type ComparisonKind,
  type ComparisonLinks,
} from '../lib/graphs/compare';
import {
  buildDistribution,
  MIN_CURVE_VALUES,
  type DistributionPlot,
} from '../lib/graphs/distribution';
import {
  DEFAULT_ALERT_THRESHOLD,
  MEAN_REPLICATE,
  pushValues,
  seriesLabel,
  type AlertThreshold,
  type PushGroup,
  type SeriesData,
  type SeriesMeta,
  type SeriesRef,
} from '../lib/graphs/graphData';
import {
  attrChips,
  attrsForEntry,
  splitCommonAttrs,
  type SeriesAttrs,
} from '../lib/graphs/seriesSummary';
import type { Commit, PushlogRange } from '../lib/graphs/pushlog';
import { commitTitle, pushlogCaveat, pushlogLabel } from '../lib/graphs/pushlog';
import type { Activity } from '../lib/picker/activity';
import {
  compareRows,
  matchesRow,
  type Filter,
  type SortState,
} from '../lib/picker/filter';
import { chipToString } from '../lib/picker/filter';
import type { Series } from '../lib/picker/series';
import { pushLogRangeUrl, type RepoLinkInfo } from '../lib/shared/links';
import {
  changeDirection,
  mannWhitneyU,
  median,
  relativeChange,
  summarize,
  type ChangeDirection,
  type MannWhitneyResult,
  type PoolSummary,
} from '../lib/shared/stats';
import { EMPTY_VIEW_STATE, serializeViewState, type SeriesEntryState, type ViewState } from '../lib/urlState';
import type { Span } from './args';
import { compareModes, describeModeComparison, type ModeComparison } from './modes';

// One signature, fetched. Defined here rather than in load.ts so the dependency
// runs impure → pure and never the other way.
export type LoadedSeries = {
  ref: SeriesRef;
  meta: SeriesMeta;
  data: SeriesData;
  found: boolean;
};

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

export function refString(ref: SeriesRef): string {
  return `${ref.repository},${ref.signatureId},${ref.frameworkId}`;
}

export type SeriesHeader = {
  ref: string;
  repository: string;
  signatureId: number;
  frameworkId: number;
  suite: string;
  test: string;
  application: string;
  platform: string;
  options: string;
  unit: string;
  lowerIsBetter: boolean;
  found: boolean;
};

export function seriesHeader(loaded: LoadedSeries): SeriesHeader {
  const { ref, meta } = loaded;
  return {
    // Two fields when nothing came back, because the framework id in `ref` is
    // then a stand-in (see `loadSeries`) and printing `autoland,999,0` invites
    // the reader to paste a framework that does not exist.
    ref: loaded.found ? refString(ref) : `${ref.repository},${ref.signatureId}`,
    repository: ref.repository,
    signatureId: ref.signatureId,
    frameworkId: ref.frameworkId,
    suite: meta.suite,
    test: meta.test,
    application: meta.application,
    platform: meta.platform,
    options: meta.options,
    unit: meta.measurementUnit,
    lowerIsBetter: meta.lowerIsBetter,
    found: loaded.found,
  };
}

// The graph this report is about, as a link into the app. Every command emits
// one, because docs/graphs.md's rule for the change detector — "open the graph
// first" — applies at least as much to a reader who only has text.
export function appUrl(base: string, state: Partial<ViewState>): string {
  const query = serializeViewState({ ...EMPTY_VIEW_STATE, ...state });
  const root = base.endsWith('/') ? base : `${base}/`;
  return query ? `${root}?${query}` : root;
}

function entriesFor(refs: readonly SeriesRef[]): SeriesEntryState[] {
  return refs.map((ref) => ({ ...ref, visible: true }));
}

export function graphUrl(base: string, refs: readonly SeriesRef[], span: Span): string {
  return appUrl(base, { series: entriesFor(refs), range: { start: span.start, end: span.end } });
}

// A link that opens the app already showing one comparison: the push after the
// step selected, the one before it pinned — the same pair a click on the bar
// sets up (`AppState.selectPushPair`).
//
// The URL names a point by datum, so a push has to be reduced to one: its first
// run, at MEAN_REPLICATE. That is the dot the app draws for the run when
// replicates are off, and it resolves under either setting.
function pairUrl(
  base: string,
  ref: SeriesRef,
  span: Span,
  before: PushGroup | undefined,
  after: PushGroup | undefined,
): string | null {
  if (!before || !after || before.runs.length === 0 || after.runs.length === 0) return null;
  return appUrl(base, {
    series: entriesFor([ref]),
    range: { start: span.start, end: span.end },
    selected: {
      repository: ref.repository,
      signatureId: ref.signatureId,
      datumId: after.runs[0].datumId,
      replicateIndex: MEAN_REPLICATE,
    },
    compared: {
      repository: ref.repository,
      signatureId: ref.signatureId,
      datumId: before.runs[0].datumId,
      replicateIndex: MEAN_REPLICATE,
    },
  });
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export type SearchRow = {
  ref: string;
  repository: string;
  signatureId: number;
  frameworkId: number;
  framework: string;
  suite: string;
  test: string;
  application: string;
  platform: string;
  options: string[];
  unit: string;
  isSubtest: boolean;
  hasSubtests: boolean;
  // Null when activity wasn't asked for, or when its fetch failed.
  runs: number | null;
  lastRunMs: number | null;
};

export type SearchReport = {
  chips: string[];
  text: string;
  repos: string[];
  intervalSeconds: number;
  includeSubtests: boolean;
  // The `--parent` restriction, as `<repo>,<signatureId>`; null without one.
  parent: string | null;
  // Whether that parent row was itself in the fetched set. False is a different
  // answer from "it has no children": a mistyped id, the wrong repository, or a
  // signature that has gone quiet all land here, and none of them means the
  // parent has no subtests.
  parentFound: boolean;
  // Raw signature rows the API returned, per repository.
  fetched: Record<string, number>;
  matched: number;
  rows: SearchRow[];
};

// Which parent's subtests to restrict to. Only the repository and the id
// matter; a framework or an `@` selector on the reference is ignored, since
// neither narrows a parent-child relation.
export type ParentRef = { repository: string; signatureId: number };

export type SearchInput = {
  rows: readonly Series[];
  fetched: ReadonlyMap<string, number>;
  filter: Filter;
  repos: readonly string[];
  intervalSeconds: number;
  includeSubtests: boolean;
  parent?: ParentRef | null;
  sort: SortState | null;
  limit: number;
  activity?: ReadonlyMap<string, Activity>;
};

// **Subtests are matched directly, not through their parents.** The picker
// groups a matched child under its parent because a table of 25,000 rows needs
// the hierarchy to stay navigable (design.md, "Match inside subtests"); here the
// answer is a list of signature references, and a subtest's reference is as good
// as a parent's. So `--subtests` widens the *set of rows the filter sees*, and
// nothing else. Callers get `isSubtest` per row and can tell them apart.
//
// **`--parent` is a separate axis from the filter, not another chip.** It asks
// a structural question — "whose children are these" — that no `field:value`
// match can express: a subtest's row carries its parent's *id* in `parentKey`
// and nothing else about it, so `suite:speedometer3 platform:x` gathers every
// variant of that suite on that platform (nova, no-nova, samply-profile) and
// there is no chip, and no negation, that separates one parent's 26 children
// from the other four parents' 104. `parentKey` is exactly that separation, and
// it is already composed for us (design.md, "Row identity").
export function buildSearchReport(input: SearchInput): SearchReport {
  const parent = input.parent ?? null;
  const parentKey = parent ? `${parent.repository}|${parent.signatureId}` : null;
  const parentFound =
    parent === null ||
    input.rows.some((row) => row.repository === parent.repository && row.id === parent.signatureId);

  const scoped = parentKey === null ? input.rows : input.rows.filter((row) => row.parentKey === parentKey);
  const matched = scoped.filter((row) => matchesRow(row, input.filter));
  const sorted = input.sort ? [...matched].sort((a, b) => compareRows(a, b, input.sort)) : matched;
  const shown = sorted.slice(0, Math.max(0, input.limit));

  return {
    chips: input.filter.chips.map(chipToString),
    text: input.filter.text,
    repos: [...input.repos],
    intervalSeconds: input.intervalSeconds,
    includeSubtests: input.includeSubtests,
    parent: parent ? `${parent.repository},${parent.signatureId}` : null,
    parentFound,
    fetched: Object.fromEntries(input.fetched),
    matched: matched.length,
    rows: shown.map((row) => {
      const activity = input.activity?.get(row.key);
      const counted = activity && !('error' in activity) ? activity : null;
      return {
        ref: `${row.repository},${row.id},${row.frameworkId}`,
        repository: row.repository,
        signatureId: row.id,
        frameworkId: row.frameworkId,
        framework: row.framework,
        suite: row.suite,
        test: row.test,
        application: row.application,
        platform: row.platform,
        options: row.options,
        unit: row.measurementUnit,
        isSubtest: row.isSubtest,
        hasSubtests: row.hasSubtests,
        runs: counted ? counted.total : null,
        lastRunMs: counted ? counted.lastRunMs : null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// series
// ---------------------------------------------------------------------------

// One push of a series, for `series --pushes`. The median is over the push's
// whole replicate cloud while the mean is `PushGroup.mean` — the mean of the
// runs' means, which is the y the app's connecting line joins. The two are not
// the same statistic and the table labels them separately for that reason.
export type PushRow = {
  atMs: number;
  revision: string;
  runCount: number;
  valueCount: number;
  mean: number;
  median: number;
};

export type SeriesLevel = {
  series: SeriesHeader;
  url: string;
  pushCount: number;
  runCount: number;
  replicateCount: number;
  firstPushMs: number | null;
  lastPushMs: number | null;
  // The most recent pushes, when asked for; null when not.
  recentPushes: PushRow[] | null;
  // Over the range, computed from *push means* — one value per push, the same
  // number the app's connecting line joins and the same unit of analysis
  // `changes.ts` uses. Pooling replicates instead would report a spread
  // dominated by within-run noise and an n the data hasn't earned.
  level: PoolSummary | null;
  // Push means in time order, for the sparkline.
  pushMeans: number[];
};

export type LevelComparison = {
  baseLabel: string;
  nextLabel: string;
  baseMedian: number;
  nextMedian: number;
  // next / base. Null when the base median is zero.
  ratio: number | null;
  deltaFraction: number | null;
  test: MannWhitneyResult | null;
  // Empty when the two disagree; the delta is then arithmetic without meaning.
  unit: string;
  warning: string | null;
  // Which side is better for the metric, or null when that isn't defined —
  // different units, disagreeing directions, or a difference the test can't
  // distinguish from noise.
  betterLabel: string | null;
};

export type SeriesReport = {
  span: Span;
  url: string;
  entries: SeriesLevel[];
  // Every other series against the first. A comparison of levels over a range,
  // not of two builds: see `buildLevelComparison`.
  comparisons: LevelComparison[];
};

export function buildSeriesReport(
  loaded: readonly LoadedSeries[],
  span: Span,
  base: string,
  // How many of the most recent pushes to list per series; null for none.
  pushLimit: number | null = null,
): SeriesReport {
  const entries = loaded.map((one): SeriesLevel => {
    const pushMeans = one.data.pushes.map((p) => p.mean);
    return {
      series: seriesHeader(one),
      url: graphUrl(base, [one.ref], span),
      pushCount: one.data.pushes.length,
      runCount: one.data.runs.length,
      replicateCount: one.data.replicates.points.length,
      firstPushMs: one.data.pushes[0]?.x ?? null,
      lastPushMs: one.data.pushes[one.data.pushes.length - 1]?.x ?? null,
      recentPushes:
        pushLimit === null
          ? null
          : one.data.pushes.slice(-Math.max(0, pushLimit)).map((push): PushRow => {
              const values = pushValues(push);
              return {
                atMs: push.x,
                revision: push.revision,
                runCount: push.runs.length,
                valueCount: values.length,
                mean: push.mean,
                median: median(values),
              };
            }),
      level: summarize(pushMeans),
      pushMeans,
    };
  });

  const comparisons: LevelComparison[] = [];
  for (let i = 1; i < loaded.length; i++) {
    const cmp = buildLevelComparison(loaded[0], loaded[i]);
    if (cmp) comparisons.push(cmp);
  }

  return {
    span,
    url: graphUrl(base, loaded.map((l) => l.ref), span),
    entries,
    comparisons,
  };
}

// Two series' *levels* over a range, tested over their push means.
//
// This is not `compare.ts`'s job and deliberately doesn't use it: that module
// answers "these two clicked points", where a `series` comparison is two series
// on **one** push and the two sides share a build. Here the sides are two
// different sets of builds over the same weeks, which is the right question for
// "how does Firefox compare with Chrome" and the wrong one for anything
// causal — nothing pairs a Firefox push with a Chrome push, so this says which
// is faster and never why.
//
// Push means rather than pooled replicates for the reason changes.ts gives at
// length: replicates of a run are repeated measurements of one number, and
// pooling them reports an n the data has not earned.
export function buildLevelComparison(
  base: LoadedSeries,
  next: LoadedSeries,
): LevelComparison | null {
  const baseValues = base.data.pushes.map((p) => p.mean);
  const nextValues = next.data.pushes.map((p) => p.mean);
  if (baseValues.length === 0 || nextValues.length === 0) return null;

  const baseSummary = summarize(baseValues);
  const nextSummary = summarize(nextValues);
  if (!baseSummary || !nextSummary) return null;

  const baseUnit = base.meta.measurementUnit;
  const nextUnit = next.meta.measurementUnit;
  const unitsDiffer = !!baseUnit && !!nextUnit && baseUnit !== nextUnit;
  const directionsDiffer = base.meta.lowerIsBetter !== next.meta.lowerIsBetter;
  const test = mannWhitneyU(baseValues, nextValues);

  const baseLabel = levelLabel(base);
  const nextLabel = levelLabel(next);
  let betterLabel: string | null = null;
  if (!unitsDiffer && !directionsDiffer && test?.significant) {
    const nextIsHigher = nextSummary.median > baseSummary.median;
    betterLabel = nextIsHigher === base.meta.lowerIsBetter ? baseLabel : nextLabel;
  }

  return {
    baseLabel,
    nextLabel,
    baseMedian: baseSummary.median,
    nextMedian: nextSummary.median,
    ratio: baseSummary.median === 0 ? null : nextSummary.median / baseSummary.median,
    deltaFraction:
      baseSummary.median === 0
        ? null
        : (nextSummary.median - baseSummary.median) / baseSummary.median,
    test,
    unit: unitsDiffer ? '' : baseUnit || nextUnit,
    warning: unitsDiffer
      ? `Measured in different units (${baseUnit} and ${nextUnit}) — the ratio is arithmetic, not a comparison.`
      : directionsDiffer
        ? 'These series disagree about which direction is better, so neither can be called faster.'
        : null,
    betterLabel,
  };
}

// The shortest thing that distinguishes one series from another in a list of
// them: the application if it has one, else the platform, else the test name.
function levelLabel(loaded: LoadedSeries): string {
  const { meta, ref } = loaded;
  return meta.application || meta.platform || seriesLabel(meta) || `signature ${ref.signatureId}`;
}

// ---------------------------------------------------------------------------
// changes
// ---------------------------------------------------------------------------

export type CommitSummary = {
  revision: string;
  author: string;
  title: string;
  bugs: number[];
  pushId: number;
  pushTimestamp: number;
};

export type ChangeEntry = {
  atMs: number;
  pushId: number;
  revision: string;
  prevPushId: number | null;
  prevRevision: string | null;
  // Which analysis produced this row. `both` is the case worth having: this app
  // and perfherder independently marking one push.
  source: 'detected' | 'alert' | 'both';
  isRegression: boolean;
  detected: {
    beforeValue: number;
    afterValue: number;
    relativeChange: number;
    pValue: number;
    effectSize: string;
    beforeCount: number;
    afterCount: number;
    windowStartMs: number;
    windowEndMs: number;
  } | null;
  alert: {
    summaryId: number;
    alertId: number;
    amountPct: number;
    prevValue: number;
    newValue: number;
    tValue: number | null;
    status: string;
    summaryStatus: string;
    bugNumber: number | null;
    reassignedFrom: number | null;
    reassignedTo: number | null;
  } | null;
  // How many pushes apart the two analyses put the change, when both did. Zero
  // for an exact agreement.
  pushOffset: number | null;
  url: string | null;
  pushlogUrl: string | null;
  // Only present with --commits.
  commits: CommitSummary[] | null;
  commitsLabel: string | null;
  commitsCaveat: string | null;
};

export type ChangesReport = {
  series: SeriesHeader;
  span: Span;
  url: string;
  pushCount: number;
  threshold: AlertThreshold;
  // Null when the alerts request failed. Distinguishable from "no alerts",
  // which is an empty list — one is missing information and the other is a
  // finding.
  alertsLoaded: boolean;
  entries: ChangeEntry[];
};

// How far apart two analyses may place a step and still be describing one
// event. Three pushes: on autoland that is minutes to a couple of hours, and
// the detector's index is a rank relocation over a ±24-push window while
// perfherder's is where its own sliding windows crossed, so exact agreement is
// not the common case even when both are right. Beyond three, they are claims
// about different pushes and merging them would invent an agreement.
const MERGE_PUSH_DISTANCE = 3;

export type ChangesInput = {
  loaded: LoadedSeries;
  span: Span;
  threshold: AlertThreshold;
  // Null when the request failed.
  alerts: SeriesAlert[] | null;
  base: string;
  repoLink: RepoLinkInfo | null;
};

export function buildChangesReport(input: ChangesInput): ChangesReport {
  const { loaded, span, threshold, alerts, base, repoLink } = input;
  const pushes = loaded.data.pushes;
  const indexOfPush = new Map(pushes.map((p, i) => [p.pushId, i]));

  const detected = detectChanges(pushes, loaded.meta.lowerIsBetter, threshold);
  const entries = mergeFindings(detected, alerts ?? [], pushes, indexOfPush).map((row) =>
    describeEntry(row, loaded, indexOfPush, span, base, repoLink),
  );

  return {
    series: seriesHeader(loaded),
    span,
    url: graphUrl(base, [loaded.ref], span),
    pushCount: pushes.length,
    threshold,
    alertsLoaded: alerts !== null,
    entries,
  };
}

type MergedFinding = {
  index: number;
  change: DetectedChange | null;
  alert: SeriesAlert | null;
};

// One row per event, not one per analysis. A detected change and an alert
// within `MERGE_PUSH_DISTANCE` of each other, agreeing about direction, are the
// same finding seen twice; anything else stands alone.
function mergeFindings(
  detected: readonly DetectedChange[],
  alerts: readonly SeriesAlert[],
  pushes: readonly PushGroup[],
  indexOfPush: ReadonlyMap<number, number>,
): MergedFinding[] {
  const rows: MergedFinding[] = detected.map((change) => ({
    index: change.index,
    change,
    alert: null,
  }));
  const taken = new Set<MergedFinding>();

  for (const alert of alerts) {
    const index = indexOfPush.get(alert.pushId);
    if (index === undefined) continue;
    let best: MergedFinding | null = null;
    let bestDistance = Infinity;
    for (const row of rows) {
      if (taken.has(row) || !row.change) continue;
      if (row.change.isRegression !== alert.isRegression) continue;
      const distance = Math.abs(row.index - index);
      if (distance <= MERGE_PUSH_DISTANCE && distance < bestDistance) {
        best = row;
        bestDistance = distance;
      }
    }
    if (best) {
      best.alert = alert;
      taken.add(best);
    } else {
      rows.push({ index, change: null, alert });
    }
  }

  return rows.sort((a, b) => a.index - b.index || (pushes[a.index]?.x ?? 0) - (pushes[b.index]?.x ?? 0));
}

function describeEntry(
  row: MergedFinding,
  loaded: LoadedSeries,
  indexOfPush: ReadonlyMap<number, number>,
  span: Span,
  base: string,
  repoLink: RepoLinkInfo | null,
): ChangeEntry {
  const pushes = loaded.data.pushes;
  const after = pushes[row.index];
  // The pair has to come from whichever analysis placed the row, or the range
  // it spans is a mix of the two: the row's index is the detector's when there
  // is one, so its "before" is the push preceding that index — which is the
  // previous push *this series has data on*, the same thing the detector
  // compared against. An alert-only row uses the alert's own `prev_push_id`,
  // the push perfherder analysed, which is likewise not always the neighbour
  // on the graph (graphs.md, "Alerts").
  const beforePush = row.change
    ? pushes[row.index - 1]
    : loaded.data.pushById.get(row.alert!.prevPushId);

  const alertIndex = row.alert ? (indexOfPush.get(row.alert.pushId) ?? -1) : -1;
  const pushOffset =
    row.change && row.alert && alertIndex >= 0 ? row.index - alertIndex : null;

  const isRegression = row.change ? row.change.isRegression : (row.alert?.isRegression ?? false);

  return {
    atMs: after?.x ?? 0,
    pushId: after?.pushId ?? row.alert?.pushId ?? 0,
    revision: after?.revision ?? row.alert?.revision ?? '',
    prevPushId: beforePush?.pushId ?? row.alert?.prevPushId ?? null,
    prevRevision: beforePush?.revision ?? row.alert?.prevRevision ?? null,
    source: row.change && row.alert ? 'both' : row.change ? 'detected' : 'alert',
    isRegression,
    detected: row.change
      ? {
          beforeValue: row.change.beforeValue,
          afterValue: row.change.afterValue,
          relativeChange: row.change.relativeChange,
          pValue: row.change.pValue,
          effectSize: row.change.effectSize,
          beforeCount: row.change.beforeCount,
          afterCount: row.change.afterCount,
          windowStartMs: row.change.x0,
          windowEndMs: row.change.x1,
        }
      : null,
    alert: row.alert
      ? {
          summaryId: row.alert.summaryId,
          alertId: row.alert.alertId,
          amountPct: row.alert.amountPct,
          prevValue: row.alert.prevValue,
          newValue: row.alert.newValue,
          tValue: row.alert.tValue,
          status: alertStatusLabel(row.alert.alertStatus),
          summaryStatus: summaryStatusLabel(row.alert.summaryStatus),
          bugNumber: row.alert.bugNumber,
          reassignedFrom: row.alert.reassignment?.fromSummaryId ?? null,
          reassignedTo: row.alert.reassignment?.toSummaryId ?? null,
        }
      : null,
    pushOffset,
    url: pairUrl(base, loaded.ref, span, beforePush, after),
    pushlogUrl:
      repoLink && beforePush && after
        ? pushLogRangeUrl(repoLink, beforePush.revision, after.revision)
        : null,
    commits: null,
    commitsLabel: null,
    commitsCaveat: null,
  };
}

// Fold a fetched pushlog into a change row. Separate from `describeEntry`
// because the fetch is per-entry and optional (`--commits`), and a report that
// is correct without it should not be built differently when it has it.
export function attachCommits(entry: ChangeEntry, range: PushlogRange, limit: number): ChangeEntry {
  return {
    ...entry,
    commits: range.commits.slice(0, limit).map(
      (commit: Commit): CommitSummary => ({
        revision: commit.revision,
        author: commit.author,
        title: commitTitle(commit),
        bugs: commit.bugs,
        pushId: commit.pushId,
        pushTimestamp: commit.pushTimestamp,
      }),
    ),
    commitsLabel: pushlogLabel(range),
    commitsCaveat: pushlogCaveat(range),
  };
}

// ---------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------
//
// "How big is the change at *this* point, on each of these series?" — the
// question `changes` cannot answer, because `changes` reports the steps it
// found and the interesting case is a series where it found none.
//
// That case is not rare and it is not a bug. A platform that runs the benchmark
// once per push, where another runs it twelve times, has several times the
// per-push noise; a real 0.8% step clears α = 0.01 on one and not on the other.
// Reading the first graph's silence as "it didn't happen here" is the mistake
// this command exists to prevent, so it reports the size of the move *and*
// which of the detector's two bars it failed — the p-value or the floor.

export type StepSide = {
  pushCount: number;
  firstPushMs: number | null;
  lastPushMs: number | null;
  summary: PoolSummary | null;
};

export type StepEntry = {
  series: SeriesHeader;
  // What distinguishes this series from the others in the same run — the same
  // split the app's series list uses for its cards. Empty when there is only
  // one series, which has nothing to be distinguished from.
  label: string;
  url: string;
  before: StepSide;
  after: StepSide;
  // Null when either side is empty.
  medianDelta: number | null;
  medianDeltaFraction: number | null;
  meanDelta: number | null;
  test: MannWhitneyResult | null;
  direction: ChangeDirection;
  // The floor `changes.ts` would have held a step here to, and whether this one
  // clears it. Reported even when the test is decisive, because the two
  // together are the whole answer to "why is there no bar on this graph".
  floor: AlertThreshold;
  clearsFloor: boolean;
  clearsAlpha: boolean;
  // What the detector would have concluded. Not a claim that it *did* — its
  // windows are placed by segmentation, not by a point the caller named.
  wouldDetect: boolean;
};

export type StepReport = {
  // The instant the series were split at.
  atMs: number;
  // The revision the caller named, when they named one.
  revision: string | null;
  // Which repository resolved that revision.
  revisionRepository: string | null;
  windowPushes: number;
  span: Span;
  url: string;
  // Attributes every series shares, for the header.
  common: string;
  entries: StepEntry[];
};

export type StepInput = {
  loaded: readonly LoadedSeries[];
  // Parallel to `loaded`.
  thresholds: readonly AlertThreshold[];
  atMs: number;
  revision: string | null;
  revisionRepository: string | null;
  windowPushes: number;
  span: Span;
  base: string;
};

export function buildStepReport(input: StepInput): StepReport {
  const attrSets = input.loaded.map((one) => attrsForEntry(one.ref, one.meta));
  const split = splitCommonAttrs(attrSets);
  // With one series the split is by role rather than by agreement (see
  // seriesSummary.ts), which would put its whole identity in the header and
  // leave the row holding only the suite. A one-row table needs no header.
  const useSplit = input.loaded.length > 1 && split.mode === 'multi';

  const entries = input.loaded.map((one, i) =>
    stepEntry(
      one,
      input.thresholds[i] ?? DEFAULT_ALERT_THRESHOLD,
      input,
      useSplit ? chipText(split.distinct[i]) : '',
    ),
  );

  return {
    atMs: input.atMs,
    revision: input.revision,
    revisionRepository: input.revisionRepository,
    windowPushes: input.windowPushes,
    span: input.span,
    url: graphUrl(input.base, input.loaded.map((l) => l.ref), input.span),
    common: useSplit && split.hasCommon ? chipText(split.common) : '',
    entries,
  };
}

function chipText(attrs: SeriesAttrs | null): string {
  if (!attrs) return '';
  return attrChips(attrs)
    .map((chip) => chip.value)
    .join(' · ');
}

function stepEntry(
  loaded: LoadedSeries,
  threshold: AlertThreshold,
  input: StepInput,
  label: string,
): StepEntry {
  const pushes = loaded.data.pushes;
  // A push exactly at the split instant belongs to `after`, matching
  // `DetectedChange.index` — the first push *after* the step.
  const boundary = pushes.findIndex((p) => p.x >= input.atMs);
  const cut = boundary === -1 ? pushes.length : boundary;
  const beforePushes = pushes.slice(Math.max(0, cut - input.windowPushes), cut);
  const afterPushes = pushes.slice(cut, cut + input.windowPushes);

  const beforeValues = beforePushes.map((p) => p.mean);
  const afterValues = afterPushes.map((p) => p.mean);
  const before = sideOf(beforePushes, beforeValues);
  const after = sideOf(afterPushes, afterValues);

  const test =
    beforeValues.length > 0 && afterValues.length > 0
      ? mannWhitneyU(beforeValues, afterValues)
      : null;

  // Means, not medians, because `changes.ts` describes a step with means and
  // this number is meant to be read beside one of its bars.
  const beforeMean = before.summary?.mean ?? NaN;
  const afterMean = after.summary?.mean ?? NaN;
  const relative = relativeChange(beforeMean, afterMean);
  const clears =
    relative !== null && clearsFloor(threshold, beforeMean, afterMean, relative);
  const alpha = test !== null && test.pValue < CHANGE_ALPHA;

  return {
    series: seriesHeader(loaded),
    label,
    url: pairUrl(
      input.base,
      loaded.ref,
      input.span,
      beforePushes[beforePushes.length - 1],
      afterPushes[0],
    ) ?? graphUrl(input.base, [loaded.ref], input.span),
    before,
    after,
    medianDelta:
      before.summary && after.summary ? after.summary.median - before.summary.median : null,
    medianDeltaFraction:
      before.summary && after.summary
        ? relativeChange(before.summary.median, after.summary.median)
        : null,
    meanDelta: before.summary && after.summary ? afterMean - beforeMean : null,
    test,
    direction: changeDirection(beforeMean, afterMean, loaded.meta.lowerIsBetter, alpha),
    floor: detectionFloor(threshold),
    clearsFloor: clears,
    clearsAlpha: alpha,
    wouldDetect: clears && alpha,
  };
}

function sideOf(pushes: readonly PushGroup[], values: readonly number[]): StepSide {
  return {
    pushCount: pushes.length,
    firstPushMs: pushes[0]?.x ?? null,
    lastPushMs: pushes[pushes.length - 1]?.x ?? null,
    summary: summarize(values),
  };
}

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

export type CompareSideReport = {
  label: string;
  series: SeriesHeader;
  pushId: number;
  revision: string;
  pushTimeMs: number;
  runCount: number;
  valueCount: number;
  summary: PoolSummary | null;
  bandwidth: number;
  modes: { letter: string; location: number; share: number }[];
};

export type CompareReport = {
  kind: ComparisonKind;
  headline: string;
  swapped: boolean;
  base: CompareSideReport;
  next: CompareSideReport;
  medianDelta: number;
  medianDeltaFraction: number | null;
  meanDelta: number;
  direction: string;
  lowerIsBetter: boolean;
  unit: string;
  warning: string | null;
  test: MannWhitneyResult | null;
  // Null for a `replicate` comparison, which has no distribution.
  modes: ModeComparison | null;
  modeSummary: string | null;
  links: ComparisonLinks & { app: string | null };
  // Everything the ASCII density plot needs. Not in `--json` output's spirit to
  // carry 256 floats twice, but it is the same array the app draws and a caller
  // that wants to re-plot it should not have to recompute the KDE.
  plot: {
    min: number;
    max: number;
    maxDensity: number;
    curves: { label: string; density: number[] }[];
  } | null;
};

export type CompareInput = {
  base: { loaded: LoadedSeries; push: PushGroup };
  next: { loaded: LoadedSeries; push: PushGroup };
  span: Span;
  appBase: string;
  repoLink: RepoLinkInfo | null;
};

// Build the two `CompareSide`s `compare.ts` wants out of two *pushes*.
//
// The app's sides come from clicked dots, so each carries a run and a replicate
// index. A CLI comparison is between builds, so it names each push's first run
// at MEAN_REPLICATE — which makes `poolFor` take the whole push's replicate
// cloud (the `push` and `series` kinds already do) and leaves `markedIndex` at
// -1, since no single value was singled out.
function sideFor(loaded: LoadedSeries, push: PushGroup): CompareSide {
  return {
    ref: loaded.ref,
    meta: loaded.meta,
    color: '',
    push,
    run: push.runs[0],
    replicateIndex: MEAN_REPLICATE,
    value: push.mean,
  };
}

export function buildCompareReport(input: CompareInput): CompareReport | null {
  const comparison = buildComparison(
    sideFor(input.next.loaded, input.next.push),
    sideFor(input.base.loaded, input.base.push),
  );
  if (!comparison) return null;

  // Which loaded series each resolved side belongs to. `buildComparison`
  // reorders by time, so this cannot be assumed from the input order.
  const loadedFor = (side: CompareSide): LoadedSeries =>
    side.ref.signatureId === input.base.loaded.ref.signatureId &&
    side.ref.repository === input.base.loaded.ref.repository &&
    side.push.pushId === input.base.push.pushId
      ? input.base.loaded
      : input.next.loaded;

  const plot = hasDistribution(comparison) ? distributionFor(comparison) : null;
  const baseSeries = plot?.series[0];
  const nextSeries = plot?.series[1];

  const modes =
    baseSeries && nextSeries
      ? compareModes(
          {
            label: comparison.base.label,
            modes: baseSeries.modes,
            bandwidth: baseSeries.bandwidth,
            hasCurve: baseSeries.density.length > 0,
          },
          {
            label: comparison.next.label,
            modes: nextSeries.modes,
            bandwidth: nextSeries.bandwidth,
            hasCurve: nextSeries.density.length > 0,
          },
        )
      : null;

  return {
    kind: comparison.kind,
    headline: comparison.headline,
    swapped: comparison.swapped,
    base: sideReport(comparison, 'base', loadedFor(comparison.base), baseSeries),
    next: sideReport(comparison, 'next', loadedFor(comparison.next), nextSeries),
    medianDelta: comparison.medianDelta,
    medianDeltaFraction: comparison.medianDeltaFraction,
    meanDelta: comparison.meanDelta,
    direction: comparison.direction,
    lowerIsBetter: comparison.lowerIsBetter,
    unit: comparison.unit,
    warning: comparison.warning,
    test: comparison.test,
    modes,
    modeSummary: modes
      ? describeModeComparison(modes, {
          value: (v) => String(Number(v.toPrecision(6))),
          unit: comparison.unit,
          baseLabel: comparison.base.label,
          nextLabel: comparison.next.label,
        })
      : null,
    links: {
      ...comparisonLinks(comparison, input.repoLink),
      app: pairUrl(
        input.appBase,
        comparison.base.ref,
        input.span,
        comparison.base.push,
        comparison.next.push,
      ),
    },
    plot: plot
      ? {
          min: plot.domain.min,
          max: plot.domain.max,
          maxDensity: plot.maxDensity,
          curves: plot.series.map((s) => ({ label: s.label, density: s.density })),
        }
      : null,
  };
}

// Both sides on one grid and one axis, which is the whole point — two curves on
// separate domains cannot be compared, by eye or by anything else. No
// `stableScales`: that exists to stop a *hover* rescaling the chart, and
// nothing here hovers.
function distributionFor(comparison: Comparison): DistributionPlot {
  return buildDistribution([
    {
      label: comparison.base.label,
      color: '',
      values: comparison.base.values,
      markedIndex: comparison.base.markedIndex,
    },
    {
      label: comparison.next.label,
      color: '',
      values: comparison.next.values,
      markedIndex: comparison.next.markedIndex,
    },
  ]);
}

function sideReport(
  comparison: Comparison,
  which: 'base' | 'next',
  loaded: LoadedSeries,
  distribution: DistributionPlot['series'][number] | undefined,
): CompareSideReport {
  const side = comparison[which];
  return {
    label: side.label,
    series: seriesHeader(loaded),
    pushId: side.push.pushId,
    revision: side.push.revision,
    pushTimeMs: side.push.x,
    runCount: side.push.runs.length,
    valueCount: side.values.length,
    summary: side.summary,
    bandwidth: distribution?.bandwidth ?? 0,
    modes: distribution
      ? distribution.modes.peakLocs.map((location, i) => ({
          letter: distribution.modes.letters[i] ?? '?',
          location,
          share: distribution.modes.fracs[i] ?? 0,
        }))
      : [],
  };
}

// Whether a pool is big enough for the density estimate the mode analysis reads.
// Re-exported so `render.ts` can say why a comparison has no modes rather than
// silently omitting the section.
export function hasEnoughForCurve(push: PushGroup): boolean {
  return pushValues(push).length >= MIN_CURVE_VALUES;
}

// ---------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------

export type CommitsReport = {
  repository: string;
  fromRevision: string;
  toRevision: string;
  label: string;
  caveat: string | null;
  pushCount: number;
  hiddenRevisions: number;
  truncated: boolean;
  url: string | null;
  commits: CommitSummary[];
};

export function buildCommitsReport(
  repository: string,
  fromRevision: string,
  toRevision: string,
  range: PushlogRange,
  repoLink: RepoLinkInfo | null,
): CommitsReport {
  return {
    repository,
    fromRevision,
    toRevision,
    label: pushlogLabel(range),
    caveat: pushlogCaveat(range),
    pushCount: range.pushCount,
    hiddenRevisions: range.hiddenRevisions,
    truncated: range.truncated,
    url: repoLink ? pushLogRangeUrl(repoLink, fromRevision, toRevision) : null,
    commits: range.commits.map((commit) => ({
      revision: commit.revision,
      author: commit.author,
      title: commitTitle(commit),
      bugs: commit.bugs,
      pushId: commit.pushId,
      pushTimestamp: commit.pushTimestamp,
    })),
  };
}
