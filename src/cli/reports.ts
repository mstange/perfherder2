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
  boundaryCandidates,
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
import { buildDistribution, type DistributionPlot } from '../lib/graphs/distribution';
import { buildDrift, type DriftSummary } from '../lib/graphs/drift';
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
import { attrsForEntry, chipText, splitCommonAttrs } from '../lib/graphs/seriesSummary';
import type { Commit, PushlogRange } from '../lib/graphs/pushlog';
import { commitTitle, pushlogCaveat, pushlogLabel } from '../lib/graphs/pushlog';
import type { Activity } from '../lib/picker/activity';
import {
  chipToString,
  compareRows,
  matchesRow,
  type Filter,
  type SortState,
} from '../lib/picker/filter';
import type { Series } from '../lib/picker/series';
import { pushLogRangeUrl, type RepoLinkInfo } from '../lib/shared/links';
import {
  changeDirection,
  mannWhitneyU,
  mean,
  median,
  relativeChange,
  summarize,
  type ChangeDirection,
  type MannWhitneyResult,
  type PoolSummary,
} from '../lib/shared/stats';
import { EMPTY_VIEW_STATE, serializeViewState, type SeriesEntryState, type ViewState } from '../lib/urlState';
import type { Span } from './args';
import { clusterLandings, type Landing, type LandingEvent } from '../lib/graphs/cluster';
import { compareModes, describeModeComparison, type ModeComparison } from './modes';
import { diagnoseNoMatch, type NoMatchDiagnosis } from './suggest';

// One signature, fetched. Defined here rather than in load.ts so the dependency
// runs impure → pure and never the other way.
export type LoadedSeries = {
  ref: SeriesRef;
  meta: SeriesMeta;
  data: SeriesData;
  found: boolean;
  // Why this series has no data, when the reason is that asking for it failed
  // rather than that there is none. Null for both kinds of success — a series
  // that came back, and one the endpoint answered about with nothing. See
  // `loadSeriesOrError`.
  error: string | null;
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
  // Carried on the header so that every command reports a failed fetch the same
  // way, and so `--json` distinguishes an empty series from an unasked one.
  error: string | null;
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
    error: loaded.error,
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
  // The `--like` slice, when one was asked for; null otherwise. The rows this
  // report was built from are already restricted to it.
  across: AcrossDescriptor | null;
  // Raw signature rows the API returned, per repository.
  fetched: Record<string, number>;
  matched: number;
  rows: SearchRow[];
  // Why nothing matched, when nothing did and there was something to blame.
  // Null for a search that matched, and for one with no terms at all.
  diagnosis: NoMatchDiagnosis | null;
};

// Which parent's subtests to restrict to. Only the repository and the id
// matter; a framework or an `@` selector on the reference is ignored, since
// neither narrows a parent-child relation.
export type ParentRef = { repository: string; signatureId: number };

// How a ref list was arrived at, when the caller named one row and asked for
// its counterparts across one attribute (`siblings.ts`). Reported rather than
// applied silently: a slice is a claim about coverage, and the two numbers that
// make it falsifiable are how many rows it found and how many it left out.
export type AcrossDescriptor = {
  fields: string[];
  // What the caller named, as `<repo>,<signatureId>`.
  anchors: string[];
  // Anchors that were not in the fetched signature list at all — a mistyped id,
  // the wrong repository, or a signature quiet enough to fall outside the
  // interval. Not the same answer as "it has no counterparts".
  missing: string[];
  // Rows sharing the anchors' framework, suite and test that were excluded
  // anyway, by what they differ in.
  omitted: { differs: string; rows: number }[];
  matched: number;
};

export type SearchInput = {
  rows: readonly Series[];
  fetched: ReadonlyMap<string, number>;
  filter: Filter;
  repos: readonly string[];
  intervalSeconds: number;
  includeSubtests: boolean;
  parent?: ParentRef | null;
  across?: AcrossDescriptor | null;
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
  // Only for an empty result: on a search that matched, the answer is the
  // answer, and this is several scans of up to thirty thousand rows.
  const diagnosis =
    matched.length === 0 && (input.filter.chips.length > 0 || input.filter.text.trim() !== '')
      ? diagnoseNoMatch(scoped, input.filter)
      : null;
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
    across: input.across ?? null,
    fetched: Object.fromEntries(input.fetched),
    matched: matched.length,
    diagnosis,
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
  // Where the series started against where it ended, when `--drift` asked. Null
  // when it did not, and also when the range holds too few pushes to say. The
  // figure itself is `drift.ts`, under `src/lib` because the app's series-list
  // card shows the same one.
  drift: DriftSummary | null;
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
  withDrift = false,
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
      drift: withDrift ? buildDrift(one.data.pushes) : null,
    };
  });

  // Row labels come from the same split `step` uses, so two series that share
  // an application are still told apart. They used to be `application ||
  // platform || name`, which printed the row "fenix → fenix" for two Fenix
  // configs differing only by `fission` — omitting the one attribute that
  // distinguished them, in the table whose entire job is to be the summary.
  const labels = distinguishingLabels(loaded);
  const comparisons: LevelComparison[] = [];
  for (let i = 1; i < loaded.length; i++) {
    const cmp = buildLevelComparison(loaded[0], loaded[i], labels[0], labels[i]);
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
  baseLabelOverride?: string,
  nextLabelOverride?: string,
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

  const baseLabel = baseLabelOverride || levelLabel(base);
  const nextLabel = nextLabelOverride || levelLabel(next);
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

// One label per series, each holding only what that series does not share with
// the others — `seriesSummary.ts`'s split, which is also what `step` labels its
// rows with. Falls back to `levelLabel` where the split has nothing to say: one
// series, or metadata that never arrived.
export function distinguishingLabels(loaded: readonly LoadedSeries[]): string[] {
  const split = splitCommonAttrs(loaded.map((one) => attrsForEntry(one.ref, one.meta)));
  return loaded.map((one, i) => {
    if (loaded.length < 2 || split.mode !== 'multi') return levelLabel(one);
    return chipText(split.distinct[i]) || levelLabel(one);
  });
}

// The fallback: the shortest thing that names a series on its own. Only good
// enough when there is nothing to contrast it with — see `distinguishingLabels`
// for why it is not good enough when there is.
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
  // The instant of the push on the other side of the change; null when that
  // push is not in the fetched range. With `atMs` this is the interval the
  // change is bracketed by — the only thing about a bar's position that is not
  // an estimate.
  prevAtMs: number | null;
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
  // How many commits of the range `--commit-limit` held back. `commitsLabel`
  // counts the *range*, so without this a limit of 8 over a 36-commit range
  // prints "36 commits:" above eight rows — a truncated answer shaped exactly
  // like a complete one, which is the one thing this tool does not do quietly.
  commitsOmitted: number;
  // How many commits `--commit-grep` excluded, for the same reason. Null when
  // no pattern was given, so "nothing was filtered" and "no filter ran" stay
  // different answers.
  commitsFiltered: number | null;
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
    // The instant of the push on the *other* side of the change, so that a row
    // carries the interval it brackets and not only the point it was placed at.
    // A bar has no interval of its own (see `locate`), and (prevAtMs, atMs] is
    // the one thing about it that is not an estimate: whatever landed, landed in
    // there. `cluster.ts` intersects these across series.
    prevAtMs: beforePush?.x ?? null,
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
    commitsOmitted: 0,
    commitsFiltered: null,
    commitsCaveat: null,
  };
}

// A pushlog `Commit` as the report carries it: `commitTitle` collapses the
// message to its first line, and everything else passes through. Both commands
// that list commits — `changes --commits` and `commits` — project the same way,
// so a field added to `CommitSummary` reaches both.
function commitSummary(commit: Commit): CommitSummary {
  return {
    revision: commit.revision,
    author: commit.author,
    title: commitTitle(commit),
    bugs: commit.bugs,
    pushId: commit.pushId,
    pushTimestamp: commit.pushTimestamp,
  };
}

// Does this commit answer `--commit-grep`? Title, author and bug number, because
// the question the flag exists for — "which of these twenty commits could have
// caused this" — is asked of a subsystem ("quota|indexeddb"), a person, or a
// bug, and a reader who has to remember which of the three the pattern searches
// will pick wrong. Case-insensitive for the same reason `search`'s free text is.
export function commitMatches(commit: CommitSummary, pattern: RegExp): boolean {
  return (
    pattern.test(commit.title) ||
    pattern.test(commit.author) ||
    commit.bugs.some((bug) => pattern.test(String(bug)))
  );
}

export type CommitOptions = {
  limit: number;
  // Null when `--commit-grep` was not given.
  grep: RegExp | null;
};

// The line above the commit table. `commitsLabel` alone is a count of the range,
// and the list under it may be shorter for two independent reasons, so the
// heading names each one that applied and the reader can tell three rows of
// three from three rows of thirty-six.
export function commitsHeading(entry: {
  commits: CommitSummary[] | null;
  commitsLabel: string | null;
  commitsOmitted: number;
  commitsFiltered: number | null;
}): string {
  const shown = entry.commits?.length ?? 0;
  const matched = shown + entry.commitsOmitted;
  const parts = [entry.commitsLabel ?? 'commits'];
  if (entry.commitsFiltered !== null) parts.push(`${matched} matching --commit-grep`);
  if (entry.commitsOmitted > 0) parts.push(`showing ${shown} (--commit-limit)`);
  return parts.join(', ');
}

// Fold a fetched pushlog into a change row. Separate from `describeEntry`
// because the fetch is per-entry and optional (`--commits`), and a report that
// is correct without it should not be built differently when it has it.
//
// Two narrowings happen here and **both are counted**, because `commitsLabel`
// describes the range rather than the list under it: a grep that excluded 19 of
// 20 commits and a range that only had one are the same three rows on screen and
// entirely different answers to "what landed here".
export function attachCommits(
  entry: ChangeEntry,
  range: PushlogRange,
  options: CommitOptions,
): ChangeEntry {
  const all = range.commits.map(commitSummary);
  const matched = options.grep ? all.filter((c) => commitMatches(c, options.grep!)) : all;
  const shown = matched.slice(0, options.limit);
  return {
    ...entry,
    commits: shown,
    commitsLabel: pushlogLabel(range),
    commitsOmitted: matched.length - shown.length,
    commitsFiltered: options.grep ? all.length - matched.length : null,
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
  // Set when the ref list came from `--across` rather than from the command
  // line. The reader has to be able to tell the two apart: one is a list they
  // wrote and the other is a claim this tool made about what that list is.
  across: AcrossDescriptor | null;
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
  across?: AcrossDescriptor | null;
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
    across: input.across ?? null,
    entries,
  };
}

// ---------------------------------------------------------------------------
// changes --cluster
// ---------------------------------------------------------------------------
//
// The per-series reports of one `changes` run, regrouped so that a row is a
// landing rather than a series. See cluster.ts for why the grouping is on
// intervals; this function's whole job is to hand it labelled events and to name
// what the series had in common, which is `splitCommonAttrs` — the same factoring
// `step` and the app's series list use, so a four-platform table reads as one
// line per platform here too.

export type ClusterReport = {
  span: Span;
  url: string;
  // What every series in the run shares, for the header.
  common: string;
  // How many series contributed, and how many of them had anything to contribute.
  seriesCount: number;
  seriesWithEvents: number;
  // Series whose fetch failed. A landing that only three of four platforms show
  // is a different finding depending on whether the fourth was quiet or missing.
  seriesFailed: number;
  landings: Landing[];
};

export function buildClusterReport(
  reports: readonly ChangesReport[],
  loaded: readonly LoadedSeries[],
  span: Span,
  base: string,
): ClusterReport {
  const split = splitCommonAttrs(loaded.map((one) => attrsForEntry(one.ref, one.meta)));
  const useSplit = loaded.length > 1 && split.mode === 'multi';

  const events: LandingEvent[] = [];
  reports.forEach((report, i) => {
    const label = useSplit ? chipText(split.distinct[i]) : describeHeader(report.series);
    for (const entry of report.entries) {
      events.push({
        ref: report.series.ref,
        label: label || describeHeader(report.series),
        repository: report.series.repository,
        atMs: entry.atMs,
        prevAtMs: entry.prevAtMs,
        revision: entry.revision,
        prevRevision: entry.prevRevision,
        isRegression: entry.isRegression,
        relativeChange: entry.detected?.relativeChange ?? null,
        source: entry.source,
        alertSummaryId: entry.alert?.summaryId ?? null,
        bugNumber: entry.alert?.bugNumber ?? null,
        // Nothing to carry: the report is the fields above. The app fills this
        // in with the entry and change a click needs — see cluster.ts.
        payload: undefined,
      });
    }
  });

  return {
    span,
    url: graphUrl(base, loaded.map((one) => one.ref), span),
    common: useSplit && split.hasCommon ? chipText(split.common) : '',
    seriesCount: reports.length,
    seriesWithEvents: reports.filter((r) => r.entries.length > 0).length,
    seriesFailed: reports.filter((r) => r.series.error !== null).length,
    landings: clusterLandings(events),
  };
}

function describeHeader(series: SeriesHeader): string {
  return [series.suite, series.test, series.platform].filter(Boolean).join(' · ');
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
// locate
// ---------------------------------------------------------------------------
//
// "Which of these pushes is the step on?" — a question neither the app nor any
// other command here answers. A bar is a point estimate with no interval, and on
// one real series it sat five hours before the push a sheriff's independent
// alert landed on, with nothing to say whether the two were arguing or agreeing
// within the noise.
//
// So this ranks every split in a window by the detector's *own* criterion —
// `boundaryCandidates`, which is the scoring `relocateBoundary` uses to place a
// bar — and prints the top few with the push each one names. Reusing that score
// is the whole point: a ranking on any other statistic would be a second opinion
// about where a bar goes, from the tool whose claim is that it agrees with the
// app. The top row is where the detector would put the mark; how far behind the
// second row is, and how much time the top rows span, is the interval the bar
// never had.

export type LocateCandidate = {
  rank: number;
  index: number;
  pushId: number;
  revision: string;
  atMs: number;
  // The push before this cut — the other end of the "somewhere between these
  // two" the candidate really names.
  prevRevision: string | null;
  prevAtMs: number | null;
  nBefore: number;
  nAfter: number;
  beforeValue: number;
  afterValue: number;
  relativeChange: number | null;
  pValue: number;
  cliffsDelta: number;
  effectSize: string;
  // |δ| less one standard error of it: what the ranking is by.
  score: number;
  clearsAlpha: boolean;
  clearsFloor: boolean;
  // A perfherder alert sits on this push. Null when alerts could not be fetched.
  alert: boolean | null;
};

export type LocateReport = {
  series: SeriesHeader;
  span: Span;
  url: string;
  // The point the caller named, and the window taken around it.
  atMs: number;
  revision: string | null;
  revisionRepository: string | null;
  windowPushes: number;
  windowStartMs: number | null;
  windowEndMs: number | null;
  windowPushCount: number;
  floor: AlertThreshold;
  alertsLoaded: boolean;
  // Candidates by score, best first, cut to the caller's --top.
  candidates: LocateCandidate[];
  totalCandidates: number;
  // How far apart the shown candidates put the step. The interval a bar lacks:
  // descriptive, not a confidence statement.
  spanMs: number | null;
  spanPushes: number | null;
};

export type LocateInput = {
  loaded: LoadedSeries;
  threshold: AlertThreshold;
  alerts: SeriesAlert[] | null;
  atMs: number;
  revision: string | null;
  revisionRepository: string | null;
  windowPushes: number;
  top: number;
  span: Span;
  base: string;
};

export function buildLocateReport(input: LocateInput): LocateReport {
  const pushes = input.loaded.data.pushes;
  const values = pushes.map((p) => p.mean);
  // The same split rule `step` uses: a push exactly at the instant is the first
  // one *after* it, matching `DetectedChange.index`.
  const boundary = pushes.findIndex((p) => p.x >= input.atMs);
  const centre = boundary === -1 ? pushes.length : boundary;
  const windowStart = Math.max(0, centre - input.windowPushes);
  const windowEnd = Math.min(pushes.length, centre + input.windowPushes);

  const alertPushIds = new Set((input.alerts ?? []).map((alert) => alert.pushId));
  const scored = boundaryCandidates(values, windowStart, windowEnd)
    .map((candidate) => {
      const beforeValue = mean(values.slice(windowStart, candidate.cut));
      const afterValue = mean(values.slice(candidate.cut, windowEnd));
      const relative = relativeChange(beforeValue, afterValue);
      const push = pushes[candidate.cut];
      const previous = pushes[candidate.cut - 1];
      return {
        rank: 0,
        index: candidate.cut,
        pushId: push.pushId,
        revision: push.revision,
        atMs: push.x,
        prevRevision: previous?.revision ?? null,
        prevAtMs: previous?.x ?? null,
        nBefore: candidate.nBefore,
        nAfter: candidate.nAfter,
        beforeValue,
        afterValue,
        relativeChange: relative,
        pValue: candidate.test.pValue,
        cliffsDelta: candidate.test.cliffsDelta,
        effectSize: candidate.test.effectSize,
        score: candidate.score,
        clearsAlpha: candidate.test.pValue < CHANGE_ALPHA,
        clearsFloor:
          relative !== null && clearsFloor(input.threshold, beforeValue, afterValue, relative),
        alert: input.alerts === null ? null : alertPushIds.has(push.pushId),
      };
    })
    // Best first, and on a tie the earlier push — the same preference
    // `relocateBoundary` expresses by keeping the nearest cut, reduced to
    // something a table can be ordered by.
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((candidate, i) => ({ ...candidate, rank: i + 1 }));

  const shown = scored.slice(0, Math.max(1, input.top));
  const times = shown.map((c) => c.atMs);
  const indices = shown.map((c) => c.index);

  return {
    series: seriesHeader(input.loaded),
    span: input.span,
    url: graphUrl(input.base, [input.loaded.ref], input.span),
    atMs: input.atMs,
    revision: input.revision,
    revisionRepository: input.revisionRepository,
    windowPushes: input.windowPushes,
    windowStartMs: pushes[windowStart]?.x ?? null,
    windowEndMs: pushes[windowEnd - 1]?.x ?? null,
    windowPushCount: Math.max(0, windowEnd - windowStart),
    floor: detectionFloor(input.threshold),
    alertsLoaded: input.alerts !== null,
    candidates: shown,
    totalCandidates: scored.length,
    spanMs: times.length > 1 ? Math.max(...times) - Math.min(...times) : null,
    spanPushes: indices.length > 1 ? Math.max(...indices) - Math.min(...indices) : null,
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
  // How many pushes this side pooled, and over what span, when `--pool` widened
  // it past the one push named. `1` and a zero-width span otherwise.
  pushCount: number;
  firstPushMs: number;
  lastPushMs: number;
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
  // Which values the test above was computed over. A pooled comparison's test
  // is over *push means*, not over the pooled replicates — see
  // `buildCompareReport`.
  testBasis: 'replicates' | 'push means';
  // Set when `--pool` was used, naming what was pooled — and carrying the
  // push-weighted level of each side, which is the figure `step` and `changes`
  // print. The medians elsewhere in the report are over the pooled replicates
  // and so weight a push by how many times it ran; the two differ, both are
  // right, and a tool that prints one of them must not leave the other
  // unreconciled.
  pool: {
    basePushes: number;
    nextPushes: number;
    baseLevel: number;
    nextLevel: number;
    levelFraction: number | null;
  } | null;
  // Set when `--pool n` could not reach `n` pushes on a side.
  //
  // **This is the report saying so rather than a failure**: the comparison is still
  // a real comparison of the two builds named, resting on fewer pushes than asked
  // for. It needs saying because the silent version looked exactly like a pool that
  // worked — `compare --pool 24 <ref>@first last` produced a 1-vs-1 comparison and
  // then "too few values for a density estimate", with nothing anywhere connecting
  // the missing modes to the request that never landed. `step` has always got this
  // right: it says "up to 24 pushes a side" and prints the counts it actually got.
  //
  // One cause, and it is `poolPushes`'s design rather than a bug: pooling reaches
  // *outward* from the push named — the earlier side backward, the later side
  // forward, so the two windows meet at the step instead of straddling it — so a
  // push within `n` of that end of the range has nothing to reach, and `@first` /
  // `@last` have nothing at all.
  poolShortfall: {
    requested: number;
    baseGot: number;
    nextGot: number;
  } | null;
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

// One side of a comparison: the push the caller named, and — when `--pool`
// widened it — the window of pushes standing behind it. `push` is then the
// synthetic group `poolPushes` built, which keeps the named push's identity so
// every label and link still points at the build that was asked about.
export type ComparePoint = {
  loaded: LoadedSeries;
  push: PushGroup;
  pooled: PushGroup[] | null;
};

export type CompareInput = {
  base: ComparePoint;
  next: ComparePoint;
  span: Span;
  appBase: string;
  repoLink: RepoLinkInfo | null;
  // What `--pool` asked for, so the report can say when a side could not reach it —
  // see `CompareReport.poolShortfall`. `1` (or absent) means it was not asked for,
  // and no shortfall is possible.
  poolRequested?: number;
};

// A window of pushes as one `PushGroup`, so the mode analysis has a pool worth
// estimating a density from.
//
// The gap this closes was found by using the tool. `compare`'s mode analysis
// rests on one push's 25–75 replicates, and on a real series the mode *count*
// flipped between two legitimate choices of push pair — while `step`, which
// pools 24 pushes a side, reports no modes at all because it works in push
// means. The capability sat in the gap between two commands that each had half
// of it.
//
// `direction` says which way the window reaches: the earlier side pools
// backwards from the push named, the later side forwards, so the two windows
// meet at the step and never overlap. That is the same shape `step` uses, which
// is what lets the two commands' numbers be read against each other.
//
// The merged group keeps the named push's id, revision and timestamp — it is
// still a comparison *of that build*, and the links and labels must not start
// pointing somewhere else — and its `mean` is the mean of the window's push
// means, one weight per push, because that is the level the window sits at.
export function poolPushes(
  pushes: readonly PushGroup[],
  at: PushGroup,
  count: number,
  direction: 'backward' | 'forward',
): { push: PushGroup; pooled: PushGroup[] } {
  const index = pushes.findIndex((p) => p.pushId === at.pushId);
  if (index === -1 || count <= 1) return { push: at, pooled: [at] };
  const pooled =
    direction === 'backward'
      ? pushes.slice(Math.max(0, index - count + 1), index + 1)
      : pushes.slice(index, index + count);
  const runs = pooled.flatMap((p) => p.runs);
  const means = pooled.map((p) => p.mean);
  return {
    push: { ...at, runs, mean: means.reduce((a, b) => a + b, 0) / means.length },
    pooled,
  };
}

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

  // Which input point each resolved side came from. `buildComparison` reorders
  // by time, so this cannot be assumed from the input order.
  const pointFor = (side: CompareSide): ComparePoint =>
    side.ref.signatureId === input.base.loaded.ref.signatureId &&
    side.ref.repository === input.base.loaded.ref.repository &&
    side.push.pushId === input.base.push.pushId
      ? input.base
      : input.next;
  const loadedFor = (side: CompareSide): LoadedSeries => pointFor(side).loaded;

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

  // **A pooled comparison is tested over push means, not over its pooled
  // replicates**, and this is the one place the CLI overrides a number
  // compare.ts computed. The reason is changes.ts's, at length: replicates of a
  // run are repeated measurements of one number and every run of a push shares
  // the binary and the moment, so 24 pushes × 30 replicates is 720 values and
  // nothing like 720 independent draws. A rank test told otherwise reports a
  // p-value it has not earned — and at these sizes it would be p < 1e-100 for
  // any two windows at all, which is worse than no number.
  //
  // What the pooled cloud *is* good for is its shape, which is the whole reason
  // to pool: the KDE, the modes and the spread all describe it. So the pools
  // stay pooled and only the test changes unit. The statistic is still
  // `mannWhitneyU` from stats.ts, over the same push means `step` and `changes`
  // use, which is what lets a pooled `compare` and a `step` at the same point be
  // read against each other.
  const basePooled = pointFor(comparison.base).pooled;
  const nextPooled = pointFor(comparison.next).pooled;
  const baseGot = basePooled?.length ?? 1;
  const nextGot = nextPooled?.length ?? 1;
  const pooling = baseGot > 1 || nextGot > 1;
  // Both sides, whenever either fell short, because "24 and 1" is the diagnosis and
  // "1" on its own is not: it does not say whether the range is too short or one
  // anchor was too near an edge.
  const requested = input.poolRequested ?? 1;
  const poolShortfall =
    requested > 1 && (baseGot < requested || nextGot < requested)
      ? { requested, baseGot, nextGot }
      : null;
  const baseMeans = (basePooled ?? []).map((p) => p.mean);
  const nextMeans = (nextPooled ?? []).map((p) => p.mean);
  const pooledTest = pooling ? mannWhitneyU(baseMeans, nextMeans) : null;
  const test = pooling ? pooledTest : comparison.test;

  return {
    kind: comparison.kind,
    headline: comparison.headline,
    swapped: comparison.swapped,
    base: sideReport(comparison, 'base', loadedFor(comparison.base), baseSeries, basePooled),
    next: sideReport(comparison, 'next', loadedFor(comparison.next), nextSeries, nextPooled),
    medianDelta: comparison.medianDelta,
    medianDeltaFraction: comparison.medianDeltaFraction,
    meanDelta: comparison.meanDelta,
    // Recomputed when pooling, because `changeDirection` is gated on the test's
    // significance and the test is no longer the one comparison.ts ran. Only
    // the `push` kind gets a direction at all; that rule is compare.ts's.
    direction:
      pooling && comparison.kind === 'push'
        ? changeDirection(
            comparison.base.summary?.median ?? NaN,
            comparison.next.summary?.median ?? NaN,
            comparison.lowerIsBetter,
            test?.significant ?? false,
          )
        : comparison.direction,
    lowerIsBetter: comparison.lowerIsBetter,
    unit: comparison.unit,
    warning: comparison.warning,
    test,
    testBasis: pooling ? 'push means' : 'replicates',
    pool: pooling
      ? {
          basePushes: baseGot,
          nextPushes: nextGot,
          baseLevel: mean(baseMeans),
          nextLevel: mean(nextMeans),
          levelFraction: relativeChange(mean(baseMeans), mean(nextMeans)),
        }
      : null,
    poolShortfall,
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
  pooled: readonly PushGroup[] | null,
): CompareSideReport {
  const side = comparison[which];
  const window = pooled && pooled.length > 0 ? pooled : [side.push];
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
    pushCount: window.length,
    firstPushMs: window[0].x,
    lastPushMs: window[window.length - 1].x,
  };
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
  // How many commits `--commit-grep` excluded; null when no pattern was given.
  // `label` counts the range, so without this a filtered list is three rows
  // under "35 commits" and reads as a range that only held three.
  filtered: number | null;
  url: string | null;
  commits: CommitSummary[];
};

export function buildCommitsReport(
  repository: string,
  fromRevision: string,
  toRevision: string,
  range: PushlogRange,
  repoLink: RepoLinkInfo | null,
  // Null when `--commit-grep` was not given, so that "the pattern excluded
  // nothing" and "no pattern ran" stay distinguishable in the report.
  grep: RegExp | null = null,
): CommitsReport {
  const all = range.commits.map(commitSummary);
  const matched = grep ? all.filter((c) => commitMatches(c, grep)) : all;
  return {
    repository,
    fromRevision,
    toRevision,
    label: pushlogLabel(range),
    caveat: pushlogCaveat(range),
    pushCount: range.pushCount,
    hiddenRevisions: range.hiddenRevisions,
    truncated: range.truncated,
    filtered: grep ? all.length - matched.length : null,
    url: repoLink ? pushLogRangeUrl(repoLink, fromRevision, toRevision) : null,
    commits: matched,
  };
}
