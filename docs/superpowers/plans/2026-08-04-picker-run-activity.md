# Picker Run Activity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `runs (14 days)` column to the Add-series picker showing, per
row, how many times that series ran in the selected time range plus a tiny
density strip of when.

**Architecture:** A pure module (`activity.ts`) owns every calculation —
bin duration, binning, SVG path, tooltip text, id chunking. A thin API module
(`activityApi.ts`) owns the one new endpoint. `PickerState` owns the cache and
the batched, debounced fetch, driven by the picker's existing virtual-scroll
window. `AddSeriesPicker.svelte` stays a renderer.

**Tech Stack:** Svelte 5 runes, TypeScript, valibot for response validation,
vitest + happy-dom, jj for version control.

## Global Constraints

- **VCS is jj, not git.** Commit with `jj commit -m "…"`. Never `git commit`.
  One logical change per commit, descriptive first line, blank line,
  rationale.
- **`npm run check`, `npm test`, and `npm run build` must all pass** before
  every commit. These are exactly the three steps in
  `.github/workflows/ci.yml`.
- **No hardcoded colors.** Every color resolves to a custom property defined
  in *both* theme blocks of `src/app.css` (`:root` and
  `:root[data-theme='dark']`).
- **No business logic in `.svelte` files** if it can live in a pure,
  unit-tested function in `src/lib/`.
- **No committed browser tests.** Puppeteer is installed temporarily for
  smoke checks and uninstalled before the commit.
- **Layout must not shift** when data loads. Reserve space for pending states
  from the first render.
- Spec of record:
  `docs/superpowers/specs/2026-08-04-picker-run-activity-design.md`.
- Read `docs/design.md` before starting; it carries the *why* behind the
  picker's filter model, virtual scrolling, and schema discipline.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/lib/activity.ts` (create) | All pure logic: bin duration choice, binning, `Activity` construction, SVG path, tooltip text, id chunking, cache keys. |
| `src/lib/activity.test.ts` (create) | Unit tests for the above. |
| `src/lib/activityApi.ts` (create) | valibot schema for `/performance/data/`, URL builder, fetch. Nothing else. |
| `src/lib/activityApi.test.ts` (create) | URL shape and schema-validation tests with a stubbed `fetch`. |
| `src/lib/pickerState.svelte.ts` (modify) | Cache, pending set, debounce, batching, abort, eviction, `activityFor`. |
| `src/lib/pickerState.test.svelte.ts` (modify) | New `fetchMock` branch + orchestration tests. |
| `src/lib/AddSeriesPicker.svelte` (modify) | Ninth column, visible-window effect, colgroup rebalance, CSS. |
| `src/app.css` (modify) | `--activity-bar` in both theme blocks. |
| `docs/design.md` (modify) | Endpoint quirks and the not-sortable non-goal. |
| `docs/graphs-todo.md` (modify) | Status entry. |

---

## Task 1: Pure activity module

Everything with arithmetic in it, with no network and no DOM. This task is
entirely self-contained: it ships a tested module nothing imports yet.

**Files:**
- Create: `src/lib/activity.ts`
- Test: `src/lib/activity.test.ts`

**Interfaces:**
- Consumes: `Series` from `./api` (only its `key` field, a `${repo}|${id}`
  string).
- Produces, all relied on by Tasks 2–4:
  - `type Activity = { counts: number[]; total: number; lastRunMs: number | null } | { error: string }`
  - `type ActivityDatumLike = { signature_id: number; push_timestamp: number }`
  - `const MAX_IDS_PER_REQUEST = 150`
  - `const MAX_BINS = 24`
  - `function activityCacheKey(seriesKey: string, intervalSeconds: number): string`
  - `function chunkIds(ids: readonly number[], size: number): number[][]`
  - `function binDuration(rangeSeconds: number): number`
  - `function binCounts(timestampsMs: readonly number[], nowMs: number, rangeSeconds: number): number[]`
  - `function buildActivities(requestedIds: readonly number[], response: Record<string, readonly ActivityDatumLike[]>, nowMs: number, rangeSeconds: number): Map<number, Activity>`
  - `function activityPath(counts: readonly number[], width: number, height: number): string`
  - `function activityTitle(activity: { counts: number[]; total: number; lastRunMs: number | null }, rangeLabel: string, nowMs: number): string`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/activity.test.ts`:

```ts
// Pure module, so a plain `.test.ts` — no runes, no DOM, no `$effect.root`.
// See docs/design.md "Testing" for when a test needs the `.test.svelte.ts`
// treatment instead.

import { describe, expect, it } from 'vitest';
import { TIME_RANGES } from './api';
import {
  MAX_BINS,
  MAX_IDS_PER_REQUEST,
  activityCacheKey,
  activityPath,
  activityTitle,
  binCounts,
  binDuration,
  buildActivities,
  chunkIds,
} from './activity';

const HOUR = 3600;
const DAY = 86400;

describe('activityCacheKey', () => {
  it('extends the series key with the interval, so a range change misses', () => {
    expect(activityCacheKey('autoland|227074', 1209600)).toBe('autoland|227074|1209600');
    expect(activityCacheKey('autoland|227074', 604800)).not.toBe(
      activityCacheKey('autoland|227074', 1209600),
    );
  });
});

describe('chunkIds', () => {
  it('splits into chunks of at most `size`', () => {
    expect(chunkIds([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns nothing for an empty list', () => {
    expect(chunkIds([], 150)).toEqual([]);
  });

  it('keeps a full chunk under treeherder’s request-line limit', () => {
    // The real constraint: 300 ids produced
    // "Request Line is too large (6069 > 4094)" from treeherder's frontend,
    // before Django ever saw the request. Each id costs
    // "&signature_id=NNNNNN" ≈ 21 bytes.
    const worstCase = MAX_IDS_PER_REQUEST * '&signature_id=2268310'.length;
    expect(worstCase).toBeLessThan(3600);
  });
});

describe('binDuration', () => {
  // The strip is ~72px wide, so more than MAX_BINS bars would be sub-pixel.
  // Within that cap we want the finest granularity available, hence
  // "smallest duration that fits" rather than "largest".
  it('picks the finest duration that stays within MAX_BINS', () => {
    expect(binDuration(172800)).toBe(3 * HOUR);
    expect(binDuration(604800)).toBe(12 * HOUR);
    expect(binDuration(1209600)).toBe(DAY);
    expect(binDuration(2592000)).toBe(2 * DAY);
    expect(binDuration(5184000)).toBe(4 * DAY);
    expect(binDuration(7776000)).toBe(4 * DAY);
  });

  it('stays within MAX_BINS for every range the dropdown offers', () => {
    for (const { value } of TIME_RANGES) {
      expect(Math.ceil(value / binDuration(value))).toBeLessThanOrEqual(MAX_BINS);
    }
  });

  it('falls back to the coarsest duration for an absurd range', () => {
    // Not reachable through the UI (`pi` must be one of the dropdown's
    // choices) but the function must still return something usable.
    expect(binDuration(400 * DAY)).toBe(7 * DAY);
  });
});

describe('binCounts', () => {
  const now = Date.UTC(2026, 7, 4, 12, 0, 0);

  it('returns all zeros for no timestamps', () => {
    expect(binCounts([], now, 1209600)).toEqual(new Array(14).fill(0));
  });

  it('counts a run into the bin containing it', () => {
    // 14 days, 1-day bins, end-aligned: the last bin is the 24h up to `now`.
    const counts = binCounts([now - 1000], now, 1209600);
    expect(counts).toHaveLength(14);
    expect(counts[13]).toBe(1);
    expect(counts.slice(0, 13)).toEqual(new Array(13).fill(0));
  });

  it('puts an older run in an earlier bin', () => {
    const counts = binCounts([now - 3 * DAY * 1000], now, 1209600);
    expect(counts[10]).toBe(1);
    expect(counts[13]).toBe(0);
  });

  it('accumulates several runs in one bin', () => {
    const counts = binCounts([now - 1000, now - 2000, now - 3000], now, 1209600);
    expect(counts[13]).toBe(3);
  });

  it('aligns bins to the end of the window, so the newest bar is full width', () => {
    // 90 days at 4-day bins is 22.5 bins. The half-width bin must be the
    // oldest one, at the far left: if it were the newest, the bar the eye
    // goes to would cover half the time of its neighbours and read as a
    // decline that isn't there.
    const counts = binCounts([], now, 7776000);
    expect(counts).toHaveLength(23);
    // One run in each of the last two bins' worth of time, 4 days apart.
    const withRuns = binCounts([now - 1000, now - 4 * DAY * 1000], now, 7776000);
    expect(withRuns[22]).toBe(1);
    expect(withRuns[21]).toBe(1);
  });

  it('clamps a timestamp past `now` into the last bin', () => {
    // The window bound is the server's clock; ours can be behind it.
    const counts = binCounts([now + 60_000], now, 1209600);
    expect(counts[13]).toBe(1);
  });

  it('clamps a timestamp older than the window into the first bin', () => {
    const counts = binCounts([now - 30 * DAY * 1000], now, 1209600);
    expect(counts[0]).toBe(1);
  });
});

describe('buildActivities', () => {
  const now = Date.UTC(2026, 7, 4, 12, 0, 0);
  const nowSec = Math.floor(now / 1000);

  it('regroups by signature_id, ignoring the hash keys', () => {
    // The response is keyed by signature_hash, which aliases within a repo:
    // two rows differing only by `application` share one. So two requested
    // series can arrive in a single bucket, and the keys are useless.
    const response = {
      sharedhash: [
        { signature_id: 1, push_timestamp: nowSec - 60 },
        { signature_id: 2, push_timestamp: nowSec - 120 },
        { signature_id: 1, push_timestamp: nowSec - 180 },
      ],
    };
    const out = buildActivities([1, 2], response, now, 1209600);
    expect(out.get(1)).toMatchObject({ total: 2 });
    expect(out.get(2)).toMatchObject({ total: 1 });
  });

  it('records 0 for a requested id the response omits entirely', () => {
    // Idle signatures are left out of the response, not returned empty. If
    // this returned nothing, the row would stay "loading" forever instead of
    // saying what is actually true: it has not run.
    const out = buildActivities([7], {}, now, 1209600);
    expect(out.get(7)).toEqual({
      counts: new Array(14).fill(0),
      total: 0,
      lastRunMs: null,
    });
  });

  it('ignores datums for ids that were not requested', () => {
    const response = { h: [{ signature_id: 99, push_timestamp: nowSec }] };
    const out = buildActivities([1], response, now, 1209600);
    expect(out.size).toBe(1);
    expect(out.get(1)).toMatchObject({ total: 0 });
  });

  it('converts push_timestamp from unix seconds to ms for lastRunMs', () => {
    // This endpoint sends an integer of seconds where /performance/summary/
    // sends a naive ISO string for the same column.
    const response = { h: [{ signature_id: 1, push_timestamp: nowSec - 3600 }] };
    const out = buildActivities([1], response, now, 1209600);
    expect(out.get(1)).toMatchObject({ lastRunMs: (nowSec - 3600) * 1000 });
  });

  it('reports the newest run regardless of response order', () => {
    // The endpoint orders by job_id, so the newest datum is not reliably
    // last — taking the max rather than the tail is load-bearing.
    const response = {
      h: [
        { signature_id: 1, push_timestamp: nowSec - 3600 },
        { signature_id: 1, push_timestamp: nowSec - 86400 },
        { signature_id: 1, push_timestamp: nowSec - 60 },
      ],
    };
    expect(buildActivities([1], response, now, 1209600).get(1)).toMatchObject({
      lastRunMs: (nowSec - 60) * 1000,
      total: 3,
    });
  });
});

describe('activityPath', () => {
  it('is empty when nothing ran, so the cell renders no bars at all', () => {
    expect(activityPath([0, 0, 0], 6, 4)).toBe('');
  });

  it('emits one subpath per non-zero bin, scaled to the tallest', () => {
    // width 6 / 3 bins => 2px per bin, 1px bar + 1px gap. The tallest bin
    // gets the full height; bin 0 is skipped because it is zero.
    expect(activityPath([0, 1, 2], 6, 4)).toBe('M2 2h1v2h-1z M4 0h1v4h-1z');
  });

  it('gives a bin with any runs at least one pixel', () => {
    // 1 run against a 500-run neighbour rounds to 0px, which would say
    // "never ran" — the opposite of the truth.
    expect(activityPath([1, 500], 4, 10)).toBe('M0 9h1v1h-1z M2 0h1v10h-1z');
  });

  it('returns empty for no bins rather than dividing by zero', () => {
    expect(activityPath([], 6, 4)).toBe('');
  });
});

describe('activityTitle', () => {
  const now = Date.UTC(2026, 7, 4, 12, 0, 0);

  it('says how many runs, over what window, and how long ago the last was', () => {
    expect(
      activityTitle(
        { counts: [1], total: 6, lastRunMs: now - 4 * 3600 * 1000 },
        '14 days',
        now,
      ),
    ).toBe('6 runs in 14 days · last run 4 hours ago');
  });

  it('does not pluralise a single run', () => {
    expect(
      activityTitle({ counts: [1], total: 1, lastRunMs: now - 61_000 }, '2 days', now),
    ).toBe('1 run in 2 days · last run 1 minute ago');
  });

  it('says so plainly when nothing ran, with no dangling last-run clause', () => {
    expect(
      activityTitle({ counts: [0], total: 0, lastRunMs: null }, '14 days', now),
    ).toBe('No runs in 14 days');
  });

  it('describes a very recent run without a bare "0 minutes ago"', () => {
    expect(
      activityTitle({ counts: [1], total: 1, lastRunMs: now - 5_000 }, '2 days', now),
    ).toBe('1 run in 2 days · last run just now');
  });

  it('switches to days past 48 hours', () => {
    expect(
      activityTitle(
        { counts: [1], total: 2, lastRunMs: now - 3 * DAY * 1000 },
        '14 days',
        now,
      ),
    ).toBe('2 runs in 14 days · last run 3 days ago');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/activity.test.ts`
Expected: FAIL — `Failed to resolve import "./activity"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/activity.ts`:

```ts
// Run activity for a picker row: how many times this series ran in the
// selected time range, and a tiny density strip of when.
//
// Everything here is pure. The network lives in activityApi.ts, the cache and
// the batching in pickerState.svelte.ts, the markup in AddSeriesPicker.svelte
// — so every calculation below is testable without a DOM or a fetch. See
// docs/superpowers/specs/2026-08-04-picker-run-activity-design.md.

// How many signature ids may go into one /performance/data/ request.
//
// Not a tuning knob: treeherder's frontend rejects the request before Django
// sees it, with "Request Line is too large (6069 > 4094)". Each id costs
// about 21 bytes of query string, so ~195 is the true ceiling; 150 leaves
// room for the other parameters and for longer ids as they grow.
export const MAX_IDS_PER_REQUEST = 150;

// The strip is ~72px wide, so more bars than this would be sub-pixel.
export const MAX_BINS = 24;

const HOUR = 3600;
const DAY = 86400;

// Bin durations we're willing to use, ascending. Every one has a name a
// tooltip could say out loud, which rules out "the range divided by 24".
const BIN_DURATIONS = [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 4 * DAY, 7 * DAY];

// A row's answer, or the reason it doesn't have one. An absent cache entry
// means "not fetched yet" — distinct from `total: 0`, which is a real answer.
export type Activity =
  | { counts: number[]; total: number; lastRunMs: number | null }
  | { error: string };

// The two fields of a /performance/data/ datum this module needs. Declared
// structurally so activity.ts doesn't have to import from activityApi.ts —
// the dependency runs the other way.
export type ActivityDatumLike = { signature_id: number; push_timestamp: number };

// `Series.key` is already the compound `${repo}|${id}` identity (see api.ts
// for why the numeric id and not the aliasing hash). The interval belongs in
// the key too, so changing the Time range misses rather than showing counts
// for a window the user isn't looking at any more.
export function activityCacheKey(seriesKey: string, intervalSeconds: number): string {
  return `${seriesKey}|${intervalSeconds}`;
}

export function chunkIds(ids: readonly number[], size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

// The *finest* granularity the strip has room for: the smallest duration
// whose bin count fits under MAX_BINS.
export function binDuration(rangeSeconds: number): number {
  for (const d of BIN_DURATIONS) {
    if (Math.ceil(rangeSeconds / d) <= MAX_BINS) return d;
  }
  return BIN_DURATIONS[BIN_DURATIONS.length - 1];
}

export function binCount(rangeSeconds: number): number {
  return Math.max(1, Math.ceil(rangeSeconds / binDuration(rangeSeconds)));
}

// Bins are aligned to the END of the window, not the start.
//
// When the range isn't a whole multiple of the bin duration — 90 days at
// 4-day bins is 22.5 — one bin is partial. Aligning to the start would put
// the short bin last, so the rightmost bar (the one the eye goes to, and the
// one that answers "is this running *now*") would cover half the time of its
// neighbours and read as a decline that isn't there. Aligned to the end, the
// partial bin is the oldest, at the far left, where a slightly short bar
// means nothing.
//
// Both ends clamp rather than drop: the window bound is the server's clock,
// so a datum can sit marginally outside ours, and silently discarding a run
// is worse than putting it in the edge bin.
export function binCounts(
  timestampsMs: readonly number[],
  nowMs: number,
  rangeSeconds: number,
): number[] {
  const bins = binCount(rangeSeconds);
  const binMs = binDuration(rangeSeconds) * 1000;
  const counts = new Array<number>(bins).fill(0);
  for (const ts of timestampsMs) {
    const fromEnd = Math.floor((nowMs - ts) / binMs);
    const idx = Math.min(bins - 1, Math.max(0, bins - 1 - fromEnd));
    counts[idx] += 1;
  }
  return counts;
}

// Turn one /performance/data/ response into one Activity per *requested* id.
//
// Two quirks of that endpoint are handled here, and only here:
//
//  - It keys the response by `signature_hash`, which aliases within a repo
//    (two rows differing only by `application` share one — see api.ts). So a
//    single bucket can hold datums for more than one requested series, and
//    the keys are useless. Every datum carries its own `signature_id`; that
//    is what we group on.
//  - It omits signatures with no data in the window rather than returning
//    them empty. Iterating the *requested* ids rather than the response is
//    what turns that silence into `total: 0` — otherwise an idle row would
//    stay pending forever, which is the one thing it must not do, since
//    "this never runs" is exactly the answer the column exists to give.
export function buildActivities(
  requestedIds: readonly number[],
  response: Record<string, readonly ActivityDatumLike[]>,
  nowMs: number,
  rangeSeconds: number,
): Map<number, Activity> {
  const wanted = new Set(requestedIds);
  const byId = new Map<number, number[]>();
  for (const datums of Object.values(response)) {
    for (const d of datums) {
      if (!wanted.has(d.signature_id)) continue;
      const list = byId.get(d.signature_id);
      // Seconds on this endpoint; /performance/summary/ sends a naive ISO
      // string for the same column. One schema per endpoint, not per table.
      const ms = d.push_timestamp * 1000;
      if (list) list.push(ms);
      else byId.set(d.signature_id, [ms]);
    }
  }

  const out = new Map<number, Activity>();
  for (const id of requestedIds) {
    const timestamps = byId.get(id) ?? [];
    out.set(id, {
      counts: binCounts(timestamps, nowMs, rangeSeconds),
      total: timestamps.length,
      // Response order isn't guaranteed to be chronological, so take the max
      // rather than the last element.
      lastRunMs: timestamps.length > 0 ? Math.max(...timestamps) : null,
    });
  }
  return out;
}

// One SVG path for the whole strip, rather than one <rect> per bar.
//
// A screenful is ~29 rows; at 24 bars each that would be ~700 elements
// churning in and out of the virtual scroller on every scroll tick. One
// <path> per row is one node, takes `fill: currentColor`, needs no
// devicePixelRatio handling and no canvas lifecycle, and is testable as a
// string.
export function activityPath(
  counts: readonly number[],
  width: number,
  height: number,
): string {
  if (counts.length === 0) return '';
  const max = Math.max(...counts);
  if (max === 0) return '';
  const slot = width / counts.length;
  // One pixel of gap between bars, but never a zero-width bar.
  const barWidth = Math.max(1, Math.round(slot) - 1);
  const parts: string[] = [];
  for (let i = 0; i < counts.length; i++) {
    const n = counts[i];
    if (n === 0) continue;
    // A bin with any runs at all gets at least 1px: 1 run beside a 500-run
    // neighbour would otherwise round to nothing and claim it never ran.
    const h = Math.max(1, Math.round((n / max) * height));
    const x = Math.round(i * slot);
    parts.push(`M${x} ${height - h}h${barWidth}v${h}h-${barWidth}z`);
  }
  return parts.join(' ');
}

function relativeAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// The hover text. "1,204 runs in 14 days · last run 4 hours ago" — the count
// the column already shows, plus the staleness the strip only implies.
export function activityTitle(
  activity: { counts: number[]; total: number; lastRunMs: number | null },
  rangeLabel: string,
  nowMs: number,
): string {
  if (activity.total === 0) return `No runs in ${rangeLabel}`;
  const runs = `${activity.total.toLocaleString()} run${activity.total === 1 ? '' : 's'}`;
  const head = `${runs} in ${rangeLabel}`;
  if (activity.lastRunMs === null) return head;
  return `${head} · last run ${relativeAge(nowMs - activity.lastRunMs)}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/activity.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Run the full gate**

Run: `npm run check && npm test && npm run build`
Expected: all three clean. `activity.ts` is not imported yet, so `check` is
verifying the module type-checks in isolation.

- [ ] **Step 6: Commit**

```bash
jj commit -m "$(cat <<'EOF'
Add the pure half of picker run activity

Bin selection, binning, SVG path and tooltip text for a per-row "how often
did this run" strip. Nothing imports it yet; the fetch, the cache and the
column follow.

Two things here are less arbitrary than they look. MAX_IDS_PER_REQUEST is a
hard server limit, not a tuning knob: treeherder's frontend rejects a
300-id request with "Request Line is too large (6069 > 4094)" before Django
sees it. And bins are aligned to the end of the window rather than the
start, so the partial bin at 90 days lands on the oldest bar instead of the
newest one — a half-width bar on the right would read as a decline that
isn't there.
EOF
)"
```

---

## Task 2: The endpoint

One module, one endpoint, no logic. Split from `api.ts` the way `graphApi.ts`
is.

**Files:**
- Create: `src/lib/activityApi.ts`
- Test: `src/lib/activityApi.test.ts`

**Interfaces:**
- Consumes: `API_BASE`, `fetchJson` from `./http`; `MAX_IDS_PER_REQUEST` from
  `./activity` (referenced in a comment only).
- Produces, relied on by Task 3:
  - `const ActivityDatumSchema` / `type ActivityDatum`
  - `const ActivityResponseSchema` / `type ActivityResponse = Record<string, ActivityDatum[]>`
  - `function activityDataUrl(repository: string, signatureIds: readonly number[], intervalSeconds: number): string`
  - `function fetchActivityData(repository: string, signatureIds: readonly number[], intervalSeconds: number, signal?: AbortSignal): Promise<ActivityResponse>`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/activityApi.test.ts`:

```ts
// Same discipline as api.test.ts: stub `fetch`, assert the URL we build and
// that the schema is actually enforced. The point of the schema tests is that
// a shape change in treeherder must be loud, not silently absorbed — see
// docs/design.md "Validating API responses".

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SchemaError } from './http';
import { activityDataUrl, fetchActivityData } from './activityApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

const datum = {
  id: 2631843010,
  signature_id: 227074,
  job_id: 581048117,
  push_id: 1983527,
  revision: '086a31370d2dbe0fa73c71dab68821be0401c2b0',
  push_timestamp: 1785155040,
  value: 763.9,
};

describe('activityDataUrl', () => {
  it('repeats signature_id once per id and passes the relative interval', () => {
    const url = activityDataUrl('autoland', [1, 2, 3], 1209600);
    expect(url).toBe(
      'https://treeherder.mozilla.org/api/project/autoland/performance/data/' +
        '?interval=1209600&signature_id=1&signature_id=2&signature_id=3',
    );
  });

  it('escapes the repository name', () => {
    expect(activityDataUrl('mozilla-central', [1], 172800)).toContain(
      '/project/mozilla-central/performance/data/',
    );
  });
});

describe('fetchActivityData', () => {
  it('returns the hash-keyed record as sent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ abc123: [datum] })));
    const out = await fetchActivityData('autoland', [227074], 1209600);
    expect(out).toEqual({ abc123: [datum] });
  });

  it('accepts an empty record, which is what an idle signature looks like', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({})));
    await expect(fetchActivityData('autoland', [1], 1209600)).resolves.toEqual({});
  });

  it('accepts a null job_id, which is what an expired job looks like', async () => {
    // Treeherder keeps perf data far longer than jobs and nulls the FK on the
    // way out (`job = ForeignKey(null=True, on_delete=SET_NULL)`).
    vi.stubGlobal('fetch', vi.fn(async () => json({ abc: [{ ...datum, job_id: null }] })));
    await expect(fetchActivityData('autoland', [1], 1209600)).resolves.toBeTruthy();
  });

  it('rejects a response whose shape changed under us', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ abc: [{ ...datum, value: 'fast' }] })));
    await expect(fetchActivityData('autoland', [1], 1209600)).rejects.toBeInstanceOf(
      SchemaError,
    );
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/activityApi.test.ts`
Expected: FAIL — `Failed to resolve import "./activityApi"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/activityApi.ts`:

```ts
// The one endpoint behind the picker's run-activity column.
//
//   /project/<repo>/performance/data/?interval=<sec>&signature_id=…(×N)
//
// Producer: `PerformanceDatumViewSet.list` in
// treeherder/webapp/api/performance_data.py. Unlike /performance/summary/,
// this one takes many signature ids per request, which is what makes an
// always-on column affordable: ~3.5 KB gzipped per signature, so a
// screenful is one request per repo.
//
// Batching is the caller's job — see MAX_IDS_PER_REQUEST in activity.ts for
// the hard limit and why it exists. Regrouping the response is also the
// caller's job (`buildActivities`), because this module deliberately holds no
// logic: it returns exactly what the endpoint sent.

import * as v from 'valibot';
import { API_BASE, fetchJson } from './http';

// One datum: one run of one signature on one push.
//
// Nullability, as elsewhere in this codebase, comes from treeherder's models
// rather than from whatever a sample happened to contain:
//
//  - `job_id` is nullable because perf data outlives jobs — the model has
//    `job = ForeignKey(null=True, on_delete=SET_NULL)`, so an expired job
//    leaves the datum with no job to point at.
//  - `value` is NOT nullable: `PerformanceDatum.value` is a plain
//    `FloatField()`. The `value is not None` guard in
//    /performance/summary/ is about the left-joined replicate column, not
//    this one — and this endpoint calls `round(value, 2)` unconditionally,
//    which would 500 rather than send a null.
//  - `push_timestamp` is an integer of unix seconds here, where
//    /performance/summary/ sends a naive ISO string for the same column.
//    See RawDatumSchema in graphApi.ts.
export const ActivityDatumSchema = v.object({
  id: v.number(),
  signature_id: v.number(),
  job_id: v.nullable(v.number()),
  push_id: v.number(),
  revision: v.string(),
  push_timestamp: v.number(),
  value: v.number(),
});
export type ActivityDatum = v.InferOutput<typeof ActivityDatumSchema>;

// Keyed by `signature_hash` — *not* by signature id, and the hash aliases
// within a repo, so one bucket can hold datums for more than one requested
// series. `buildActivities` regroups on each datum's own `signature_id` and
// ignores these keys entirely. Signatures with no data in the window are
// omitted rather than present-and-empty.
export const ActivityResponseSchema = v.record(
  v.string(),
  v.array(ActivityDatumSchema),
);
export type ActivityResponse = v.InferOutput<typeof ActivityResponseSchema>;

// The relative `interval`, not the absolute startday/endday that graphApi.ts
// uses. The reason for absolute bounds there is permalink stability
// (docs/graphs.md); nothing here is linkable, and `interval` makes the
// column's window the very same server-side filter as the signature list's.
export function activityDataUrl(
  repository: string,
  signatureIds: readonly number[],
  intervalSeconds: number,
): string {
  const params = new URLSearchParams({ interval: String(intervalSeconds) });
  for (const id of signatureIds) params.append('signature_id', String(id));
  return `${API_BASE}/project/${encodeURIComponent(repository)}/performance/data/?${params}`;
}

export function fetchActivityData(
  repository: string,
  signatureIds: readonly number[],
  intervalSeconds: number,
  signal?: AbortSignal,
): Promise<ActivityResponse> {
  return fetchJson(
    ActivityResponseSchema,
    activityDataUrl(repository, signatureIds, intervalSeconds),
    signal,
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/activityApi.test.ts`
Expected: PASS.

If the URL test fails on parameter order, note that `URLSearchParams`
preserves insertion order, so `interval` comes first because it is in the
constructor. Fix the expectation only if the implementation is genuinely
producing a different order — do not reorder to match a typo.

- [ ] **Step 5: Run the full gate**

Run: `npm run check && npm test && npm run build`
Expected: all three clean.

- [ ] **Step 6: Commit**

```bash
jj commit -m "$(cat <<'EOF'
Add the /performance/data/ client for run activity

The endpoint that makes an always-on activity column affordable: it takes
many signature ids per request, at about 3.5 KB gzipped each, so one
screenful of picker rows costs one request per repo rather than one per row.

The schema comments record three things that cost measurements to establish
and would cost them again: the response is keyed by the aliasing
signature_hash rather than by id, push_timestamp is unix seconds here where
the summary endpoint sends an ISO string for the same column, and `value` is
non-nullable even though the summary endpoint guards against a null (that
guard is about the left-joined replicate column).
EOF
)"
```

---

## Task 3: Cache and batched fetch on PickerState

**Files:**
- Modify: `src/lib/pickerState.svelte.ts`
- Test: `src/lib/pickerState.test.svelte.ts`

**Interfaces:**
- Consumes: `Activity`, `activityCacheKey`, `buildActivities`, `chunkIds`,
  `MAX_IDS_PER_REQUEST` from `./activity`; `fetchActivityData` from
  `./activityApi`; `Series` from `./api`.
- Produces, relied on by Task 4:
  - `picker.activityCache: Map<string, Activity>` (`$state`)
  - `picker.requestActivity(rows: readonly Series[]): void`
  - `picker.activityFor(row: Series): Activity | null`
  - `const ACTIVITY_DEBOUNCE_MS = 150` (exported so the test can wait it out)

**Ordering note for the implementer.** Correctness here does not depend on
effect ordering, and that is deliberate. Every cache and pending key contains
the interval, so a request issued against a stale interval can only ever write
a cache entry nobody reads. The abort-on-interval-change below is therefore a
*bandwidth* optimisation, not a correctness mechanism — if it ran late, or not
at all, the column would still be right. Do not add ordering machinery to
"fix" it.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/pickerState.test.svelte.ts`. The existing `fetchMock` in
`beforeEach` falls through to the signatures payload for any unrecognised URL,
so it needs a `/performance/data/` branch *before* that fallthrough:

```ts
// Add near the top of the file, beside `let signatures`:
// The /performance/data/ payload, keyed by signature_hash as the endpoint
// keys it. Tests that care replace it before building the picker.
let activityData: Record<string, unknown> = {};
let activityUrls: string[] = [];
```

```ts
// Inside the existing `beforeEach`, reset the new state alongside
// `signatures = {}`:
activityData = {};
activityUrls = [];
```

```ts
// Inside the existing fetchMock, BEFORE the final `return json(signatures)`:
if (s.includes('/performance/data/')) {
  activityUrls.push(s);
  return json(activityData);
}
```

Then add this describe block at the end of the file:

```ts
describe('run activity', () => {
  // The picker's own clock, so the assertions don't depend on wall time.
  const NOW = Date.UTC(2026, 7, 4, 12, 0, 0);

  function seriesRow(picker: PickerState, id: number): Series {
    return picker.combined.find((s) => s.id === id)!;
  }

  it('fetches nothing until asked', async () => {
    await withPicker(async (picker) => {
      expect(activityUrls).toEqual([]);
      expect(picker.activityFor(seriesRow(picker, 1))).toBeNull();
    });
  });

  it('batches one request per repo and fills the cache', async () => {
    signatures = { 1: signature(1), 2: signature(2) };
    activityData = {
      hash1: [{ ...datum, signature_id: 1, push_timestamp: NOW / 1000 - 60 }],
    };
    await withPicker(async (picker) => {
      picker.requestActivity(picker.combined);
      await settleActivity();
      // autoland and mozilla-central are the default repos, so two requests.
      expect(activityUrls).toHaveLength(2);
      expect(activityUrls[0]).toContain('signature_id=1');
      expect(activityUrls[0]).toContain('signature_id=2');
      const a = picker.activityFor(seriesRow(picker, 1))!;
      expect('error' in a).toBe(false);
    });
  });

  it('records 0 for a row the response omits, rather than leaving it pending', async () => {
    signatures = { 1: signature(1) };
    activityData = {};
    await withPicker(async (picker) => {
      picker.requestActivity(picker.combined);
      await settleActivity();
      const a = picker.activityFor(seriesRow(picker, 1))!;
      expect(a).toMatchObject({ total: 0, lastRunMs: null });
    });
  });

  it('does not refetch a row that is already cached', async () => {
    signatures = { 1: signature(1) };
    await withPicker(async (picker) => {
      picker.requestActivity(picker.combined);
      await settleActivity();
      const before = activityUrls.length;
      picker.requestActivity(picker.combined);
      await settleActivity();
      expect(activityUrls).toHaveLength(before);
    });
  });

  it('coalesces rows requested during the debounce window into one request', async () => {
    signatures = { 1: signature(1), 2: signature(2), 3: signature(3) };
    await withPicker(async (picker) => {
      const rows = picker.combined.filter((s) => s.repository === 'autoland');
      picker.requestActivity([rows[0]]);
      picker.requestActivity([rows[1]]);
      picker.requestActivity([rows[2]]);
      await settleActivity();
      const autoland = activityUrls.filter((u) => u.includes('/autoland/'));
      expect(autoland).toHaveLength(1);
      for (const id of [1, 2, 3]) expect(autoland[0]).toContain(`signature_id=${id}`);
    });
  });

  it('splits a batch larger than the request-line limit', async () => {
    signatures = {};
    for (let id = 1; id <= MAX_IDS_PER_REQUEST + 5; id++) signatures[id] = signature(id);
    await withPicker(async (picker) => {
      picker.requestActivity(picker.combined.filter((s) => s.repository === 'autoland'));
      await settleActivity();
      const autoland = activityUrls.filter((u) => u.includes('/autoland/'));
      expect(autoland).toHaveLength(2);
    });
  });

  it('records the failure on the row rather than in the error banner', async () => {
    // Activity is decoration on a list that works without it. A failed fetch
    // must not be why the picker looks broken.
    signatures = { 1: signature(1) };
    fetchMock.mockImplementation(async (url: string) => {
      const s = String(url);
      if (s.includes('/performance/framework/')) return json([{ id: 13, name: 'browsertime' }]);
      if (s.includes('/optioncollectionhash/')) {
        return json([{ option_collection_hash: 'H_OPT', options: [{ name: 'opt' }] }]);
      }
      if (s.includes('/performance/data/')) return { ok: false, status: 503, statusText: '' } as Response;
      return json(signatures);
    });
    await withPicker(async (picker) => {
      picker.requestActivity(picker.combined);
      await settleActivity();
      const a = picker.activityFor(seriesRow(picker, 1))!;
      expect('error' in a).toBe(true);
      expect(picker.errors).toEqual([]);
    });
  });

  it('misses the cache after the time range changes', async () => {
    signatures = { 1: signature(1) };
    await withPicker(async (picker) => {
      picker.requestActivity(picker.combined);
      await settleActivity();
      const before = activityUrls.length;
      picker.timeRangeSeconds = 604800;
      flushSync();
      // The signature list refetches too; wait for it before reading rows.
      await settleActivity();
      picker.requestActivity(picker.combined);
      await settleActivity();
      expect(activityUrls.length).toBeGreaterThan(before);
      expect(activityUrls[activityUrls.length - 1]).toContain('interval=604800');
    });
  });
});
```

Add these helpers near the file's other helpers (adapt `withPicker` to
whatever the existing file already uses to build a picker inside
`$effect.root` — reuse it rather than adding a second one):

```ts
// One datum shaped like the endpoint's, for tests that only care about count.
const datum = {
  id: 1,
  signature_id: 1,
  job_id: 1,
  push_id: 1,
  revision: 'abc',
  push_timestamp: 1785155040,
  value: 1,
};

// Wait out the activity debounce and let the fetch promises settle. Real
// timers, because the debounce is a plain setTimeout and faking timers here
// would also freeze the promise scheduling the fetches depend on.
async function settleActivity(): Promise<void> {
  await new Promise((r) => setTimeout(r, ACTIVITY_DEBOUNCE_MS + 20));
  flushSync();
  await Promise.resolve();
  flushSync();
}
```

Extend the imports at the top of the file:

```ts
import type { Series } from './api';
import { MAX_IDS_PER_REQUEST } from './activity';
import { ACTIVITY_DEBOUNCE_MS, PickerState } from './pickerState.svelte';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/pickerState.test.svelte.ts`
Expected: FAIL — `ACTIVITY_DEBOUNCE_MS` is not exported and
`picker.requestActivity` is not a function.

- [ ] **Step 3: Write the implementation**

In `src/lib/pickerState.svelte.ts`, add to the imports:

```ts
import {
  MAX_IDS_PER_REQUEST,
  activityCacheKey,
  buildActivities,
  chunkIds,
  type Activity,
} from './activity';
import { fetchActivityData } from './activityApi';
```

Add above the class:

```ts
// Long enough that a flung scrollbar doesn't queue a request per frame for
// windows nobody looked at, short enough that a deliberate scroll-and-read
// fills in while the eye is still travelling.
export const ACTIVITY_DEBOUNCE_MS = 150;

// Bounded like the graph caches: scrolling a 25k-row list would otherwise
// accumulate entries for the lifetime of the tab. Eviction is insertion
// order — least recently *fetched*, not least recently read. True read-LRU
// would mean writing to the cache during render, which isn't worth it for a
// decoration; the cost is that scrolling far away and back refetches.
const MAX_ACTIVITY_ENTRIES = 5000;
```

Add to the class, in a new `// ---- Run activity ----` section after the
fetch caches:

```ts
  // `activityCacheKey(row.key, interval)` → the row's answer, or the reason
  // it hasn't got one. An absent entry means "not fetched yet", which is why
  // an idle series must be stored as `total: 0` rather than left out.
  activityCache = $state(new Map<string, Activity>());
  // Cache keys queued or in flight, so a row isn't requested twice.
  private activityPending = new Set<string>();
  // Rows waiting for the next batch, keyed by `Series.key` to dedupe.
  private activityQueue = new Map<string, Series>();
  private activityTimer: ReturnType<typeof setTimeout> | null = null;
  private activityControllers = new Set<AbortController>();

  activityFor(row: Series): Activity | null {
    return this.activityCache.get(activityCacheKey(row.key, this.timeRangeSeconds)) ?? null;
  }

  // Called from the picker's virtual-scroll effect with the rows currently on
  // screen. Cheap and idempotent: everything already cached or in flight is
  // dropped here, so a scroll that reveals two new rows queues two ids.
  requestActivity(rows: readonly Series[]): void {
    for (const row of rows) {
      const key = activityCacheKey(row.key, this.timeRangeSeconds);
      if (this.activityCache.has(key) || this.activityPending.has(key)) continue;
      this.activityPending.add(key);
      this.activityQueue.set(row.key, row);
    }
    if (this.activityQueue.size === 0 || this.activityTimer !== null) return;
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      this.flushActivityQueue();
    }, ACTIVITY_DEBOUNCE_MS);
  }

  // Abort whatever is in flight and forget what was queued. Called when the
  // interval changes, purely to stop paying for answers about a window the
  // user has left — every key carries its interval, so a late response could
  // only ever write a cache entry nobody reads. This is an optimisation, not
  // a correctness mechanism; see the note in the plan.
  private resetActivityRequests(): void {
    for (const c of this.activityControllers) c.abort();
    this.activityControllers.clear();
    this.activityPending.clear();
    this.activityQueue.clear();
    if (this.activityTimer !== null) {
      clearTimeout(this.activityTimer);
      this.activityTimer = null;
    }
  }

  private flushActivityQueue(): void {
    // Captured once: the interval must not change under a batch mid-flight.
    const interval = this.timeRangeSeconds;
    const byRepo = new Map<string, number[]>();
    for (const row of this.activityQueue.values()) {
      const ids = byRepo.get(row.repository);
      if (ids) ids.push(row.id);
      else byRepo.set(row.repository, [row.id]);
    }
    this.activityQueue.clear();
    for (const [repo, ids] of byRepo) {
      for (const chunk of chunkIds(ids, MAX_IDS_PER_REQUEST)) {
        void this.loadActivity(repo, chunk, interval);
      }
    }
  }

  private async loadActivity(
    repo: string,
    ids: number[],
    interval: number,
  ): Promise<void> {
    const controller = new AbortController();
    this.activityControllers.add(controller);
    // The row keys these ids will be filed under. Built up front so the
    // failure path can mark exactly the same set.
    const keys = ids.map((id) => activityCacheKey(`${repo}|${id}`, interval));
    try {
      const response = await fetchActivityData(repo, ids, interval, controller.signal);
      const built = buildActivities(ids, response, Date.now(), interval);
      const entries: [string, Activity][] = [];
      for (const [id, activity] of built) {
        entries.push([activityCacheKey(`${repo}|${id}`, interval), activity]);
      }
      this.mergeActivity(entries);
    } catch (e) {
      // An aborted request isn't a failure to report — the interval moved on.
      if (controller.signal.aborted) return;
      // Per-row and quiet: no entry in `errors`, which is the banner the list
      // uses for "your repos didn't load". This column is decoration.
      const message = (e as Error).message;
      this.mergeActivity(keys.map((k) => [k, { error: message }] as [string, Activity]));
    } finally {
      this.activityControllers.delete(controller);
      for (const k of keys) this.activityPending.delete(k);
    }
  }

  private mergeActivity(entries: readonly [string, Activity][]): void {
    if (entries.length === 0) return;
    const next = new Map(this.activityCache);
    for (const [k, v] of entries) {
      // Delete before set so a re-fetched key moves to the end of the
      // insertion order rather than keeping its old position.
      next.delete(k);
      next.set(k, v);
    }
    while (next.size > MAX_ACTIVITY_ENTRIES) {
      const oldest = next.keys().next().value;
      if (oldest === undefined) break;
      next.delete(oldest);
    }
    this.activityCache = next;
  }
```

In the constructor, after the existing fetch effect, add:

```ts
    // Stop paying for activity in a window the user has left. Reading
    // `timeRangeSeconds` is the whole subscription; the first run is a no-op
    // because there is nothing in flight yet.
    $effect(() => {
      void this.timeRangeSeconds;
      this.resetActivityRequests();
    });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/pickerState.test.svelte.ts`
Expected: PASS, including the pre-existing cases.

If the "misses the cache after the time range changes" case is flaky, the
likely cause is `settleActivity` not waiting for the 22 MB-shaped signatures
refetch that a range change also triggers. Await a second `settleActivity()`
rather than lengthening the timeout.

- [ ] **Step 5: Run the full gate**

Run: `npm run check && npm test && npm run build`
Expected: all three clean.

- [ ] **Step 6: Commit**

```bash
jj commit -m "$(cat <<'EOF'
Fetch and cache run activity for the rows on screen

PickerState gains a debounced, per-repo-batched fetch driven by whatever the
caller says is visible, plus an insertion-order-bounded cache. Nothing calls
requestActivity yet; the column follows.

Every cache and pending key carries the interval, which is what makes this
independent of effect ordering: a request issued against a range the user has
already left can only write an entry nobody reads. The abort on range change
is therefore about bandwidth, not correctness — worth having on a page that
already pulls 22 MB per repo, but not something to build ordering machinery
around.

A failed activity fetch is recorded on the row, not in `errors`. The column
is decoration on a list that works without it, and it must never be the
reason the picker looks broken.
EOF
)"
```

---

## Task 4: The column

**Files:**
- Modify: `src/lib/AddSeriesPicker.svelte`
- Modify: `src/app.css`

**Interfaces:**
- Consumes: `picker.requestActivity`, `picker.activityFor` (Task 3);
  `activityPath`, `activityTitle`, `type Activity` (Task 1); `TIME_RANGES`
  from `./api`.
- Produces: no new module exports.

- [ ] **Step 1: Add the theme token**

In `src/app.css`, add to the `:root` block, in the field-color group near
`--field-option-fg`:

```css
  /* Run-activity bars in the picker. Deliberately quiet: the strip is
     peripheral information the eye should be able to skim past. */
  --activity-bar: #8c959f;
```

And the matching entry in the `:root[data-theme='dark']` block:

```css
  --activity-bar: #6e7681;
```

- [ ] **Step 2: Add the column, header and cell**

In `src/lib/AddSeriesPicker.svelte`, extend the imports:

```ts
  import { TIME_RANGES, type Series } from './api';
  import { activityPath, activityTitle } from './activity';
```

Add beside the other layout constants near `ROW_HEIGHT`:

```ts
  // Strip geometry, in px. Fixed, so a row's activity cell occupies the same
  // space before and after its data arrives.
  const STRIP_W = 72;
  const STRIP_H = 14;
```

Add after the `skeletonCount` derivation:

```ts
  // The label the Time range select is showing, for the column header and the
  // hover text. Taken from TIME_RANGES rather than a second abbreviation
  // table, so there is one place where "14 days" is spelled.
  const rangeLabel = $derived(
    TIME_RANGES.find((t) => t.value === picker.timeRangeSeconds)?.label ?? '',
  );

  // Ask for activity for whatever is on screen. `visibleWindow` already
  // accounts for the overscan, so this covers the rows about to scroll in
  // too. `requestActivity` drops everything cached or in flight, so this
  // firing on every scroll tick is cheap.
  $effect(() => {
    picker.requestActivity(
      visibleWindow.flatMap((item) => (item.kind === 'note' ? [] : [item.row])),
    );
  });
```

Add the `<col>`, after `col-unit-w`:

```svelte
        <col class="col-activity-w" />
```

Add the header cell, after the `Unit` sort header. Not a `sortHeader`: see
the non-goal in Step 6.

```svelte
          <th class="col-activity" title="Runs recorded in the selected time range">
            runs ({rangeLabel})
          </th>
```

Add this snippet in `<tbody>`, beside the existing `pickCell` snippet:

```svelte
        <!-- Three states in one fixed-size cell, so nothing moves as data
             lands: not fetched yet, failed, and answered. The `<svg>` is
             always present at the same width and height even when it draws
             nothing — an empty box is what keeps the column from twitching
             row by row as batches arrive. -->
        <!-- `{@const}` takes no type annotation, so `activity` is inferred as
             `Activity | null` from `activityFor`. Annotating it here is a
             compile error, not a style choice. -->
        {#snippet activityCell(row: Series)}
          {@const activity = picker.activityFor(row)}
          <td class="col-activity">
            <span class="activity">
              {#if activity === null}
                <span class="runs runs-pending">·</span>
              {:else if 'error' in activity}
                <span class="runs runs-pending" title="Run activity failed: {activity.error}"
                  >—</span
                >
              {:else}
                <span class="runs" title={activityTitle(activity, rangeLabel, Date.now())}
                  >{activity.total.toLocaleString()}</span
                >
              {/if}
              <svg
                class="strip"
                width={STRIP_W}
                height={STRIP_H}
                viewBox="0 0 {STRIP_W} {STRIP_H}"
                aria-hidden="true"
              >
                {#if activity !== null && !('error' in activity)}
                  <path d={activityPath(activity.counts, STRIP_W, STRIP_H)} />
                {/if}
              </svg>
            </span>
          </td>
        {/snippet}
```

Render it as the last cell of both the parent row (after
`<td class="unit">{row.measurementUnit}</td>`) and the child row (after
`<td class="unit">{child.measurementUnit}</td>`):

```svelte
              {@render activityCell(row)}
```

```svelte
              {@render activityCell(child)}
```

- [ ] **Step 3: Fix every other place that counts columns**

There are four, and missing one leaves a visibly broken row. Change each
`colspan="8"` to `colspan="9"`:

- the top spacer row
- the bottom spacer row
- the `subtest-note` row
- the empty/`no-repos` row

And add one more cell to the skeleton row, so the loading state carries the
same column widths as the loaded list:

```svelte
              <td><span class="skeleton-bar"></span></td>
```

- [ ] **Step 4: Add the CSS**

Replace the `<col>` width block with these values. The percentages have to
come down to make room for a px-width column: under `table-layout: fixed` a
mix of percentages summing to 100% plus a fixed column over-specifies the
table. `min-width` rises to keep the narrowed columns from cramping.

```css
  col.col-check-w    { width: 32px; }
  col.col-disclose-w { width: 24px; }
  col.col-suite-w    { width: 22%; }
  col.col-app-w      { width: 8%; }
  col.col-repo-w     { width: 8%; }
  col.col-platform-w { width: 16%; }
  col.col-options-w  { width: 22%; }
  col.col-unit-w     { width: 6%; }
  /* Fixed rather than a percentage: the count and the strip are both a known
     number of pixels wide, so this column has an actual right answer and no
     reason to breathe with the viewport. */
  col.col-activity-w { width: 128px; }
```

And change the table's floor, in the `table` rule:

```css
    min-width: 72em;
```

Add these rules near the `.unit` rule:

```css
  .activity {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
  }
  .runs {
    /* Reserved width, in digits that are all the same width: 6 becoming
       1,204 must not shove the strip sideways. */
    font-variant-numeric: tabular-nums;
    min-width: 5ch;
    text-align: right;
  }
  .runs-pending {
    color: var(--fg-subtle);
  }
  .strip {
    /* Always laid out, even when it draws nothing — the empty box is what
       stops the column twitching as batches land. `block` because an inline
       svg picks up the line-box descender and would sit low in the row. */
    display: block;
    flex: none;
    fill: var(--activity-bar);
  }
```

- [ ] **Step 5: Verify in a browser**

`npm run check` cannot see a column-width mistake, and this step is the whole
reason the widths in Step 4 are specific. Per docs/design.md, puppeteer is
installed temporarily and removed before the commit.

```bash
npm install --save-dev puppeteer
npm run dev   # in another shell; note the port it prints
```

Write `smoke.mjs`:

```js
// Throwaway. Checks the two things static analysis can't: that the new
// column doesn't push the table into a horizontal scrollbar at a normal
// window size, and that the counts actually arrive.
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.goto('http://localhost:5173/?picker=1', { waitUntil: 'networkidle0' });
await page.waitForSelector('tbody tr .strip', { timeout: 120000 });

// Give the debounce and one batch time to land.
await new Promise((r) => setTimeout(r, 3000));

const report = await page.evaluate(() => {
  const table = document.querySelector('.picker table');
  const wrapper = table.parentElement;
  const headers = [...document.querySelectorAll('thead th')].map((th) => ({
    text: th.textContent.trim().slice(0, 20),
    width: Math.round(th.getBoundingClientRect().width),
  }));
  const counts = [...document.querySelectorAll('tbody tr .runs')]
    .slice(0, 8)
    .map((el) => el.textContent.trim());
  const paths = [...document.querySelectorAll('tbody tr .strip path')].length;
  return {
    overflows: wrapper.scrollWidth > wrapper.clientWidth,
    headerCount: headers.length,
    headers,
    counts,
    paths,
  };
});
console.log(JSON.stringify(report, null, 2));
await browser.close();
```

Run: `node smoke.mjs`

Expected: `headerCount` is 9; the last header reads `runs (14 days)` at about
128px; `overflows` is `false`; `counts` are numbers rather than all `·`; and
`paths` is greater than 0.

If `overflows` is `true`, lower `min-width` on `table` or shave a percentage
point off `col-options-w` — do not shrink `col-activity-w` below 128px, which
is what the count and the 72px strip actually need.

Then check the dark theme and a narrow window:

```bash
# In smoke.mjs, before goto:
#   await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
# and separately, a 1100px viewport.
node smoke.mjs
```

Expected: bars are visible against the dark background (they use
`--activity-bar`, so a hardcoded color would show up here as invisible or
glaring), and the narrow viewport degrades to a horizontal scrollbar rather
than to overlapping columns.

- [ ] **Step 6: Document it**

In `docs/design.md`, add a subsection near the picker's other subsections:

```markdown
### Run activity is fetched for the visible window only

Each picker row shows how many times that series ran in the selected time
range, plus a density strip of when. It comes from
`/project/<repo>/performance/data/`, which takes many `signature_id`s per
request — about 3.5 KB gzipped each, so one screenful is one request per
repo. Three quirks of that endpoint, all of them recorded in
[activityApi.ts](../src/lib/activityApi.ts): the response is keyed by the
aliasing `signature_hash` rather than by id (so `buildActivities` regroups on
each datum's own `signature_id`), `push_timestamp` is unix seconds where
`/performance/summary/` sends an ISO string, and requests cap out at about
195 ids because treeherder's frontend rejects a request line over 4094 bytes.

**The column is deliberately not sortable.** Sorting would need counts for
every one of the ~25k filtered rows; we fetch only the ~29 on screen, which
is what makes the column affordable enough to be always-on. If sorting turns
out to be what's wanted, the shape of the fix is to fetch counts for the
whole filtered set once it's under a couple of hundred rows and enable the
header at that point.

A failed activity fetch is recorded on the row as a muted `—`, not in the
error banner. The column is decoration on a list that works without it, and
it must not be the reason the picker looks broken.
```

In `docs/graphs-todo.md`, add to the **Done** list:

```markdown
- Run activity in the picker — a per-row run count and density strip over the
  selected time range (`activity.ts`, `activityApi.ts`, + tests). See
  docs/design.md, "Run activity is fetched for the visible window only"
```

- [ ] **Step 7: Remove puppeteer and run the full gate**

```bash
npm uninstall puppeteer
rm smoke.mjs
npm run check && npm test && npm run build
```

Expected: all three clean, and `git diff package.json` shows no puppeteer
entry. If `package-lock.json` still mentions puppeteer, run `npm install`
once more to prune it.

- [ ] **Step 8: Commit**

```bash
jj commit -m "$(cat <<'EOF'
Show run counts and a density strip in the picker

Two rows in the picker can differ only in ways the columns don't make
meaningful — three platform variants of one suite, an -fis and a -nofis
option set — and nothing on screen said which one is actually being measured
and which is a signature that ran twice in March. The new column answers
that: a run count over the selected time range, and a strip of when those
runs happened, so "ran heavily for three days then stopped" doesn't read as
healthy the way a bare count does.

The strip is one SVG path per row rather than a rect per bar or a canvas: a
screenful is ~29 rows at up to 24 bars each, and ~700 nodes churning through
the virtual scroller is what makes scrolling stutter.

The column widths had to be rebalanced — the existing percentages summed to
exactly 100%, which over-specifies the table once a px-width column joins
them under table-layout: fixed — and the table's min-width went up to keep
the narrowed columns from cramping. Verified against a throwaway puppeteer
script in both themes at 1440px and 1100px: no horizontal scrollbar at the
former, a scrollbar rather than overlap at the latter.
EOF
)"
```

---

## Self-Review

**Spec coverage.** Every section of
`docs/superpowers/specs/2026-08-04-picker-run-activity-design.md` maps to a
task:

| Spec section | Task |
| --- | --- |
| Data layer (schema, three quirks, retain timestamps only) | 2 (schema, two quirks) + 1 (`buildActivities`, the regroup and zero-seed quirks) |
| Pure module (`chunkIds`, `binDuration`, `binCounts`, `activityPath`, `activityTitle`, `groupBySignatureId`) | 1 |
| Fetch orchestration (cache, debounce, batching, abort, bound, per-entry failure, subtest rows) | 3 |
| Rendering (column, header label, layout stability, colgroup rebalance, `--activity-bar`, colspan/skeleton) | 4 |
| Non-goals (not sortable, documented) | 4, Step 6 |
| Testing (`activity.test.ts`, one `pickerState` seam case, all three CI steps) | 1, 2, 3, and the gate step in each |

Two deliberate deviations from the spec, both recorded here so a reviewer
doesn't read them as drift:

- The spec illustrates the header as `runs (14d)`. The plan uses the
  `TIME_RANGES` label verbatim — `runs (14 days)` — rather than introducing a
  second abbreviation table for the same six ranges. It fits the 128px
  column, and it matches the tooltip's "in 14 days".
- The spec names `groupBySignatureId` as its own export. The plan folds it
  into `buildActivities`, because nothing else needs the intermediate map and
  a second exported function would be an untested-in-isolation seam for no
  caller's benefit. The behaviour it describes is tested, under
  `buildActivities`.

**Placeholder scan.** No TBD/TODO, no "add error handling", no "similar to
Task N", no "write tests for the above". Every code step carries the actual
code. The one instruction that isn't literal code is Task 3's "adapt
`withPicker` to whatever the existing file already uses" — deliberate,
because the existing test file's helper must be reused rather than
duplicated, and its exact current name is the one thing the implementer can
read faster than this plan can assert.

**Type consistency.** `Activity`, `ActivityDatumLike`, `activityCacheKey`,
`chunkIds`, `binDuration`, `binCount`, `binCounts`, `buildActivities`,
`activityPath`, `activityTitle`, `MAX_IDS_PER_REQUEST`, `MAX_BINS` are
defined in Task 1 and used under those exact names in Tasks 3 and 4.
`ActivityResponse`, `activityDataUrl`, `fetchActivityData` are defined in
Task 2 and used under those names in Task 3. `activityCache`,
`requestActivity`, `activityFor`, `ACTIVITY_DEBOUNCE_MS` are defined in Task
3 and used under those names in Task 4. `binCount` is exported in Task 1's
implementation but not listed in its Interfaces block, because only
`binCounts` uses it — harmless, and leaving it exported keeps it directly
testable.
