import { describe, expect, it } from 'vitest';
import type { RawDatum, RawSummary } from './graphApi';
import { parseApiDate } from './graphApi';
import {
  buildSeriesData,
  metaFromSummary,
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
    expect(buildSeriesData(null).points).toEqual([]);
    expect(buildSeriesData(summary([])).points).toEqual([]);
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
    expect(data.points).toHaveLength(3);
    expect(data.points.map((p) => p.replicateIndex)).toEqual([0, 1, 2]);
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
  });

  it('sorts runs by push time even when the server order is scrambled', () => {
    const data = buildSeriesData(
      summary([
        datum({ id: 2, value: 20, push_timestamp: '2026-07-22T00:00:00' }),
        datum({ id: 1, value: 10, push_timestamp: '2026-07-21T00:00:00' }),
      ]),
    );
    expect(data.runs.map((r) => r.datumId)).toEqual([1, 2]);
    expect(data.points.map((p) => p.y)).toEqual([10, 20]);
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
    expect(data.minY).toBe(10);
    expect(data.maxY).toBe(99);
  });

  it('drops non-finite values instead of poisoning the extent', () => {
    const data = buildSeriesData(
      summary([
        datum({ id: 1, value: 10 }),
        datum({ id: 1, value: NaN as unknown as number }),
        datum({ id: 2, value: null as unknown as number }),
      ]),
    );
    expect(data.points).toHaveLength(1);
    expect(data.maxY).toBe(10);
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
