# Graphs view — design and status

Companion to [design.md](design.md), which covers the "Add series" picker.
This file covers the graphs half of the app: layout, data model, rendering,
selection, and URL state.

Treeherder's implementation lives in `~/code/treeherder/ui/perfherder/graphs/`
(`GraphsView.jsx`, `GraphsContainer.jsx`, `GraphTooltip.jsx`). Where we follow
it, the decision is recorded below so it can be revisited; where we deviate
deliberately, the deviation is called out.

## Layout

Three panes, filling the viewport, no page scroll:

```
┌──────────────┬────────────────────────────────┬───────────────┐
│ Series list  │  overview graph (thin, full    │ Selection     │
│ (left)       │  time range, no lines)         │ details       │
│              ├────────────────────────────────┤ (right)       │
│ + Add series │  detail graph (zoomed range)   │ build / run / │
│              │                                │ replicate     │
└──────────────┴────────────────────────────────┴───────────────┘
```

The "Add series" picker opens as an overlay panel over the whole area rather
than living in the left pane — it needs the full width for its table.

## Data model

### Fetch

`GET /api/performance/summary/` with
`repository`, `signature=<signature id>`, `framework`, `all_data=true`,
`replicates=true`, and `startday`/`endday`.

- **We pass `startday`/`endday` (absolute), treeherder passes `interval`
  (relative).** This is the deviation the task called for: a URL that says
  "last 14 days" points at a moving window, so a linked data point silently
  falls out of range over time. Absolute bounds keep permalinks stable. The
  UI still offers "Last N days" buttons; they compute absolute bounds at
  click time and bake those into the URL.
- Format is naive ISO (`YYYY-MM-DDTHH:mm:ss`), interpreted by the backend as
  UTC. The backend filters `push_timestamp > startday AND < endday`.
- `all_data=true` is required to get the per-datum `data` array at all; without
  it the endpoint returns aggregate `values`.

### Replicates

`replicates=true` is **always on** (task requirement; treeherder makes it a
toggle). The backend then emits one row per replicate value, all sharing the
same datum `id`, `job_id`, `push_id` and `push_timestamp`. When a datum has no
replicates recorded, the backend falls back to emitting a single row with the
summary `value`. So "a run always has at least one value" holds.

### The three-level hierarchy

Flat API rows are grouped into the structure the right-hand pane displays:

```
push   (push_id, revision, push_timestamp)   ← "build" in the task description
└─ run (job_id, datum id)                    ← "job"
   └─ replicate (index, value)
```

`push_id` groups retriggers of the same build; `job_id` distinguishes them.
Replicate index is positional within a datum — the API gives no replicate id,
and the order is the DB row order of `performancedatumreplicate`.

A **plotted point** is one replicate. Its identity is
`(repository, signatureId, datumId, replicateIndex)`; that's what the URL
stores and what hit-testing resolves to. `datumId` alone is what treeherder
stores (`selected=<signature_id>,<dataPointId>`), which is ambiguous once
replicates are on — hence the extra index. The repo is included because
signature ids are only unique per repo, matching `Series.key` in the picker.

### Push and job details

Clicking a dot needs more than the summary payload carries:

- push: `GET /api/project/<repo>/push/<pushId>/` → revision, author,
  `push_timestamp`, and `revisions[]` with per-commit `comments`.
- job: `GET /api/project/<repo>/jobs/<jobId>/` → job type name, machine,
  result, timestamps, and log links.

Both are fetched lazily on selection and cached by id.

**`job_id` is frequently null, and that is not an error.** Treeherder keeps
performance data far longer than the jobs that produced it — roughly four
months for jobs — and nulls out the datum's `job_id` when the job row goes
away. On a one-year range, most points have no job: for signature 5276320 on
mozilla-central in July 2026, 583 of 860 datums were null, all of them older
than the end of March. Pushes are *not* expired the same way, so the Build
section of the pane keeps working for those points.

Consequences, all in `Run.jobId: number | null`:

- Never request `/jobs/null/` — treeherder answers that with a **500**.
- The pane reports `expired` rather than "loading…". `selectedJobStatus`
  on `AppState` is the four-state version of this (`loaded` / `loading` /
  `expired` / `failed`); a failed lookup is remembered in a negative cache
  so the selection effect can't reissue it and the pane can't hang.
- The "Job" link degrades to the push's job list, with no `selectedJob`
  parameter.

### Caching and failure

Series data is cached under `(repo, signature, rangeStart, rangeEnd)` — the
tuple that identifies one API response. Entries outside the current
(series × range) set are **pruned**, and their in-flight fetches aborted:
without that, every click on a range preset leaves a full set of point arrays
behind, megabytes each, for the lifetime of the tab. Going Back to a previous
range therefore refetches. That trade is deliberate.

A failed fetch records an error against the key. That record is load-bearing:
a failure leaves no cache entry, so the loading effect would otherwise re-fire
on the state change the failure itself caused and hammer the API in a loop.
Recovery is the explicit Retry button.

## Code map

- [graphApi.ts](../src/lib/graphApi.ts) — the three endpoints, plus
  `/repository/` for hg-vs-git link shapes. Network only.
- [graphData.ts](../src/lib/graphData.ts) — **pure**. Flat rows →
  push/run/replicate, plus the flat arrays the renderer walks.
- [chart.ts](../src/lib/chart.ts) — **pure**. Scales, domains, ticks,
  formatting, plot geometry, hit-testing, palette.
- [chartDraw.ts](../src/lib/chartDraw.ts) — canvas painting. Imperative, but
  takes all its coordinates from a `PlotGeometry`.
- [timeRange.ts](../src/lib/timeRange.ts) — **pure**. Presets ↔ absolute
  bounds.
- [urlState.ts](../src/lib/urlState.ts) — **pure**. Query string ↔ `ViewState`.
- [appState.svelte.ts](../src/lib/appState.svelte.ts) — the reactive core.
- [ScatterChart.svelte](../src/lib/ScatterChart.svelte) — one canvas component
  serving both graphs, parameterized by `interaction: 'select' | 'brush'`.
- [SeriesList.svelte](../src/lib/SeriesList.svelte),
  [GraphPane.svelte](../src/lib/GraphPane.svelte),
  [DetailsPane.svelte](../src/lib/DetailsPane.svelte) — the three panes.

**Do not put a `SeriesData` inside a `$state` object or array.** Svelte 5
deep-proxies plain objects and arrays assigned to `$state`, and a proxied
20k-element point array turns every read in the draw loop into a proxy trap.
The series caches are `Map`s (which Svelte does not proxy) that get replaced
wholesale to trigger reactivity — the same pattern the picker uses.

## Rendering

**Canvas, not SVG.** A single series over 90 days with replicates is easily
20k+ points; treeherder's Victory/SVG approach creates a DOM node per point
and is visibly slow past a few thousand. We draw to a `<canvas>` and hit-test
in JS against the same coordinate transform.

**Two canvas layers per graph.** The data layer (grid, axes, run lines, dots)
only repaints when the data or the domains change. The overlay layer (brush
window, selection ring) repaints on every frame of a drag. Measured with 8
series over 90 days — 111k plotted replicates — dragging the overview brush:
one combined layer gave p90 25ms frames and a 134ms worst frame, because
moving the window repainted all 111k dots; split, the same drag is p90 17ms,
worst 18ms. Pointer and keyboard events live on the wrapper `<div>`, since
the overlay canvas would otherwise swallow them.

Decisions carried over from treeherder:

- One shared linear y-axis for all visible series, even when their units
  differ. Mixing units on one axis is questionable, but it's what Perfherder
  does and users are used to comparing shapes rather than absolute values.
  Revisit if it bites.
- x-axis is push timestamp, not job submit time.
- Series colors come from a fixed palette assigned in add order.

Deliberate deviations:

- **No tooltip and no hover/click arrow panel.** Clicking a dot fills the
  right-hand pane instead.
- **Smaller dots.** Treeherder uses `DOT_SIZE = 5`; at high point counts the
  plot turns into a solid blob. We use radius 2 in the detail graph and 1 in
  the overview.
- **No connecting lines in the overview graph**, per the task. The detail
  graph does draw them (treeherder's `VictoryLine`), one polyline per series
  through the per-run mean.
- **Tighter y padding.** Treeherder pads the y domain by `(max-min)/1.8` on
  each side, so data occupies under half the plot height. We pad by 5%.
- **The graph fills the remaining viewport**, rather than treeherder's fixed
  `CHART_WIDTH = 1350`.
- **Larger color palette.** Treeherder cycles 6 colors × 6 symbols; we use a
  12-color categorical palette and no symbol variation (symbols are hard to
  distinguish at radius 2).

**Hiding a series** keeps it in the list, in the URL, and in its color slot —
only the drawing stops. Everything downstream of `AppState.visibleSeries`
(both y domains, hit-testing, the "no data" note, keyboard stepping) works off
the visible subset, so a hidden series can't influence the plot. A selection
belonging to a hidden series survives; the details pane says why it isn't on
screen and offers to unhide.

## URL state

Everything the task listed is in the query string:

| Param | Meaning |
|---|---|
| `series` | Repeated. Each is `repo,signatureId,frameworkId[,0]`; the trailing `0` means hidden and is omitted when visible. **Order is significant** — it drives legend order and color assignment. |
| `range` | Absolute full time range, `<startMs>,<endMs>` |
| `zoom` | Absolute zoomed range, `<startMs>,<endMs>`; absent when not zoomed |
| `sel` | Selected point, `<repo>,<signatureId>,<datumId>,<replicateIndex>` |
| `picker` | `1` when the Add-series panel is open |
| `pf` | Picker filter free text |
| `pc` | Picker filter chips, `field:value` repeated |

If `sel` names a point that isn't in the loaded data (e.g. the range was
narrowed), the selection is dropped rather than shown as a phantom —
treeherder does the same (`verifySelectedDataPoint`).

`pf` / `pc` are only written while `picker=1`; a closed panel's filter would
be noise in every shared graph link.

**History granularity.** URL writes are not driven by an `$effect` — each
mutation on `AppState` decides between `pushState` and `replaceState`.
Discrete actions (add/remove series, pick a range, commit a zoom, select a
point, open the panel) push, so the back button undoes them one at a time.
Continuous ones (each frame of a zoom drag, each keystroke in the picker
filter) replace. An effect can't tell those apart, which is why the sync is
explicit.

## Status

See [graphs-todo.md](graphs-todo.md).
