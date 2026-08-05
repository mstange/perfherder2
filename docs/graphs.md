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
│ + Add series │  detail graph (zoomed range)   │ value / push  │
│              │                                │ / run / build │
└──────────────┴────────────────────────────────┴───────────────┘
```

The "Add series" picker opens as an overlay panel over the whole area rather
than living in the left pane — it needs the full width for its table.

### The details pane, top to bottom

The pane is read from the top on every click, so its order is by how immediately
each fact bears on the dot you just clicked, not by the shape of the data model —
which would put the twenty-commit pushlog above the value you asked about.

1. **The series** — which line this is, spelled out in full. The series *list*
   deliberately shows only what distinguishes one card from the next (design.md,
   "The series list shows differences, not descriptions"), so this is the one
   place that answers "which series is this, exactly?".
2. **Comparison**, when a second point is pinned or hovered. Two points on screen
   make the difference between them the headline and everything below supporting
   detail. See [comparison.md](comparison.md).
3. **The value** — the clicked replicate and its rank, or the run's mean.
4. **Values on this push** — the push distribution, then every value the build
   recorded as a clickable chip, grouped by the job that produced it. High up
   because this is the context the value above needs: 3% off the previous push
   means one thing when the build's own replicates span 1% and another when they
   span 10%. Grouped by job, and covering the whole push rather than the clicked
   run, because the question a retriggered build raises is whether its runs
   agree — and because the other runs' values were otherwise reachable only by
   hunting for their dots on the graph.

   **Absent below two values.** Where a harness records no replicates the backend
   falls back to one row carrying the summary value, so the distribution would be
   a strip with one dot on it and the chip list one chip repeating the headline
   above. That's every awsy signature — checked against production: 23 of 23
   datums with one value each, where a talos `ts_paint` has 20 apiece — so it is
   a case worth suppressing rather than a theoretical one. A heavily
   retriggered push goes the other way and makes this the longest section in the
   pane — twelve runs is twelve groups — which is the cost of the ask, and the cost
   falls on Build, which is meant to be at the bottom anyway. The chips are the
   value alone, with no replicate index: the index was a rank over values we sorted
   ourselves (see "The three-level hierarchy"), so it named no trial and no
   execution order, and dropping it bought about a quarter of each chip's width —
   enough to fit a five-replicate run on one line instead of two.
5. **Run** — the job: type, machine, start, duration, task. `result` comes
   **last**; it reads "success" for all but a handful of points, since a job that
   failed outright recorded no performance data to click on. It's kept rather
   than dropped only because the `bad` styling makes the rare exception jump out.
6. **Build** — push time, revision, author, the pushlog link, and the commit
   list. Last because it's the longest section by far and the least specific to
   the dot: two dots on the same push have identical builds.

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
Replicate index is positional within a datum, **over values we sorted
ourselves** — so it's a rank, not an iteration number.

That's forced, and it's forced by something with a bug number.

**Trial ordering isn't implemented.** The replicates/trials table does now carry
run numbers and machine identifiers, but nothing surfaces them through the
summary endpoint —
[bug 1981623](https://bugzilla.mozilla.org/show_bug.cgi?id=1981623) is the meta
bug tracking putting them to use. The endpoint also has no `ORDER BY` over
`performancedatumreplicate`, so it hands a datum's rows back in a different
order on every request: four fetches of one datum in production gave four
different orders of the same ten values. Response position is therefore both
unstable *and* the only thing on offer, so
`sel=…,<datumId>,<replicateIndex>` used to name a different value every time the
page loaded — the one thing a permalink must not do.

`buildSeriesData` sorts each run's values ascending, which makes the index a
stable function of the values themselves; `graphData.test.ts` feeds one run's
rows in four different orders and pins that an index resolves to one value. The
details pane says "by value" rather than implying an execution order we can't
see, and the replicate list reads as the run's spread.

**When bug 1981623 lands, index by the trial number instead.** It would be
stable *and* meaningful, where the rank is only stable, and it would let the pane
show a run's values in the order they were measured — which is the interesting
order, since the first trial of a browsertime run is routinely the slow one.

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
  formatting, plot geometry, hit-testing, palette, and the jitter both charts
  use (see "Dots are translucent, and jittered sideways" below).
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

### Dots are translucent, and jittered sideways

Every replicate of a run shares its run's push timestamp, and every retrigger of a
build shares it too. Drawn literally, a push that recorded 12 runs × 5 replicates
is 60 dots on one x — a vertical line whose only legible feature is its extremes.
Two things fix that, and they cover different densities:

- **`DOT_ALPHA = 0.5`, drawn in interleaved passes**
  ([chartDraw.ts](../src/lib/chartDraw.ts)). One dot covers half the background,
  two 75%, four 94%, so the bulk of a cloud is where the color saturates. It used
  to be 0.75, which is past the useful range: two dots already reached 94% and
  every cluster from two upwards looked identical. Not lower, because the palette's
  light end has to survive it — orange (the fifth series) stops being a visible dot
  below about 0.4.

  **The alpha only means anything because a series' dots are split across
  `DOT_PATHS = 8` paths** (point *i* into path *i* mod 8), and the reason is that
  **canvas composites once per draw call, not once per shape**. `fill()` rasterizes
  the whole path into a coverage mask first — under the nonzero winding rule a pixel
  inside two overlapping circles has coverage 1, exactly like a pixel inside one —
  and then composites the paint through that mask a single time. So batching a
  series into one path, which is the obvious thing and is what this did at first,
  gave sixty overlapping replicates the same flat 50% as a lone outlier: the series
  read as a series-wide opacity rather than as density. Expressing the translucency
  as an `rgba()` fill style instead of `globalAlpha` changes nothing, for the same
  reason; the overlapping dots have to be in *different* draw calls.

  Splitting **by index** is what makes that reliable rather than lucky: the points
  are x-sorted, so a run's replicates are consecutive, and any 8 consecutive dots
  land in 8 distinct paths. It costs nothing — measured over 111k dots (headless
  Chrome, software rasterization, so ratios not absolutes): 63ms for one path, 59ms
  for four, 66ms for eight, 63ms for sixteen, 69ms for a `fill()` per dot, all
  inside each other's noise. **One fill per dot is the simplification to make here**
  — exact rather than approximate, and no interleaving to explain — pending a
  measurement on GPU-backed canvas; see graphs-todo.md. The distribution strip
  ([distributionDraw.ts](../src/lib/distributionDraw.ts)) had the identical bug and
  carries the identical fix, where a pool of tens of values makes the question moot.
- **Horizontal jitter**, sized in x units and applied in pixels, from a
  deterministic hash of `(datumId, replicateIndex)`. See "Jitter" in
  [chart.ts](../src/lib/chart.ts) for the arithmetic; the decisions:

  - **The room is a property of the push, not of the chart.** CI landings come in
    bursts: measured on autoland over one day, the *median* gap between
    consecutive pushes was four minutes — 4px on a 1500px plot — while the
    isolated pushes on either side of the burst had hours of room each. One
    amplitude for the whole graph is therefore wrong for most of the pushes on
    screen: the median leaves the isolated columns as vertical lines, and anything
    wider makes the bursts overlap. So `PushGroup.xRoom` is
    `JITTER_GAP_FRACTION` of the distance to that push's *nearer* neighbour, which
    also means two clouds can never meet — each keeps to 30% of the gap between
    them and 40% of it always stays clear.
  - **Stored on the point, in x units; converted to pixels at draw time.** That
    way it scales with the zoom for free, and the pixel *ceiling*
    (`JITTER_MAX_RADII` dot radii) can still stop a deep zoom — or a
    post-weekend push — from smearing one build across a quarter of the plot.
    Baking pixels into the data instead would need a rebuild per zoom step;
    baking the offset into `SeriesPoint.x` would break the x-sorted order every
    binary search in `chart.ts` relies on.
  - **A dot that shares its x with no other dot is not moved** (`pointJitter`).
    x means *time* here, not a category, so a lone dot nudged off its push would
    sit beside the connecting line's vertex and read as noise in a quantity that
    has none. The two point sets are judged separately: with replicates hidden, an
    un-retriggered push is a single dot and stays exactly on the line.
  - **The offset is a pure function of the point's identity, and three code paths
    compute it** — the dots, the hit test, and the selection ring, which is drawn
    from a resolved URL triple and never sees a `SeriesPoint`. They share
    `jitterOffsetPx`; if they disagreed, the graph would answer clicks somewhere
    other than where it drew, and the ring would sit beside the dot it names.
    `graphData.test.ts` pins that `jitterForSelection` agrees with the stored
    values.

The same hash serves the distribution strip's vertical jitter, which is why it
lives in `chart.ts` rather than in either chart's own module. See
[comparison.md](comparison.md) for why it can't be `Math.random()`.

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
  Our dots are translucent so a dense cluster reads as density (see "Dots are
  translucent, and jittered sideways" above); an opaque fill would flatten those
  clusters into blobs and a translucent white one would smear over the series
  behind.
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
