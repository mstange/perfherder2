// Pure helpers used by the picker. Kept in their own module so they can be
// unit-tested without spinning up Svelte's runtime.

import type { Series } from './series';

// ---------------------------------------------------------------------------
// Structured filter model
//
// The user's filter is a mix of typed chips (exact per-field matches like
// `repo:autoland`, or exclusions like `-application:firefox`) and free-text
// tokens (substring matches against the row's prebuilt searchText). Every chip
// must match and every free-text token must appear in searchText — one flat
// AND, no per-field special case.

export const FILTER_FIELDS = [
  'suite',
  'test',
  'application',
  'repo',
  'platform',
  'option',
] as const;

export type FilterField = (typeof FILTER_FIELDS)[number];

export interface FilterChip {
  field: FilterField;
  value: string; // stored lowercase for case-insensitive equality
  // An exclusion: the row matches when it does *not* have this value. Chips
  // are canonical — `negated` is either `true` or absent, never `false`, so
  // `{field, value}` is a perfectly good include chip and a deep-equality
  // assertion over one doesn't have to know this field exists. Build chips
  // with `makeChip` where the polarity is a variable.
  negated?: true;
}

export interface Filter {
  chips: FilterChip[];
  text: string;
}

export const EMPTY_FILTER: Filter = { chips: [], text: '' };

const FIELD_SET: ReadonlySet<string> = new Set(FILTER_FIELDS);

export function isFilterField(s: string): s is FilterField {
  return FIELD_SET.has(s);
}

// The one place a chip is built from a polarity that isn't a literal. Keeps
// `negated: false` out of the model — see the field's comment.
export function makeChip(
  field: FilterField,
  value: string,
  negated = false,
): FilterChip {
  const chip: FilterChip = { field, value: value.toLowerCase() };
  if (negated) chip.negated = true;
  return chip;
}

// Serialize a chip for display / for typing back into the input. This is also
// the URL's `pc=` spelling and the CLI's term spelling — one syntax everywhere,
// so a chip pastes between the three.
export function chipToString(chip: FilterChip): string {
  return `${chip.negated ? '-' : ''}${chip.field}:${chip.value}`;
}

// Parse "field:value", or "-field:value" for an exclusion. Returns null if the
// field isn't one we know or the value is empty. Values are lowercased; the
// field must already be lowercase (typing "Repo:Autoland" is rejected — this
// keeps the parser simple and the input predictable).
//
// The leading `-` is the GitHub/Gmail search convention, and it costs nothing
// elsewhere: a term with no colon or an unknown field stays free text either
// way, and the CLI's argv parser only treats `--` tokens as flags, so
// `-application:firefox` reaches it as a positional.
export function parseChip(text: string): FilterChip | null {
  const negated = text.startsWith('-');
  const body = negated ? text.slice(1) : text;
  const idx = body.indexOf(':');
  if (idx <= 0 || idx === body.length - 1) return null;
  const field = body.slice(0, idx);
  const value = body.slice(idx + 1).trim();
  if (!value) return null;
  if (!isFilterField(field)) return null;
  return makeChip(field, value, negated);
}

// Split the free-text half of the filter into lowercase substring tokens.
export function tokenizeFilter(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// Test whether a single chip matches a row. Comparison is exact and
// case-insensitive because chip values are stored lowercase. A negated chip
// matches the rows its positive twin doesn't — including rows with no value
// for the field at all, so `-test:foo` keeps the suite-level rows (whose
// `test` is empty) rather than quietly dropping them.
export function chipMatchesRow(row: Series, chip: FilterChip): boolean {
  const has = rowHasFieldValue(row, chip.field, chip.value);
  return chip.negated ? !has : has;
}

function rowHasFieldValue(row: Series, field: FilterField, v: string): boolean {
  switch (field) {
    case 'repo':
      return row.repository.toLowerCase() === v;
    case 'application':
      return row.application.toLowerCase() === v;
    case 'platform':
      return row.platform.toLowerCase() === v;
    case 'suite':
      return row.suite.toLowerCase() === v;
    case 'test':
      return row.test.toLowerCase() === v;
    case 'option':
      return row.options.some((o) => o.toLowerCase() === v);
  }
}

// The row's raw values for a given field — the strings a chip of that field is
// compared against (case-insensitively; see `chipMatchesRow`). Multi-valued for
// `option`; empty when the row has no value, as suite-level rows have no `test`.
export function fieldValues(row: Series, field: FilterField): string[] {
  switch (field) {
    case 'repo':
      return [row.repository];
    case 'application':
      return row.application ? [row.application] : [];
    case 'platform':
      return [row.platform];
    case 'suite':
      return [row.suite];
    case 'test':
      return row.test ? [row.test] : [];
    case 'option':
      return row.options;
  }
}

// True if the filter has any user-authored constraint (chips or non-blank text).
// Used to decide when to enter "subtest-aware" filtering — when there's no
// constraint, everything matches trivially and children shouldn't be pruned.
export function isFilterActive(filter: Filter): boolean {
  return filter.chips.length > 0 || filter.text.trim().length > 0;
}

// Evaluate a parent against a filter while giving its subtests a chance to
// match. Returns null if neither the parent nor any of its children match.
// The `matchedChildren` array is the exact subset of `children` that matched;
// when the caller renders subtests under this parent, it should use that
// subset if the filter is active, so a subtest-badge click reveals only the
// row the user clicked on rather than 200 unrelated siblings.
export interface ParentMatch {
  parent: Series;
  selfMatched: boolean;
  matchedChildren: Series[];
}

export function matchParentWithChildren(
  parent: Series,
  children: readonly Series[],
  filter: Filter,
): ParentMatch | null {
  const selfMatched = matchesRow(parent, filter);
  const matchedChildren: Series[] = [];
  for (const c of children) {
    if (matchesRow(c, filter)) matchedChildren.push(c);
  }
  if (!selfMatched && matchedChildren.length === 0) return null;
  return { parent, selfMatched, matchedChildren };
}

export function matchesRow(row: Series, filter: Filter): boolean {
  // Every chip narrows, including two chips of the same field and including
  // exclusions. See the "Filter model" section of docs/design.md for why
  // that's AND and not the usual faceted-search OR.
  for (const c of filter.chips) {
    if (!chipMatchesRow(row, c)) return false;
  }
  // All free-text tokens must match the row's precomputed haystack.
  for (const tok of tokenizeFilter(filter.text)) {
    if (!row.searchText.includes(tok)) return false;
  }
  return true;
}

// Chip equality — used for de-dup on add and lookup on remove. Polarity is
// part of it: `application:firefox` and `-application:firefox` are two
// different chips, and `sameTerm` below is the question that ignores it.
export function sameChip(a: FilterChip, b: FilterChip): boolean {
  return a.field === b.field && a.value === b.value && !!a.negated === !!b.negated;
}

// Same field and value, either polarity — the two chips that can't coexist.
// A filter holding both matches nothing, and every path that adds a chip goes
// through `addChip`, which replaces the twin rather than producing that.
export function sameTerm(a: FilterChip, b: FilterChip): boolean {
  return a.field === b.field && a.value === b.value;
}

// The chip that says the opposite about the same field and value.
export function flipChip(chip: FilterChip): FilterChip {
  return makeChip(chip.field, chip.value, !chip.negated);
}

// Literal equality: same text, same chips in the same order. An identity
// question, not a semantic one — reordering the same chips counts as different,
// which is what its caller wants: `graphContextState` uses it to decide whether
// applying the graph's context would *change* anything, and re-applying a
// permutation is a no-op worth disabling.
export function sameFilter(a: Filter, b: Filter): boolean {
  return (
    a.text === b.text &&
    a.chips.length === b.chips.length &&
    a.chips.every((chip, i) => sameChip(chip, b.chips[i]))
  );
}

// What the panel's "Derive filter" control can do right now. Four answers,
// because three of them disable the button for visibly different reasons and
// the user is owed the right one:
//
// - `none`     nothing is plotted, so there is no context to take.
// - `pending`  series are plotted but no metadata has arrived, so their shared
//              attributes aren't known yet. Distinct from `none` because the
//              button becomes live on its own once the fetches land, and a
//              tooltip that said "nothing on the graph" would be a lie.
// - `same`     the filter already *is* the context. Disabled, and the most
//              useful of the four: it's the only place the panel says out loud
//              that what you're looking at matches your graph.
// - `apply`    the context differs from the filter. The button acts.
//
// Takes `hasSeries` rather than the whole context so this module keeps its
// distance from the graphs half of the app: `GraphContext` is declared in
// urlState.ts, which imports *from* here.
export type GraphContextState = 'none' | 'pending' | 'same' | 'apply';

export function graphContextState(
  current: Filter,
  context: Filter,
  hasSeries: boolean,
): GraphContextState {
  if (!isFilterActive(context)) return hasSeries ? 'pending' : 'none';
  return sameFilter(current, context) ? 'same' : 'apply';
}

export function hasChip(filter: Filter, chip: FilterChip): boolean {
  return filter.chips.some((c) => sameChip(c, chip));
}

// Whether the filter includes, excludes, or says nothing about a field's value.
// What a badge draws itself from, and what its click has to know.
export type ChipPolarity = 'include' | 'exclude';

export function chipPolarity(
  filter: Filter,
  field: FilterField,
  value: string,
): ChipPolarity | null {
  const term = makeChip(field, value);
  const found = filter.chips.find((c) => sameTerm(c, term));
  if (!found) return null;
  return found.negated ? 'exclude' : 'include';
}

// Add a chip, **replacing its opposite-polarity twin in place** if one is
// there. Adding `-application:firefox` on top of `application:firefox` has to
// mean "no, the other one" — keeping both would be a filter that matches
// nothing, which is not a state any click should be able to produce. In place,
// rather than appended, so flipping a chip doesn't shuffle the row of pills.
export function addChip(filter: Filter, chip: FilterChip): Filter {
  if (hasChip(filter, chip)) return filter;
  const twin = filter.chips.findIndex((c) => sameTerm(c, chip));
  if (twin === -1) return { ...filter, chips: [...filter.chips, chip] };
  const chips = [...filter.chips];
  chips[twin] = chip;
  return { ...filter, chips };
}

export function removeChip(filter: Filter, chip: FilterChip): Filter {
  return {
    ...filter,
    chips: filter.chips.filter((c) => !sameChip(c, chip)),
  };
}

// Toggle a chip on/off. Convenience for badge clicks, and the reason each
// polarity toggles only *itself*: plain click owns `include` and alt-click
// owns `exclude`, so of the six transitions between the three states, every
// one is a single click. (Were this "toggle whichever chip is there", going
// from included to excluded would take two.)
export function toggleChip(filter: Filter, chip: FilterChip): Filter {
  return hasChip(filter, chip) ? removeChip(filter, chip) : addChip(filter, chip);
}

// Flip one chip's polarity where it sits. The filter box's pills call this;
// it is the path that doesn't need a modifier key, so it's the one a touch or
// keyboard user has.
export function toggleChipNegation(filter: Filter, chip: FilterChip): Filter {
  if (!hasChip(filter, chip)) return filter;
  return {
    ...filter,
    chips: filter.chips.map((c) => (sameChip(c, chip) ? flipChip(c) : c)),
  };
}

// ---------------------------------------------------------------------------
// Column sorting

export const SORT_COLUMNS = [
  'suite',
  'application',
  'repo',
  'platform',
  'options',
  'unit',
] as const;

export type SortColumn = (typeof SORT_COLUMNS)[number];

export type SortDirection = 'asc' | 'desc';

export interface SortState {
  column: SortColumn;
  direction: SortDirection;
}

// The user-clicked sort cycles asc → desc → cleared → asc. Passing null as
// `current` means "no sort", and clicking a column starts at asc.
export function cycleSort(
  current: SortState | null,
  column: SortColumn,
): SortState | null {
  if (!current || current.column !== column) return { column, direction: 'asc' };
  if (current.direction === 'asc') return { column, direction: 'desc' };
  return null;
}

// Canonical string used to compare rows for a given column. Multi-valued
// columns (options) are joined so sorting stays deterministic.
export function sortKey(row: Series, column: SortColumn): string {
  switch (column) {
    case 'suite':
      // Suite is the primary text column; break ties with test name.
      return `${row.suite}\u0000${row.test}`.toLowerCase();
    case 'application':
      return row.application.toLowerCase();
    case 'repo':
      return row.repository.toLowerCase();
    case 'platform':
      return row.platform.toLowerCase();
    case 'options':
      return row.options.join(' ').toLowerCase();
    case 'unit':
      return row.measurementUnit.toLowerCase();
  }
}

// Comparator suitable for Array.prototype.sort. `sort` may be null to mean
// "no sorting" (returns 0 for every pair, which keeps the caller's original
// order when sort is stable, which it is in every modern engine).
export function compareRows(
  a: Series,
  b: Series,
  sort: SortState | null,
): number {
  if (!sort) return 0;
  const ka = sortKey(a, sort.column);
  const kb = sortKey(b, sort.column);
  const cmp = ka < kb ? -1 : ka > kb ? 1 : 0;
  return sort.direction === 'asc' ? cmp : -cmp;
}

// ---------------------------------------------------------------------------
// Subtest grouping and cache helpers

// Group subtest rows by their parent's `key`. Series carries both `key` and
// `parentKey` fields (composed at construction in series.ts::toSeries), so
// consumers don't need to remember the `${repository}|${id}` recipe.
export function groupChildrenByParent(
  rows: readonly Series[],
): Map<string, Series[]> {
  const m = new Map<string, Series[]>();
  for (const r of rows) {
    if (!r.parentKey) continue;
    const arr = m.get(r.parentKey);
    if (arr) arr.push(r);
    else m.set(r.parentKey, [r]);
  }
  return m;
}

export function cacheKey(
  repo: string,
  includeSubtests: boolean,
  intervalSeconds: number,
): string {
  return `${repo}|${includeSubtests ? 1 : 0}|${intervalSeconds}`;
}

// Prefer the subtests-included fetch if loaded, fall back to the no-subtests
// fetch. Keeps the top-level list visible when the fatter fetch is in flight.
export function pickCachedForRepo(
  cache: ReadonlyMap<string, Series[]>,
  repo: string,
  intervalSeconds: number,
): Series[] | undefined {
  return (
    cache.get(cacheKey(repo, true, intervalSeconds)) ??
    cache.get(cacheKey(repo, false, intervalSeconds))
  );
}

/**
 * The load row in one line, for the panel too narrow to keep it open: which
 * repositories are being fetched, and over what window.
 *
 * Two repositories are named and three or more are counted. The names are what
 * the reader wants — "autoland, mozilla-central" is the answer to "am I looking
 * at the right thing" — but four of them do not fit a phone's width beside the
 * time range, and an ellipsis in the middle of a list of names says less than
 * the count does. `repos` arrives in the order the chips are drawn in, so the
 * line doesn't reshuffle as one is checked.
 *
 * Nothing selected is a state the panel is already loud about (the list says "No
 * repositories selected — check one above"), so this only has to not lie.
 */
export function loadSummary(repos: readonly string[], rangeLabel: string): string {
  const which =
    repos.length === 0
      ? 'no repositories'
      : repos.length <= 2
        ? repos.join(', ')
        : `${repos.length} repositories`;
  return `${which} · last ${rangeLabel}`;
}
