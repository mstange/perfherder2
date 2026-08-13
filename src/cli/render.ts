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

import {
  formatPValue,
  formatSignedPercent,
  formatSignedValue,
  formatValue,
} from '../lib/shared/chart';
import { bugUrl } from '../lib/shared/links';
import {
  axisLines,
  columnFor,
  densityRow,
  formatDurationMs,
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
import {
  formatWindowHours,
  landingSeriesCount,
  landingWindowLabel,
  peakChange,
  type Landing,
} from '../lib/graphs/cluster';
import type { DriftSummary } from '../lib/graphs/drift';
import { commitsHeading } from './reports';
import type {
  AcrossDescriptor,
  ChangeEntry,
  ChangesReport,
  ClusterReport,
  CommitsReport,
  CompareReport,
  CompareSideReport,
  LocateReport,
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

// How a `--like` / `--across` ref list was arrived at.
//
// Printed because the list is this tool's claim rather than the reader's
// instruction, and a claim about coverage that cannot be checked is the failure
// mode this file keeps guarding against. So both numbers are here: what the
// slice found, and what shares the suite and test and was held out of it
// anyway. The second is the one that says whether the strictness helped or hid
// something — an `option` line under `--across platform` usually means a
// platform that runs the test with a different configuration.
function describeAcross(across: AcrossDescriptor): string[] {
  const out = [
    `across ${across.fields.join(' and ')} from ${across.anchors.join(', ')} — ` +
      `${across.matched} series`,
  ];
  if (across.omitted.length > 0) {
    out.push(
      `  not included: ${across.omitted
        .map((o) => `${o.rows} differing in ${o.differs}`)
        .join(', ')} (same framework, suite and test)`,
    );
  }
  for (const missing of across.missing) {
    out.push(`  ! ${missing} is not in the fetched signature list, so it contributed nothing`);
  }
  return out;
}

// A series whose fetch failed, said the same way by every command.
//
// The distinction it protects is the one this file is built around: "could not
// ask" and "asked, and there is nothing" are different answers, and a row that
// prints the second when it means the first is the more dangerous of the two —
// a 502 on one of twenty-eight series would otherwise read as a quiet graph.
function fetchFailureLines(series: SeriesHeader): string[] {
  return [`! could not be fetched: ${series.error}`, '  (this row is missing, not empty)'];
}

// Only ever printed for a series that came back. `placeholderMeta` fills the
// unit with '' and the direction with a default, and "no unit · lower is
// better" reads as a fact about the metric rather than as the absence of one.
function measurementLine(series: SeriesHeader): string {
  if (!series.found) return 'no metadata';
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
  if (report.across) out.push(...describeAcross(report.across));
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
    if (report.across && report.across.matched === 0) {
      out.push(
        report.across.missing.length > 0
          ? `No signature ${report.across.missing.join(', ')} in the fetched set.`
          : `${report.across.anchors.join(', ')} has no counterparts across ${report.across.fields.join(' and ')}.`,
      );
      out.push('');
      out.push(
        report.across.missing.length > 0
          ? '  Check the id and the repository, and widen --interval: the signatures endpoint only\n' +
            '  returns signatures that have run inside it.'
          : '  It is the only row with this framework, suite, test, application and option set.',
      );
      return out;
    }
    out.push('No signatures match.');
    out.push('');
    out.push(...renderDiagnosis(report));
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

// What went wrong with a search that matched nothing, term by term.
//
// The generic advice this replaces was wrong twice over: it explained chips to
// a reader who had used none, and it had nothing to say about the real failure,
// which is that the corpus calls the thing something else. Both halves are now
// drawn from the fetched rows — which is the only place the answer was ever
// available — and the chip paragraph appears only for a search with a chip in
// it.
function renderDiagnosis(report: SearchReport): string[] {
  const out: string[] = [];
  const diagnosis = report.diagnosis;
  const culprits = diagnosis?.terms.filter((t) => t.alone === 0) ?? [];
  const survivors = diagnosis?.terms.filter((t) => t.alone > 0 && t.without > 0) ?? [];

  for (const term of culprits) {
    // "Without it, N rows match" is only worth saying when there is another
    // term to be left with: on a single-term search it restates the corpus
    // size, which the header line above already gives.
    const alone = diagnosis!.terms.length === 1;
    out.push(
      `  "${term.term}" matches nothing in the ${diagnosis!.scanned.toLocaleString('en-US')} ` +
        `rows searched${
          !alone && term.without > 0
            ? `; without it, ${term.without.toLocaleString('en-US')} rows match.`
            : '.'
        }`,
    );
    if (term.suggestions.length > 0) {
      out.push(
        `    try: ${term.suggestions
          .map((s) => `${s.term} (${s.rows} ${s.rows === 1 ? 'row' : 'rows'})`)
          .join(' · ')}`,
      );
    }
    if (term.field !== null) {
      // Said per chip and only for a chip, because it is the *chip* that is
      // exact — and this sentence used to be printed at a reader who had typed
      // free text, sending them to look for a wrong value.
      out.push(
        `    ${term.field}: is a chip, so it must equal a whole ${term.field} value, not a part of one.`,
      );
    }
    out.push('');
  }

  if (culprits.length === 0 && survivors.length > 0) {
    // Every term is a real word and the combination is what is empty, which is
    // a different problem and has a different answer.
    out.push('  Every term matches something on its own; it is the combination that is empty.');
    for (const term of survivors) {
      out.push(
        `    without "${term.term}": ${term.without.toLocaleString('en-US')} rows ` +
          `(it matches ${term.alone.toLocaleString('en-US')} on its own)`,
      );
    }
    out.push('');
  }

  if (!report.includeSubtests) {
    out.push('  Subtests were not fetched; pass --subtests to search inside them.');
  }
  if (culprits.length === 0 && survivors.length === 0) {
    out.push('  Try fewer terms, or widen --interval so quieter signatures are fetched.');
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
  if (report.across) out.push(...describeAcross(report.across));
  if (report.common) out.push(`all series: ${report.common}`);
  // Direction belongs beside the number it qualifies. A run over a suite's
  // subtests can hold a score and three timings, and then "+0.53% improvement"
  // sits directly above "-1.5% improvement" — both correct, and unreadable
  // unless each row says which way its own metric runs. Where every series
  // agrees, one header line says it once and the column is dropped.
  const metric = sharedMetric(report);
  if (metric) out.push(`measured in ${metric}`);
  out.push('');

  const anyLabel = report.entries.some((e) => e.label);
  const rows = report.entries.map((entry) => {
    const cells = anyLabel ? [truncate(entry.label || entry.series.suite, 40)] : [];
    if (!metric) cells.push(entry.series.found ? metricOf(entry.series) : NONE);
    const b = entry.before.summary;
    const a = entry.after.summary;
    cells.push(
      `${entry.before.pushCount}/${entry.after.pushCount}`,
      b ? formatValue(b.mean) : NONE,
      a ? formatValue(a.mean) : NONE,
      entry.meanDelta === null ? NONE : formatSignedValue(entry.meanDelta),
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
  if (!metric) {
    headers.push('METRIC');
    aligns.push('left');
  }
  headers.push('N', 'BEFORE', 'AFTER', 'Δ', 'CHANGE', 'P', 'EFFECT', 'VERDICT');
  aligns.push('right', 'right', 'right', 'right', 'right', 'right', 'left', 'left');

  out.push(...table(headers, rows, aligns));
  out.push('');
  out.push(
    'N is pushes before/after. BEFORE and AFTER are means over push means — the unit of',
    'analysis the change detector uses, so these numbers sit on the same scale as a `changes`',
    'row. P is the two-sided Mann-Whitney U over those push means.',
  );
  // Δ and CHANGE are the same move in two units and they rank differently: the
  // percentage says which subtest moved most, the absolute says which one moved
  // the suite. "Which subtests drove this" is the second question, and it used
  // to be unanswerable from this table.
  out.push(
    'Δ is AFTER − BEFORE in the metric\'s own unit, and CHANGE is the same difference relative',
    'to BEFORE. Rank by Δ for what drove a suite-level move; by CHANGE for what moved most.',
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
    const name = entry.label || describeSeries(entry.series);
    if (entry.series.error) {
      // Before the empty-side note below, and instead of it: a series that was
      // never fetched has no pushes on either side of anything, and saying so
      // would blame the range for a network failure.
      out.push(`! ${name} could not be fetched: ${entry.series.error}`);
      continue;
    }
    if (entry.before.pushCount === 0 || entry.after.pushCount === 0) {
      out.push(
        `! ${name} has no pushes ${entry.before.pushCount === 0 ? 'before' : 'after'} the split` +
          ' — widen --range, or check the split point is inside it.',
      );
    }
  }

  out.push(report.url);
  return out;
}

// "ms, lower is better" — the unit a row's numbers are in and which way that
// unit runs, which VERDICT's "improvement" is meaningless without.
function metricOf(series: SeriesHeader): string {
  return `${series.unit || 'no unit'}, ${series.lowerIsBetter ? 'lower' : 'higher'} is better`;
}

// The metric every series in the run shares, or empty when they don't share
// one. A header can only carry what is common; direction is not a shared
// attribute of a suite's subtests, and `splitCommonAttrs` doesn't consider it.
// A series that never arrived has a placeholder's metric, which is nobody's,
// so it neither supplies the shared answer nor prevents one.
function sharedMetric(report: StepReport): string {
  const known = report.entries.filter((e) => e.series.found);
  if (known.length === 0) return '';
  const first = metricOf(known[0].series);
  return known.every((e) => metricOf(e.series) === first) ? first : '';
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
// locate
// ---------------------------------------------------------------------------

export function renderLocate(report: LocateReport): string[] {
  const out: string[] = [];
  out.push(describeSeries(report.series));
  out.push(`${report.series.ref} · ${measurementLine(report.series)}`);
  const at = report.revision
    ? `${formatUtc(report.atMs)} (${report.revision.slice(0, 12)}${
        report.revisionRepository ? ` on ${report.revisionRepository}` : ''
      })`
    : formatUtc(report.atMs);
  out.push(
    `candidates around ${at} · ${report.windowPushCount} pushes ` +
      `(±${report.windowPushes} of the split)`,
  );
  out.push('');

  if (report.series.error) {
    out.push(...fetchFailureLines(report.series));
    return out;
  }
  if (report.candidates.length === 0) {
    out.push(
      report.windowPushCount < 4
        ? `Only ${report.windowPushCount} pushes in the window — nothing to rank. Widen --range.`
        : 'No split in this window has pools big enough for the rank test to reach α = 0.01.',
    );
    out.push('');
    out.push(report.url);
    return out;
  }

  const rows = report.candidates.map((c) => [
    String(c.rank),
    formatUtc(c.atMs),
    c.revision.slice(0, 12),
    `${c.nBefore}/${c.nAfter}`,
    formatValue(c.beforeValue),
    formatValue(c.afterValue),
    c.relativeChange === null ? NONE : formatSignedPercent(c.relativeChange),
    formatPValue(c.pValue),
    c.score.toFixed(3),
    // What the detector would do with this split, which is the column the reader
    // is really after: the top row is where a bar would go, and a row that fails
    // a bar is a candidate the detector could not have marked at all.
    c.clearsAlpha && c.clearsFloor ? 'would mark' : !c.clearsAlpha ? 'under α' : 'under floor',
    c.alert === null ? NONE : c.alert ? 'alert here' : '',
  ]);

  out.push(
    ...table(
      ['#', 'WHEN', 'REVISION', 'N', 'BEFORE', 'AFTER', 'CHANGE', 'P', 'SCORE', 'DETECTOR', 'PERFHERDER'],
      rows,
      ['right', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'left', 'left'],
    ),
  );
  out.push('');
  out.push(
    'SCORE is |Cliff\'s δ| less one standard error of it — the detector\'s own criterion for where',
    'a step goes (src/lib/graphs/changes.ts, `relocateBoundary`), so row 1 is the push a bar',
    'would land on and the rest are what it was chosen over. Ranking on anything else would be a',
    'second opinion about the app\'s own answer.',
  );
  if (report.candidates.length < report.totalCandidates) {
    out.push('');
    out.push(
      `Showing ${report.candidates.length} of ${report.totalCandidates} splits the test could ` +
        'reach α at — raise --top for the rest.',
    );
  }
  if (report.spanMs !== null && report.spanPushes !== null && report.spanPushes > 0) {
    out.push('');
    out.push(
      `These ${report.candidates.length} candidates span ${report.spanPushes} pushes and ` +
        `${formatDurationMs(report.spanMs)}, and the top two differ by ` +
        `${Math.abs(report.candidates[0].score - report.candidates[1].score).toFixed(3)} of score.`,
    );
    out.push(
      '  That spread is the interval a bar does not carry. Candidates whose scores are close are',
      '  not separated by the data, so an alert a few rows from the top is the same finding seen',
      '  twice, while one well down the list is a different claim about where the step is.',
    );
  }
  // The comparison the command exists for, spelled out rather than left to the
  // reader to compute from two rows: how much worse the push perfherder chose
  // scores than the one the detector would.
  const alerted = report.candidates.filter((c) => c.alert);
  if (report.alertsLoaded && alerted.length > 0) {
    out.push('');
    const best = report.candidates[0];
    for (const c of alerted) {
      out.push(
        c.rank === 1
          ? `Perfherder alerted on ${c.revision.slice(0, 12)}, which is row 1 — the two analyses ` +
            'agree about the push.'
          : `Perfherder alerted on ${c.revision.slice(0, 12)}: row ${c.rank} of ` +
            `${report.totalCandidates}, score ${c.score.toFixed(3)} against ` +
            `${best.score.toFixed(3)} at row 1, ${formatDurationMs(Math.abs(c.atMs - best.atMs))} ` +
            'apart.',
      );
    }
  } else if (!report.alertsLoaded) {
    out.push('');
    out.push("! Perfherder's alerts could not be fetched, so the PERFHERDER column is blank");
    out.push('  everywhere rather than empty where there is no alert.');
  }
  out.push('');
  out.push(report.url);
  return out;
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
    if (entry.series.error) {
      out.push(...indent(fetchFailureLines(entry.series)));
      out.push('');
      continue;
    }
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
      out.push(`  ${describeSparkline(entry.pushMeans, entry.series.unit)}`);
    }
    if (entry.drift) out.push(...indent(driftLines(entry.drift, entry.series)));
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

// A sparkline is drawn against its own extremes, and eight block characters
// carry no axis, so the row says what `▁` and `█` stand for. Without it the
// picture is only shape — a live trial read a 10% dip as a large improvement,
// having nothing but a `range` widened by outliers to scale it against, and the
// two numbers are not the same numbers: these are bucket means over the drawn
// columns, which is what the blocks are, and the level line above carries the
// raw spread.
function describeSparkline(values: readonly number[], unit: string): string {
  const spark = sparkline(values, SPARK_WIDTH);
  const suffix = unit ? ` ${unit}` : '';
  const scale =
    spark.low === spark.high
      ? `flat at ${formatValue(spark.low)}${suffix}`
      : `▁ ${formatValue(spark.low)} → █ ${formatValue(spark.high)}${suffix}`;
  return `${spark.text}  (push means, oldest first · ${scale})`;
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
// `brief` drops the per-event paragraphs and keeps the table. Twelve refs over
// six months emitted a block per event — 99 of them, each repeating a pushlog
// URL and a graph URL — and the reader's move was to pipe it to `tail`, which
// loses the top of the report: the same defect the `fenix → fenix` labels had,
// reached by the same route. The URLs are all still in `--json`, which is where
// a reader who wants 99 of them is going anyway.
export function renderChanges(report: ChangesReport, legend = true, brief = false): string[] {
  const out: string[] = [];
  out.push(describeSeries(report.series));
  out.push(`${report.series.ref} · ${measurementLine(report.series)}`);
  out.push(
    `${formatSpan(report.span.start, report.span.end)} (UTC) · ${report.pushCount} pushes` +
      // The floor is resolved from the signature's own threshold, and a series
      // that never arrived has a default standing in for one. Printing it would
      // state a policy for a signature nothing is known about.
      (report.series.found ? ` · floor ${describeThreshold(report)}` : ''),
  );
  out.push('');

  if (report.series.error) {
    out.push(...fetchFailureLines(report.series));
    return out;
  }
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
    // `--brief` keeps a commit list. It is the answer to "what caused this", the
    // reader paid a pushlog fetch per event for it, and dropping it would make
    // `--brief --commits` do all of the fetching and none of the reporting.
    if (brief) out.push(...renderChangeCommits(entry));
    else out.push(...renderChangeDetail(entry));
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

  out.push(...commitLines(entry));
  if (entry.pushlogUrl) out.push(`  pushlog: ${entry.pushlogUrl}`);
  if (entry.url) out.push(`  graph:   ${entry.url}`);
  out.push('');
  return out;
}

// `--brief` with `--commits`: which event, and what landed on it. No statistics
// paragraph — the table above carries the numbers — and no URLs.
function renderChangeCommits(entry: ChangeEntry): string[] {
  if (!entry.commits) return [];
  const out = [
    `${formatUtc(entry.atMs)}  ${entry.revision.slice(0, 12)}  ${
      entry.isRegression ? 'regression' : 'improvement'
    }`,
  ];
  out.push(...commitLines(entry));
  out.push('');
  return out;
}

// The commit list under one change, with the two narrowings it may have had
// declared. Shared by the full and brief forms so they cannot drift.
function commitLines(entry: ChangeEntry): string[] {
  if (!entry.commits) return [];
  const out: string[] = [];
  if (entry.commits.length === 0) {
    out.push(
      entry.commitsFiltered
        ? `  no commits match --commit-grep (${entry.commitsFiltered} in the range did not)`
        : '  no commits in the range (the two pushes are adjacent with nothing between)',
    );
  } else {
    out.push(`  ${commitsHeading(entry)}:`);
    out.push(...indent(renderCommitTable(entry.commits), '    '));
  }
  if (entry.commitsCaveat) out.push(`  ! ${entry.commitsCaveat}`);
  return out;
}

// Where the series started against where it ended. Two lines, because the
// figure means nothing without the windows it came from: a reader has to be able
// to see that "February" is 24 pushes and not the whole month.
function driftLines(drift: DriftSummary, series: SeriesHeader): string[] {
  const unit = series.unit ? ` ${series.unit}` : '';
  const delta =
    drift.deltaFraction === null
      ? NONE
      : formatSignedPercent(drift.deltaFraction);
  const direction =
    drift.deltaFraction === null || drift.deltaFraction === 0
      ? ''
      : ` ${(drift.deltaFraction > 0) === series.lowerIsBetter ? 'worse' : 'better'}`;
  return [
    `drift ${formatValue(drift.first.median)} → ${formatValue(drift.last.median)}${unit} · ` +
      `${delta}${direction}` +
      (drift.test ? ` · p ${formatPValue(drift.test.pValue)}` : ''),
    `  ${drift.windowPushes} pushes a side — ` +
      `${drift.first.startMs === null ? '?' : formatUtcDate(drift.first.startMs)}…` +
      `${drift.first.endMs === null ? '?' : formatUtcDate(drift.first.endMs)} against ` +
      `${drift.last.startMs === null ? '?' : formatUtcDate(drift.last.startMs)}…` +
      `${drift.last.endMs === null ? '?' : formatUtcDate(drift.last.endMs)}`,
  ];
}

// ---------------------------------------------------------------------------
// changes --cluster
// ---------------------------------------------------------------------------

// One row per landing, and under it the series that saw it. "How far did this
// reach" is the column a reader scans first — a step on one platform of three and
// a step on all three are different findings — and the per-series form of this
// report makes them count it by hand.
export function renderCluster(report: ClusterReport): string[] {
  const out: string[] = [];
  out.push(
    `${report.landings.length} ${report.landings.length === 1 ? 'landing' : 'landings'} across ` +
      `${report.seriesCount} series (${report.seriesWithEvents} with any change)`,
  );
  if (report.common) out.push(`all series: ${report.common}`);
  out.push(`${formatSpan(report.span.start, report.span.end)} (UTC)`);
  if (report.seriesFailed > 0) {
    // A landing that three of four platforms show is a different finding
    // depending on whether the fourth was quiet or never arrived.
    out.push(
      `! ${report.seriesFailed} of ${report.seriesCount} series could not be fetched, so a landing`,
      '  absent from them is missing rather than absent.',
    );
  }
  out.push('');

  if (report.landings.length === 0) {
    out.push('No steps detected and no perfherder alerts on any of these series in this range.');
    out.push('');
    out.push(report.url);
    return out;
  }

  out.push(
    ...table(
      ['WINDOW', 'HOURS', 'SERIES', 'REG', 'IMP', 'PEAK', 'BUGS'],
      report.landings.map((landing) => {
        const peak = peakChange(landing);
        return [
          `${formatUtc(landing.startMs)}${landing.intersects ? '' : ' ~'}`,
          formatWindowHours(landing),
          String(landingSeriesCount(landing)),
          landing.regressions > 0 ? String(landing.regressions) : NONE,
          landing.improvements > 0 ? String(landing.improvements) : NONE,
          peak === null ? NONE : formatSignedPercent(peak),
          landing.bugs.length > 0 ? landing.bugs.join(',') : NONE,
        ];
      }),
      ['left', 'right', 'right', 'right', 'right', 'right', 'left'],
    ),
  );
  out.push('');
  out.push(
    'WINDOW is where the members agree the landing is: the intersection of the push intervals each',
    'of them brackets it with, which is narrower than any one series carries. HOURS is how wide',
    'that window is. A ~ marks a landing whose members chained into one group without sharing a',
    'common instant, so its window is their union and a weaker claim. PEAK is the largest move by',
    'magnitude rather than the average — one platform at +500% and two at +8% is a +500% event',
    'with partial reach, not a +172% one.',
  );
  out.push('');

  for (const landing of report.landings) {
    out.push(...renderLanding(landing));
  }

  out.push(report.url);
  return out;
}

function renderLanding(landing: Landing): string[] {
  const out: string[] = [];
  out.push(
    `${formatUtc(landing.startMs)} → ${formatUtc(landing.endMs)} · ` +
      `${landingSeriesCount(landing)} series · ` +
      // The three cases — a landing pinned to one push, a window, a union — are
      // worded in cluster.ts so that the app's Landing block says them the same
      // way.
      landingWindowLabel(landing),
  );
  out.push(
    ...indent(
      table(
        ['SERIES', 'WHEN', 'BETWEEN', 'CHANGE', 'VERDICT', 'SOURCE'],
        landing.events.map((event) => [
          truncate(event.label, 40),
          formatUtc(event.atMs),
          event.prevRevision
            ? `${event.prevRevision.slice(0, 12)}..${event.revision.slice(0, 12)}`
            : event.revision.slice(0, 12),
          event.relativeChange === null ? NONE : formatSignedPercent(event.relativeChange),
          event.isRegression ? 'regression' : 'improvement',
          event.alertSummaryId
            ? `${event.source}, alert #${event.alertSummaryId}${event.bugNumber ? ` bug ${event.bugNumber}` : ''}`
            : event.source,
        ]),
        ['left', 'left', 'left', 'right', 'left', 'left'],
      ),
      '  ',
    ),
  );
  out.push('');
  return out;
}

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

export function renderCompare(report: CompareReport): string[] {
  const out: string[] = [];
  out.push(
    `comparison: ${report.headline}` +
      // The noun agrees with the second number, which is the one it sits beside:
      // "24 and 1 pushes" was reachable before and is common now that a side falling
      // short of `--pool` is reported rather than silent.
      (report.pool
        ? ` · pooled over ${report.pool.basePushes} and ${report.pool.nextPushes} ` +
          `${report.pool.nextPushes === 1 ? 'push' : 'pushes'}`
        : ''),
  );
  if (report.swapped) {
    out.push('(the sides were put in time order, so the baseline is not the one given first)');
  }
  // Directly under the header, before the numbers it explains: everything below is
  // computed over the pushes that were reached, so the reader has to know that is
  // not what they asked for before reading any of it.
  if (report.poolShortfall) {
    const { requested, baseGot, nextGot } = report.poolShortfall;
    out.push(
      `! --pool ${requested} reached ${baseGot} ${baseGot === 1 ? 'push' : 'pushes'} for ` +
        `${report.base.label} and ${nextGot} for ${report.next.label}`,
    );
    // Only the counts and the labels go on the line above; the explanation stays
    // label-free. A `series` comparison's labels are distinguishing series names,
    // which are long and variable, and interpolating one into a hand-wrapped
    // paragraph makes the wrap ragged at exactly the width it was set for.
    out.push(
      '  Pooling reaches outward from the push named — the earlier side back, the later side',
    );
    out.push(
      `  forward — so a push within ${requested} of that end of the range has nothing to reach,`,
    );
    out.push(
      '  and @first / @last have nothing at all. Name pushes further in, widen the range,',
    );
    out.push('  or ask `series --drift` for the two ends of a range.');
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
      '  revision to compare them on one build, or use `perfherder-cli series` to compare their',
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
    out.push(
      report.testBasis === 'push means'
        ? 'Mann-Whitney U (two-sided, over the pushes\' means — see below)'
        : 'Mann-Whitney U (two-sided, over the replicate pools above)',
    );
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
    if (report.pool) {
      // Reconciling two figures for one event, rather than leaving the reader
      // to notice they differ: this is the number `step` and `changes` print for
      // the same windows, and the medians above are not it.
      out.push(
        `  push-mean level ${formatValue(report.pool.baseLevel)} → ` +
          `${formatValue(report.pool.nextLevel)}${unit}` +
          (report.pool.levelFraction === null
            ? ''
            : ` (${formatSignedPercent(report.pool.levelFraction)})`) +
          ' — one value per push, equally weighted,',
        '  which is what `step` and `changes` report. The medians above are over the pooled',
        '  replicates, so they weight a push by how many times it ran.',
      );
    }
    if (report.testBasis === 'push means') {
      // The one number here that is not the one the app's card would print, so
      // it says why in the output and not only in the source.
      out.push(
        '  Over one value per push, not over the pooled replicates: replicates of a run are',
        '  repeated measurements of one number, and every run of a push shares its binary and',
        '  its moment, so a rank test over hundreds of them reports a p-value it has not earned',
        '  (src/lib/graphs/changes.ts makes the argument at length). The pooled cloud is what the',
        '  distributions and the modes below describe, which is what pooling is for.',
      );
    }
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
  if (side.pushCount > 1) {
    // The revision above is still the push that was named — the links and the
    // pushlog are about that build — so the window it stands for has to be
    // spelled out or the two lines contradict each other.
    out.push(
      `  pooled over ${side.pushCount} pushes, ${formatUtc(side.firstPushMs)} → ` +
        `${formatUtc(side.lastPushMs)}`,
    );
  }
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
      '(the base push is excluded, as hg\'s own pushlog excludes it)' +
      // The label counts the range. A filtered list under it would read as a
      // range that only ever held these rows.
      (report.filtered !== null
        ? `, ${report.commits.length} matching --commit-grep`
        : ''),
  );
  out.push('');
  if (report.commits.length === 0) {
    out.push(
      report.filtered
        ? `No commits match --commit-grep; ${report.filtered} in the range did not.`
        : 'Nothing landed between these two revisions.',
    );
    return out;
  }
  out.push(...renderCommitTable(report.commits));
  out.push('');
  if (report.caveat) out.push(`! ${report.caveat}`);
  if (report.url) out.push(report.url);
  return out;
}

// Headers name the fields of `CommitSummary`, not synonyms for them. `BUG` and
// `SUMMARY` cost a session a column of `undefined`: it read the headers, reached
// for `commit.bug` and `commit.summary` in `--json`, and got neither — the same
// trap as the `APP` header for `application`, and the same fix.
function renderCommitTable(commits: readonly { revision: string; author: string; title: string; bugs: number[]; pushTimestamp: number }[]): string[] {
  return table(
    ['WHEN', 'REVISION', 'BUGS', 'AUTHOR', 'TITLE'],
    commits.map((c) => [
      formatUtcDate(c.pushTimestamp * 1000),
      c.revision.slice(0, 12),
      // Every bug, not the first of them: a commit citing two is not a commit
      // citing one, and dropping the rest here is a truncation nothing declares.
      c.bugs.length > 0 ? c.bugs.join(',') : NONE,
      truncate(c.author, 22),
      truncate(c.title, 78),
    ]),
    ['left', 'left', 'right', 'left', 'left'],
  );
}

