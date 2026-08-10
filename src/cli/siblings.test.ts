import { describe, expect, it } from 'vitest';
import type { Series } from '../lib/picker/series';
import { expandAcross, siblingsAcross } from './siblings';

function row(overrides: Partial<Series>): Series {
  const base: Series = {
    id: 1,
    repository: 'autoland',
    framework: 'browsertime',
    frameworkId: 13,
    platform: 'linux2404-64-shippable',
    suite: 'speedometer3',
    test: 'Charts-chartjs/total',
    application: 'firefox',
    options: ['opt', 'fission', 'webrender'],
    extraOptions: [],
    measurementUnit: 'ms',
    hasSubtests: false,
    isSubtest: true,
    parentSignature: 'parenthash',
    signatureHash: 'hash',
    key: 'autoland|1',
    parentKey: 'autoland|100',
    searchText: '',
  };
  const merged = { ...base, ...overrides };
  return { ...merged, key: `${merged.repository}|${merged.id}` };
}

// The same subtest on three platforms, plus the traps: a nova variant of the
// same row, a different subtest, and a different application.
const ROWS = [
  row({ id: 1, platform: 'linux2404-64-shippable' }),
  row({ id: 2, platform: 'macosx1470-64-shippable' }),
  row({ id: 3, platform: 'windows11-64-24h2-shippable' }),
  row({ id: 4, platform: 'macosx1470-64-shippable', options: ['opt', 'fission', 'nova', 'webrender'] }),
  row({ id: 5, platform: 'macosx1470-64-shippable', test: 'Editor-TipTap/total' }),
  row({ id: 6, platform: 'android-hw-a55', application: 'fenix', options: ['opt', 'webrender'] }),
  row({ id: 7, repository: 'mozilla-central', platform: 'macosx1470-64-shippable' }),
];

const anchor = { repository: 'autoland', signatureId: 1 };

describe('siblingsAcross', () => {
  it('varies one attribute and holds every other one fixed', () => {
    const set = siblingsAcross(ROWS, anchor, ['platform']);
    expect(set.rows.map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('keeps a nova variant out — that is the mistake it exists to prevent', () => {
    // Doing this by hand in a live trial swept the variants of a suite into one
    // table beside each other. The option set is part of what makes a row the
    // same measurement.
    const set = siblingsAcross(ROWS, anchor, ['platform']);
    expect(set.rows.some((r) => r.id === 4)).toBe(false);
    expect(set.omitted).toContainEqual({ differs: 'option', rows: 1 });
  });

  it('counts what it held out rather than dropping it silently', () => {
    const set = siblingsAcross(ROWS, anchor, ['platform']);
    // The other repository, and the differently-configured Fenix row. The other
    // subtest is not counted: it is a different measurement, not a near miss.
    expect(set.omitted).toContainEqual({ differs: 'repo', rows: 1 });
    expect(set.omitted).toContainEqual({ differs: 'application + option', rows: 1 });
    expect(set.omitted.reduce((n, o) => n + o.rows, 0)).toBe(3);
  });

  it('varies two attributes at once, which is the browser comparison', () => {
    // Chrome runs on neither the same platform nor the same options as Fenix,
    // so one field cannot express "Firefox against Chrome".
    const set = siblingsAcross(ROWS, anchor, ['platform', 'application', 'option']);
    // Ordered by the varying fields in the order they were named: platform
    // first, so the two macOS rows sit together.
    expect(set.rows.map((r) => r.id)).toEqual([6, 1, 4, 2, 3]);
  });

  it('reaches the other repository only when asked to', () => {
    expect(siblingsAcross(ROWS, anchor, ['repo']).rows.map((r) => r.id)).toEqual([1]);
    const withPlatform = siblingsAcross(ROWS, anchor, ['repo', 'platform']);
    expect(withPlatform.rows.map((r) => r.id)).toEqual([1, 2, 3, 7]);
  });

  it('says an anchor is absent rather than that it has no counterparts', () => {
    const set = siblingsAcross(ROWS, { repository: 'autoland', signatureId: 999 }, ['platform']);
    expect(set.anchor).toBeNull();
    expect(set.rows).toEqual([]);
  });
});

describe('expandAcross', () => {
  it('merges several anchors without repeating a row', () => {
    const expansion = expandAcross(
      ROWS,
      [anchor, { repository: 'autoland', signatureId: 2 }],
      ['platform'],
    );
    expect(expansion.rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(expansion.missing).toEqual([]);
  });

  it('names an anchor it could not find and carries on with the rest', () => {
    const expansion = expandAcross(
      ROWS,
      [anchor, { repository: 'autoland', signatureId: 999 }],
      ['platform'],
    );
    expect(expansion.rows).toHaveLength(3);
    expect(expansion.missing).toEqual(['autoland,999']);
  });
});
