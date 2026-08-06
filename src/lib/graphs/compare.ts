// Comparison mode's model: two clicked points in, one described comparison out.
//
// Pure, and the single place that decides three things the rest of the app must
// not decide for itself (see docs/comparison.md):
//
//   1. How the two points are related — same series, same push, same run — which
//      is what makes the pane's numbers mean anything.
//   2. Which side is the baseline. Chronological, not click order.
//   3. Which values each side contributes. A push's whole replicate cloud for a
//      cross-push or cross-series comparison; one run's values when the two
//      points *are* two runs of one push, where pooling per push would hand both
//      sides the same numbers.
//
// The chart, the statistics and the labels all read the pools from here, so they
// can't end up describing different things.

import {
  indexInPushValues,
  MEAN_REPLICATE,
  pushValues,
  seriesLabel,
  type PushGroup,
  type Run,
  type SeriesMeta,
  type SeriesRef,
} from './graphData';
import {
  perfCompareSubtestsUrl,
  perfCompareUrl,
  pushLogRangeUrl,
  type RepoLinkInfo,
} from '../shared/links';
import {
  changeDirection,
  mannWhitneyU,
  relativeChange,
  summarize,
  type ChangeDirection,
  type MannWhitneyResult,
  type PoolSummary,
} from '../shared/stats';

// One clicked point, with as much of its series as a comparison needs. Built
// from an `AppState.Selection` — kept structural rather than importing that type
// so this module stays free of the reactive layer.
export type CompareSide = {
  ref: SeriesRef;
  meta: SeriesMeta | null;
  color: string;
  push: PushGroup;
  run: Run;
  // A real replicate index, or MEAN_REPLICATE.
  replicateIndex: number;
  value: number;
};

// How the two points are related. What the pane can usefully say depends
// entirely on this.
export type ComparisonKind =
  // Same series, different pushes: before and after. The case the feature is
  // shaped around.
  | 'push'
  // Same push, different series: firefox against chrome on one build.
  | 'series'
  // Same series and push, different runs: do two retriggers agree?
  | 'run'
  // Same run, two of its replicates. There is no distribution to compare — both
  // values come from one job — so each side is just its own number.
  | 'replicate'
  // Different series *and* different pushes. Rarely what anyone means, but the
  // delta and the test are still well defined.
  | 'unrelated';

export type ComparisonSide = CompareSide & {
  // Short enough for the chart legend at 320px: "before", "chrome", "run 2".
  label: string;
  // What this side contributes to the distribution and to the test.
  values: number[];
  // Index of the clicked value within `values`, or -1 when it isn't one of them
  // (a run-mean selection).
  markedIndex: number;
  summary: PoolSummary | null;
};

export type Comparison = {
  kind: ComparisonKind;
  // One line naming what is being compared, for the section subtitle.
  headline: string;
  base: ComparisonSide;
  next: ComparisonSide;
  // True when the baseline is the shift-clicked point rather than the selection
  // — i.e. the sides were put in time order rather than click order. The pane
  // says so, because otherwise "before" silently means "the one you clicked
  // second".
  swapped: boolean;
  // Null only when a side has no values at all.
  test: MannWhitneyResult | null;
  // next − base, on the medians. Median rather than mean because a multi-modal
  // cloud's mean sits between its modes, where no measurement is.
  medianDelta: number;
  // As a fraction of the base median; null when that median is zero.
  medianDeltaFraction: number | null;
  meanDelta: number;
  direction: ChangeDirection;
  lowerIsBetter: boolean;
  // Empty when the two sides disagree about their unit — see `warning`.
  unit: string;
  // Set when the comparison is defensible arithmetic but questionable science:
  // two series measured in different units, or with opposite ideas of which
  // direction is better. Rendered as a caution rather than suppressing the
  // numbers, since the user asked for this pair specifically.
  warning: string | null;
};

// Whether this comparison has a spread to draw, rather than two bare numbers.
// A `replicate` comparison is one value against one value: two one-dot strips
// say less than the push distribution underneath them does.
//
// Asked from two places — the comparison card, deciding whether to draw a
// chart, and the details pane, deciding whether to suppress the push
// distribution it would duplicate — so the rule lives here rather than being
// spelled `kind !== 'replicate'` in both.
export function hasDistribution(cmp: Comparison): boolean {
  return cmp.kind !== 'replicate';
}

// ---------------------------------------------------------------------------
// Classification and ordering
// ---------------------------------------------------------------------------

function sameSeries(a: CompareSide, b: CompareSide): boolean {
  return (
    a.ref.repository === b.ref.repository && a.ref.signatureId === b.ref.signatureId
  );
}

// Push ids are per-repository, so two repos' "push 12345" are unrelated builds —
// the repository has to be part of the test. (Same trap as `Series.key`; see
// design.md, "Row identity".)
function samePush(a: CompareSide, b: CompareSide): boolean {
  return a.ref.repository === b.ref.repository && a.push.pushId === b.push.pushId;
}

export function classifyComparison(a: CompareSide, b: CompareSide): ComparisonKind {
  if (sameSeries(a, b)) {
    if (!samePush(a, b)) return 'push';
    return a.run.datumId === b.run.datumId ? 'replicate' : 'run';
  }
  return samePush(a, b) ? 'series' : 'unrelated';
}

// Time order, finest tiebreakers last. One rule for every kind, and it
// degenerates to "leave them alone" exactly when there is no time order to use:
// two series on one push share a push timestamp, and their runs are unordered
// with respect to each other.
//
// Chronological rather than clicked because "did it get better or worse" only
// reads correctly in time order, and the pushlog and perf.compare links need
// `fromchange` to be the ancestor.
export function sideOrder(a: CompareSide, b: CompareSide): number {
  return (
    a.push.x - b.push.x ||
    // Expired jobs have no id; datumId below is the stable fallback.
    (a.run.jobId ?? 0) - (b.run.jobId ?? 0) ||
    a.run.datumId - b.run.datumId ||
    a.replicateIndex - b.replicateIndex
  );
}

// ---------------------------------------------------------------------------
// Pools and labels
// ---------------------------------------------------------------------------

function poolFor(kind: ComparisonKind, side: CompareSide): {
  values: number[];
  markedIndex: number;
} {
  if (kind === 'replicate') {
    // Two replicates of one job: each side is the one value that was clicked.
    // Pooling the run would hand both sides identical numbers, and pooling the
    // push would too.
    return { values: [side.value], markedIndex: 0 };
  }
  if (kind === 'run') {
    return {
      values: [...side.run.values],
      markedIndex: side.replicateIndex === MEAN_REPLICATE ? -1 : side.replicateIndex,
    };
  }
  return {
    values: pushValues(side.push),
    markedIndex: indexInPushValues(side.push, side.run.datumId, side.replicateIndex),
  };
}

// The first attribute on which two series differ, which is the shortest honest
// name for each of them. Falls through coarse to fine, so "chrome" wins over the
// platform string they also happen not to share.
//
// Same insight as the series list's shared-attribute header (see design.md):
// what distinguishes two series is almost always one word.
export function distinguishingLabels(a: CompareSide, b: CompareSide): [string, string] {
  const fields: ((side: CompareSide) => string)[] = [
    (s) => s.meta?.application ?? '',
    (s) => s.meta?.platform ?? '',
    (s) => (s.meta ? seriesLabel(s.meta) : ''),
    (s) => s.meta?.options ?? '',
    (s) => s.ref.repository,
  ];
  for (const read of fields) {
    const left = read(a);
    const right = read(b);
    if (left && right && left !== right) return [left, right];
  }
  // Two signatures we can't tell apart from their metadata; the ids always
  // differ, since a comparison of a point with itself never gets here.
  return [`signature ${a.ref.signatureId}`, `signature ${b.ref.signatureId}`];
}

function runIndexIn(push: PushGroup, run: Run): number {
  const i = push.runs.findIndex((r) => r.datumId === run.datumId);
  return i === -1 ? 0 : i;
}

function labelsFor(
  kind: ComparisonKind,
  base: CompareSide,
  next: CompareSide,
): [string, string] {
  switch (kind) {
    case 'push':
    case 'unrelated':
      return ['before', 'after'];
    case 'series':
      return distinguishingLabels(base, next);
    case 'run':
      return [
        `run ${runIndexIn(base.push, base.run) + 1}`,
        `run ${runIndexIn(next.push, next.run) + 1}`,
      ];
    case 'replicate':
      return [
        `replicate ${base.replicateIndex + 1}`,
        `replicate ${next.replicateIndex + 1}`,
      ];
  }
}

const HEADLINES: Record<ComparisonKind, string> = {
  push: 'one series, two pushes',
  series: 'one push, two series',
  run: 'one push, two runs',
  replicate: 'one run, two replicates',
  unrelated: 'different series, different pushes',
};

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

// Null when the two arguments are the same point: there is nothing to compare,
// and every number would be zero by construction.
export function buildComparison(
  selected: CompareSide,
  compared: CompareSide,
): Comparison | null {
  if (
    sameSeries(selected, compared) &&
    selected.run.datumId === compared.run.datumId &&
    selected.replicateIndex === compared.replicateIndex
  ) {
    return null;
  }

  const swapped = sideOrder(compared, selected) < 0;
  const baseSide = swapped ? compared : selected;
  const nextSide = swapped ? selected : compared;
  const kind = classifyComparison(baseSide, nextSide);
  const [baseLabel, nextLabel] = labelsFor(kind, baseSide, nextSide);

  const basePool = poolFor(kind, baseSide);
  const nextPool = poolFor(kind, nextSide);
  const base: ComparisonSide = {
    ...baseSide,
    label: baseLabel,
    ...basePool,
    summary: summarize(basePool.values),
  };
  const next: ComparisonSide = {
    ...nextSide,
    label: nextLabel,
    ...nextPool,
    summary: summarize(nextPool.values),
  };

  // No test for two replicates of one job: one value against one value produces
  // p = 1, δ = ±1 and "large effect" every time, which is statistical theatre
  // rather than information. The two numbers and their difference are the whole
  // answer there.
  const test = kind === 'replicate' ? null : mannWhitneyU(base.values, next.values);

  // "Improvement" and "regression" describe one thing measured twice, which only
  // the `push` kind is. Windows being slower than macOS on one build is not a
  // regression; two retriggers of one build differing is noise; and two
  // *different* series on two different pushes aren't a before and an after at
  // all, however well-defined their delta is. Labelling any of those would be a
  // category error dressed up as a finding.
  const isChangeOverTime = kind === 'push';
  const baseMedian = base.summary?.median ?? NaN;
  const nextMedian = next.summary?.median ?? NaN;
  const lowerIsBetter = base.meta?.lowerIsBetter ?? true;

  const baseUnit = base.meta?.measurementUnit ?? '';
  const nextUnit = next.meta?.measurementUnit ?? '';
  const unitsDiffer = !!baseUnit && !!nextUnit && baseUnit !== nextUnit;
  const directionsDiffer =
    !!base.meta && !!next.meta && base.meta.lowerIsBetter !== next.meta.lowerIsBetter;

  return {
    kind,
    headline: HEADLINES[kind],
    base,
    next,
    swapped,
    test,
    medianDelta: nextMedian - baseMedian,
    medianDeltaFraction: relativeChange(baseMedian, nextMedian),
    meanDelta: (next.summary?.mean ?? NaN) - (base.summary?.mean ?? NaN),
    direction: isChangeOverTime
      ? changeDirection(baseMedian, nextMedian, lowerIsBetter, test?.significant ?? false)
      : 'none',
    lowerIsBetter,
    unit: unitsDiffer ? '' : baseUnit || nextUnit,
    warning: unitsDiffer
      ? `These series are measured in different units (${baseUnit} and ${nextUnit}), so the difference between them is not meaningful.`
      : directionsDiffer
        ? 'These series disagree about which direction is better, so improvement and regression are not defined for the pair.'
        : null,
  };
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export type ComparisonLinks = {
  // Everything that landed between the two revisions. Same-repository only —
  // there is no such range across two repositories.
  pushlog: string | null;
  // PerfCompare over the whole framework.
  perfCompare: string | null;
  // PerfCompare's subtest table for each side's parent signature: the closest it
  // gets to "just these two series".
  perfCompareSubtests: string | null;
};

const NO_LINKS: ComparisonLinks = {
  pushlog: null,
  perfCompare: null,
  perfCompareSubtests: null,
};

// `repoLink` is the base side's repository record, for the hg-vs-git pushlog
// shape; null while `/repository/` hasn't landed, which only costs the pushlog.
export function comparisonLinks(
  c: Comparison,
  repoLink: RepoLinkInfo | null,
): ComparisonLinks {
  // Every link here compares two revisions. Within one push there is only one
  // revision, so a pushlog range would be empty and a perf.compare link would
  // compare a build against itself.
  if (c.base.push.revision === c.next.push.revision) return NO_LINKS;

  const sameRepo = c.base.ref.repository === c.next.ref.repository;
  const revisions = {
    baseRepo: c.base.ref.repository,
    baseRev: c.base.push.revision,
    newRepo: c.next.ref.repository,
    newRev: c.next.push.revision,
    // One framework parameter for both sides; the base's is the one that names
    // the comparison. Two series in different frameworks can't both be honoured.
    frameworkId: c.base.ref.frameworkId,
  };
  const baseParent = c.base.meta?.parentSignatureId ?? null;
  const nextParent = c.next.meta?.parentSignatureId ?? null;

  return {
    pushlog:
      sameRepo && repoLink
        ? pushLogRangeUrl(repoLink, c.base.push.revision, c.next.push.revision)
        : null,
    perfCompare: perfCompareUrl(revisions),
    perfCompareSubtests:
      baseParent !== null && nextParent !== null
        ? perfCompareSubtestsUrl({
            ...revisions,
            baseParentSignature: baseParent,
            newParentSignature: nextParent,
          })
        : null,
  };
}
