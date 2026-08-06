import { describe, expect, it } from 'vitest';
import { buildOptionMap, type OptionCollection, type RawSignature } from './signaturesApi';
import { toSeries } from './series';
import { seriesKey } from '../graphs/graphData';

const frameworks = new Map<number, string>([
  [1, 'talos'],
  [13, 'browsertime'],
]);

const optionCollections: OptionCollection[] = [
  { option_collection_hash: 'H_OPT', options: [{ name: 'opt' }] },
  { option_collection_hash: 'H_DEBUG', options: [{ name: 'debug' }] },
];
const optionMap = buildOptionMap(optionCollections);

function raw(overrides: Partial<RawSignature> = {}): RawSignature {
  return {
    id: 1,
    signature_hash: 'abc',
    framework_id: 13,
    option_collection_hash: 'H_OPT',
    machine_platform: 'linux2404-64',
    suite: 'speedometer3',
    should_alert: null,
    ...overrides,
  };
}

describe('toSeries', () => {
  it('resolves option_collection_hash + extra_options, deduped', () => {
    const [s] = toSeries(
      { '1': raw({ extra_options: ['opt', 'fission', 'webrender'] }) },
      'autoland',
      frameworks,
      optionMap,
    );
    // 'opt' from the hash and 'opt' from extra_options should be deduped.
    expect(s.options).toEqual(['opt', 'fission', 'webrender']);
    expect(s.extraOptions).toEqual(['opt', 'fission', 'webrender']);
  });

  // The graphs view marks picker rows that are already plotted by looking them
  // up with `seriesKey(ref)`; the picker builds `Series.key` independently in
  // this module. If the two recipes ever drift apart, no row would ever match
  // and the marks would silently vanish.
  it('builds a key the graphs view can look up with seriesKey', () => {
    const [s] = toSeries({ '5259007': raw({ id: 5259007 }) }, 'autoland', frameworks, optionMap);
    expect(s.key).toBe(
      seriesKey({ repository: 'autoland', signatureId: 5259007, frameworkId: 13 }),
    );
  });

  it('resolves framework name from the id', () => {
    const [s] = toSeries({ '1': raw({ framework_id: 1 }) }, 'autoland', frameworks, optionMap);
    expect(s.framework).toBe('talos');
    expect(s.frameworkId).toBe(1);
  });

  it('falls back to a synthetic framework name for unknown ids', () => {
    const [s] = toSeries({ '1': raw({ framework_id: 999 }) }, 'autoland', frameworks, optionMap);
    expect(s.framework).toBe('framework:999');
  });

  it('marks parent rows via has_subtests and child rows via parent_signature', () => {
    const parent = raw({ id: 1, signature_hash: 'P', has_subtests: true });
    const child = raw({ id: 2, signature_hash: 'C', parent_signature: 'P', test: 'sub' });
    const [p, c] = toSeries({ '1': parent, '2': child }, 'autoland', frameworks, optionMap);
    expect(p.hasSubtests).toBe(true);
    expect(p.isSubtest).toBe(false);
    expect(p.parentSignature).toBeNull();
    expect(c.hasSubtests).toBe(false);
    expect(c.isSubtest).toBe(true);
    expect(c.parentSignature).toBe('P');
  });

  it('handles missing/optional fields without throwing', () => {
    const [s] = toSeries(
      { '1': raw({ test: undefined, application: undefined, extra_options: undefined, measurement_unit: undefined }) },
      'autoland',
      frameworks,
      optionMap,
    );
    expect(s.test).toBe('');
    expect(s.application).toBe('');
    expect(s.measurementUnit).toBe('');
  });

  it('builds a lowercase searchText that covers every filterable dimension', () => {
    const [s] = toSeries(
      {
        '1': raw({
          suite: 'Speedometer3',
          test: 'MicroBench',
          application: 'Firefox',
          machine_platform: 'Linux2404-64',
          extra_options: ['Fission', 'WebRender'],
        }),
      },
      'Autoland',
      frameworks,
      optionMap,
    );
    for (const token of [
      'speedometer3',
      'microbench',
      'firefox',
      'linux2404-64',
      'browsertime',
      'autoland',
      'fission',
      'webrender',
      'opt',
    ]) {
      expect(s.searchText.includes(token), `expected searchText to contain ${token}`).toBe(true);
    }
    // searchText itself must be lowercase.
    expect(s.searchText).toBe(s.searchText.toLowerCase());
  });

  it('coerces the object key into a numeric id', () => {
    const [s] = toSeries({ '42': raw() }, 'autoland', frameworks, optionMap);
    expect(s.id).toBe(42);
  });

  it('composes `key` = `${repository}|${id}` and null parentKey for parents', () => {
    const [s] = toSeries(
      { '7': raw({ signature_hash: 'HASH' }) },
      'autoland',
      frameworks,
      optionMap,
    );
    expect(s.key).toBe('autoland|7');
    expect(s.parentKey).toBeNull();
  });

  it('composes `parentKey` by looking up the parent id from (parent_signature, application)', () => {
    const [parent, child] = toSeries(
      {
        '10': raw({
          id: 10,
          signature_hash: 'PHASH',
          application: 'firefox',
          has_subtests: true,
        }),
        '11': raw({
          id: 11,
          signature_hash: 'CHASH',
          parent_signature: 'PHASH',
          application: 'firefox',
          test: 'sub',
        }),
      },
      'autoland',
      frameworks,
      optionMap,
    );
    expect(parent.key).toBe('autoland|10');
    expect(child.key).toBe('autoland|11');
    expect(child.parentKey).toBe('autoland|10');
  });

  // Perfherder's signature_hash is not unique within a repo: two parents that
  // differ only by application (custom-car vs chrome for the same suite)
  // share it, and their subtests share hashes too. Grouping children by the
  // raw hash would put every child under both parents. `parentKey` must
  // therefore point at the specific parent's id.
  it('disambiguates parents that share a signature_hash by application', () => {
    const [pCar, pChrome, cCar, cChrome] = toSeries(
      {
        '100': raw({ id: 100, signature_hash: 'P', application: 'custom-car', has_subtests: true }),
        '101': raw({ id: 101, signature_hash: 'P', application: 'chrome', has_subtests: true }),
        '200': raw({ id: 200, signature_hash: 'C', parent_signature: 'P', application: 'custom-car', test: 'sub' }),
        '201': raw({ id: 201, signature_hash: 'C', parent_signature: 'P', application: 'chrome', test: 'sub' }),
      },
      'autoland',
      frameworks,
      optionMap,
    );
    // Parents have distinct keys even though their signature_hash collides.
    expect(pCar.key).toBe('autoland|100');
    expect(pChrome.key).toBe('autoland|101');
    // Each child points at the parent that shares its application.
    expect(cCar.parentKey).toBe('autoland|100');
    expect(cChrome.parentKey).toBe('autoland|101');
  });
});
