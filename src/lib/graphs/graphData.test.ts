import { describe, expect, it } from 'vitest';
import { JITTER_GAP_FRACTION } from '../shared/chart';
import type { RawDatum, RawSummary } from './graphApi';
import { parseApiDate } from './graphApi';
import { buildOptionMap, type OptionCollection, type RawSignature } from '../picker/signaturesApi';
import optionCollections from '../fixtures/option-collections.json';
import signaturesById from '../fixtures/signatures-by-id.json';
import summaryFixture from '../fixtures/summary.json';
import {
  alertThresholdFromSummary,
  buildSeriesData,
  DEFAULT_ALERT_THRESHOLD,
  indexInPushValues,
  isPlaceholder,
  jitterForSelection,
  MEAN_REPLICATE,
  metaFromSignature,
  metaFromSummary,
  placeholderMeta,
  pushValues,
  replicateGroups,
  resolveAlertThreshold,
  resolvePoint,
  runRangeInPushValues,
  seriesKey,
  seriesLabel,
  thresholdParentRef,
  type AlertThreshold,
  type SeriesRef,
} from './graphData';

function datum(o: Partial<RawDatum> & { id: number; value: number }): RawDatum {
  return {
    job_id: 100 + o.id,
    push_id: 1000 + o.id,
    push_timestamp: '2026-07-21T06:38:40',
    revision: 'a'.repeat(40),
    submit_time: null,
    machine_name: null,
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
    alert_change_type: null,
    alert_threshold: null,
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

  it('carries the run’s machine onto every dot it produced', () => {
    const data = buildSeriesData(
      summary([
        datum({ id: 1, value: 10, push_id: 7, machine_name: 'nuc13-085' }),
        datum({ id: 1, value: 12, push_id: 7, machine_name: 'nuc13-085' }),
        datum({ id: 2, value: 20, push_id: 8, machine_name: null }),
      ]),
    );
    expect(data.runs.map((r) => r.machineName)).toEqual(['nuc13-085', null]);
    expect(data.replicates.points.map((p) => p.machine)).toEqual([
      'nuc13-085',
      'nuc13-085',
      null,
    ]);
    // The mean point set too, or a focus would empty the graph in `runs` mode.
    expect(data.means.points.map((p) => p.machine)).toEqual(['nuc13-085', null]);
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

  it('groups every run of the push, marking the selected replicate', () => {
    const groups = replicateGroups(push, 2, 1);
    expect(groups.map((g) => [g.run.datumId, g.ordinal])).toEqual([
      [1, 1],
      [2, 2],
    ]);
    // Only the selected run carries an index; the other one is listed in full
    // but has nothing marked.
    expect(groups.map((g) => g.selectedIndex)).toEqual([null, 1]);
    expect(groups.map((g) => g.selectedRun)).toEqual([false, true]);
  });

  it('marks the run but no replicate when a run mean is selected', () => {
    const groups = replicateGroups(push, 1, MEAN_REPLICATE);
    expect(groups.map((g) => g.selectedRun)).toEqual([true, false]);
    expect(groups.map((g) => g.selectedIndex)).toEqual([null, null]);
  });

  it('marks nothing for a selection in another push', () => {
    const groups = replicateGroups(push, 99, 0);
    expect(groups.every((g) => !g.selectedRun && g.selectedIndex === null)).toBe(true);
  });

  it('gives each run a contiguous range of the pool', () => {
    expect(runRangeInPushValues(push, 1)).toEqual({ start: 0, end: 3 });
    expect(runRangeInPushValues(push, 2)).toEqual({ start: 3, end: 5 });
    // The range is over the same array `pushValues` builds, which is what lets
    // the strip use it as an index range.
    const values = pushValues(push);
    const r = runRangeInPushValues(push, 2)!;
    expect(values.slice(r.start, r.end)).toEqual([20, 21]);
  });

  it('has no range for a run that is not in this push', () => {
    expect(runRangeInPushValues(push, 99)).toBeNull();
  });
});

describe('jitter', () => {
  it('spreads the dots of a run and leaves a lone dot alone', () => {
    const spread = buildSeriesData(
      summary([
        datum({ id: 1, value: 10, push_id: 7 }),
        datum({ id: 1, value: 11, push_id: 7 }),
        datum({ id: 1, value: 12, push_id: 7 }),
      ]),
    ).replicates.points;
    expect(spread.every((p) => p.jitter !== 0)).toBe(true);
    expect(new Set(spread.map((p) => p.jitter)).size).toBe(3);
    for (const p of spread) {
      expect(p.jitter).toBeGreaterThanOrEqual(-1);
      expect(p.jitter).toBeLessThanOrEqual(1);
    }

    // A single measurement on a push has nothing to be separated from, and
    // nudging it would put it off the connecting line's vertex for nothing.
    const alone = buildSeriesData(summary([datum({ id: 1, value: 10 })]));
    expect(alone.replicates.points[0].jitter).toBe(0);
    expect(alone.means.points[0].jitter).toBe(0);
  });

  it('judges the two point sets separately', () => {
    // One push, one run, three replicates: the replicate dots overlap and get
    // spread, but the single mean dot doesn't.
    const data = buildSeriesData(
      summary([
        datum({ id: 1, value: 10, push_id: 7 }),
        datum({ id: 1, value: 11, push_id: 7 }),
        datum({ id: 1, value: 12, push_id: 7 }),
      ]),
    );
    expect(data.replicates.points.every((p) => p.jitter !== 0)).toBe(true);
    expect(data.means.points.map((p) => p.jitter)).toEqual([0]);

    // Retriggered: now the mean dots share an x too, so they get spread.
    const retriggered = buildSeriesData(
      summary([
        datum({ id: 1, value: 10, push_id: 7, job_id: 1 }),
        datum({ id: 2, value: 20, push_id: 7, job_id: 2 }),
      ]),
    );
    expect(retriggered.means.points.every((p) => p.jitter !== 0)).toBe(true);
  });

  it('is stable across the two ways of computing it', () => {
    // The dots are drawn from `points`, the selection ring from a push resolved
    // out of `pushById`. If those two disagreed the ring would sit beside the dot
    // it names, which is the failure this pins.
    const data = buildSeriesData(
      summary([
        datum({ id: 1, value: 10, push_id: 7, job_id: 1 }),
        datum({ id: 1, value: 12, push_id: 7, job_id: 1 }),
        datum({ id: 2, value: 20, push_id: 7, job_id: 2 }),
        datum({ id: 3, value: 30, push_id: 8, job_id: 3 }),
      ]),
    );
    for (const set of [data.replicates, data.means]) {
      for (const p of set.points) {
        const push = data.pushById.get(data.runByDatumId.get(p.datumId)!.pushId)!;
        expect(jitterForSelection(push, p.datumId, p.replicateIndex)).toBe(p.jitter);
      }
    }
  });

  it('gives each push the room to its nearer neighbour', () => {
    // Pushes at 0, 1h, 5h: the middle one is 1h from the first and 4h from the
    // last, so the nearer neighbour caps it at the same room the first one gets.
    const at = (h: number, id: number) =>
      datum({
        id,
        value: 10,
        push_id: id,
        push_timestamp: `2026-07-21T${String(h).padStart(2, '0')}:00:00`,
      });
    const HOUR = 3600000;
    const pushes = buildSeriesData(summary([at(0, 1), at(1, 2), at(5, 3)])).pushes;
    expect(pushes.map((p) => p.xRoom / (HOUR * JITTER_GAP_FRACTION))).toEqual([1, 1, 4]);
  });

  it('leaves a lone push unbounded, for the pixel ceiling to decide', () => {
    // No neighbour, so nothing to collide with. Infinity rather than zero: the
    // alternative is that a series with one push draws its replicates as a line
    // even when the plot is nothing but empty space.
    expect(buildSeriesData(summary([datum({ id: 1, value: 10 })])).pushes[0].xRoom).toBe(
      Infinity,
    );
  });

  it('copies the room onto every dot of the push', () => {
    const data = buildSeriesData(
      summary([
        datum({ id: 1, value: 10, push_id: 7, push_timestamp: '2026-07-21T00:00:00' }),
        datum({ id: 1, value: 11, push_id: 7, push_timestamp: '2026-07-21T00:00:00' }),
        datum({ id: 2, value: 20, push_id: 8, push_timestamp: '2026-07-21T01:00:00' }),
      ]),
    );
    for (const set of [data.replicates, data.means]) {
      for (const p of set.points) {
        expect(p.xRoom).toBe(data.pushById.get(data.runByDatumId.get(p.datumId)!.pushId)!.xRoom);
      }
    }
  });

  it('keeps the point arrays x-sorted', () => {
    // Emitting points push by push (needed to know how many dots share an x)
    // must not disturb the order every binary search in chart.ts relies on.
    const rows = [8, 5, 9, 5, 7].map((day, i) =>
      datum({
        id: i + 1,
        value: 10 + i,
        push_id: day,
        push_timestamp: `2026-07-0${day}T06:00:00`,
      }),
    );
    for (const set of [
      buildSeriesData(summary(rows)).replicates,
      buildSeriesData(summary(rows)).means,
    ]) {
      const xs = set.points.map((p) => p.x);
      expect(xs).toEqual([...xs].sort((a, b) => a - b));
    }
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

describe('metaFromSignature', () => {
  const OPTION_MAP = buildOptionMap(optionCollections as OptionCollection[]);
  // "opt", the collection both recorded fixtures use.
  const OPT = '102210fe594ee9b33d82058545b1ed14f4c8206e';

  function signature(over: Partial<RawSignature> = {}): RawSignature {
    return {
      id: 42,
      signature_hash: 'h'.repeat(40),
      framework_id: 1,
      option_collection_hash: OPT,
      machine_platform: 'linux2404-64-shippable',
      suite: 'ts_paint',
      should_alert: true,
      extra_options: ['e10s', 'fission'],
      ...over,
    };
  }

  // The load-bearing test of the whole early-identity path: the two endpoints
  // describe the same signature, and the card is drawn from whichever answered
  // first, so any disagreement is a card that visibly rewrites itself when its
  // data lands. Both sides here are *recorded production responses* for
  // mozilla-central signature 5310381 — a damp subtest — not hand-written
  // fixtures agreeing with each other.
  it('agrees field for field with the summary response for the same signature', () => {
    const raw = (signaturesById as Record<string, RawSignature>)['5310381'];
    const row = (summaryFixture as RawSummary[])[0];
    expect(row.signature_id).toBe(5310381);

    const fromSignature = metaFromSignature(5310381, raw, OPTION_MAP);
    const fromSummary = metaFromSummary(row);

    // Everything the card and the shared-attribute header read, including the
    // server-composed name this one has to reproduce by hand.
    expect(fromSignature.name).toBe(fromSummary.name);
    expect(fromSignature.options).toBe(fromSummary.options);
    expect(fromSignature.suite).toBe(fromSummary.suite);
    expect(fromSignature.test).toBe(fromSummary.test);
    expect(fromSignature.platform).toBe(fromSummary.platform);
    expect(fromSignature.application).toBe(fromSummary.application);
    expect(fromSignature.measurementUnit).toBe(fromSummary.measurementUnit);
    expect(fromSignature.lowerIsBetter).toBe(fromSummary.lowerIsBetter);

    // And the three that are allowed to differ, spelled out so a change to any
    // of them has to be deliberate. The threshold and the parent id are the two
    // fields the signatures endpoint does not serialize.
    expect(fromSignature.source).toBe('signature');
    expect(fromSummary.source).toBe('summary');
    expect(fromSummary.parentSignatureId).toBe(5309052);
    expect(fromSignature.parentSignatureId).toBeNull();
    expect(fromSignature.alertThreshold).toBeNull();
  });

  it('composes the name the way the serializer does, trailing space and all', () => {
    // `"{} {} {}".format(test_suite, option_name, extra_options)` — a signature
    // with no extra options really does come back as "…opt " from treeherder
    // (checked against production), and `options` must not pick that up.
    const meta = metaFromSignature(42, signature({ extra_options: undefined }), OPTION_MAP);
    expect(meta.name).toBe('ts_paint opt ');
    expect(meta.options).toBe('opt');
  });

  it('does not deduplicate options, because the server does not', () => {
    // 204 of autoland's 31,547 signatures have an option collection that
    // overlaps their extra options. The picker tidies this; matching the summary
    // endpoint matters more here, since the two take turns describing one card.
    const asan = '03abd064e50ec12b8c7309950268531d78c63f60'; // ["asan"]
    const meta = metaFromSignature(
      42,
      signature({ suite: 'installer size', option_collection_hash: asan, extra_options: ['asan', 'opt'] }),
      OPTION_MAP,
    );
    expect(meta.name).toBe('installer size asan asan opt');
    expect(meta.options).toBe('asan asan opt');
  });

  it('drops a test name that merely repeats the suite, as metaFromSummary does', () => {
    const meta = metaFromSignature(42, signature({ suite: 'ts_paint', test: 'ts_paint' }), OPTION_MAP);
    expect(meta.test).toBe('');
    expect(meta.name).toBe('ts_paint opt e10s fission');
  });

  it('keeps a genuine subtest name in the composed name', () => {
    const meta = metaFromSignature(
      42,
      signature({ suite: 'speedometer3', test: 'Charts' }),
      OPTION_MAP,
    );
    expect(meta.test).toBe('Charts');
    expect(meta.name).toBe('speedometer3 Charts opt e10s fission');
  });

  it('claims a parent id only for a parent, never for a subtest', () => {
    // A parent is its own answer, as in `metaFromSummary`. A subtest's parent is
    // reported as a *hash* by this endpoint, so the id stays unknown until the
    // data arrives — and null here means "unknown", not "has no parent".
    expect(metaFromSignature(777, signature({ has_subtests: true }), OPTION_MAP).parentSignatureId)
      .toBe(777);
    expect(
      metaFromSignature(777, signature({ parent_signature: 'p'.repeat(40) }), OPTION_MAP)
        .parentSignatureId,
    ).toBeNull();
    expect(metaFromSignature(777, signature(), OPTION_MAP).parentSignatureId).toBeNull();
  });

  it('defaults lowerIsBetter to true, since the producer omits it when true', () => {
    expect(metaFromSignature(42, signature(), OPTION_MAP).lowerIsBetter).toBe(true);
    expect(
      metaFromSignature(42, signature({ lower_is_better: false }), OPTION_MAP).lowerIsBetter,
    ).toBe(false);
  });

  it('is not a placeholder — its fields are real, unlike placeholderMeta', () => {
    const ref: SeriesRef = { repository: 'autoland', signatureId: 42, frameworkId: 1 };
    expect(isPlaceholder(metaFromSignature(42, signature(), OPTION_MAP))).toBe(false);
    expect(isPlaceholder(metaFromSummary(summary([])))).toBe(false);
    expect(isPlaceholder(placeholderMeta(ref))).toBe(true);
  });

  it('leaves options empty when the option collection is unknown to us', () => {
    // A collection added after our memoised table was fetched. The extra options
    // still come through; the missing one is simply not named.
    const meta = metaFromSignature(
      42,
      signature({ option_collection_hash: 'z'.repeat(40) }),
      OPTION_MAP,
    );
    expect(meta.options).toBe('e10s fission');
    expect(meta.name).toBe('ts_paint  e10s fission');
  });
});

describe('alertThresholdFromSummary', () => {
  it('reads a percentage threshold, whether or not the change type is spelled out', () => {
    // 0 is ALERT_PCT and null is the same thing — most signatures leave it unset.
    expect(alertThresholdFromSummary(summary([], { alert_threshold: 5 }))).toEqual({
      kind: 'percentage',
      value: 5,
    });
    expect(
      alertThresholdFromSummary(summary([], { alert_threshold: 5, alert_change_type: 0 })),
    ).toEqual({ kind: 'percentage', value: 5 });
  });

  it('reads an absolute threshold in the metric’s own units', () => {
    expect(
      alertThresholdFromSummary(summary([], { alert_threshold: 102400, alert_change_type: 1 })),
    ).toEqual({ kind: 'absolute', value: 102400 });
  });

  it('says nothing when there is no threshold, change type or not', () => {
    // A change type on its own declares nothing: there is no number to compare
    // against. Reading it as "absolute, 0" would pass every change ever measured.
    expect(alertThresholdFromSummary(summary([]))).toBeNull();
    expect(alertThresholdFromSummary(summary([], { alert_change_type: 1 }))).toBeNull();
    expect(alertThresholdFromSummary(summary([], { alert_threshold: 0 }))).toBeNull();
  });
});

describe('resolveAlertThreshold', () => {
  const own: AlertThreshold = { kind: 'percentage', value: 6 };
  const parent: AlertThreshold = { kind: 'absolute', value: 102400 };

  it('prefers the signature’s own threshold to its parent’s', () => {
    expect(resolveAlertThreshold(own, parent)).toBe(own);
  });

  it('inherits the parent’s when the signature declares none', () => {
    // The build-metrics case: every installer-size subtest is silent and its
    // parent carries the 100 KB.
    expect(resolveAlertThreshold(null, parent)).toBe(parent);
  });

  it('falls back to perfherder’s global default when neither says anything', () => {
    expect(resolveAlertThreshold(null, null)).toBe(DEFAULT_ALERT_THRESHOLD);
  });
});

describe('thresholdParentRef', () => {
  const ref: SeriesRef = { repository: 'autoland', signatureId: 1668132, frameworkId: 2 };

  it('points a subtest at its parent, keeping repo and framework', () => {
    const meta = metaFromSummary(
      summary([], { signature_id: 1668132, parent_signature: 1457010, has_subtests: false }),
    );
    expect(thresholdParentRef(ref, meta)).toEqual({
      repository: 'autoland',
      signatureId: 1457010,
      frameworkId: 2,
    });
  });

  it('has nobody to ask for a parent or a standalone signature', () => {
    // `parentSignatureId` reports a parent's *own* id, which would otherwise send
    // the lookup back round to the signature we already have.
    const parent = metaFromSummary(
      summary([], { signature_id: 1668132, has_subtests: true, parent_signature: null }),
    );
    expect(thresholdParentRef(ref, parent)).toBeNull();
    const alone = metaFromSummary(summary([], { has_subtests: false, parent_signature: null }));
    expect(thresholdParentRef(ref, alone)).toBeNull();
  });
});

describe('seriesKey', () => {
  it('is scoped by repo, since signature ids are per-repo rows', () => {
    // Through a `SeriesRef`, because the framework id is deliberately not part
    // of the key — `seriesKey` takes the two fields it reads, so a caller
    // holding a `SelectedPoint` can pass that instead.
    const ref: SeriesRef = { repository: 'autoland', signatureId: 1, frameworkId: 1 };
    expect(seriesKey(ref)).toBe('autoland|1');
  });
});
