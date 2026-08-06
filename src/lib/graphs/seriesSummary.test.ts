import { describe, expect, it } from 'vitest';
import { placeholderMeta, type SeriesMeta, type SeriesRef } from './graphData';
import {
  attrChips,
  attrsForEntry,
  attrsFromMeta,
  commonAttrs,
  commonFilterChips,
  commonMeasurement,
  documentTitle,
  isEmptyAttrs,
  measurementForEntry,
  measurementParts,
  NO_ATTRS,
  NO_MEASUREMENT,
  splitCommonAttrs,
  splitOptions,
  type Measurement,
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
      parentSignatureId: 5152393,
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
  // One series has nothing to intersect with, so the split is by role: the
  // header takes the details, the card keeps the name. Without that, the card
  // would either repeat everything or go blank.
  it('hoists everything but the name for a single series', () => {
    const split = splitCommonAttrs([attrs({ test: 'ContentfulSpeedIndex' })]);
    expect(split.mode).toBe('single');
    expect(split.hasCommon).toBe(true);
    expect(split.common).toEqual(attrs({ suite: '', test: '' }));
    expect(split.distinct).toEqual([
      { ...NO_ATTRS, suite: 'speedometer3', test: 'ContentfulSpeedIndex' },
    ]);
  });

  it('keeps a summary series identifiable when it has no subtest name', () => {
    // `test` is '' for a suite-level series, so the card is carried by `suite`
    // alone — which is exactly what the graph in the wild looks like.
    const split = splitCommonAttrs([attrs({ test: '' })]);
    expect(split.distinct).toEqual([{ ...NO_ATTRS, suite: 'speedometer3', test: '' }]);
    expect(isEmptyAttrs(split.distinct[0]!)).toBe(false);
  });

  it('hoists nothing for a single series with no metadata yet', () => {
    const split = splitCommonAttrs([null]);
    expect(split.hasCommon).toBe(false);
    expect(split.mode).toBe('single');
  });

  it('hoists nothing for an empty list', () => {
    expect(splitCommonAttrs([])).toEqual({
      common: NO_ATTRS,
      distinct: [],
      hasCommon: false,
      mode: 'multi',
    });
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

  // The twinopen case: signature 5304038 against 5926558, identical but for
  // the extra `no-nova` option on the second. The first series has nothing left
  // over, because what distinguishes it is an option it *lacks*.
  it('names a card whose options are exactly the shared set', () => {
    const base = { suite: 'twinopen', test: 'ext+twinopen:twinopen.html' };
    const shared = ['opt', 'e10s', 'fission', 'stylo', 'webrender'];
    const split = splitCommonAttrs([
      attrs({ ...base, options: shared }),
      attrs({ ...base, options: [...shared, 'no-nova'] }),
    ]);
    expect(split.common.options).toEqual(shared);
    // Not empty, so the card doesn't print "signature 5304038" and read as a
    // series whose metadata never arrived.
    expect(isEmptyAttrs(split.distinct[0]!)).toBe(false);
    expect(attrChips(split.distinct[0]!)).toEqual([
      { field: 'suite', value: 'twinopen' },
      { field: 'test', value: 'ext+twinopen:twinopen.html' },
    ]);
    // The series that does have something of its own is untouched by the
    // fallback.
    expect(attrChips(split.distinct[1]!)).toEqual([{ field: 'option', value: 'no-nova' }]);
  });

  it('names both cards when two series are alike in everything shown', () => {
    // Two signatures that differ only in something this app never displays.
    // Both cards fall back, so they read the same — the swatch, the point count
    // and the graph are what tell them apart.
    const split = splitCommonAttrs([attrs({}), attrs({})]);
    expect(split.distinct.map((d) => d && attrChips(d))).toEqual([
      [{ field: 'suite', value: 'speedometer3' }],
      [{ field: 'suite', value: 'speedometer3' }],
    ]);
  });

  it('still falls through for a series with no suite and no test', () => {
    // Nothing to name it with, so the card keeps the signature id — which is
    // the only remaining case that branch is for.
    const split = splitCommonAttrs([
      attrs({ suite: '', test: '' }),
      attrs({ suite: '', test: '', options: ['opt', 'cold'] }),
    ]);
    expect(isEmptyAttrs(split.distinct[0]!)).toBe(true);
  });

  it('leaves an unloaded series null rather than naming it', () => {
    // The fallback is for series we know about. A null stays null, so the card
    // keeps showing the signature id until the metadata lands.
    const split = splitCommonAttrs([attrs({}), attrs({ options: ['opt', 'cold'] }), null]);
    expect(split.distinct[2]).toBeNull();
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
  // The difference from splitCommonAttrs: it keeps the name. The picker prefill
  // and the document title want one series' attributes whole, suite and test
  // included; only the display peels the name off for the card to carry.
  it('keeps the name a single series’ split hoists away', () => {
    expect(commonAttrs([attrs({})])).toEqual(attrs({}));
    expect(splitCommonAttrs([attrs({})]).common).toEqual(attrs({ suite: '', test: '' }));
  });

  it('is empty for no series', () => {
    expect(commonAttrs([])).toEqual(NO_ATTRS);
    expect(commonAttrs([null])).toEqual(NO_ATTRS);
  });
});

describe('commonMeasurement', () => {
  const m = (unit: string, lowerIsBetter = true): Measurement => ({ unit, lowerIsBetter });

  it('reports a unit and direction every series agrees on', () => {
    expect(commonMeasurement([m('score', false), m('score', false)])).toEqual({
      unit: 'score',
      lowerIsBetter: false,
    });
  });

  it('says nothing about a unit the series disagree on', () => {
    expect(commonMeasurement([m('ms'), m('score')]).unit).toBe('');
  });

  it('says nothing about a direction the series disagree on', () => {
    expect(commonMeasurement([m('ms', true), m('ms', false)]).lowerIsBetter).toBeNull();
  });

  it('judges unit and direction independently', () => {
    // Different units but the same direction: withholding "lower is better"
    // because the units differ would suppress something true.
    expect(commonMeasurement([m('ms', true), m('score', true)])).toEqual({
      unit: '',
      lowerIsBetter: true,
    });
  });

  it('ignores a series with no unit rather than calling it disagreement', () => {
    // Matches the graph's y-axis label, which filters empty units out before
    // deciding whether there is one unit or several.
    expect(commonMeasurement([m(''), m('ms'), m('ms')]).unit).toBe('ms');
  });

  it('ignores series with no metadata yet', () => {
    expect(commonMeasurement([null, m('ms', false), null])).toEqual({
      unit: 'ms',
      lowerIsBetter: false,
    });
    expect(commonMeasurement([null])).toEqual(NO_MEASUREMENT);
    expect(commonMeasurement([])).toEqual(NO_MEASUREMENT);
  });
});

describe('measurementForEntry', () => {
  const ref: SeriesRef = { repository: 'autoland', signatureId: 5690953, frameworkId: 13 };

  it('has nothing to say for an unloaded series or a placeholder', () => {
    expect(measurementForEntry(null)).toBeNull();
    // A placeholder's `lowerIsBetter: true` is a default nobody stated, so
    // counting it would report a unanimous direction from one real opinion.
    expect(measurementForEntry(placeholderMeta(ref))).toBeNull();
  });
});

describe('measurementParts', () => {
  it('names the unit and the direction', () => {
    expect(measurementParts({ unit: 'score', lowerIsBetter: false })).toEqual([
      'score',
      'higher is better',
    ]);
    expect(measurementParts({ unit: 'ms', lowerIsBetter: true })).toEqual([
      'ms',
      'lower is better',
    ]);
  });

  it('omits whichever half is unknown', () => {
    expect(measurementParts({ unit: 'ms', lowerIsBetter: null })).toEqual(['ms']);
    expect(measurementParts({ unit: '', lowerIsBetter: true })).toEqual(['lower is better']);
    expect(measurementParts(NO_MEASUREMENT)).toEqual([]);
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

describe('documentTitle', () => {
  const S3 = attrs({ suite: 'speedometer3', test: 'cpuTime', platform: 'android-hw-a55' });

  it('is the bare app name with nothing plotted', () => {
    expect(documentTitle([], false)).toBe('Perfherder Graphs');
  });

  it('names a single series by its own attributes, coarse to fine', () => {
    expect(documentTitle([S3], false)).toBe(
      'speedometer3 · cpuTime · firefox · android-hw-a55 — Perfherder Graphs',
    );
  });

  it('names several series by what they share, and counts them', () => {
    // Three browsers of one test: the application drops out of the shared part,
    // so the count is what says there is more than one line on the graph.
    const sets = [
      S3,
      attrs({ ...S3, application: 'chrome' }),
      attrs({ ...S3, application: 'safari' }),
    ];
    expect(documentTitle(sets, false)).toBe(
      'speedometer3 · cpuTime · android-hw-a55 · 3 series — Perfherder Graphs',
    );
  });

  it('falls back to the count when the series share nothing', () => {
    const sets = [S3, attrs({ suite: 'ts_paint', test: '', platform: 'linux', application: '' })];
    expect(documentTitle(sets, false)).toBe('2 series — Perfherder Graphs');
  });

  it('says how many series there are before their metadata lands', () => {
    // `attrsForEntry` yields null for a series still loading, or one the
    // summary endpoint said nothing about.
    expect(documentTitle([null, null], false)).toBe('2 series — Perfherder Graphs');
    expect(documentTitle([null], false)).toBe('1 series — Perfherder Graphs');
  });

  it('names the Add-series panel while it is open', () => {
    expect(documentTitle([S3], true)).toBe('Add series — Perfherder Graphs');
    expect(documentTitle([], true)).toBe('Add series — Perfherder Graphs');
  });
});
