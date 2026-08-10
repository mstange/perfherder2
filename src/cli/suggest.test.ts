import { describe, expect, it } from 'vitest';
import type { Series } from '../lib/picker/series';
import { diagnoseNoMatch, fuzzyMatch } from './suggest';

// The same shape `toSeries` produces, including its composed haystack — a
// fixture whose searchText doesn't contain its own names would let a free-text
// diagnosis pass here and fail on real rows.
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
    searchText: '',
  };
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    key: `${merged.repository}|${merged.id}`,
    searchText: [
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

const ROWS = [
  row({ id: 1, suite: 'idb-open-many-seq', test: 'open_duration', platform: 'windows11-64-24h2-shippable' }),
  row({ id: 2, suite: 'idb-open-many-seq', test: 'delete_duration', platform: 'windows11-64-24h2-shippable' }),
  row({ id: 3, suite: 'idb-open-few-par', test: 'open_duration', platform: 'macosx1470-64-shippable' }),
  row({ id: 4, suite: 'speedometer3', test: '', platform: 'android-hw-a55-14-0-aarch64-shippable', application: 'fenix' }),
  row({ id: 5, suite: 'speedometer3', test: '', platform: 'android-em-14-arm64-shippable', application: 'chrome-m' }),
];

describe('fuzzyMatch', () => {
  it('finds an abbreviation nothing else can: idb from indexeddb', () => {
    // The rule this module exists for. Edit distance is 6 on a 9-letter word
    // and no substring relates them, but `idb` is `i`,`d`,`b` in order.
    expect(fuzzyMatch('indexeddb', 'idb')).toMatchObject({ tier: 1 });
  });

  it('ranks a misspelling above the word it is a fragment of', () => {
    const full = fuzzyMatch('speedomter3', 'speedometer3')!;
    const part = fuzzyMatch('speedomter3', 'speed')!;
    expect(full.tier).toBe(part.tier);
    expect(full.similarity).toBeGreaterThan(part.similarity);
  });

  it('refuses a word that merely shares a couple of letters', () => {
    expect(fuzzyMatch('speedomter3', 'dom')).toBeNull();
    expect(fuzzyMatch('indexeddb', 'bdi')).toBeNull();
  });

  it('will not abbreviate to something starting with another letter', () => {
    // `dxb` is a subsequence of `indexeddb`, and suggesting it would be noise.
    expect(fuzzyMatch('indexeddb', 'dxb')).toBeNull();
  });
});

describe('diagnoseNoMatch', () => {
  it('names the term that matched nothing and what the corpus calls it', () => {
    const diagnosis = diagnoseNoMatch(ROWS, { chips: [], text: 'indexeddb' });
    expect(diagnosis.terms).toHaveLength(1);
    expect(diagnosis.terms[0]).toMatchObject({ term: 'indexeddb', alone: 0 });
    expect(diagnosis.terms[0].suggestions[0]).toMatchObject({ term: 'idb', rows: 3 });
  });

  it('counts a suggestion against the search\'s other terms, not on its own', () => {
    const diagnosis = diagnoseNoMatch(ROWS, { chips: [], text: 'indexeddb macosx1470-64-shippable' });
    const culprit = diagnosis.terms.find((t) => t.term === 'indexeddb')!;
    // Three rows are idb rows; one of them is on that platform.
    expect(culprit.suggestions[0]).toMatchObject({ term: 'idb', rows: 1 });
  });

  it('tells an over-constrained search from a wrong word', () => {
    const diagnosis = diagnoseNoMatch(ROWS, { chips: [], text: 'idb speedometer3' });
    expect(diagnosis.terms.every((t) => t.alone > 0)).toBe(true);
    // Drop "idb" and the two speedometer3 rows come back; drop "speedometer3"
    // and the three idb rows do.
    expect(diagnosis.terms.map((t) => t.without)).toEqual([2, 3]);
  });

  it('answers a chip given a fragment with the whole values that contain it', () => {
    const diagnosis = diagnoseNoMatch(ROWS, {
      chips: [{ field: 'platform', value: 'android' }],
      text: '',
    });
    expect(diagnosis.terms[0].field).toBe('platform');
    expect(diagnosis.terms[0].suggestions.map((s) => s.term)).toEqual([
      'platform:android-em-14-arm64-shippable',
      'platform:android-hw-a55-14-0-aarch64-shippable',
    ]);
  });

  it('never suggests a term that would also match nothing', () => {
    const diagnosis = diagnoseNoMatch(ROWS, {
      chips: [{ field: 'platform', value: 'android' }],
      // Every android row is a speedometer3 row, so a suggestion has to keep
      // this term satisfied or it is no help at all.
      text: 'idb',
    });
    expect(diagnosis.terms.flatMap((t) => t.suggestions)).toEqual([]);
  });
});
