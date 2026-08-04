# Run activity in the Add-series picker

Status: approved 2026-08-04, not yet implemented.

## Problem

The picker lists one flat row per performance series across the selected
repos. When several rows differ only in ways the columns don't make
meaningful — three platform variants of one suite, a `-fis` and a `-nofis`
option set, two applications of the same test — there is nothing on screen
to say which one is the live, actively-measured variation and which is a
signature that ran twice in March and never again. The list is sorted and
filtered on identity, never on whether the series has any recent data.

What's missing is *volume and recency*: how many times has this variation
run in the window the list is already scoped to, and was it spread across
the whole window or a burst that stopped?

## Feasibility

Cheap, and there is a batching endpoint built for it.

```
GET /api/project/<repo>/performance/data/?interval=<sec>&signature_id=…(×N)
```

(`PerformanceDatumViewSet.list`, `treeherder/webapp/api/performance_data.py`.)
It takes many signature ids in one request and answers with one compact row
per run: `{id, signature_id, job_id, push_id, revision, push_timestamp,
value}`. That's a count *and* a timeline out of the same payload.

Measured against production on 2026-08-04, `interval` = 14 days, gzipped:

| batch | transfer | time |
| --- | --- | --- |
| 50 signatures | 177 KB | 0.32 s |
| 150 signatures | 333 KB | 0.86 s |
| 200 signatures | 412 KB | 1.05 s |

About 3.5 KB gzipped per signature — negligible beside the ~22 MB signatures
fetch the picker already performs per repo.

The rejected cheaper alternative: `/performance/signatures/` *filters* on
`last_updated` but never returns it, so bucketing series by recency would
cost one 22 MB download per bucket. Not viable.

## Decisions

Settled during brainstorming; recorded with the reasoning because each one
constrains the others.

**Always-on, fetched lazily per visible window.** Every row in the virtual
scroll window gets a count and a strip. The alternative — reveal on
hover/click — is cheaper but defeats the purpose: the hard part is *scanning
and comparing* a list, which you cannot do one row at a time.

**The strip is run density per day-ish bucket**, bar height = number of runs
in that bucket. Rejected: plotting the measured values (each row would carry
its own y-scale and unit, so rows stop being comparable — and a noisy series
is a smudge at 72px); a binary ran/didn't-run block (1 run/day and 90
retriggers/day would look identical); count with no strip (a burst that
stopped three days ago reads as healthy).

**The window follows the picker's existing Time range select.** The column
header names it (`runs (14d)`), and the strip's window becomes literally the
same server-side filter as the list's. Staleness is still legible: at 90
days, a test that stopped a month ago has bars on the left and nothing on
the right. Rejected: a fixed 14-day window, which would put two different
notions of "recent" on screen at once.

## Data layer

New `src/lib/activityApi.ts`, separate from `api.ts` the way `graphApi.ts`
is.

Request uses the relative `interval` parameter, matching `fetchSignatures`.
The absolute-bounds argument in `docs/graphs.md` ("a URL that says last 14
days points at a moving window") is about permalink stability and does not
apply: nothing here is linkable.

Three quirks, all verified against production, each of which gets a schema
comment in the house style:

- **The response is keyed by `signature_hash`, not by signature id.** This
  codebase already documents that hashes alias within a repo — two rows
  differing only by `application` share one (see `api.ts`, `Series.key`) —
  so two requested series can land in a single bucket. Every datum carries
  its own `signature_id`; regroup on that and ignore the response keys
  entirely.
- **`push_timestamp` is an integer of unix seconds here**, where
  `/performance/summary/` returns a naive ISO string for the same column.
  A textbook case of the one-schema-per-endpoint rule `graphApi.ts` already
  states.
- **Signatures with no data in the window are omitted from the response**
  rather than returned empty. The cache must therefore be seeded for every
  *requested* id and filled in from the response, or a genuinely idle series
  stays "loading" forever instead of showing 0.

The valibot schema declares the whole row, per house style, but only
timestamps are retained — values are discarded, so a cached entry is a short
array of numbers.

## Pure module

`src/lib/activity.ts` with `activity.test.ts`. All logic lives here; the
`.svelte` file gets none.

- `chunkIds(ids, 150)`. A hard constraint, not a guess: 300 ids is rejected
  by treeherder's frontend before Django sees it, with `Request Line is too
  large (6069 > 4094)`. 150 leaves room for the other parameters.
- `groupBySignatureId(response)` → `Map<number, number[]>`, timestamps
  sorted.
- `binDuration(rangeSeconds)` — the *smallest* of `{1h, 3h, 6h, 12h, 1d, 2d,
  4d, 7d}` that keeps the bin count at 24 or below, i.e. the finest
  granularity the strip has room for. Not one bar per day: at 90 days that
  would be 0.8px per bar in a 72px strip. Every member of the set has a
  sayable name for the tooltip. Resolves to 3h at 2 days, 12h at 7, 1d at
  14, 2d at 30, and 4d at both 60 and 90.
- `binCounts(timestamps, nowMs, rangeSeconds)` → `number[]`. Bins are
  aligned to the *end* of the window, not the start: when the range isn't a
  whole multiple of the bin duration (90 days at 4d/bin is 22.5), the partial
  bin has to be the oldest one at the far left. Aligned the other way, the
  rightmost bar — the one the eye goes to, and the one that answers "is this
  running *now*" — would cover half the time of its neighbours and read as a
  decline that isn't there. Timestamps outside the window are clamped into
  the nearest end bin; the window bound is the server's clock, not ours.
- `activityPath(counts, width, height)` → a single SVG path string. Not 24
  `<rect>`s per row and not a canvas: a screenful is roughly 29 rows, and
  ~700 DOM nodes churning through the virtual scroller is what makes
  scrolling stutter. One `<path>` per row takes `fill: currentColor`, needs
  no devicePixelRatio handling and no canvas lifecycle, and is testable as
  a string.
- `activityTitle(count, timestamps, rangeLabel)` → `"1,204 runs in 14 days ·
  last run 4 hours ago"` — the staleness answer in words, for the hover.

## Fetch orchestration

On `PickerState`, per the state-ownership rule in `docs/design.md`:

```ts
type Activity =
  | { counts: number[]; total: number; lastRunMs: number | null }
  | { error: string };

activityCache = $state(new Map<string, Activity>()); // `${repo}|${id}|${interval}`
activityPending = new Set<string>();
requestActivity(rows: Series[]): void;
```

`AddSeriesPicker` gains one `$effect` over its existing `visibleWindow` that
calls `requestActivity`. The interval is part of the cache key, so changing
the Time range invalidates without a manual sweep.

Parent and subtest rows are treated identically: a child's signature id
rides in the same batch as its parent's, so an expanded row's subtests fill
in as they scroll into view. An idle series is `{counts: […zeros], total: 0}`
— a real answer, distinct from an absent cache entry, which means "not
fetched yet".

- **Debounced ~150 ms**, in `PickerState` rather than the component, so the
  timer is testable without a DOM. A flung scrollbar must not queue thirty
  requests for windows nobody looked at.
- **Grouped by repo, chunked at 150.** A realistic screenful — ~17 visible
  rows plus the 12 rows of overscan — across one or two checked repos is one
  request per repo, ~100 KB gzipped, ~0.3 s.
- **In-flight requests are aborted when the interval changes.** Their
  results are keyed to the dead interval and would be dropped anyway; what
  aborting saves is bandwidth, which matters on a page that already pulls
  22 MB per repo.
- **Bounded to ~5,000 entries**, like the graph caches, evicting in
  insertion order — least recently *fetched*, not least recently read. True
  read-LRU would mean writing to the cache during render, which is not worth
  it for a decoration. Scrolling a 25k-row list would otherwise accumulate
  without limit; 5,000 entries of ~24 numbers is trivial.
- **Failure is per-entry and quiet**: a muted `—` with the error in the
  `title`. No banner and no retry loop. This is decoration on a list that
  works without it, and it must never be the reason the picker looks broken.

## Rendering

One new column after `unit`, 128px: the count right-aligned in
`tabular-nums` (wide enough for `12,345`), a gap, then the 72px strip. The
header reads `runs (14d)`, with the label taken from the selected
`TIME_RANGES` entry.

Layout stability, which `CLAUDE.md` requires: the column is
`<colgroup>`-pinned and present from the first render, the count has a fixed
`min-width`, and the strip has a fixed `width`/`height` (about 72×14 inside
the 36px row). The pending state is a flat baseline rule rather than empty
space. Nothing moves when data arrives.

The existing column percentages sum to exactly 100%, so they need
rebalancing to make room for a px-width column under `table-layout: fixed`.
Two other easy-to-miss consequences of a ninth column: the `colspan="8"`
on the note and spacer rows becomes `colspan="9"`, and the skeleton row
grows one more `<td>` so the loading state still carries the same column
widths as the loaded list.

Bar color comes from a new `--activity-bar` custom property defined for both
themes in `app.css` — no literal hex. The strip is SVG rather than the
graphs' canvas, so the documented palette exception does not apply.

## Non-goals

**The runs column is not sortable.** This follows from the fetch strategy
rather than being an oversight: sorting needs counts for all ~25k filtered
rows, and we deliberately fetch only the ~29 on screen. To be recorded in
`docs/design.md` together with the escape hatch — if sorting turns out to be
what's actually wanted, fetch counts for the whole filtered set once it is
under ~200 rows and enable the header at that point.

Also out of scope: `no_retriggers` (we want runs, and a retrigger is a run),
plotting values in the strip, and any URL state — there is no knob to carry.

## Testing

`activity.test.ts` covers `binDuration` at all six ranges, binning
boundaries and future-timestamp clamping, empty input, and the generated
path string.

One `pickerState.test.svelte.ts` case pins the seam that would break
quietly: a visible window batches by repo, chunks at 150, records 0 for ids
the response omits, and does not refetch what is already cached. The
existing `fetchMock` there needs one more branch for `/performance/data/`.

`npm run check`, `npm test` and `npm run build` must all be clean, as CI
runs exactly those three.
