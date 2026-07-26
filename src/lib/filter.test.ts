import { describe, expect, it } from 'vitest';
import type { Series } from './api';
import {
  cacheKey,
  groupChildrenByParent,
  matchesRow,
  pickCachedForRepo,
  tokenizeFilter,
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

describe('tokenizeFilter', () => {
  it('splits on whitespace, lowercases, drops empties', () => {
    expect(tokenizeFilter('  Foo   Bar  ')).toEqual(['foo', 'bar']);
  });
  it('returns an empty list for empty input', () => {
    expect(tokenizeFilter('')).toEqual([]);
    expect(tokenizeFilter('   ')).toEqual([]);
  });
});

describe('matchesRow', () => {
  const empty = new Set<string>();

  it('matches when every token is a substring of searchText', () => {
    expect(matchesRow(s(), ['speedometer3', 'fission'], empty)).toBe(true);
  });
  it('rejects when any token is missing', () => {
    expect(matchesRow(s(), ['speedometer3', 'nope'], empty)).toBe(false);
  });
  it('is case-insensitive because searchText is prelowercased and tokens are too', () => {
    // In real use, tokens come from tokenizeFilter(), which lowercases them.
    // Give matchesRow already-lowercased tokens and confirm mixed-case
    // searchText content is still findable via lowercase substrings.
    expect(matchesRow(s(), ['firefox'], empty)).toBe(true);
  });
  it('respects the platform filter set when non-empty', () => {
    expect(matchesRow(s(), [], new Set(['macos']))).toBe(false);
    expect(matchesRow(s(), [], new Set(['linux2404-64']))).toBe(true);
    // Empty platform set means "no platform filter".
    expect(matchesRow(s(), [], empty)).toBe(true);
  });
  it('requires BOTH platform and tokens to pass', () => {
    expect(matchesRow(s(), ['speedometer3'], new Set(['macos']))).toBe(false);
    expect(matchesRow(s(), ['nope'], new Set(['linux2404-64']))).toBe(false);
    expect(matchesRow(s(), ['speedometer3'], new Set(['linux2404-64']))).toBe(true);
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
    // Parents are not their own children.
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

  it('keys are interval-specific — a different interval is a cache miss', () => {
    const cache = new Map<string, Series[]>([
      [cacheKey('autoland', false, interval), noSub],
    ]);
    expect(pickCachedForRepo(cache, 'autoland', 172800)).toBeUndefined();
  });
});
