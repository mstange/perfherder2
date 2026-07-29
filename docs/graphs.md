# Graphs view — design and status

Companion to [design.md](design.md), which covers the "Add series" picker.
This file covers the graphs half of the app: layout, data model, rendering,
selection, and URL state. [comparison.md](comparison.md) covers what the
details pane does with a selection once it has one — push distributions and
comparison mode.

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

`replicates=true` is **always on** in the *fetch* (task requirement;
treeherder makes it a fetch-level toggle). The backend then emits one row per
replicate value, all sharing the same datum `id`, `job_id`, `push_id` and
`push_timestamp`. When a datum has no replicates recorded, the backend falls
back to emitting a single row with the summary `value`. So "a run always has at
least one value" holds.

*Drawing* them is a toggle (`AppState.showReplicates`, `reps=0` in the URL,
the "Replicates" checkbox above the graphs). Off, each run collapses to a
single dot at its mean, which takes a 90-day range from ~20k dots per series
to a few hundred and stops a real step in the data being buried in scatter.

Still one dot per *run*, note — not per push. A retriggered push keeps one dot
per retrigger, straddling the line's single vertex for that push. Collapsing
to one dot per push would need a second sentinel alongside `MEAN_REPLICATE`
and a push-level selection in the details pane, and it would hide that a build
was retriggered at all.

Keeping this on the drawing side rather than the fetch side is deliberate:
toggling is then instant and allocation-free rather than a refetch of every
series, and the details pane can still list a run's individual replicates in
either mode. `buildSeriesData` materializes both point sets up front
(`SeriesData.replicates` and `.means`, each a `PlotPoints` with its own
precomputed y extent); `AppState` picks one into `SeriesEntry.plot`, and
*everything* downstream — both graphs, both y domains, hit-testing, keyboard
stepping, the series list's point count — reads `plot` rather than re-deriving
the choice. That single choke point is what keeps the graph, the y axis and
the click targets from disagreeing about which dots exist.

Selecting a mean dot needs a way to say "not a replicate": that is
`MEAN_REPLICATE = -1`, which flows through `SelectedPoint.replicateIndex` and
the URL's `sel` unchanged. A selection is deliberately *not* rewritten when
the toggle flips — a mean selection is still valid with replicates drawn, and
a replicate selection still names a real value with them hidden, so coercing
it either way would throw away the point the user was looking at. The
consequence is that with replicates hidden, a replicate selection draws its
ring on a value that has no dot; that's honest (the ring shows where that
replicate sits relative to the mean) and reachable only by deliberately
picking one from the pane's replicate list.

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
  `/repository/` for hg-vs-git link shapes. Network and the valibot schemas
  that every response is validated against; the `Raw*`, `Push` and `Job`
  types are inferred from those schemas. See design.md, "Validating API
  responses" — including why nullability is transcribed from treeherder's
  serializers rather than from sampled payloads.
- [graphData.ts](../src/lib/graphData.ts) — **pure**. Flat rows →
  push/run/replicate, plus the flat arrays the renderer walks — both of them,
  see "Replicates" above.
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
- [stats.ts](../src/lib/stats.ts), [kde.ts](../src/lib/kde.ts),
  [distribution.ts](../src/lib/distribution.ts),
  [distributionDraw.ts](../src/lib/distributionDraw.ts),
  [compare.ts](../src/lib/compare.ts),
  [DistributionChart.svelte](../src/lib/DistributionChart.svelte) — the
  details pane's distributions and comparison mode. All pure except the last
  two. See [comparison.md](comparison.md).
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
- Series colors *and* dot symbols come from treeherder's own lists, assigned
  in add order. See "Series look" below.

Deliberate deviations:

- **No tooltip and no hover/click arrow panel.** Clicking a dot fills the
  right-hand pane instead. *Hovering* one fills the pane's comparison card as a
  preview against the selection — which is the same information a tooltip would
  carry, in a place where it has room to be a distribution and a rank-sum test.
  See [comparison.md](comparison.md).
- **Smaller dots.** Treeherder uses `DOT_SIZE = 5`; at high point counts the
  plot turns into a solid blob. We use radius 3 in the detail graph and 1.25
  in the overview — big enough to read the symbol shapes below, small enough
  that six series' replicates don't merge. Measured: the size makes no
  difference to redraw cost (median 16.6 ms either way on a live brush drag
  over 91k points), so it's purely a legibility call.
- **No connecting lines in the overview graph**, per the task. The detail
  graph does draw them (treeherder's `VictoryLine`), one polyline per series
  through the **per-push** mean — `PushGroup.mean`, the mean of that push's
  runs' means. Per push rather than per run because retriggers of one push
  share a push timestamp: joining runs put two or more vertices at the same x
  and drew a vertical zigzag there instead of a trend through one value per
  build. It also means the line can legitimately sit off a retriggered push's
  individual dots, which is why the details pane spells out `Push mean`
  whenever a push has more than one run.

  The mean is over the runs' means, *not* over all their replicates pooled: a
  retrigger is an independent sample of machine and run-to-run noise, so each
  job counts once however many replicates it recorded. The two coincide when
  the retriggers ran the same number of replicates, which is the normal case.
- **Tighter y padding.** Treeherder pads the y domain by `(max-min)/1.8` on
  each side, so data occupies under half the plot height. We pad by 5%.
- **The detail graph derives its y domain from the zoom window** instead of
  keeping a separate y zoom in the URL, so zooming in on a flat stretch
  doesn't leave it as a horizontal line at the bottom of the plot. The window
  extent has to account for the *connecting lines*, not just the dots: a series
  can have pushes on both sides of a narrow window and none inside it, and the
  stretch of line crossing the window still has to fit. `extentOf` therefore
  interpolates each series' line at both window edges — between the same push
  vertices `chartDraw` joins, so the domain can't disagree with what gets
  painted — and folds those two values in. Without it, a series off-scale from
  the others
  (speedometer3 cpuTime is ~0 ms for cstm-car-m and ~100 s for fenix)
  disappears whenever the zoom lands between two of its pushes.
- **The graph fills the remaining viewport**, rather than treeherder's fixed
  `CHART_WIDTH = 1350`.
- **Colors and symbols past the sixth series.** See below — we keep
  treeherder's six of each, but treeherder stops drawing after six series and
  we don't.

## Series look: treeherder's colors and symbols

Both lists are lifted from treeherder's
`ui/perfherder/perf-helpers/constants.js` (`graphColors`, `graphSymbols`), so
the same series looks the same in both tools — [chart.ts](../src/lib/chart.ts)
`SERIES_COLORS` / `SERIES_SYMBOLS`.

**They are stored in the order treeherder hands them out, which is the reverse
of the order it declares them.** Treeherder treats both lists as stacks:
`helpers.js::createGraphData` calls `.pop()` per series, and `LegendCard`
pushes a color back when a series is removed. So the first series on a
treeherder graph is blue-bell with a filled circle — not dark-puce with a
hollow diamond, which is what copying the arrays verbatim would give you. If
you ever re-sync these lists, re-check that, because nothing else in the app
can tell the difference:

| # | color | symbol |
|---|---|---|
| 1 | `#464876` blue-bell | filled circle |
| 2 | `#16BCDE` cerulean | hollow circle |
| 3 | `#C92D2F` fire-red | filled square |
| 4 | `#921181` purple | hollow square |
| 5 | `#FFB851` orange | filled diamond |
| 6 | `#4C3146` dark-puce | hollow diamond |

Color and symbol advance together, so within six series each has a unique
color *and* a unique shape. **Past six, treeherder gives up** —
`createGraphData` leaves the seventh series with no color and `visible: false`.
We plot as many as you add, so the lists have to keep going, and cycling both
in lockstep would make the seventh series identical to the first.
`styleForIndex` advances the symbol one extra step per wrap, which keeps every
(color, symbol) pair unique for 36 series and leaves the first six exactly as
treeherder pairs them.

Drawing details, in [chartDraw.ts](../src/lib/chartDraw.ts):

- The three shapes are area-matched (`SQUARE_HALF_SIDE`,
  `DIAMOND_HALF_DIAGONAL`). A square of side 2r covers 4r² against a circle's
  πr² and a diamond's 2r², so without scaling the squares read as the biggest
  series on the graph and the diamonds as the smallest.
- A series is still one batched path: filled symbols get one `fill()`, hollow
  ones one `stroke()`. That keeps the per-series cost at one rasterization
  pass, which is what makes 20k dots per series affordable.
- **Hollow symbols are not filled white**, though treeherder fills them.
  Our dots are translucent so a dense cluster reads as density; an opaque
  fill would flatten those clusters into blobs and a translucent white one
  would smear over the series behind.
- The stroke thins with the radius (`min(1.5, max(0.75, r/2))`), or the
  overview's 1.25px symbols would close up into solid dots.

**The series list and details pane carry the shape too**, because a legend
that showed only half of the encoding would make the shapes unreadable. There,
shape is the identity and *fill means visible* (see `.swatch.off`) — so the
swatch deliberately doesn't mirror the symbol's own filled/hollow state, which
would collide with the visibility toggle. The picker's "already plotted"
swatch stays a plain square: it answers "do you already have this one", and
the graph isn't on screen to compare against.

**Hiding a series** keeps it in the list, in the URL, and in its color slot —
only the drawing stops. Everything downstream of `AppState.visibleSeries`
(both y domains, hit-testing, the "no data" note, keyboard stepping) works off
the visible subset, so a hidden series can't influence the plot. A selection
belonging to a hidden series survives; the details pane says why it isn't on
screen and offers to unhide.

## URL state

The whole view is in the query string:

| Param | Meaning |
|---|---|
| `series` | Repeated. Each is `repo,signatureId,frameworkId[,0]`; the trailing `0` means hidden and is omitted when visible. **Order is significant** — it drives legend order and color assignment. |
| `range` | Absolute full time range, `<startMs>,<endMs>` |
| `zoom` | Absolute zoomed range, `<startMs>,<endMs>`; absent when not zoomed |
| `sel` | Selected point, `<repo>,<signatureId>,<datumId>,<replicateIndex>`. A `replicateIndex` of `-1` (`MEAN_REPLICATE`) means the run's *mean* rather than one of its replicates — what a click selects while `reps=0` |
| `cmp` | Pinned comparison point, same shape as `sel`; set by shift-clicking a dot. Only written alongside a `sel`, since a comparison needs two ends. See [comparison.md](comparison.md) |
| `reps` | `0` to draw one dot per run at its mean instead of every replicate. Omitted when on, which is the default |
| `picker` | `1` when the Add-series panel is open |
| `pf` | Picker filter free text |
| `pc` | Picker filter chips, `field:value` repeated |
| `pr` | Picker repo selection, comma-separated |
| `pi` | Picker signature interval, seconds; must be one of the dropdown's choices |
| `psub` | `1` / `0` — the picker's "Match inside subtests" checkbox |
| `psort` | Picker column sort, `<column>:<asc\|desc>` |

If `sel` names a point that isn't in the loaded data (e.g. the range was
narrowed), the selection is dropped rather than shown as a phantom —
treeherder does the same (`verifySelectedDataPoint`).

Everything from `pf` down is only written while `picker=1`; a closed panel's
filter and knob positions would be noise in every shared graph link. They come
back through `PickerState.seed` on the next mount, which is the only way they
could survive — the panel is mounted fresh every time it opens.

**Three of the picker params are three-valued**, and the third value is
"absent". `pr`, `pi` and `psub` distinguish *unspecified* — let the panel apply
its own default — from a concrete choice, which is why `pr=` (empty) and
`psub=0` are written explicitly rather than omitted:

- `pr=` is every repo chip unchecked. Omitting it would read as "use the
  default two", so a deliberate empty selection wouldn't survive a reload.
- `psub=0` is the checkbox unchecked. Omitting it would let the `test:`-chip
  nudge in `PickerState.seed` turn subtest matching back on, undoing the
  unchecking on every reload.
- Absent is still the useful case for a hand-written link: `?picker=1&pc=test:fcp`
  gets the nudge and shows something, and `AppState.derivePickerView` leaves
  everything it has no opinion about unspecified for the same reason.

A repo in `pr` that isn't one of Perfherder's pinned four gets a chip of its
own (`PickerState.extraRepos`), so a link that selects `mozilla-release` shows
where its rows came from and offers a way to switch it off. The chip is fixed
at seed time rather than derived from `selectedRepos`, so unchecking it doesn't
take the way back with it.

**History granularity.** URL writes are not driven by an `$effect` — each
mutation on `AppState` decides between `pushState` and `replaceState`.
Discrete actions (add/remove series, pick a range, commit a zoom, select a
point, open the panel) push, so the back button undoes them one at a time.
Continuous ones (each frame of a zoom drag) replace. An effect can't tell those
apart, which is why the sync is explicit.

Everything *inside* the panel replaces, including the discrete-feeling ones —
a repo toggle, a new interval, a column-header click. Opening the panel is the
push, and its contents belong to that entry: the back button steps through
graph-level actions rather than walking backwards through knob positions
within one panel session. It also falls out of the plumbing —
`AddSeriesPicker` reports its whole state through one `onviewchange`, which
can't tell a keystroke from a checkbox — and that report firing on mount is
what turns whatever the seed left unspecified into the concrete values the URL
then carries.

## Status

See [graphs-todo.md](graphs-todo.md).
