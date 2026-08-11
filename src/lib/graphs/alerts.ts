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

// A sheriff moving an alert onto the push they blame for it. The one status that
// changes *where* a marker goes; see `alertsForSeries`.
//
// Not to be confused with status 1, downstream, which also sets
// `related_summary_id` and means something else entirely: the change is real on
// this push and is a consequence of a regression tracked over there, often on
// another repository. Nothing to relocate.
export const ALERT_STATUS_REASSIGNED = 2;

export function alertStatusLabel(status: number): string {
  return ALERT_STATUS[status] ?? `status ${status}`;
}

export function summaryStatusLabel(status: number): string {
  return SUMMARY_STATUS[status] ?? `status ${status}`;
}

// Both ends of a reassignment. `SeriesAlert.summaryId` is whichever of the two
// the marker actually sits on, so comparing them says which way this reads —
// "reassigned *from* #from" once the marker moved, "reassigned *to* #to" when it
// couldn't. Perfherder's alert table words it the same way and for the same
// reason (`AlertTableRow.jsx::getReassignment`).
export type Reassignment = {
  // Where perfherder's analysis filed the alert.
  fromSummaryId: number;
  // The push a sheriff decided the change actually belongs to.
  toSummaryId: number;
};

// One alert, flattened onto the push we plotted it at.
export type SeriesAlert = {
  // The summary whose push this alert is drawn on — the reassignment target for
  // a relocated alert, so the status, bug and revisions below are that summary's
  // too. Only `amountPct`, the two values and `tValue` belong to the alert
  // itself, and those are unchanged by a reassignment: they are the numbers the
  // analysis computed over its own detection window.
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
  // Null unless a sheriff reassigned this alert to another push.
  reassignment: Reassignment | null;
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

// The reassignment an alert carries, or null if it isn't one. Read off the alert
// alone, so it says the same thing from either end: the alert stays in its
// original summary's `alerts` and appears in the target's `related_alerts`, and
// `summary_id` and `related_summary_id` name the two ends whichever list we
// happened to find it in.
function reassignmentOf(alert: Alert): Reassignment | null {
  if (alert.status !== ALERT_STATUS_REASSIGNED || alert.related_summary_id === null) return null;
  return { fromSummaryId: alert.summary_id, toSummaryId: alert.related_summary_id };
}

// The summaries `alertsForSeries` needs fetched before it can place a reassigned
// alert on the push it was moved to — one id per reassignment, deduplicated,
// since one sheriff's verdict commonly gathers a dozen summaries' alerts onto a
// single push. Empty in the ordinary case, which is what keeps this from costing
// a round trip on every series.
export function reassignmentTargetIds(
  summaries: readonly AlertSummary[],
  signatureId: number,
): number[] {
  const ids = new Set<number>();
  for (const summary of summaries) {
    const alert = alertFor(summary, signatureId);
    if (!alert || alert.status === ALERT_STATUS_INVALID) continue;
    const reassignment = reassignmentOf(alert);
    // Nothing to fetch when the summary in hand already *is* the target.
    if (reassignment && reassignment.toSummaryId !== summary.id) ids.add(reassignment.toSummaryId);
  }
  return [...ids];
}

// Every alert about `signatureId` that landed on a push this series has data
// for, in time order.
//
// The push lookup is the range filter: the endpoint answers with a superset
// (everything since the start of the range, server-side and relative to now),
// and a summary whose push isn't in `data` is one we can't place on the graph
// anyway. It also drops alerts belonging to *another* signature that happened
// to share a summary with ours.
//
// **A reassigned alert is drawn on the push it was reassigned to.** The analysis
// picks the push where the numbers moved; a sheriff who bisects it and finds the
// culprit somewhere else says so by reassigning the alert, and from then on
// perfherder's own alerts view lists it under the target push and strikes the
// original row through (`AlertTableRow.jsx::getTitleText`). Treeherder's *graph*
// keeps marking the detected push, but only because it can't see otherwise: it
// places each summary at its own `push_id` and never fetches the target
// (`createGraphData` in `perf-helpers/helpers.js`). So this is a deliberate
// deviation, and the direction of it is towards what the sheriff decided.
//
// `reassignmentTargets` is keyed by summary id, from `reassignmentTargetIds` —
// pass it and the move happens; leave it out and every marker sits where the
// analysis put it. A target that isn't in the map (the lookup failed) or whose
// push this series has no data for falls back to the detected push, which is
// still a real alert about a real change and better shown there than not at all.
export function alertsForSeries(
  summaries: readonly AlertSummary[],
  signatureId: number,
  data: SeriesData,
  reassignmentTargets?: ReadonlyMap<number, AlertSummary>,
): SeriesAlert[] {
  const out: SeriesAlert[] = [];
  for (const summary of summaries) {
    const alert = alertFor(summary, signatureId);
    if (!alert || alert.status === ALERT_STATUS_INVALID) continue;

    const reassignment = reassignmentOf(alert);
    const targetId =
      reassignment && reassignment.toSummaryId !== summary.id ? reassignment.toSummaryId : null;
    const target = targetId === null ? undefined : reassignmentTargets?.get(targetId);
    // Everything about the *push* comes from whichever summary won, including
    // the triage state and the bug: once an alert is reassigned, the summary
    // being investigated is the target's, and the original carries no bug.
    const home = target && data.pushById.has(target.push_id) ? target : summary;
    const push = data.pushById.get(home.push_id);
    if (!push) continue;

    out.push({
      summaryId: home.id,
      alertId: alert.id,
      pushId: home.push_id,
      prevPushId: home.prev_push_id,
      x: push.x,
      revision: home.revision,
      prevRevision: home.prev_push_revision,
      isRegression: alert.is_regression,
      amountPct: alert.amount_pct,
      prevValue: alert.prev_value,
      newValue: alert.new_value,
      tValue: alert.t_value ?? null,
      alertStatus: alert.status,
      summaryStatus: home.status,
      bugNumber: home.bug_number,
      reassignment,
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

// ---------------------------------------------------------------------------
// The alert as a change, in the same terms as everything else
// ---------------------------------------------------------------------------
//
// Perfherder reports a magnitude and a direction separately: `amount_pct` is
// always positive and `is_regression` says whether that was bad. The pane's two
// other change cards report a signed measurement and a verdict badge, so the
// alert card printed "2%" where they printed "-2 ms" — and on a
// higher-is-better metric those describe the same regression. These two put the
// alert in the same terms, which is what lets one component draw all three
// headlines (ChangeHeadline.svelte).
//
// **The sign comes from the alert's own pair of values, not from
// `isRegression`.** A regression on a score *is* a drop; taking the sign from
// the verdict would print "+2%" for it and contradict the values on the line
// below.

// `newValue - prevValue`, in the metric's units. Both are window averages —
// 12–24 pushes back against 12 forward — so this is a delta between those
// windows and not between two builds; the card says so underneath.
export function alertDelta(alert: SeriesAlert): number {
  return alert.newValue - alert.prevValue;
}

// `amountPct` as a signed fraction, ready for `formatSignedPercent`.
//
// Perfherder's own figure rather than one recomputed from the two values: it is
// what the alert summary shows and what a sheriff quotes. Only the sign is ours.
export function signedAmountFraction(alert: SeriesAlert): number {
  const magnitude = alert.amountPct / 100;
  return alertDelta(alert) < 0 ? -magnitude : magnitude;
}
