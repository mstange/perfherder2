// `Series` — one row of the picker's table — and the projection that builds it
// from treeherder's raw signature rows.
//
// Pure logic over the shapes signaturesApi.ts validates: no fetching here, so
// the whole thing is exercisable from a fixture. Same split as
// graphApi.ts/graphData.ts.

import type { RawSignature } from './signaturesApi';

// Enriched signature we display in the table. `repository` and `framework`
// come from the request context / framework map; `options` is the resolved
// option-collection + extra_options list.
export type Series = {
  id: number;
  repository: string;
  framework: string;
  frameworkId: number;
  platform: string;
  suite: string;
  test: string;
  application: string;
  options: string[];
  // The three below are **not read outside this module and its tests**, and are
  // kept for the same reason `framework` is (see "Framework is searchable but
  // not shown" in design.md): they are what the row came in as, they cost a
  // reference each, and a reader asking "what does a signature carry" should
  // find the answer here rather than in signaturesApi.ts. `extraOptions` is the
  // unresolved half of `options`; `parentSignature` and `signatureHash` are the
  // raw hashes that `parentKey` and `key` exist to replace — **never key
  // anything by them**, see the comment on `key`.
  extraOptions: string[];
  measurementUnit: string;
  hasSubtests: boolean;
  isSubtest: boolean;
  parentSignature: string | null;
  signatureHash: string;
  // Compound identity: `${repository}|${id}`. Baked in at construction so
  // callers never need to remember the composition. The API's row id is
  // globally unique, unlike `signatureHash` which collides both across repos
  // (same test on autoland and mozilla-central) and within a repo (two rows
  // differing only by `application` — e.g. custom-car vs chrome — share a
  // hash).
  key: string;
  // The parent row's `key`, if this is a subtest. `null` for parents. Looked
  // up in `toSeries` because `parent_signature` alone doesn't identify the
  // parent when hashes alias within a repo (see above); the child's
  // `application` disambiguates.
  parentKey: string | null;
  // Precomputed lowercase haystack for fast text filtering.
  searchText: string;
};

export function toSeries(
  raw: Record<string, RawSignature>,
  repository: string,
  frameworkMap: Map<number, string>,
  optionMap: Map<string, string[]>,
): Series[] {
  const entries = Object.entries(raw);

  // Lookup from a parent's (signature_hash, application) to its numeric id.
  // Subtests reference their parent by `parent_signature` (a hash), but that
  // hash is NOT unique within a repo: parents that differ only by
  // `application` (custom-car vs chrome for the same suite/platform) share
  // it. A child inherits its parent's application, so (hash, application)
  // uniquely picks the right parent — and the parent's id then goes into the
  // child's `parentKey`.
  const parentIdByHashApp = new Map<string, number>();
  for (const [idStr, s] of entries) {
    if (s.parent_signature) continue;
    const app = s.application ?? '';
    parentIdByHashApp.set(`${s.signature_hash}|${app}`, Number(idStr));
  }

  const out: Series[] = [];
  for (const [idStr, s] of entries) {
    const id = Number(idStr);
    const framework = frameworkMap.get(s.framework_id) ?? `framework:${s.framework_id}`;
    const baseOpts = optionMap.get(s.option_collection_hash) ?? [];
    const extra = s.extra_options ?? [];
    // Dedup while preserving order.
    const options = [...new Set([...baseOpts, ...extra])];
    const suite = s.suite ?? '';
    const test = s.test ?? '';
    const application = s.application ?? '';
    // `tags` are a subset of `extra_options` (see docs/design.md) — already
    // covered by `options` above, so we don't feed them into searchText.
    const searchText = [
      suite,
      test,
      application,
      s.machine_platform,
      framework,
      repository,
      ...options,
    ]
      .join(' ')
      .toLowerCase();
    const parentSignature = s.parent_signature ?? null;
    let parentKey: string | null = null;
    if (parentSignature) {
      const pid = parentIdByHashApp.get(`${parentSignature}|${application}`);
      if (pid !== undefined) parentKey = `${repository}|${pid}`;
    }
    out.push({
      id,
      repository,
      framework,
      frameworkId: s.framework_id,
      platform: s.machine_platform,
      suite,
      test,
      application,
      options,
      extraOptions: extra,
      measurementUnit: s.measurement_unit ?? '',
      hasSubtests: !!s.has_subtests,
      isSubtest: !!parentSignature,
      parentSignature,
      signatureHash: s.signature_hash,
      key: `${repository}|${id}`,
      parentKey,
      searchText,
    });
  }
  return out;
}
