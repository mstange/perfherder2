// Treeherder API calls that back the graphs view.
//
// Four endpoints:
//   /performance/summary/       the actual data points for one signature, and —
//                               asked over a zero-width window — a signature's
//                               metadata on its own; see `fetchSignatureMeta`
//   /project/<repo>/push/<id>/  push ("build") metadata for a clicked point
//   /project/<repo>/jobs/<id>/  job ("run") metadata for a clicked point
//   /repository/                repo list; `dvcs_type` and `url` shape the links
//
// See docs/graphs.md for why we pass absolute startday/endday instead of
// treeherder's relative `interval`, and for the replicates quirk.

import * as v from 'valibot';
import { API_BASE, fetchJson } from '../shared/http';

// ---- Schemas -------------------------------------------------------------
// As in signaturesApi.ts: types are inferred, `v.object` tolerates fields we
// don't declare, and nullability comes from treeherder's serializers rather
// than from whatever a sample happened to contain.

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
  // The signature's own alerting policy, and the only endpoint that reports it —
  // the signatures endpoint the picker uses serializes neither. Null means the
  // signature said nothing and perfherder falls back to its global default; see
  // `alertThresholdFromSummary`.
  //
  // `alert_change_type` indexes `PerformanceSignature.ALERT_CHANGE_TYPES`:
  // 0 percentage, 1 absolute, null percentage. `alert_threshold` is read in
  // *percent* for the first and in the metric's own units for the second, which
  // is why the two can never be looked at separately.
  alert_change_type: v.nullish(v.number()),
  alert_threshold: v.nullish(v.number()),
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
  // Both come from `job.taskcluster_metadata`, so they are present or absent
  // together — the view catches the missing-relation case and skips the pair.
  // `retry_id` is the *run* number the task's artifacts hang off; see
  // `taskArtifactsUrl`.
  task_id: v.optional(v.string()),
  retry_id: v.optional(v.number()),
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

// `frameworkId` is nullable, and the parameter is then omitted.
//
// **The endpoint does not need it** — `signature` already identifies the row,
// and checked against production the two requests answer identically. The app
// always has a framework and passes it, matching treeherder's own request; the
// null case is for a caller that has only `(repository, signatureId)` and would
// otherwise have to download a repo's whole signature list to learn a number
// the response is about to hand back in `framework_id`. See src/cli/.
export function summaryUrl(
  repository: string,
  signatureId: number,
  frameworkId: number | null,
  startMs: number,
  endMs: number,
): string {
  const params = new URLSearchParams({ repository, signature: String(signatureId) });
  if (frameworkId !== null) params.set('framework', String(frameworkId));
  params.set('startday', toApiDate(new Date(startMs)));
  params.set('endday', toApiDate(new Date(endMs)));
  params.set('all_data', 'true');
  params.set('replicates', 'true');
  return `${API_BASE}/performance/summary/?${params}`;
}

// Returns null when the signature has no data in the range: the endpoint
// answers with an empty list rather than a 404.
export async function fetchSummary(
  repository: string,
  signatureId: number,
  frameworkId: number | null,
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

// One signature's metadata and none of its data, for the parent lookup in
// `appState` — a subtest carries no alerting policy of its own and inherits its
// parent's (see `resolveAlertThreshold`), so this asks about a signature nobody
// is plotting.
//
// **A zero-width window is how you ask for that.** The endpoint filters
// signatures by `last_updated` only when given a relative `interval`, so passing
// `startday === endday` skips that filter entirely and answers with the
// signature row and an empty `data` — the row is returned "even if there isn't
// performance data", per the comment in `PerformanceSummary.list`. An `interval`
// would have been the obvious way to ask and is the wrong one twice: it would
// drop a signature that has gone quiet, and it would carry back a value per push
// over the interval for a request that wants none of them.
//
// `nowMs` is the width-zero instant, and it is a parameter only so a caller can
// make the request cacheable: the answer doesn't depend on it (the filter it
// skips is the point), but `Date.now()` puts a fresh timestamp in the URL on
// every call, which is a cache miss every time for anything keyed on one.
export function fetchSignatureMeta(
  repository: string,
  signatureId: number,
  frameworkId: number | null,
  signal?: AbortSignal,
  nowMs: number = Date.now(),
): Promise<RawSummary | null> {
  return fetchSummary(repository, signatureId, frameworkId, nowMs, nowMs, signal);
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

// The most pushes one range query keeps. 300 pushes measured 344 KB in 0.63 s,
// so this is roughly a quarter-megabyte worst case — chosen to bound a
// comparison pinned across months, not because anything near it is common: a
// detected change's window is 24 pushes and "since previous" is one.
export const MAX_RANGE_PUSHES = 200;

// The *list* route of the push endpoint, which is how a range is asked for. It
// wraps its rows in `{meta, results}`, unlike the detail route above.
export const PushListSchema = v.object({ results: v.array(PushSchema) });

export type PushRange = {
  // Newest first, as the endpoint returns them.
  pushes: Push[];
  // The range was longer than `MAX_RANGE_PUSHES` and these are the newest of it.
  truncated: boolean;
};

// Every push between two revisions, inclusive of both ends — `pushlog.ts` is
// where the base end is dropped, and its comment says why.
//
// **Both endpoints are inclusive and the page size is 10.** Truncation here is
// silent: a 300-push range answered without an explicit `count` returns 10 rows
// and a `meta.count` of 10, which reads exactly like a complete answer. That is
// the trap that made treeherder's own `getCommonAlerts` quietly wrong over long
// ranges (see docs/graphs-todo.md), so this asks for one more than it will keep
// and reports the overflow rather than inferring it from a full-looking page.
export async function fetchPushRange(
  repository: string,
  fromRevision: string,
  toRevision: string,
  signal?: AbortSignal,
): Promise<PushRange> {
  const params = new URLSearchParams({
    fromchange: fromRevision,
    tochange: toRevision,
    count: String(MAX_RANGE_PUSHES + 1),
  });
  const { results } = await fetchJson(
    PushListSchema,
    `${API_BASE}/project/${encodeURIComponent(repository)}/push/?${params}`,
    signal,
  );
  // Keeping the newest keeps the pushes nearest the change being explained.
  return {
    pushes: results.slice(0, MAX_RANGE_PUSHES),
    truncated: results.length > MAX_RANGE_PUSHES,
  };
}

// One push, by revision, or null when the repository has no such push.
//
// The list route again, filtered by `revision=` — which accepts a 12-character
// prefix as well as the full 40, matching how revisions are written everywhere
// else (`shortRevision`). Verified against production.
//
// This exists for the CLI's `step` command, which has to turn "the change at
// revision X" into an instant it can split *another* series at. The other series
// routinely has no data on that push — a platform that runs the benchmark every
// few hours skips most of them — so it cannot be looked up in the data already
// fetched, which is exactly the case where the question is being asked.
export async function fetchPushByRevision(
  repository: string,
  revision: string,
  signal?: AbortSignal,
): Promise<Push | null> {
  const params = new URLSearchParams({ revision });
  const { results } = await fetchJson(
    PushListSchema,
    `${API_BASE}/project/${encodeURIComponent(repository)}/push/?${params}`,
    signal,
  );
  return results[0] ?? null;
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
