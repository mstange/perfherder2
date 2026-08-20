import { describe, expect, it } from 'vitest';
import {
  buildComparison,
  classifyComparison,
  comparisonLinks,
  distinguishingLabels,
  sideOrder,
  type CompareSide,
} from './compare';
import { MEAN_REPLICATE, type PushGroup, type Run, type SeriesMeta } from './graphData';
import type { RepoLinkInfo } from '../shared/links';

const DAY = 86400000;

function meta(): SeriesMeta {
  return {
    suite: 'speedometer3',
    test: '',
    platform: 'macosx1500-aarch64-shippable',
    application: 'firefox',
    measurementUnit: 'score',
    lowerIsBetter: false,
    name: 'speedometer3 opt',
    options: 'opt',
    parentSignatureId: 5152393,
    alertThreshold: null,
    source: 'summary',
  };
}

function run(o: {
  datumId: number;
  jobId?: number | null;
  machineName?: string | null;
  x: number;
  values: number[];
}): Run {
  const mean = o.values.reduce((a, b) => a + b, 0) / o.values.length;
  return {
    datumId: o.datumId,
    jobId: o.jobId === undefined ? o.datumId + 1000 : o.jobId,
    machineName: o.machineName ?? null,
    pushId: 0,
    x: o.x,
    revision: '',
    values: o.values,
    mean,
  };
}

// A push with one or more runs. `revision` is padded to something rev-shaped so
// the link tests read like the real thing.
function push(o: { pushId: number; x: number; rev: string; runs: Run[] }): PushGroup {
  const runs = o.runs.map((r) => ({ ...r, pushId: o.pushId, x: o.x, revision: o.rev }));
  return {
    pushId: o.pushId,
    revision: o.rev,
    x: o.x,
    runs,
    xRoom: Infinity,
    mean: runs.reduce((s, r) => s + r.mean, 0) / runs.length,
  };
}

function side(o: {
  signatureId?: number;
  repository?: string;
  frameworkId?: number;
  metaOver?: Partial<SeriesMeta>;
  push: PushGroup;
  runIndex?: number;
  replicateIndex?: number;
  color?: string;
}): CompareSide {
  const r = o.push.runs[o.runIndex ?? 0];
  const replicateIndex = o.replicateIndex ?? 0;
  return {
    ref: {
      repository: o.repository ?? 'mozilla-central',
      signatureId: o.signatureId ?? 5353482,
      frameworkId: o.frameworkId ?? 13,
    },
    meta: { ...meta(), ...o.metaOver },
    color: o.color ?? '#464876',
    push: o.push,
    run: r,
    replicateIndex,
    value: replicateIndex === MEAN_REPLICATE ? r.mean : r.values[replicateIndex],
  };
}

const older = push({
  pushId: 1,
  x: 10 * DAY,
  rev: 'a'.repeat(40),
  runs: [run({ datumId: 1, x: 0, values: [100, 101, 102, 103, 104] })],
});
const newer = push({
  pushId: 2,
  x: 12 * DAY,
  rev: 'b'.repeat(40),
  runs: [run({ datumId: 2, x: 0, values: [120, 121, 122, 123, 124] })],
});
// Two runs of one push: a retrigger.
const retriggered = push({
  pushId: 3,
  x: 14 * DAY,
  rev: 'c'.repeat(40),
  runs: [
    run({ datumId: 10, jobId: 500, x: 0, values: [10, 11, 12, 13] }),
    run({ datumId: 11, jobId: 600, x: 0, values: [40, 41, 42, 43] }),
  ],
});

describe('classifyComparison', () => {
  it('names each of the five relationships', () => {
    expect(classifyComparison(side({ push: older }), side({ push: newer }))).toBe('push');
    expect(
      classifyComparison(side({ push: older }), side({ push: older, signatureId: 999 })),
    ).toBe('series');
    expect(
      classifyComparison(
        side({ push: retriggered, runIndex: 0 }),
        side({ push: retriggered, runIndex: 1 }),
      ),
    ).toBe('run');
    expect(
      classifyComparison(
        side({ push: retriggered, replicateIndex: 0 }),
        side({ push: retriggered, replicateIndex: 2 }),
      ),
    ).toBe('replicate');
    expect(
      classifyComparison(side({ push: older }), side({ push: newer, signatureId: 999 })),
    ).toBe('unrelated');
  });

  it('does not call two repositories the same push', () => {
    // Push ids are per-repository, so an id match across repos is a coincidence,
    // not the same build. Same trap as Series.key.
    const a = side({ push: older, repository: 'mozilla-central', signatureId: 1 });
    const b = side({ push: older, repository: 'autoland', signatureId: 2 });
    expect(classifyComparison(a, b)).toBe('unrelated');
  });
});

describe('sideOrder', () => {
  it('orders by push time', () => {
    expect(sideOrder(side({ push: older }), side({ push: newer }))).toBeLessThan(0);
    expect(sideOrder(side({ push: newer }), side({ push: older }))).toBeGreaterThan(0);
  });

  it('falls through to the job, then the datum, then the replicate', () => {
    const first = side({ push: retriggered, runIndex: 0 });
    const second = side({ push: retriggered, runIndex: 1 });
    expect(sideOrder(first, second)).toBeLessThan(0);
    expect(
      sideOrder(
        side({ push: retriggered, replicateIndex: 1 }),
        side({ push: retriggered, replicateIndex: 3 }),
      ),
    ).toBeLessThan(0);
  });

  it('is zero for two series on one push, leaving click order alone', () => {
    const a = side({ push: older, signatureId: 1 });
    const b = side({ push: older, signatureId: 2 });
    expect(sideOrder(a, b)).toBe(0);
  });
});

describe('distinguishingLabels', () => {
  it('prefers the application, the shortest thing that differs', () => {
    expect(
      distinguishingLabels(
        side({ push: older, metaOver: { application: 'firefox' } }),
        side({ push: older, metaOver: { application: 'chrome', platform: 'windows11-64' } }),
      ),
    ).toEqual(['firefox', 'chrome']);
  });

  it('falls through to the platform, then the test, then the options', () => {
    expect(
      distinguishingLabels(
        side({ push: older, metaOver: { platform: 'linux2404-64' } }),
        side({ push: older, metaOver: { platform: 'windows11-64' } }),
      ),
    ).toEqual(['linux2404-64', 'windows11-64']);
    expect(
      distinguishingLabels(
        side({ push: older, metaOver: { test: 'Charts' } }),
        side({ push: older, metaOver: { test: 'Editor' } }),
      ),
    ).toEqual(['speedometer3 · Charts', 'speedometer3 · Editor']);
    expect(
      distinguishingLabels(
        side({ push: older, metaOver: { options: 'opt cold' } }),
        side({ push: older, metaOver: { options: 'opt warm' } }),
      ),
    ).toEqual(['opt cold', 'opt warm']);
  });

  it('names the signatures when nothing in the metadata differs', () => {
    expect(
      distinguishingLabels(
        side({ push: older, signatureId: 11 }),
        side({ push: older, signatureId: 22 }),
      ),
    ).toEqual(['signature 11', 'signature 22']);
  });
});

describe('buildComparison', () => {
  it('is null for a point compared with itself', () => {
    expect(buildComparison(side({ push: older }), side({ push: older }))).toBeNull();
  });

  it('puts the earlier push first however it was clicked', () => {
    const forward = buildComparison(side({ push: older }), side({ push: newer }))!;
    expect(forward.swapped).toBe(false);
    expect(forward.base.push.pushId).toBe(1);
    expect(forward.base.label).toBe('before');
    expect(forward.next.label).toBe('after');

    // Selecting the later push and shift-clicking the earlier one has to produce
    // the same comparison, or the sign of the delta depends on click order.
    const backward = buildComparison(side({ push: newer }), side({ push: older }))!;
    expect(backward.swapped).toBe(true);
    expect(backward.base.push.pushId).toBe(1);
    expect(backward.medianDelta).toBe(forward.medianDelta);
  });

  it('pools each push and reports the median shift', () => {
    const c = buildComparison(side({ push: older }), side({ push: newer }))!;
    expect(c.kind).toBe('push');
    expect(c.headline).toBe('one series, two pushes');
    expect(c.base.values).toEqual([100, 101, 102, 103, 104]);
    expect(c.next.values).toEqual([120, 121, 122, 123, 124]);
    expect(c.medianDelta).toBe(20);
    expect(c.medianDeltaFraction).toBeCloseTo(20 / 102, 12);
    expect(c.meanDelta).toBeCloseTo(20, 12);
    expect(c.test?.significant).toBe(true);
    expect(c.unit).toBe('score');
  });

  it('reads the direction through lowerIsBetter', () => {
    // The fixture is a score: higher is better, so going up is an improvement.
    const up = buildComparison(side({ push: older }), side({ push: newer }))!;
    expect(up.direction).toBe('improvement');
    const asMs = buildComparison(
      side({ push: older, metaOver: { lowerIsBetter: true } }),
      side({ push: newer, metaOver: { lowerIsBetter: true } }),
    )!;
    expect(asMs.direction).toBe('regression');
  });

  it('pools per run when the two points are two runs of one push', () => {
    // Pooling per push would give both sides all eight values and a delta of
    // zero — the one case where the per-push framing actively lies.
    const c = buildComparison(
      side({ push: retriggered, runIndex: 0 }),
      side({ push: retriggered, runIndex: 1 }),
    )!;
    expect(c.kind).toBe('run');
    expect(c.base.values).toEqual([10, 11, 12, 13]);
    expect(c.next.values).toEqual([40, 41, 42, 43]);
    expect(c.base.label).toBe('run 1');
    expect(c.next.label).toBe('run 2');
    expect(c.medianDelta).toBe(30);
  });

  it('gives two replicates of one run a single value each', () => {
    const c = buildComparison(
      side({ push: retriggered, replicateIndex: 0 }),
      side({ push: retriggered, replicateIndex: 3 }),
    )!;
    expect(c.kind).toBe('replicate');
    expect(c.base.values).toEqual([10]);
    expect(c.next.values).toEqual([13]);
    expect(c.base.markedIndex).toBe(0);
    expect(c.medianDelta).toBe(3);
    // No test at all: one value against one value yields p = 1 and a "large"
    // Cliff's delta every time, which reads as a finding and isn't one.
    expect(c.test).toBeNull();
    expect(c.direction).toBe('none');
  });

  it('marks the clicked value inside a pooled push', () => {
    const c = buildComparison(
      side({ push: retriggered, runIndex: 1, replicateIndex: 2 }),
      side({ push: newer }),
    )!;
    // Base is `newer` (earlier push); the retrigger side is `next`, where the
    // clicked value is run 2's third replicate — index 4 + 2 = 6.
    expect(c.next.markedIndex).toBe(6);
    expect(c.next.values[6]).toBe(42);
  });

  it('has no marked index for a run-mean selection', () => {
    const c = buildComparison(
      side({ push: older, replicateIndex: MEAN_REPLICATE }),
      side({ push: newer }),
    )!;
    expect(c.base.markedIndex).toBe(-1);
  });

  it('labels two series on one push by what distinguishes them', () => {
    const c = buildComparison(
      side({ push: older, signatureId: 1, metaOver: { application: 'firefox' } }),
      side({ push: older, signatureId: 2, metaOver: { application: 'chrome' } }),
    )!;
    expect(c.kind).toBe('series');
    expect([c.base.label, c.next.label]).toEqual(['firefox', 'chrome']);
    expect(c.swapped).toBe(false);
  });

  it('calls nothing an improvement or regression unless it is one series over time', () => {
    // Chrome being slower than Firefox on one build is not a regression; two
    // retriggers of one build differing is noise; two different series on two
    // different pushes aren't a before and an after. All three produce
    // significant deltas; none of them is a verdict.
    const acrossSeries = buildComparison(
      side({ push: older, signatureId: 1 }),
      side({ push: older, signatureId: 2, metaOver: { application: 'chrome' } }),
    )!;
    expect(acrossSeries.direction).toBe('none');
    const acrossRuns = buildComparison(
      side({ push: retriggered, runIndex: 0 }),
      side({ push: retriggered, runIndex: 1 }),
    )!;
    expect(acrossRuns.test?.significant).toBe(true);
    expect(acrossRuns.direction).toBe('none');
    const unrelated = buildComparison(
      side({ push: older, signatureId: 1 }),
      side({ push: newer, signatureId: 2, metaOver: { application: 'chrome' } }),
    )!;
    expect(unrelated.kind).toBe('unrelated');
    expect(unrelated.direction).toBe('none');
    // One series across two pushes is the one case that is a change.
    expect(buildComparison(side({ push: older }), side({ push: newer }))!.direction).not.toBe(
      'none',
    );
  });

  it('warns when the two series are not measured in the same unit', () => {
    const c = buildComparison(
      side({ push: older, signatureId: 1, metaOver: { measurementUnit: 'ms' } }),
      side({ push: older, signatureId: 2, metaOver: { measurementUnit: 'score' } }),
    )!;
    expect(c.unit).toBe('');
    expect(c.warning).toMatch(/different units/);
  });

  it('warns when the two series disagree about which direction is better', () => {
    const c = buildComparison(
      side({ push: older, signatureId: 1, metaOver: { lowerIsBetter: true } }),
      side({ push: older, signatureId: 2, metaOver: { lowerIsBetter: false } }),
    )!;
    expect(c.warning).toMatch(/which direction is better/);
  });

  it('is quiet when the units agree', () => {
    expect(buildComparison(side({ push: older }), side({ push: newer }))!.warning).toBeNull();
  });
});

describe('comparisonLinks', () => {
  const hg: RepoLinkInfo = {
    name: 'mozilla-central',
    dvcs_type: 'hg',
    url: 'https://hg.mozilla.org/mozilla-central',
  };
  const crossPush = buildComparison(side({ push: older }), side({ push: newer }))!;

  it('links the pushlog range in time order', () => {
    const links = comparisonLinks(crossPush, hg);
    expect(links.pushlog).toContain(`fromchange=${'a'.repeat(40)}`);
    expect(links.pushlog).toContain(`tochange=${'b'.repeat(40)}`);
  });

  it('links perf.compare with both revisions and the subtest table', () => {
    const links = comparisonLinks(crossPush, hg);
    expect(links.perfCompare).toContain('/compare-results?');
    expect(links.perfCompare).toContain(`baseRev=${'a'.repeat(40)}`);
    expect(links.perfCompareSubtests).toContain('baseParentSignature=5152393');
    expect(links.perfCompareSubtests).toContain('newParentSignature=5152393');
  });

  it('offers nothing at all within one push', () => {
    // One revision: an empty pushlog range, and a perf.compare link that would
    // compare a build against itself.
    const withinPush = buildComparison(
      side({ push: retriggered, runIndex: 0 }),
      side({ push: retriggered, runIndex: 1 }),
    )!;
    expect(comparisonLinks(withinPush, hg)).toEqual({
      pushlog: null,
      perfCompare: null,
      perfCompareSubtests: null,
    });
  });

  it('drops the pushlog across repositories but keeps perf.compare', () => {
    const crossRepo = buildComparison(
      side({ push: older, repository: 'mozilla-central', signatureId: 1 }),
      side({ push: newer, repository: 'autoland', signatureId: 2 }),
    )!;
    const links = comparisonLinks(crossRepo, hg);
    expect(links.pushlog).toBeNull();
    expect(links.perfCompare).toContain('baseRepo=mozilla-central');
    expect(links.perfCompare).toContain('newRepo=autoland');
  });

  it('drops the pushlog until the repository record has landed', () => {
    expect(comparisonLinks(crossPush, null).pushlog).toBeNull();
    expect(comparisonLinks(crossPush, null).perfCompare).not.toBeNull();
  });

  it('drops the subtests link when a side has no parent signature', () => {
    const standalone = buildComparison(
      side({ push: older, metaOver: { parentSignatureId: null } }),
      side({ push: newer }),
    )!;
    expect(comparisonLinks(standalone, hg).perfCompareSubtests).toBeNull();
    expect(comparisonLinks(standalone, hg).perfCompare).not.toBeNull();
  });
});
