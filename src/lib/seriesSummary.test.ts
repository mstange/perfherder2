import { describe, expect, it } from 'vitest';
import { placeholderMeta, type SeriesMeta, type SeriesRef } from './graphData';
import {
  attrChips,
  attrsForEntry,
  attrsFromMeta,
  commonAttrs,
  commonFilterChips,
  isEmptyAttrs,
  NO_ATTRS,
  splitCommonAttrs,
  splitOptions,
  type SeriesAttrs,
} from './seriesSummary';

function attrs(o: Partial<SeriesAttrs>): SeriesAttrs {
  return {
    repo: 'mozilla-central',
    suite: 'speedometer3',
    test: '',
    platform: 'macosx1500-aarch64-shippable',
    application: 'firefox',
    options: ['opt'],
    ...o,
  };
}

describe('splitOptions', () => {
  it('splits on whitespace and drops empties', () => {
    expect(splitOptions('opt fission webrender')).toEqual(['opt', 'fission', 'webrender']);
    // `optionsFromName` trims, but a double space inside the server's string
    // would otherwise produce an empty token.
    expect(splitOptions('opt  cold ')).toEqual(['opt', 'cold']);
    expect(splitOptions('')).toEqual([]);
  });
});

describe('attrsFromMeta', () => {
  const ref: SeriesRef = { repository: 'autoland', signatureId: 5259007, frameworkId: 13 };

  it('takes the repository from the ref and splits the options', () => {
    const meta: SeriesMeta = {
      suite: 'bing-search',
      test: 'ContentfulSpeedIndex',
      platform: 'windows11-64-24h2-shippable',
      application: 'firefox',
      measurementUnit: 'ms',
      lowerIsBetter: true,
      name: 'bing-search ContentfulSpeedIndex opt cold fission webrender',
      options: 'opt cold fission webrender',
      placeholder: false,
    };
    expect(attrsFromMeta(ref, meta)).toEqual({
      repo: 'autoland',
      suite: 'bing-search',
      test: 'ContentfulSpeedIndex',
      platform: 'windows11-64-24h2-shippable',
      application: 'firefox',
      options: ['opt', 'cold', 'fission', 'webrender'],
    });
  });

  it('has no attributes for an unloaded series or a placeholder', () => {
    expect(attrsForEntry(ref, null)).toBeNull();
    // Everything in a placeholder is either empty or synthesized — filtering
    // on "signature 5259007" as a suite name would match nothing.
    expect(attrsForEntry(ref, placeholderMeta(ref))).toBeNull();
  });
});

describe('splitCommonAttrs', () => {
  it('hoists nothing for a single series', () => {
    const one = attrs({});
    const split = splitCommonAttrs([one]);
    expect(split.hasCommon).toBe(false);
    expect(split.common).toEqual(NO_ATTRS);
    expect(split.distinct).toEqual([one]);
  });

  it('hoists nothing for an empty list', () => {
    expect(splitCommonAttrs([])).toEqual({ common: NO_ATTRS, distinct: [], hasCommon: false });
  });

  // The four-browser speedometer3 case: everything is shared but `application`.
  it('leaves only the differing scalar field in each card', () => {
    const split = splitCommonAttrs([
      attrs({ application: 'chrome' }),
      attrs({ application: 'safari' }),
      attrs({ application: 'custom-car' }),
    ]);
    expect(split.hasCommon).toBe(true);
    expect(split.common).toEqual({
      repo: 'mozilla-central',
      suite: 'speedometer3',
      test: '',
      platform: 'macosx1500-aarch64-shippable',
      application: '',
      options: ['opt'],
    });
    expect(split.distinct.map((d) => d && attrChips(d))).toEqual([
      [{ field: 'application', value: 'chrome' }],
      [{ field: 'application', value: 'safari' }],
      [{ field: 'application', value: 'custom-car' }],
    ]);
  });

  // The bing-search case: two repos, and option sets that overlap partially.
  it('intersects options token by token', () => {
    const base = {
      suite: 'bing-search',
      test: 'ContentfulSpeedIndex',
      platform: 'windows11-64-24h2-shippable',
    };
    const split = splitCommonAttrs([
      attrs({ ...base, repo: 'autoland', options: ['opt', 'cold', 'fission', 'webrender'] }),
      attrs({ ...base, repo: 'autoland', options: ['opt', 'fission', 'warm', 'webrender'] }),
      attrs({
        ...base,
        repo: 'mozilla-central',
        options: ['opt', 'bytecode-cached', 'cold', 'fission', 'webrender'],
      }),
    ]);
    expect(split.common.options).toEqual(['opt', 'fission', 'webrender']);
    expect(split.common.repo).toBe('');
    expect(split.common.suite).toBe('bing-search');
    expect(split.distinct.map((d) => d?.options)).toEqual([
      ['cold'],
      ['warm'],
      ['bytecode-cached', 'cold'],
    ]);
    // The differing repo stays on the cards, and leads their chip order.
    expect(split.distinct[2] && attrChips(split.distinct[2])).toEqual([
      { field: 'repo', value: 'mozilla-central' },
      { field: 'option', value: 'bytecode-cached' },
      { field: 'option', value: 'cold' },
    ]);
  });

  it('preserves the first series’ option order in the common set', () => {
    const split = splitCommonAttrs([
      attrs({ options: ['opt', 'fission', 'webrender'] }),
      attrs({ options: ['webrender', 'fission', 'opt'] }),
    ]);
    expect(split.common.options).toEqual(['opt', 'fission', 'webrender']);
  });

  it('treats an attribute every series lacks as shared and absent', () => {
    const split = splitCommonAttrs([
      attrs({ application: '', options: [] }),
      attrs({ application: '', options: [], platform: 'linux2404-64-shippable' }),
    ]);
    expect(split.common.application).toBe('');
    expect(split.common.options).toEqual([]);
    // …and it doesn't reappear in the cards.
    expect(split.distinct.map((d) => d && attrChips(d))).toEqual([
      [{ field: 'platform', value: 'macosx1500-aarch64-shippable' }],
      [{ field: 'platform', value: 'linux2404-64-shippable' }],
    ]);
  });

  it('can leave a card with nothing to show', () => {
    // Two signatures identical in every displayed attribute. Rare, but the
    // list has to render something for them.
    const split = splitCommonAttrs([attrs({}), attrs({})]);
    expect(split.distinct.every((d) => d && isEmptyAttrs(d))).toBe(true);
  });

  it('ignores series whose metadata has not arrived', () => {
    const split = splitCommonAttrs([
      attrs({ application: 'chrome' }),
      null,
      attrs({ application: 'safari' }),
    ]);
    // The unloaded series neither contributes to nor collapses the header.
    expect(split.common.suite).toBe('speedometer3');
    expect(split.distinct[1]).toBeNull();
  });

  it('needs two loaded series before it hoists anything', () => {
    const split = splitCommonAttrs([attrs({}), null]);
    expect(split.hasCommon).toBe(false);
    expect(split.distinct[0]).toEqual(attrs({}));
  });
});

describe('commonAttrs', () => {
  // The difference from splitCommonAttrs: no "fewer than two has no common
  // set" rule. The picker prefill wants one series' attributes as-is.
  it('is a single series’ own attributes', () => {
    expect(commonAttrs([attrs({})])).toEqual(attrs({}));
    expect(splitCommonAttrs([attrs({})]).common).toEqual(NO_ATTRS);
  });

  it('is empty for no series', () => {
    expect(commonAttrs([])).toEqual(NO_ATTRS);
    expect(commonAttrs([null])).toEqual(NO_ATTRS);
  });
});

describe('commonFilterChips', () => {
  it('turns shared attributes into lowercase chips', () => {
    expect(
      commonFilterChips(
        attrs({ suite: 'Speedometer3', test: 'FCP', application: 'Custom-CAR', options: ['opt'] }),
      ),
    ).toEqual([
      { field: 'suite', value: 'speedometer3' },
      { field: 'test', value: 'fcp' },
      { field: 'platform', value: 'macosx1500-aarch64-shippable' },
      { field: 'application', value: 'custom-car' },
      { field: 'option', value: 'opt' },
    ]);
  });

  it('never emits a repo chip', () => {
    // The picker filters by repository through its checkbox row, which is also
    // what decides whether the rows are fetched at all.
    expect(commonFilterChips(attrs({})).some((c) => c.field === 'repo')).toBe(false);
  });

  it('emits one chip per shared option and skips absent attributes', () => {
    expect(
      commonFilterChips({ ...NO_ATTRS, suite: 'raptor', options: ['opt', 'cold'] }),
    ).toEqual([
      { field: 'suite', value: 'raptor' },
      { field: 'option', value: 'opt' },
      { field: 'option', value: 'cold' },
    ]);
  });

  it('is empty when the series share nothing', () => {
    expect(commonFilterChips(NO_ATTRS)).toEqual([]);
  });
});

describe('attrChips', () => {
  it('orders repo, suite, test, application, options, platform', () => {
    expect(attrChips(attrs({ test: 'Speedometer3' })).map((c) => c.field)).toEqual([
      'repo',
      'suite',
      'test',
      'application',
      'option',
      'platform',
    ]);
  });

  it('is empty for empty attributes', () => {
    expect(attrChips(NO_ATTRS)).toEqual([]);
  });
});
