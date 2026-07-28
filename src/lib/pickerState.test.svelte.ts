// PickerState is reactive, so — as in appState.test.svelte.ts — these run
// inside an `$effect.root` with `flushSync` driving the effect graph and
// `fetch` stubbed. See docs/design.md "Testing" for why the file is named
// `.test.svelte.ts` and why the environment must be happy-dom.
//
// Coverage here is deliberately narrow: the seam between the app and the
// picker. `seed` is where the app hands over a starting point, and where
// getting the ordering wrong (seed after the fetch effect) would quietly fetch
// the wrong repos or the wrong interval; `view` is the way back, and what ends
// up in a shared link.

import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REPOS, PINNED_REPOS } from './api';
import type { FilterChip } from './filter';
import { PickerState } from './pickerState.svelte';
import { EMPTY_PICKER_VIEW, type PickerViewState } from './urlState';

let fetchMock: ReturnType<typeof vi.fn>;
// The signatures payload each repo fetch answers with; tests that care about
// rows replace it before building the picker.
let signatures: Record<string, unknown> = {};

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
  fetchMock = vi.fn(async (url: string) => {
    const s = String(url);
    if (s.includes('/performance/framework/')) return json([{ id: 13, name: 'browsertime' }]);
    if (s.includes('/optioncollectionhash/')) {
      return json([{ option_collection_hash: 'H_OPT', options: [{ name: 'opt' }] }]);
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

describe('PickerState.plotted', () => {
  it('leaves rows already on the graph out of the pickable set', () => {
    signatures = { '1': signature(1), '2': signature(2) };
    return withPicker(
      (p) => {
        p.seed(view({ repos: ['autoland'] }));
        p.plotted = new Map([['autoland|1', '#0969da']]);
      },
      async (p) => {
        await settle();
        expect(p.filteredParents.map((r) => r.id)).toEqual([1, 2]);
        // Row 1 is on the graph and renders a swatch instead of a checkbox, so
        // select-all must not count it as something it can pick.
        expect(p.pickableRows.map((r) => r.id)).toEqual([2]);
        p.toggleSelectAll();
        expect([...p.picked.keys()]).toEqual([2]);
        expect(p.allPickablePicked).toBe(true);
      },
    );
  });
});
