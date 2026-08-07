// PickerState is reactive, so — as in appState.test.svelte.ts — these run
// inside an `$effect.root` with `flushSync` driving the effect graph and
// `fetch` stubbed. See docs/design.md "Testing" for why the file is named
// `.test.svelte.ts` and why the environment must be happy-dom.
//
// Most of what follows is the seam between the app and the picker. `seed` is
// where the app hands over a starting point, and where getting the ordering
// wrong (seed after the fetch effect) would quietly fetch the wrong repos or
// the wrong interval; `view` is the way back, and what ends up in a shared
// link. The rest is state PickerState owns itself: `listStatus`, `plotted`,
// and the batching, debouncing and caching behind run activity.

import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_IDS_PER_REQUEST } from './activity';
import { type Series } from './series';
import { DEFAULT_REPOS, PINNED_REPOS } from './pickerOptions';
import type { FilterChip } from './filter';
import { ACTIVITY_DEBOUNCE_MS, PickerState } from './pickerState.svelte';
import { EMPTY_PICKER_VIEW, type PickerViewState } from '../urlState';

let fetchMock: ReturnType<typeof vi.fn>;
// The signatures payload each repo fetch answers with; tests that care about
// rows replace it before building the picker.
let signatures: Record<string, unknown> = {};
// The /performance/data/ payload, keyed by signature_hash as the endpoint
// keys it. Tests that care replace it before building the picker.
let activityData: Record<string, unknown> = {};
// Every /performance/data/ URL the picker asked for, in order — the batching
// assertions are all about how many of these there are and what's in them.
let activityUrls: string[] = [];

function json(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

function signature(id: number, o: Record<string, unknown> = {}) {
  return {
    id,
    signature_hash: `hash${id}`,
    framework_id: 13,
    option_collection_hash: 'H_OPT',
    machine_platform: 'linux2404-64',
    suite: 'speedometer3',
    should_alert: null,
    ...o,
  };
}

beforeEach(() => {
  signatures = {};
  activityData = {};
  activityUrls = [];
  fetchMock = vi.fn(async (url: string) => {
    const s = String(url);
    if (s.includes('/performance/framework/')) return json([{ id: 13, name: 'browsertime' }]);
    if (s.includes('/optioncollectionhash/')) {
      return json([{ option_collection_hash: 'H_OPT', options: [{ name: 'opt' }] }]);
    }
    if (s.includes('/performance/data/')) {
      activityUrls.push(s);
      return json(activityData);
    }
    // The signatures payload; an empty map is a valid response.
    return json(signatures);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Only the fields a test cares about; the rest stay unspecified, which is what
// a URL without them and a prefill that has no opinion both look like.
function view(overrides: Partial<PickerViewState> = {}): PickerViewState {
  return { ...EMPTY_PICKER_VIEW, ...overrides };
}

// A seed carrying nothing but a filter — the common shape here.
function filterView(chips: FilterChip[], text = ''): PickerViewState {
  return view({ filter: { chips, text } });
}

// `seed` must run during setup, before the constructor's fetch effect first
// fires — the same order AddSeriesPicker.svelte uses.
function withPicker(
  seed: (picker: PickerState) => void,
  fn: (picker: PickerState) => void | Promise<void>,
) {
  let picker!: PickerState;
  const dispose = $effect.root(() => {
    picker = new PickerState();
    seed(picker);
  });
  flushSync();
  return Promise.resolve(fn(picker)).finally(dispose);
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
    flushSync();
  }
}

// One datum shaped like /performance/data/ sends them, for tests that only
// care how many came back.
const datum = {
  id: 1,
  signature_id: 1,
  job_id: 1,
  push_id: 1,
  revision: 'abc',
  push_timestamp: 1785155040,
  value: 1,
};

// Wait out the activity debounce, then let the fetch promises settle. Real
// timers, because the debounce is a plain setTimeout and faking timers here
// would also freeze the promise scheduling the fetches depend on.
async function settleActivity(): Promise<void> {
  await new Promise((r) => setTimeout(r, ACTIVITY_DEBOUNCE_MS + 20));
  await settle();
}

function signatureRepos(): string[] {
  return fetchMock.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.includes('/performance/signatures/'))
    .map((u) => /\/project\/([^/]+)\//.exec(u)?.[1] ?? '');
}

describe('PickerState.seed', () => {
  it('adopts the seeded filter', () =>
    withPicker(
      (p) => p.seed(filterView([{ field: 'suite', value: 'speedometer3' }], 'chrome')),
      (p) => {
        expect(p.filter.chips).toEqual([{ field: 'suite', value: 'speedometer3' }]);
        expect(p.filter.text).toBe('chrome');
        expect(p.filterActive).toBe(true);
      },
    ));

  it('descends into subtests when the seed names a test', () =>
    withPicker(
      (p) => p.seed(filterView([{ field: 'test', value: 'contentfulspeedindex' }])),
      (p) => {
        // Parent rows have no `test` of their own, so without this the seeded
        // filter would match nothing at all.
        expect(p.matchSubtests).toBe(true);
        expect(p.needSubtestsFetch).toBe(true);
      },
    ));

  it('leaves subtest matching off for a seed without a test', () =>
    withPicker(
      (p) => p.seed(filterView([{ field: 'suite', value: 'speedometer3' }])),
      (p) => expect(p.matchSubtests).toBe(false),
    ));

  it('lets an explicit subtest mode of off beat the test-chip nudge', () =>
    withPicker(
      (p) =>
        p.seed(
          view({
            filter: { chips: [{ field: 'test', value: 'fcp' }], text: '' },
            matchSubtests: false,
          }),
        ),
      // The nudge exists for filters that never had the checkbox applied to
      // them. A seed that says `false` is the user having unchecked it, and a
      // shared link has to come back the way it was left.
      (p) => expect(p.matchSubtests).toBe(false),
    ));

  it('adopts an explicit subtest mode of on', () =>
    withPicker(
      (p) => p.seed(view({ matchSubtests: true })),
      (p) => {
        expect(p.matchSubtests).toBe(true);
        expect(p.needSubtestsFetch).toBe(true);
      },
    ));

  it('adopts the seeded sort', () =>
    withPicker(
      (p) => p.seed(view({ sort: { column: 'platform', direction: 'desc' } })),
      (p) => expect(p.sort).toEqual({ column: 'platform', direction: 'desc' }),
    ));

  it('fetches the seeded repos instead of the defaults', () =>
    withPicker(
      (p) => p.seed(view({ repos: ['mozilla-beta'] })),
      async (p) => {
        expect([...p.selectedRepos]).toEqual(['mozilla-beta']);
        await settle();
        // Crucially only the seeded one: seeding after the fetch effect had
        // run would have pulled autoland and mozilla-central as well.
        expect(signatureRepos()).toEqual(['mozilla-beta']);
      },
    ));

  it('keeps the default repos when the seed does not name any', () =>
    withPicker(
      (p) => p.seed(view({ repos: null })),
      async (p) => {
        expect([...p.selectedRepos]).toEqual(DEFAULT_REPOS);
        await settle();
        expect(signatureRepos().sort()).toEqual([...DEFAULT_REPOS].sort());
      },
    ));

  it('selects no repos at all for an explicitly empty seed', () =>
    withPicker(
      // Reachable by unchecking every chip, so it has to restore that way
      // rather than springing back to the defaults.
      (p) => p.seed(view({ repos: [] })),
      async (p) => {
        expect([...p.selectedRepos]).toEqual([]);
        await settle();
        expect(signatureRepos()).toEqual([]);
      },
    ));

  it('fetches over the seeded interval', () =>
    withPicker(
      (p) => p.seed(view({ repos: ['try'], intervalSeconds: 604800 })),
      async (p) => {
        expect(p.timeRangeSeconds).toBe(604800);
        await settle();
        // Same ordering hazard as the repos: seeding late would have fetched
        // the default 14 days first and thrown the result away.
        const intervals = fetchMock.mock.calls
          .map((c) => String(c[0]))
          .filter((u) => u.includes('/performance/signatures/'))
          .map((u) => /interval=(\d+)/.exec(u)?.[1]);
        expect(intervals).toEqual(['604800']);
      },
    ));

  it('gives a seeded repo outside the pinned four a chip of its own', () =>
    withPicker(
      (p) => p.seed(view({ repos: ['mozilla-release', 'autoland'] })),
      (p) => {
        // Otherwise its rows would be in the list with nothing to explain
        // where they came from and no way to switch it off.
        expect(p.repoChips).toEqual([...PINNED_REPOS, 'mozilla-release']);
        p.toggleRepo('mozilla-release');
        // And the chip survives being unchecked, so the way back stays.
        expect(p.repoChips).toContain('mozilla-release');
        expect(p.selectedRepos.has('mozilla-release')).toBe(false);
      },
    ));
});

describe('PickerState.view', () => {
  it('resolves whatever the seed left unspecified', () =>
    withPicker(
      (p) => p.seed(filterView([{ field: 'suite', value: 'sp3' }])),
      (p) =>
        // What the app writes to the URL: the concrete state of the controls,
        // not the partial prefill they were built from.
        expect(p.view).toEqual({
          filter: { chips: [{ field: 'suite', value: 'sp3' }], text: '' },
          repos: DEFAULT_REPOS,
          intervalSeconds: 1209600,
          matchSubtests: false,
          sort: null,
        }),
    ));

  it('tracks every control the panel offers', () =>
    withPicker(
      (p) => p.seed(view({ repos: ['try'] })),
      (p) => {
        p.toggleRepo('autoland');
        p.timeRangeSeconds = 7776000;
        p.matchSubtests = true;
        p.onSortHeader('unit');
        expect(p.view).toEqual({
          filter: { chips: [], text: '' },
          repos: ['try', 'autoland'],
          intervalSeconds: 7776000,
          matchSubtests: true,
          sort: { column: 'unit', direction: 'asc' },
        });
      },
    ));
});

describe('PickerState.listStatus', () => {
  it('is loading before the metadata lands', () =>
    withPicker(
      (p) => p.seed(view({ repos: ['autoland'] })),
      // No `settle()`: the framework and option-collection fetches haven't
      // resolved, so no signature fetch has even started and `anyLoading` is
      // still false. This is the window in which the list used to claim there
      // were no matching series.
      (p) => {
        expect(p.anyLoading).toBe(false);
        expect(p.listStatus).toBe('loading');
      },
    ));

  it('says which kind of empty it is', async () => {
    // Nothing checked: nothing is fetched either, so this is the repo row's
    // doing and pointing at the filter would be a wild goose chase.
    await withPicker(
      (p) => p.seed(view({ repos: [] })),
      async (p) => {
        await settle();
        expect(p.listStatus).toBe('no-repos');
      },
    );
    // A repo that answered with no rows: a filter problem, or an empty repo.
    signatures = {};
    await withPicker(
      (p) => p.seed(view({ repos: ['autoland'] })),
      async (p) => {
        await settle();
        expect(p.listStatus).toBe('no-matches');
      },
    );
  });

  it('stops loading when the metadata fetch fails', () => {
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/performance/framework/')
        ? ({ ok: false, status: 500, statusText: '' } as Response)
        : json({}),
    );
    return withPicker(
      (p) => p.seed(view({ repos: ['autoland'] })),
      async (p) => {
        await settle();
        // `metadataReady` never becomes true after a failure, so without the
        // error clause the list would shimmer forever behind an error banner.
        expect(p.metadataError).not.toBeNull();
        expect(p.listStatus).not.toBe('loading');
      },
    );
  });
});

describe('PickerState.plotted', () => {
  it('splits the shown rows by whether they are on the graph', () => {
    signatures = { '1': signature(1), '2': signature(2) };
    return withPicker(
      (p) => {
        p.seed(view({ repos: ['autoland'] }));
        p.plotted = new Map([['autoland|1', '#0969da']]);
      },
      async (p) => {
        await settle();
        expect(p.filteredParents.map((r) => r.id)).toEqual([1, 2]);
        // Row 1 is on the graph, so it offers Remove, not Add — "Add all"
        // must not count it (it would say 2 and add one no-op).
        expect(p.addableRows.map((r) => r.id)).toEqual([2]);
        expect(p.removableRows.map((r) => r.id)).toEqual([1]);
      },
    );
  });

  it('flips the bulk action to Remove once everything shown is plotted', () => {
    signatures = { '1': signature(1), '2': signature(2) };
    return withPicker(
      (p) => {
        p.seed(view({ repos: ['autoland'] }));
        p.plotted = new Map([['autoland|1', '#0969da']]);
      },
      async (p) => {
        await settle();
        // One row still addable: the button offers to add that one, not to
        // remove the other.
        expect(p.bulkAction).toEqual({ kind: 'add', rows: [expect.objectContaining({ id: 2 })] });
        p.plotted = new Map([
          ['autoland|1', '#0969da'],
          ['autoland|2', '#1a7f37'],
        ]);
        expect(p.bulkAction.kind).toBe('remove');
        expect(p.bulkAction.rows.map((r) => r.id)).toEqual([1, 2]);
      },
    );
  });

  it('has an empty bulk action when the filter matches nothing', () => {
    signatures = { '1': signature(1) };
    return withPicker(
      (p) => {
        p.seed(view({ repos: ['autoland'], filter: { chips: [], text: 'nothing-matches' } }));
      },
      async (p) => {
        await settle();
        // Both sides empty. `bulkAction` falls through to 'remove' with no
        // rows, which the template renders as a disabled button rather than
        // an enabled "Remove all 0".
        expect(p.addableRows).toEqual([]);
        expect(p.bulkAction.rows).toEqual([]);
      },
    );
  });
});

describe('PickerState run activity', () => {
  // The picker asks for activity only for the rows a caller says are on
  // screen, so every test here drives `requestActivity` by hand — that seam is
  // exactly what AddSeriesPicker's virtual-scroll effect does.

  function rowFor(picker: PickerState, id: number): Series {
    return picker.combined.find((s) => s.id === id)!;
  }

  it('fetches nothing until asked', () => {
    signatures = { '1': signature(1) };
    return withPicker(
      (p) => p.seed(view({ repos: ['autoland'] })),
      async (p) => {
        await settle();
        expect(activityUrls).toEqual([]);
        expect(p.activityFor(rowFor(p, 1))).toBeNull();
      },
    );
  });

  it('batches one request per repo and fills the cache', () => {
    signatures = { '1': signature(1), '2': signature(2) };
    activityData = { hash1: [{ ...datum, signature_id: 1 }] };
    return withPicker(
      (p) => p.seed(view({ repos: ['autoland', 'mozilla-central'] })),
      async (p) => {
        await settle();
        p.requestActivity(p.combined);
        await settleActivity();
        expect(activityUrls).toHaveLength(2);
        expect(activityUrls.some((u) => u.includes('/autoland/'))).toBe(true);
        expect(activityUrls.some((u) => u.includes('/mozilla-central/'))).toBe(true);
        const autoland = activityUrls.find((u) => u.includes('/autoland/'))!;
        expect(autoland).toContain('signature_id=1');
        expect(autoland).toContain('signature_id=2');
        const a = p.activityFor(rowFor(p, 1))!;
        expect('error' in a).toBe(false);
      },
    );
  });

  it('records 0 for a row the response omits, rather than leaving it pending', () => {
    signatures = { '1': signature(1) };
    activityData = {};
    return withPicker(
      (p) => p.seed(view({ repos: ['autoland'] })),
      async (p) => {
        await settle();
        p.requestActivity(p.combined);
        await settleActivity();
        // "This never runs" is exactly the answer the column exists to give,
        // so it must be a real entry rather than a permanent pending state.
        expect(p.activityFor(rowFor(p, 1))).toMatchObject({ total: 0, lastRunMs: null });
      },
    );
  });

  it('does not refetch a row that is already cached', () => {
    signatures = { '1': signature(1) };
    return withPicker(
      (p) => p.seed(view({ repos: ['autoland'] })),
      async (p) => {
        await settle();
        p.requestActivity(p.combined);
        await settleActivity();
        const before = activityUrls.length;
        p.requestActivity(p.combined);
        await settleActivity();
        expect(activityUrls).toHaveLength(before);
      },
    );
  });

  it('coalesces rows requested during the debounce window into one request', () => {
    signatures = { '1': signature(1), '2': signature(2), '3': signature(3) };
    return withPicker(
      (p) => p.seed(view({ repos: ['autoland'] })),
      async (p) => {
        await settle();
        // Three separate calls, as a scroll would make them.
        p.requestActivity([rowFor(p, 1)]);
        p.requestActivity([rowFor(p, 2)]);
        p.requestActivity([rowFor(p, 3)]);
        await settleActivity();
        expect(activityUrls).toHaveLength(1);
        for (const id of [1, 2, 3]) expect(activityUrls[0]).toContain(`signature_id=${id}`);
      },
    );
  });

  it('splits a batch larger than the request-line limit', () => {
    signatures = {};
    for (let id = 1; id <= MAX_IDS_PER_REQUEST + 5; id++) {
      signatures[String(id)] = signature(id);
    }
    return withPicker(
      (p) => p.seed(view({ repos: ['autoland'] })),
      async (p) => {
        await settle();
        p.requestActivity(p.combined);
        await settleActivity();
        // 155 ids at 150 per request.
        expect(activityUrls).toHaveLength(2);
      },
    );
  });

  it('records the failure on the row rather than in the error banner', () => {
    // Activity is decoration on a list that works without it. A failed fetch
    // must not be why the picker looks broken.
    signatures = { '1': signature(1) };
    fetchMock.mockImplementation(async (url: string) => {
      const s = String(url);
      if (s.includes('/performance/framework/')) {
        return json([{ id: 13, name: 'browsertime' }]);
      }
      if (s.includes('/optioncollectionhash/')) {
        return json([{ option_collection_hash: 'H_OPT', options: [{ name: 'opt' }] }]);
      }
      if (s.includes('/performance/data/')) {
        activityUrls.push(s);
        return { ok: false, status: 503, statusText: '' } as Response;
      }
      return json(signatures);
    });
    return withPicker(
      (p) => p.seed(view({ repos: ['autoland'] })),
      async (p) => {
        await settle();
        p.requestActivity(p.combined);
        await settleActivity();
        const a = p.activityFor(rowFor(p, 1))!;
        expect('error' in a).toBe(true);
        expect(p.errors).toEqual([]);
      },
    );
  });

  it('misses the cache after the time range changes', () => {
    signatures = { '1': signature(1) };
    return withPicker(
      (p) => p.seed(view({ repos: ['autoland'], intervalSeconds: 1209600 })),
      async (p) => {
        await settle();
        p.requestActivity(p.combined);
        await settleActivity();
        const before = activityUrls.length;
        p.timeRangeSeconds = 604800;
        flushSync();
        // A range change refetches the signature list too; wait for the new
        // rows before asking about them.
        await settle();
        p.requestActivity(p.combined);
        await settleActivity();
        expect(activityUrls.length).toBeGreaterThan(before);
        expect(activityUrls[activityUrls.length - 1]).toContain('interval=604800');
      },
    );
  });
});
