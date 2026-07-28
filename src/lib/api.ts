// Treeherder / Perfherder API client.
//
// The signatures endpoint returns one row per performance series for a given
// repo. Everything else (frameworks, option collections) is small metadata
// used to give the raw rows human-readable names.

import * as v from 'valibot';
import { API_BASE as BASE, fetchJson } from './http';

// ---- Schemas -------------------------------------------------------------
// Types are inferred from these, never written twice. `v.object` ignores keys
// we don't declare, which is deliberate: treeherder adds fields without
// notice (production already sends a `push.branch` that its own checked-out
// serializer doesn't list), and a new field is not a reason to fail.

export const FrameworkSchema = v.object({ id: v.number(), name: v.string() });
export type Framework = v.InferOutput<typeof FrameworkSchema>;

export const OptionCollectionSchema = v.object({
  option_collection_hash: v.string(),
  options: v.array(v.object({ name: v.string() })),
});
export type OptionCollection = v.InferOutput<typeof OptionCollectionSchema>;

// Raw signature as returned by /performance/signatures/.
//
// Optionality here is not guesswork: `PerformanceSignatureViewSet.list` in
// treeherder/webapp/api/performance_data.py builds each row by hand and adds
// the cheap-to-omit fields *only when truthy* ("save some bandwidth"), which
// is why they are optional-but-never-null. `should_alert` is the one field it
// always emits and the one that can be null (the model has `null=True`).
// Confirmed against 162,584 live rows across autoland, mozilla-central,
// mozilla-beta and try: no other field was ever null or absent.
export const RawSignatureSchema = v.object({
  id: v.number(),
  signature_hash: v.string(),
  framework_id: v.number(),
  option_collection_hash: v.string(),
  machine_platform: v.string(),
  suite: v.string(),
  should_alert: v.nullable(v.boolean()),
  test: v.optional(v.string()),
  application: v.optional(v.string()),
  extra_options: v.optional(v.array(v.string())),
  measurement_unit: v.optional(v.string()),
  has_subtests: v.optional(v.boolean()),
  parent_signature: v.optional(v.string()),
  // Only ever emitted when false — the producer treats `true` as the default.
  lower_is_better: v.optional(v.boolean()),
  // Space-separated in the DB, a list here. We don't use it yet; declared so
  // the schema documents the row rather than half of it.
  tags: v.optional(v.array(v.string())),
});
export type RawSignature = v.InferOutput<typeof RawSignatureSchema>;

// The endpoint keys the map by stringified signature id.
export const SignatureMapSchema = v.record(v.string(), RawSignatureSchema);

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

export function fetchFrameworks(): Promise<Framework[]> {
  return fetchJson(v.array(FrameworkSchema), `${BASE}/performance/framework/`);
}

export function fetchOptionCollections(): Promise<OptionCollection[]> {
  return fetchJson(v.array(OptionCollectionSchema), `${BASE}/optioncollectionhash/`);
}

export function buildOptionMap(list: OptionCollection[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const oc of list) {
    map.set(oc.option_collection_hash, oc.options.map((o) => o.name));
  }
  return map;
}

export async function fetchSignatures(
  repository: string,
  intervalSeconds: number,
  includeSubtests: boolean,
): Promise<Record<string, RawSignature>> {
  const url =
    `${BASE}/project/${encodeURIComponent(repository)}/performance/signatures/` +
    `?interval=${intervalSeconds}&subtests=${includeSubtests ? 1 : 0}`;
  // The big one: ~22 MB and 54k rows for one repo. Validating it costs ~50ms
  // against a ~5s download, so the honest boundary is worth the 1%.
  return fetchJson(SignatureMapSchema, url);
}

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

// Perfherder's Graphs view pins these four repos. autoland + mozilla-central
// are the default-checked ones.
export const PINNED_REPOS = ['autoland', 'mozilla-central', 'mozilla-beta', 'try'];
export const DEFAULT_REPOS = ['autoland', 'mozilla-central'];

// Time range choices from the Perfherder graphs modal, seconds.
export const TIME_RANGES: { label: string; value: number }[] = [
  { label: '2 days', value: 172800 },
  { label: '7 days', value: 604800 },
  { label: '14 days', value: 1209600 },
  { label: '30 days', value: 2592000 },
  { label: '60 days', value: 5184000 },
  { label: '90 days', value: 7776000 },
];
