// Treeherder API calls that back the graphs view.
//
// Three endpoints:
//   /performance/summary/       the actual data points for one signature
//   /project/<repo>/push/<id>/  push ("build") metadata for a clicked point
//   /project/<repo>/jobs/<id>/  job ("run") metadata for a clicked point
//
// See docs/graphs.md for why we pass absolute startday/endday instead of
// treeherder's relative `interval`, and for the replicates quirk.

import { API_BASE, fetchJson } from './http';

// One row of `data[]` in a performance/summary response. With
// `replicates=true` the backend emits one of these *per replicate value*, all
// sharing the same `id` (datum id), `job_id`, `push_id` and `push_timestamp`.
export type RawDatum = {
  job_id: number;
  id: number;
  value: number;
  // Naive ISO string in UTC, e.g. "2026-07-21T06:38:40" — no zone suffix.
  push_timestamp: string;
  push_id: number;
  revision: string;
  submit_time: string | null;
};

export type RawSummary = {
  signature_id: number;
  framework_id: number;
  signature_hash: string;
  platform: string;
  test: string;
  suite: string;
  lower_is_better: boolean;
  has_subtests: boolean;
  measurement_unit: string | null;
  application: string;
  repository_name: string;
  repository_id: number;
  // "<suite> <test> <option_name> <extra_options>", composed server-side.
  name: string;
  parent_signature: number | null;
  should_alert: boolean | null;
  data: RawDatum[];
};

// A revision inside a push. `comments` is the full commit message.
export type PushRevision = {
  revision: string;
  author: string;
  comments: string;
};

export type Push = {
  id: number;
  revision: string;
  author: string;
  // Seconds since epoch (unlike the datum's ISO string).
  push_timestamp: number;
  revisions: PushRevision[];
  revision_count: number;
};

export type JobLog = { name: string; url: string };

export type Job = {
  id: number;
  job_type_name: string;
  job_type_symbol: string;
  job_group_name: string;
  job_group_symbol: string;
  platform: string;
  machine_name: string;
  // "success" | "testfailed" | "busted" | ...
  result: string;
  // "completed" | "running" | "pending"
  state: string;
  submit_timestamp: number;
  start_timestamp: number;
  end_timestamp: number;
  who: string;
  tier: number;
  push_id: number;
  task_id?: string;
  logs?: JobLog[];
};

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
  const list = await fetchJson<RawSummary[]>(
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
  return fetchJson<Push>(
    `${API_BASE}/project/${encodeURIComponent(repository)}/push/${pushId}/`,
    signal,
  );
}

export function fetchJob(
  repository: string,
  jobId: number,
  signal?: AbortSignal,
): Promise<Job> {
  return fetchJson<Job>(
    `${API_BASE}/project/${encodeURIComponent(repository)}/jobs/${jobId}/`,
    signal,
  );
}

export type RepositoryInfo = {
  id: number;
  name: string;
  dvcs_type: string;
  url: string;
};

export function fetchRepositories(signal?: AbortSignal): Promise<RepositoryInfo[]> {
  return fetchJson<RepositoryInfo[]>(`${API_BASE}/repository/`, signal);
}
