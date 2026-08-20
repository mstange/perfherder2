import { describe, expect, it } from 'vitest';
import type { SeriesAlert } from '../lib/graphs/alerts';
import type { RawDatum, RawSummary } from '../lib/graphs/graphApi';
import {
  buildSeriesData,
  DEFAULT_ALERT_THRESHOLD,
  EMPTY_SERIES_DATA,
  metaFromSummary,
  placeholderMeta,
} from '../lib/graphs/graphData';
import type { PushlogRange } from '../lib/graphs/pushlog';
import type { Series } from '../lib/picker/series';
import { EMPTY_FILTER } from '../lib/picker/filter';
import {
  attachCommits,
  buildChangesReport,
  buildCommitsReport,
  buildCompareReport,
  buildLevelComparison,
  buildLocateReport,
  buildMachinesReport,
  buildSearchReport,
  buildStepReport,
  commitMatches,
  commitsHeading,
  graphUrl,
  poolPushes,
  type ChangeEntry,
  type LoadedSeries,
} from './reports';

// ---------------------------------------------------------------------------
// Fixtures
//
// Built by running synthetic API payloads through the app's own projections
// rather than by hand-writing the domain objects, so a change to `toSeries` or
// `buildSeriesData` shows up here instead of being papered over.
// ---------------------------------------------------------------------------

const BASE_TIME = Date.UTC(2026, 0, 1);

type SummaryOptions = Partial<
  Pick<
    RawSummary,
    'signature_id' | 'suite' | 'test' | 'application' | 'platform' | 'measurement_unit' | 'lower_is_better' | 'name'
  >
>;

// One entry per push, each holding that push's replicate values. `machines`
// names the worker each push ran on, cycling if it is shorter than the push
// list; without it every run is unattributed, the way an expired job arrives.
function summaryOf(
  pushes: readonly (readonly number[])[],
  options: SummaryOptions = {},
  machines: readonly string[] = [],
): RawSummary {
  const data: RawDatum[] = [];
  pushes.forEach((values, i) => {
    const timestamp = new Date(BASE_TIME + i * 3_600_000).toISOString().slice(0, 19);
    for (const value of values) {
      data.push({
        job_id: 500 + i,
        id: 1 + i,
        value,
        push_timestamp: timestamp,
        push_id: 1000 + i,
        revision: `rev${String(i).padStart(4, '0')}${'a'.repeat(34)}`,
        submit_time: null,
        machine_name: machines.length > 0 ? machines[i % machines.length] : null,
      });
    }
  });
  const suite = options.suite ?? 'bench';
  const test = options.test ?? 'metric';
  return {
    signature_id: options.signature_id ?? 900,
    framework_id: 13,
    signature_hash: 'hash',
    platform: options.platform ?? 'linux2404-64-shippable',
    test,
    suite,
    lower_is_better: options.lower_is_better ?? true,
    has_subtests: false,
    measurement_unit: options.measurement_unit ?? 'ms',
    application: options.application ?? 'firefox',
    repository_name: 'autoland',
    repository_id: 77,
    name: options.name ?? `${suite} ${test} opt`,
    parent_signature: null,
    should_alert: true,
    alert_change_type: null,
    alert_threshold: null,
    data,
  };
}

function loadedOf(summary: RawSummary): LoadedSeries {
  return {
    ref: {
      repository: summary.repository_name,
      signatureId: summary.signature_id,
      frameworkId: summary.framework_id,
    },
    meta: metaFromSummary(summary),
    data: buildSeriesData(summary),
    found: true,
    error: null,
  };
}

// Deterministic, because a test that counts detected steps must not flake.
function noisy(level: number, count: number, amplitude: number, seed = 7): number[] {
  let state = seed;
  return Array.from({ length: count }, () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return level + ((state / 0x7fffffff) * 2 - 1) * amplitude;
  });
}

const SPAN = { start: BASE_TIME, end: BASE_TIME + 100 * 3_600_000 };

function row(overrides: Partial<Series>): Series {
  const base: Series = {
    id: 1,
    repository: 'autoland',
    framework: 'browsertime',
    frameworkId: 13,
    platform: 'linux2404-64-shippable',
    suite: 'bench',
    test: '',
    application: 'firefox',
    options: ['opt'],
    extraOptions: [],
    measurementUnit: 'ms',
    hasSubtests: false,
    isSubtest: false,
    parentSignature: null,
    signatureHash: 'hash',
    key: 'autoland|1',
    parentKey: null,
    searchText: 'bench firefox linux2404-64-shippable browsertime autoland opt',
  };
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    key: `${merged.repository}|${merged.id}`,
    // Composed the way `toSeries` composes it unless a test states its own.
    // A fixture whose haystack doesn't contain its own test name would let a
    // free-text search pass here and fail against real rows.
    searchText:
      overrides.searchText ??
      [
        merged.suite,
        merged.test,
        merged.application,
        merged.platform,
        merged.framework,
        merged.repository,
        ...merged.options,
      ]
        .join(' ')
        .toLowerCase(),
  };
}

// ---------------------------------------------------------------------------

describe('buildSearchReport', () => {
  const rows = [
    row({ id: 1, suite: 'speedometer3', searchText: 'speedometer3 fenix android' , application: 'fenix' }),
    row({ id: 2, suite: 'speedometer3', searchText: 'speedometer3 chrome-m android', application: 'chrome-m' }),
    row({ id: 3, suite: 'nytimes', searchText: 'nytimes firefox linux' }),
  ];
  const input = {
    rows,
    fetched: new Map([['autoland', 3]]),
    repos: ['autoland'],
    intervalSeconds: 1209600,
    includeSubtests: false,
    sort: null,
    limit: 10,
  };

  it('counts what matched and what it is showing separately', () => {
    // A truncated answer must not be shaped like a complete one.
    const report = buildSearchReport({ ...input, filter: EMPTY_FILTER, limit: 2 });
    expect(report.matched).toBe(3);
    expect(report.rows).toHaveLength(2);
    expect(report.fetched).toEqual({ autoland: 3 });
  });

  it('applies the picker\'s filter, chips and free text alike', () => {
    const byText = buildSearchReport({
      ...input,
      filter: { chips: [], text: 'speedometer3' },
    });
    expect(byText.matched).toBe(2);

    const byChip = buildSearchReport({
      ...input,
      filter: { chips: [{ field: 'application', value: 'chrome-m' }], text: '' },
    });
    expect(byChip.rows.map((r) => r.signatureId)).toEqual([2]);
  });

  it('emits a ref other commands can be handed straight back', () => {
    const report = buildSearchReport({ ...input, filter: EMPTY_FILTER, limit: 1 });
    expect(report.rows[0].ref).toBe('autoland,1,13');
  });

  it('reports a missing run count as null rather than zero', () => {
    // Zero means "this never runs", which is a finding the column exists to
    // give; null means the fetch failed or was not asked for.
    const report = buildSearchReport({ ...input, filter: EMPTY_FILTER, limit: 1 });
    expect(report.rows[0].runs).toBeNull();

    const withActivity = buildSearchReport({
      ...input,
      filter: EMPTY_FILTER,
      limit: 1,
      activity: new Map([['autoland|1', { counts: [], total: 0, lastRunMs: null }]]),
    });
    expect(withActivity.rows[0].runs).toBe(0);
  });
});

describe('buildLevelComparison', () => {
  const firefox = loadedOf(
    summaryOf(noisy(8.2, 40, 0.1).map((v) => [v]), {
      signature_id: 1,
      application: 'fenix',
      measurement_unit: 'score',
      lower_is_better: false,
    }),
  );
  const chrome = loadedOf(
    summaryOf(noisy(10.1, 40, 0.1, 99).map((v) => [v]), {
      signature_id: 2,
      application: 'chrome-m',
      measurement_unit: 'score',
      lower_is_better: false,
    }),
  );

  it('reports the ratio and names the better side', () => {
    const cmp = buildLevelComparison(firefox, chrome)!;
    expect(cmp.baseLabel).toBe('fenix');
    expect(cmp.nextLabel).toBe('chrome-m');
    expect(cmp.ratio).toBeGreaterThan(1.2);
    expect(cmp.test?.significant).toBe(true);
    // Higher is better for a score, so the higher median wins — never the sign
    // of the delta on its own.
    expect(cmp.betterLabel).toBe('chrome-m');
  });

  it('leaves the better side unnamed when the difference is not significant', () => {
    const twin = loadedOf(
      summaryOf(noisy(8.2, 40, 0.1).map((v) => [v]), {
        signature_id: 3,
        application: 'fenix-twin',
        measurement_unit: 'score',
        lower_is_better: false,
      }),
    );
    expect(buildLevelComparison(firefox, twin)!.betterLabel).toBeNull();
  });

  it('warns and refuses a verdict when the units differ', () => {
    const bytes = loadedOf(
      summaryOf(noisy(100, 40, 1).map((v) => [v]), {
        signature_id: 4,
        application: 'fenix',
        measurement_unit: 'bytes',
      }),
    );
    const cmp = buildLevelComparison(firefox, bytes)!;
    expect(cmp.warning).toMatch(/different units/);
    expect(cmp.unit).toBe('');
    expect(cmp.betterLabel).toBeNull();
  });

  it('is null when a side has no data in the range', () => {
    expect(buildLevelComparison(firefox, loadedOf(summaryOf([])))).toBeNull();
  });
});

describe('buildChangesReport', () => {
  // A clean 10% step at push 30 of 60, which the detector finds comfortably.
  const stepped = loadedOf(
    summaryOf([...noisy(100, 30, 0.5), ...noisy(110, 30, 0.5, 21)].map((v) => [v])),
  );

  function alertAt(index: number, isRegression = true): SeriesAlert {
    const push = stepped.data.pushes[index];
    const previous = stepped.data.pushes[index - 1];
    return {
      summaryId: 500 + index,
      alertId: 900 + index,
      pushId: push.pushId,
      prevPushId: previous.pushId,
      x: push.x,
      revision: push.revision,
      prevRevision: previous.revision,
      isRegression,
      amountPct: 10,
      prevValue: 100,
      newValue: 110,
      tValue: 9,
      alertStatus: 4,
      summaryStatus: 5,
      bugNumber: 12345,
      reassignment: null,
    };
  }

  const build = (alerts: SeriesAlert[] | null) =>
    buildChangesReport({
      loaded: stepped,
      span: SPAN,
      threshold: DEFAULT_ALERT_THRESHOLD,
      alerts,
      base: 'http://localhost:5173/',
      repoLink: null,
    });

  it('finds the step on its own', () => {
    const report = build([]);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].source).toBe('detected');
    expect(report.entries[0].isRegression).toBe(true);
    expect(report.entries[0].detected?.relativeChange).toBeGreaterThan(0.08);
  });

  it('merges an alert that lands on the same event into one row', () => {
    const report = build([alertAt(31)]);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].source).toBe('both');
    // Reported, not hidden: the two analyses genuinely place the step one push
    // apart and the reader should know by how much.
    expect(report.entries[0].pushOffset).toBe(-1);
    expect(report.entries[0].alert?.bugNumber).toBe(12345);
  });

  it('keeps an alert far from any detected step as its own row', () => {
    const report = build([alertAt(10)]);
    expect(report.entries).toHaveLength(2);
    expect(report.entries.map((e) => e.source)).toEqual(['alert', 'detected']);
  });

  it('does not merge findings that disagree about direction', () => {
    const report = build([alertAt(31, false)]);
    expect(report.entries).toHaveLength(2);
  });

  it('tells "no alerts" from "could not ask"', () => {
    expect(build([]).alertsLoaded).toBe(true);
    expect(build(null).alertsLoaded).toBe(false);
  });

  it('links each change to the app with both ends of the comparison pinned', () => {
    const url = build([]).entries[0].url!;
    expect(url).toContain('series=autoland,900,13');
    // `sel` is the push after the step and `cmp` the one before it — the pair a
    // click on the bar sets up in the app.
    expect(url).toMatch(/sel=autoland,900,\d+,-1/);
    expect(url).toMatch(/cmp=autoland,900,\d+,-1/);
  });

  it('reports nothing, and says why, for a series too short to test', () => {
    const short = loadedOf(summaryOf(noisy(100, 5, 1).map((v) => [v])));
    const report = buildChangesReport({
      loaded: short,
      span: SPAN,
      threshold: DEFAULT_ALERT_THRESHOLD,
      alerts: [],
      base: 'http://localhost:5173/',
      repoLink: null,
    });
    expect(report.entries).toEqual([]);
    expect(report.pushCount).toBe(5);
  });
});

describe('buildLocateReport', () => {
  // A clean step between index 23 and 24, one run a push.
  const stepped = loadedOf(
    summaryOf([...noisy(100, 24, 1), ...noisy(110, 24, 1, 31)].map((v) => [v])),
  );
  const pushes = stepped.data.pushes;

  const build = (alerts: SeriesAlert[] | null, top = 5) =>
    buildLocateReport({
      loaded: stepped,
      threshold: DEFAULT_ALERT_THRESHOLD,
      alerts,
      atMs: pushes[24].x,
      revision: pushes[24].revision,
      revisionRepository: 'autoland',
      windowPushes: 24,
      top,
      span: SPAN,
      base: 'http://localhost:5173/',
    });

  it('ranks by the detector\'s own score, best first', () => {
    const report = build([]);
    expect(report.candidates[0].rank).toBe(1);
    expect(report.candidates[0].index).toBe(24);
    for (let i = 1; i < report.candidates.length; i++) {
      expect(report.candidates[i].score).toBeLessThanOrEqual(report.candidates[i - 1].score);
    }
  });

  it('says how many candidates it is not showing', () => {
    // A truncated answer must not be shaped like a complete one.
    const report = build([], 3);
    expect(report.candidates).toHaveLength(3);
    expect(report.totalCandidates).toBeGreaterThan(3);
  });

  it('reports the spread of the shown candidates, which is the missing interval', () => {
    const report = build([]);
    expect(report.spanPushes).toBeGreaterThan(0);
    expect(report.spanMs).toBeGreaterThan(0);
  });

  it('marks the push perfherder alerted on, and tells that from not asking', () => {
    const alerted = build([{ pushId: pushes[26].pushId } as SeriesAlert], 48);
    const row = alerted.candidates.find((c) => c.pushId === pushes[26].pushId)!;
    expect(row.alert).toBe(true);
    expect(alerted.candidates.filter((c) => c.alert === true)).toHaveLength(1);
    expect(alerted.alertsLoaded).toBe(true);

    // Null everywhere, not false: "we could not ask" is not "there is no alert
    // here".
    const unasked = build(null);
    expect(unasked.alertsLoaded).toBe(false);
    expect(unasked.candidates.every((c) => c.alert === null)).toBe(true);
  });

  it('says whether each candidate is one the detector could have marked', () => {
    const report = build([]);
    expect(report.candidates[0].clearsAlpha).toBe(true);
    expect(report.candidates[0].clearsFloor).toBe(true);
    // A quarter of perfherder's global 2% default.
    expect(report.floor).toEqual({ kind: 'percentage', value: 0.5 });
  });
});

describe('buildCompareReport', () => {
  const loaded = loadedOf(
    summaryOf([
      [100, 101, 102, 99, 100, 101],
      [140, 141, 139, 142, 140, 141],
    ]),
  );
  const [before, after] = loaded.data.pushes;

  it('orders the sides by time, whichever way round they were given', () => {
    const forwards = buildCompareReport({
      base: { loaded, push: before, pooled: null },
      next: { loaded, push: after, pooled: null },
      span: SPAN,
      appBase: 'http://localhost:5173/',
      repoLink: null,
    })!;
    const backwards = buildCompareReport({
      base: { loaded, push: after, pooled: null },
      next: { loaded, push: before, pooled: null },
      span: SPAN,
      appBase: 'http://localhost:5173/',
      repoLink: null,
    })!;
    expect(forwards.base.pushId).toBe(before.pushId);
    expect(backwards.base.pushId).toBe(before.pushId);
    expect(forwards.kind).toBe('push');
  });

  it('pools each push\'s whole replicate cloud and marks no single value', () => {
    const report = buildCompareReport({
      base: { loaded, push: before, pooled: null },
      next: { loaded, push: after, pooled: null },
      span: SPAN,
      appBase: 'http://localhost:5173/',
      repoLink: null,
    })!;
    expect(report.base.valueCount).toBe(6);
    expect(report.next.valueCount).toBe(6);
    expect(report.direction).toBe('regression');
    expect(report.medianDeltaFraction).toBeGreaterThan(0.35);
    expect(report.modes?.verdict).toBe('shifted');
  });

  it('pools a window of pushes and tests it over their means', () => {
    // Ten pushes at one level, ten at another, four replicates each. Pooled,
    // each side has 20 values to estimate a density from instead of 4 — which
    // is the point, since a mode count off one push's cloud flipped between two
    // legitimate choices of pair on a real series.
    const stepped = loadedOf(
      summaryOf([
        ...noisy(100, 10, 1).map((v) => [v, v + 1, v - 1, v + 0.5]),
        ...noisy(140, 10, 1, 31).map((v) => [v, v + 1, v - 1, v + 0.5]),
      ]),
    );
    const pushes = stepped.data.pushes;
    const basePooled = poolPushes(pushes, pushes[9], 5, 'backward');
    const nextPooled = poolPushes(pushes, pushes[10], 5, 'forward');
    // The windows meet at the step rather than straddling it.
    expect(basePooled.pooled.map((p) => p.pushId)).toEqual(
      pushes.slice(5, 10).map((p) => p.pushId),
    );
    expect(nextPooled.pooled.map((p) => p.pushId)).toEqual(
      pushes.slice(10, 15).map((p) => p.pushId),
    );

    const report = buildCompareReport({
      base: { loaded: stepped, push: basePooled.push, pooled: basePooled.pooled },
      next: { loaded: stepped, push: nextPooled.push, pooled: nextPooled.pooled },
      span: SPAN,
      appBase: 'http://localhost:5173/',
      repoLink: null,
    })!;

    expect(report.pool).toMatchObject({ basePushes: 5, nextPushes: 5 });
    // The push-weighted level, which is the figure `step` prints for the same
    // window — reported so the two commands can be reconciled rather than left
    // to disagree by a statistic nobody named.
    expect(report.pool!.baseLevel).toBeCloseTo(
      pushes.slice(5, 10).reduce((a, p) => a + p.mean, 0) / 5,
      6,
    );
    expect(report.base.valueCount).toBe(20);
    expect(report.base.pushCount).toBe(5);
    // The test is over five values a side, not twenty: pooled replicates would
    // report an n the data has not earned.
    expect(report.testBasis).toBe('push means');
    expect(report.test!.nBase).toBe(5);
    expect(report.test!.nNext).toBe(5);
    expect(report.direction).toBe('regression');
    // The named push still names the comparison, so the links keep pointing at
    // the build that was asked about.
    expect(report.base.pushId).toBe(pushes[9].pushId);
    expect(report.base.revision).toBe(pushes[9].revision);
  });

  it('says when a pool could not reach what was asked for', () => {
    // The case a live run hit: `--pool 24` against `@first` and `@last`. Pooling
    // reaches outward, the range edges have nothing outside them, so both sides get
    // one push — and the silent version of this looked exactly like a pool that
    // worked, right down to "too few values for a density estimate".
    const stepped = loadedOf(
      summaryOf([
        ...noisy(100, 10, 1).map((v) => [v, v + 1]),
        ...noisy(140, 10, 1, 31).map((v) => [v, v + 1]),
      ]),
    );
    const pushes = stepped.data.pushes;
    const first = poolPushes(pushes, pushes[0], 24, 'backward');
    const last = poolPushes(pushes, pushes[pushes.length - 1], 24, 'forward');
    expect(first.pooled).toHaveLength(1);
    expect(last.pooled).toHaveLength(1);

    const report = buildCompareReport({
      base: { loaded: stepped, push: first.push, pooled: first.pooled },
      next: { loaded: stepped, push: last.push, pooled: last.pooled },
      span: SPAN,
      appBase: 'http://localhost:5173/',
      repoLink: null,
      poolRequested: 24,
    })!;
    expect(report.poolShortfall).toEqual({ requested: 24, baseGot: 1, nextGot: 1 });
    // And the rest of the report is unchanged by saying so: one push a side is not
    // pooling, so the test is still over replicates.
    expect(report.pool).toBeNull();
    expect(report.testBasis).toBe('replicates');
  });

  it('reports both counts when only one side fell short', () => {
    // "5 and 1" is the diagnosis — one anchor was too near an edge. "1" alone would
    // not say whether the range was too short instead.
    const stepped = loadedOf(
      summaryOf([
        ...noisy(100, 10, 1).map((v) => [v, v + 1]),
        ...noisy(140, 10, 1, 31).map((v) => [v, v + 1]),
      ]),
    );
    const pushes = stepped.data.pushes;
    const base = poolPushes(pushes, pushes[9], 5, 'backward');
    const next = poolPushes(pushes, pushes[pushes.length - 1], 5, 'forward');
    const report = buildCompareReport({
      base: { loaded: stepped, push: base.push, pooled: base.pooled },
      next: { loaded: stepped, push: next.push, pooled: next.pooled },
      span: SPAN,
      appBase: 'http://localhost:5173/',
      repoLink: null,
      poolRequested: 5,
    })!;
    expect(report.poolShortfall).toEqual({ requested: 5, baseGot: 5, nextGot: 1 });
    // Still a pooled comparison, because one side did widen.
    expect(report.pool).toMatchObject({ basePushes: 5, nextPushes: 1 });
    expect(report.testBasis).toBe('push means');
  });

  it('says nothing when every side got what it asked for', () => {
    const stepped = loadedOf(
      summaryOf([
        ...noisy(100, 10, 1).map((v) => [v, v + 1]),
        ...noisy(140, 10, 1, 31).map((v) => [v, v + 1]),
      ]),
    );
    const pushes = stepped.data.pushes;
    const base = poolPushes(pushes, pushes[9], 5, 'backward');
    const next = poolPushes(pushes, pushes[10], 5, 'forward');
    const report = buildCompareReport({
      base: { loaded: stepped, push: base.push, pooled: base.pooled },
      next: { loaded: stepped, push: next.push, pooled: next.pooled },
      span: SPAN,
      appBase: 'http://localhost:5173/',
      repoLink: null,
      poolRequested: 5,
    })!;
    expect(report.poolShortfall).toBeNull();
  });

  it('cannot fall short when --pool was never asked for', () => {
    // Without the flag every side is one push by definition, which is not a
    // shortfall and must not be reported as one.
    const report = buildCompareReport({
      base: { loaded, push: before, pooled: null },
      next: { loaded, push: after, pooled: null },
      span: SPAN,
      appBase: 'http://localhost:5173/',
      repoLink: null,
    })!;
    expect(report.poolShortfall).toBeNull();
  });

  it('leaves an unpooled comparison exactly as it was', () => {
    const report = buildCompareReport({
      base: { loaded, push: before, pooled: [before] },
      next: { loaded, push: after, pooled: [after] },
      span: SPAN,
      appBase: 'http://localhost:5173/',
      repoLink: null,
    })!;
    expect(report.pool).toBeNull();
    expect(report.testBasis).toBe('replicates');
    expect(report.test!.nBase).toBe(6);
  });

  it('is null when both arguments name the same push', () => {
    expect(
      buildCompareReport({
        base: { loaded, push: before, pooled: null },
        next: { loaded, push: before, pooled: null },
        span: SPAN,
        appBase: 'http://localhost:5173/',
        repoLink: null,
      }),
    ).toBeNull();
  });
});

describe('buildCommitsReport', () => {
  const range: PushlogRange = {
    commits: [
      {
        revision: 'abc123def456789',
        author: 'Someone',
        summary: 'Bug 2051123 - Do a thing r=reviewer',
        body: '',
        bugs: [2051123],
        pushId: 1,
        pushTimestamp: BASE_TIME / 1000,
      },
    ],
    pushCount: 1,
    hiddenRevisions: 144,
    truncated: false,
  };

  it('strips the bug prefix the bug column already carries', () => {
    const report = buildCommitsReport('autoland', 'from', 'to', range, null);
    expect(report.commits[0].title).toBe('Do a thing r=reviewer');
    expect(report.commits[0].bugs).toEqual([2051123]);
  });

  it('says when a merge was abbreviated rather than presenting a fifth of it as all', () => {
    const report = buildCommitsReport('autoland', 'from', 'to', range, null);
    expect(report.label).toBe('1 of 145 commits');
    expect(report.caveat).toMatch(/at most 20 per push/);
  });
});

// A change row is only ever built by `buildChangesReport`; these tests are about
// what `attachCommits` folds into one, so the row itself is a stub with the
// fields that function reads and copies.
function changeEntryStub(): ChangeEntry {
  return {
    atMs: BASE_TIME,
    pushId: 2,
    revision: 'after0000000',
    prevPushId: 1,
    prevRevision: 'before000000',
    prevAtMs: BASE_TIME - 3600_000,
    source: 'detected',
    isRegression: true,
    detected: null,
    alert: null,
    pushOffset: null,
    url: null,
    pushlogUrl: null,
    commits: null,
    commitsLabel: null,
    commitsOmitted: 0,
    commitsFiltered: null,
    commitsCaveat: null,
  };
}

function commit(summary: string, author: string, bugs: number[], id: number) {
  return {
    revision: `rev${id}`,
    author,
    summary,
    body: '',
    bugs,
    pushId: 1,
    pushTimestamp: BASE_TIME / 1000,
  };
}

describe('attachCommits', () => {
  const range: PushlogRange = {
    commits: [
      commit('Bug 1 - Quota manager: reconcile the L1 cache r=x', 'Jari', [1], 1),
      commit('Bug 2 - Enlarge the crossword widget r=y', 'Reem', [2], 2),
      commit('Bug 3 - IDBCursor: use row values comparison r=z', 'Arnaud', [3], 3),
      commit('Bug 4 - Update the WPT manifest r=w', 'bot', [4], 4),
    ],
    pushCount: 2,
    hiddenRevisions: 0,
    truncated: false,
  };

  it('counts what --commit-limit held back, rather than showing a short list under a full count', () => {
    const entry = attachCommits(changeEntryStub(), range, { limit: 2, grep: null });
    expect(entry.commits).toHaveLength(2);
    expect(entry.commitsOmitted).toBe(2);
    // The label still describes the range, which is why the omitted count has to
    // exist: on its own it would caption two rows with "4 commits".
    expect(entry.commitsLabel).toBe('4 commits');
    expect(commitsHeading(entry)).toBe('4 commits, showing 2 (--commit-limit)');
  });

  it('leaves the omitted count at zero when the whole range fits', () => {
    const entry = attachCommits(changeEntryStub(), range, { limit: 15, grep: null });
    expect(entry.commitsOmitted).toBe(0);
    expect(entry.commitsFiltered).toBeNull();
    expect(commitsHeading(entry)).toBe('4 commits');
  });

  it('filters on title, and counts the commits the pattern excluded', () => {
    const entry = attachCommits(changeEntryStub(), range, { limit: 15, grep: /quota|idbcursor/i });
    expect(entry.commits?.map((c) => c.author)).toEqual(['Jari', 'Arnaud']);
    expect(entry.commitsFiltered).toBe(2);
    expect(commitsHeading(entry)).toBe('4 commits, 2 matching --commit-grep');
  });

  it('reports both narrowings when both applied', () => {
    const entry = attachCommits(changeEntryStub(), range, { limit: 1, grep: /bug/i });
    expect(entry.commits).toHaveLength(1);
    expect(entry.commitsFiltered).toBe(0);
    expect(entry.commitsOmitted).toBe(3);
    expect(commitsHeading(entry)).toBe(
      '4 commits, 4 matching --commit-grep, showing 1 (--commit-limit)',
    );
  });

  it('distinguishes a filter that excluded everything from a range that was empty', () => {
    const filtered = attachCommits(changeEntryStub(), range, { limit: 15, grep: /nothing/i });
    expect(filtered.commits).toEqual([]);
    expect(filtered.commitsFiltered).toBe(4);

    const empty = attachCommits(
      changeEntryStub(),
      { commits: [], pushCount: 0, hiddenRevisions: 0, truncated: false },
      { limit: 15, grep: null },
    );
    expect(empty.commits).toEqual([]);
    expect(empty.commitsFiltered).toBeNull();
  });
});

describe('commitMatches', () => {
  const one = {
    revision: 'r',
    author: 'Jari Jalkanen',
    title: 'Reconcile L1 cache rows with disk during repository init',
    bugs: [1998600, 2052152],
    pushId: 1,
    pushTimestamp: 0,
  };

  it('matches a subsystem in the title', () => {
    expect(commitMatches(one, /l1 cache/i)).toBe(true);
  });

  it('matches an author, because "who landed this" is the same question', () => {
    expect(commitMatches(one, /jalkanen/i)).toBe(true);
  });

  it('matches any of the bugs cited, not just the first', () => {
    expect(commitMatches(one, /2052152/)).toBe(true);
  });

  it('does not match a word in none of the three', () => {
    expect(commitMatches(one, /webgl/i)).toBe(false);
  });
});

describe('graphUrl', () => {
  it('produces a link the app parses back to the same view', () => {
    const url = graphUrl(
      'http://localhost:5173',
      [{ repository: 'autoland', signatureId: 5350953, frameworkId: 13 }],
      { start: 1, end: 2 },
    );
    expect(url).toBe('http://localhost:5173/?series=autoland,5350953,13&range=1,2');
  });
});

describe('a merged row takes its pair from the analysis that placed it', () => {
  // The row's index is the detector's, so its "before" must be the detector's
  // too. Taking the alert's `prev_push_id` instead spans a range that is
  // neither analysis's — and `--commits` would then list the wrong candidates.
  const stepped = loadedOf(
    summaryOf([...noisy(100, 30, 0.5), ...noisy(110, 30, 0.5, 21)].map((v) => [v])),
  );

  it('uses the push before the detected index, not the alert\'s previous push', () => {
    const alertPush = stepped.data.pushes[32];
    // An alert whose own "before" is eight pushes back, well outside the pair
    // the detector found.
    const report = buildChangesReport({
      loaded: stepped,
      span: SPAN,
      threshold: DEFAULT_ALERT_THRESHOLD,
      alerts: [
        {
          summaryId: 1,
          alertId: 1,
          pushId: alertPush.pushId,
          prevPushId: stepped.data.pushes[24].pushId,
          x: alertPush.x,
          revision: alertPush.revision,
          prevRevision: stepped.data.pushes[24].revision,
          isRegression: true,
          amountPct: 10,
          prevValue: 100,
          newValue: 110,
          tValue: null,
          alertStatus: 4,
          summaryStatus: 5,
          bugNumber: null,
          reassignment: null,
        },
      ],
      base: 'http://localhost:5173/',
      repoLink: null,
    });

    expect(report.entries).toHaveLength(1);
    const entry = report.entries[0];
    expect(entry.source).toBe('both');
    expect(entry.prevPushId).toBe(stepped.data.pushes[29].pushId);
    expect(entry.pushId).toBe(stepped.data.pushes[30].pushId);
  });
});

describe('buildSearchReport with --parent', () => {
  const parentRow = row({ id: 100, suite: 'speedometer3', test: '' });
  const child = (id: number, test: string, parentId: number): Series =>
    row({ id, suite: 'speedometer3', test, parentSignature: 'hash', isSubtest: true, parentKey: `autoland|${parentId}` });
  const rows = [
    parentRow,
    child(101, 'Charts-chartjs/total', 100),
    child(102, 'TodoMVC-Vue/total', 100),
    // A second parent's children — same suite, same chips, different parent.
    // This is the case no filter term can separate.
    row({ id: 200, suite: 'speedometer3', test: '', options: ['opt', 'no-nova'] }),
    child(201, 'Charts-chartjs/total', 200),
  ];
  const input = {
    rows,
    fetched: new Map([['autoland', rows.length]]),
    filter: EMPTY_FILTER,
    repos: ['autoland'],
    intervalSeconds: 1209600,
    includeSubtests: true,
    sort: null,
    limit: 50,
  };

  it('returns one parent\'s children and not another\'s', () => {
    const report = buildSearchReport({
      ...input,
      parent: { repository: 'autoland', signatureId: 100 },
    });
    expect(report.rows.map((r) => r.signatureId)).toEqual([101, 102]);
    expect(report.parent).toBe('autoland,100');
    expect(report.parentFound).toBe(true);
  });

  it('excludes the parent row itself', () => {
    const report = buildSearchReport({
      ...input,
      parent: { repository: 'autoland', signatureId: 100 },
    });
    expect(report.rows.some((r) => r.signatureId === 100)).toBe(false);
  });

  it('still applies the filter on top', () => {
    const report = buildSearchReport({
      ...input,
      filter: { chips: [], text: 'todomvc' },
      parent: { repository: 'autoland', signatureId: 100 },
    });
    expect(report.rows.map((r) => r.signatureId)).toEqual([102]);
  });

  it('tells an unknown parent from a childless one', () => {
    // Two empty results that mean different things: a mistyped id, and a
    // signature that genuinely has no subtests.
    const unknown = buildSearchReport({
      ...input,
      parent: { repository: 'autoland', signatureId: 999 },
    });
    expect(unknown.rows).toEqual([]);
    expect(unknown.parentFound).toBe(false);

    const childless = buildSearchReport({
      ...input,
      parent: { repository: 'autoland', signatureId: 201 },
    });
    expect(childless.rows).toEqual([]);
    expect(childless.parentFound).toBe(true);
  });

  it('does not match a same-numbered signature in another repository', () => {
    const report = buildSearchReport({
      ...input,
      parent: { repository: 'mozilla-central', signatureId: 100 },
    });
    expect(report.rows).toEqual([]);
    expect(report.parentFound).toBe(false);
  });
});

describe('buildStepReport', () => {
  // 40 pushes an hour apart; the step lands between index 19 and 20.
  const SPLIT = BASE_TIME + 20 * 3_600_000;

  const stepped = (before: number, after: number, amplitude: number, id: number, platform: string) =>
    loadedOf(
      summaryOf(
        [...noisy(before, 20, amplitude), ...noisy(after, 20, amplitude, 31)].map((v) => [v]),
        { signature_id: id, platform },
      ),
    );

  const build = (
    loaded: LoadedSeries[],
    thresholds = loaded.map(() => DEFAULT_ALERT_THRESHOLD),
    windowPushes = 24,
  ) =>
    buildStepReport({
      loaded,
      thresholds,
      atMs: SPLIT,
      revision: null,
      revisionRepository: null,
      windowPushes,
      span: SPAN,
      base: 'http://localhost:5173/',
    });

  it('splits at the instant, with the push at it counted as after', () => {
    const report = build([stepped(100, 110, 0.5, 1, 'linux2404-64-shippable')]);
    const entry = report.entries[0];
    expect(entry.before.pushCount).toBe(20);
    expect(entry.after.pushCount).toBe(20);
    expect(entry.before.lastPushMs).toBeLessThan(SPLIT);
    expect(entry.after.firstPushMs).toBe(SPLIT);
  });

  it('clips the windows to --window pushes a side', () => {
    const entry = build([stepped(100, 110, 0.5, 1, 'linux2404-64-shippable')], undefined, 6)
      .entries[0];
    expect(entry.before.pushCount).toBe(6);
    expect(entry.after.pushCount).toBe(6);
  });

  it('measures a real step and calls it detectable', () => {
    const entry = build([stepped(100, 110, 0.5, 1, 'linux2404-64-shippable')]).entries[0];
    expect(entry.meanDelta).toBeGreaterThan(9);
    expect(entry.test!.pValue).toBeLessThan(0.001);
    expect(entry.clearsAlpha).toBe(true);
    expect(entry.clearsFloor).toBe(true);
    expect(entry.wouldDetect).toBe(true);
    // Lower is better by default, so a rise is a regression — never the sign
    // of the delta alone.
    expect(entry.direction).toBe('regression');
  });

  it('separates "under the floor" from "not significant"', () => {
    // The whole point of the command. A 0.2% move, measured very precisely, is
    // real and below the 0.5% the detector holds this signature to.
    const tiny = build([stepped(100, 100.2, 0.02, 1, 'linux2404-64-shippable')]).entries[0];
    expect(tiny.clearsAlpha).toBe(true);
    expect(tiny.clearsFloor).toBe(false);
    expect(tiny.wouldDetect).toBe(false);

    // A big move seen through too few, too noisy pushes: past the floor, but
    // the rank test cannot certify it.
    const noisyStep = build([stepped(100, 110, 0.5, 2, 'linux2404-64-shippable')], undefined, 3)
      .entries[0];
    expect(noisyStep.clearsFloor).toBe(true);
    expect(noisyStep.clearsAlpha).toBe(false);
    expect(noisyStep.wouldDetect).toBe(false);
  });

  it('reads the floor off the signature, not off a constant', () => {
    // An absolute threshold is compared in the metric's own units; a percentage
    // one against the relative change. Reading either as the other is off by
    // whatever the metric's magnitude happens to be.
    const absolute = build(
      [stepped(1_000_000, 1_002_000, 100, 1, 'linux2404-64-shippable')],
      [{ kind: 'absolute', value: 102_400 }],
    ).entries[0];
    // 2,000 units against a floor of a quarter of 102,400.
    expect(absolute.floor).toEqual({ kind: 'absolute', value: 25_600 });
    expect(absolute.clearsFloor).toBe(false);
    // The same move is 0.2% — also under a percentage floor, but for a
    // different reason and by a different arithmetic.
    expect(absolute.clearsAlpha).toBe(true);
  });

  it('labels rows by what distinguishes them and hoists the rest', () => {
    const report = build([
      stepped(100, 110, 0.5, 1, 'linux2404-64-shippable'),
      stepped(200, 220, 1, 2, 'windows11-64-24h2-shippable'),
    ]);
    expect(report.common).toContain('bench');
    expect(report.entries[0].label).toBe('linux2404-64-shippable');
    expect(report.entries[1].label).toBe('windows11-64-24h2-shippable');
  });

  it('carries a fetch failure onto the row instead of losing the run', () => {
    // A 502 on one of twenty-eight series used to take the other twenty-seven
    // with it. The failed row has to be tellable from an empty one: both have
    // no pushes, and only one of them is a finding.
    const failed: LoadedSeries = {
      ref: { repository: 'autoland', signatureId: 99, frameworkId: 13 },
      meta: placeholderMeta({ repository: 'autoland', signatureId: 99, frameworkId: 13 }),
      data: EMPTY_SERIES_DATA,
      found: false,
      error: 'HTTP 502 Bad Gateway — https://treeherder.mozilla.org/api/…',
    };
    const report = build([stepped(100, 110, 0.5, 1, 'linux2404-64-shippable'), failed]);
    expect(report.entries).toHaveLength(2);
    expect(report.entries[0].test).not.toBeNull();
    expect(report.entries[1].series.error).toContain('502');
    expect(report.entries[1].before.pushCount).toBe(0);
  });

  it('leaves a single series unlabelled — there is nothing to distinguish it from', () => {
    const report = build([stepped(100, 110, 0.5, 1, 'linux2404-64-shippable')]);
    expect(report.entries[0].label).toBe('');
    expect(report.common).toBe('');
  });

  it('reports an empty side rather than inventing one', () => {
    const entry = buildStepReport({
      loaded: [stepped(100, 110, 0.5, 1, 'linux2404-64-shippable')],
      thresholds: [DEFAULT_ALERT_THRESHOLD],
      // Before every push in the series.
      atMs: BASE_TIME - 3_600_000,
      revision: null,
      revisionRepository: null,
      windowPushes: 24,
      span: SPAN,
      base: 'http://localhost:5173/',
    }).entries[0];
    expect(entry.before.pushCount).toBe(0);
    expect(entry.test).toBeNull();
    expect(entry.meanDelta).toBeNull();
    expect(entry.wouldDetect).toBe(false);
  });
});

describe('buildMachinesReport', () => {
  // 60 pushes an hour apart, one run each, rotating over four workers — the
  // shape a real pool has, where nothing runs concurrently.
  const POOL = ['nuc-1', 'nuc-2', 'nuc-3', 'nuc-4'];
  const SPAN60 = { start: BASE_TIME, end: BASE_TIME + 60 * 3_600_000 };

  function pool(values: readonly number[], machines = POOL) {
    return loadedOf(summaryOf(values.map((v) => [v, v]), {}, machines));
  }

  it('pools the runs of every ref, since a worker runs them all', () => {
    const flat = noisy(100, 60, 1);
    const report = buildMachinesReport(
      [pool(flat), pool(flat)],
      SPAN60,
      'https://example/',
    );
    expect(report.machines.map((m) => m.name)).toEqual(POOL);
    // Two series of 60 pushes over four machines: 30 runs each, two values a run.
    expect(report.machines.map((m) => m.runs)).toEqual([30, 30, 30, 30]);
    expect(report.machines.map((m) => m.points)).toEqual([60, 60, 60, 60]);
    expect(report.attributedRuns).toBe(120);
    expect(report.series).toHaveLength(2);
  });

  it('shares out the runs against an even split', () => {
    // nuc-1 takes three quarters of a 60-push series, nuc-2 the rest.
    const machines = ['nuc-1', 'nuc-1', 'nuc-1', 'nuc-2'];
    const report = buildMachinesReport([pool(noisy(100, 60, 1), machines)], SPAN60, 'x');
    const [one, two] = report.machines;
    expect(one.runs).toBe(45);
    expect(two.runs).toBe(15);
    // Even would be 30 each.
    expect(one.shareOfRuns).toBeCloseTo(1.5, 5);
    expect(two.shareOfRuns).toBeCloseTo(0.5, 5);
  });

  it('finds the one machine that reads high', () => {
    const values = noisy(100, 60, 0.5).map((v, i) => (i % 4 === 2 ? v * 1.08 : v));
    const report = buildMachinesReport([pool(values)], SPAN60, 'x');
    const byName = new Map(report.machines.map((m) => [m.name, m.relativeLevel ?? 0]));
    expect(byName.get('nuc-3')).toBeGreaterThan(0.03);
    for (const name of ['nuc-1', 'nuc-2', 'nuc-4']) {
      expect(Math.abs(byName.get(name)!)).toBeLessThan(0.015);
    }
  });

  it('counts the expired runs and says where attribution starts', () => {
    // The first half has no machine, which is what a range reaching past
    // treeherder's job retention window looks like — and the date matters more
    // than the count, since it is what tells the reader to ask for less range.
    const summary = summaryOf(noisy(100, 40, 1).map((v) => [v]));
    for (const datum of summary.data) {
      const index = datum.push_id - 1000;
      if (index >= 20) datum.machine_name = index % 2 === 0 ? 'nuc-1' : 'nuc-2';
    }
    const report = buildMachinesReport(
      [loadedOf(summary)],
      { start: BASE_TIME, end: BASE_TIME + 40 * 3_600_000 },
      'x',
    );
    expect(report.unattributedRuns).toBe(20);
    expect(report.attributedRuns).toBe(20);
    expect(report.attributionStartsMs).toBe(BASE_TIME + 20 * 3_600_000);
  });

  it('reports nothing but the count when every job has expired', () => {
    const report = buildMachinesReport([pool(noisy(100, 40, 1), [])], SPAN60, 'x');
    expect(report.machines).toEqual([]);
    expect(report.unattributedRuns).toBe(40);
    expect(report.attributionStartsMs).toBeNull();
  });
});
