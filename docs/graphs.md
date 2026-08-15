# Graphs view — design and status

Companion to [design.md](design.md), which covers the "Add series" picker and
the conventions that apply app-wide — start at its "Which document" map if
you're not sure which file answers your question. This file covers the graphs
half of the app: layout, data model, rendering, selection, and URL state.
[comparison.md](comparison.md) covers what the details pane does with a
selection once it has one — push distributions and comparison mode.

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

### The header is two groups: what loads, and what shows

The bar over the graphs holds nine controls, and the line between its two rows
is the same one the Add-series panel's control block draws — see design.md,
"The control block is two groups: what loads, and what shows". They share the
idiom down to the CSS (`.control-grid` and friends in app.css):

```
RANGE   last ( 2 days  7 days  14 days  30 days  60 days [90 days] 1 year )  May 17 – Aug 15   Loading 3…
SHOW    points ( Replicates  Run means [None] )   ☑ Detected changes  ☑ Trend band  Zoomed: … [Reset zoom]
```

(The parentheses are the two segmented tracks; the square brackets are the option
in effect in each.)

**Which row a control goes on is decided by whether it fetches.** `dataKey` is
the series plus the *range*, so changing the range sends requests and rebuilds
every point array; everything on the second row draws data already in hand. That
also places the two things that look like they could go anywhere: the loading
count belongs to the row that causes the loading, and the zoom — a window onto
data already fetched — to the row that decides what is painted.

Two departures from the panel's version of the block, both because this is a bar
over a graph rather than a card in a panel:

- **Two columns, not three.** The panel gives each group's secondary controls a
  column of their own, which lines the rails up down the block. Reserving that
  column here costs its widest member's width — the zoom label's 23ch plus a
  button, ~250px — on *every* row, and the range presets need the space:
  measured at a 680px pane (before the tracks below, which cost 4px a row), the
  reserved column put the seven presets on three lines and the header at 156px,
  against 134px with each aside as the last item of its own row, pushed right by
  `margin-left: auto`. It reads as a right rail
  while there is room for one and is the first thing to wrap when there isn't.
- **An 8px row gap, not 18px.** That figure exists in the panel to keep a right
  rail's *second* line with the group above it. No rail here has one.

**Exclusive choices are segmented groups; independent switches are checkboxes.**
That is the whole vocabulary of the bar. It is why `points` is a group of buttons
with one filled (`.btn-selected`) rather than a `<select>` — `None` is the option
nobody would think to look for, and a dropdown that has to be opened before it
admits to a third choice would not get found — and it is why both groups are
drawn as one control rather than as buttons in a row: three buttons with gaps
between them are three buttons, and the recessed track (`.btn-group` in app.css)
is what says they are one control with one answer. The shape difference is also
what tells them from the checkboxes beside them.

Two consequences of the track worth knowing, both in app.css beside the rules:

- **It is a filled box, not joined borders.** Segments sharing 1px edges with
  only the outer corners rounded is the other way to draw this, and it cannot
  survive `flex-wrap` — a wrapped row starts with a square left edge and the
  group reads as broken. Seven presets at a 500px pane *have* to wrap, so the
  grouping cue has to be something that encloses two rows as happily as one. The
  lowercase word beside each track stays on the track's first line
  (`align-items: baseline`), and does not wrap with it: a flex item whose
  max-content doesn't fit takes a line of its own, which left "last" alone on a
  line and cost 24px at a 500px pane.
- **Hover and press mean a different surface inside it.** `--bg-hover` is a step
  *down* from the canvas, which against the track's own fill is three or four
  units and invisible; so the group remaps `--bg-hover` and `--bg-active` for its
  children — in light mode a hovered segment lifts to the canvas and a held one
  settles past the track, in dark mode the track is already lighter than the
  canvas and the ordinary fills point the right way. The state *rules* are
  untouched; only what they resolve to changes.

Measured heights, against the single wrapping flex row this replaced (window
width, then the pane it leaves — the pane is the window less 600px of fixed side
panes):

| Window | Pane | Before | After |
| --- | --- | --- | --- |
| 1800 | 1200 | 77px | 81px |
| 1500 | 900 | 77px | 81px |
| 1280 | 680 | 104px | 138px |
| 1100 | 500 | 136px | 164px |
| 980 | 380 | 154px | 188px |
| 860 | 260 | 208px, **overflowing by 70px** | 365px, no overflow |

So it costs 4px at the widths where the graph has room — the tracks' padding, and
`.btn-group` gives 2px of it back by tightening the segments' own vertical
padding — and ~30px between 1280 and 980, where it is also carrying two more
controls than before (the points group is 271px against the one checkbox's
~100px). The last row is the pane at 260px, where the graph is unusable either
way; the point of it is that the header no longer spills out of its own pane.
Below a 360px pane a container query gives up the zoom label's reserved width,
which is the only remaining unwrappable item.

### The details pane, top to bottom

The pane is read from the top on every click, so its order is by how immediately
each fact bears on the dot you just clicked, not by the shape of the data model —
which would put the twenty-commit pushlog above the value you asked about.

1. **The series** — which line this is, spelled out in full. The series *list*
   deliberately shows only what distinguishes one card from the next (design.md,
   "The series list shows differences, not descriptions"), so this is the one
   place that answers "which series is this, exactly?".
2. **The comparison block** — two slots that hold their height, so the pane
   cannot move while the pointer sweeps the graph. A headline slot (the delta
   when two points are on screen, otherwise the hint or "marked"), and under it
   **the distribution chart**: one strip row for the selected push, a second
   when there is something to compare it with. Each slot sizes itself by
   stacking its own states hidden underneath the live one, so neither carries a
   pixel value. A pinned comparison adds its stats, sides and links below the
   chart. See [comparison.md](comparison.md).
3. **The value** — the clicked replicate and its rank, or the run's mean.
4. **Values on this push** — every value the build recorded as a clickable chip,
   grouped by the job that produced it. The chart for this pool is the one in
   the block above, in its one-row form. High up
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

   **On a retriggered push the clicked run's dots are haloed** on the strip — a
   hairline outline, so they stay the same dots at the same weight; the pool's
   whole point is that the runs are one sample of one build. That is the
   question the grouping raises and the chip list answers only in numbers:
   which part of this cloud is the job I clicked. `markedGroup` is an index
   *range*, not a set, because `pushValues` concatenates in run order
   (`runRangeInPushValues`). A run-mean selection gets the halo with no ringed
   dot, which is the one case where the halo is the whole answer. Not drawn on
   a single-run push, where every dot would wear one.

   **Each run's mean is selectable too**, from the button in that run's head
   line. It is a point the app already has — the `means` drawing mode plots it
   and `sel=…,-1` names it — but with replicates drawn its dot isn't on the
   graph, so before this a chip click was a one-way door: nothing led back to
   the run as a whole. It stays in the head rather than joining the chip row,
   quieter than a chip until hovered or selected, because a mean in a row of
   measured values is a different kind of number wearing the same clothes.
5. **Run** — the job: type, machine, start, duration, task. `result` comes
   **last**; it reads "success" for all but a handful of points, since a job that
   failed outright recorded no performance data to click on. It's kept rather
   than dropped only because the `bad` styling makes the rare exception jump out.

   **Profiles** sits between the task and the result — see below.
6. **Build** — push time, revision, author, and this push's commit list. Last
   because it's the longest section by far and the least specific to the dot:
   two dots on the same push have identical builds.

   The commit list is [CommitList.svelte](../src/lib/graphs/CommitList.svelte),
   the same component the comparison card's inline pushlog uses — they were two
   implementations of one row, and only one of them counted a truncated merge
   correctly. It is *this push's* commits; the range between two pushes is the
   card's, see [comparison.md](comparison.md), "The inline pushlog".

   There used to be a "Since previous → pushlog" link here too. It built exactly
   the range `comparePrevious` pins, and pinning now answers that inline in the
   card along with the delta and the statistics, so the link was a trip out to
   hg for a subset of one keypress.

#### The three change cards say it the same way

Between 2 and 3 sit the two cards that are not about the dot at all — the Alert
and the Detected change — and all three can be on screen together, since
perfherder alerting on a push this app also found a step on is the *agreement*
case, and clicking either mark pins the comparison. Measured on signature
5350953 at alert #51136, that is 989px of change cards in a 910px pane.

Three cards is fine. Three *dialects* was not, and they had drifted into three:

| | before | after |
| --- | --- | --- |
| Comparison | `+306.1 ms (+4.9%)` | `+4.9% (+306.1 ms)` |
| Alert | `10.95%` | `+11% (+659.17 ms)` |
| Detected change | `+8.9% (+535.71 ms)` | `+8.9% (+535.71 ms)` |

[ChangeHeadline.svelte](../src/lib/graphs/ChangeHeadline.svelte) is now the only
one of these, and the rule is: **the percentage leads, the absolute follows in
parentheses, both signed arithmetically, and the badge carries the verdict.**

- *Percent first* because it is the number that compares across series and the
  one people quote. The absolute stays because the percentage is not always the
  number that means anything — a signature whose alerting threshold is absolute
  (installer size sets 100 KB) shows a real 340 KB regression as −0.19%.
- *Signed arithmetically*, so the sign always means "the measurement went up".
  The alert card was the odd one out: `amount_pct` is a magnitude and
  `is_regression` carries the direction, so it printed `2%` where the cards
  under it printed `−2 ms` for the same move. `alerts.ts::signedAmountFraction`
  takes the sign from the alert's own two values — **not** from `isRegression`,
  since a regression on a higher-is-better metric *is* a drop and signing by the
  verdict would contradict the values on the line below. The magnitude stays
  perfherder's own, because that is the figure a sheriff quotes.
- *The badge carries regression/improvement* because the sign cannot: −2 ms is
  an improvement on a duration and a regression on a score. It also had to move
  to [detailsPane.css](../src/lib/graphs/detailsPane.css) — it was declared
  inside ComparisonSection, so Svelte's scoping meant the other two cards wrote
  `class="verdict"` and got nothing but the headline's inherited bold.

The three still print *different numbers*, and each says why on the line under
its headline: perfherder's window averages (12–24 pushes back against 12
forward), this app's up to 24 a side, and the comparison's two builds. That is
the point of having all three — a reader who took them for one figure would
think two of them were wrong.

#### Keeping the pane readable

Same case, measured before and after: **2,098px → 1,546px** in a 910px viewport.
Four cuts, none of which removes a fact from the app:

- **The stats table lost two rows.** `Values 8 vs 7` is `n=8` and `n=7` from the
  chart legend directly above it, and `Lower: after in 13% of pairs` is `Effect:
  δ −0.75` restated — `stats.ts` computes δ = 2·cles − 1, so they cannot
  disagree, and two rows read as two pieces of evidence. CLES now finishes the
  Effect row; the small-sample caveat moved onto Significance, the verdict it
  qualifies.
- **"Values on this push" folds past three runs** (386px → 38px on a
  seven-retrigger push, unchanged on the one-run push that is the common case).
  The summary carries what the fold hides — the run count and the push mean —
  and the distribution above already draws the whole cloud with the clicked run
  haloed, which is the question a retriggered build raises. Three runs is still
  341px unfolded: the height is driven by replicate chips, not by run count.
- **The job type drops the prefix the pane has already spelled out.**
  `test-windows11-64-24h2-shippable/opt-browsertime-…` is four wrapped
  monospace lines whose first two thirds are the platform and build config from
  the top of the pane. Only an exact `test-<platform>/` is stripped, since the
  platform comes from the same job row and matching it is a comparison rather
  than a guess ([job.ts](../src/lib/graphs/job.ts)); the whole string stays in
  the row's `title`, because that is what gets pasted into a `./mach try`.
- **One `Triage` row for the two alert statuses.** They are still two different
  facts — this series' alert against the whole push's summary — and both are
  still named. What they are not is two findings.

### Profiles

The Run section links the selected job's profiles straight into
profiler.firefox.com. Without them, opening a profile for a point on the graph
meant: click through to treeherder, find the job again in the push, open the
Artifacts tab, and click the profiler link *there* — four steps to reach
something the pane already has the task id for.

**The rule is treeherder's**, from `ui/shared/JobArtifacts.jsx` and
`getPerfAnalysisUrl` in `ui/helpers/url.js`, and following it exactly is the
point: the same job opened from either app should land on the same profile with
the same tab title.

- An artifact is a profile iff its **file name** starts with `profile_`. A
  prefix, not a substring — every browsertime task also uploads
  `browsertime-profiler.tgz`, which is not one.
- The link is `https://profiler.firefox.com/from-url/<encoded artifact url>`.
  The profiler fetches the artifact itself (taskcluster serves
  `access-control-allow-origin: *`), so this is a link you follow, not a file
  you download and re-upload.
- `profile_build_resources.json` and `profile_resource-usage.json` are
  *resource usage* profiles — CPU, memory and IO assembled from mozharness'
  log rather than sampled by Gecko. They carry no name of their own, so both
  apps pass `?profileName=<job type> (<task id>.<retry id>)` for exactly these
  two and the profiler titles the tab with it.

Three deliberate deviations, all in [artifacts.ts](../src/lib/graphs/artifacts.ts):

- **The label is the middle of the file name.** `profile_idb-open-many-seq.zip`
  reads as `idb-open-many-seq`. The prefix is *why* the artifact is in the list
  and the container format is the harness' business, so neither says which
  profile this is — and the pane's column is narrow. Treeherder shows the whole
  name because its artifact list is a table of every artifact, where the name is
  the row's identity; here it's a link's text. The full name is the `title`.
- **Resource usage sorts last.** Nearly every perf job uploads one and only a
  gecko-profiling run uploads the other, so sorting by name would bury the
  profile someone came looking for under the one they get for free.
- **The row is drawn as soon as there is a task to ask about**, showing
  "loading…" and then either the links or "none uploaded". The artifact list can
  only be fetched once the job lookup names its task, so it lands a beat after
  the rest of the Run section — and this is not a rare row (even a plain build
  job has `profile_build_resources.json`), so letting it appear under the
  reader's eyes would shift the pane on nearly every click.

The same artifact list feeds one thing that isn't a link *to* a profile: when a
pinned comparison's two runs both uploaded the same benchmark's compact profile,
the comparison card offers a comparison *between* them. See comparison.md,
"Profile comparison".

### Where the artifact list comes from

`GET https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/<taskId>/runs/<runId>/artifacts`
— taskcluster-queue's `listArtifacts`, the only non-treeherder endpoint the app
calls. See [artifactsApi.ts](../src/lib/graphs/artifactsApi.ts).

- **`runId` is the job's `retry_id`**, added to `JobSchema` for this. Artifacts
  hang off the *run*, not the task: a retried task keeps its task id, so a link
  built without the run number points at the wrong attempt's files. `task_id`
  and `retry_id` are both `v.optional` and absent together — they come from one
  `taskcluster_metadata` relation the view skips when it's missing — so
  `appState.svelte.ts::taskRunOf` is the one place that checks for the pair.
- **Only `name` is declared**, against this codebase's usual habit of
  transcribing the whole serializer. The rows also carry `contentType`,
  `expires` and `storageType`, none of which we show, and every declared field
  is one more way for a shape change to turn a decorative link list into a fatal
  `SchemaError`.
- **The root URL is hardcoded.** Treeherder threads each repository's
  `tc_root_url` through, because two clusters are in play; the only repositories
  on the other one (community-tc: `servo-master`, `servo-auto`, `servo-try`)
  have no performance signatures at all, so no point this app can plot ever came
  out of a task there.
- **Failures are remembered, not retried**, as with the job lookup: artifacts
  expire a year after the run and the queue answers 404 for good once they have.

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
- The same endpoint, with **`startday === endday`**, is how the parent-signature
  threshold lookup asks for metadata and nothing else (`fetchSignatureMeta`; see
  "The floor comes from the signature"). It is also the only endpoint that
  serializes `alert_threshold` and `alert_change_type` at all — the signatures
  endpoint does not.

**A second, much cheaper request runs first and in parallel**: `GET
/api/project/<repo>/performance/signatures/?id=…&id=…`, one per repository, which
answers with every plotted signature's identity in 866 bytes and ~160 ms
(`fetchSignaturesByIds` → `metaFromSignature`). It is what puts a card's suite,
platform and options on screen about a second before its dots, and it is keyed by
signature rather than by range, so changing the window doesn't un-name the list.
The full reasoning, the two fields it can't answer, and the field-for-field
verification against the summary response are in design.md, "Two endpoints
describe a series", and api-assumptions.md.

Neither request waits on the other, and the identity one is best-effort: if it
fails it is not retried, because the summary response carries everything it was
after.

### Replicates

`replicates=true` is **always on** in the *fetch* (task requirement;
treeherder makes it a fetch-level toggle). The backend then emits one row per
replicate value, all sharing the same datum `id`, `job_id`, `push_id` and
`push_timestamp`. When a datum has no replicates recorded, the backend falls
back to emitting a single row with the summary `value`. So "a run always has at
least one value" holds.

*Drawing* them is one of three modes (`AppState.pointMode`, `pts=` in the URL,
the `points` button group above the graphs). It is one question — at what
resolution do I want to see the measurements — so it is one control with three
answers rather than two checkboxes:

| Mode | Dots | For |
| --- | --- | --- |
| `replicates` | every replicate value | the default; the only view that shows a run's *spread*, which is what tells a step from a noisy series |
| `runs` | one per run, at its mean | takes a 90-day range from ~20k dots per series to a few hundred, and stops a real step being buried in scatter |
| `none` | none, and no connecting line | leaves the summaries: the trend band, the alert markers, the change bars |

`none` exists because the band is drawn *under* nine series' worth of dots
(see "The trend band"), and comparing two bands is a question the raw plot
cannot answer at all. Two things follow the mode rather than being switches of
their own — in both cases because the state the extra switch would allow is one
nobody asked for:

- **The connecting line goes off with the dots.** It is the same raw data at
  push resolution, so "no data points" that still drew the noisiest summary of
  them would not be the thing the reader asked for.
- **The y axis follows what is drawn**, so with the dots off it covers the
  *band* (`extentOf`'s `drawPoints` argument, and `trendExtent` in trend.ts,
  which measures exactly the vertices `trendSpan` hands the drawing). Measured
  on the two 128m_encrypt/decrypt signatures over three months: run means span
  ~45k–115k where the band spans ~64k–72k, so leaving the axis on the invisible
  dots would draw the band as a stripe across a fifth of the plot. With no band
  either — `none` and the band off — it falls back to the point extent, and the
  detail graph carries a note saying the dots are hidden, since that state is
  otherwise indistinguishable from a broken graph.

In `runs` and `none` it is still one dot (or none) per *run*, note — not per
push. A retriggered push keeps one dot per retrigger, straddling the line's
single vertex for that push. Collapsing to one dot per push would need a second
sentinel alongside `MEAN_REPLICATE` and a push-level selection in the details
pane, and it would hide that a build was retriggered at all.

Keeping this on the drawing side rather than the fetch side is deliberate:
switching is then instant and allocation-free rather than a refetch of every
series, and the details pane can still list a run's individual replicates in
every mode. `buildSeriesData` materializes both point sets up front
(`SeriesData.replicates` and `.means`, each a `PlotPoints` with its own
precomputed y extent); `AppState` picks one into `SeriesEntry.plot`, and
*everything* downstream — both graphs, both y domains, hit-testing, keyboard
stepping, the series list's point count — reads `plot` rather than re-deriving
the choice. That single choke point is what keeps the graph, the y axis and
the click targets from disagreeing about which dots exist.

**`none` does not empty `plot`**, which was the first shape of the change and
was wrong twice over: `hasData` reads it, so the graph drew "No data in this
time range." over a year of data, and the point count, the keyboard's entry
point and the fallback y extent all describe the series whether or not it is
painted. So `plot` stays at run resolution and a separate `AppState.drawPoints`
suppresses the ink. That flag gates ScatterChart's drawing **and** its hit test
together (one `drawnPoints` derived feeds both): a dot that can be clicked but
not seen is a selection out of nowhere, and a hover ring appearing over empty
space is worse.

Selecting a mean dot needs a way to say "not a replicate": that is
`MEAN_REPLICATE = -1`, which flows through `SelectedPoint.replicateIndex` and
the URL's `sel` unchanged. A selection is deliberately *not* rewritten when
the mode changes — a mean selection is still valid with replicates drawn, and
a replicate selection still names a real value with them hidden, so coercing
it either way would throw away the point the user was looking at. In `none` the
details pane is the *only* thing still describing the selection, so clearing it
would empty that pane too. The consequence is that with replicates hidden, a
replicate selection draws its ring on a value that has no dot; that's honest
(the ring shows where that replicate sits relative to the mean) and reachable
only by deliberately picking one from the pane's replicate list. In `none`, where
the axis covers the band, a selected value outside the band is off the axis and
its ring is clipped away — see graphs-todo.md.

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

### Alerts

Perfherder's own verdicts on the plotted series: `GET
/api/performance/alertsummary/?framework=<id>&alerts__series_signature=<id>&timerange=<sec>`,
one request per series, the same parameters treeherder's own graphs view sends
(`GraphsView.jsx::getAlertSummaries`). An *alert summary* is a push where the
analysis found at least one series changing; the alerts inside it are one per
signature, so a summary filtered to our signature still arrives carrying
everyone else's — `alerts.ts::alertsForSeries` picks ours out, `related_alerts`
included, since a reassigned alert is as much about the push as an original one.

**The range filter is the push lookup, not a timestamp comparison.**
`timerange` is server-side and counts back from *now*, while our range is
absolute and may end in the past, so the request deliberately asks for a
superset — everything since the start of the window — and a summary whose
`push_id` isn't one of the pushes we plotted is dropped. That is a stricter test
than comparing timestamps: it also drops a push the series has no data on.

**A reassigned alert is drawn on the push it was reassigned to.** The analysis
marks the push where the numbers moved; a sheriff who bisects it and finds the
culprit elsewhere says so by reassigning the alert, and perfherder's own alerts
view then lists it under the target push and strikes the original row through
(`AlertTableRow.jsx::getTitleText`). Treeherder's *graph* keeps marking the
detected push, but only because it can't see otherwise: `createGraphData` in
`perf-helpers/helpers.js` places every summary at its own `push_id`, and the
target summary isn't in the response. So this is a deliberate deviation from
treeherder, and the direction of it is towards what the sheriff decided.

Seeing the target costs one extra request per reassignment
(`fetchAlertSummary`): the list filter is `alerts__series_signature`, which
matches a summary's *own* alerts, and a reassigned alert stays in the original
summary's `alerts` while appearing in the target's `related_alerts` — so the
target has to be asked for by id. Affordable because reassignments are a small
minority (one of the five alerts autoland signature 300397 collected over a
year, whose target summary #51596 had gathered fourteen signatures' alerts onto
one push), and the ids are computed first so the ordinary case doesn't even
spend a microtask turn on the lookup.

**That request goes through the same collection URL as the one above — the
viewset's `list()`, with `?id=<n>` — and never through `/alertsummary/<n>/`,
because the difference is 12x.** The batched queries that make
this endpoint fast were only wired into `list()`, so the detail route falls back
to several sequential queries *per alert* and its cost is linear in how many
alerts a sheriff piled onto that push — about 30 ms each, no fixed cost to blame.
On summary 50829 (27 own alerts plus 609 reassigned into it) that is 17.7 s and
18.0 s for the detail route against 1.42 s and 1.39 s for `?id=50829`, for the
same 700 kB of identical content. End to end on the two-series speedometer3 URL,
the alert counts used to appear at about twenty seconds and now appear at 3.4 s.

Two things follow, both in `fetchAlertSummary`'s comment: a missing summary is a
200 with an empty page rather than a 404, and the result is matched by id rather
than read off `results[0]` — because an `id` filter that stopped being applied
would otherwise move a marker to an unrelated push while looking like a verdict.
api-assumptions.md carries both.

**Targets are cached for the session, by id** (`AppState.reassignmentTarget`),
which is not the belt-and-braces it looks like: a sheriff blaming one push for a
broad regression reassigns *every* affected signature's alert onto it, so two
plotted series routinely want the same target, and `loadAlerts` runs per series
and concurrently. The cache stores the in-flight promise, so those two share one
request rather than racing to start two, and it is deliberately not pruned with
the series data — the summary survives the range change that discards every
`alertCache` entry referencing it. A failed lookup is evicted rather than kept, so
one dropped request doesn't leave a marker on the wrong push for the rest of the
session.

**Skipping the request when the target is already in the page does not work**,
tempting as it looks — `reassignmentTargetIds` does skip the case where the
target *is* the summary holding the alert, so the idea is half there already. But
the page we have is filtered by `alerts__series_signature`, which matches own
alerts only, and a target holds our alert as a *related* alert: it is almost
never in the page. Confirmed for both targets on the two-series speedometer3 URL
— 50643 and 50829 are each absent from the page that named them.

The server-side fix is worth having too, and is written up separately in the
treeherder checkout (`proposal-alertsummary-detail-perf.md`) — but it needs a
deploy we don't control, and `list()` is where the batching lives and where
future batching will be added, so the route choice here is right either way.

Everything about the *push* then comes from the target: `prevPushId` and the
revisions, so clicking the marker pins the pair the sheriff claims, and the
status and bug number, because the original summary's status is "reassigned" and
it never gets a bug. Only the alert's own numbers stay — `amountPct`, the two
values, `tValue` — which a reassignment doesn't restate. Both ends are kept in
`SeriesAlert.reassignment` so the pane can name the other one, worded the way
perfherder words it: "reassigned from #N" once the marker moved, "reassigned to
#N" when it couldn't. It can't when the target lookup failed or when this series
has no data on the target push — the commonest reason the analysis skipped that
push in the first place — and then the marker stays where the analysis put it,
which is still a real alert about a real change.

**Invalid alerts are the one status not drawn.** A sheriff marking an alert
invalid is saying the change was an artefact, and a mark on the graph would
contradict the person who owns it. Downstream, reassigned and infra alerts *are*
drawn, even though perfherder's own alerts list hides all four by default: those
three are real movements in the data, tracked elsewhere or blamed on the
infrastructure rather than on the patch, and the pane names the status so a
marker never claims more than the sheriff did.

The two status maps in `alerts.ts` are treeherder's `summaryStatusMap` and
`alertStatusMap` from `perf-helpers/constants.js`, taken from master rather than
from a local checkout — a three-month-old checkout was already missing both
"infra" statuses (alert 5, summary 9) and had 9 meaning something else. They
were cross-checked by loading one summary per status in the live alerts view and
reading the word it printed. Unknown codes render as `status N`.

Alerts are **decoration on someone else's graph**: they load after the series
data (placing one needs the pushes), a failed request is swallowed rather than
surfaced, and it isn't retried — the retry is changing the range or the series
list. The dots are the point; a missing marker is a smaller harm than a retry
loop or an error banner over a working graph.

**But being second is visible, so the wait is stated.** Measured on a two-series
90-day load, the dots and the change counts were on screen at 2s and the alert
counts arrived between 6s and past 9s — long enough that a card reading
"1,592 points · 7 changes · +3.5% drift" looks finished while it is still one
badge short of the truth, and indistinguishable from the same card on a series
with no alerts. `SeriesEntry.alertsPending` is that gap, and the card holds the
count's place with a pulsing `· alerts…` until it closes (design.md, "Two
loading cues").

It is a flag of its own, tracked in `AppState.alertsInFlight`, for a reason worth
keeping: `alertRequests` — the set that stops a failed lookup being reissued
forever — is deliberately *never* cleared on failure, so a cue driven off it
would pulse for the rest of the session on exactly the series whose request
died. `alertsInFlight` clears in a `finally`, whatever happened. Neither one is
pruned with the range: a request for a key nobody wants any more belongs to no
card.

**Marker shape is a deliberate deviation.** Treeherder highlights the alerted
*dot* with a 12px translucent halo, behind a "highlight alerts" toggle. That
works when the graph draws one dot per push; ours draws every replicate, so the
alerted point is a cloud and the halo would have to pick one arbitrary member of
it. Instead the marker belongs to the pixel column: a triangle at the top of the
plot — down for a regression, up for an improvement, filled red or green and
outlined in the series color — over a faint full-height guide. Light enough that
it doesn't need a toggle. Detail graph only: the overview is 100px tall and may
hold a year of pushes.

**Markers that collide stack into rows** rather than overlapping, packed by
[annotations.ts::layoutAlertMarkers](../src/lib/graphs/annotations.ts) — up to
`ALERT_MAX_ROWS`, past which they double up again, because twelve alerts in one
week should not turn the top of the plot into a wall of triangles. Nudging them
sideways was the alternative and it lies about which column a marker means;
stacking doesn't. Two alerts fourteen hours apart (speedometer3's 2026-06-02
regression and improvement, about 5px at a 90-day range against an 8px triangle)
used to draw as one blob, and `hitTestAlerts` could tell them apart only by
whichever column was nearer — so one of the two was effectively unreachable.
Now the row answers, and each has a hit band that stops where the next row
begins. The single-row case, which is nearly all of them, keeps the 16px band
it had.

**One layout, read three times.** `layoutAlertMarkers` runs once in
[ScatterChart](../src/lib/graphs/ScatterChart.svelte) and the same array goes to
the draw call, the overlay's highlight and the hit test. Same rule as
`jitterOffsetPx`, and it bites harder here: rows are the entire reason two
overlapping markers are separately clickable, so a draw loop and a hit test that
packed independently would answer clicks on the wrong triangle.

The details pane's Alert card carries the rest — percentage, the two values,
both statuses, perfherder's t-value, the bug, and a link to the summary. It sits
with the comparison card, above the single-point sections, because it is a
two-push statement and usually the reason a sheriff is looking at the graph at
all. Read-only: creating and triaging alerts needs an authenticated session,
which this app doesn't have.

**Clicking a marker sets up both ends of the alert.** The alerted push is
selected and `prev_push_id` is pinned as the comparison, so one gesture goes
from "perfherder flagged this" to the comparison card — KDE, rank-sum test,
effect size — computed from the replicates this app fetched.
`AppState.selectAlert` assigns both ends before a single `syncUrl`, because
routing through `selectPoint` and `comparePoint` would spend two history
entries on one click and leave Back on a half-built comparison.

The pinned end is **`prev_push_id`, not the previous push on the graph**. The
two differ whenever the series has no data on an intervening push, and pinning
the graph's neighbour would put a before-value in the comparison card that the
alert never used, directly under a card quoting the one it did. When that push
isn't loaded — out of range, or expired — the selection still happens and the
comparison simply doesn't: better than a substitute.

**The two cards will disagree, and both are right.** Perfherder's `prev_value`
and `new_value` are `historical_stats["avg"]` and `forward_stats["avg"]` from
`treeherder/perf/alerts.py` — means over a *window* of 12–24 data points back
and 12 forward (`PERFHERDER_ALERTS_{MIN_BACK,MAX_BACK,FORE}_WINDOW`) — while the
comparison card is those two pushes and nothing else. On alert #51605 that is
+121.43% against +195%. Each card says which it is; the Alert card's line used
to read "against the previous analysed push", which described neither.

**Hit-testing.** `chart.ts::hitTestAlerts` owns the triangle's dimensions as
well, so the draw loop and the hit test can't drift — the same reason
`jitterOffsetPx` is shared. The target is widened to 13×16 around the ink's
8×7, and confined to a band across the top of the plot: the guide runs the full
height, and a hit area following it would swallow clicks meant for the dots it
passes. Markers win over dots inside that band, ties go to the nearest column
(which is what keeps two overlapping markers separately clickable), and a marker
the draw loop clipped for being off-screen isn't clickable either.

**Hovering one also says what it is**, in a tooltip: the direction and the signed
percentage, the two window averages with the reminder that they *are* window
averages, the alert number with both triage states and the bug, and — with more
than one series plotted — which series, with its swatch. Wording in
[graphTooltip.ts](../src/lib/graphs/graphTooltip.ts), mechanism in design.md,
"Tooltips". The triage line is why it earns its space: a triangle otherwise says
"something was flagged here" and nothing else, when the answer a reader wants is
often that a sheriff has already called it invalid, or that the bug is open in
the next tab. Before this the only way to find out was to click, and then to find
the Alert card among the pane's others.

The hover highlight — a triangle 1.4× larger, and the guide from a hint to a
line you can follow — is painted on the **overlay** canvas, not by repainting
the markers. The markers ride the data layer with 100k+ dots on it; redrawing
that on every mousemove across a triangle would undo the two-layer split.

**A selected marker keeps that growth, and adds the ring a selected dot wears.**
Without it the click didn't stick: the triangle sprang back to its resting size
the moment the pointer left, and the only thing left saying that this alert was
the one being looked at was the pane, three hundred pixels away. The growth is
what makes the click land; `palette.ring` around it is what tells the selected
marker from a merely hovered one, since hovering a *second* marker enlarges that
one too. The rule is the pane's — the alert on the *selected push*, i.e. exactly
what the Alert card is describing — and deliberately not "both of the alert's
pushes are still pinned": shift-clicking a third dot moves the comparison
without changing what the card says, and the marker following that would take
the mark off the push the pane is still talking about. Hidden series don't
count; nothing else of theirs is drawn either.

<kbd>A</kbd> and <kbd>shift-A</kbd> step between alerts without a pointer,
stopping at the ends rather than wrapping: an alert list is short and unevenly
spaced, so jumping from December's back to January's reads as a bug.

### Detected changes

Perfherder's alerts are somebody else's verdict, and they exist only where
somebody else's threshold fired. This is the second opinion, computed from the
data already on screen: `changes.ts` segments each series and marks the steps it
can confirm, drawn as bars along the plot's floor.

**The gap it fills is a real one, with a case number.** graphs-todo.md records
it under "Common alerts": plotting idb-open-many-seq `open_duration` on macOS
(signature 5350956) over a year shows nothing at all, while its Windows
counterpart carries alert #51136 for the very same push. Only one of the two
crossed an alerting threshold. The macOS graph is not quiet; it is unannotated.
The idea and the two-stage shape are perf.webkit.org's ("Segmentation with
Welch's t-test change detection", `public/v3/pages/chart-pane.js`); the
deviations are below.

#### The series behind the tuning

Every constant in [changes.ts](../src/lib/graphs/changes.ts) that came from real
data names the signature it came from. **Load them.** Each row below is a URL
this app will open, next to what a reader should expect to see in it and what it
decided; a claim in that file that can't be checked against a graph is a claim
that has already drifted once. `range` is absolute, so these stay pointed at the
same window — until treeherder expires the data, which it does about a year
after the run, and a row whose graph has gone empty is stale rather than wrong.

| Graph | What it shows | What it decided |
| --- | --- | --- |
| [5350956 — idb-open-many-seq `open_duration`, macOS, one year](http://localhost:5173/?series=autoland,5350956,13&range=1754407080000,1785943080000) | 2,101 points and **neither an alert marker nor a bar**, while [its Windows counterpart](http://localhost:5173/?series=autoland,5350953,13&range=1781113080000,1786297080000) carries alert #51136 on 2026-06-23 for the same change. The empty sidebar line is the finding — see below | That the gap is real: this is why the feature exists |
| [5350953 — the same test on Windows, two months](http://localhost:5173/?series=autoland,5350953,13&range=1781113080000,1786297080000) | 1 alert, 2 bars: one on alert #51136's own push, and one on 2026-07-30 that perfherder has no alert for | The standard-error penalty in `relocateBoundary`. Before it, the first bar sat 16 pushes and 21 hours early and the second did not exist |
| [299010 — tresize, two months](http://localhost:5173/?series=autoland,299010,1&range=1780954380000,1786138380000) | 5 alerts and 10 bars, among them alert #51554's −4.56% improvement on 2026-07-23 with one push shortly before it dragged low by a single bad job | That `relocateBoundary` has to exist at all: the proposed cut lands on the bad push, not on the step |
| [5352791 — speedometer3 TodoMVC-jQuery/total, macOS, two months](http://localhost:5173/?series=autoland,5352791,13&range=1780963200000,1786147200000) | A level that wanders over 65–68 ms with one push in six measured far less precisely, four perfherder alerts and 17 bars. Recorded as `fixtures/push-means-wandering.json` | Binary segmentation, replacing a dynamic program that scored the whole range against one noise scale and covered everything past push 290 with a single segment |
| [installer size — three subtests, one week](http://localhost:5173/?series=autoland,1954909,2&series=autoland,1668132,2&series=autoland,5688441,2&range=1785563520000,1786168320000&pts=runs) | 9, 8 and 2 bars, all of them steps of tens of KB on binaries of 119–240 MB — tenths of a *tenth* of a percent — with four of the first two landing on the same push across two platforms | The per-signature threshold. A fixed 0.5% floor drew nothing at all on any of the three |

**The first row is the honest one, and worth reading twice.** The macOS series
gets no bar either. Measured over the two months around that push, the same event
is a ~10.5% shift on it — but the per-push noise there has a robust scale of 12.3%
*of the level*, push means bouncing between 5,046 and 9,127 with a single run
each, so 24 pushes a side put it at p = 0.04 and it does not clear the detector's
α of 0.01. Perfherder is silent there because of a threshold; this app is silent
there because at that noise level the evidence genuinely isn't in the data. The
feature closes the gap on series like the installer-size row, not on this one, and
the case that motivates a design is not automatically a case it fixes.

#### The unit of analysis is the push mean

This app has something perf.webkit.org doesn't: tens of replicates per run, and
often several runs per push. It is tempting to feed them all in, and it would be
wrong — but the two levels are not dependent in the same way.

Replicates within one run share everything: a machine, a binary, a moment. They
are repeated measurements of one number, and pooling them is flagrant — a
rank-sum test over 20 replicates a side calls *every* adjacent pair of pushes
significantly different, and the whole graph turns into bars.

Runs of one push are the interesting case, because they need not share a machine,
so machine-to-machine variation is something they *do* sample. What every run of a
push shares is the binary and the moment, and that is where most of the noise
lives: over the 65-push plateau before the 2026-07-23 step on autoland signature
299010, two runs of the same push differ with a robust sd of 0.039 ms while push
means at the same level differ with 0.056 ms, which nets out to three quarters of
the variance being build-and-moment — PGO layout luck, infra weather — and no
number of retriggers on one push reaches it. Pooling run values would contribute
k values per push but only one draw of the term that dominates: the clustered-data
trap, milder than the replicate version and the same mistake.

So the values are `PushGroup.mean`, one per push: the same number the connecting
line joins. What the runs and replicates earn is the precision of that one value —
and a single bad run can still drag it (see `relocateBoundary`), which argues for
summarising a push more robustly rather than for unpooling.

#### Three stages

1. **Propose.** Binary segmentation: split the series at its sharpest CUSUM
   contrast, recurse into both halves, stop when a stretch is too short to test or
   its sharpest split isn't sharp enough. `candidateBoundaries`. This decides
   *where* a step might be and tests nothing; it is cheap and parametric, and each
   stretch is scored against a noise scale estimated inside that stretch.
2. **Confirm.** Greedy forward selection. Gate every candidate with a two-sided
   Mann-Whitney U over the push means either side, accept the strongest, make its
   index a wall that no later pool may cross, and go round again until nothing new
   clears α. `detectChanges` and `gateChange`.
3. **Locate.** Re-estimate the accepted index as the cut through its window with
   the largest Cliff's delta *minus one standard error of it*. `relocateBoundary`.
   A proposed cut is a mean-based statistic and one bad run walks it, which is why
   a rank statistic re-estimates it — and δ on its own is maximised by the
   smallest pool the window allows, which is why it is charged for its own
   imprecision. See "Locating a step is not the same question as testing for one".

**Only an accepted change is a wall**, and that is what makes the second stage a
loop rather than a pass. Three things follow from it:

- An outlier the proposal stage fences off can't silence the real step beside it.
  It used to: with candidate boundaries as walls, a bad push four pushes from a step
  left both of them with too small a pool to test, so a step with thirty clean
  pushes either side went unmarked because something twitched four pushes earlier.
  A candidate no test has confirmed now has no standing to stop another being
  tested.
- A regression and its backout can confirm each other. Each dilutes the other while
  both are unconfirmed, and accepting either one makes the other visible, so
  re-gating every round is what finds the pair.
- One step can't be marked twice, without a rule about it. Once a change is
  accepted, a candidate within six pushes of it has no pool on that side.

Accepted changes are then re-described against the final walls, so a change
accepted early doesn't report means that reach across a step found later.

#### Locating a step is not the same question as testing for one

The gate answers "is there a step in this window", at the cut the segmentation
proposed. `relocateBoundary` then answers "where", and the two questions want
different statistics — the mistake that cost two bugs was letting the second one
be answered by a number that is only meaningful for the first.

Cliff's delta is the fraction of cross-pool pairs that are ordered the right way.
As a *description* of one split it is exactly right, which is why the card prints
its interpretation. As a *criterion for choosing among splits* it has a defect:
it says nothing about how many pairs it was computed from, so it is maximised at
the smallest pool the window admits. Three pushes need only be three ordinary low
values to separate perfectly and score 1.000, and 1.000 beats the real step's 0.90
every time.

That is not a corner case. Over the 92 gated candidates in the four real series in
the table above, bare δ landed on a pool of four or fewer a side **8 times**, and
4 of those then failed the α re-check and lost the change altogether. Both failure
modes are visible on [the Windows idb-open-many-seq
graph](http://localhost:5173/?series=autoland,5350953,13&range=1781113080000,1786297080000),
which is where they were found: the 2026-06-23 step that perfherder alerted on
(#51136) was reported on a 4-vs-44 split 16 pushes and 21 hours early, and a real
+4.6% step on 2026-07-30 relocated to a 3-vs-45 split at p = 0.067 and disappeared.

The fix is to charge each split the imprecision of its own estimate: subtract
`√((n₁+n₂+1)/(3·n₁·n₂))`, the null standard deviation of δ. It is 0.30 at 4-vs-44
against 0.17 at 20-vs-28, so the tiny pool now has to separate a sixth of a
pair-fraction better to win — and on that graph it doesn't. The two failures become
the alert's own push at p = 3e-8, and a 24-vs-24 split at p = 2e-4.

**Not |z|**, which is the other way to weight δ by its precision and is δ *divided*
by the same deviation. Dividing is a strong enough preference for balance to pull
the estimate toward the middle of the window, and the middle of the window is where
the candidate we are trying to get away from sits: on the 299010 fixture |z| peaks
one push short of the step. Subtracting leaves splits of comparable size ranked by
δ alone, because their penalties are within a hair of each other, and only bites
when the sizes are far apart — which is exactly when the δ estimates aren't
comparable. One standard error is a correction rather than a guarantee: where the
real step separates weakly enough, a tiny perfectly-separating pool still wins.

#### The floor comes from the signature

A confirmed step still has to be big enough to be worth a mark, and how big that
is cannot be a constant. It was one — 0.5% — and the bug that killed it is three
installer-size series plotted over a week with no bars at all. The test saw the
steps perfectly well: 41 candidates on `installer size libxul.so`, several gating
at p ≈ 1e-9. Every one was thrown away by the floor, because a 240 MB binary that
grows by 68 KB has moved 0.028% and the whole week's spread is 0.14%. A 0.5% floor
on a size metric admits nothing, ever.

Perfherder has the answer already, per signature, on the summary endpoint:
`alert_threshold` with `alert_change_type`, which is either a percentage or an
**absolute** delta in the metric's own units. Autoland alone declares 0.25%
(awsy), 2/5/6/10% (talos, browsertime), 50% and 100% (build times), 100 KB and
1 MB. `changes.ts` takes a **quarter** of whichever it is — the same quarter the
old constant was of perfherder's global 2% default, so nothing moved for the
signatures that declare nothing, and this is only ever a change for one that does.

Three wrinkles, none optional:

- **The two kinds are not interchangeable.** An absolute floor compares
  `afterValue − beforeValue`; a percentage floor compares the relative change.
  Reading one as the other is off by whatever the metric's magnitude happens to be.
- **A subtest declares nothing and inherits its parent's.** All three signatures
  in the bug are subtests of an `installer size` suite that carries the 100 KB;
  they carry nothing. Perfherder doesn't inherit — it goes straight to the global
  2% — but it also never reaches that line, because a subtest whose `should_alert`
  is null under a suite that sets one is treated as false and never analysed at
  all. There is no perfherder verdict to match here, only the gap this whole
  feature exists for, and the parent's threshold is the best statement available
  of what a real move in the metric looks like. Costs one metadata-only request
  per parent per session (`fetchSignatureMeta`, a zero-width window).
- **Detection waits for that request** rather than running at the default and
  redoing it. The result is cached under a key that says nothing about the floor
  it was computed with, so a first pass at 2% would be an empty array nothing
  ever revisits.

With the signature's own floor, the three series draw 9, 8 and 2 bars over that
week where they drew none. The `libxul.so` and `xul.dll` graphs put four of theirs
on the same push to within a quarter of an hour, three of them to the second, which
is the check worth doing on a detector: two platforms built from one tree should
step together, and noise should not.

Every constant is in [changes.ts](../src/lib/graphs/changes.ts) with its reason;
the five worth knowing here:

- **A CUSUM threshold of 3.5 for proposing a cut**, which is √(2 log n) at n = 500:
  the point where the sharpest split in a few hundred pushes stops being what noise
  ordinarily produces. It is not a verdict, so what it really controls is how many
  candidates the α downstream has to cover — the two were measured together, and the
  table is at the constant. At 3.5 nothing is drawn on 40 synthetic flat series; at
  3 two bars are, in exchange for two of perfherder's alerts that cancel each other
  out.

- **A fixed window of 24 pushes a side**, clipped to the walls and to the stretch
  the candidate was proposed in. 24 is `PERFHERDER_ALERTS_MAX_BACK_WINDOW`, matched
  deliberately:
  perfherder's alert quotes means over 12–24 pushes back against 12 forward, and
  both cards can be in the details pane at once, so the two "before → after"
  pairs should be on the same scale. Where they differ it should be because the
  analyses disagree, not because one averaged ten times as much data.
- **Six pushes a side, minimum — to propose and to gate.** A rank statistic on
  *balanced* pools this small has a floor on the p-value it can reach however
  cleanly they separate: 0.030 at 4v4, 0.012 at 5v5. Where the mark finally goes is
  bounded by `canReachAlpha` instead, which asks the same question of the actual pool
  sizes: 4v10 clears α, and holding the estimate to six would leave a step near the
  edge of the range marked on the wrong push with a diluted delta. One knock-on: a
  step is reported five pushes after it happens rather than six, since the gate's
  pool may straddle it and the estimate then slides onto it.
- **α = 0.01, not the 0.05 the comparison card uses.** Multiple comparisons: the
  card asks one question about two builds the user picked, this asks one per
  candidate on every plotted series, unprompted, and the greedy loop asks again each
  round. At 0.05 that is on the order of one manufactured bar per series per range,
  which for something drawn by default is the difference between a second opinion
  and a nuisance. The CUSUM threshold is the other half of the same budget.
- **A minimum change of a quarter of the signature's own alerting threshold.**
  With enough pushes the test will certify a 0.05% drift, which is true and
  useless, so there has to be a floor; a quarter keeps it far below perfherder's
  bar, because a floor near theirs would rebuild the blind spot this exists to
  cover. See "The floor comes from the signature" for why it is not a constant.

#### Deviations from perf.webkit.org

- **Mann-Whitney U over push means, not Welch's t.** Non-parametric, robust to
  the outlier pushes CI data is full of, and — the deciding reason — it is the
  same test the comparison card reports, so a bar and the card a click on it
  produces can't contradict each other about whether two things differ.
- **A fixed window rather than one grown until significant.** perf.webkit.org
  expands outward from ±2 until its t-test fires and reports that window, which
  is optional stopping: the p-value isn't the false-positive rate it looks like,
  and the means come from the smallest sample that happened to clear the bar
  rather than the best one available. What that costs us is perf.webkit.org's
  incidental reading of "how much data it took to see this" — the bar's extent
  here is the evidence, not a measure of confidence.
- **No cut closer than six pushes to the end of its stretch.** perf.webkit.org
  allows length-1 segments and special-cases their cost to zero. Here the proposal
  stage refuses to offer what the confirmation stage could not test, which also
  means an outlier is never fenced off into a segment of its own — the failure mode
  that used to need a rejection rule downstream.
- **Binary segmentation against a local scale, not a penalised dynamic program.**
  Theirs picks one segment count for a whole grid by a Schwarz criterion, so its
  sensitivity comes from that grid's total spread — and a series whose noise varies
  fourfold across it cannot be served by one number. That is not a tuning problem:
  on autoland signature 5352791 a 6σ step sat inside a single segment covering 460
  pushes, and no setting of the penalty constant both found it and stayed quiet on
  noise. Splitting recursively and scoring each stretch against a scale estimated
  inside it finds the step at any threshold that keeps flat noise clean. It is also
  O(n·k) rather than O(n²k), which retired the grid, its size constant, the
  segment-count ceiling and the variance floor: 8.9 ms at 2000 pushes against 33.
- **Greedy confirmation with growing walls, not one pass in boundary order.** See
  "Three stages" above for the three defects this fixes, all of which were live.
- **A confirmed boundary's index is re-estimated with a rank statistic.** One bad
  job can walk the segmentation's boundary several pushes off the step it found,
  and the confirmation stage cannot see it happen: a ±24-push window straddles
  the real step from either index, so the test says "a step is in here" and only
  the index is wrong. Found on autoland signature 299010 (tresize, 2026-07-23),
  where a push whose three runs came back 8.20 / 6.26 / 8.29 took the boundary
  eight pushes — ten minutes — off the real step, because holding that one push
  out of the pre-step segment bought more variance than putting it in the
  post-step one cost. The notch was drawn early, the reported delta understated
  the step (−3.4% against −4.7%, pushes still at the old level sitting in the
  "after" pool), and a click pinned the wrong pair of builds. Cliff's delta over
  the same window puts the boundary back on the step; the variance cost, re-run
  inside the window, picks the outlier all over again. δ rather than |z| because a
  z is standardized by a null deviation that grows with `n1 · n2` and so prefers
  the balanced split — a pull toward the middle of the window, which is where the
  candidate being escaped from sits. Both splits have to clear α, so relocation
  can only remove a change, never add one.

#### How it's drawn, and what a click does

- **Bars along the plot's floor, inside the plot rather than in a reserved band
  under it.** perf.webkit.org shrinks its chart by the height of its annotation
  rows. Here the row count is a function of the *zoom* — two bars overlap at a
  year and don't at a week — so a reserved band would resize the plot mid-drag,
  against the layout-stability rule in design.md and in the place the user is
  watching most closely. As an overlay the row count costs nothing, at the price
  of covering a few pixels of the lowest dots. Rows stack upward and share
  `packRows` with the alert markers.
- **Direction gets the area, series identity gets the notch.** Red for a
  regression, green for an improvement — the same vocabulary as the alert
  triangles, because they are the same kind of statement and only the shape
  should distinguish them. The first version also outlined each bar in the
  series color the way a triangle is outlined; on a 5px-tall bar that put two of
  its five rows of pixels in a color answering the *less* important question,
  and screenshotted over two real series every bar read as "the cyan one" and
  not one of them read as green. So the two swapped: the fill carries direction,
  and the 2px notch marking the step carries the series color.
- **The notch is there because a wide bar over-claims.** The bar spans the
  pushes the test compared; the notch marks the first push after the step, which
  is the vertex where the connecting line kinks. Halfway between that push and
  the one before it is the honester estimate — the step happened somewhere in
  that gap and nothing in the data says where — and that is what it was at first.
  It read as a bug: at a tight zoom half a push gap is minutes wide, so the notch
  stood visibly beside the kink it was pointing at, and a mark that doesn't line
  up with the line the reader is looking at doesn't get the benefit of the doubt.
  The bar is what carries the "somewhere in here".
- **Hover grows the bar and runs a full-height guide up its column.** A bar
  hugging the floor is a long way from the dots it is about; the guide is what
  connects them, and keeping it to the hover is what lets the resting bar stay
  quiet. Same device the alert markers use.
- **Hover also says what the bar is**, which for these matters more than it does
  for the triangles: a 5px strip along the floor reads as chrome, and the first
  thing a reader needs to know is that it is *this page's* reading and not
  perfherder's — which is what explains a bar where no triangle is, and why no
  bug number will ever be attached to one. So the tooltip carries that sentence
  along with the two window means, the p-value and the effect size
  ([graphTooltip.ts](../src/lib/graphs/graphTooltip.ts)).
- **A click sets up both ends of a comparison**, exactly as an alert marker
  does — the push after the step selected, the one before it pinned, one history
  entry (`AppState.selectPushPair`, shared by both). So a bar goes from "there
  is a step here" to the comparison card's replicate distributions and rank-sum
  test in one gesture.
- **The pane's Detected-change card will print a different percentage from the
  comparison card below it, and both are right** — the same relationship the
  Alert card has with the comparison, one step milder. The card is a difference
  of means over up to 24 pushes a side; the comparison is these two builds. Each
  says which it is.

#### One landing, not nine bars

Twelve signatures on one graph produce twelve sets of bars, twelve per-card
counts in the series list, and no statement anywhere that nine of them are one
event. The pane's Detected-change card carries that statement: **Same landing —
"seen in 9 of 9 plotted series · pinned to one push"**, then the window, then
one clickable row per member with its swatch and its own percentage.

- **The grouping is [cluster.ts](../src/lib/graphs/cluster.ts), the module the
  CLI's `changes --cluster` uses** — moved under `src/lib/graphs` for this,
  since dependencies run `src/cli` → `src/lib` and never back, and app logic the
  CLI reuses is the honest arrangement rather than the reverse. Both views
  therefore group identically and word a window identically
  (`landingWindowLabel`); checked against production, the pane's block and
  `changes --cluster` report the same nine members and the same "pinned to one
  push" for bug 1899194's landing on 2026-07-15.
- **Events group by the interval each brackets, not by the push each was placed
  on.** A bar's position is an estimate — that is what the notch and the bar's
  width are about — and no two platforms run the same pushes, so one landing is
  placed on a different revision by each series that saw it. What is not an
  estimate is `(pushBefore, pushAfter]`. `barEvents` therefore takes the bracket
  from the pair of pushes the bar sits between and **not from the bar's own
  `x0`…`x1`**, which is the two-dozen-push window the test compared and would
  join everything to everything.
- **The intersection is narrower than any member's bracket**, which is the whole
  payoff: nine series each saying "somewhere in these three hours", of nine
  different sets of three hours, agree on one push.
- **Free for the series already plotted.** This is the same question "Common
  alerts" was killed over in graphs-todo.md — that one needed 29 MB of a
  framework's alert summaries to ask "who else moved here". Here the changes are
  computed, the push times are in memory, and the grouping is arithmetic.
- **Visible series only**, because the claim is about the bars on the graph.
  Hiding a series takes its bars off the plot and its row out of the block.
- **Bars only — perfherder's alerts are not merged in.** Deciding that an alert
  and a bar are one finding is `reports.ts::mergeFindings`, which the app has no
  equivalent of; a landing that listed one move twice would overstate its reach.
  So the block never carries a bug number, and the CLI's does.
- **A member row is a click to that series' bar**, the same `selectChange` the
  bar itself calls, so "who else saw this" leads straight to "show me theirs".
  The row you are on is marked rather than disabled: one dead row in a list of
  live ones reads as broken.

#### On by default

`changeDetection` starts on, which departs from how this app usually treats
interpretation. The justification for building it is the gap where perfherder is
silent, and a feature that only helps the people who find a checkbox does not
close that gap. The bars earn the default by being quiet — a 5px strip along the
floor — and by never claiming to be a verdict: the word is "detected" wherever
they are described, and the pane's card says outright that no alert may exist
for what it found. `cd=0` in the URL turns them off.

#### Cost

Cached per `(series, range)` alongside the series data and pruned with it, filled
by an effect rather than derived, because `series` recomputes for reasons that have
nothing to do with the data — a theme flip, a replicate toggle. Measured (node, so
ratios rather than absolutes): 1.3 ms at 400 pushes, 3.7 ms at 900, 8.9 ms at 2000,
and 6 ms for the 752-push fixture, which is the shape that costs most — 32
candidates, so 32 rounds of gates. The dynamic program this replaced was 4.4 / 12.4
/ 33 ms on the same machine and 17 ms on that fixture, so the cache now buys much
less than it did; it stays because the reasons for it were never mainly about the
segmentation's cost. Turning the switch off hides the bars without dropping the
cache; turning it back on doesn't pay again.

### The drift figure, for the series with no bars

Segmentation looks for steps, so a series that slides 10% over six months gets no
bar — honestly, but silently. Signature 5350957 is the case that got this built:
1,158 pushes, a climb plain in the sparkline, **no bar and no perfherder alert
anywhere in six months**. Everything this app drew was silent about a real
regression, and graphs-todo.md had carried that as a known hole for as long as the
detector had existed.

The answer is a figure on the series-list card, beside the alert and change
counts: **"1,161 points · +10% drift"**. [drift.ts](../src/lib/graphs/drift.ts)
computes it, `series --drift` prints the same object, and the module sits under
`src/lib` for cluster.ts's reason — dependencies run `src/cli` → `src/lib` and
never back.

- **It is two medians, not a detection.** `WINDOW_PUSHES` a side, imported from
  changes.ts so a drift figure and a `step` or `changes` figure are on one scale;
  medians rather than means, because one bad push drags a mean. The rank test says
  the ends are at different levels, which is *not* the claim that something
  stepped between them — a series with one clean step in the middle drifts by
  exactly that step. That is also why it is a number on a card and not a span
  drawn across the plot: a span would claim to know the shape of the climb, and
  this knows nothing about the shape.
- **A badge that drew itself pays the bars' price.** `series --drift` was asked
  for by name and prints whatever it computed; the card shows up uninvited on
  every series, so `driftWorthReporting` holds it to two bars borrowed rather than
  invented — the detector's floor (a quarter of the signature's own alerting
  threshold) and `CHANGE_ALPHA` rather than `SIGNIFICANCE_ALPHA`, for the
  multiple-comparisons reason changes.ts gives. Without the floor a rank test over
  1,158 pushes will certify a 0.05% drift, which is true and useless; without α
  every noisy series wobbles its way onto a card.
- **Absence covers three things**: flat, too short a range to ask, and a climb
  inside the series' own noise. The card shows nothing for all three, because a
  badge that distinguished them would be a sentence. The CLI separates them.
- **The percentage is in the badge and the rest is in the hover**: both medians
  with their unit, both windows' dates, the p-value, and the reminder that the
  ends differing is not a step. "February against now" is a claim the reader has
  to be able to check, and 24 pushes on autoland is three days rather than a
  month.
- **Not gated on `cd`.** That switch governs marks on the plot, and the series
  this figure exists for has no marks: turning the bars off is not a reason to
  withdraw the only reading that saw the climb.
- **It cost the row a second line.** Measured at the pane's width, `.sub` holds
  about 28 characters, and a busy card wants 49 — "1,271 points · 1 alert · 2
  changes · +7.7% drift". As one clipped line the busiest card lost the figure
  outright and the middling ones truncated it to "+4…", which reads as a rendering
  bug rather than as an omission. So `.sub` now wraps to two clamped lines with
  **both reserved from the start**: alerts arrive on a second fetch and the change
  count and drift figure land after detection, and a row that took its second line
  when they arrived would move every card below it. Verified in a browser: the
  cards are 87px whether they use one line or two, and card 5 gaining its alert
  badge late moved nothing.
- **Checked against production.** The five signatures in graphs-todo.md's drift
  table show +10%, +45%, +29%, +14% and +7.7% on their cards — the same figures
  `series --drift` prints for them, which is what sharing the module buys.

### The trend band

The drift badge says the ends of the range differ and deliberately says nothing
about the path between them. The band is that path: **a p25–p75 ribbon with a
median line through it**, over the same `WINDOW_PUSHES` window, one vertex per
push. `trend=1`, or the "Trend band" checkbox.
[trend.ts](../src/lib/graphs/trend.ts) computes it.

**Its first and last median are the drift badge's two numbers, by
construction** — same window rule, so the badge is literally the endpoints of
this curve and the two cannot disagree. That invariant is a test.

#### Why quartiles and not a moving average

perf.webkit.org offers three moving averages and this app had none, and the
obvious next step was to add one. The data talked us out of it. Pooling 24 pushes
at each end of the six-month window and running the mode analysis over three of
the drifting idb-open signatures:

| Signature | Badge | What the typical run did | Modes |
| --- | --- | --- | --- |
| 5350975 | +45% | fast mode 623 → 642 ms, **in place** | 1 → 2: a **new mode at 917 ms taking 67%** |
| 5350957 | +10% | 6428 → 6831 ms, **less than the KDE can resolve** | unimodal, shares held |
| 5350963 | +14% | 28158 → 29874 ms, **+6.1%, genuinely moved** | unimodal, shares held |

The +45% series never got slower. Its fast path is as fast as it was in February;
a second, slower path appeared and now takes two thirds of the runs. **A single
smoothed line there climbs 622 → 900 ms through the gap *between* the two modes —
a value almost no measurement ever took.** And in all three cases the badge's
percentage is roughly double the movement of the typical run, because a median
over push means absorbs a growing tail.

So the thing that changes in these series is the *shape of the distribution*, and
one line cannot carry that while two edges and a middle can. What the four graphs
actually look like with the band on, which is worth loading before changing any of
this:

- **Floor holds, ceiling climbs** — 5350975. p25 sits flat at ~620 ms from February
  to August while p75 goes 640 → 920. That is the mode takeover, drawn: the fast
  path never moved, and everything the badge's +45% reports happened above it.
- **Both edges rise and the band widens** — 5350957. p25 goes ~5500 → ~6400 and p75
  ~6500 → ~8300. Two things happened at once, and only the band separates them: the
  frequent *downward* dips of February stopped, which lifts the floor, and the upward
  tail grew, which lifts the ceiling much further. The median moves 6350 → 7000, the
  +10% the badge reports.
- **A narrow band sliding** — 5350963. The band stays tight around 28k and steps up
  to ~31.5k from June, which is what a real level change looks like and matches the
  mode analysis above: peak moved, shares held.
- **A permanently wide band** — 5141330, AWSY. Wide from end to end, because
  consecutive pushes land in different clusters of a multi-modal mixture, and sliding
  upward over the year. "No typical value here, and it got worse anyway." See the
  next section: this is the series where the median line needs the band read with it.

#### The median line is the least trustworthy of the three, and the band says so

**All three curves are quantiles of a mixture, and a quantile of a mixture is not a
level of anything.** The median answers "where does the middle-ranked push of these
24 sit", which coincides with a mode only while one mode holds a clear majority of
the window.

AWSY's `Explicit Memory` on macOS (signature 5141330) is the case that shows it, and
it is worth loading with `trend=1` before touching this code. Its raw plot is a wall
of vertical zigzag and it collects 16 change bars over a year. Its push means over
Aug–Nov 2025 fall in **at least four clusters — roughly 540, 558, 585 and 612 MB**,
with sparse gaps between them (a 2 MB-binned histogram of 400 pushes has 0–2 pushes
per bin across 568–577 and 596–607). So:

- The median **hops between clusters** as the mixture shifts over months, and where
  the window splits near 50/50 it lands **in a gap** — at 576.7 MB in one window,
  a value almost no push ever took. That is why it can look "close to the lower band
  but on neither band": it is often sitting on a middle cluster the year-long view is
  too dense to resolve.
- It **steps rather than glides**. Measured on that series: one push entering the
  window moves this median by up to **18.6 MB where a 24-push moving mean moves at
  most 3.5** — 5× — and over ten pushes it swung 32.8 MB against the mean's 5.2. That
  is the median being a rank statistic. It is also the answer to "why does this react
  faster than a moving average", which is the first thing a user asks about it.
- A jump therefore means **the majority of the window changed cluster**, which is a
  real event but not the one a reader will assume ("it got 30 MB slower") unless they
  read the band with it.

All of which reads correctly *because* the band is wide: a wide band means "there is
no typical value here", which is the truth about that series and something no single
line can say about itself. On a series with one mode and stable spread the same three
curves collapse to a tight ribbon around a line that does mean what it looks like.

#### Decisions

- **Centred windows, not trailing.** A trailing window lags by half a window, which
  would put the curve's kink twelve pushes to the right of the change bar marking
  the same event. Two marks disagreeing about when something happened is worse than
  one mark fewer.
- **Clamped at the ends, not shortened.** The first and last windows slide inward
  rather than shrinking, so no point is noisier than any other — and the end windows
  are then exactly the drift figure's two.
- **Off by default**, which is the opposite call from the change bars and does not
  contradict them. The bars are on because the gap they close is invisible until
  something draws it; that gap is now closed for drift too, by the badge, which costs
  no switch and no ink. The band adds the *shape* of something the reader has already
  been told about, and nine ribbons unasked-for would be a different graph.
- **Ribbon under the dots, the three curves over them.** The ribbon is a fill covering
  a quarter of the plot on a noisy series, and over the dots it would grey out the data
  it is summarising; the curves are what a reader follows, and under 20,000 translucent
  dots a 1–2px line disappears.
- **The quartiles are stroked as well as filled**, which the first version did not do
  and which the screenshots forced. At a fill alpha low enough to survive nine
  overlapping ribbons, and in the series' own colour under the series' own dots, a
  ribbon narrower than ~30px reads as a smudge: on 5350975 it was invisible, and on
  5350957 the two edges that *are* the finding could not be seen. The fill says
  *region*, the 1px edges say *where*, and the median is drawn last so it still wins
  where a narrow band puts all three within a pixel.
- **Both in the series' own colour**, since on a nine-series graph a band has to say
  whose it is and the list's swatch is the only key there is. The ribbon's alpha is
  low enough to survive nine of itself overlapping.
- **`points: None` is the band's companion**, and the two are worth reaching for
  together: this ribbon is drawn under every dot of every series, and on the encrypt /
  decrypt pair above it is a smear across a fifth of a plot scaled to the raw data's
  outliers. Turning the dots off gives the band the axis (see "Replicates"). The two
  stay separate switches, though — a band nobody asked for is not the answer to
  "hide the dots", and `none` with the band off is a legitimate view of the marks
  alone.
- **The header's rows are what the switches cost.** An earlier version of this
  section recorded 27px of plot height lost to the third checkbox at one narrow band
  of widths, and accepted it because "restructuring the header's groups would be a
  bigger change than the row is worth". The header has since been restructured for
  the points group (see "The header is two groups"), which is where that
  accounting now lives.
- **Cached per `(series, range)` and pruned with the data**, like the change bars and
  for the same reason: a quartile of 24 values *per push* is 2,700 sorts on a year of
  autoland, and `series` recomputes for reasons that have nothing to do with the data.
  Nothing is computed at all while the switch is off.

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

- [graphApi.ts](../src/lib/graphs/graphApi.ts) — the three endpoints, plus
  `/repository/` for hg-vs-git link shapes. Network and the valibot schemas
  that every response is validated against; the `Raw*`, `Push` and `Job`
  types are inferred from those schemas. See design.md, "Validating API
  responses" — including why nullability is transcribed from treeherder's
  serializers rather than from sampled payloads.
- [graphData.ts](../src/lib/graphs/graphData.ts) — **pure**. Flat rows →
  push/run/replicate, plus the flat arrays the renderer walks — both of them,
  see "Replicates" above. Also `SeriesMeta` and the three projections into it:
  `metaFromSummary`, `metaFromSignature` (the early identity, from the picker's
  signature row) and `placeholderMeta`, with `source` naming which one ran.
- [chart.ts](../src/lib/shared/chart.ts) — **pure**. Scales, domains, ticks,
  formatting, plot geometry, hit-testing, palette, and the jitter both charts
  use (see "Dots are translucent, and jittered sideways" below).
- [chartDraw.ts](../src/lib/graphs/chartDraw.ts) — canvas painting. Imperative, but
  takes all its coordinates from a `PlotGeometry`.
- [alertsApi.ts](../src/lib/graphs/alertsApi.ts) — `/performance/alertsummary/`, and
  the schemas for it. [alerts.ts](../src/lib/graphs/alerts.ts) — **pure**. Summaries →
  the marks the graph draws and the facts the pane prints. See "Alerts" above.
- [changes.ts](../src/lib/graphs/changes.ts) — **pure**. Segmentation and the
  confirmation test; a series' pushes and its `AlertThreshold` → the steps in it.
  See "Detected changes".
- [cluster.ts](../src/lib/graphs/cluster.ts) — **pure**. Change events from
  several series → the landings that caused them, plus `barEvents`, which is how
  the app's bars become events. Shared with the CLI's `changes --cluster`; see
  "One landing, not nine bars".
- [drift.ts](../src/lib/graphs/drift.ts) — **pure**. The two ends of the loaded
  range against each other, for the series segmentation has nothing to say about,
  plus the two bars that decide whether the card mentions it. Shared with the
  CLI's `series --drift`; see "The drift figure, for the series with no bars".
- [trend.ts](../src/lib/graphs/trend.ts) — **pure**. The same statistic as drift.ts
  evaluated at every push instead of at the two ends: a rolling p25 / median / p75.
  See "The trend band" — including why it is quartiles and not a moving average.
  **"Band" in this module means the trend ribbon**; the comparison card's density
  band is a different thing (comparison.md), which is why nothing here is named
  `band`.
- [annotations.ts](../src/lib/graphs/annotations.ts) — **pure**. The marks in the
  plot's margins: row packing, pixel layout and hit tests for both the alert
  triangles and the change bars. Both of its layouts are computed once by
  ScatterChart and read by the draw call, the overlay and the hit test alike.
- [graphTooltip.ts](../src/lib/graphs/graphTooltip.ts) — **pure**. What those marks
  say when you point at one. Separate from the components because the wording
  carries the same sign and window conventions as the pane's cards, and a tooltip
  that disagreed with the card a click leads to would be worse than none; the
  chart asks for the words through a callback rather than composing them, the same
  division as `onalertselect`. See design.md, "Tooltips".
- [timeRange.ts](../src/lib/shared/timeRange.ts) — **pure**. Presets ↔ absolute
  bounds.
- [urlState.ts](../src/lib/urlState.ts) — **pure**. Query string ↔ `ViewState`.
- [appState.svelte.ts](../src/lib/graphs/appState.svelte.ts) — the reactive core.
- [ScatterChart.svelte](../src/lib/graphs/ScatterChart.svelte) — one canvas component
  serving both graphs, parameterized by `interaction: 'select' | 'brush'`.
- [stats.ts](../src/lib/shared/stats.ts), [kde.ts](../src/lib/graphs/kde.ts),
  [distribution.ts](../src/lib/graphs/distribution.ts),
  [distributionDraw.ts](../src/lib/graphs/distributionDraw.ts),
  [compare.ts](../src/lib/graphs/compare.ts),
  [DistributionChart.svelte](../src/lib/graphs/DistributionChart.svelte) — the
  details pane's distributions and comparison mode. All pure except the last
  two. See [comparison.md](comparison.md).
- [job.ts](../src/lib/graphs/job.ts) — **pure**. A job row's duration, and its
  type with the platform prefix the pane has already said stripped off.
- [SeriesList.svelte](../src/lib/graphs/SeriesList.svelte),
  [GraphPane.svelte](../src/lib/graphs/GraphPane.svelte),
  [DetailsPane.svelte](../src/lib/graphs/DetailsPane.svelte) — the three panes.
  The details pane delegates its comparison card to
  [ComparisonSection.svelte](../src/lib/graphs/ComparisonSection.svelte), its
  three change headlines to
  [ChangeHeadline.svelte](../src/lib/graphs/ChangeHeadline.svelte), and shares
  its text styles with both through
  [detailsPane.css](../src/lib/graphs/detailsPane.css).

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
  ([chartDraw.ts](../src/lib/graphs/chartDraw.ts)). One dot covers half the background,
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
  ([distributionDraw.ts](../src/lib/graphs/distributionDraw.ts)) had the identical bug and
  carries the identical fix, where a pool of tens of values makes the question moot.
- **Horizontal jitter**, sized in x units and applied in pixels, from a
  deterministic hash of `(datumId, replicateIndex)`. See "Jitter" in
  [chart.ts](../src/lib/shared/chart.ts) for the arithmetic; the decisions:

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

- **No tooltip on a dot, and no hover/click arrow panel.** Clicking a dot fills
  the right-hand pane instead. *Hovering* one fills the pane's comparison card as
  a preview against the selection — which is the same information a tooltip would
  carry, in a place where it has room to be a distribution and a rank-sum test.
  See [comparison.md](comparison.md). The *marks* are the other way round and do
  have one: a triangle or a bar is a claim with no room to state itself, and the
  pane only speaks once you have clicked. They are also the only thing in the app
  with a drawn tooltip rather than a `title` — being canvas, they have no element
  to put one on. See "Alerts" and "Detected changes" above, and design.md,
  "Tooltips: for what the canvas paints".
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
the same series looks the same in both tools — [chart.ts](../src/lib/shared/chart.ts)
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

Drawing details, in [chartDraw.ts](../src/lib/graphs/chartDraw.ts):

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
that showed only half of the encoding would make the shapes unreadable. The
swatch is identity and nothing else — colour plus shape, in both panes, always
filled. It does *not* mirror the symbol's own filled/hollow state, which would
be the sixth series' hollow diamond drawn hollow twice and the fifth's filled
diamond drawn filled, telling the reader nothing they can act on while costing
the swatch its contrast at 12px. The picker's "already plotted" swatch stays a
plain square: it answers "do you already have this one", and the graph isn't
on screen to compare against.

**Hiding a series** keeps it in the list, in the URL, and in its color slot —
only the drawing stops. Everything downstream of `AppState.visibleSeries`
(both y domains, hit-testing, the "no data" note, keyboard stepping) works off
the visible subset, so a hidden series can't influence the plot. A selection
belonging to a hidden series survives; the details pane says why it isn't on
screen and offers to unhide.

**The control is an eye button under the swatch**, in the card's left column.
It used to *be* the swatch, hollow when hidden, on the reasoning that the
swatch is what ties a card to the graph — but a 12px coloured square with no
icon and no border isn't a thing anyone tries clicking, so the feature existed
without being findable, and the fill was then carrying identity and state at
once. Splitting them gives each element one meaning: the swatch says which
series, the eye says whether it's drawn.

- **Left column, not the action cluster.** "Is this one on?" is asked of the
  swatch, so the answer belongs beside it, away from the reorder/remove
  operations. It's also the placement that costs nothing: the swatch and the
  eye stacked come to 37px against the 2×2 action grid's 38px, so the card
  height is unchanged, where a fifth button on the right would have forced a
  third row onto every card in the list.
- **Hidden drops the pupil and draws the slash**, rather than slashing the
  whole eye. At 12px a line crossing both lid and pupil is three strokes
  meeting in the middle, and the casing that makes a slashed eye legible at
  24px — a second stroke in the background colour beneath the slash — can't be
  used on a `.btn`, whose fill changes on hover.
- **No `aria-pressed`.** The label already carries the state ("Hide this
  series" / "Show this series"); a pressed state on top of that announces the
  opposite thing twice.
- The hidden card dims its swatch along with its text, so "off" is still
  legible while scanning eight cards — but as opacity, which is a state that
  can be layered over the identity rather than a competing encoding of it.

## URL state

The whole view is in the query string:

| Param | Meaning |
|---|---|
| `series` | Repeated. Each is `repo,signatureId,frameworkId[,0]`; the trailing `0` means hidden and is omitted when visible. **Order is significant** — it drives legend order and color assignment. |
| `range` | Absolute full time range, `<startMs>,<endMs>` |
| `zoom` | Absolute zoomed range, `<startMs>,<endMs>`; absent when not zoomed |
| `sel` | Selected point, `<repo>,<signatureId>,<datumId>,<replicateIndex>`. A `replicateIndex` of `-1` (`MEAN_REPLICATE`) means the run's *mean* rather than one of its replicates — what a click selects while the points mode is not `replicates` |
| `cmp` | Pinned comparison point, same shape as `sel`; set by shift-clicking a dot. Only written alongside a `sel`, since a comparison needs two ends. See [comparison.md](comparison.md) |
| `pts` | Which dots are drawn: `runs` (one per run at its mean) or `none` (no dots and no connecting line). Omitted for `replicates`, the default. **`reps=0` is still read** as `runs` — it is what links written before the third mode say — but never written, so such a link normalizes on the next interaction |
| `cd` | `0` to stop drawing the steps this app detects for itself. Omitted when on, which is the default — see "Detected changes" |
| `trend` | `1` to draw the rolling quartile band. **The one drawing switch written when *on*** rather than off, its default being the other way round — see "The trend band" |
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
