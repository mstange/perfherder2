// Treeherder's performance-signature endpoints: the big per-repo signature
// listing, plus the two small metadata tables needed to give its raw rows
// human-readable names.
//
// Transport and schemas only. The domain shape the app actually renders —
// `Series` — is built from these in series.ts, the same way graphData.ts sits
// over graphApi.ts and alerts.ts over alertsApi.ts.

import * as v from 'valibot';
import { API_BASE as BASE, fetchJson } from '../shared/http';

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

// ---- Requests ------------------------------------------------------------

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

// The option-collection map, fetched at most once per session and shared by both
// halves of the app — the picker gates its repo fetches on it, and the graphs
// view needs it to name a signature's options before that signature's data has
// arrived (see `metaFromSignature`). 9.8 KB and ~290 ms, and it changes a few
// times a year, so the memo has no expiry; a reload picks up a new collection.
//
// **The promise is memoised, not the result**, so two callers starting within the
// same tick share one request rather than making two. Which is the whole reason
// this isn't left to each side's own cache: the picker's `metadataStore` and the
// graphs view's identity fetch would otherwise each pull the table down once.
let optionMapPromise: Promise<Map<string, string[]>> | null = null;

export function fetchOptionMap(): Promise<Map<string, string[]>> {
  if (!optionMapPromise) {
    optionMapPromise = fetchOptionCollections()
      .then(buildOptionMap)
      // A failure must not be remembered — the map gates real content on both
      // sides, and the next caller should get a fresh attempt rather than a
      // permanently rejected promise.
      .catch((e) => {
        optionMapPromise = null;
        throw e;
      });
  }
  return optionMapPromise;
}

// Test seam, like `resetPickerCaches`: a module-scope memo outlives a test.
export function resetOptionMapCache(): void {
  optionMapPromise = null;
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

// The same endpoint asked about *named* signatures instead of a whole repo:
// `id` is a `getlist` filter server-side (`id__in`), so **one request answers
// for every signature the graph is plotting in that repository** — 866 bytes and
// ~160 ms for two, against 1.3 s for one of their data responses. That is what
// lets a card show its name and platform long before its dots (see
// `AppState.loadSignatureMetas`).
//
// **No `interval`, deliberately.** The interval filter is on `last_updated`, so
// passing one would answer nothing for a signature that has gone quiet — exactly
// the signature somebody is most likely to have a stale URL for. Same reasoning
// as the zero-width window in `fetchSignatureMeta`, and here it costs nothing:
// the `id` filter already names the rows.
//
// Ids not in this repository are simply absent from the map, and so is a made-up
// one — the response is not an error, and the caller keeps its placeholder.
export function signaturesByIdsUrl(repository: string, ids: readonly number[]): string {
  const params = new URLSearchParams();
  for (const id of ids) params.append('id', String(id));
  return (
    `${BASE}/project/${encodeURIComponent(repository)}/performance/signatures/` + `?${params}`
  );
}

export function fetchSignaturesByIds(
  repository: string,
  ids: readonly number[],
  signal?: AbortSignal,
): Promise<Record<string, RawSignature>> {
  return fetchJson(SignatureMapSchema, signaturesByIdsUrl(repository, ids), signal);
}
