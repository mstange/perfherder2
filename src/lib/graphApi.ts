// Treeherder API calls that back the graphs view.
//
// Three endpoints:
//   /performance/summary/       the actual data points for one signature
//   /project/<repo>/push/<id>/  push ("build") metadata for a clicked point
//   /project/<repo>/jobs/<id>/  job ("run") metadata for a clicked point
//
// See docs/graphs.md for why we pass absolute startday/endday instead of
// treeherder's relative `interval`, and for the replicates quirk.

import * as v from 'valibot';
import { API_BASE, fetchJson } from './http';

// ---- Schemas -------------------------------------------------------------
// As in api.ts: types are inferred, `v.object` tolerates fields we don't
// declare, and nullability comes from treeherder's serializers rather than
// from whatever a sample happened to contain.

// One row of `data[]` in a performance/summary response. With
// `replicates=true` the backend emits one of these *per replicate value*, all
// sharing the same `id` (datum id), `job_id`, `push_id` and `push_timestamp`.
// Producer: `PerformanceDatumSerializer` + the hand-built dicts in
// `PerformanceSummary.list`.
export const RawDatumSchema = v.object({
  // Null once treeherder has expired the job row this datum came from — it
  // keeps performance data far longer than jobs (~4 months), and nulls the
  // FK on the way out. Perf data older than that has no job to look up.
  // 153,301 of 412,451 live rows sampled over a year were null.
  job_id: v.nullable(v.number()),
  id: v.number(),
  value: v.number(),
  // Naive ISO string in UTC, e.g. "2026-07-21T06:38:40" — no zone suffix.
  push_timestamp: v.string(),
  push_id: v.number(),
  revision: v.string(),
  // `allow_null=True, default=None` on the serializer, and null in every row
  // we've observed.
  submit_time: v.nullish(v.string()),
});
export type RawDatum = v.InferOutput<typeof RawDatumSchema>;

// Producer: `PerformanceSummarySerializer`. Note `tags` is a plain space-
// separated string here, unlike the list the signatures endpoint returns for
// the same column — a good example of why one schema per endpoint, not per
// database table.
export const RawSummarySchema = v.object({
  signature_id: v.number(),
  framework_id: v.number(),
  signature_hash: v.string(),
  platform: v.string(),
  // "" for a summary series, per the model's `blank=True`.
  test: v.string(),
  suite: v.string(),
  lower_is_better: v.boolean(),
  has_subtests: v.boolean(),
  measurement_unit: v.nullable(v.string()),
  application: v.string(),
  repository_name: v.string(),
  repository_id: v.number(),
  // "<suite> <test> <option_name> <extra_options>", composed server-side.
  name: v.string(),
  // The parent's signature *id* — not its hash, unlike the signatures
  // endpoint's `parent_signature`.
  parent_signature: v.nullable(v.number()),
  should_alert: v.nullable(v.boolean()),
  data: v.array(RawDatumSchema),
});
export type RawSummary = v.InferOutput<typeof RawSummarySchema>;

// A revision inside a push. `comments` is the full commit message.
export const PushRevisionSchema = v.object({
  revision: v.string(),
  author: v.string(),
  comments: v.string(),
});
export type PushRevision = v.InferOutput<typeof PushRevisionSchema>;

// Producer: `PushSerializer`. `revisions` is capped at 20 by the serializer,
// so `revision_count` is the only source for the real total.
export const PushSchema = v.object({
  id: v.number(),
  revision: v.string(),
  author: v.string(),
  // Seconds since epoch (unlike the datum's ISO string).
  push_timestamp: v.number(),
  revisions: v.array(PushRevisionSchema),
  revision_count: v.number(),
});
export type Push = v.InferOutput<typeof PushSchema>;

export const JobLogSchema = v.object({ name: v.string(), url: v.string() });
export type JobLog = v.InferOutput<typeof JobLogSchema>;

// Producer: `JobProjectSerializer.to_representation`, plus the extras that
// `JobsViewSet.retrieve` bolts on (`logs`, and `task_id` only when the job
// has taskcluster metadata).
//
// The three timestamps go through `to_timestamp()`, which returns None for a
// datetime that isn't set — so a running job has a null `end_timestamp`, and
// a pending one a null `start_timestamp` too. Sampling completed jobs would
// never have shown that.
export const JobSchema = v.object({
  id: v.number(),
  job_type_name: v.string(),
  job_type_symbol: v.string(),
  job_group_name: v.string(),
  job_group_symbol: v.string(),
  platform: v.string(),
  machine_name: v.string(),
  // "success" | "testfailed" | "busted" | ...
  result: v.string(),
  // "completed" | "running" | "pending"
  state: v.string(),
  submit_timestamp: v.nullable(v.number()),
  start_timestamp: v.nullable(v.number()),
  end_timestamp: v.nullable(v.number()),
  who: v.string(),
  tier: v.number(),
  push_id: v.number(),
  task_id: v.optional(v.string()),
  logs: v.optional(v.array(JobLogSchema)),
});
export type Job = v.InferOutput<typeof JobSchema>;

// The summary endpoint's startday/endday are parsed as naive UTC datetimes,
// so we must not send a "Z" or an offset — `toISOString().slice(0, 19)` is
// exactly the shape it wants.
export function toApiDate(d: Date): string {
  return d.toISOString().slice(0, 19);
}

// The datum `push_timestamp` is UTC but carries no zone marker, so `new
// Date(s)` would read it as local time. Append the Z explicitly.
export function parseApiDate(s: string): number {
  return Date.parse(`${s}Z`);
}

export function summaryUrl(
  repository: string,
  signatureId: number,
  frameworkId: number,
  startMs: number,
  endMs: number,
): string {
  const params = new URLSearchParams({
    repository,
    signature: String(signatureId),
    framework: String(frameworkId),
    startday: toApiDate(new Date(startMs)),
    endday: toApiDate(new Date(endMs)),
    all_data: 'true',
    replicates: 'true',
  });
  return `${API_BASE}/performance/summary/?${params}`;
}

// Returns null when the signature has no data in the range: the endpoint
// answers with an empty list rather than a 404.
export async function fetchSummary(
  repository: string,
  signatureId: number,
  frameworkId: number,
  startMs: number,
  endMs: number,
  signal?: AbortSignal,
): Promise<RawSummary | null> {
  const list = await fetchJson(
    v.array(RawSummarySchema),
    summaryUrl(repository, signatureId, frameworkId, startMs, endMs),
    signal,
  );
  return list.length > 0 ? list[0] : null;
}

export function fetchPush(
  repository: string,
  pushId: number,
  signal?: AbortSignal,
): Promise<Push> {
  return fetchJson(
    PushSchema,
    `${API_BASE}/project/${encodeURIComponent(repository)}/push/${pushId}/`,
    signal,
  );
}

export function fetchJob(
  repository: string,
  jobId: number,
  signal?: AbortSignal,
): Promise<Job> {
  return fetchJson(
    JobSchema,
    `${API_BASE}/project/${encodeURIComponent(repository)}/jobs/${jobId}/`,
    signal,
  );
}

// Producer: `RepositorySerializer` with `fields = "__all__"`, so this is a
// small subset of a much wider row.
export const RepositoryInfoSchema = v.object({
  id: v.number(),
  name: v.string(),
  // "hg" or "git"; decides the pushlog and revision URL shapes.
  dvcs_type: v.string(),
  url: v.string(),
});
export type RepositoryInfo = v.InferOutput<typeof RepositoryInfoSchema>;

export function fetchRepositories(signal?: AbortSignal): Promise<RepositoryInfo[]> {
  return fetchJson(v.array(RepositoryInfoSchema), `${API_BASE}/repository/`, signal);
}
