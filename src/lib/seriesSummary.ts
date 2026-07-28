// Factoring a list of plotted series into "what they all share" and "what
// makes each one different".
//
// Four speedometer3 series that differ only by browser used to render as four
// near-identical three-line cards, and the eye had to diff long strings to
// find the one word that mattered. So the series list hoists the attributes
// every series shares into a single header and leaves each card with nothing
// but its own distinguishing attributes.

import type { FilterChip, FilterField } from './filter';
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

// What both consumers actually want: attributes, or null when there is no real
// metadata to read. That covers a series still loading *and* one the summary
// endpoint had nothing to say about — `SeriesMeta.placeholder`, whose suite is
// a synthesized "signature 1234". Feeding those fabricated fields into an
// intersection would either wipe out the shared header or, worse, prefill the
// picker with a filter that matches nothing.
export function attrsForEntry(ref: SeriesRef, meta: SeriesMeta | null): SeriesAttrs | null {
  if (!meta || meta.placeholder) return null;
  return attrsFromMeta(ref, meta);
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

// The attributes every series holds. `null` entries are series whose metadata
// hasn't arrived yet; they're left out of the intersection rather than treated
// as a series with empty attributes — otherwise one in-flight fetch would make
// every field "differ".
//
// Over a single series this is just that series' own attributes, which is what
// the picker prefill wants. The "one series has no header" rule belongs to the
// display, so it lives in `splitCommonAttrs` instead.
export function commonAttrs(sets: readonly (SeriesAttrs | null)[]): SeriesAttrs {
  const loaded = sets.filter((s): s is SeriesAttrs => s !== null);
  if (loaded.length === 0) return NO_ATTRS;

  const first = loaded[0];
  const common: SeriesAttrs = { ...NO_ATTRS };
  for (const field of SCALAR_FIELDS) {
    if (loaded.every((s) => s[field] === first[field])) common[field] = first[field];
  }
  common.options = first.options.filter((o) => loaded.every((s) => s.options.includes(o)));
  return common;
}

export function splitCommonAttrs(sets: (SeriesAttrs | null)[]): AttrSplit {
  const loaded = sets.filter((s): s is SeriesAttrs => s !== null);
  // With a single series there is nothing to compare against, and hoisting its
  // attributes into the header would leave the card blank.
  if (loaded.length < 2) {
    return { common: NO_ATTRS, distinct: sets, hasCommon: false };
  }

  const common = commonAttrs(sets);
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

// The picker filter a set of already-plotted series implies: one chip per
// attribute they all share, so opening "Add series" starts you among their
// siblings instead of at all 25,000 rows.
//
// `repo` is deliberately absent. The picker expresses the repository through
// its checkbox row, which also decides what gets *fetched* — a `repo:` chip
// would be a redundant second mechanism that can't fetch anything, and one
// that silently matches nothing if its repo isn't checked. `AppState` seeds
// the checkboxes from the series' repositories instead.
export function commonFilterChips(common: SeriesAttrs): FilterChip[] {
  const chips: FilterChip[] = [];
  // Chip values are lowercase by convention; see docs/design.md.
  const add = (field: FilterField, value: string) => {
    if (value !== '') chips.push({ field, value: value.toLowerCase() });
  };
  add('suite', common.suite);
  add('test', common.test);
  add('platform', common.platform);
  add('application', common.application);
  for (const option of common.options) add('option', option);
  return chips;
}

export const APP_NAME = 'Perfherder Graphs';

// Attributes worth putting in a title, coarse-to-fine: the front of the string
// is all a tab strip shows, so the most identifying part goes first and the
// long platform string trails.
//
// `repo` is left out — it's context rather than identity, and series from
// different repositories don't share one anyway. So are `options`: "opt
// fission webrender" is noise in a tab, and it would push the test name out of
// the visible part.
const TITLE_FIELDS: ScalarField[] = ['suite', 'test', 'application', 'platform'];

// `document.title` for a set of plotted series. They're named by what they
// have in *common*, the same factoring the list pane's header uses: a graph is
// nearly always one test sliced along one axis, and the shared part is what
// names the whole thing. The count then says how many slices, since
// "speedometer3 cpuTime" alone would read as a single graph when it's really
// three browsers overlaid.
//
// Metadata arrives per series, so this narrows as fetches land — from
// "3 series" to the first-loaded series' attributes to the true intersection.
// Titles that settle as data loads are normal; the alternative is showing the
// bare app name until every fetch is in, which would leave a shared link
// nameless for a second and forever if one series failed.
export function documentTitle(
  sets: readonly (SeriesAttrs | null)[],
  pickerOpen: boolean,
): string {
  // The one case the old static title was actually right about.
  if (pickerOpen) return `Add series — ${APP_NAME}`;
  if (sets.length === 0) return APP_NAME;

  const common = commonAttrs(sets);
  const parts = TITLE_FIELDS.map((f) => common[f]).filter((v) => v !== '');
  if (sets.length > 1) parts.push(`${sets.length} series`);
  // Reached when a lone series has no usable metadata yet — nothing shared and
  // no count to fall back on.
  if (parts.length === 0) return `1 series — ${APP_NAME}`;
  return `${parts.join(' · ')} — ${APP_NAME}`;
}

export function attrChips(attrs: SeriesAttrs): AttrChip[] {
  const chips: AttrChip[] = [];
  for (const field of CHIP_ORDER) {
    if (attrs[field] !== '') chips.push({ field, value: attrs[field] });
  }
  for (const option of attrs.options) chips.push({ field: 'option', value: option });
  if (attrs.platform !== '') chips.push({ field: 'platform', value: attrs.platform });
  return chips;
}
