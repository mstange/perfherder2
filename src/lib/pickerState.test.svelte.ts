// PickerState is reactive, so — as in appState.test.svelte.ts — these run
// inside an `$effect.root` with `flushSync` driving the effect graph and
// `fetch` stubbed. See docs/design.md "Testing" for why the file is named
// `.test.svelte.ts` and why the environment must be happy-dom.
//
// Coverage here is deliberately narrow: the seeding seam, which is where the
// app hands the picker a starting point and where getting the ordering wrong
// (seed after the fetch effect) would quietly fetch the wrong repos.

import { flushSync } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REPOS } from './api';
import { EMPTY_FILTER } from './filter';
import { PickerState } from './pickerState.svelte';

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
      (p) => p.seed({ chips: [{ field: 'suite', value: 'speedometer3' }], text: 'chrome' }),
      (p) => {
        expect(p.filter.chips).toEqual([{ field: 'suite', value: 'speedometer3' }]);
        expect(p.filter.text).toBe('chrome');
        expect(p.filterActive).toBe(true);
      },
    ));

  it('descends into subtests when the seed names a test', () =>
    withPicker(
      (p) => p.seed({ chips: [{ field: 'test', value: 'contentfulspeedindex' }], text: '' }),
      (p) => {
        // Parent rows have no `test` of their own, so without this the seeded
        // filter would match nothing at all.
        expect(p.matchSubtests).toBe(true);
        expect(p.needSubtestsFetch).toBe(true);
      },
    ));

  it('leaves subtest matching off for a seed without a test', () =>
    withPicker(
      (p) => p.seed({ chips: [{ field: 'suite', value: 'speedometer3' }], text: '' }),
      (p) => expect(p.matchSubtests).toBe(false),
    ));

  it('fetches the seeded repos instead of the defaults', () =>
    withPicker(
      (p) => p.seed(EMPTY_FILTER, ['mozilla-beta']),
      async (p) => {
        expect([...p.selectedRepos]).toEqual(['mozilla-beta']);
        await settle();
        // Crucially only the seeded one: seeding after the fetch effect had
        // run would have pulled autoland and mozilla-central as well.
        expect(signatureRepos()).toEqual(['mozilla-beta']);
      },
    ));

  it('keeps the default repos when the seed has none', () =>
    withPicker(
      (p) => p.seed(EMPTY_FILTER, []),
      async (p) => {
        expect([...p.selectedRepos]).toEqual(DEFAULT_REPOS);
        await settle();
        expect(signatureRepos().sort()).toEqual([...DEFAULT_REPOS].sort());
      },
    ));
});

describe('PickerState.plotted', () => {
  it('leaves rows already on the graph out of the pickable set', () => {
    signatures = { '1': signature(1), '2': signature(2) };
    return withPicker(
      (p) => {
        p.seed(EMPTY_FILTER, ['autoland']);
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
