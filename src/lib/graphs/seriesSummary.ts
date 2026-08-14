// Factoring a list of plotted series into "what they all share" and "what
// makes each one different".
//
// Four speedometer3 series that differ only by browser used to render as four
// near-identical three-line cards, and the eye had to diff long strings to
// find the one word that mattered. So the series list hoists the attributes
// every series shares into a single header and leaves each card with nothing
// but its own distinguishing attributes.

import type { Filter, FilterChip, FilterField } from '../picker/filter';
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

// Which of the two jobs the header is doing. With several series it names what
// they agree on; with one there is nothing to agree with, so it holds that
// series' details and the card keeps only its name. The two read differently
// enough that the heading has to say which one it is.
export type SplitMode = 'single' | 'multi';

export type AttrSplit = {
  // Attributes held by every series passed in — or, in `single` mode,
  // everything except the name.
  common: SeriesAttrs;
  // Parallel to the input: null where the input was null, otherwise that
  // series' attributes with everything in `common` removed.
  distinct: (SeriesAttrs | null)[];
  // Whether `common` holds anything at all, i.e. whether a header is worth
  // rendering.
  hasCommon: boolean;
  mode: SplitMode;
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

// The fields that stay on the card in `single` mode: the closest thing a series
// has to a name, and the reason the card doesn't go blank when everything else
// moves up into the header.
const NAME_FIELDS = ['suite', 'test'] as const;

export function splitCommonAttrs(sets: (SeriesAttrs | null)[]): AttrSplit {
  // One series: nothing to intersect, so the split is by role rather than by
  // agreement. Its details go up into the header and the card keeps its name.
  //
  // This is why `commonAttrs` still exists separately: over one series it
  // returns that series' attributes *whole*, which is what the picker prefill
  // and `documentTitle` want. Only the display splits them up.
  if (sets.length === 1) {
    const only = sets[0];
    if (!only) return { common: NO_ATTRS, distinct: sets, hasCommon: false, mode: 'single' };
    const common: SeriesAttrs = { ...only };
    const name: SeriesAttrs = { ...NO_ATTRS };
    for (const field of NAME_FIELDS) {
      name[field] = only[field];
      common[field] = '';
    }
    return { common, distinct: [name], hasCommon: !isEmptyAttrs(common), mode: 'single' };
  }

  const loaded = sets.filter((s): s is SeriesAttrs => s !== null);
  // Several series but fewer than two loaded: an intersection over the one that
  // has arrived is a claim about the ones that haven't, and it would visibly
  // rewrite itself as their fetches land.
  if (loaded.length < 2) {
    return { common: NO_ATTRS, distinct: sets, hasCommon: false, mode: 'multi' };
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
    // Nothing left over. That isn't the same as nothing to say, and the card
    // must not fall through to "signature 5304038" — which is what it prints
    // for metadata that hasn't arrived, so a loaded series would be wearing a
    // loading state.
    //
    // It happens when a series' options are exactly the intersection while
    // another series has more: plot twinopen on windows11 (5304038) against the
    // same test with `no-nova` (5926558) and every attribute of the first is
    // shared, so the second's card gets "no-nova" and the first's gets nothing.
    // Its distinguishing feature is an *absent* option, which a list of present
    // ones cannot express — and spelling it out is worse than it sounds, since
    // the missing option here is itself called "no-nova".
    //
    // Only options can do this. A scalar is either shared by everyone, and so
    // in the header for all, or absent from `common` and so on every card.
    //
    // So the card falls back to the series' name, duplicating the suite and
    // test already in the header. Redundant, but a card that repeats the header
    // still reads as a series; a bare signature id reads as a failure.
    if (isEmptyAttrs(rest)) {
      for (const field of NAME_FIELDS) rest[field] = s[field];
    }
    return rest;
  });

  return { common, distinct, hasCommon: !isEmptyAttrs(common), mode: 'multi' };
}

export function isEmptyAttrs(attrs: SeriesAttrs): boolean {
  return SCALAR_FIELDS.every((f) => attrs[f] === '') && attrs.options.length === 0;
}

// ---- What the numbers mean ------------------------------------------------
// The unit and the better-direction are kept apart from `SeriesAttrs` on
// purpose. `SeriesAttrs` is the *identifying* half — it feeds
// `commonFilterChips` and `documentTitle`, and neither wants a `unit:` chip or
// "ms" in the tab title. These two are a property of the measurement, so they
// travel separately and only reach the header.

export type Measurement = { unit: string; lowerIsBetter: boolean };

// Same null convention as `attrsForEntry`, and for the same reason: a
// placeholder's metadata is synthesized, and its `lowerIsBetter: true` is a
// default nobody stated. Counting it would report a direction as unanimous
// when only one series actually has an opinion.
export function measurementForEntry(meta: SeriesMeta | null): Measurement | null {
  if (!meta || meta.placeholder) return null;
  return { unit: meta.measurementUnit, lowerIsBetter: meta.lowerIsBetter };
}

// '' / null mean "don't say anything about this".
export type CommonMeasurement = { unit: string; lowerIsBetter: boolean | null };

export const NO_MEASUREMENT: CommonMeasurement = { unit: '', lowerIsBetter: null };

// Unit and direction are judged independently: two series in different units
// that agree on the direction still get "higher is better". They're separate
// facts, and suppressing one because the other disagrees would withhold
// something true.
export function commonMeasurement(
  sets: readonly (Measurement | null)[],
): CommonMeasurement {
  const loaded = sets.filter((m): m is Measurement => m !== null);
  if (loaded.length === 0) return NO_MEASUREMENT;
  // Empty units are ignored rather than counted as disagreement, matching the
  // graph's y-axis label: one unitless series alongside two in "ms" still
  // says "ms".
  const units = new Set(loaded.map((m) => m.unit).filter((u) => u !== ''));
  const directions = new Set(loaded.map((m) => m.lowerIsBetter));
  return {
    unit: units.size === 1 ? [...units][0] : '',
    lowerIsBetter: directions.size === 1 ? [...directions][0] : null,
  };
}

// A list rather than a joined string, so the template separates the parts with
// the same "·" idiom the attribute chips use.
//
// Wording matches DetailsPane, which says the same thing for a selected point —
// though only for a selected point, which is why this exists: the direction has
// no other unconditional home in the UI.
export function measurementParts(m: CommonMeasurement): string[] {
  const parts: string[] = [];
  if (m.unit !== '') parts.push(m.unit);
  if (m.lowerIsBetter !== null) {
    parts.push(m.lowerIsBetter ? 'lower is better' : 'higher is better');
  }
  return parts;
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

// The whole filter, not just its chips: the two places that apply it — the
// prefill on open and the panel's "Filter to graph" button — both replace the
// filter outright, free text included. Merging instead would be worse in both
// directions: the text is usually the search that *found* the plotted series
// and is spent once they're on the graph, and a leftover token silently
// narrowing a filter whose chips claim to describe the graph is exactly the
// "the box says one thing, the list shows another" failure docs/design.md warns
// about for FilterInput.
export function graphContextFilter(sets: readonly (SeriesAttrs | null)[]): Filter {
  return { chips: commonFilterChips(commonAttrs(sets)), text: '' };
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

// The same chips as one string, for the places that name a series inside a line
// of running text rather than as styled spans: the CLI's tables, and the app's
// Landing block. The separator is the "·" the cards draw between chips, so a
// series reads the same wherever it is named.
export function chipText(attrs: SeriesAttrs | null): string {
  if (!attrs) return '';
  return attrChips(attrs)
    .map((chip) => chip.value)
    .join(' · ');
}
