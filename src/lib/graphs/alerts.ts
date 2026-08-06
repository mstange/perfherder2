// Alert summaries → the marks the graph draws and the facts the details pane
// prints. Pure: the fetch is alertsApi.ts's, the painting chartDraw.ts's.
//
// The shape of the problem: an alert summary is about a *push*, and carries one
// alert per signature that changed on it. We plot one series, so for each
// summary there is at most one alert we care about — and only if that push is
// one we actually drew, which is how the range filter happens (see
// `alertsForSeries`).

import type { Alert, AlertSummary } from './alertsApi';
import type { SeriesData } from './graphData';

// The statuses arrive as bare numbers, so the words are ours to supply — and
// they had better be perfherder's words, since anyone reading them here will
// cross-check them there.
//
// Both maps are `summaryStatusMap` and `alertStatusMap` from treeherder's
// `ui/perfherder/perf-helpers/constants.js` — checked against master rather
// than a local checkout, because a checkout three months old still had alert 5
// and summary 9 missing (both are "infra", added since) and 9 meaning something
// else entirely. Verified a second way, by loading one summary per status at
// `/perfherder/alerts?id=N` and reading the word the live view printed.
//
// Only the real, stored statuses are here. Treeherder's map also carries
// filter-only pseudo-values — -2 "all statuses", -1 "all regressions", 10 and
// 11 for untriaged regressions and improvements — which are dropdown entries,
// not things a summary can be. Anything outside these maps is printed as
// `status N`: a status added after this was written should show up as a number
// in the UI, not as a wrong word.
export const ALERT_STATUS: Record<number, string> = {
  0: 'untriaged',
  1: 'downstream',
  2: 'reassigned',
  3: 'invalid',
  4: 'acknowledged',
  5: 'infra',
};

// Overlaps the alert statuses for the first four values and then diverges,
// which is exactly the kind of thing that makes one shared map a bug waiting to
// happen. "backedout" is perfherder's spelling, kept as it prints it.
export const SUMMARY_STATUS: Record<number, string> = {
  0: 'untriaged',
  1: 'downstream',
  2: 'reassigned',
  3: 'invalid',
  4: 'improvement',
  5: 'investigating',
  6: 'wontfix',
  7: 'fixed',
  8: 'backedout',
  9: 'infra',
};

// Sheriffs mark an alert invalid when the "change" was an artefact — a harness
// change, a bad build, noise the analysis fell for. Drawing those would put
// marks on the graph that the people who own them have already said mean
// nothing.
//
// The *only* status we drop, which is a narrower rule than perfherder's own
// alerts list, whose default filter also hides downstream, reassigned and infra
// alerts. Those three are all real changes in the data — tracked under another
// summary, or blamed on the infrastructure rather than the patch — and a graph
// is about what the data did. The pane names the status, so a marker never
// claims more than the sheriff did.
export const ALERT_STATUS_INVALID = 3;

export function alertStatusLabel(status: number): string {
  return ALERT_STATUS[status] ?? `status ${status}`;
}

export function summaryStatusLabel(status: number): string {
  return SUMMARY_STATUS[status] ?? `status ${status}`;
}

// One alert, flattened onto the push we plotted it at.
export type SeriesAlert = {
  summaryId: number;
  alertId: number;
  pushId: number;
  // The push perfherder analysed *before* this one, which is not always the
  // previous push in this graph: a series with no data on an intervening push
  // isn't analysed there. Carried as an id rather than matched on
  // `prevRevision`, so clicking a marker pins the pair perfherder actually
  // used and not a lookalike.
  prevPushId: number;
  // The plotted push's x, so the marker lands on the same pixel column as its
  // dots. Taken from the series data rather than from `push_timestamp`, which
  // is the same instant but arrives as seconds and would round differently.
  x: number;
  revision: string;
  prevRevision: string;
  isRegression: boolean;
  // Always positive; `isRegression` carries the direction.
  amountPct: number;
  prevValue: number;
  newValue: number;
  tValue: number | null;
  alertStatus: number;
  summaryStatus: number;
  bugNumber: number | null;
};

function alertFor(summary: AlertSummary, signatureId: number): Alert | null {
  for (const alert of summary.alerts) {
    if (alert.series_signature.id === signatureId) return alert;
  }
  for (const alert of summary.related_alerts ?? []) {
    if (alert.series_signature.id === signatureId) return alert;
  }
  return null;
}

// Every alert about `signatureId` that landed on a push this series has data
// for, in time order.
//
// The push lookup is the range filter: the endpoint answers with a superset
// (everything since the start of the range, server-side and relative to now),
// and a summary whose push isn't in `data` is one we can't place on the graph
// anyway. It also drops alerts belonging to *another* signature that happened
// to share a summary with ours.
export function alertsForSeries(
  summaries: readonly AlertSummary[],
  signatureId: number,
  data: SeriesData,
): SeriesAlert[] {
  const out: SeriesAlert[] = [];
  for (const summary of summaries) {
    const push = data.pushById.get(summary.push_id);
    if (!push) continue;
    const alert = alertFor(summary, signatureId);
    if (!alert || alert.status === ALERT_STATUS_INVALID) continue;
    out.push({
      summaryId: summary.id,
      alertId: alert.id,
      pushId: summary.push_id,
      prevPushId: summary.prev_push_id,
      x: push.x,
      revision: summary.revision,
      prevRevision: summary.prev_push_revision,
      isRegression: alert.is_regression,
      amountPct: alert.amount_pct,
      prevValue: alert.prev_value,
      newValue: alert.new_value,
      tValue: alert.t_value ?? null,
      alertStatus: alert.status,
      summaryStatus: summary.status,
      bugNumber: summary.bug_number,
    });
  }
  out.sort((a, b) => a.x - b.x);
  return out;
}

// By push, for the details pane: the question there is "does the build I
// clicked have an alert", which is a lookup, not a scan.
//
// One entry per push even though a push could in principle hold two alerts for
// one signature — it can't: the analysis emits one alert per (summary,
// signature) pair, and the unique constraint on `PerformanceAlert` says so.
export function alertsByPush(alerts: readonly SeriesAlert[]): Map<number, SeriesAlert> {
  const map = new Map<number, SeriesAlert>();
  for (const alert of alerts) map.set(alert.pushId, alert);
  return map;
}
