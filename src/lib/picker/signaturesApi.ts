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
