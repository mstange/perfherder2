// The one endpoint behind the picker's run-activity column.
//
//   /project/<repo>/performance/data/?interval=<sec>&signature_id=…(×N)
//
// Producer: `PerformanceDatumViewSet.list` in
// treeherder/webapp/api/performance_data.py. Unlike /performance/summary/,
// this one takes many signature ids per request, which is what makes an
// always-on column affordable: ~3.5 KB gzipped per signature, so a
// screenful is one request per repo.
//
// Batching is the caller's job — see MAX_IDS_PER_REQUEST in activity.ts for
// the hard limit and why it exists. Regrouping the response is also the
// caller's job (`buildActivities`), because this module deliberately holds no
// logic: it returns exactly what the endpoint sent.

import * as v from 'valibot';
import { API_BASE, fetchJson } from './http';

// One datum: one run of one signature on one push.
//
// Nullability, as elsewhere in this codebase, comes from treeherder's models
// rather than from whatever a sample happened to contain:
//
//  - `job_id` is nullable because perf data outlives jobs — the model has
//    `job = ForeignKey(null=True, on_delete=SET_NULL)`, so an expired job
//    leaves the datum with no job to point at.
//  - `value` is NOT nullable: `PerformanceDatum.value` is a plain
//    `FloatField()`. The `value is not None` guard in
//    /performance/summary/ is about the left-joined replicate column, not
//    this one — and this endpoint calls `round(value, 2)` unconditionally,
//    which would 500 rather than send a null.
//  - `push_timestamp` is an integer of unix seconds here, where
//    /performance/summary/ sends a naive ISO string for the same column.
//    See RawDatumSchema in graphApi.ts.
export const ActivityDatumSchema = v.object({
  id: v.number(),
  signature_id: v.number(),
  job_id: v.nullable(v.number()),
  push_id: v.number(),
  revision: v.string(),
  push_timestamp: v.number(),
  value: v.number(),
});
export type ActivityDatum = v.InferOutput<typeof ActivityDatumSchema>;

// Keyed by `signature_hash` — *not* by signature id, and the hash aliases
// within a repo, so one bucket can hold datums for more than one requested
// series. `buildActivities` regroups on each datum's own `signature_id` and
// ignores these keys entirely. Signatures with no data in the window are
// omitted rather than present-and-empty.
export const ActivityResponseSchema = v.record(
  v.string(),
  v.array(ActivityDatumSchema),
);
export type ActivityResponse = v.InferOutput<typeof ActivityResponseSchema>;

// The relative `interval`, not the absolute startday/endday that graphApi.ts
// uses. The reason for absolute bounds there is permalink stability
// (docs/graphs.md); nothing here is linkable, and `interval` makes the
// column's window the very same server-side filter as the signature list's.
export function activityDataUrl(
  repository: string,
  signatureIds: readonly number[],
  intervalSeconds: number,
): string {
  const params = new URLSearchParams({ interval: String(intervalSeconds) });
  for (const id of signatureIds) params.append('signature_id', String(id));
  return `${API_BASE}/project/${encodeURIComponent(repository)}/performance/data/?${params}`;
}

export function fetchActivityData(
  repository: string,
  signatureIds: readonly number[],
  intervalSeconds: number,
  signal?: AbortSignal,
): Promise<ActivityResponse> {
  return fetchJson(
    ActivityResponseSchema,
    activityDataUrl(repository, signatureIds, intervalSeconds),
    signal,
  );
}
