import { describe, expect, it } from 'vitest';
import type { RawDatum, RawSummary } from './graphApi';
import { parseApiDate } from './graphApi';
import {
  buildSeriesData,
  indexInPushValues,
  MEAN_REPLICATE,
  metaFromSummary,
  pushValues,
  resolvePoint,
  seriesKey,
  seriesLabel,
} from './graphData';

function datum(o: Partial<RawDatum> & { id: number; value: number }): RawDatum {
  return {
    job_id: 100 + o.id,
    push_id: 1000 + o.id,
    push_timestamp: '2026-07-21T06:38:40',
    revision: 'a'.repeat(40),
    submit_time: null,
    ...o,
  };
}

function summary(data: RawDatum[], o: Partial<RawSummary> = {}): RawSummary {
  return {
    signature_id: 42,
    framework_id: 1,
    signature_hash: 'hash',
    platform: 'linux2404-64-shippable',
    test: 'ts_paint',
    suite: 'ts_paint',
    lower_is_better: true,
    has_subtests: false,
    measurement_unit: 'ms',
    application: 'firefox',
    repository_name: 'autoland',
    repository_id: 77,
    name: 'ts_paint opt e10s',
    parent_signature: null,
    should_alert: true,
    data,
    ...o,
  };
}

describe('parseApiDate', () => {
  it('reads the zone-less API timestamp as UTC', () => {
    expect(parseApiDate('2026-07-21T06:38:40')).toBe(Date.UTC(2026, 6, 21, 6, 38, 40));
  });
});

describe('buildSeriesData', () => {
  it('returns empty data for a missing or empty summary', () => {
    expect(buildSeriesData(null).replicates.points).toEqual([]);
    expect(buildSeriesData(summary([])).replicates.points).toEqual([]);
  });

  it('groups rows sharing a datum id into one run with N replicates', () => {
    const data = buildSeriesData(
      summary([
        datum({ id: 1, value: 10 }),
        datum({ id: 1, value: 12 }),
        datum({ id: 1, value: 14 }),
      ]),
    );
    expect(data.runs).toHaveLength(1);
    expect(data.runs[0].values).toEqual([10, 12, 14]);
    expect(data.runs[0].mean).toBe(12);
    expect(data.replicates.points).toHaveLength(3);
    expect(data.replicates.points.map((p) => p.replicateIndex)).toEqual([0, 1, 2]);
  });

  it('groups runs sharing a push id — retriggers', () => {
    const data = buildSeriesData(
      summary([
        datum({ id: 1, value: 10, push_id: 7, job_id: 500 }),
        datum({ id: 2, value: 20, push_id: 7, job_id: 501 }),
        datum({ id: 3, value: 30, push_id: 8, job_id: 502 }),
      ]),
    );
    expect(data.pushes).toHaveLength(2);
    expect(data.pushes[0].runs.map((r) => r.jobId)).toEqual([500, 501]);
    expect(data.pushes[1].runs.map((r) => r.jobId)).toEqual([502]);
    // One value per build, averaged across the retriggers.
    expect(data.pushes.map((p) => p.mean)).toEqual([15, 30]);
  });

  it('weights each retrigger equally in the push mean, not each replicate', () => {
    const data = buildSeriesData(
      summary([
        // One job with four replicates averaging 10…
        datum({ id: 1, value: 7, push_id: 7, job_id: 500 }),
        datum({ id: 1, value: 9, push_id: 7, job_id: 500 }),
        datum({ id: 1, value: 11, push_id: 7, job_id: 500 }),
        datum({ id: 1, value: 13, push_id: 7, job_id: 500 }),
        // …and a retrigger with one replicate at 20.
        datum({ id: 2, value: 20, push_id: 7, job_id: 501 }),
      ]),
    );
    // Mean of the run means: (10 + 20) / 2. Pooling all five replicates would
    // give 12, letting the four-replicate job outvote the retrigger.
    expect(data.pushes[0].mean).toBe(15);
  });

  it('sorts runs by push time even when the server order is scrambled', () => {
    const data = buildSeriesData(
      summary([
        datum({ id: 2, value: 20, push_timestamp: '2026-07-22T00:00:00' }),
        datum({ id: 1, value: 10, push_timestamp: '2026-07-21T00:00:00' }),
      ]),
    );
    expect(data.runs.map((r) => r.datumId)).toEqual([1, 2]);
    expect(data.replicates.points.map((p) => p.y)).toEqual([10, 20]);
  });

  it('regroups a datum whose rows are not contiguous', () => {
    const data = buildSeriesData(
      summary([
        datum({ id: 1, value: 10 }),
        datum({ id: 2, value: 20 }),
        datum({ id: 1, value: 11 }),
      ]),
    );
    expect(data.runs).toHaveLength(2);
    expect(data.runByDatumId.get(1)!.values).toEqual([10, 11]);
  });

  it('tracks the y extent across every replicate', () => {
    const data = buildSeriesData(
      summary([
        datum({ id: 1, value: 10 }),
        datum({ id: 1, value: 99 }),
        datum({ id: 2, value: 50 }),
      ]),
    );
    expect(data.replicates.minY).toBe(10);
    expect(data.replicates.maxY).toBe(99);
  });

  it('drops non-finite values instead of poisoning the extent', () => {
    const data = buildSeriesData(
      summary([
        datum({ id: 1, value: 10 }),
        datum({ id: 1, value: NaN as unknown as number }),
        datum({ id: 2, value: null as unknown as number }),
      ]),
    );
    expect(data.replicates.points).toHaveLength(1);
    expect(data.replicates.maxY).toBe(10);
  });

  it('builds one mean point per run, with its own tighter extent', () => {
    const data = buildSeriesData(
      summary([
        datum({ id: 1, value: 10, push_timestamp: '2026-07-21T00:00:00' }),
        datum({ id: 1, value: 30, push_timestamp: '2026-07-21T00:00:00' }),
        datum({ id: 2, value: 50, push_timestamp: '2026-07-22T00:00:00' }),
        datum({ id: 2, value: 70, push_timestamp: '2026-07-22T00:00:00' }),
      ]),
    );
    expect(data.means.points.map((p) => p.y)).toEqual([20, 60]);
    expect(data.means.points.map((p) => p.datumId)).toEqual([1, 2]);
    // The mean dots share the y the connecting line already passes through, so
    // they must carry the sentinel rather than a replicate index.
    expect(data.means.points.map((p) => p.replicateIndex)).toEqual([
      MEAN_REPLICATE,
      MEAN_REPLICATE,
    ]);
    expect([data.means.minY, data.means.maxY]).toEqual([20, 60]);
    expect([data.replicates.minY, data.replicates.maxY]).toEqual([10, 70]);
  });
});

describe('resolvePoint', () => {
  const data = buildSeriesData(
    summary([
      datum({ id: 1, value: 10, push_id: 7 }),
      datum({ id: 1, value: 12, push_id: 7 }),
    ]),
  );

  it('resolves a datum + replicate index to a value', () => {
    const r = resolvePoint(data, 1, 1);
    expect(r?.value).toBe(12);
    expect(r?.push.pushId).toBe(7);
  });

  it('returns null for a datum that is not loaded', () => {
    expect(resolvePoint(data, 999, 0)).toBeNull();
  });

  it('clamps an out-of-range replicate index to the first replicate', () => {
    expect(resolvePoint(data, 1, 9)?.replicateIndex).toBe(0);
  });

  it('resolves the mean sentinel to the run mean, not to a replicate', () => {
    const r = resolvePoint(data, 1, MEAN_REPLICATE);
    expect(r?.value).toBe(11);
    expect(r?.replicateIndex).toBe(MEAN_REPLICATE);
  });
});

// The summary endpoint returns a datum's replicate rows in a different order on
// every request (measured against production: four fetches of one datum, four
// different orders of the same ten values). Before `Run.values` was sorted, a
// `sel=` link therefore resolved to a different replicate on every page load —
// the reported bug.
describe('replicate ordering is independent of the response order', () => {
  const VALUES = [1625.7, 1569.567, 1606.922, 1483.444, 1716.022];
  const rowsIn = (order: number[]) =>
    summary(order.map((i) => datum({ id: 1, value: VALUES[i], push_id: 7 })));

  it('sorts a run so the index names a value, not a row position', () => {
    const data = buildSeriesData(rowsIn([0, 1, 2, 3, 4]));
    expect(data.runs[0].values).toEqual([...VALUES].sort((a, b) => a - b));
  });

  it('resolves one index to the same value however the rows arrived', () => {
    const shuffles = [
      [0, 1, 2, 3, 4],
      [4, 3, 2, 1, 0],
      [2, 0, 4, 1, 3],
      [1, 4, 0, 3, 2],
    ];
    for (const index of [0, 2, 4]) {
      const resolved = shuffles.map(
        (order) => resolvePoint(buildSeriesData(rowsIn(order)), 1, index)?.value,
      );
      expect(new Set(resolved).size).toBe(1);
    }
  });

  it('keeps the run mean, which does not depend on the order either', () => {
    const expected = VALUES.reduce((a, b) => a + b, 0) / VALUES.length;
    expect(buildSeriesData(rowsIn([3, 1, 4, 0, 2])).runs[0].mean).toBeCloseTo(expected, 9);
  });

  it('puts a run\'s dots in ascending y, all at the same x', () => {
    // The point array has to stay x-sorted for the binary searches in chart.ts;
    // every replicate of a run shares its push timestamp, so sorting by value
    // within a run can't disturb that.
    const points = buildSeriesData(rowsIn([2, 0, 4, 1, 3])).replicates.points;
    expect(points.map((p) => p.y)).toEqual([...VALUES].sort((a, b) => a - b));
    expect(new Set(points.map((p) => p.x)).size).toBe(1);
  });
});

describe('pushValues and indexInPushValues', () => {
  // One push, two runs (a retrigger): three replicates then two.
  const data = buildSeriesData(
    summary([
      datum({ id: 1, value: 10, push_id: 7, job_id: 1 }),
      datum({ id: 1, value: 11, push_id: 7, job_id: 1 }),
      datum({ id: 1, value: 12, push_id: 7, job_id: 1 }),
      datum({ id: 2, value: 20, push_id: 7, job_id: 2 }),
      datum({ id: 2, value: 21, push_id: 7, job_id: 2 }),
    ]),
  );
  const push = data.pushById.get(7)!;

  it('pools every run of the push, in run order', () => {
    expect(pushValues(push)).toEqual([10, 11, 12, 20, 21]);
  });

  it('locates a replicate across the run boundary', () => {
    expect(indexInPushValues(push, 1, 0)).toBe(0);
    expect(indexInPushValues(push, 1, 2)).toBe(2);
    expect(indexInPushValues(push, 2, 0)).toBe(3);
    expect(indexInPushValues(push, 2, 1)).toBe(4);
  });

  it('has no index for a run mean, which is not one of the values', () => {
    expect(indexInPushValues(push, 1, MEAN_REPLICATE)).toBe(-1);
  });

  it('has no index for an unknown run or an out-of-range replicate', () => {
    expect(indexInPushValues(push, 99, 0)).toBe(-1);
    expect(indexInPushValues(push, 1, 5)).toBe(-1);
  });
});

describe('metaFromSummary', () => {
  it('drops the test name when it merely repeats the suite', () => {
    expect(metaFromSummary(summary([])).test).toBe('');
  });

  it('keeps a genuine subtest name', () => {
    const meta = metaFromSummary(summary([], { suite: 'speedometer3', test: 'Charts' }));
    expect(meta.test).toBe('Charts');
    expect(seriesLabel(meta)).toBe('speedometer3 · Charts');
  });

  it('recovers the options from the composed name', () => {
    expect(metaFromSummary(summary([], { name: 'ts_paint opt e10s fission' })).options).toBe(
      'opt e10s fission',
    );
    const sub = metaFromSummary(
      summary([], { suite: 'speedometer3', test: 'Charts', name: 'speedometer3 Charts opt' }),
    );
    expect(sub.options).toBe('opt');
  });

  it('leaves options empty when the name does not start with the suite', () => {
    expect(metaFromSummary(summary([], { name: 'something else entirely' })).options).toBe('');
  });

  it('resolves the parent signature for the subtests-compare link', () => {
    // A subtest points at its parent; a parent with subtests points at itself
    // (perf.compare keys its subtest table by the parent, so a parent is its own
    // answer); a standalone signature has neither.
    expect(
      metaFromSummary(summary([], { parent_signature: 5152393, has_subtests: false }))
        .parentSignatureId,
    ).toBe(5152393);
    expect(
      metaFromSummary(summary([], { signature_id: 777, has_subtests: true, parent_signature: null }))
        .parentSignatureId,
    ).toBe(777);
    expect(
      metaFromSummary(summary([], { has_subtests: false, parent_signature: null }))
        .parentSignatureId,
    ).toBeNull();
  });

  it('defaults lowerIsBetter to true and unit to empty', () => {
    const meta = metaFromSummary(
      summary([], { lower_is_better: null as unknown as boolean, measurement_unit: null }),
    );
    expect(meta.lowerIsBetter).toBe(true);
    expect(meta.measurementUnit).toBe('');
  });
});

describe('seriesKey', () => {
  it('is scoped by repo, since signature ids are per-repo rows', () => {
    expect(seriesKey({ repository: 'autoland', signatureId: 1, frameworkId: 1 })).toBe(
      'autoland|1',
    );
  });
});
