// Pure helpers used by the picker. Kept in their own module so they can be
// unit-tested without spinning up Svelte's runtime.

import type { Series } from './api';

// Split the user's filter text into lowercase whitespace-separated tokens.
// All tokens must match (see matchesRow) — this mirrors Perfherder's own
// containsText() behavior.
export function tokenizeFilter(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

export function matchesRow(
  row: Series,
  tokens: readonly string[],
  platforms: ReadonlySet<string>,
): boolean {
  if (platforms.size > 0 && !platforms.has(row.platform)) return false;
  for (const t of tokens) {
    if (!row.searchText.includes(t)) return false;
  }
  return true;
}

// Group subtest rows under their parent's signature_hash. Non-subtest rows
// are ignored.
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

// Return the "richest" cached series list for a repo: prefer the
// subtests-included fetch if loaded, and fall back to the no-subtests
// fetch. This lets the top-level list stay visible even when the user
// just enabled subtests and the fatter fetch hasn't finished yet.
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
