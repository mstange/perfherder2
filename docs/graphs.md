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
6. **Build** — push time, revision, author, the pushlog link, and the commit
   list. Last because it's the longest section by far and the least specific to
   the dot: two dots on the same push have identical builds.

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

### Where the artifact list comes from

`GET https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/<taskId>/runs/<runId>/artifacts`
— taskcluster-queue's `listArtifacts`, the only non-treeherder endpoint the app
calls. See [artifactsApi.ts](../src/lib/graphs/artifactsApi.ts).

- **`runId` is the job's `retry_id`**, added to `JobSchema` for this. Artifacts
  hang off the *run*, not the task: a retried task keeps its task id, so a link
  built without the run number points at the wrong attempt's files. `task_id`
  and `retry_id` are both `v.optional` and absent together — they come from one
  `taskcluster_metadata` relation the view skips when it's missing — so
  `AppState.selectedTaskRun` is the one place that checks for the pair.
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
counterpart carries alert #51136 for the very same push. The change hit both —
macOS moved +2.0% against Windows' +9.9% — and only one of them crossed the
alerting threshold. The macOS graph is not quiet; it is unannotated. The idea
and the two-stage shape are perf.webkit.org's ("Segmentation with Welch's t-test
change detection", `public/v3/pages/chart-pane.js`); the deviations are below.

#### The unit of analysis is the push mean

This app has something perf.webkit.org doesn't: tens of replicates per build. It
is tempting to feed them all in, and it would be wrong. Replicates within one
build share a machine, a binary and a moment, so their spread is far tighter
than the build-to-build spread a regression has to be seen against — pooled, a
rank-sum test over 20 replicates a side calls *every* adjacent pair of pushes
significantly different, and the whole graph turns into bars. Textbook
pseudo-replication. So the values are `PushGroup.mean`, one per build: the same
number the connecting line joins. The replicates still earn their keep, by
making each of those means precise.

#### Three stages

1. **Segment.** Find the boundaries that minimise a penalised cost — segment
   cost is `len · log(variance)`, penalty is Birgé and Massart's, the whole
   thing scored by the Schwarz criterion. `segmentValues`. This decides *where*
   a step might be, and nothing else; it does not test anything.
2. **Confirm.** For each interior boundary, a two-sided Mann-Whitney U over the
   push means either side. `confirmChange`. Boundaries that don't survive are
   dropped, which is what keeps a segmentation that liked an outlier from
   reaching the graph.
3. **Relocate.** Re-estimate the confirmed boundary's index as the cut through
   its own window with the largest Cliff's delta. `relocateBoundary`. Not
   perf.webkit.org's, and the reason it exists is below.

Every constant is in [changes.ts](../src/lib/graphs/changes.ts) with its reason;
the four worth knowing here:

- **A fixed window of 24 pushes a side**, clipped to the neighbouring
  boundaries. 24 is `PERFHERDER_ALERTS_MAX_BACK_WINDOW`, matched deliberately:
  perfherder's alert quotes means over 12–24 pushes back against 12 forward, and
  both cards can be in the details pane at once, so the two "before → after"
  pairs should be on the same scale. Where they differ it should be because the
  analyses disagree, not because one averaged ten times as much data.
- **Six pushes a side, minimum.** A rank statistic on small pools has a floor on
  the p-value it can reach *however cleanly* the groups separate: 0.030 at 4v4,
  0.012 at 5v5. Below six a side the answer would come from arithmetic rather
  than from evidence.
- **α = 0.01, not the 0.05 the comparison card uses.** Multiple comparisons: the
  card asks one question about two builds the user picked, this asks one per
  candidate boundary on every plotted series, unprompted. At 0.05 that is on the
  order of one manufactured bar per series per range, which for something drawn
  by default is the difference between a second opinion and a nuisance.
- **0.5% minimum change.** With enough pushes the test will certify a 0.05%
  drift, which is true and useless. Far below perfherder's 2% alerting
  threshold, deliberately — a threshold near theirs would rebuild the blind spot
  this exists to cover.

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
- **Minimum segment length 2.** perf.webkit.org allows length-1 segments and
  special-cases their cost to zero; here a single value has no sample variance,
  so it would score at the variance floor, which is an unbounded discount one
  outlier could buy out of nothing.
- **The DP runs once, layer by layer.** perf.webkit.org re-runs its whole
  dynamic program for each candidate segment count, which is O(n²k²);
  evaluating the criterion off each layer of one run is O(n²k) for the same
  answer.
- **Grid edges are discarded, not kept as candidates.** Rediscovered the hard
  way — see GRID_SIZE. Keeping them manufactured a −1.0% "change" at p = 0.028
  out of the noise on a synthetic series, every 500 pushes, guaranteed.
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
  pushes the test compared; the step itself happened between two of them, and
  the notch says which two.
- **Hover grows the bar and runs a full-height guide up its column.** A bar
  hugging the floor is a long way from the dots it is about; the guide is what
  connects them, and keeping it to the hover is what lets the resting bar stay
  quiet. Same device the alert markers use.
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
by an effect rather than derived, because `series` recomputes for reasons that
have nothing to do with the data — a theme flip, a replicate toggle — and the
segmentation is an O(n²) dynamic program. Measured (node, so ratios rather than
absolutes): 3 ms at 340 pushes, 10 ms at 900, 21 ms at 2000. The inner loop is
bounded by `GRID_SIZE`, so a long range costs a multiple of one grid rather than
its square, and eight series over a year is a fraction of one fetch. Turning the
switch off hides the bars without dropping the cache; turning it back on doesn't
pay again.

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
  see "Replicates" above.
- [chart.ts](../src/lib/shared/chart.ts) — **pure**. Scales, domains, ticks,
  formatting, plot geometry, hit-testing, palette, and the jitter both charts
  use (see "Dots are translucent, and jittered sideways" below).
- [chartDraw.ts](../src/lib/graphs/chartDraw.ts) — canvas painting. Imperative, but
  takes all its coordinates from a `PlotGeometry`.
- [alertsApi.ts](../src/lib/graphs/alertsApi.ts) — `/performance/alertsummary/`, and
  the schemas for it. [alerts.ts](../src/lib/graphs/alerts.ts) — **pure**. Summaries →
  the marks the graph draws and the facts the pane prints. See "Alerts" above.
- [changes.ts](../src/lib/graphs/changes.ts) — **pure**. Segmentation and the
  confirmation test; a series' pushes → the steps in it. See "Detected changes".
- [annotations.ts](../src/lib/graphs/annotations.ts) — **pure**. The marks in the
  plot's margins: row packing, pixel layout and hit tests for both the alert
  triangles and the change bars. Both of its layouts are computed once by
  ScatterChart and read by the draw call, the overlay and the hit test alike.
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
- [SeriesList.svelte](../src/lib/graphs/SeriesList.svelte),
  [GraphPane.svelte](../src/lib/graphs/GraphPane.svelte),
  [DetailsPane.svelte](../src/lib/graphs/DetailsPane.svelte) — the three panes.
  The details pane delegates its comparison card to
  [ComparisonSection.svelte](../src/lib/graphs/ComparisonSection.svelte) and
  shares its text styles with it through
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
| `sel` | Selected point, `<repo>,<signatureId>,<datumId>,<replicateIndex>`. A `replicateIndex` of `-1` (`MEAN_REPLICATE`) means the run's *mean* rather than one of its replicates — what a click selects while `reps=0` |
| `cmp` | Pinned comparison point, same shape as `sel`; set by shift-clicking a dot. Only written alongside a `sel`, since a comparison needs two ends. See [comparison.md](comparison.md) |
| `reps` | `0` to draw one dot per run at its mean instead of every replicate. Omitted when on, which is the default |
| `cd` | `0` to stop drawing the steps this app detects for itself. Omitted when on, which is the default — see "Detected changes" |
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
