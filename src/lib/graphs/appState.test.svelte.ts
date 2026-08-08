// AppState is reactive, so these run inside an `$effect.root` and use
// `flushSync` to drive the effect graph. `fetch` is stubbed: the point is the
// state machine, not the network.

import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppState, extentOf, type SeriesEntry } from './appState.svelte';
import type { Job, Push, RawDatum, RawSummary } from './graphApi';
import { buildSeriesData, MEAN_REPLICATE, metaFromSummary, seriesKey } from './graphData';

const DAY = 86400000;
const NOW = Date.UTC(2026, 6, 27, 12, 0, 0);

function datum(o: Partial<RawDatum> & { id: number; value: number }): RawDatum {
  return {
    job_id: 500 + o.id,
    push_id: 900 + o.id,
    push_timestamp: '2026-07-21T06:00:00',
    revision: 'a'.repeat(40),
    submit_time: null,
    ...o,
  };
}

function summary(signatureId: number, data: RawDatum[]): RawSummary {
  return {
    signature_id: signatureId,
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
}

// A loaded, visible series entry — enough of one for the pure helpers below,
// which only look at `data` and `plot`. `showReplicates` picks which point set
// lands in `plot` in the real app; here the caller says.
function entry(s: RawSummary, showReplicates = true): SeriesEntry {
  const ref = { repository: 'autoland', signatureId: s.signature_id, frameworkId: 1 };
  const data = buildSeriesData(s);
  return {
    ref,
    key: seriesKey(ref),
    color: '#000',
    symbol: { shape: 'circle', filled: true },
    visible: true,
    meta: metaFromSummary(s),
    data,
    plot: showReplicates ? data.replicates : data.means,
    loading: false,
    error: null,
    alerts: [],
    changes: [],
  };
}

// One datum with three replicates, plus a second push.
const SAMPLE = summary(1, [
  datum({ id: 10, value: 100, push_id: 1, push_timestamp: '2026-07-21T06:00:00' }),
  datum({ id: 10, value: 110, push_id: 1, push_timestamp: '2026-07-21T06:00:00' }),
  datum({ id: 10, value: 120, push_id: 1, push_timestamp: '2026-07-21T06:00:00' }),
  datum({ id: 11, value: 200, push_id: 2, push_timestamp: '2026-07-22T06:00:00' }),
  datum({ id: 11, value: 210, push_id: 2, push_timestamp: '2026-07-22T06:00:00' }),
]);

// A series long enough for change detection to have anything to say: 30 pushes
// at 100 then 30 at 130, one run of one value each. Signature 2, so a test can
// ask for it instead of SAMPLE.
const STEP = summary(
  2,
  Array.from({ length: 60 }, (_, i) =>
    datum({
      id: 100 + i,
      // Alternating by a hair rather than flat: a pool with no variance at all
      // gives the rank-sum test nothing to work with, which is a property of
      // the fixture and not of the detector.
      value: (i < 30 ? 100 : 130) + (i % 2),
      push_id: 100 + i,
      push_timestamp: `2026-06-${String(1 + Math.floor(i / 2)).padStart(2, '0')}T0${i % 2}:00:00`,
    }),
  ),
);

// Detail payloads have to be schema-valid now, not just truthy: the fetch
// layer validates every response (see http.ts), so `{}` would be rejected the
// same way a treeherder shape change would be.
function push(overrides: Partial<Push> = {}): Push {
  return {
    id: 1,
    revision: 'a'.repeat(40),
    author: 'someone@mozilla.com',
    push_timestamp: 1784548800,
    revision_count: 1,
    revisions: [
      { revision: 'a'.repeat(40), author: 'someone@mozilla.com', comments: 'Bug 1 - do a thing' },
    ],
    ...overrides,
  };
}

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: 510,
    job_type_name: 'test-linux2404-64-shippable/opt-talos-g1',
    job_type_symbol: 'g1',
    job_group_name: 'Talos performance tests',
    job_group_symbol: 'T',
    platform: 'linux2404-64-shippable',
    machine_name: 'i-0abc',
    result: 'success',
    state: 'completed',
    submit_timestamp: 1784548000,
    start_timestamp: 1784548400,
    end_timestamp: 1784549000,
    who: 'someone@mozilla.com',
    tier: 1,
    push_id: 1,
    task_id: 'VS4H7qUmRhq7nn_ENn1fxw',
    ...overrides,
  };
}

// One page of /performance/alertsummary/. The envelope matters as much as the
// rows: the schema rejects a bare array, which is what the endpoint would send
// if it weren't paginated.
function alertPage(results: unknown[]) {
  return { count: results.length, next: null, previous: null, results };
}

// An alert summary for SAMPLE's second push (datum 11), regressing by 95%.
function alertSummary(overrides: Record<string, unknown> = {}) {
  return {
    id: 900,
    push_id: 2,
    prev_push_id: 1,
    push_timestamp: 1784700000,
    revision: 'b'.repeat(40),
    prev_push_revision: 'c'.repeat(40),
    repository: 'autoland',
    framework: 1,
    status: 5,
    bug_number: 1234567,
    alerts: [
      {
        id: 77,
        status: 0,
        series_signature: { id: 1 },
        is_regression: true,
        prev_value: 110,
        new_value: 205,
        t_value: 9.1,
        amount_abs: 95,
        amount_pct: 86.36,
        summary_id: 900,
        related_summary_id: null,
        manually_created: false,
        starred: false,
      },
    ],
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    // Signature 2 is the long stepped series; everything else gets SAMPLE.
    if (url.includes('/performance/summary/')) {
      return json([url.includes('signature=2&') ? STEP : SAMPLE]);
    }
    if (url.includes('/performance/alertsummary/')) return json(alertPage([]));
    if (url.includes('/repository/')) return json([]);
    if (url.includes('/push/')) return json(push());
    if (url.includes('/jobs/')) return json(job());
    return json({});
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

// Build an AppState inside an effect root, run its effects, and hand both to
// the test. The caller disposes the root.
function withApp(search: string, fn: (app: AppState) => void | Promise<void>) {
  let app!: AppState;
  const dispose = $effect.root(() => {
    app = new AppState(search, NOW);
  });
  flushSync();
  return Promise.resolve(fn(app)).finally(dispose);
}

// Effects fire on a microtask; the fetch mock resolves on another.
async function settle() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    flushSync();
  }
}

describe('AppState construction', () => {
  it('defaults to a 14-day range when the URL says nothing', () =>
    withApp('', (app) => {
      expect(app.range.end - app.range.start).toBe(14 * DAY);
      expect(app.seriesRefs).toEqual([]);
      expect(app.zoom).toBeNull();
    }));

  it('restores series, range, zoom and selection from the URL', () =>
    withApp(
      `?series=autoland,1,1&range=${NOW - DAY},${NOW}&zoom=${NOW - DAY / 2},${NOW}&sel=autoland,1,10,2`,
      (app) => {
        expect(app.seriesRefs).toEqual([
          { repository: 'autoland', signatureId: 1, frameworkId: 1, visible: true },
        ]);
        expect(app.range).toEqual({ start: NOW - DAY, end: NOW });
        expect(app.zoom).toEqual({ start: NOW - DAY / 2, end: NOW });
        expect(app.selectedPoint?.datumId).toBe(10);
      },
    ));
});

describe('AppState loading', () => {
  it('fetches each series once and exposes its points', () =>
    withApp('?series=autoland,1,1', async (app) => {
      await settle();
      const summaryCalls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes('/performance/summary/'),
      );
      expect(summaryCalls).toHaveLength(1);
      expect(app.series[0].data.replicates.points).toHaveLength(5);
      expect(app.series[0].meta?.options).toBe('opt');
      expect(app.series[0].loading).toBe(false);
    }));

  it('does not refetch when unrelated state changes', () =>
    withApp('?series=autoland,1,1', async (app) => {
      await settle();
      const before = fetchMock.mock.calls.length;
      app.setPickerOpen(true);
      app.setZoom({ start: NOW - DAY, end: NOW });
      await settle();
      expect(fetchMock.mock.calls.length).toBe(before);
    }));

  it('stops rather than retrying forever when a fetch fails', () =>
    withApp('?series=autoland,1,1', async (app) => {
      fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: '' } as Response);
      // Force a refetch under the failing mock by moving to a new range.
      app.setRange({ start: NOW - 2 * DAY, end: NOW });
      await settle();
      const after = fetchMock.mock.calls.length;
      await settle();
      expect(fetchMock.mock.calls.length).toBe(after);
      expect(app.failedSeries).toHaveLength(1);
      expect(app.series[0].error).toBe('HTTP 500');
    }));

  it('retries only when asked to', () =>
    withApp('?series=autoland,1,1', async (app) => {
      fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: '' } as Response);
      app.setRange({ start: NOW - 2 * DAY, end: NOW });
      await settle();
      const after = fetchMock.mock.calls.length;
      app.retryAllFailed();
      await settle();
      expect(fetchMock.mock.calls.length).toBeGreaterThan(after);
    }));
});

describe('AppState series list', () => {
  const ref = (id: number) => ({ repository: 'autoland', signatureId: id, frameworkId: 1 });

  it('appends without duplicating an existing series', () =>
    withApp('?series=autoland,1,1', (app) => {
      app.addSeries([ref(1), ref(2)]);
      expect(app.seriesRefs.map((s) => s.signatureId)).toEqual([1, 2]);
    }));

  it('assigns colors by position, so reordering recolors', () =>
    withApp('?series=autoland,1,1&series=autoland,2,1', (app) => {
      const [first, second] = app.series.map((s) => s.color);
      app.moveSeries(0, 1);
      expect(app.series.map((s) => s.color)).toEqual([first, second]);
      expect(app.series.map((s) => s.ref.signatureId)).toEqual([2, 1]);
    }));

  it('reorders to an arbitrary position, as a drag does', () =>
    withApp('?series=autoland,1,1&series=autoland,2,1&series=autoland,3,1', (app) => {
      app.reorderSeries(0, 2);
      expect(app.series.map((s) => s.ref.signatureId)).toEqual([2, 3, 1]);
      app.reorderSeries(2, 0);
      expect(app.series.map((s) => s.ref.signatureId)).toEqual([1, 2, 3]);
    }));

  it('clamps a reorder past the end and ignores a no-op', () =>
    withApp('?series=autoland,1,1&series=autoland,2,1', (app) => {
      app.reorderSeries(0, 99);
      expect(app.series.map((s) => s.ref.signatureId)).toEqual([2, 1]);
      const before = app.seriesRefs;
      app.reorderSeries(0, 0);
      expect(app.seriesRefs).toBe(before);
    }));

  it('ignores a move off either end', () =>
    withApp('?series=autoland,1,1&series=autoland,2,1', (app) => {
      app.moveSeries(0, -1);
      app.moveSeries(1, 1);
      expect(app.series.map((s) => s.ref.signatureId)).toEqual([1, 2]);
    }));

  it('drops a selection that belonged to a removed series', () =>
    withApp('?series=autoland,1,1&sel=autoland,1,10,0', (app) => {
      app.removeSeries(ref(1));
      expect(app.selectedPoint).toBeNull();
    }));

  it('keeps a selection belonging to a different series', () =>
    withApp('?series=autoland,1,1&series=autoland,2,1&sel=autoland,2,10,0', (app) => {
      app.removeSeries(ref(1));
      expect(app.selectedPoint?.signatureId).toBe(2);
    }));

  // The picker's "Remove all n" hands down the whole array. One call, so one
  // history entry — a loop over the single-ref form would cost n Back presses
  // to undo what was one click.
  it('removes many refs in one go', () =>
    withApp('?series=autoland,1,1&series=autoland,2,1&series=autoland,3,1', (app) => {
      const pushes = history.length;
      app.removeSeries([ref(1), ref(3)]);
      expect(app.series.map((s) => s.ref.signatureId)).toEqual([2]);
      expect(history.length).toBe(pushes + 1);
    }));

  it('drops a selection belonging to any of a batch of removed series', () =>
    withApp('?series=autoland,1,1&series=autoland,2,1&sel=autoland,2,10,0', (app) => {
      app.removeSeries([ref(1), ref(2)]);
      expect(app.selectedPoint).toBeNull();
    }));

  // Guards the early return: an empty array must not push a history entry for
  // a removal that removed nothing.
  it('does nothing for an empty batch', () =>
    withApp('?series=autoland,1,1', (app) => {
      const pushes = history.length;
      app.removeSeries([]);
      expect(app.series).toHaveLength(1);
      expect(history.length).toBe(pushes);
    }));
});

describe('AppState visibility', () => {
  const ref = (id: number) => ({ repository: 'autoland', signatureId: id, frameworkId: 1 });

  it('adds series visible', () =>
    withApp('', (app) => {
      app.addSeries([ref(1)]);
      expect(app.visibleSeries).toHaveLength(1);
    }));

  it('hides and shows without removing or recoloring', () =>
    withApp('?series=autoland,1,1&series=autoland,2,1', (app) => {
      const colors = app.series.map((s) => s.color);
      app.toggleSeriesVisibility(ref(1));
      expect(app.series).toHaveLength(2);
      expect(app.visibleSeries.map((s) => s.ref.signatureId)).toEqual([2]);
      expect(app.series.map((s) => s.color)).toEqual(colors);
      app.toggleSeriesVisibility(ref(1));
      expect(app.visibleSeries).toHaveLength(2);
    }));

  it('round-trips the hidden flag through the URL', () =>
    withApp('?series=autoland,1,1,0&series=autoland,2,1', (app) => {
      expect(app.visibleSeries.map((s) => s.ref.signatureId)).toEqual([2]);
      app.showAllSeries();
      expect(location.search).not.toContain(',0');
      expect(app.visibleSeries).toHaveLength(2);
    }));

  it('ignores hidden series when computing whether there is data', () =>
    withApp('?series=autoland,1,1', async (app) => {
      await settle();
      expect(app.hasData).toBe(true);
      app.toggleSeriesVisibility(ref(1));
      expect(app.hasData).toBe(false);
    }));

  it('reports a selection hidden by its series, separately from zoom', () =>
    withApp('?series=autoland,1,1&sel=autoland,1,10,0', async (app) => {
      await settle();
      expect(app.selectionHiddenBySeries).toBe(false);
      app.toggleSeriesVisibility(ref(1));
      expect(app.selectionHiddenBySeries).toBe(true);
      expect(app.selectionInView).toBe(false);
      // The selection itself survives — hiding is not removing.
      expect(app.selection?.value).toBe(100);
    }));

  it('does not step the keyboard selection into a hidden series', () =>
    withApp('?series=autoland,1,1', async (app) => {
      await settle();
      app.toggleSeriesVisibility(ref(1));
      app.stepRun(1);
      expect(app.selectedPoint).toBeNull();
    }));
});

describe('AppState ranges', () => {
  it('clamps a zoom into a narrowed range', () =>
    withApp(`?range=${NOW - 10 * DAY},${NOW}&zoom=${NOW - 8 * DAY},${NOW - 6 * DAY}`, (app) => {
      app.setRange({ start: NOW - 7 * DAY, end: NOW });
      expect(app.zoom).toEqual({ start: NOW - 7 * DAY, end: NOW - 6 * DAY });
    }));

  it('drops a zoom that no longer overlaps', () =>
    withApp(`?range=${NOW - 10 * DAY},${NOW}&zoom=${NOW - 9 * DAY},${NOW - 8 * DAY}`, (app) => {
      app.setRange({ start: NOW - 2 * DAY, end: NOW });
      expect(app.zoom).toBeNull();
    }));

  it('rounds fractional bounds, since the URL only carries integers', () =>
    withApp('', (app) => {
      app.setRange({ start: NOW - DAY + 0.4, end: NOW + 0.6 });
      expect(app.range).toEqual({ start: NOW - DAY, end: NOW + 1 });
    }));

  it('drops a zoom that covers the whole range', () =>
    withApp(`?range=${NOW - DAY},${NOW}`, (app) => {
      app.setZoom({ start: NOW - 2 * DAY, end: NOW + DAY });
      expect(app.zoom).toBeNull();
    }));
});

describe('AppState selection', () => {
  it('resolves a selection against loaded data', () =>
    withApp('?series=autoland,1,1&sel=autoland,1,10,1', async (app) => {
      await settle();
      expect(app.selection?.value).toBe(110);
      expect(app.selection?.run.values).toEqual([100, 110, 120]);
      expect(app.selection?.push.pushId).toBe(1);
    }));

  it('reports no selection for a point that is not loaded', () =>
    withApp('?series=autoland,1,1&sel=autoland,1,999,0', async (app) => {
      await settle();
      expect(app.selection).toBeNull();
    }));

  it('steps run by run, keeping the replicate slot where it can', () =>
    withApp('?series=autoland,1,1&sel=autoland,1,10,1', async (app) => {
      await settle();
      app.stepRun(1);
      expect(app.selectedPoint).toMatchObject({ datumId: 11, replicateIndex: 1 });
      // Back to a run that has three replicates; slot 1 still exists.
      app.stepRun(-1);
      expect(app.selectedPoint).toMatchObject({ datumId: 10, replicateIndex: 1 });
    }));

  it('clamps the replicate slot when the next run has fewer', () =>
    withApp('?series=autoland,1,1&sel=autoland,1,10,2', async (app) => {
      await settle();
      app.stepRun(1);
      expect(app.selectedPoint).toMatchObject({ datumId: 11, replicateIndex: 1 });
    }));

  it('stops at the ends instead of wrapping', () =>
    withApp('?series=autoland,1,1&sel=autoland,1,10,0', async (app) => {
      await settle();
      app.stepRun(-1);
      expect(app.selectedPoint?.datumId).toBe(10);
      app.stepReplicate(-1);
      expect(app.selectedPoint?.replicateIndex).toBe(0);
      app.stepReplicate(5);
      expect(app.selectedPoint?.replicateIndex).toBe(2);
    }));

  it('selects the first point when stepping with nothing selected', () =>
    withApp('?series=autoland,1,1', async (app) => {
      await settle();
      app.stepRun(1);
      expect(app.selectedPoint).toMatchObject({ datumId: 10, replicateIndex: 0 });
    }));

  it('reports when the selected point is outside the zoomed window', () =>
    withApp('?series=autoland,1,1&sel=autoland,1,10,0', async (app) => {
      await settle();
      expect(app.selectionInView).toBe(true);
      // Datum 10 is on Jul 21; zoom to Jul 22 only.
      const jul22 = Date.UTC(2026, 6, 22, 0, 0, 0);
      app.setZoom({ start: jul22, end: jul22 + DAY });
      expect(app.selectionInView).toBe(false);
      app.resetZoom();
      expect(app.selectionInView).toBe(true);
    }));

  it('offers the previous push for the pushlog link', () =>
    withApp('?series=autoland,1,1&sel=autoland,1,11,0', async (app) => {
      await settle();
      expect(app.previousPush?.pushId).toBe(1);
    }));
});

describe('AppState comparison', () => {
  const withBoth = '?series=autoland,1,1&sel=autoland,1,10,1&cmp=autoland,1,11,0';

  it('restores a pinned comparison from the URL and describes it', () =>
    withApp(withBoth, async (app) => {
      await settle();
      expect(app.comparisonSource).toBe('pinned');
      expect(app.comparison?.kind).toBe('push');
      // Datum 10 is the Jul 21 push (100/110/120), datum 11 the Jul 22 one
      // (200/210), so the earlier one is the baseline whichever was clicked.
      expect(app.comparison?.base.values).toEqual([100, 110, 120]);
      expect(app.comparison?.next.values).toEqual([200, 210]);
      expect(app.comparison?.medianDelta).toBe(95);
    }));

  it('writes the pin to the URL and takes it back out', () =>
    withApp('?series=autoland,1,1&sel=autoland,1,10,1', async (app) => {
      await settle();
      expect(app.comparison).toBeNull();
      app.comparePoint({ repository: 'autoland', signatureId: 1, datumId: 11, replicateIndex: 0 });
      expect(location.search).toContain('cmp=autoland,1,11,0');
      expect(app.comparison?.kind).toBe('push');
      // The same shift-click again is the gesture's own undo.
      app.comparePoint({ repository: 'autoland', signatureId: 1, datumId: 11, replicateIndex: 0 });
      expect(app.comparedPoint).toBeNull();
      expect(location.search).not.toContain('cmp=');
    }));

  // Pinning the selected point is the keyboard path's first step: mark this
  // point, then walk away from it with the arrow keys.
  it('marks the selected point, which is not yet a comparison', () =>
    withApp('?series=autoland,1,1&sel=autoland,1,10,1', async (app) => {
      await settle();
      app.comparePoint(app.selectedPoint);
      expect(app.comparisonMarkedHere).toBe(true);
      expect(app.comparison).toBeNull();
      // Stepping away from it turns the mark into a comparison.
      app.stepRun(1);
      expect(app.comparisonMarkedHere).toBe(false);
      expect(app.comparison?.kind).toBe('push');
    }));

  // Shift-clicking with nothing selected used to write `cmp=` and render
  // nothing, because comparisonSource reports none without a selection.
  describe('pinning with nothing selected', () => {
    const pin = { repository: 'autoland', signatureId: 1, datumId: 11, replicateIndex: 0 };

    it('selects the point too, landing in the state the pane explains', () =>
      withApp('?series=autoland,1,1', async (app) => {
        await settle();
        expect(app.selectedPoint).toBeNull();
        app.comparePoint(pin);
        expect(app.selectedPoint).toEqual(pin);
        expect(app.comparedPoint).toEqual(pin);
        // Not a silent state any more: the pane has a branch for this one.
        expect(app.comparisonMarkedHere).toBe(true);
        expect(app.comparison).toBeNull();
      }));

    it('turns into a real comparison on the next move', () =>
      withApp('?series=autoland,1,1', async (app) => {
        await settle();
        app.comparePoint(pin);
        app.stepRun(-1);
        expect(app.comparisonMarkedHere).toBe(false);
        expect(app.comparison?.kind).toBe('push');
      }));

    it('spends one history entry', () =>
      withApp('?series=autoland,1,1', async (app) => {
        await settle();
        const before = history.length;
        app.comparePoint(pin);
        expect(history.length).toBe(before + 1);
      }));

    it('is still its own undo', () =>
      withApp('?series=autoland,1,1', async (app) => {
        await settle();
        app.comparePoint(pin);
        app.comparePoint(pin);
        expect(app.comparedPoint).toBeNull();
        // The selection stays: the second shift-click undoes the pin, and
        // clearing the selection as well would be two undos for one gesture.
        expect(app.selectedPoint).toEqual(pin);
        expect(location.search).not.toContain('cmp=');
      }));

    it('leaves an existing selection alone', () =>
      withApp('?series=autoland,1,1&sel=autoland,1,10,1', async (app) => {
        await settle();
        const sel = app.selectedPoint;
        app.comparePoint(pin);
        expect(app.selectedPoint).toEqual(sel);
        expect(app.comparison?.kind).toBe('push');
      }));
  });

  it('keeps the pin when the arrow keys step back onto it, and says so', () =>
    withApp('?series=autoland,1,1&sel=autoland,1,10,0&cmp=autoland,1,11,0', async (app) => {
      await settle();
      app.stepRun(1);
      expect(app.selectedPoint?.datumId).toBe(11);
      // Silently dropping the pin here would make walking left and then right
      // throw away a mark the user set deliberately. Moving it would be worse:
      // the pin is an anchor, and an anchor that follows the selection around
      // is not one.
      expect(app.comparedPoint?.datumId).toBe(11);
      expect(app.comparisonMarkedHere).toBe(true);
      expect(app.comparison).toBeNull();
      // And walking away again compares against the anchor, not against the
      // point we just came from.
      app.stepRun(-1);
      expect(app.comparedPoint?.datumId).toBe(11);
      expect(app.comparison?.kind).toBe('push');
    }));

  // Clicking one of the two ends is "look at that end now", not "throw the
  // comparison away" — which is what it used to be, landing in the keyboard
  // path's "marked, now move to another point" and telling a user who had just
  // built a comparison to go build one.
  it('swaps the two ends when the pinned point is clicked', () =>
    withApp(withBoth, async (app) => {
      await settle();
      const wasSelected = app.selectedPoint;
      const before = app.comparison;
      app.selectPoint({ repository: 'autoland', signatureId: 1, datumId: 11, replicateIndex: 0 });

      expect(app.selectedPoint?.datumId).toBe(11);
      expect(app.comparedPoint).toEqual(wasSelected);
      expect(app.comparisonMarkedHere).toBe(false);
      // The card doesn't move: sides are ordered by time, not by which end is
      // selected, so only the role labels trade places.
      expect(app.comparison?.base.values).toEqual(before?.base.values);
      expect(app.comparison?.next.values).toEqual(before?.next.values);
      expect(app.comparison?.medianDelta).toBe(before?.medianDelta);
      // `swapped` is what the pane reads to label each side.
      expect(app.comparison?.swapped).toBe(!before?.swapped);
    }));

  it('leaves the pin alone when the selected point itself is clicked', () =>
    withApp(withBoth, async (app) => {
      await settle();
      const pin = app.comparedPoint;
      app.selectPoint(app.selectedPoint);
      expect(app.comparedPoint).toEqual(pin);
      expect(app.comparison?.kind).toBe('push');
    }));

  // Marked-here is its own state, not half a comparison: clicking the point
  // that is both ends has nothing to swap.
  it('stays marked when the marked point is clicked', () =>
    withApp('?series=autoland,1,1&sel=autoland,1,10,1', async (app) => {
      await settle();
      app.comparePoint(app.selectedPoint);
      app.selectPoint(app.selectedPoint);
      expect(app.comparisonMarkedHere).toBe(true);
      expect(app.comparison).toBeNull();
    }));

  it('drops the pin when the selection is cleared', () =>
    withApp(withBoth, async (app) => {
      await settle();
      app.selectPoint(null);
      expect(app.comparedPoint).toBeNull();
    }));

  it('drops a pin belonging to a removed series', () =>
    withApp(
      '?series=autoland,1,1&series=autoland,2,1&sel=autoland,2,10,0&cmp=autoland,1,10,0',
      async (app) => {
        await settle();
        app.removeSeries({ repository: 'autoland', signatureId: 1, frameworkId: 1 });
        // Left in the URL, a Back to a state that still has series 1 would
        // silently resurrect a comparison against a series that's gone.
        expect(app.comparedPoint).toBeNull();
        expect(app.selectedPoint?.signatureId).toBe(2);
      },
    ));

  it('previews a hovered point, but only alongside a selection', () =>
    withApp('?series=autoland,1,1', async (app) => {
      await settle();
      const hovered = { repository: 'autoland', signatureId: 1, datumId: 11, replicateIndex: 0 };
      // Nothing selected: a hover has nothing to compare against, and every
      // mousemove would otherwise light up the pane.
      app.setHoveredPoint(hovered);
      expect(app.comparisonSource).toBeNull();
      expect(app.comparison).toBeNull();

      app.selectPoint({ repository: 'autoland', signatureId: 1, datumId: 10, replicateIndex: 1 });
      expect(app.comparisonSource).toBe('hover');
      expect(app.comparison?.kind).toBe('push');
      // Transient: no history entry, no URL.
      expect(location.search).not.toContain('cmp=');

      app.setHoveredPoint(null);
      expect(app.comparison).toBeNull();
    }));

  it('lets a pin win over a hover', () =>
    withApp(withBoth, async (app) => {
      await settle();
      // Hovering a third point must not silently replace the comparison the
      // user pinned.
      app.setHoveredPoint({ repository: 'autoland', signatureId: 1, datumId: 10, replicateIndex: 0 });
      expect(app.comparisonSource).toBe('pinned');
      expect(app.comparedSelection?.run.datumId).toBe(11);
      expect(app.hoveredSelection).toBeNull();
    }));

  it('has no comparison while the hovered point is the selection', () =>
    withApp('?series=autoland,1,1&sel=autoland,1,10,1', async (app) => {
      await settle();
      app.setHoveredPoint({ repository: 'autoland', signatureId: 1, datumId: 10, replicateIndex: 1 });
      expect(app.comparison).toBeNull();
    }));

  it('clears the pin explicitly', () =>
    withApp(withBoth, async (app) => {
      await settle();
      app.clearComparison();
      expect(app.comparedPoint).toBeNull();
      expect(app.comparison).toBeNull();
    }));
});

// "What changed here?" in one click — see `compareWithPreviousPush`.
describe('AppState compare with the previous push', () => {
  it('pins the previous push, keeping the replicate slot', () =>
    withApp('?series=autoland,1,1&sel=autoland,1,11,1', async (app) => {
      await settle();
      app.compareWithPreviousPush();
      expect(app.comparedPoint).toMatchObject({ datumId: 10, replicateIndex: 1 });
      expect(app.comparison?.kind).toBe('push');
      // The pool is the whole push either way, so the comparison is the same
      // one a shift-click on any of the earlier push's dots would produce.
      expect(app.comparison?.base.values).toEqual([100, 110, 120]);
      expect(app.comparison?.next.values).toEqual([200, 210]);
      expect(location.search).toContain('cmp=autoland,1,10,1');
    }));

  it('clamps the replicate slot to what the previous run recorded', async () => {
    // One value on the first push, three on the second: replicate 2 has no
    // counterpart to keep.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/performance/summary/')) {
        return json([
          summary(1, [
            datum({ id: 10, value: 100, push_id: 1, push_timestamp: '2026-07-21T06:00:00' }),
            datum({ id: 11, value: 200, push_id: 2, push_timestamp: '2026-07-22T06:00:00' }),
            datum({ id: 11, value: 210, push_id: 2, push_timestamp: '2026-07-22T06:00:00' }),
            datum({ id: 11, value: 220, push_id: 2, push_timestamp: '2026-07-22T06:00:00' }),
          ]),
        ]);
      }
      if (url.includes('/repository/')) return json([]);
      return json({});
    });
    await withApp('?series=autoland,1,1&sel=autoland,1,11,2', async (app) => {
      await settle();
      app.compareWithPreviousPush();
      expect(app.comparedPoint).toMatchObject({ datumId: 10, replicateIndex: 0 });
    });
  });

  it('keeps a mean selection comparing against a mean', () =>
    withApp('?series=autoland,1,1&sel=autoland,1,11,-1', async (app) => {
      await settle();
      expect(app.selection?.replicateIndex).toBe(MEAN_REPLICATE);
      app.compareWithPreviousPush();
      expect(app.comparedPoint?.replicateIndex).toBe(MEAN_REPLICATE);
    }));

  it('does nothing on the earliest push in range', () =>
    withApp('?series=autoland,1,1&sel=autoland,1,10,0', async (app) => {
      await settle();
      expect(app.previousPush).toBeNull();
      app.compareWithPreviousPush();
      expect(app.comparedPoint).toBeNull();
    }));

  it('is its own undo, like every other way of pinning', () =>
    withApp('?series=autoland,1,1&sel=autoland,1,11,0', async (app) => {
      await settle();
      app.compareWithPreviousPush();
      expect(app.comparedPoint).not.toBeNull();
      app.compareWithPreviousPush();
      expect(app.comparedPoint).toBeNull();
    }));

  it('picks the latest retrigger of the previous push', async () => {
    // Two runs on the first push; the second (job 512) is the one to pin.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/performance/summary/')) {
        return json([
          summary(1, [
            datum({ id: 10, value: 100, push_id: 1, push_timestamp: '2026-07-21T06:00:00' }),
            datum({ id: 12, value: 130, push_id: 1, push_timestamp: '2026-07-21T06:00:00' }),
            datum({ id: 11, value: 200, push_id: 2, push_timestamp: '2026-07-22T06:00:00' }),
          ]),
        ]);
      }
      if (url.includes('/repository/')) return json([]);
      return json({});
    });
    await withApp('?series=autoland,1,1&sel=autoland,1,11,0', async (app) => {
      await settle();
      app.compareWithPreviousPush();
      expect(app.comparedPoint?.datumId).toBe(12);
      // Both runs pool into the baseline regardless of which one wears the ring.
      expect(app.comparison?.base.values).toEqual([100, 130]);
    });
  });
});

describe('AppState alerts', () => {
  const withAlerts = (results: unknown[]) => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/performance/summary/')) return json([SAMPLE]);
      if (url.includes('/performance/alertsummary/')) return json(alertPage(results));
      if (url.includes('/repository/')) return json([]);
      return json({});
    });
  };

  it('hangs the alerts off the series and finds the selected one', async () => {
    withAlerts([alertSummary()]);
    await withApp('?series=autoland,1,1&sel=autoland,1,11,0', async (app) => {
      await settle();
      expect(app.series[0].alerts.map((a) => a.pushId)).toEqual([2]);
      expect(app.selectedAlert).toMatchObject({
        summaryId: 900,
        isRegression: true,
        amountPct: 86.36,
        bugNumber: 1234567,
        summaryStatus: 5,
      });
      // The other push has none, and asking about it must not resurrect one.
      app.selectPoint({ repository: 'autoland', signatureId: 1, datumId: 10, replicateIndex: 0 });
      expect(app.selectedAlert).toBeNull();
    });
  });

  it('asks for alerts once per series, after the data lands', async () => {
    withAlerts([alertSummary()]);
    await withApp('?series=autoland,1,1', async (app) => {
      await settle();
      const calls = fetchMock.mock.calls.filter((c: unknown[]) =>
        String(c[0]).includes('/alertsummary/'),
      );
      expect(calls).toHaveLength(1);
      // Filtered to the series' signature, so the response isn't the whole
      // framework's alert history.
      expect(String(calls[0][0])).toContain('alerts__series_signature=1');
      expect(app.series[0].alerts).toHaveLength(1);
    });
  });

  // The one case that needs a second request: a reassigned alert belongs on the
  // push the sheriff moved it to, and the list request can't see that summary
  // (its filter matches a summary's own alerts, and a reassigned alert is in the
  // target's `related_alerts`). Placement itself is alerts.test.ts's; what this
  // pins down is that the extra lookup happens at all, and only here.
  describe('reassignment', () => {
    const reassignedTo901 = alertSummary({
      status: 2,
      bug_number: null,
      alerts: [{ ...alertSummary().alerts[0], status: 2, related_summary_id: 901 }],
    });

    // Summary 901 sits on SAMPLE's *first* push, so a move is visible as the
    // marker changing columns.
    const target = alertSummary({ id: 901, push_id: 1, prev_push_id: 0, alerts: [] });

    const withTarget = (detail: unknown) => {
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes('/performance/summary/')) return json([SAMPLE]);
        if (url.includes('/alertsummary/901/')) return detail === null ? json({}) : json(detail);
        if (url.includes('/performance/alertsummary/')) {
          return json(alertPage([reassignedTo901]));
        }
        if (url.includes('/repository/')) return json([]);
        return json({});
      });
    };

    // Two settles: the target lookup is a second round trip, and the ordinary
    // path deliberately doesn't spend a microtask turn on it.
    const settleTwice = async () => {
      await settle();
      await settle();
    };

    it('draws the alert on the push it was reassigned to', async () => {
      withTarget(target);
      await withApp('?series=autoland,1,1', async (app) => {
        await settleTwice();
        expect(app.series[0].alerts.map((a) => a.pushId)).toEqual([1]);
        expect(app.series[0].alerts[0].summaryId).toBe(901);
        // The triage state comes with the push: 901 is the summary a sheriff is
        // investigating, and the only one of the two with a bug on it.
        expect(app.series[0].alerts[0].bugNumber).toBe(1234567);
        expect(app.series[0].alerts[0].reassignment).toEqual({
          fromSummaryId: 900,
          toSummaryId: 901,
        });
      });
    });

    it('asks for the target once, by id', async () => {
      withTarget(target);
      await withApp('?series=autoland,1,1', async (app) => {
        await settleTwice();
        const calls = fetchMock.mock.calls
          .map((c: unknown[]) => String(c[0]))
          .filter((u: string) => u.includes('/alertsummary/'));
        expect(calls.filter((u: string) => u.includes('/alertsummary/901/'))).toHaveLength(1);
        expect(app.series[0].alerts).toHaveLength(1);
      });
    });

    it('leaves the marker where it was detected when the lookup fails', async () => {
      // A bad response, not a rejection: the schema is what rejects it, and the
      // marker must survive that the same way.
      withTarget(null);
      await withApp('?series=autoland,1,1', async (app) => {
        await settleTwice();
        expect(app.series[0].alerts.map((a) => a.pushId)).toEqual([2]);
        expect(app.series[0].alerts[0].summaryId).toBe(900);
      });
    });

    it('asks for no target when nothing was reassigned', async () => {
      withAlerts([alertSummary()]);
      await withApp('?series=autoland,1,1', async (app) => {
        await settleTwice();
        const calls = fetchMock.mock.calls
          .map((c: unknown[]) => String(c[0]))
          .filter((u: string) => u.includes('/alertsummary/'));
        // The list request, and nothing else.
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain('alerts__series_signature=1');
        expect(app.series[0].alerts[0].pushId).toBe(2);
      });
    });
  });

  // Clicking a marker, and the keyboard's version of it. SAMPLE has two
  // pushes: 1 (datum 10) and 2 (datum 11). alertSummary() alerts on push 2 and
  // names push 1 as the one perfherder measured against.
  describe('selectAlert', () => {
    it('selects the alerted push and pins the one the alert measured against', async () => {
      withAlerts([alertSummary()]);
      await withApp('?series=autoland,1,1', async (app) => {
        await settle();
        app.selectAlert(app.series[0].ref, app.series[0].alerts[0]);
        expect(app.selection?.push.pushId).toBe(2);
        expect(app.comparedSelection?.push.pushId).toBe(1);
        // Both ends are the push, not one of its replicates: an alert is about
        // the build.
        expect(app.selection?.replicateIndex).toBe(MEAN_REPLICATE);
        expect(app.comparedSelection?.replicateIndex).toBe(MEAN_REPLICATE);
        // And the card the click was aiming at is now on screen.
        expect(app.selectedAlert?.summaryId).toBe(900);
        expect(app.comparison).not.toBeNull();
      });
    });

    it('pins prev_push_id rather than the previous push on the graph', async () => {
      // Perfherder skipped push 1 — the series had no data when it analysed —
      // so its "before" is a push this graph doesn't hold. Pinning push 1
      // anyway would put a before-value in the comparison card that the alert
      // never used, right under a card quoting the one it did.
      withAlerts([alertSummary({ prev_push_id: 987 })]);
      await withApp('?series=autoland,1,1', async (app) => {
        await settle();
        app.selectAlert(app.series[0].ref, app.series[0].alerts[0]);
        expect(app.selection?.push.pushId).toBe(2);
        expect(app.comparedPoint).toBeNull();
        // The alert itself still reads, which is the point of not bailing out.
        expect(app.selectedAlert?.summaryId).toBe(900);
      });
    });

    it('spends one history entry on the pair, not two', async () => {
      // selectPoint + comparePoint would push twice, and one Back would land
      // on a half-built comparison the user never asked for.
      withAlerts([alertSummary()]);
      await withApp('?series=autoland,1,1', async (app) => {
        await settle();
        const before = history.length;
        app.selectAlert(app.series[0].ref, app.series[0].alerts[0]);
        expect(history.length).toBe(before + 1);
      });
    });

    it('does nothing for an alert whose push is not loaded', async () => {
      withAlerts([alertSummary()]);
      await withApp('?series=autoland,1,1', async (app) => {
        await settle();
        const alert = { ...app.series[0].alerts[0], pushId: 999 };
        app.selectAlert(app.series[0].ref, alert);
        expect(app.selectedPoint).toBeNull();
      });
    });
  });

  describe('stepAlert', () => {
    // Both of SAMPLE's pushes alerting, so stepping has somewhere to go.
    const twoAlerts = () =>
      withAlerts([
        alertSummary(),
        alertSummary({ id: 901, push_id: 1, prev_push_id: 0 }),
      ]);

    it('orders alerts by push time, not by the order they arrived', async () => {
      twoAlerts();
      await withApp('?series=autoland,1,1', async (app) => {
        await settle();
        expect(app.visibleAlerts.map((a) => a.alert.pushId)).toEqual([1, 2]);
      });
    });

    it('enters at the first alert with nothing selected, and at the last going back', async () => {
      twoAlerts();
      await withApp('?series=autoland,1,1', async (app) => {
        await settle();
        app.stepAlert(1);
        expect(app.selection?.push.pushId).toBe(1);
        app.selectPoint(null);
        app.stepAlert(-1);
        expect(app.selection?.push.pushId).toBe(2);
      });
    });

    it('walks forward and back from the selected push', async () => {
      twoAlerts();
      await withApp('?series=autoland,1,1', async (app) => {
        await settle();
        app.stepAlert(1);
        app.stepAlert(1);
        expect(app.selection?.push.pushId).toBe(2);
        app.stepAlert(-1);
        expect(app.selection?.push.pushId).toBe(1);
      });
    });

    it('stops at the ends rather than wrapping', async () => {
      // Unlike stepRun's clamp: alerts are few and unevenly spaced, so jumping
      // from December's back to January's reads as a bug, not as a cycle.
      twoAlerts();
      await withApp('?series=autoland,1,1', async (app) => {
        await settle();
        app.stepAlert(-1);
        expect(app.selection?.push.pushId).toBe(2);
        app.stepAlert(1);
        expect(app.selection?.push.pushId).toBe(2);
        app.stepAlert(-1);
        app.stepAlert(-1);
        expect(app.selection?.push.pushId).toBe(1);
      });
    });

    it('steps from a push with no alert of its own', async () => {
      // Landing between two alerts is the normal case once you have clicked a
      // dot: the step is defined by push time, not by "the next in a list I am
      // already inside".
      twoAlerts();
      await withApp('?series=autoland,1,1&sel=autoland,1,10,0', async (app) => {
        await settle();
        expect(app.selection?.push.pushId).toBe(1);
        app.stepAlert(1);
        expect(app.selection?.push.pushId).toBe(2);
      });
    });

    it('does nothing when no visible series has an alert', async () => {
      withAlerts([]);
      await withApp('?series=autoland,1,1', async (app) => {
        await settle();
        app.stepAlert(1);
        expect(app.selectedPoint).toBeNull();
      });
    });

    it('skips a hidden series alerts', async () => {
      // The markers are gone from the graph, so the keyboard must not walk to
      // one: the selection would land on a series the user can't see.
      withAlerts([alertSummary()]);
      await withApp('?series=autoland,1,1', async (app) => {
        await settle();
        app.toggleSeriesVisibility(app.series[0].ref);
        expect(app.visibleAlerts).toEqual([]);
        app.stepAlert(1);
        expect(app.selectedPoint).toBeNull();
      });
    });
  });

  it('survives an alert endpoint that fails, and does not retry it', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/performance/summary/')) return json([SAMPLE]);
      if (url.includes('/performance/alertsummary/')) {
        return { ok: false, status: 503, statusText: '' } as Response;
      }
      if (url.includes('/repository/')) return json([]);
      return json({});
    });
    await withApp('?series=autoland,1,1&sel=autoland,1,11,0', async (app) => {
      await settle();
      // The graph is unharmed: the dots are the point, the markers decoration.
      expect(app.series[0].alerts).toEqual([]);
      expect(app.selectedAlert).toBeNull();
      expect(app.failedSeries).toEqual([]);
      const before = fetchMock.mock.calls.length;
      app.selectPoint({ repository: 'autoland', signatureId: 1, datumId: 10, replicateIndex: 0 });
      await settle();
      const after = fetchMock.mock.calls.filter((c: unknown[]) =>
        String(c[0]).includes('/alertsummary/'),
      );
      expect(after).toHaveLength(1);
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(before);
    });
  });
});

// The wiring around changes.ts: when the detection runs, what hides it, and
// what a click on a bar does. The detection itself is changes.test.ts's.
describe('AppState detected changes', () => {
  it('runs over a loaded series and finds its step', () =>
    withApp('?series=autoland,2,1', async (app) => {
      await settle();
      const changes = app.series[0].changes;
      expect(changes).toHaveLength(1);
      // STEP goes from ~100 to ~130 at push 130, and lower is better.
      expect(changes[0].afterPushId).toBe(130);
      expect(changes[0].relativeChange).toBeCloseTo(0.2985, 3);
      expect(changes[0].isRegression).toBe(true);
    }));

  it('says nothing about a series with two pushes', () =>
    withApp('?series=autoland,1,1', async (app) => {
      await settle();
      expect(app.series[0].changes).toEqual([]);
    }));

  it('hides them while the switch is off, and brings them back', () =>
    withApp('?series=autoland,2,1', async (app) => {
      await settle();
      expect(app.series[0].changes).toHaveLength(1);
      app.setChangeDetection(false);
      expect(app.series[0].changes).toEqual([]);
      // Back without a second pass over the data: the cache is kept, only the
      // reading of it is switched off.
      app.setChangeDetection(true);
      expect(app.series[0].changes).toHaveLength(1);
    }));

  it('does not run at all while the switch is off', () =>
    withApp('?series=autoland,2,1&cd=0', async (app) => {
      await settle();
      expect(app.changeDetection).toBe(false);
      expect(app.series[0].changes).toEqual([]);
    }));

  it('clicking a bar selects the push after the step and pins the one before', () =>
    withApp('?series=autoland,2,1', async (app) => {
      await settle();
      const entry = app.series[0];
      app.selectChange(entry.ref, entry.changes[0]);
      await settle();
      expect(app.selection?.push.pushId).toBe(130);
      expect(app.comparedSelection?.push.pushId).toBe(129);
      // Both ends are the run's mean, as with an alert: the finding is about
      // the build, not about one of its values.
      expect(app.selectedPoint?.replicateIndex).toBe(MEAN_REPLICATE);
      expect(app.comparedPoint?.replicateIndex).toBe(MEAN_REPLICATE);
      // …and the pane's card is keyed on the push that click selected.
      expect(app.selectedChange).toBe(entry.changes[0]);
    }));

  it('has no card on a build the detection said nothing about', () =>
    withApp('?series=autoland,2,1', async (app) => {
      await settle();
      const entry = app.series[0];
      // The push *before* the step carries the change's other end, not the
      // change itself.
      app.selectChange(entry.ref, entry.changes[0]);
      await settle();
      app.selectPoint(app.comparedPoint);
      await settle();
      expect(app.selection?.push.pushId).toBe(129);
      expect(app.selectedChange).toBeNull();
    }));

  it('drops the cache with the series data it was computed from', () =>
    withApp('?series=autoland,2,1', async (app) => {
      await settle();
      expect(app.series[0].changes).toHaveLength(1);
      app.removeSeries(app.series[0].ref);
      expect(app.series).toEqual([]);
    }));
});

// Treeherder expires job rows long before the performance data that points at
// them, so `job_id: null` is normal for anything more than a few months old.
// These cases used to leave the details pane on "loading…" indefinitely.
describe('AppState job details', () => {
  const jobCalls = () =>
    fetchMock.mock.calls.filter((c) => String(c[0]).includes('/jobs/')).length;

  it('reports a loaded job', () =>
    withApp('?series=autoland,1,1&sel=autoland,1,10,0', async (app) => {
      // Two rounds: the job lookup can only be issued once the series data
      // has landed and resolved the selection.
      await settle();
      await settle();
      expect(app.selectedJobStatus).toBe('loaded');
      expect(app.selectedJob).not.toBeNull();
    }));

  it('reports an expired job without requesting it', () => {
    const expired = summary(1, [datum({ id: 10, value: 100, push_id: 1, job_id: null })]);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/performance/summary/')) return json([expired]);
      return json({});
    });
    return withApp('?series=autoland,1,1&sel=autoland,1,10,0', async (app) => {
      await settle();
      expect(app.selection?.run.jobId).toBeNull();
      expect(app.selectedJobStatus).toBe('expired');
      expect(app.selectedJob).toBeNull();
      // `/jobs/null/` is a 500 on the real API — never ask for it.
      expect(jobCalls()).toBe(0);
    });
  });

  it('reports a failed job lookup once instead of retrying it', () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/performance/summary/')) return json([SAMPLE]);
      if (url.includes('/jobs/')) {
        return { ok: false, status: 404, statusText: 'Not Found' } as Response;
      }
      return json({});
    });
    return withApp('?series=autoland,1,1&sel=autoland,1,10,0', async (app) => {
      await settle();
      expect(app.selectedJobStatus).toBe('failed');
      expect(jobCalls()).toBe(1);
      // Moving within the same run re-runs the selection effect; the negative
      // cache has to stop it reissuing the same doomed lookup.
      app.selectPoint({
        repository: 'autoland',
        signatureId: 1,
        datumId: 10,
        replicateIndex: 1,
      });
      await settle();
      expect(app.selectedJobStatus).toBe('failed');
      expect(jobCalls()).toBe(1);
    });
  });
});

// The profile-comparison link needs a job lookup *and* an artifact list per
// side, and only for a pinned comparison — the hover preview crosses a dot per
// mouse move.
describe('AppState profile comparison', () => {
  const COMPACT = 'public/test_info/profile_speedometer3_compact.jslb.gz';

  // Datum 10's job is 510 and datum 11's is 511 (see `datum`), so each side of
  // the comparison lands on its own task.
  const TASKS = new Map([
    [510, 'BASETASK'],
    [511, 'NEXTTASK'],
  ]);

  // `names` decides which tasks uploaded a comparable profile; anything not
  // named gets a task with a log and nothing else.
  function stubProfiles(names: Map<string, string[]>) {
    fetchMock.mockImplementation(async (url: string) => {
      const s = String(url);
      if (s.includes('/performance/summary/')) return json([SAMPLE]);
      if (s.includes('/performance/alertsummary/')) return json(alertPage([]));
      if (s.includes('/repository/')) return json([]);
      if (s.includes('/push/')) return json(push());
      const jobId = Number(/\/jobs\/(\d+)\//.exec(s)?.[1]);
      if (jobId) {
        return json(job({ id: jobId, task_id: TASKS.get(jobId), retry_id: 0 }));
      }
      const taskId = /\/task\/([^/]+)\/runs\//.exec(s)?.[1];
      if (taskId) {
        const artifacts = names.get(taskId) ?? ['public/logs/live.log'];
        return json({ artifacts: artifacts.map((name) => ({ name })) });
      }
      return json({});
    });
  }

  const bothSides = () =>
    new Map([
      ['BASETASK', [COMPACT, 'public/logs/live.log']],
      ['NEXTTASK', [COMPACT]],
    ]);

  const pinned = '?series=autoland,1,1&sel=autoland,1,10,0&cmp=autoland,1,11,0';

  it('links both runs once the two artifact lists have landed', () => {
    stubProfiles(bothSides());
    return withApp(pinned, async (app) => {
      await settle();
      await settle();
      const link = app.profileComparison;
      expect(link?.benchmark).toBe('speedometer3');
      const profiles = new URL(link!.url).searchParams.getAll('profiles[]');
      // Base first, and base is the chronologically earlier push — datum 10,
      // job 510 — whichever end the user selected.
      expect(decodeURIComponent(profiles[0])).toContain('/task/BASETASK/runs/0/');
      expect(decodeURIComponent(profiles[1])).toContain('/task/NEXTTASK/runs/0/');
    });
  });

  it('offers nothing when only one side profiled', () => {
    stubProfiles(new Map([['BASETASK', [COMPACT]]]));
    return withApp(pinned, async (app) => {
      await settle();
      await settle();
      expect(app.profileComparison).toBeNull();
    });
  });

  // A hovered comparison is a preview the pointer takes away again. Following it
  // would be two lookups per dot crossed, for a link nobody can click.
  it('neither links nor fetches for a hovered comparison', () => {
    stubProfiles(bothSides());
    return withApp('?series=autoland,1,1&sel=autoland,1,10,0', async (app) => {
      await settle();
      await settle();
      const before = fetchMock.mock.calls.length;
      app.setHoveredPoint({
        repository: 'autoland',
        signatureId: 1,
        datumId: 11,
        replicateIndex: 0,
      });
      await settle();
      expect(app.comparisonSource).toBe('hover');
      expect(app.comparison).not.toBeNull();
      expect(app.profileComparison).toBeNull();
      expect(fetchMock.mock.calls.length).toBe(before);
    });
  });

  // Pinning is what authorizes the second pair of lookups, so it has to reach
  // the link without a reload.
  it('picks the link up when a comparison is pinned', () => {
    stubProfiles(bothSides());
    return withApp('?series=autoland,1,1&sel=autoland,1,10,0', async (app) => {
      await settle();
      await settle();
      expect(app.profileComparison).toBeNull();
      app.comparePoint({
        repository: 'autoland',
        signatureId: 1,
        datumId: 11,
        replicateIndex: 0,
      });
      await settle();
      await settle();
      expect(app.profileComparison?.artifact).toBe(COMPACT);
    });
  });

  // Both sides resolve to one task, so the link would compare a profile with
  // itself. `benchmarkComparison` refuses; this pins that the two selections
  // really do arrive as the same task run.
  it('offers nothing for two replicates of one run', () => {
    stubProfiles(bothSides());
    return withApp(
      '?series=autoland,1,1&sel=autoland,1,10,0&cmp=autoland,1,10,2',
      async (app) => {
        await settle();
        await settle();
        expect(app.comparison?.kind).toBe('replicate');
        expect(app.profileComparison).toBeNull();
      },
    );
  });
});

describe('AppState URL sync', () => {
  it('writes the view back to the query string', () =>
    withApp('?series=autoland,1,1', (app) => {
      app.setZoom({ start: NOW - DAY, end: NOW });
      expect(location.search).toContain('series=autoland,1,1');
      expect(location.search).toContain(`zoom=${NOW - DAY},${NOW}`);
    }));

  it('pushes history for discrete actions and replaces during a drag', () =>
    withApp('?series=autoland,1,1', (app) => {
      const before = history.length;
      // Three frames of a drag: the view updates, the history doesn't grow.
      app.setZoom({ start: NOW - 3 * DAY, end: NOW }, true);
      app.setZoom({ start: NOW - 2 * DAY, end: NOW }, true);
      app.setZoom({ start: NOW - DAY, end: NOW }, true);
      expect(history.length).toBe(before);
      // Releasing the pointer commits one entry.
      app.setZoom({ start: NOW - DAY, end: NOW - DAY / 2 });
      expect(history.length).toBe(before + 1);
    }));

  it('does not write back the state it just read from the URL', () => {
    const search = `?series=autoland,1,1&range=${NOW - DAY},${NOW}`;
    history.replaceState(null, '', `/${search}`);
    const before = history.length;
    return withApp(search, () => {
      expect(history.length).toBe(before);
      expect(location.search).toBe(search);
    });
  });

  it('applies a popstate without pushing another entry', () =>
    withApp('?series=autoland,1,1', (app) => {
      const before = history.length;
      app.onPopState('?series=autoland,7,1');
      expect(app.seriesRefs.map((s) => s.signatureId)).toEqual([7]);
      expect(history.length).toBe(before);
    }));
});

describe('AppState picker prefill', () => {
  // The shared mock answers every signature with the same summary; these tests
  // need each series to differ, so they install their own.
  function stubSummaries(bySignature: Map<number, RawSummary>) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const s = String(url);
        if (s.includes('/performance/summary/')) {
          const id = Number(/signature=(\d+)/.exec(s)?.[1]);
          const found = bySignature.get(id);
          return json(found ? [found] : []);
        }
        if (s.includes('/repository/')) return json([]);
        return json({});
      }),
    );
  }

  function meta(signatureId: number, o: Partial<RawSummary>): RawSummary {
    return {
      ...summary(signatureId, []),
      platform: 'macosx1500-aarch64-shippable',
      suite: 'speedometer3',
      test: '',
      name: 'speedometer3 opt',
      ...o,
    };
  }

  // Two speedometer3 series that differ only by browser: everything else is
  // shared, so everything else becomes a chip.
  const TWO_BROWSERS = new Map([
    [1, meta(1, { application: 'chrome' })],
    [2, meta(2, { application: 'safari' })],
  ]);

  it('prefills from what the plotted series share', () => {
    stubSummaries(TWO_BROWSERS);
    return withApp('?series=mozilla-central,1,1&series=mozilla-central,2,1', async (app) => {
      await settle();
      app.setPickerOpen(true);
      expect(app.pickerView.filter).toEqual({
        chips: [
          { field: 'suite', value: 'speedometer3' },
          { field: 'platform', value: 'macosx1500-aarch64-shippable' },
          { field: 'option', value: 'opt' },
        ],
        text: '',
      });
    });
  });

  it('expresses the repository as a repo selection, not a chip', () => {
    stubSummaries(TWO_BROWSERS);
    return withApp('?series=mozilla-central,1,1&series=autoland,2,1', async (app) => {
      await settle();
      app.setPickerOpen(true);
      expect(app.pickerView.filter.chips.some((c) => c.field === 'repo')).toBe(false);
      expect(app.pickerView.repos).toEqual(['mozilla-central', 'autoland']);
    });
  });

  it('prefills from a single series too', () => {
    stubSummaries(TWO_BROWSERS);
    return withApp('?series=mozilla-central,1,1', async (app) => {
      await settle();
      app.setPickerOpen(true);
      // Unlike the series list's header, one series is enough here: it is the
      // context to search from.
      expect(app.pickerView.filter.chips).toContainEqual({ field: 'application', value: 'chrome' });
    });
  });

  it('includes the subtest name when the series are subtests', () => {
    stubSummaries(
      new Map([
        [1, meta(1, { suite: 'bing-search', test: 'fcp', name: 'bing-search fcp opt cold' })],
      ]),
    );
    return withApp('?series=autoland,1,1', async (app) => {
      await settle();
      app.setPickerOpen(true);
      expect(app.pickerView.filter.chips).toContainEqual({ field: 'test', value: 'fcp' });
      expect(app.pickerView.filter.chips).toContainEqual({ field: 'option', value: 'cold' });
    });
  });

  it('leaves a filter the user has edited alone', () => {
    stubSummaries(TWO_BROWSERS);
    return withApp('?series=mozilla-central,1,1&series=mozilla-central,2,1', async (app) => {
      await settle();
      app.setPickerOpen(true);
      app.setPickerOpen(false);
      app.setPickerView({
        ...app.pickerView,
        filter: { chips: [{ field: 'suite', value: 'jetstream3' }], text: 'chrome' },
      });
      app.setPickerOpen(true);
      expect(app.pickerView.filter).toEqual({
        chips: [{ field: 'suite', value: 'jetstream3' }],
        text: 'chrome',
      });
    });
  });

  it('re-derives an untouched prefill when the series change', () => {
    stubSummaries(TWO_BROWSERS);
    return withApp('?series=mozilla-central,1,1', async (app) => {
      await settle();
      app.setPickerOpen(true);
      expect(app.pickerView.filter.chips).toContainEqual({ field: 'application', value: 'chrome' });
      // Adding a second series makes `application` differ, so it should drop
      // out of the prefill on the next open rather than pinning the picker to
      // a browser the set no longer shares.
      app.setPickerOpen(false);
      app.addSeries([{ repository: 'mozilla-central', signatureId: 2, frameworkId: 1 }]);
      await settle();
      app.setPickerOpen(true);
      expect(app.pickerView.filter.chips.some((c) => c.field === 'application')).toBe(false);
      expect(app.pickerView.filter.chips).toContainEqual({ field: 'suite', value: 'speedometer3' });
    });
  });

  it('ignores series the summary endpoint knows nothing about', () => {
    // Signature 2 has no data in range, so its metadata is the placeholder
    // whose suite reads "signature 2". Filtering on that would match nothing.
    stubSummaries(new Map([[1, meta(1, { application: 'chrome' })]]));
    return withApp('?series=mozilla-central,1,1&series=mozilla-central,2,1', async (app) => {
      await settle();
      app.setPickerOpen(true);
      expect(app.pickerView.filter.chips).toEqual([
        { field: 'suite', value: 'speedometer3' },
        { field: 'platform', value: 'macosx1500-aarch64-shippable' },
        { field: 'application', value: 'chrome' },
        { field: 'option', value: 'opt' },
      ]);
    });
  });

  it('prefills nothing when every series is a placeholder', () => {
    stubSummaries(new Map());
    return withApp('?series=mozilla-central,1,1', async (app) => {
      await settle();
      app.setPickerOpen(true);
      expect(app.pickerView.filter.chips).toEqual([]);
    });
  });

  it('prefills nothing when no series are plotted', () =>
    withApp('', (app) => {
      app.setPickerOpen(true);
      expect(app.pickerView.filter).toEqual({ chips: [], text: '' });
    }));

  it('does not prefill while the metadata is still in flight', () => {
    stubSummaries(TWO_BROWSERS);
    return withApp('?series=mozilla-central,1,1', (app) => {
      // No `settle()`: the summary fetch hasn't resolved, so there is nothing
      // to derive from. The next open picks it up.
      app.setPickerOpen(true);
      expect(app.pickerView.filter.chips).toEqual([]);
    });
  });

  it('carries the prefill into the URL', () => {
    stubSummaries(TWO_BROWSERS);
    return withApp('?series=mozilla-central,1,1&series=mozilla-central,2,1', async (app) => {
      await settle();
      app.setPickerOpen(true);
      expect(location.search).toContain('pc=suite:speedometer3');
      expect(location.search).toContain('pc=option:opt');
      // The prefill's repos too — they decide which rows the filter has to
      // work with, so a link without them opens on a different list.
      expect(location.search).toContain('pr=mozilla-central');
    });
  });

  it('resets an untouched panel to its defaults on reopen', () => {
    stubSummaries(TWO_BROWSERS);
    return withApp('?series=mozilla-central,1,1', async (app) => {
      await settle();
      app.setPickerOpen(true);
      app.setPickerView({ ...app.pickerView, intervalSeconds: 7776000, sort: null });
      app.setPickerOpen(false);
      // The filter is still the prefill, so the whole view is re-derived —
      // the same thing a panel mounted fresh on every open used to do.
      app.setPickerOpen(true);
      expect(app.pickerView.intervalSeconds).toBeNull();
    });
  });
});

describe('AppState picker URL state', () => {
  it('writes the whole panel state and reads it back', () =>
    withApp('', async (app) => {
      app.setPickerOpen(true);
      app.setPickerView({
        filter: { chips: [{ field: 'suite', value: 'speedometer3' }], text: 'chrome' },
        repos: ['try', 'mozilla-beta'],
        intervalSeconds: 604800,
        matchSubtests: true,
        sort: { column: 'platform', direction: 'desc' },
      });
      const shared = location.search;
      // What a reload of the shared link builds.
      await withApp(shared, (reloaded) => {
        expect(reloaded.pickerOpen).toBe(true);
        expect(reloaded.pickerView).toEqual(app.pickerView);
      });
    }));

  it('replaces rather than pushes while the panel is worked', () =>
    withApp('', (app) => {
      const before = history.length;
      app.setPickerOpen(true);
      const afterOpen = history.length;
      app.setPickerView({ ...app.pickerView, intervalSeconds: 604800 });
      app.setPickerView({ ...app.pickerView, matchSubtests: true });
      // Opening is one discrete action worth a history entry; the knobs inside
      // belong to it.
      expect(afterOpen).toBe(before + 1);
      expect(history.length).toBe(afterOpen);
    }));

  it('drops the panel state from the URL when it closes', () =>
    withApp('', (app) => {
      app.setPickerOpen(true);
      app.setPickerView({ ...app.pickerView, repos: ['try'], matchSubtests: true });
      app.setPickerOpen(false);
      expect(location.search).not.toContain('pr=');
      expect(location.search).not.toContain('psub=');
      expect(location.search).not.toContain('picker=');
    }));

  it('restores the panel state on a back navigation', () =>
    withApp('?picker=1&pr=try&pi=604800&psub=1&psort=unit:asc', (app) => {
      expect(app.pickerView.repos).toEqual(['try']);
      app.setPickerView({ ...app.pickerView, repos: ['autoland'], matchSubtests: false });
      app.onPopState('?picker=1&pr=try&pi=604800&psub=1&psort=unit:asc');
      expect(app.pickerOpen).toBe(true);
      expect(app.pickerView).toEqual({
        filter: { chips: [], text: '' },
        repos: ['try'],
        intervalSeconds: 604800,
        matchSubtests: true,
        sort: { column: 'unit', direction: 'asc' },
      });
    }));
});

describe('AppState y domains', () => {
  it('spans everything for the overview and only the window for the detail', () =>
    withApp('?series=autoland,1,1', async (app) => {
      await settle();
      // Sample values run 100..210 across two days.
      expect(app.fullYDomain.min).toBeLessThan(100);
      expect(app.fullYDomain.max).toBeGreaterThan(210);

      const firstPushDay = Date.UTC(2026, 6, 21, 6, 0, 0);
      app.setZoom({ start: firstPushDay - 3600000, end: firstPushDay + 3600000 });
      expect(app.detailYDomain.max).toBeLessThan(150);
    }));
});

// The whole point of this one: hovering a dot must not rescale the details pane's
// distribution chart, and the axis is what decides that.
describe('AppState selectionChart', () => {
  const selected = '?series=autoland,1,1&sel=autoland,1,10,1';

  it('is null with nothing selected', () =>
    withApp('?series=autoland,1,1', async (app) => {
      await settle();
      expect(app.selectionChart).toBeNull();
    }));

  it('does not move when the compared or hovered point does', () =>
    withApp(selected, async (app) => {
      await settle();
      const before = app.selectionChart?.scales;
      expect(before).toBeDefined();
      // Three replicates is below MIN_CURVE_VALUES, so this selection has no curve
      // of its own and no height to protect; the axis still has to hold still.
      expect(before!.densityCeiling).toBe(0);

      const other = { repository: 'autoland', signatureId: 1, datumId: 11, replicateIndex: 0 };
      app.setHoveredPoint(other);
      expect(app.comparisonSource).toBe('hover');
      expect(app.selectionChart?.scales).toEqual(before);

      app.comparePoint(other);
      expect(app.comparisonSource).toBe('pinned');
      expect(app.selectionChart?.scales).toEqual(before);
    }));

  it('is the selected pool with headroom, not the whole series', () =>
    withApp(selected, async (app) => {
      await settle();
      // The selected push is 100..120; the other one, 200..210, is a *hover* away
      // and deliberately not on the axis. Covering every push a hover could reach
      // is what the first version of this did, and on a series with outliers it
      // left the selected distribution 2% of the plot.
      const axis = app.selectionChart!.scales.axis;
      expect(axis.min).toBeLessThan(100);
      expect(axis.max).toBeGreaterThan(120);
      expect(axis.max).toBeLessThan(200);
    }));

  it('does not follow the zoom, since it never looked at the window', () =>
    withApp(selected, async (app) => {
      await settle();
      const before = app.selectionChart!.scales.axis;
      const firstPushDay = Date.UTC(2026, 6, 21, 6, 0, 0);
      app.setZoom({ start: firstPushDay - 3600000, end: firstPushDay + 3600000 });
      expect(app.selectionChart!.scales.axis).toEqual(before);
    }));

  it('stays on the selection when the zoom excludes it', () =>
    withApp(selected, async (app) => {
      await settle();
      // A selection survives a zoom that scrolls it off screen — the pane says so
      // and offers to reset — and the pane still draws its values.
      const secondPushDay = Date.UTC(2026, 6, 22, 6, 0, 0);
      app.setZoom({ start: secondPushDay - 3600000, end: secondPushDay + 3600000 });
      expect(app.selectionInView).toBe(false);
      expect(app.selectionChart!.scales.axis.min).toBeLessThan(100);
      expect(app.selectionChart!.scales.axis.max).toBeGreaterThan(120);
    }));

  it('reserves height above the selected pool own peak', async () => {
    // Five replicates, so the selected push has a curve — and the ceiling above it
    // is what a hovered pool has to exceed before the band's scale moves.
    const withCurve = summary(1, [
      ...[100, 104, 110, 116, 120].map((value) =>
        datum({ id: 10, value, push_id: 1, push_timestamp: '2026-07-21T06:00:00' }),
      ),
      ...[200, 210].map((value) =>
        datum({ id: 11, value, push_id: 2, push_timestamp: '2026-07-22T06:00:00' }),
      ),
    ]);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/performance/summary/')) return json([withCurve]);
      if (url.includes('/repository/')) return json([]);
      if (url.includes('/push/')) return json(push());
      if (url.includes('/jobs/')) return json(job());
      return json({});
    });
    await withApp(selected, async (app) => {
      await settle();
      const ceiling = app.selectionChart!.scales.densityCeiling;
      expect(ceiling).toBeGreaterThan(0);
      // And it doesn't budge for the hover, which is the whole point.
      app.setHoveredPoint({
        repository: 'autoland',
        signatureId: 1,
        datumId: 11,
        replicateIndex: 0,
      });
      expect(app.selectionChart!.scales.densityCeiling).toBe(ceiling);
    });
  });

  it('has room for a nearby pool but not a distant one', async () => {
    // The headroom is the whole trade: a hover onto push 2 changes nothing,
    // because its values are inside the axis already, while push 3 has to widen it
    // — which `buildDistribution` does, since both distributions have to fit.
    const spread = summary(1, [
      ...[100, 110, 120].map((value) =>
        datum({ id: 10, value, push_id: 1, push_timestamp: '2026-07-21T06:00:00' }),
      ),
      ...[104, 112, 118].map((value) =>
        datum({ id: 11, value, push_id: 2, push_timestamp: '2026-07-22T06:00:00' }),
      ),
      ...[400, 410, 420].map((value) =>
        datum({ id: 12, value, push_id: 3, push_timestamp: '2026-07-23T06:00:00' }),
      ),
    ]);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/performance/summary/')) return json([spread]);
      if (url.includes('/repository/')) return json([]);
      if (url.includes('/push/')) return json(push());
      if (url.includes('/jobs/')) return json(job());
      return json({});
    });
    await withApp(selected, async (app) => {
      await settle();
      const axis = app.selectionChart!.scales.axis;
      expect(axis.min).toBeLessThan(104);
      expect(axis.max).toBeGreaterThan(118);
      expect(axis.max).toBeLessThan(400);
    });
  });

  it('reserves the density band when any hoverable push has enough values', () =>
    withApp(selected, async (app) => {
      await settle();
      // Push 1 has three replicates and push 2 has two, so neither draws a curve
      // — and reserving space for one would be a permanently empty band.
      expect(app.selectionChart!.reserveBand).toBe(false);
    }));

  it('reserves it for a series that straddles MIN_CURVE_VALUES', async () => {
    // Four replicates on one push, two on the other: hovering between them used
    // to add and remove the density band, 73px at a time.
    const straddles = summary(1, [
      ...[100, 105, 110, 115].map((value) =>
        datum({ id: 10, value, push_id: 1, push_timestamp: '2026-07-21T06:00:00' }),
      ),
      ...[200, 210].map((value) =>
        datum({ id: 11, value, push_id: 2, push_timestamp: '2026-07-22T06:00:00' }),
      ),
    ]);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/performance/summary/')) return json([straddles]);
      if (url.includes('/repository/')) return json([]);
      if (url.includes('/push/')) return json(push());
      if (url.includes('/jobs/')) return json(job());
      return json({});
    });
    await withApp('?series=autoland,1,1&sel=autoland,1,11,0', async (app) => {
      await settle();
      // The selected push is the two-value one, which has no curve of its own.
      expect(app.selection?.run.values).toEqual([200, 210]);
      expect(app.selectionChart!.reserveBand).toBe(true);
    });
  });

  it('reserves it for a curve in another visible series', async () => {
    // The pointer can land on any drawn dot, and comparing across two series is
    // an ordinary thing to want, so a series that never draws a curve of its own
    // still has to reserve the band when it is plotted next to one that does.
    // Scanning only the selected series' pushes missed this.
    const flat = summary(1, [
      datum({ id: 10, value: 100, push_id: 1, push_timestamp: '2026-07-21T06:00:00' }),
      datum({ id: 11, value: 101, push_id: 2, push_timestamp: '2026-07-22T06:00:00' }),
    ]);
    const curvy = summary(2, [
      ...[200, 205, 210, 215].map((value) =>
        datum({ id: 20, value, push_id: 1, push_timestamp: '2026-07-21T06:00:00' }),
      ),
    ]);
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/performance/summary/')) {
        return json([url.includes('signature=2') ? curvy : flat]);
      }
      if (url.includes('/repository/')) return json([]);
      if (url.includes('/push/')) return json(push());
      if (url.includes('/jobs/')) return json(job());
      return json({});
    });

    // Alone, the flat series reserves nothing: a permanently empty band is 73px
    // of labelled nothing.
    await withApp('?series=autoland,1,1&sel=autoland,1,10,0', async (app) => {
      await settle();
      expect(app.selectionChart!.reserveBand).toBe(false);
    });

    await withApp('?series=autoland,1,1&series=autoland,2,1&sel=autoland,1,10,0', async (app) => {
      await settle();
      expect(app.selectionChart!.reserveBand).toBe(true);
    });

    // Hidden series can't be hovered, so they don't get a say.
    await withApp(
      '?series=autoland,1,1&series=autoland,2,1,0&sel=autoland,1,10,0',
      async (app) => {
        await settle();
        expect(app.selectionChart!.reserveBand).toBe(false);
      },
    );
  });
});

describe('AppState page title', () => {
  it('names the plotted series once their metadata lands', () =>
    withApp('?series=autoland,1,1', async (app) => {
      // Before the fetch resolves there is nothing to name it by.
      expect(app.pageTitle).toBe('1 series — Perfherder Graphs');
      await settle();
      expect(app.pageTitle).toBe(
        'ts_paint · firefox · linux2404-64-shippable — Perfherder Graphs',
      );
    }));

  it('counts them when there is more than one', () =>
    withApp('?series=autoland,1,1&series=autoland,2,1', async (app) => {
      await settle();
      expect(app.pageTitle).toContain('2 series');
    }));

  it('names the panel while it is open, whatever is plotted', () =>
    withApp('?series=autoland,1,1', async (app) => {
      await settle();
      app.setPickerOpen(true);
      expect(app.pageTitle).toBe('Add series — Perfherder Graphs');
      app.setPickerOpen(false);
      expect(app.pageTitle).toContain('ts_paint');
    }));

  it('is the bare app name with nothing plotted', () =>
    withApp('', (app) => {
      expect(app.pageTitle).toBe('Perfherder Graphs');
    }));
});

describe('AppState replicate drawing', () => {
  // SAMPLE: one run of three replicates (100/110/120, mean 110) and one of two
  // (200/210, mean 205).
  it('collapses each run to one dot at its mean when turned off', () =>
    withApp('?series=autoland,1,1', async (app) => {
      await settle();
      expect(app.showReplicates).toBe(true);
      expect(app.series[0].plot.points).toHaveLength(5);

      app.setShowReplicates(false);
      expect(app.series[0].plot.points.map((p) => p.y)).toEqual([110, 205]);
      // Still one dot per run, so the graph is not empty and `hasData` holds.
      expect(app.hasData).toBe(true);
    }));

  it('tightens the y domain to the means, since that is what is drawn', () =>
    withApp('?series=autoland,1,1', async (app) => {
      await settle();
      expect(app.fullYDomain.min).toBeLessThan(100);
      expect(app.fullYDomain.max).toBeGreaterThan(210);

      app.setShowReplicates(false);
      expect(app.fullYDomain.min).toBeGreaterThan(100);
      expect(app.fullYDomain.max).toBeLessThan(210);
    }));

  it('is a drawing choice, so toggling it refetches nothing', () =>
    withApp('?series=autoland,1,1', async (app) => {
      await settle();
      const before = fetchMock.mock.calls.length;
      app.setShowReplicates(false);
      app.setShowReplicates(true);
      await settle();
      expect(fetchMock.mock.calls.length).toBe(before);
    }));

  it('round-trips through the URL', () =>
    withApp('?series=autoland,1,1', async (app) => {
      await settle();
      app.setShowReplicates(false);
      expect(location.search).toContain('reps=0');
      app.setShowReplicates(true);
      expect(location.search).not.toContain('reps');
    }));

  it('restores the off state from the URL', () =>
    withApp('?series=autoland,1,1&reps=0', async (app) => {
      await settle();
      expect(app.showReplicates).toBe(false);
      expect(app.series[0].plot.points).toHaveLength(2);
    }));

  it('selects the run mean rather than a hidden replicate', () =>
    withApp('?series=autoland,1,1&reps=0', async (app) => {
      await settle();
      // The keyboard entry point goes through the drawn point set.
      app.stepRun(1);
      expect(app.selectedPoint?.replicateIndex).toBe(MEAN_REPLICATE);
      expect(app.selection?.value).toBe(110);
      // Walking to the next run keeps the mean, rather than falling back to a
      // replicate the user can't see.
      app.stepRun(1);
      expect(app.selection?.value).toBe(205);
      expect(app.selectedPoint?.replicateIndex).toBe(MEAN_REPLICATE);
    }));

  it('does not step replicates while they are hidden', () =>
    withApp('?series=autoland,1,1&reps=0&sel=autoland,1,10,-1', async (app) => {
      await settle();
      app.stepReplicate(1);
      expect(app.selectedPoint?.replicateIndex).toBe(MEAN_REPLICATE);
    }));

  it('keeps a replicate selection across a toggle instead of rewriting it', () =>
    withApp('?series=autoland,1,1&sel=autoland,1,10,2', async (app) => {
      await settle();
      expect(app.selection?.value).toBe(120);
      app.setShowReplicates(false);
      expect(app.selection?.value).toBe(120);
      app.setShowReplicates(true);
      expect(app.selection?.replicateIndex).toBe(2);
    }));
});

describe('extentOf', () => {
  // Two runs a day apart, means 100 and 200, with nothing in between.
  const DAY_1 = Date.UTC(2026, 6, 21, 6, 0, 0);
  const DAY_2 = DAY_1 + DAY;
  const SLOPED = entry(
    summary(1, [
      datum({ id: 10, value: 100, push_id: 1, push_timestamp: '2026-07-21T06:00:00' }),
      datum({ id: 11, value: 200, push_id: 2, push_timestamp: '2026-07-22T06:00:00' }),
    ]),
  );

  it('covers the whole series when there is no window', () => {
    expect(extentOf([SLOPED], null)).toEqual({ min: 100, max: 200 });
  });

  it('covers the connecting line where it crosses a window with no points of its own', () => {
    // Quarter to half way between the two pushes: the line runs 125..150 there.
    const span = { start: DAY_1 + DAY / 4, end: DAY_1 + DAY / 2 };
    expect(extentOf([SLOPED], span)).toEqual({ min: 125, max: 150 });
  });

  it('interpolates from the push means, not from individual retriggers', () => {
    // Same two timestamps, but the first push is retriggered: means 100 and 300
    // for its two runs, so the line leaves it at 200 rather than at either dot.
    const retriggered = entry(
      summary(3, [
        datum({ id: 30, value: 100, push_id: 1, push_timestamp: '2026-07-21T06:00:00' }),
        datum({ id: 31, value: 300, push_id: 1, push_timestamp: '2026-07-21T06:00:00' }),
        datum({ id: 32, value: 400, push_id: 2, push_timestamp: '2026-07-22T06:00:00' }),
      ]),
    );
    // Half way across: 200 → 400 gives 300. Interpolating between individual
    // runs would have used 300 (the second retrigger) as the left vertex and
    // landed on 350.
    const span = { start: DAY_1 + DAY / 2, end: DAY_1 + DAY / 2 };
    expect(extentOf([retriggered], span)).toEqual({ min: 300, max: 300 });
  });

  it('unions a series whose only contribution is its line with one that has points', () => {
    const flat = entry(
      summary(2, [
        datum({ id: 20, value: 500, push_id: 3, push_timestamp: '2026-07-21T12:00:00' }),
      ]),
    );
    const span = { start: DAY_1 + DAY / 4, end: DAY_1 + DAY / 2 };
    expect(extentOf([SLOPED, flat], span)).toEqual({ min: 125, max: 500 });
  });

  it('does not extrapolate past the ends of a series', () => {
    // Window entirely to the right of both runs: no line to show.
    expect(extentOf([SLOPED], { start: DAY_2 + DAY, end: DAY_2 + 2 * DAY })).toEqual({
      min: 0,
      max: 1,
    });
  });
});

describe('the inline pushlog', () => {
  // Distinct revisions on the two pushes. The shared SAMPLE gives every datum
  // the same one, which is the degenerate case the range is suppressed for.
  const BASE_REV = 'b'.repeat(40);
  const NEXT_REV = 'c'.repeat(40);
  const TWO_REVS = summary(3, [
    datum({
      id: 20,
      value: 100,
      push_id: 1,
      revision: BASE_REV,
      push_timestamp: '2026-07-21T06:00:00',
    }),
    datum({
      id: 21,
      value: 200,
      push_id: 2,
      revision: NEXT_REV,
      push_timestamp: '2026-07-22T06:00:00',
    }),
  ]);

  // The range as treeherder answers it: newest first, and *including* the push
  // named by `fromchange`.
  const RANGE_RESULTS = [
    push({
      id: 2,
      revision: NEXT_REV,
      revisions: [
        { revision: NEXT_REV, author: 'Dev <dev@example.com>', comments: 'Bug 22 - the culprit' },
      ],
    }),
    push({
      id: 1,
      revision: BASE_REV,
      revisions: [
        { revision: BASE_REV, author: 'Dev <dev@example.com>', comments: 'Bug 11 - the baseline' },
      ],
    }),
  ];

  // Installed *before* `withApp`, which constructs the state and runs its
  // effects before it hands it over. Range requests are collected separately
  // from the push *detail* lookups the selection makes, which share a prefix.
  function stubRanges(rangeResponse: () => Response) {
    const ranges: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const s = String(url);
        if (s.includes('/performance/summary/')) return json([TWO_REVS]);
        if (s.includes('/performance/alertsummary/')) return json(alertPage([]));
        if (s.includes('/repository/')) return json([]);
        if (s.includes('/push/?')) {
          ranges.push(s);
          return rangeResponse();
        }
        if (s.includes('/push/')) return json(push());
        if (s.includes('/jobs/')) return json(job());
        return json({});
      }),
    );
    return ranges;
  }

  const ok = () => json({ results: RANGE_RESULTS });
  const selOnly = '?series=autoland,3,1&sel=autoland,3,20,0';
  const pinned = `${selOnly}&cmp=autoland,3,21,0`;

  it('fetches the range for a pinned comparison and drops the base push', () => {
    const ranges = stubRanges(ok);
    return withApp(pinned, async (app) => {
      await settle();
      expect(ranges).toHaveLength(1);
      expect(ranges[0]).toContain(`fromchange=${BASE_REV}`);
      expect(ranges[0]).toContain(`tochange=${NEXT_REV}`);
      // Explicit count: the endpoint's default page is 10 and truncates in
      // silence.
      expect(ranges[0]).toContain('count=201');

      expect(app.pushlogStatus).toBe('loaded');
      // The baseline commit is the "before" side, not a suspect.
      expect(app.pushlogRange?.commits.map((c) => c.summary)).toEqual(['Bug 22 - the culprit']);
      expect(app.pushlogRange?.pushCount).toBe(1);
    });
  });

  // The rule this feature most needs to keep: a range fetch is the largest of
  // the pane's lookups, and hovering crosses dots by the dozen.
  it('does not fetch anything for a hovered comparison', () => {
    const ranges = stubRanges(ok);
    return withApp(selOnly, async (app) => {
      await settle();
      app.setHoveredPoint({
        repository: 'autoland',
        signatureId: 3,
        datumId: 21,
        replicateIndex: 0,
      });
      await settle();
      expect(app.comparisonSource).toBe('hover');
      expect(app.comparison).not.toBeNull();
      expect(ranges).toEqual([]);
      expect(app.pushlogStatus).toBe('absent');
    });
  });

  it('has no range to fetch when both ends are the same push', () => {
    const ranges = stubRanges(ok);
    return withApp('?series=autoland,3,1&sel=autoland,3,20,0&cmp=autoland,3,20,0', async (app) => {
      await settle();
      expect(ranges).toEqual([]);
      expect(app.pushlogStatus).toBe('absent');
    });
  });

  it('serves a re-pinned range from cache', () => {
    const ranges = stubRanges(ok);
    return withApp(pinned, async (app) => {
      await settle();
      expect(ranges).toHaveLength(1);
      app.clearComparison();
      await settle();
      app.comparePoint({
        repository: 'autoland',
        signatureId: 3,
        datumId: 21,
        replicateIndex: 0,
      });
      await settle();
      expect(app.pushlogStatus).toBe('loaded');
      expect(ranges).toHaveLength(1);
    });
  });

  it('reports a failed range instead of retrying it', () => {
    const ranges = stubRanges(() => ({ ok: false, status: 503, statusText: 'nope' }) as Response);
    return withApp(pinned, async (app) => {
      await settle();
      expect(app.pushlogStatus).toBe('failed');
      // The negative cache stops the effect reissuing a doomed request.
      await settle();
      expect(ranges).toHaveLength(1);
    });
  });
});
