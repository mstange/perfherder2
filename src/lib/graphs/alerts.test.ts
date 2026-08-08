import { describe, expect, it } from 'vitest';
import {
  alertsByPush,
  alertsForSeries,
  alertStatusLabel,
  reassignmentTargetIds,
  summaryStatusLabel,
} from './alerts';
import type { Alert, AlertSummary } from './alertsApi';
import type { RawDatum, RawSummary } from './graphApi';
import { buildSeriesData } from './graphData';

const SIGNATURE = 42;

function datum(o: Partial<RawDatum> & { id: number; value: number }): RawDatum {
  return {
    job_id: 100 + o.id,
    push_id: 1000 + o.id,
    push_timestamp: '2026-07-21T06:00:00',
    revision: 'a'.repeat(40),
    submit_time: null,
    ...o,
  };
}

function seriesData(data: RawDatum[]) {
  const summary: RawSummary = {
    signature_id: SIGNATURE,
    framework_id: 1,
    signature_hash: 'hash',
    platform: 'linux2404-64-shippable',
    test: 'ts_paint',
    suite: 'ts_paint',
    lower_is_better: true,
    has_subtests: false,
    measurement_unit: 'ms',
    application: 'firefox',
    repository_name: 'autoland',
    repository_id: 77,
    name: 'ts_paint opt',
    parent_signature: null,
    should_alert: true,
    data,
  };
  return buildSeriesData(summary);
}

function alert(o: Partial<Alert> & { id: number; signatureId?: number }): Alert {
  const { signatureId, ...rest } = o;
  return {
    status: 0,
    series_signature: { id: signatureId ?? SIGNATURE },
    is_regression: true,
    prev_value: 100,
    new_value: 120,
    t_value: 8.5,
    amount_abs: 20,
    amount_pct: 20,
    summary_id: 900,
    related_summary_id: null,
    manually_created: false,
    starred: false,
    ...rest,
  };
}

function summary(o: Partial<AlertSummary> & { id: number; push_id: number }): AlertSummary {
  return {
    prev_push_id: o.push_id - 1,
    push_timestamp: 1784592000,
    revision: 'b'.repeat(40),
    prev_push_revision: 'c'.repeat(40),
    repository: 'autoland',
    framework: 1,
    status: 0,
    bug_number: null,
    alerts: [alert({ id: 1 })],
    ...o,
  };
}

describe('alertsForSeries', () => {
  // Two pushes with data, and a third the series never ran on.
  const data = seriesData([
    datum({ id: 1, value: 10, push_id: 7, push_timestamp: '2026-07-21T06:00:00' }),
    datum({ id: 2, value: 20, push_id: 8, push_timestamp: '2026-07-22T06:00:00' }),
  ]);

  it('places an alert on the push it belongs to', () => {
    const [placed] = alertsForSeries([summary({ id: 900, push_id: 8 })], SIGNATURE, data);
    expect(placed.pushId).toBe(8);
    // The x is the plotted push's, so the marker and the dots share a column.
    expect(placed.x).toBe(data.pushById.get(8)!.x);
    expect(placed.summaryId).toBe(900);
    expect(placed.isRegression).toBe(true);
  });

  it('carries the push perfherder measured against', () => {
    // As an id, not as `prevRevision`. Clicking a marker pins this push, and
    // the pair has to be the one the alert used — not the graph's neighbour,
    // which differs whenever the series has no data on an intervening push.
    const [placed] = alertsForSeries(
      [summary({ id: 900, push_id: 8, prev_push_id: 7 })],
      SIGNATURE,
      data,
    );
    expect(placed.prevPushId).toBe(7);
  });

  it('keeps a prev push the series never ran on', () => {
    // The alert is still real and still placeable; only its "before" is
    // missing from this graph. Dropping it here would hide the alert entirely.
    const [placed] = alertsForSeries(
      [summary({ id: 900, push_id: 8, prev_push_id: 99 })],
      SIGNATURE,
      data,
    );
    expect(placed.pushId).toBe(8);
    expect(placed.prevPushId).toBe(99);
    expect(data.pushById.has(99)).toBe(false);
  });

  it('drops a summary whose push this series has no data for', () => {
    // How the range filter happens: the endpoint answers relative to *now*, so
    // it sends summaries from before the window as well.
    expect(alertsForSeries([summary({ id: 900, push_id: 99 })], SIGNATURE, data)).toEqual([]);
  });

  it('ignores the other signatures sharing a summary', () => {
    const shared = summary({
      id: 900,
      push_id: 8,
      alerts: [alert({ id: 1, signatureId: 7 }), alert({ id: 2, signatureId: 8 })],
    });
    expect(alertsForSeries([shared], SIGNATURE, data)).toEqual([]);
  });

  it('finds our signature among a summary’s other alerts', () => {
    const shared = summary({
      id: 900,
      push_id: 8,
      alerts: [alert({ id: 1, signatureId: 7 }), alert({ id: 2, amount_pct: 3.5 })],
    });
    const [placed] = alertsForSeries([shared], SIGNATURE, data);
    expect(placed.alertId).toBe(2);
    expect(placed.amountPct).toBe(3.5);
  });

  it('reads related alerts too, which are as much about the push', () => {
    const moved = summary({
      id: 900,
      push_id: 8,
      alerts: [alert({ id: 1, signatureId: 7 })],
      related_alerts: [alert({ id: 5, status: 2 })],
    });
    const [placed] = alertsForSeries([moved], SIGNATURE, data);
    expect(placed.alertId).toBe(5);
    expect(placed.alertStatus).toBe(2);
  });

  it('skips an alert a sheriff marked invalid', () => {
    // Marking a mark on the graph that the people who own it have called an
    // artefact is worse than showing nothing.
    const invalid = summary({ id: 900, push_id: 8, alerts: [alert({ id: 1, status: 3 })] });
    expect(alertsForSeries([invalid], SIGNATURE, data)).toEqual([]);
  });

  it('sorts by push time regardless of the order they arrive in', () => {
    const placed = alertsForSeries(
      [summary({ id: 901, push_id: 8 }), summary({ id: 900, push_id: 7 })],
      SIGNATURE,
      data,
    );
    expect(placed.map((a) => a.pushId)).toEqual([7, 8]);
  });

  it('carries a null t-value through rather than inventing one', () => {
    const manual = summary({
      id: 900,
      push_id: 8,
      alerts: [alert({ id: 1, t_value: null, manually_created: true })],
    });
    expect(alertsForSeries([manual], SIGNATURE, data)[0].tValue).toBeNull();
  });
});

// A sheriff bisecting an alert and blaming a different push. Shaped after
// autoland signature 300397: alert 244501 was detected on summary 51606 (push
// 1984607) and reassigned to summary 51596 (push 1983389), which is where
// perfherder's own alerts view lists it and where bug 2059682 hangs off.
describe('alertsForSeries with a reassignment', () => {
  const data = seriesData([
    datum({ id: 1, value: 10, push_id: 7, push_timestamp: '2026-07-21T06:00:00' }),
    datum({ id: 2, value: 20, push_id: 8, push_timestamp: '2026-07-22T06:00:00' }),
    datum({ id: 3, value: 20, push_id: 9, push_timestamp: '2026-07-23T06:00:00' }),
  ]);

  // The alert as it arrives: in the detecting summary's own `alerts`, status
  // reassigned, pointing at the summary it was moved to.
  const moved = alert({ id: 1, status: 2, summary_id: 900, related_summary_id: 901 });
  const detected = summary({ id: 900, push_id: 9, prev_push_id: 7, status: 2, alerts: [moved] });
  // The target: another push entirely, and the one carrying the triage state.
  const targetSummary = summary({
    id: 901,
    push_id: 8,
    prev_push_id: 7,
    status: 5,
    bug_number: 2059682,
    alerts: [],
    related_alerts: [moved],
  });
  const targets = new Map([[901, targetSummary]]);

  it('draws the alert on the push it was reassigned to', () => {
    const [placed] = alertsForSeries([detected], SIGNATURE, data, targets);
    expect(placed.pushId).toBe(8);
    expect(placed.x).toBe(data.pushById.get(8)!.x);
    // Both ends named, and `summaryId` is the end the marker sits on — which is
    // what tells the pane to word this "reassigned from #900".
    expect(placed.summaryId).toBe(901);
    expect(placed.reassignment).toEqual({ fromSummaryId: 900, toSummaryId: 901 });
  });

  it('takes the triage state from the summary being investigated', () => {
    // The original summary's status is "reassigned" and it never gets a bug;
    // reading either off it would tell the sheriff nothing.
    const [placed] = alertsForSeries([detected], SIGNATURE, data, targets);
    expect(placed.summaryStatus).toBe(5);
    expect(placed.bugNumber).toBe(2059682);
    // The alert's own numbers are the analysis's and are not restated by a
    // reassignment, so they come across untouched.
    expect(placed.amountPct).toBe(20);
    expect(placed.prevValue).toBe(100);
    expect(placed.newValue).toBe(120);
  });

  it('pins the pair the target summary claims, not the detected one', () => {
    const [placed] = alertsForSeries(
      [summary({ id: 900, push_id: 9, prev_push_id: 7, alerts: [moved] })],
      SIGNATURE,
      data,
      new Map([[901, summary({ id: 901, push_id: 8, prev_push_id: 7, alerts: [] })]]),
    );
    expect(placed.pushId).toBe(8);
    expect(placed.prevPushId).toBe(7);
  });

  it('leaves the marker on the detected push when the target was not fetched', () => {
    // A failed lookup costs the alert its move, not its marker.
    const [placed] = alertsForSeries([detected], SIGNATURE, data);
    expect(placed.pushId).toBe(9);
    expect(placed.summaryId).toBe(900);
    // Still says so, the other way round: "reassigned to #901".
    expect(placed.reassignment).toEqual({ fromSummaryId: 900, toSummaryId: 901 });
  });

  it('leaves the marker on the detected push when the target push has no data', () => {
    // The commonest reason the analysis skipped the culprit push in the first
    // place: this series never ran on it.
    const elsewhere = new Map([[901, summary({ id: 901, push_id: 99, alerts: [] })]]);
    const [placed] = alertsForSeries([detected], SIGNATURE, data, elsewhere);
    expect(placed.pushId).toBe(9);
    expect(placed.summaryId).toBe(900);
  });

  it('draws an alert whose detected push is outside the graph on its target', () => {
    // Dropped outright before the move existed, and the move is what makes it
    // placeable: the range filter is the push lookup, and now it has two pushes
    // to try rather than one.
    const outside = summary({ id: 900, push_id: 99, alerts: [moved] });
    const [placed] = alertsForSeries([outside], SIGNATURE, data, targets);
    expect(placed.pushId).toBe(8);
    expect(placed.summaryId).toBe(901);
  });

  it('reads an alert off its target and words the reassignment the same way', () => {
    // The other end of the same relationship: found in `related_alerts`, already
    // on the right push, nothing to move.
    const [placed] = alertsForSeries([targetSummary], SIGNATURE, data, targets);
    expect(placed.pushId).toBe(8);
    expect(placed.summaryId).toBe(901);
    expect(placed.reassignment).toEqual({ fromSummaryId: 900, toSummaryId: 901 });
  });

  it('does not move a downstream alert', () => {
    // Status 1 also sets `related_summary_id`, and means something else: the
    // change is real here and is a consequence of one tracked over there, often
    // on another repository. Moving it would put the marker on a push this
    // series may not even share a repository with.
    const downstream = summary({
      id: 900,
      push_id: 9,
      alerts: [alert({ id: 1, status: 1, summary_id: 900, related_summary_id: 901 })],
    });
    const [placed] = alertsForSeries([downstream], SIGNATURE, data, targets);
    expect(placed.pushId).toBe(9);
    expect(placed.summaryId).toBe(900);
    expect(placed.reassignment).toBeNull();
  });

  it('leaves an ordinary alert with no reassignment to report', () => {
    const [placed] = alertsForSeries([summary({ id: 900, push_id: 8 })], SIGNATURE, data);
    expect(placed.reassignment).toBeNull();
  });
});

describe('reassignmentTargetIds', () => {
  const reassigned = (id: number, summaryId: number, relatedId: number | null) =>
    summary({
      id: summaryId,
      push_id: 8,
      alerts: [alert({ id, status: 2, summary_id: summaryId, related_summary_id: relatedId })],
    });

  it('asks for each target once', () => {
    // One sheriff's verdict commonly gathers a dozen summaries' alerts onto a
    // single push — fourteen of them on summary 51596.
    expect(
      reassignmentTargetIds([reassigned(1, 900, 950), reassigned(2, 901, 950)], SIGNATURE),
    ).toEqual([950]);
  });

  it('asks for nothing in the ordinary case', () => {
    // The whole point of a separate pass: no reassignment, no round trip.
    expect(reassignmentTargetIds([summary({ id: 900, push_id: 8 })], SIGNATURE)).toEqual([]);
  });

  it('ignores a summary that already is the target', () => {
    expect(reassignmentTargetIds([reassigned(1, 900, 900)], SIGNATURE)).toEqual([]);
  });

  it('ignores statuses that have nothing to move', () => {
    const downstream = summary({
      id: 900,
      push_id: 8,
      alerts: [alert({ id: 1, status: 1, summary_id: 900, related_summary_id: 950 })],
    });
    const invalid = summary({
      id: 901,
      push_id: 8,
      alerts: [alert({ id: 2, status: 3, summary_id: 901, related_summary_id: 951 })],
    });
    expect(reassignmentTargetIds([downstream, invalid], SIGNATURE)).toEqual([]);
  });

  it('ignores another signature’s reassignment', () => {
    const other = summary({
      id: 900,
      push_id: 8,
      alerts: [
        alert({ id: 1, signatureId: 7, status: 2, summary_id: 900, related_summary_id: 950 }),
      ],
    });
    expect(reassignmentTargetIds([other], SIGNATURE)).toEqual([]);
  });
});

describe('alertsByPush', () => {
  it('keys the alerts by push for the details pane lookup', () => {
    const data = seriesData([datum({ id: 1, value: 10, push_id: 7 })]);
    const alerts = alertsForSeries([summary({ id: 900, push_id: 7 })], SIGNATURE, data);
    expect(alertsByPush(alerts).get(7)?.summaryId).toBe(900);
    expect(alertsByPush(alerts).get(8)).toBeUndefined();
  });
});

describe('status labels', () => {
  it('names the statuses perfherder names', () => {
    expect(alertStatusLabel(0)).toBe('untriaged');
    expect(alertStatusLabel(4)).toBe('acknowledged');
    // The alert and summary maps diverge past 3, which is why they are two:
    // status 4 is an *acknowledged alert* or an *improvement summary*, and 5 is
    // an infra alert or an investigating summary.
    expect(alertStatusLabel(5)).toBe('infra');
    expect(summaryStatusLabel(4)).toBe('improvement');
    expect(summaryStatusLabel(5)).toBe('investigating');
    expect(summaryStatusLabel(8)).toBe('backedout');
    expect(summaryStatusLabel(9)).toBe('infra');
  });

  it('prints an unknown status rather than guessing at it', () => {
    // Statuses 5 and 9 were both absent from the constants everyone remembers
    // and present in production, so the fallback is not hypothetical.
    expect(alertStatusLabel(11)).toBe('status 11');
    expect(summaryStatusLabel(99)).toBe('status 99');
  });
});
