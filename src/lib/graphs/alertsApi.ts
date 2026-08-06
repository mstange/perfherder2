// The one endpoint behind alert markers.
//
//   /performance/alertsummary/?framework=<id>&alerts__series_signature=<id>
//
// Producer: `PerformanceAlertSummaryViewSet` in
// treeherder/webapp/api/performance_data.py, paginated by
// `AlertSummaryPagination`.
//
// An *alert summary* is a push: one build where the analysis found at least one
// series changing. The alerts inside it are one per signature, and a summary
// filtered by our signature still arrives carrying everyone else's — regrouping
// is alerts.ts's job, as with activityApi.ts, so that this module stays a
// description of what the endpoint sends.
//
// The parameters are treeherder's own, from
// `ui/perfherder/graphs/GraphsView.jsx::getAlertSummaries`: one request per
// plotted signature, filtered by `alerts__series_signature` and `timerange`.
//
// Two deliberate differences. Treeherder also sends `repository` (the numeric
// id, not the name our series carry); the signature filter makes it redundant,
// since signature ids are unique across repositories. And its `limit` is 30
// against our 100 — it re-requests per view, we cache per (series, range), and
// 100 summaries is more than any real signature has in a year.
//
// Without the signature filter the endpoint answers with every summary in the
// framework — 848 of them on framework 1 the day this was written, each
// carrying its whole alert list.

import * as v from 'valibot';
import { API_BASE, fetchJson } from '../shared/http';

// One signature's change on one push. Nullability from treeherder's
// `PerformanceAlert` model rather than from a sample:
//
//  - `t_value` is `FloatField(null=True)`: an alert a sheriff created by hand
//    has no test statistic behind it.
//  - `related_summary_id` is set only for a downstream or reassigned alert,
//    which is the majority of nulls in any sample.
//  - `series_signature` is the full signature row; the id is all we need to
//    know whether the alert is about the series we asked for.
export const AlertSchema = v.object({
  id: v.number(),
  // PerformanceAlert.STATUSES — see `ALERT_STATUS` in alerts.ts.
  status: v.number(),
  series_signature: v.object({ id: v.number() }),
  is_regression: v.boolean(),
  prev_value: v.number(),
  new_value: v.number(),
  t_value: v.nullish(v.number()),
  amount_abs: v.number(),
  // Always positive: the direction is `is_regression` plus the series' own
  // lower-is-better, not the sign of this.
  amount_pct: v.number(),
  summary_id: v.number(),
  related_summary_id: v.nullable(v.number()),
  manually_created: v.boolean(),
  starred: v.boolean(),
});
export type Alert = v.InferOutput<typeof AlertSchema>;

// One push's worth of alerts, plus the triage state that hangs off it.
export const AlertSummarySchema = v.object({
  id: v.number(),
  push_id: v.number(),
  prev_push_id: v.number(),
  // Unix seconds, unlike /performance/summary/'s naive ISO string for the same
  // column. Not what positions the marker — that comes from the push we already
  // plotted — but it's the only date the summary carries on its own.
  push_timestamp: v.number(),
  revision: v.string(),
  prev_push_revision: v.string(),
  repository: v.string(),
  framework: v.number(),
  // PerformanceAlertSummary.STATUSES — see `SUMMARY_STATUS` in alerts.ts.
  status: v.number(),
  bug_number: v.nullable(v.number()),
  alerts: v.array(AlertSchema),
  // Alerts moved here from another summary. Same shape, and just as much about
  // the push, so the caller reads both lists.
  related_alerts: v.optional(v.array(AlertSchema)),
});
export type AlertSummary = v.InferOutput<typeof AlertSummarySchema>;

export const AlertSummaryPageSchema = v.object({
  count: v.number(),
  next: v.nullable(v.string()),
  results: v.array(AlertSummarySchema),
});

// One page is all we ask for. `limit` is the page size, and 100 summaries for
// one signature is years of them — a busy signature in the graphs view's widest
// range (a year) had 23.
export const ALERT_PAGE_LIMIT = 100;

export function alertSummaryApiUrl(
  signatureId: number,
  frameworkId: number,
  timerangeSeconds: number,
): string {
  const params = new URLSearchParams({
    framework: String(frameworkId),
    alerts__series_signature: String(signatureId),
    // Seconds back from *now*, server-side, on the push timestamp. The view's
    // range is absolute and may end in the past, so this is deliberately a
    // superset: everything from the start of the range onwards. The caller
    // drops what falls outside — it has the plotted pushes to check against,
    // which is a stricter test than a timestamp comparison anyway.
    timerange: String(Math.ceil(timerangeSeconds)),
    limit: String(ALERT_PAGE_LIMIT),
  });
  return `${API_BASE}/performance/alertsummary/?${params}`;
}

export async function fetchAlertSummaries(
  signatureId: number,
  frameworkId: number,
  timerangeSeconds: number,
  signal?: AbortSignal,
): Promise<AlertSummary[]> {
  const page = await fetchJson(
    AlertSummaryPageSchema,
    alertSummaryApiUrl(signatureId, frameworkId, timerangeSeconds),
    signal,
  );
  return page.results;
}
