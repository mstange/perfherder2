import { describe, expect, it } from 'vitest';
import type { Series } from './api';
import {
  addChip,
  cacheKey,
  chipMatchesRow,
  chipToString,
  fieldValues,
  groupChildrenByParent,
  hasChip,
  matchesRow,
  parseChip,
  pickCachedForRepo,
  removeChip,
  toggleChip,
  tokenizeFilter,
  type Filter,
  type FilterChip,
} from './filter';

function s(overrides: Partial<Series> = {}): Series {
  const base: Series = {
    id: 1,
    repository: 'autoland',
    framework: 'browsertime',
    frameworkId: 13,
    platform: 'linux2404-64',
    suite: 'speedometer3',
    test: '',
    application: 'firefox',
    options: ['opt', 'fission'],
    extraOptions: ['fission'],
    tags: ['fission'],
    measurementUnit: 'score',
    hasSubtests: false,
    isSubtest: false,
    parentSignature: null,
    signatureHash: 'hash1',
    searchText: 'speedometer3 firefox linux2404-64 browsertime autoland opt fission',
  };
  return { ...base, ...overrides };
}

const empty: Filter = { chips: [], text: '' };

describe('tokenizeFilter', () => {
  it('splits on whitespace, lowercases, drops empties', () => {
    expect(tokenizeFilter('  Foo   Bar  ')).toEqual(['foo', 'bar']);
  });
});

describe('parseChip', () => {
  it('parses "field:value"', () => {
    expect(parseChip('repo:autoland')).toEqual({ field: 'repo', value: 'autoland' });
  });
  it('lowercases the value', () => {
    expect(parseChip('application:Chrome')).toEqual({
      field: 'application',
      value: 'chrome',
    });
  });
  it('rejects unknown fields', () => {
    expect(parseChip('framework:talos')).toBeNull();
  });
  it('rejects missing value or colon', () => {
    expect(parseChip('repo:')).toBeNull();
    expect(parseChip(':autoland')).toBeNull();
    expect(parseChip('autoland')).toBeNull();
  });
});

describe('chipToString', () => {
  it('round-trips through parseChip', () => {
    const c: FilterChip = { field: 'repo', value: 'autoland' };
    expect(parseChip(chipToString(c))).toEqual(c);
  });
});

describe('chipMatchesRow', () => {
  it('matches on repo exactly', () => {
    expect(chipMatchesRow(s(), { field: 'repo', value: 'autoland' })).toBe(true);
    expect(chipMatchesRow(s(), { field: 'repo', value: 'mozilla-central' })).toBe(
      false,
    );
  });
  it('matches on platform exactly (not by substring)', () => {
    expect(chipMatchesRow(s(), { field: 'platform', value: 'linux2404-64' })).toBe(
      true,
    );
    // Substring should NOT match, unlike free-text.
    expect(chipMatchesRow(s(), { field: 'platform', value: 'linux' })).toBe(false);
  });
  it('matches option/tag membership', () => {
    expect(chipMatchesRow(s(), { field: 'option', value: 'fission' })).toBe(true);
    expect(chipMatchesRow(s(), { field: 'option', value: 'nova' })).toBe(false);
    expect(chipMatchesRow(s(), { field: 'tag', value: 'fission' })).toBe(true);
  });
  it('is case-insensitive because chip values are pre-lowercased', () => {
    expect(chipMatchesRow(s({ application: 'Firefox' }), {
      field: 'application',
      value: 'firefox',
    })).toBe(true);
  });
});

describe('matchesRow (structured filter)', () => {
  it('accepts the empty filter as a wildcard', () => {
    expect(matchesRow(s(), empty)).toBe(true);
  });

  it('ANDs across different chip fields', () => {
    const filter: Filter = {
      chips: [
        { field: 'repo', value: 'autoland' },
        { field: 'application', value: 'firefox' },
      ],
      text: '',
    };
    expect(matchesRow(s(), filter)).toBe(true);
    expect(matchesRow(s({ application: 'chrome' }), filter)).toBe(false);
  });

  it('ORs within a single chip field (multiple repo chips)', () => {
    const filter: Filter = {
      chips: [
        { field: 'repo', value: 'autoland' },
        { field: 'repo', value: 'mozilla-central' },
      ],
      text: '',
    };
    expect(matchesRow(s({ repository: 'autoland' }), filter)).toBe(true);
    expect(matchesRow(s({ repository: 'mozilla-central' }), filter)).toBe(true);
    expect(matchesRow(s({ repository: 'try' }), filter)).toBe(false);
  });

  it('applies free text tokens as substring AND-matches', () => {
    expect(
      matchesRow(s(), { chips: [], text: 'speedometer3 fission' }),
    ).toBe(true);
    expect(matchesRow(s(), { chips: [], text: 'speedometer3 nope' })).toBe(false);
  });

  it('combines chips with free text', () => {
    const filter: Filter = {
      chips: [{ field: 'application', value: 'firefox' }],
      text: 'speedometer3',
    };
    expect(matchesRow(s(), filter)).toBe(true);
    expect(matchesRow(s({ application: 'chrome' }), filter)).toBe(false);
    expect(
      matchesRow(s({ searchText: 'other content' }), filter),
    ).toBe(false);
  });
});

describe('chip mutations (add/remove/toggle/hasChip)', () => {
  const c1: FilterChip = { field: 'repo', value: 'autoland' };
  const c2: FilterChip = { field: 'application', value: 'firefox' };

  it('addChip appends and dedupes', () => {
    const a = addChip(empty, c1);
    expect(a.chips).toEqual([c1]);
    const b = addChip(a, c1);
    expect(b.chips).toEqual([c1]);
    expect(b).toBe(a); // same reference when it's a no-op
    const c = addChip(a, c2);
    expect(c.chips).toEqual([c1, c2]);
  });
  it('removeChip removes only exact matches', () => {
    const f = { chips: [c1, c2], text: '' };
    expect(removeChip(f, c1).chips).toEqual([c2]);
    expect(removeChip(f, { field: 'repo', value: 'try' }).chips).toEqual([c1, c2]);
  });
  it('toggleChip adds when missing and removes when present', () => {
    const a = toggleChip(empty, c1);
    expect(a.chips).toEqual([c1]);
    const b = toggleChip(a, c1);
    expect(b.chips).toEqual([]);
  });
  it('hasChip', () => {
    expect(hasChip({ chips: [c1], text: '' }, c1)).toBe(true);
    expect(hasChip({ chips: [c1], text: '' }, c2)).toBe(false);
  });
});

describe('fieldValues', () => {
  it('returns comparable strings per field', () => {
    const row = s({
      test: 'sub',
      application: 'firefox',
      options: ['opt', 'fission'],
      tags: ['fission'],
    });
    expect(fieldValues(row, 'repo')).toEqual(['autoland']);
    expect(fieldValues(row, 'suite')).toEqual(['speedometer3']);
    expect(fieldValues(row, 'test')).toEqual(['sub']);
    expect(fieldValues(row, 'application')).toEqual(['firefox']);
    expect(fieldValues(row, 'platform')).toEqual(['linux2404-64']);
    expect(fieldValues(row, 'option')).toEqual(['opt', 'fission']);
    expect(fieldValues(row, 'tag')).toEqual(['fission']);
  });
  it('returns empty array for missing test / application', () => {
    expect(fieldValues(s({ test: '' }), 'test')).toEqual([]);
    expect(fieldValues(s({ application: '' }), 'application')).toEqual([]);
  });
});

describe('groupChildrenByParent', () => {
  it('groups subtest rows by parent signature_hash and skips non-subtests', () => {
    const parent1 = s({ signatureHash: 'P1', hasSubtests: true });
    const parent2 = s({ signatureHash: 'P2', hasSubtests: true });
    const c1 = s({ id: 10, isSubtest: true, parentSignature: 'P1', signatureHash: 'C1' });
    const c2 = s({ id: 11, isSubtest: true, parentSignature: 'P1', signatureHash: 'C2' });
    const c3 = s({ id: 12, isSubtest: true, parentSignature: 'P2', signatureHash: 'C3' });

    const grouped = groupChildrenByParent([parent1, c1, c2, parent2, c3]);

    expect(grouped.get('P1')?.map((r) => r.id)).toEqual([10, 11]);
    expect(grouped.get('P2')?.map((r) => r.id)).toEqual([12]);
    expect(grouped.has('C1')).toBe(false);
  });
  it('returns an empty map when there are no subtests', () => {
    expect(groupChildrenByParent([s()]).size).toBe(0);
  });
});

describe('cacheKey', () => {
  it('includes repo, subtests flag, and interval', () => {
    expect(cacheKey('autoland', false, 1209600)).toBe('autoland|0|1209600');
    expect(cacheKey('autoland', true, 1209600)).toBe('autoland|1|1209600');
  });
});

describe('pickCachedForRepo', () => {
  const interval = 1209600;
  const noSub = [s({ id: 100, signatureHash: 'A', hasSubtests: true })];
  const withSub = [
    s({ id: 100, signatureHash: 'A', hasSubtests: true }),
    s({ id: 200, isSubtest: true, parentSignature: 'A', signatureHash: 'B' }),
  ];

  it('prefers the subtests=1 cache when available', () => {
    const cache = new Map<string, Series[]>([
      [cacheKey('autoland', true, interval), withSub],
      [cacheKey('autoland', false, interval), noSub],
    ]);
    expect(pickCachedForRepo(cache, 'autoland', interval)).toBe(withSub);
  });

  it('falls back to subtests=0 when subtests=1 is missing', () => {
    const cache = new Map<string, Series[]>([
      [cacheKey('autoland', false, interval), noSub],
    ]);
    expect(pickCachedForRepo(cache, 'autoland', interval)).toBe(noSub);
  });

  it('returns undefined when neither variant is cached', () => {
    expect(pickCachedForRepo(new Map(), 'autoland', interval)).toBeUndefined();
  });

  it('keys are interval-specific', () => {
    const cache = new Map<string, Series[]>([
      [cacheKey('autoland', false, interval), noSub],
    ]);
    expect(pickCachedForRepo(cache, 'autoland', 172800)).toBeUndefined();
  });
});
