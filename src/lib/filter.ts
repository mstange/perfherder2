// Pure helpers used by the picker. Kept in their own module so they can be
// unit-tested without spinning up Svelte's runtime.

import type { Series } from './api';

// ---------------------------------------------------------------------------
// Structured filter model
//
// The user's filter is a mix of typed chips (exact per-field matches like
// `repo:autoland`) and free-text tokens (substring matches against the row's
// prebuilt searchText). Chips of the same field OR together; different fields
// AND together; every free-text token must match somewhere in searchText.

export const FILTER_FIELDS = [
  'suite',
  'test',
  'application',
  'repo',
  'platform',
  'option',
  'tag',
] as const;

export type FilterField = (typeof FILTER_FIELDS)[number];

export interface FilterChip {
  field: FilterField;
  value: string; // stored lowercase for case-insensitive equality
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

// Serialize a chip for display / for typing back into the input.
export function chipToString(chip: FilterChip): string {
  return `${chip.field}:${chip.value}`;
}

// Parse "field:value". Returns null if the field isn't one we know or the
// value is empty. Values are lowercased; the field must already be lowercase
// (typing "Repo:Autoland" is rejected — this keeps the parser simple and the
// input predictable).
export function parseChip(text: string): FilterChip | null {
  const idx = text.indexOf(':');
  if (idx <= 0 || idx === text.length - 1) return null;
  const field = text.slice(0, idx);
  const value = text.slice(idx + 1).trim();
  if (!value) return null;
  if (!isFilterField(field)) return null;
  return { field, value: value.toLowerCase() };
}

// Split the free-text half of the filter into lowercase substring tokens.
export function tokenizeFilter(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// Test whether a single chip matches a row. Comparison is exact and
// case-insensitive because chip values are stored lowercase.
export function chipMatchesRow(row: Series, chip: FilterChip): boolean {
  const v = chip.value;
  switch (chip.field) {
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
    case 'tag':
      return row.tags.some((t) => t.toLowerCase() === v);
  }
}

// Get the exact string on the row that a chip would compare against, for
// the given field. Used to decide if a badge's value equals an existing
// chip's value (so the badge can flip to "remove filter" mode).
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
    case 'tag':
      return row.tags;
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
  // Chips of the same field OR together; different fields AND together.
  const chipsByField = new Map<FilterField, FilterChip[]>();
  for (const c of filter.chips) {
    const arr = chipsByField.get(c.field);
    if (arr) arr.push(c);
    else chipsByField.set(c.field, [c]);
  }
  for (const chips of chipsByField.values()) {
    let anyMatched = false;
    for (const c of chips) {
      if (chipMatchesRow(row, c)) {
        anyMatched = true;
        break;
      }
    }
    if (!anyMatched) return false;
  }
  // All free-text tokens must match the row's precomputed haystack.
  for (const tok of tokenizeFilter(filter.text)) {
    if (!row.searchText.includes(tok)) return false;
  }
  return true;
}

// Chip equality — used for de-dup on add and lookup on remove.
export function sameChip(a: FilterChip, b: FilterChip): boolean {
  return a.field === b.field && a.value === b.value;
}

export function hasChip(filter: Filter, chip: FilterChip): boolean {
  return filter.chips.some((c) => sameChip(c, chip));
}

export function addChip(filter: Filter, chip: FilterChip): Filter {
  if (hasChip(filter, chip)) return filter;
  return { ...filter, chips: [...filter.chips, chip] };
}

export function removeChip(filter: Filter, chip: FilterChip): Filter {
  return {
    ...filter,
    chips: filter.chips.filter((c) => !sameChip(c, chip)),
  };
}

// Toggle a chip on/off. Convenience for badge clicks.
export function toggleChip(filter: Filter, chip: FilterChip): Filter {
  return hasChip(filter, chip) ? removeChip(filter, chip) : addChip(filter, chip);
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
// Subtest grouping and cache helpers (unchanged)

export function groupChildrenByParent(
  rows: readonly Series[],
): Map<string, Series[]> {
  const m = new Map<string, Series[]>();
  for (const r of rows) {
    if (!r.isSubtest || !r.parentSignature) continue;
    const arr = m.get(r.parentSignature);
    if (arr) arr.push(r);
    else m.set(r.parentSignature, [r]);
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
