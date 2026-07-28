// Factoring a list of plotted series into "what they all share" and "what
// makes each one different".
//
// Four speedometer3 series that differ only by browser used to render as four
// near-identical three-line cards, and the eye had to diff long strings to
// find the one word that mattered. So the series list hoists the attributes
// every series shares into a single header and leaves each card with nothing
// but its own distinguishing attributes.

import type { SeriesMeta, SeriesRef } from './graphData';

// The displayable attributes of one series, flattened.
//
// `options` is a token list rather than the server's space-joined string on
// purpose: two series routinely share "opt fission webrender" and differ only
// in "cold" vs "warm", and only a per-token intersection can see that.
export type SeriesAttrs = {
  repo: string;
  suite: string;
  test: string;
  platform: string;
  application: string;
  options: string[];
};

// Every field of `SeriesAttrs` except `options`, which needs set logic.
export const SCALAR_FIELDS = ['repo', 'suite', 'test', 'platform', 'application'] as const;
export type ScalarField = (typeof SCALAR_FIELDS)[number];

// '' / [] mean "nothing to show here", which is also what an attribute the
// series genuinely doesn't have looks like — a subtest-less signature has
// `test: ''`. Both render as absent, so the two cases don't need telling
// apart.
export const NO_ATTRS: SeriesAttrs = {
  repo: '',
  suite: '',
  test: '',
  platform: '',
  application: '',
  options: [],
};

export function attrsFromMeta(ref: SeriesRef, meta: SeriesMeta): SeriesAttrs {
  return {
    // Not in the metadata: the repository is part of the series' identity, not
    // of the signature the API described.
    repo: ref.repository,
    suite: meta.suite,
    test: meta.test,
    platform: meta.platform,
    application: meta.application,
    options: splitOptions(meta.options),
  };
}

export function splitOptions(options: string): string[] {
  return options.split(/\s+/).filter(Boolean);
}

export type AttrSplit = {
  // Attributes held by every series passed in.
  common: SeriesAttrs;
  // Parallel to the input: null where the input was null, otherwise that
  // series' attributes with everything in `common` removed.
  distinct: (SeriesAttrs | null)[];
  // Whether `common` holds anything at all, i.e. whether a header is worth
  // rendering.
  hasCommon: boolean;
};

// `null` entries are series whose metadata hasn't arrived yet. They're left
// out of the intersection rather than treated as a series with empty
// attributes — otherwise one unloaded series would make every field "differ"
// and the whole header would collapse into the cards and back again as it
// lands.
export function splitCommonAttrs(sets: (SeriesAttrs | null)[]): AttrSplit {
  const loaded = sets.filter((s): s is SeriesAttrs => s !== null);
  // With a single series there is nothing to compare against, and hoisting its
  // attributes into the header would leave the card blank.
  if (loaded.length < 2) {
    return { common: NO_ATTRS, distinct: sets, hasCommon: false };
  }

  const first = loaded[0];
  const common: SeriesAttrs = { ...NO_ATTRS };
  for (const field of SCALAR_FIELDS) {
    if (loaded.every((s) => s[field] === first[field])) common[field] = first[field];
  }
  common.options = first.options.filter((o) => loaded.every((s) => s.options.includes(o)));

  const distinct = sets.map((s) => {
    if (!s) return null;
    const rest: SeriesAttrs = {
      ...NO_ATTRS,
      options: s.options.filter((o) => !common.options.includes(o)),
    };
    for (const field of SCALAR_FIELDS) {
      if (common[field] === '') rest[field] = s[field];
    }
    return rest;
  });

  return { common, distinct, hasCommon: !isEmptyAttrs(common) };
}

export function isEmptyAttrs(attrs: SeriesAttrs): boolean {
  return SCALAR_FIELDS.every((f) => attrs[f] === '') && attrs.options.length === 0;
}

// One attribute as the list renders it. Options become one chip per token, so
// "cold" can sit in a card while "fission webrender" sits in the header.
export type AttrChip = { field: ScalarField | 'option'; value: string };

// Display order for a card's distinguishing attributes. Repository leads
// because it's the coarsest split and the eye can group cards by it; platform
// trails because it's by far the longest string.
const CHIP_ORDER: ScalarField[] = ['repo', 'suite', 'test', 'application'];

export function attrChips(attrs: SeriesAttrs): AttrChip[] {
  const chips: AttrChip[] = [];
  for (const field of CHIP_ORDER) {
    if (attrs[field] !== '') chips.push({ field, value: attrs[field] });
  }
  for (const option of attrs.options) chips.push({ field: 'option', value: option });
  if (attrs.platform !== '') chips.push({ field: 'platform', value: attrs.platform });
  return chips;
}
