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
