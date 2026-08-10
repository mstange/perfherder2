// Report objects → lines of text. Pure, and the only place that decides what a
// human (or an agent reading a terminal) sees.
//
// Two rules run through all of it:
//
//   - **Say what was asked and what came back.** Every command prints the range
//     it resolved, the repositories it looked in, and how many rows it is
//     showing out of how many it found. A truncated answer that looks complete
//     is the failure mode this whole codebase keeps running into (see the
//     `getCommonAlerts` note in graphs-todo.md), and it is worse in a CLI, where
//     there is no scrollbar to hint at the rest.
//   - **A missing thing and an empty thing print differently.** "no alerts" is a
//     finding; "alerts could not be fetched" is not. Same for a series with no
//     data in the range versus one that doesn't exist.

import { formatPValue, formatSignedPercent, formatValue } from '../lib/shared/chart';
import { bugUrl } from '../lib/shared/links';
import {
  axisLines,
  columnFor,
  densityRow,
  formatSpan,
  formatUtc,
  formatUtcDate,
  indent,
  markerRow,
  NONE,
  sparkline,
  table,
  truncate,
  wrap,
  type Align,
} from './format';
import type {
  ChangeEntry,
  ChangesReport,
  CommitsReport,
  CompareReport,
  CompareSideReport,
  PushRow,
  SearchReport,
  SeriesHeader,
  SeriesReport,
  StepEntry,
  StepReport,
} from './reports';

// Wide enough for the mode structure of a real replicate cloud to be legible,
// narrow enough to survive an 80-column terminal with a label in front of it.
const PLOT_WIDTH = 56;
const SPARK_WIDTH = 48;

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

// "idb-open-many-seq · open_duration · windows11-64-24h2-shippable · opt fission"
export function describeSeries(series: SeriesHeader): string {
  const parts = [series.suite, series.test, series.application, series.platform, series.options];
  return parts.filter(Boolean).join(' · ') || `signature ${series.signatureId}`;
}

function measurementLine(series: SeriesHeader): string {
  const bits = [series.unit || 'no unit', series.lowerIsBetter ? 'lower is better' : 'higher is better'];
  return bits.join(' · ');
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export function renderSearch(report: SearchReport): string[] {
  const out: string[] = [];
  const terms = [...report.chips, report.text].filter(Boolean).join(' ') || '(everything)';
  const fetched = Object.values(report.fetched).reduce((a, b) => a + b, 0);
  const days = Math.round(report.intervalSeconds / 86400);

  out.push(`search: ${terms}${report.parent ? ` · subtests of ${report.parent}` : ''}`);
  out.push(
    `${report.repos.join(', ')} · last ${days} days · ` +
      `${report.includeSubtests ? 'subtests included' : 'no subtests'} · ` +
      `${fetched.toLocaleString('en-US')} signatures fetched`,
  );
  out.push('');

  if (report.rows.length === 0) {
    // Which nothing this is matters. A parent that isn't in the fetched set is
    // a different problem from a parent with no children, and both are
    // different from a filter that matched nothing.
    if (report.parent && !report.parentFound) {
      out.push(`No signature ${report.parent} in the fetched set.`);
      out.push('');
      out.push(
        'Check the id and the repository, and widen --interval: the signatures endpoint only',
        'returns signatures that have run inside it, so a parent that has gone quiet is absent',
        'even though its id is valid.',
      );
      return out;
    }
    if (report.parent) {
      out.push(`${report.parent} has no subtests matching this search.`);
      out.push('');
      out.push(
        'Drop the other terms to see all of its subtests. If there are none at all, the parent',
        'may be a standalone signature — `has_subtests` is a claim, not a promise (design.md).',
      );
      return out;
    }
    out.push('No signatures match.');
    out.push('');
    out.push(
      'Try fewer terms, or drop a field chip — a chip is an exact match, so ' +
        '`platform:android` will not find `android-hw-a51-11-0-aarch64-shippable`. ' +
        'Free text is a substring match and is usually what you want first.',
    );
    return out;
  }

  const withRuns = report.rows.some((r) => r.runs !== null);
  // "APPLICATION", not "APP": the column header is where a reader learns the
  // chip name, and an abbreviated one taught `app:` — which is not a field, and
  // which used to be accepted in silence as free text.
  const headers = ['REF', 'SUITE', 'TEST', 'APPLICATION', 'PLATFORM', 'OPTIONS', 'UNIT'];
  const aligns: Align[] = ['left', 'left', 'left', 'left', 'left', 'left', 'left'];
  if (withRuns) {
    headers.push('RUNS');
    aligns.push('right');
  }

  const rows = report.rows.map((row) => {
    const cells = [
      row.ref,
      truncate(row.suite, 30),
      truncate(row.test, 34),
      row.application || NONE,
      truncate(row.platform, 34),
      truncate(row.options.join(' '), 30),
      row.unit || NONE,
    ];
    if (withRuns) cells.push(row.runs === null ? NONE : String(row.runs));
    return cells;
  });

  out.push(...table(headers, rows, aligns));
  out.push('');
  out.push(
    report.rows.length < report.matched
      ? `Showing ${report.rows.length} of ${report.matched} matching signatures — narrow the search or raise --limit.`
      : `${report.matched} matching ${report.matched === 1 ? 'signature' : 'signatures'}.`,
  );
  if (!report.includeSubtests) {
    out.push('Subtests were not fetched; pass --subtests to search inside them.');
  }
  return out;
}

// ---------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------

export function renderStep(report: StepReport): string[] {
  const out: string[] = [];
  const at = report.revision
    ? `${formatUtc(report.atMs)} (${report.revision.slice(0, 12)}${
        report.revisionRepository ? ` on ${report.revisionRepository}` : ''
      })`
    : formatUtc(report.atMs);
  out.push(`step at ${at} · up to ${report.windowPushes} pushes a side`);
  if (report.common) out.push(`all series: ${report.common}`);
  out.push('');

  const anyLabel = report.entries.some((e) => e.label);
  const rows = report.entries.map((entry) => {
    const cells = anyLabel ? [truncate(entry.label || entry.series.suite, 40)] : [];
    const b = entry.before.summary;
    const a = entry.after.summary;
    cells.push(
      `${entry.before.pushCount}/${entry.after.pushCount}`,
      b ? formatValue(b.mean) : NONE,
      a ? formatValue(a.mean) : NONE,
      entry.medianDeltaFraction === null && entry.meanDelta === null
        ? NONE
        : formatSignedPercent(relativeOf(entry)),
      entry.test ? formatPValue(entry.test.pValue) : NONE,
      entry.test ? entry.test.effectSize : NONE,
      verdictOf(entry),
    );
    return cells;
  });

  const headers = anyLabel ? ['SERIES'] : [];
  const aligns: Align[] = anyLabel ? ['left'] : [];
  headers.push('N', 'BEFORE', 'AFTER', 'CHANGE', 'P', 'EFFECT', 'VERDICT');
  aligns.push('right', 'right', 'right', 'right', 'right', 'left', 'left');

  out.push(...table(headers, rows, aligns));
  out.push('');
  out.push(
    'N is pushes before/after. BEFORE and AFTER are means over push means — the unit of',
    'analysis the change detector uses, so these numbers sit on the same scale as a `changes`',
    'row. P is the two-sided Mann-Whitney U over those push means.',
  );
  out.push('');

  // The point of the command: separate "no step here" from "a step the
  // detector could not certify on this series".
  const missed = report.entries.filter((e) => !e.wouldDetect && (e.clearsFloor || e.clearsAlpha));
  if (missed.length > 0) {
    out.push('Why `changes` is silent on some of these');
    for (const entry of missed) {
      const name = entry.label || describeSeries(entry.series);
      const floor =
        entry.floor.kind === 'absolute'
          ? `${formatValue(entry.floor.value)} ${entry.series.unit}`.trimEnd()
          : `${entry.floor.value}%`;
      out.push(
        entry.clearsAlpha
          ? `  ${name}: significant, but under the ${floor} floor the detector holds this signature to.`
          : `  ${name}: past the ${floor} floor, but p ${
              entry.test ? formatPValue(entry.test.pValue) : NONE
            } does not clear α = 0.01 — too few pushes, or too noisy, to certify here.`,
      );
    }
    out.push('');
    out.push(
      '  A step that fails either bar is still a step. Where the same move is confirmed on a',
      '  better-sampled series, absence of a bar here is absence of evidence, not evidence of',
      '  absence — which is the mistake this command exists to prevent.',
    );
    out.push('');
  }

  for (const entry of report.entries) {
    if (entry.before.pushCount === 0 || entry.after.pushCount === 0) {
      const name = entry.label || describeSeries(entry.series);
      out.push(
        `! ${name} has no pushes ${entry.before.pushCount === 0 ? 'before' : 'after'} the split` +
          ' — widen --range, or check the split point is inside it.',
      );
    }
  }

  out.push(report.url);
  return out;
}

// Percent for the table. The mean delta, matching what BEFORE and AFTER show
// and what a `changes` row reports; the median delta is in `--json`.
function relativeOf(entry: StepEntry): number {
  const before = entry.before.summary?.mean ?? NaN;
  const after = entry.after.summary?.mean ?? NaN;
  return before === 0 ? NaN : (after - before) / before;
}

function verdictOf(entry: StepEntry): string {
  if (!entry.test) return NONE;
  if (entry.wouldDetect) return entry.direction === 'none' ? 'change' : entry.direction;
  if (!entry.clearsAlpha) return 'not significant';
  return `${entry.direction === 'none' ? 'change' : entry.direction}, under floor`;
}

// ---------------------------------------------------------------------------
// series
// ---------------------------------------------------------------------------

export function renderSeries(report: SeriesReport): string[] {
  const out: string[] = [];
  out.push(`range: ${formatSpan(report.span.start, report.span.end)}  (UTC)`);
  out.push('');

  for (const entry of report.entries) {
    out.push(describeSeries(entry.series));
    out.push(`  ${entry.series.ref} · ${measurementLine(entry.series)}`);
    if (!entry.series.found) {
      out.push('  no such signature, or no data in this range');
      out.push('');
      continue;
    }
    if (entry.pushCount === 0) {
      out.push('  no data in this range');
      out.push('');
      continue;
    }

    out.push(
      `  ${entry.pushCount} pushes · ${entry.runCount} runs · ` +
        `${entry.replicateCount.toLocaleString('en-US')} replicate values · ` +
        `${formatUtcDate(entry.firstPushMs ?? 0)} → ${formatUtcDate(entry.lastPushMs ?? 0)}`,
    );
    const level = entry.level;
    if (level) {
      out.push(
        `  median ${formatValue(level.median)} ${entry.series.unit}`.trimEnd() +
          ` · mean ${formatValue(level.mean)} · sd ${formatValue(level.stdDev)}` +
          ` · cv ${(level.cv * 100).toFixed(1)}%` +
          ` · range ${formatValue(level.min)}–${formatValue(level.max)}`,
      );
    }
    if (entry.pushMeans.length > 1) {
      out.push(`  ${sparkline(entry.pushMeans, SPARK_WIDTH)}  (push means, oldest first)`);
    }
    if (entry.recentPushes && entry.recentPushes.length > 0) {
      out.push('');
      out.push(...indent(renderPushTable(entry.recentPushes)));
      out.push('');
    }
    out.push(`  ${entry.url}`);
    out.push('');
  }

  if (report.comparisons.length > 0) {
    out.push('Levels over the range');
    out.push('');
    const rows = report.comparisons.map((c) => [
      `${c.baseLabel} → ${c.nextLabel}`,
      formatValue(c.baseMedian),
      formatValue(c.nextMedian),
      c.ratio === null ? NONE : `${c.ratio.toFixed(3)}×`,
      c.deltaFraction === null ? NONE : formatSignedPercent(c.deltaFraction),
      c.test ? formatPValue(c.test.pValue) : NONE,
      c.test ? `${c.test.cliffsDelta.toFixed(2)} (${c.test.effectSize})` : NONE,
      c.betterLabel ?? NONE,
    ]);
    out.push(
      ...indent(
        table(
          // "BETTER", not "FASTER": half of perfherder's metrics are
          // higher-is-better, and a score of 10 beating a score of 8 is not a
          // statement about speed at all for the ones that measure size.
          ['PAIR', 'BASE', 'OTHER', 'RATIO', 'DELTA', 'P', "CLIFF'S δ", 'BETTER'],
          rows,
          ['left', 'right', 'right', 'right', 'right', 'right', 'left', 'left'],
        ),
      ),
    );
    for (const c of report.comparisons) {
      if (c.warning) out.push(`  ! ${c.baseLabel} → ${c.nextLabel}: ${c.warning}`);
    }
    out.push('');
    out.push(
      '  Medians are over push means, one value per push — the same unit of analysis the',
      '  change detector uses, and not the pooled replicates, which would report a sample',
      '  size the data has not earned. Nothing pairs a push on one side with a push on the',
      '  other, so this says which side is better over the window and never why. BETTER is',
      "  blank unless the test is significant and both sides agree on the metric's direction.",
    );
    out.push('');
  }

  out.push(report.url);
  return out;
}

// MEAN is `PushGroup.mean` — the mean of the runs' means, which is the value
// the app's connecting line passes through — while MEDIAN is over the push's
// whole pooled replicate cloud. Two different statistics, so two columns.
function renderPushTable(pushes: readonly PushRow[]): string[] {
  return table(
    ['WHEN', 'REVISION', 'RUNS', 'VALUES', 'MEAN', 'MEDIAN'],
    pushes.map((push) => [
      formatUtc(push.atMs),
      push.revision.slice(0, 12),
      String(push.runCount),
      String(push.valueCount),
      formatValue(push.mean),
      formatValue(push.median),
    ]),
    ['left', 'left', 'right', 'right', 'right', 'right'],
  );
}

// ---------------------------------------------------------------------------
// changes
// ---------------------------------------------------------------------------

// `legend` is false for every series after the first in a multi-ref run. The
// paragraph below explains the columns, which do not change between series, and
// printing it six times in one invocation was the single most common complaint
// in a live trial of this tool.
export function renderChanges(report: ChangesReport, legend = true): string[] {
  const out: string[] = [];
  out.push(describeSeries(report.series));
  out.push(`${report.series.ref} · ${measurementLine(report.series)}`);
  out.push(
    `${formatSpan(report.span.start, report.span.end)} (UTC) · ${report.pushCount} pushes · ` +
      `floor ${describeThreshold(report)}`,
  );
  out.push('');

  if (!report.series.found) {
    out.push('No such signature, or no data in this range.');
    return out;
  }
  if (!report.alertsLoaded) {
    out.push("! Perfherder's alerts could not be fetched, so the ALERT column is blank");
    out.push('  everywhere rather than empty where there is no alert.');
    out.push('');
  }

  if (report.entries.length === 0) {
    out.push(
      report.pushCount < 12
        ? `Nothing found — ${report.pushCount} pushes is too few to test a step (six a side is the minimum).`
        : 'No steps detected and no perfherder alerts in this range.',
    );
    out.push('');
    out.push(report.url);
    return out;
  }

  const rows = report.entries.map((entry) => {
    const d = entry.detected;
    return [
      formatUtc(entry.atMs),
      entry.revision.slice(0, 12),
      d ? formatValue(d.beforeValue) : entry.alert ? formatValue(entry.alert.prevValue) : NONE,
      d ? formatValue(d.afterValue) : entry.alert ? formatValue(entry.alert.newValue) : NONE,
      d
        ? formatSignedPercent(d.relativeChange)
        : entry.alert
          ? formatSignedPercent((entry.isRegression ? 1 : -1) * (entry.alert.amountPct / 100))
          : NONE,
      entry.isRegression ? 'regression' : 'improvement',
      d ? formatPValue(d.pValue) : NONE,
      describeSource(entry),
    ];
  });

  out.push(
    ...table(
      ['WHEN', 'REVISION', 'BEFORE', 'AFTER', 'CHANGE', 'VERDICT', 'P', 'SOURCE'],
      rows,
      ['left', 'left', 'right', 'right', 'right', 'left', 'right', 'left'],
    ),
  );
  out.push('');
  if (legend) {
    out.push(
      'BEFORE/AFTER and CHANGE are the detected step where there is one — a difference of means',
      'over up to 24 pushes a side — and the alert\'s own numbers otherwise. Where both exist they',
      'will differ, and both are right: perfherder averages a 12–24 push window, this one averages',
      'the window either side of the step it located. P is this app\'s rank test; perfherder has no',
      'comparable figure.',
    );
    out.push('');
  }

  for (const entry of report.entries) {
    out.push(...renderChangeDetail(entry));
  }

  out.push(report.url);
  return out;
}

function describeThreshold(report: ChangesReport): string {
  const { threshold } = report;
  const quarter = threshold.value * 0.25;
  return threshold.kind === 'absolute'
    ? `${formatValue(quarter)} ${report.series.unit} (a quarter of the signature's ${formatValue(threshold.value)} alerting threshold)`.trimEnd()
    : `${quarter}% (a quarter of the signature's ${threshold.value}% alerting threshold)`;
}

function describeSource(entry: ChangeEntry): string {
  if (entry.source === 'detected') return 'detected';
  const alert = entry.alert!;
  const label = `alert #${alert.summaryId}`;
  const status = alert.summaryStatus;
  const bug = alert.bugNumber ? `, bug ${alert.bugNumber}` : '';
  const offset =
    entry.source === 'both' && entry.pushOffset !== null && entry.pushOffset !== 0
      ? `, ${Math.abs(entry.pushOffset)} push${Math.abs(entry.pushOffset) === 1 ? '' : 'es'} apart`
      : '';
  return `${entry.source === 'both' ? 'both, ' : ''}${label} (${status}${bug}${offset})`;
}

function renderChangeDetail(entry: ChangeEntry): string[] {
  const out: string[] = [];
  const head = `${formatUtc(entry.atMs)}  ${entry.revision.slice(0, 12)}  ${
    entry.isRegression ? 'regression' : 'improvement'
  }`;
  out.push(head);

  if (entry.detected) {
    const d = entry.detected;
    out.push(
      `  detected: ${formatValue(d.beforeValue)} → ${formatValue(d.afterValue)} ` +
        `(${formatSignedPercent(d.relativeChange)}) over ${d.beforeCount} vs ${d.afterCount} pushes, ` +
        `p ${formatPValue(d.pValue)}, ${d.effectSize} effect`,
    );
  }
  if (entry.alert) {
    const a = entry.alert;
    const reassigned =
      a.reassignedTo !== null && a.reassignedTo !== a.summaryId
        ? ` · reassigned to #${a.reassignedTo}`
        : a.reassignedFrom !== null && a.reassignedFrom !== a.summaryId
          ? ` · reassigned from #${a.reassignedFrom}`
          : '';
    out.push(
      `  perfherder: alert #${a.alertId} in summary #${a.summaryId} · ` +
        `${formatValue(a.prevValue)} → ${formatValue(a.newValue)} (${a.amountPct.toFixed(2)}%) · ` +
        `${a.status}/${a.summaryStatus}${a.bugNumber ? ` · ${bugUrl(a.bugNumber)}` : ''}${reassigned}`,
    );
  }
  if (entry.prevRevision) {
    out.push(`  between ${entry.prevRevision.slice(0, 12)} and ${entry.revision.slice(0, 12)}`);
  }

  if (entry.commits) {
    if (entry.commits.length === 0) {
      out.push('  no commits in the range (the two pushes are adjacent with nothing between)');
    } else {
      out.push(`  ${entry.commitsLabel}:`);
      out.push(...indent(renderCommitTable(entry.commits), '    '));
    }
    if (entry.commitsCaveat) out.push(`  ! ${entry.commitsCaveat}`);
  }
  if (entry.pushlogUrl) out.push(`  pushlog: ${entry.pushlogUrl}`);
  if (entry.url) out.push(`  graph:   ${entry.url}`);
  out.push('');
  return out;
}

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

export function renderCompare(report: CompareReport): string[] {
  const out: string[] = [];
  out.push(`comparison: ${report.headline}`);
  if (report.swapped) {
    out.push('(the sides were put in time order, so the baseline is not the one given first)');
  }
  // For a two-push comparison both sides name one series, and spelling it out
  // twice is half the header saying nothing.
  const oneSeries = report.base.series.ref === report.next.series.ref;
  if (oneSeries) {
    out.push('');
    out.push(describeSeries(report.base.series));
    out.push(`${report.base.series.ref} · ${measurementLine(report.base.series)}`);
  }
  out.push('');

  out.push(...renderCompareSide(report.base, report.unit, !oneSeries));
  out.push('');
  out.push(...renderCompareSide(report.next, report.unit, !oneSeries));
  out.push('');

  if (report.warning) {
    out.push(`! ${report.warning}`);
    out.push('');
  }
  if (report.kind === 'unrelated') {
    // Reached by asking for two series at `@last`, which is rarely what anyone
    // means: two series need not run on the same pushes, so "the latest of
    // each" is two different builds. Worth saying, because the numbers below
    // are all well defined and none of them is the comparison that was wanted.
    out.push(
      '! These are two different series on two different pushes, so the delta below is a',
      "  difference between two builds as much as between two series. Give both sides the same",
      '  revision to compare them on one build, or use `perfherder series` to compare their',
      '  levels over a whole range.',
      '',
    );
  }

  const unit = report.unit ? ` ${report.unit}` : '';
  out.push('Difference');
  out.push(
    `  median  ${formatValue(report.base.summary?.median ?? NaN)} → ` +
      `${formatValue(report.next.summary?.median ?? NaN)}${unit}` +
      (report.medianDeltaFraction === null
        ? ''
        : `  (${formatSignedPercent(report.medianDeltaFraction)})`),
  );
  out.push(`  mean    ${formatValue(report.meanDelta)}${unit} absolute`);
  out.push(
    `  verdict ${
      report.direction === 'none'
        ? report.kind === 'push'
          ? 'no significant change'
          : `not applicable — ${report.headline} is not a before and an after`
        : report.direction
    }`,
  );
  out.push('');

  if (report.test) {
    const t = report.test;
    out.push('Mann-Whitney U (two-sided, over the replicate pools above)');
    out.push(
      `  p ${formatPValue(t.pValue)}${t.significant ? ' (significant at α = 0.05)' : ' (not significant at α = 0.05)'}` +
        ` · Cliff's δ ${t.cliffsDelta.toFixed(3)} (${t.effectSize})` +
        ` · CLES ${(t.cles * 100).toFixed(0)}%` +
        ` · n ${t.nBase} vs ${t.nNext}`,
    );
    // Both figures are the same quantity twice and neither reads without its
    // convention: δ is negative when the second side runs *higher*, matching
    // PerfCompare, and CLES is the same number as a percentage of pairs.
    out.push(
      `  δ < 0 means "${report.next.label}" tends to be higher; CLES is the share of pairs ` +
        `where "${report.next.label}" comes in below "${report.base.label}".`,
    );
    if (t.degenerate) {
      out.push('  ! every value in both pools is identical, so p = 1 by construction, not by evidence');
    } else if (t.smallSample) {
      out.push('  ! fewer than five values on a side — the normal approximation is shaky here');
    }
    out.push('');
  }

  if (report.plot && report.plot.curves.some((c) => c.density.length > 0)) {
    out.push('Distributions (both on one axis)');
    out.push(...indent(renderDensityPlot(report)));
    out.push('');
  }

  if (report.modeSummary) {
    out.push('Modes');
    out.push(...indent(wrap(report.modeSummary, 92)));
    if (report.modes && report.modes.resolution > 0) {
      // The load-bearing number: "moved" and "in place" are defined by it, and
      // without it a `+0.00%` row reads as snapped rather than measured.
      out.push(
        `  KDE bandwidths ${formatValue(report.base.bandwidth)} / ${formatValue(report.next.bandwidth)}` +
          `${report.unit ? ` ${report.unit}` : ''}; a peak has to move more than ` +
          `${formatValue(report.modes.resolution)} to count.`,
      );
    }
    if (report.modes && report.modes.pairs.length > 0) {
      out.push('');
      const rows = report.modes.pairs.map((p) => [
        `${p.baseLetter} → ${p.nextLetter}`,
        formatValue(p.baseLoc),
        formatValue(p.nextLoc),
        p.shiftFraction === null ? formatValue(p.shift) : formatSignedPercent(p.shiftFraction),
        p.moved ? 'moved' : 'in place',
        `${Math.round(p.baseShare * 100)}%`,
        `${Math.round(p.nextShare * 100)}%`,
        // Blank rather than "held" when the mode sets differ: neither word is
        // true of a share that changed only because another mode vanished.
        report.modes?.verdict === 'restructured' ? '' : p.reweighted ? 'reweighted' : 'held',
      ]);
      out.push(
        ...indent(
          table(
            ['MODE', 'BASE AT', 'NEXT AT', 'SHIFT', '', 'BASE %', 'NEXT %', ''],
            rows,
            ['left', 'right', 'right', 'right', 'left', 'right', 'right', 'left'],
          ),
        ),
      );
    }
    out.push('');
  }

  const links: [string, string | null][] = [
    ['graph', report.links.app],
    ['pushlog', report.links.pushlog],
    ['perf.compare', report.links.perfCompare],
    ['subtests', report.links.perfCompareSubtests],
  ];
  const present = links.filter(([, url]) => url !== null);
  if (present.length > 0) {
    out.push('Links');
    const width = Math.max(...present.map(([name]) => name.length));
    for (const [name, url] of present) out.push(`  ${name.padEnd(width)}  ${url}`);
  }
  return out;
}

function renderCompareSide(
  side: CompareSideReport,
  unit: string,
  showSeries: boolean,
): string[] {
  const out: string[] = [];
  out.push(showSeries ? `${side.label}: ${describeSeries(side.series)}` : `${side.label}`);
  out.push(
    `  ${side.revision.slice(0, 12)} · push ${side.pushId} · ${formatUtc(side.pushTimeMs)} · ` +
      `${side.runCount} ${side.runCount === 1 ? 'run' : 'runs'}, ${side.valueCount} values`,
  );
  const s = side.summary;
  if (s) {
    out.push(
      `  median ${formatValue(s.median)}${unit ? ` ${unit}` : ''} · mean ${formatValue(s.mean)} · ` +
        `sd ${formatValue(s.stdDev)} · cv ${(s.cv * 100).toFixed(1)}% · ` +
        `range ${formatValue(s.min)}–${formatValue(s.max)}`,
    );
  }
  return out;
}

// One row per side over a shared axis and a shared density scale, so the two
// rows can be read against each other — which is the only reason to draw them.
// Mode letters go under each row rather than into it: overwriting a column of
// the curve to place a letter would hide the very peak it is labelling.
function renderDensityPlot(report: CompareReport): string[] {
  const plot = report.plot!;
  const out: string[] = [];
  const sides = [report.base, report.next];
  const width = Math.max(...sides.map((s) => s.label.length));

  for (let i = 0; i < plot.curves.length; i++) {
    const curve = plot.curves[i];
    const side = sides[i];
    if (curve.density.length === 0) {
      out.push(
        `${curve.label.padEnd(width)}  (${side.valueCount} values — too few for a density estimate)`,
      );
      continue;
    }
    out.push(`${curve.label.padEnd(width)}  ${densityRow(curve.density, PLOT_WIDTH, plot.maxDensity)}`);
    // Drawn for a single mode too. It is one line, and without it a unimodal
    // side's peak has to be located by eye against a three-tick ruler — which is
    // the one thing the reader came here to do.
    if (side.modes.length > 0) {
      const marks = side.modes.map((mode) => ({
        column: columnFor(mode.location, plot.min, plot.max, PLOT_WIDTH),
        label: mode.letter,
      }));
      out.push(`${' '.repeat(width)}  ${markerRow(marks, PLOT_WIDTH)}`);
    }
  }

  for (const line of axisLines(plot.min, plot.max, PLOT_WIDTH, report.unit)) {
    out.push(`${' '.repeat(width)}  ${line}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------

export function renderCommits(report: CommitsReport): string[] {
  const out: string[] = [];
  out.push(
    `${report.repository}: ${report.fromRevision.slice(0, 12)} → ${report.toRevision.slice(0, 12)}`,
  );
  out.push(
    `${report.label} across ${report.pushCount} ${report.pushCount === 1 ? 'push' : 'pushes'} ` +
      '(the base push is excluded, as hg\'s own pushlog excludes it)',
  );
  out.push('');
  if (report.commits.length === 0) {
    out.push('Nothing landed between these two revisions.');
    return out;
  }
  out.push(...renderCommitTable(report.commits));
  out.push('');
  if (report.caveat) out.push(`! ${report.caveat}`);
  if (report.url) out.push(report.url);
  return out;
}

function renderCommitTable(commits: readonly { revision: string; author: string; title: string; bugs: number[]; pushTimestamp: number }[]): string[] {
  return table(
    ['WHEN', 'REVISION', 'BUG', 'AUTHOR', 'SUMMARY'],
    commits.map((c) => [
      formatUtcDate(c.pushTimestamp * 1000),
      c.revision.slice(0, 12),
      c.bugs.length > 0 ? String(c.bugs[0]) : NONE,
      truncate(c.author, 22),
      truncate(c.title, 78),
    ]),
    ['left', 'left', 'right', 'left', 'left'],
  );
}

