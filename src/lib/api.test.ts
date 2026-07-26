import { describe, expect, it } from 'vitest';
import {
  buildOptionMap,
  toSeries,
  type OptionCollection,
  type RawSignature,
} from './api';

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
    ...overrides,
  };
}

describe('buildOptionMap', () => {
  it('maps hashes to option name lists', () => {
    expect(optionMap.get('H_OPT')).toEqual(['opt']);
    expect(optionMap.get('H_DEBUG')).toEqual(['debug']);
    expect(optionMap.get('unknown')).toBeUndefined();
  });
});

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
      { '1': raw({ test: undefined, application: undefined, extra_options: undefined, tags: undefined, measurement_unit: undefined }) },
      'autoland',
      frameworks,
      optionMap,
    );
    expect(s.test).toBe('');
    expect(s.application).toBe('');
    expect(s.tags).toEqual([]);
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
          tags: ['Fission'],
          extra_options: ['WebRender'],
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
});
