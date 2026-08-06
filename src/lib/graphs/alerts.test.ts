import { describe, expect, it } from 'vitest';
import {
  alertsByPush,
  alertsForSeries,
  alertStatusLabel,
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
