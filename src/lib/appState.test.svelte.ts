// AppState is reactive, so these run inside an `$effect.root` and use
// `flushSync` to drive the effect graph. `fetch` is stubbed: the point is the
// state machine, not the network.

import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppState } from './appState.svelte';
import type { RawDatum, RawSummary } from './graphApi';

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

// One datum with three replicates, plus a second push.
const SAMPLE = summary(1, [
  datum({ id: 10, value: 100, push_id: 1, push_timestamp: '2026-07-21T06:00:00' }),
  datum({ id: 10, value: 110, push_id: 1, push_timestamp: '2026-07-21T06:00:00' }),
  datum({ id: 10, value: 120, push_id: 1, push_timestamp: '2026-07-21T06:00:00' }),
  datum({ id: 11, value: 200, push_id: 2, push_timestamp: '2026-07-22T06:00:00' }),
  datum({ id: 11, value: 210, push_id: 2, push_timestamp: '2026-07-22T06:00:00' }),
]);

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/performance/summary/')) return json([SAMPLE]);
    if (url.includes('/repository/')) return json([]);
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
      expect(app.series[0].data.points).toHaveLength(5);
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
