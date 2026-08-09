# Graphs view — implementation status

Living checklist. Update in the same commit as the work it describes.

## Done

- `graphApi.ts` — summary / push / job / repository fetches
- `graphData.ts` — flat API rows → push/run/replicate structure (+ tests)
- `chart.ts` — scales, ticks, y-domain, plot geometry, hit-testing (+ tests)
- `chartDraw.ts` — canvas painting (grid, axes, run lines, dots, brush)
- `timeRange.ts` — presets ↔ absolute bounds (+ tests)
- `urlState.ts` — parse/serialize the whole view state (+ tests)
- `appState.svelte.ts` — reactive state, fetch orchestration, URL sync
- Three-pane shell; Add-series picker as a lazily-mounted overlay
- `ScatterChart.svelte` — one canvas component for both graphs
- Overview graph with brush-to-zoom (create / move / resize the window)
- Detail graph: drag to zoom, double-click to reset, click to select
- `DetailsPane.svelte` — value / push values / run / build, with external links.
  See graphs.md, "The details pane, top to bottom", for the order
- URL sync both directions, including back-button support
- Keyboard navigation (arrow keys walk runs and replicates), hover feedback,
  and a focusable detail graph
- Layered canvases: dots on one, brush + selection ring on another, so a
  zoom drag repaints only the cheap layer
- Bounded caches with request cancellation; failed fetches surface a banner
  with Retry instead of retrying in a loop
- Modal behaviour for the picker overlay (inert background, backdrop click,
  focus restore)
- Unit tests for the reactive state (see docs/design.md → Testing)
- Per-series visibility (the eye button on each card), carried in the URL
- Drag-to-reorder in the series list, with the ↑/↓ buttons as the
  keyboard-reachable equivalent
- Run activity in the picker — a per-row run count and density strip over the
  selected time range, fetched in batches for the visible window only
  (`activity.ts`, `activityApi.ts`, + tests). See design.md, "Run activity is
  fetched for the visible window only"
- Translucent, horizontally jittered dots, so a dense replicate cloud reads as
  density instead of as a vertical line (`chart.ts` "Jitter",
  `graphData.ts::pointJitter`, + tests). See graphs.md, "Dots are translucent, and
  jittered sideways"
- Alert markers on the detail graph, an alert card in the details pane, and a
  per-series count in the list — `alertsApi.ts`, `alerts.ts` (+ tests). See
  graphs.md, "Alerts"
- Push value distributions and comparison mode — `kde.ts`, `stats.ts`,
  `distribution.ts`, `distributionDraw.ts`, `compare.ts`,
  `DistributionChart.svelte` (+ tests for all the pure halves). See
  [comparison.md](comparison.md)
- Client-side change detection — `changes.ts` (+ tests). Drawn as bars along the
  plot floor, clicking one sets up the comparison, and the details pane gets a
  Detected-change card. On by default, `cd=0` to turn it off. See graphs.md,
  "Detected changes"
- Marks in the plot's margins stack into rows instead of overlapping —
  `annotations.ts` (+ tests), shared by the change bars and the alert triangles.
  Closes the alert-marker half of the item that used to be under "Alerts: the
  parts still missing"
- Change detection in three stages — local proposal (binary segmentation
  against a scale estimated inside each stretch), greedy confirmation where only an
  accepted change walls off a pool, and rank relocation of the accepted index. Closes
  both of the items that used to be under "Open questions": the wall rule and local
  candidate generation. What it bought, measured: signature 5352791's step at push
  1966248 (perfherder alert #243130) is found where the dynamic program covered 460
  pushes with one segment, a fenced-off outlier can no longer silence the step beside
  it, a regression and its backout confirm each other, nothing appears on 40
  synthetic flat series, and 2000 pushes cost 8.9 ms against 33. See graphs.md,
  "Three stages", and the constants in changes.ts

- The commit list for a pinned comparison, inline in the card — `pushlog.ts` (+
  tests) and `fetchPushRange`. Collapsed with the count in the summary, fetched
  on pin so the count is there to show, pinned-only so a hover doesn't fetch a
  range per dot. See [comparison.md](comparison.md), "The inline pushlog"

- `bin/perfherder`, a CLI over the same modules — `src/cli/` (+ tests for its
  four pure halves), built by `vite.cli.config.ts`. Six commands mirroring the
  UI: `search`, `series`, `changes`, `compare`, `commits`, `url`. It adds two
  things the app doesn't have, both because a CLI has no reader to lend a
  picture to: `modes.ts`, which says in words whether the modes moved or their
  weights did, and `step`, which measures a change at a point the caller names
  and reports which of the detector's bars a real-but-unmarked move failed —
  the question a quiet graph on an under-sampled platform raises and `changes`
  cannot answer. See [cli.md](cli.md)

## Next

- [ ] A full repaint of the detail graph at 100k+ dots takes ~60ms, which is
      one dropped frame on a discrete action like resetting the zoom.
      Decimating the overview by pixel column would be the first thing to
      try if that starts to matter.

## Open questions / deferred

- **A smooth drift is reported as a run of steps.** Measured over 40 synthetic
  series of 500 pushes with a 4% linear climb and 0.8% noise: 32 bars, and 159 for a
  10% climb. Every one of them is a real, confirmed level difference between the
  pushes either side, so this is not a false-positive problem to tighten α against —
  it is that "where did it step" is the wrong question for a series that never
  stepped. The old dynamic program did the same thing (22 bars on the same fixture),
  so this is longstanding rather than new. What would fix it is recognising the shape
  instead of marking it: fit a slope to the window, and where a line explains the
  window about as well as a step does, say "drifting +4% over 30 pushes" and draw one
  span instead of six notches. Wants a way to say that in the UI before it is worth
  detecting.
- **Index replicates by trial number once the API exposes one.**
  [Bug 1981623](https://bugzilla.mozilla.org/show_bug.cgi?id=1981623) tracks
  using the run numbers and machine identifiers the replicates/trials table
  already carries. Until they reach the summary endpoint there is no trial order
  to show or to store, so `Run.values` is sorted and `replicateIndex` is a rank
  (see graphs.md, "The three-level hierarchy"). Indexing by trial number would
  be stable *and* meaningful, and would let the pane list a run's values in
  measurement order — the interesting order, since the first trial of a
  browsertime run is routinely the slow one. The machine identifiers would also
  make "is this retrigger on a different machine" answerable, which is currently
  a guess from the job's `machine_name` alone.
- **One `fill()` per dot instead of the eight interleaved paths.** The dots are
  split across `DOT_PATHS` paths so overlapping ones accumulate their alpha (see
  graphs.md, "Dots are translucent, and jittered sideways"); a fill per dot would
  do the same thing exactly rather than approximately and delete the concept. The
  expectation is that it's fine: measured headless, over 111k dots, per-dot came out
  at 69ms against 66ms for eight paths, inside the noise. That environment
  rasterizes in software, though, so it can't see the per-draw-call overhead the
  batching was introduced to avoid. **What's needed is one repaint measured on real
  hardware at 100k+ dots**; if it holds, simplify.
- **A compressed density scale, for the hovers headroom can't cover.** The band's
  y scale is shared between the two sides and now has headroom above the selected
  pool's peak (see comparison.md), which holds it still for roughly two thirds of
  hovers. It does nothing for the tail: a hovered push that is one tight run peaks
  16–20× higher than a 60-value selected pool, and the selected curve is then a
  smear along the floor. A sqrt (or log) density scale would compress that 20× to
  4.5× and bound the squash, and the reason not to reach for it yet is that height
  currently means spread in plain proportion — both curves integrate to 1 — and a
  compressed axis keeps the ordering while quietly changing what the picture
  claims. If it turns out the tail hurts more than the proportion helps, this is
  the fix.
- **The comparison card's remaining hover movement.** Beyond the density tail
  above, two known ones, neither seen in the wild yet: the legend's detail line
  wraps to a second line for a multi-modal pool ("modes A … B … C …"), which moves
  everything below it by 14px per side; and the verdict badge appears and
  disappears between hovers, which is inline and so only bites at a narrow pane
  width. A sweep of 40 hovers over two real series found neither, so this is
  waiting for a case that shows it.
- **Mixed units on one y-axis.** Following treeherder for now; the axis says
  "mixed units" when it happens. A per-series normalized mode ("% of the
  first value") would be the real fix.
- **Alert markers: the parts still missing.** The display path is done (see
  graphs.md, "Alerts"): markers on the detail graph, a card in the pane, a count
  in the series list, and the markers are clickable — a click selects the
  alerted push and pins `prev_push_id` as the comparison. Not done, and each
  needs something we don't have:
  - *Creating and triaging* alerts from the graph — needs an authenticated
    session.
  - *Common alerts — **decided against**, and now largely moot.* Treeherder also
    marks pushes where some **other** series in the framework alerted. The case
    for it was real: plotting idb-open-many-seq `open_duration` on macOS
    (signature 5350956) over a year shows nothing, while its Windows counterpart
    (5350953) carries alert #51136 for the very same push — the change hit both
    platforms, but macOS moved +2.0% against Windows' +9.9% and never crossed
    the threshold, so only Windows has an alert of its own.

    What killed it is the cost, measured rather than assumed. There is no
    push-id filter on `/performance/alertsummary/` (unknown parameters are
    silently ignored, so a probe returns the unfiltered count), and
    `alerts__series_signature` takes one id — repeating it keeps the last, and a
    comma list is a 400. So "who else alerted here" can only be answered by
    pulling the framework's summaries: **2,428 of them for framework 13 over a
    year, ~29 MB across 25 pages at ~17 s a page**. Treeherder's own
    `getCommonAlerts` dodges that by fetching a single `limit=30` page, which
    over a long range covers the last few weeks and silently misses the rest —
    a partial answer that looks like a complete one.

    A marker therefore keeps its narrow meaning: *perfherder alerted on this
    series*. What has changed since is that the underlying question — "this
    series moved here and nobody said so" — is now answered directly by the
    detected-change bars, which cost one local dynamic program rather than 29 MB
    and answer it for the series in front of you rather than for its siblings.
    The +2.0% macOS step is exactly what they are tuned to keep.
- **Detected changes: what's left.** The detector and its bars are done (see
  graphs.md); four things it doesn't do.
  - *No keyboard path.* Alerts have <kbd>A</kbd> / <kbd>shift-A</kbd> to step
    between them; the bars are pointer-only. The same stepper over
    `visibleChanges` would be a few lines, and the reason it isn't there yet is
    that <kbd>A</kbd>'s meaning would have to widen to "next finding, of either
    kind" or the two would need separate keys for what is one gesture to a user.
  - *No label on the bar.* perf.webkit.org writes "Potential 3.24% regression"
    into its annotation bar. Ours carries no text, so the percentage is only
    reachable by clicking. Drawing it when it fits is easy; deciding what a bar
    too narrow for it should do — nothing, an ellipsis, a wider bar — is the
    part that needs a decision, and a bar that sometimes has a label reads as a
    different kind of mark from one that never does.
  - *False positives: field-checked, not counted.* α = 0.01 and the floor (0.5%
    at the time; now a quarter of the signature's own alerting threshold, which
    is the same 0.5% wherever perfherder declares nothing — see "The floor comes
    from the signature" in graphs.md)
    were chosen from first principles and one synthetic sweep. What exists now
    instead of the census that was planned is regular use over real graphs, which
    reports: the bars mostly look reasonable; where a bar and a perfherder alert
    describe the same event **the bar has the tighter push range**, which is the
    locality the three-stage rewrite was for and is the clearest evidence it paid
    off; an alert with no bar happens but is rare; and a bar with no alert is
    common and *usually explained by an outlier*.

    This is qualitative — nobody has a numerator and denominator — but it answers
    the decision the count was for: **the constants stay and the default stays
    on.** A census would now only refine numbers nothing is waiting on.

    What it redirects effort to is the outlier mode, which is no longer a
    hypothetical: see "A push is summarised by its mean" below.
  - *Gradual drift is invisible by construction.* Segmentation looks for steps.
    A series that slides 8% over three months has no step in it and gets no bar,
    which is honest but is also the case a trend line would answer — see the
    next item.
- **A push is summarised by its mean.** `values = pushes.map(p => p.mean)`
  ([changes.ts](../src/lib/graphs/changes.ts)), and `push.mean` is the mean of its
  runs' means, each of which is the mean of its replicates. Two comments in
  changes.ts already call this the weak point — the module header ("a single bad
  run can still drag it, which is an argument for summarising a push more
  robustly, not for unpooling") and `relocateBoundary` ("still a mean, and a single
  bad push still pulls it") — and field use now reports the same thing from the
  other end, as the usual explanation for a bar with no alert.

  Three places a mean enters, and they are not equally entangled:

  - *The reported percentage.* `confirm()` takes `mean(before)` against
    `mean(after)`, so one outlier push in a pool inflates the number on the card.
    A median here is a contained change: it moves the printed delta and the
    `clearsFloor` comparison, and nothing else reads it.
  - *The detector's input.* Swapping in a robust push summary is the change that
    would actually remove bars, and it is the one with a coupling problem:
    `push.mean` is also the y the connecting line joins
    ([chartDraw.ts](../src/lib/graphs/chartDraw.ts), the edge interpolation in
    `appState`) and the value the pane prints. A detector on medians and a line on
    means means a bar can sit where the line looks flat, which is the confusion
    this would be trying to remove.
  - *`run.mean` over replicates.* The least controversial in principle — the
    module header calls replicates "repeated measurements of one number" — and the
    one with a documented systematic outlier, since the first trial of a
    browsertime run is routinely the slow one (see the trial-number item below).
    A constant bias creates no steps, so this only matters where the replicate
    count changes; whether that happens often enough to make bars is unmeasured
    and would be the thing to check first.

  Unresolved, and it decides the shape: whether the outlier bars sit *on* the
  outlier push (the detector was fooled, and a robust summary deletes them) or
  are real level changes an outlier merely pushed over the threshold (a robust
  summary moves the number and keeps the bar).
- **Trend lines.** perf.webkit.org's chart offers simple, cumulative and
  exponential moving averages alongside its segmentation, from one menu
  (`chart-pane.js::ChartTrendLineTypes`). We took the segmentation and left
  those. They are perhaps twenty lines each and would answer the drift case the
  bars can't, at the cost of another control and another line on a plot that
  already draws every replicate. Worth it only if the drift case comes up.
- **Retrigger / delta-vs-previous readouts.** Treeherder's tooltip shows the
  delta from the previous data point and a retrigger count. We show the
  retrigger count, and hovering any dot gives the delta against the *selected*
  point rather than against the previous one. "What changed here" is now one
  click — the pane's "Compare with the previous push", or <kbd>P</kbd> on the
  graph (see comparison.md) — which answers it with the whole comparison card
  rather than a single number in a tooltip. What's still missing is the delta
  *without* selecting anything, which would mean a tooltip we don't have.
- **History granularity.** Every discrete action pushes a history entry; a
  zoom drag and everything inside the Add-series panel replace. Whether that's
  the right granularity (should a repo toggle in the picker be undoable?) is
  untested with real use.
- **Data volume.** No cap on how many series can be added; a 90-day range
  across 10 series with replicates may be tens of MB and hundreds of
  thousands of dots. Drawing is batched but not decimated. Measure before
  optimizing.
- **A bootstrap confidence interval for the median difference.** PerfCompare
  computes a BCa interval (`src/utils/bootstrap-ci.ts`, seeded, so
  deterministic) and it's the number that best answers "how sure are we". Left
  out for now: 9999 resamples × two medians is tens of milliseconds, which is
  fine for a pinned comparison and not for the hover preview, so it needs a
  split between cheap and full statistics that nothing else currently wants.
- **Comparing more than two points.** The `cmp` parameter holds one. Three or
  more would want a table rather than a card, and it isn't clear anyone wants
  it.
- **Picker state a link still can't carry.** Its filter, repos, interval,
  subtest mode and sort now round-trip (see "URL state" in graphs.md), but the
  scroll position, which rows are expanded, and which rows are checked-but-not-
  yet-added do not. Expansion is the interesting one: it's a `Map` keyed by
  `Series.key`, so it *could* be serialized, but a link that reopens on a
  half-expanded tree seems more confusing than useful. The pending check set
  deliberately doesn't persist — a shared link should not arrive with an
  un-pressed "Add 4".
