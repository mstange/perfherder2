import { describe, expect, it } from 'vitest';
import type { Series } from './api';
import {
  addChip,
  cacheKey,
  chipMatchesRow,
  chipToString,
  compareRows,
  cycleSort,
  fieldValues,
  groupChildrenByParent,
  hasChip,
  isFilterActive,
  matchesRow,
  matchParentWithChildren,
  parseChip,
  pickCachedForRepo,
  removeChip,
  sortKey,
  toggleChip,
  tokenizeFilter,
  type Filter,
  type FilterChip,
  type SortState,
} from './filter';

// The picker uses `Series.key` / `Series.parentKey` as the compound identity
// across repos. Test fixtures compute them from repository + signatureHash so
// overrides that change either field automatically get consistent keys.
function s(overrides: Partial<Series> = {}): Series {
  const repository = overrides.repository ?? 'autoland';
  const signatureHash = overrides.signatureHash ?? 'hash1';
  const parentSignature = overrides.parentSignature ?? null;
  const base: Series = {
    id: 1,
    repository,
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
    isSubtest: !!parentSignature,
    parentSignature,
    signatureHash,
    key: `${repository}|${signatureHash}`,
    parentKey: parentSignature ? `${repository}|${parentSignature}` : null,
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
  it('groups subtest rows by (repo, parent signature_hash) and skips non-subtests', () => {
    const parent1 = s({ signatureHash: 'P1', hasSubtests: true });
    const parent2 = s({ signatureHash: 'P2', hasSubtests: true });
    const c1 = s({ id: 10, isSubtest: true, parentSignature: 'P1', signatureHash: 'C1' });
    const c2 = s({ id: 11, isSubtest: true, parentSignature: 'P1', signatureHash: 'C2' });
    const c3 = s({ id: 12, isSubtest: true, parentSignature: 'P2', signatureHash: 'C3' });

    const grouped = groupChildrenByParent([parent1, c1, c2, parent2, c3]);

    expect(grouped.get('autoland|P1')?.map((r) => r.id)).toEqual([10, 11]);
    expect(grouped.get('autoland|P2')?.map((r) => r.id)).toEqual([12]);
    expect(grouped.has('autoland|C1')).toBe(false);
  });

  it('keeps children from different repos in separate buckets even when the parent signature_hash is shared', () => {
    // The same test has the same signature_hash across repos — keying by
    // hash alone would let autoland children get attached to a
    // mozilla-central parent (and vice versa), which then survives filters
    // it shouldn't.
    const autoKid = s({
      id: 10,
      repository: 'autoland',
      isSubtest: true,
      parentSignature: 'HASH',
      signatureHash: 'CA',
    });
    const mcKid = s({
      id: 11,
      repository: 'mozilla-central',
      isSubtest: true,
      parentSignature: 'HASH',
      signatureHash: 'CM',
    });
    const grouped = groupChildrenByParent([autoKid, mcKid]);
    expect(grouped.get('autoland|HASH')?.map((r) => r.id)).toEqual([10]);
    expect(grouped.get('mozilla-central|HASH')?.map((r) => r.id)).toEqual([11]);
  });

  it('returns an empty map when there are no subtests', () => {
    expect(groupChildrenByParent([s()]).size).toBe(0);
  });
});

describe('isFilterActive', () => {
  it('is false for the empty filter', () => {
    expect(isFilterActive(empty)).toBe(false);
  });
  it('is false for whitespace-only text', () => {
    expect(isFilterActive({ chips: [], text: '   ' })).toBe(false);
  });
  it('is true when text is non-empty', () => {
    expect(isFilterActive({ chips: [], text: 'foo' })).toBe(true);
  });
  it('is true when any chip is present', () => {
    expect(
      isFilterActive({ chips: [{ field: 'repo', value: 'try' }], text: '' }),
    ).toBe(true);
  });
});

describe('matchParentWithChildren', () => {
  // A parent with an empty test field (typical) that has three subtests.
  const parent = s({
    id: 1,
    signatureHash: 'P',
    hasSubtests: true,
    test: '',
    searchText: 'speedometer3 firefox linux2404-64 browsertime autoland opt fission',
  });
  const kidA = s({
    id: 10,
    isSubtest: true,
    parentSignature: 'P',
    signatureHash: 'C10',
    test: 'React-Redux-TodoMVC',
    searchText:
      'speedometer3 react-redux-todomvc firefox linux2404-64 browsertime autoland opt fission',
  });
  const kidB = s({
    id: 11,
    isSubtest: true,
    parentSignature: 'P',
    signatureHash: 'C11',
    test: 'Vanilla-JS-TodoMVC',
    searchText:
      'speedometer3 vanilla-js-todomvc firefox linux2404-64 browsertime autoland opt fission',
  });
  const kidC = s({
    id: 12,
    isSubtest: true,
    parentSignature: 'P',
    signatureHash: 'C12',
    test: 'Angular2-TypeScript-TodoMVC',
    searchText:
      'speedometer3 angular2-typescript-todomvc firefox linux2404-64 browsertime autoland opt fission',
  });

  it('returns parent-only match when only the parent matches', () => {
    const m = matchParentWithChildren(parent, [kidA, kidB, kidC], {
      chips: [{ field: 'suite', value: 'speedometer3' }],
      text: '',
    });
    expect(m?.selfMatched).toBe(true);
    // Children whose suite is speedometer3 also match — they're all speedometer3.
    expect(m?.matchedChildren.map((c) => c.id)).toEqual([10, 11, 12]);
  });

  it('promotes parent via a matching child even when parent itself does not match', () => {
    // A test:react-redux-todomvc chip: parent has empty test → doesn't match;
    // but kidA does. Parent should still be returned, with only kidA as the
    // matched child.
    const m = matchParentWithChildren(parent, [kidA, kidB, kidC], {
      chips: [{ field: 'test', value: 'react-redux-todomvc' }],
      text: '',
    });
    expect(m).not.toBeNull();
    expect(m!.selfMatched).toBe(false);
    expect(m!.matchedChildren.map((c) => c.id)).toEqual([10]);
  });

  it('returns null when neither parent nor any child matches', () => {
    const m = matchParentWithChildren(parent, [kidA, kidB, kidC], {
      chips: [{ field: 'test', value: 'nonexistent' }],
      text: '',
    });
    expect(m).toBeNull();
  });

  it('with no children, degenerates to a self-match check', () => {
    const noKids: Series[] = [];
    expect(
      matchParentWithChildren(parent, noKids, {
        chips: [{ field: 'suite', value: 'speedometer3' }],
        text: '',
      }),
    ).not.toBeNull();
    expect(
      matchParentWithChildren(parent, noKids, {
        chips: [{ field: 'suite', value: 'other' }],
        text: '',
      }),
    ).toBeNull();
  });

  it('with an empty filter (wildcard), returns all children as matches', () => {
    const m = matchParentWithChildren(parent, [kidA, kidB, kidC], empty);
    expect(m?.selfMatched).toBe(true);
    expect(m?.matchedChildren.length).toBe(3);
  });
});

describe('cacheKey', () => {
  it('includes repo, subtests flag, and interval', () => {
    expect(cacheKey('autoland', false, 1209600)).toBe('autoland|0|1209600');
    expect(cacheKey('autoland', true, 1209600)).toBe('autoland|1|1209600');
  });
});

describe('cycleSort', () => {
  it('starts a new column at ascending', () => {
    expect(cycleSort(null, 'suite')).toEqual({ column: 'suite', direction: 'asc' });
  });
  it('cycles asc → desc on the same column', () => {
    expect(cycleSort({ column: 'suite', direction: 'asc' }, 'suite')).toEqual({
      column: 'suite',
      direction: 'desc',
    });
  });
  it('cycles desc → null on the same column', () => {
    expect(cycleSort({ column: 'suite', direction: 'desc' }, 'suite')).toBeNull();
  });
  it('switching columns resets to asc regardless of prior direction', () => {
    expect(cycleSort({ column: 'suite', direction: 'desc' }, 'repo')).toEqual({
      column: 'repo',
      direction: 'asc',
    });
  });
});

describe('sortKey', () => {
  it('combines suite and test for a stable primary key', () => {
    const row = s({ suite: 'speedometer3', test: 'total' });
    // Just check both parts are represented.
    expect(sortKey(row, 'suite')).toContain('speedometer3');
    expect(sortKey(row, 'suite')).toContain('total');
  });
  it('is lowercase so case doesn\'t affect ordering', () => {
    expect(sortKey(s({ suite: 'FOO' }), 'suite')).toBe(sortKey(s({ suite: 'foo' }), 'suite'));
  });
});

describe('compareRows', () => {
  const asc = (col: SortState['column']): SortState => ({ column: col, direction: 'asc' });
  const desc = (col: SortState['column']): SortState => ({ column: col, direction: 'desc' });

  it('returns 0 when there is no sort (preserves order)', () => {
    expect(compareRows(s({ suite: 'a' }), s({ suite: 'z' }), null)).toBe(0);
  });

  it('sorts by suite ascending', () => {
    const rows = [s({ suite: 'zeta' }), s({ suite: 'alpha' }), s({ suite: 'mu' })];
    rows.sort((a, b) => compareRows(a, b, asc('suite')));
    expect(rows.map((r) => r.suite)).toEqual(['alpha', 'mu', 'zeta']);
  });

  it('sorts descending flips the order', () => {
    const rows = [s({ suite: 'alpha' }), s({ suite: 'zeta' })];
    rows.sort((a, b) => compareRows(a, b, desc('suite')));
    expect(rows.map((r) => r.suite)).toEqual(['zeta', 'alpha']);
  });

  it('breaks suite ties with test name', () => {
    const rows = [
      s({ suite: 'speedometer3', test: 'total' }),
      s({ suite: 'speedometer3', test: 'aggregate' }),
    ];
    rows.sort((a, b) => compareRows(a, b, asc('suite')));
    expect(rows.map((r) => r.test)).toEqual(['aggregate', 'total']);
  });

  it('sorts by repo / platform / application / unit', () => {
    const rows = [
      s({ repository: 'try', platform: 'linux', application: 'firefox', measurementUnit: 'ms' }),
      s({ repository: 'autoland', platform: 'macos', application: 'chrome', measurementUnit: 'score' }),
    ];
    for (const col of ['repo', 'platform', 'application', 'unit'] as const) {
      const copy = [...rows].sort((a, b) => compareRows(a, b, asc(col)));
      const first = copy[0];
      // First one should have the alphabetically-smaller value on the column.
      switch (col) {
        case 'repo':
          expect(first.repository).toBe('autoland');
          break;
        case 'platform':
          expect(first.platform).toBe('linux');
          break;
        case 'application':
          expect(first.application).toBe('chrome');
          break;
        case 'unit':
          expect(first.measurementUnit).toBe('ms');
          break;
      }
    }
  });

  it('sorts by joined options string', () => {
    const rows = [
      s({ options: ['opt', 'webrender'] }),
      s({ options: ['debug'] }),
      s({ options: ['opt', 'fission'] }),
    ];
    rows.sort((a, b) => compareRows(a, b, asc('options')));
    expect(rows.map((r) => r.options.join(' '))).toEqual([
      'debug',
      'opt fission',
      'opt webrender',
    ]);
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
