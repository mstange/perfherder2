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

- `bin/perfherder-cli`, a CLI over the same modules — `src/cli/` (+ tests for its
  pure halves), built by `vite.cli.config.ts`. Commands mirroring the
  UI: `search`, `series`, `changes`, `compare`, `commits`, `url`. It adds two
  things the app doesn't have, both because a CLI has no reader to lend a
  picture to: `modes.ts`, which says in words whether the modes moved or their
  weights did, and `step`, which measures a change at a point the caller names
  and reports which of the detector's bars a real-but-unmarked move failed —
  the question a quiet graph on an under-sampled platform raises and `changes`
  cannot answer. See [cli.md](cli.md)

- The CLI, published. `perfherder-cli/` is a package of its own — the
  profiler repository's arrangement for `profiler-cli` — so `npm publish
  perfherder-cli/` ships the tool without shipping the app or versioning the two
  together. The bundle carries its version, and `verify-cli-build.mjs` refuses to
  publish one that does not match, since the output is gitignored and only the
  wrapper rebuilds it. Links now default to the deployed app rather than to a dev
  server nobody else is running. See cli.md, "The published package"

- The eight gaps a four-session live trial of the CLI found, closed. Three were
  output defects — a sparkline with no scale, `step` printing percentages but no
  absolute Δ, and direction stated in a header that by construction cannot carry
  it. Three were missing capability: `siblings.ts` and `--like` / `--across` for
  the horizontal slice that `--parent` had no inverse of, `compare --pool` for a
  mode analysis resting on more than one push's replicates, and `locate` for
  "which of these pushes is the step on", which ranks every split in a window by
  `boundaryCandidates` — the detector's own criterion, newly exported — and marks
  the row perfherder alerted on. One was robustness: a failed fetch is now a row
  rather than the end of the run. And one was a vocabulary problem in the data
  rather than in the docs, `suggest.ts`, which answers `indexeddb` with `idb`.
  See [cli.md](cli.md), "What four fresh sessions found"

- The bars of the loaded series, grouped into the landings that caused them, and
  said in the pane: **Same landing — "seen in 9 of 9 plotted series · pinned to
  one push"**, the window, and one clickable row per member. `cluster.ts` moved
  from `src/cli` to `src/lib/graphs/` (dependencies run `src/cli` → `src/lib` and
  never back) and grew `barEvents`, so the app and `changes --cluster` group the
  same way and word a window the same way. Verified against production: the block
  and the CLI report the same nine members and the same "pinned to one push" for
  bug 1899194's landing. See graphs.md, "One landing, not nine bars".

  The cost argument is the one under "Common alerts — decided against" below,
  coming out the other way: that feature needed 29 MB of alert summaries to ask
  "who else moved on this push", while for the series already plotted the changes
  are computed, the push times are in memory, and the grouping is arithmetic.

- The two marks in the plot's margins say what they are on hover — direction and
  signed percentage, the values with the window they are over, an alert's triage
  states and bug or a change's p-value and effect size, and which series when more
  than one is plotted. `graphTooltip.ts` (+ tests) for the wording,
  `shared/tooltip.ts` (+ tests), `tooltipState.svelte.ts` and `Tooltip.svelte` for
  the box, which follows the pointer and flips at the viewport's edges. The only
  drawn tooltip in the app: a mark is canvas and has no element to carry a
  `title`, and clicking to find out then meant hunting for the right card in the
  pane. See graphs.md, "Alerts" and "Detected changes", and design.md, "Tooltips:
  for what the canvas paints"

- Every bug a commit cites is linked in `CommitList.svelte`, not just
  `bugs[0]`. `pushlog.ts` restricts `bugs` to the summary line and says why, so
  a second entry means the summary really did name two bugs — and the CLI's
  commit table already printed them all, which made this two views of one field
  disagreeing.

- One headline shape across the three change cards, and a shorter pane.
  `ChangeHeadline.svelte` draws all three: percent first, absolute in
  parentheses, both signed arithmetically, badge for the verdict. The alert card
  was printing an unsigned magnitude beside two signed numbers — a regression on
  a higher-is-better metric read "2%" over one reading "−2 ms" — so
  `signedAmountFraction` takes the sign from the alert's own values rather than
  from `isRegression`. With it, four cuts that take the crowded case (alert,
  detected change and a pinned comparison, all on signature 5350953) from
  **2,098px to 1,546px**: two stats rows that were one number twice, a fold on
  "Values on this push" past three runs, the job type's platform prefix, and one
  `Triage` row for the two alert statuses. See graphs.md, "The three change
  cards say it the same way" and "Keeping the pane readable".

- A drift figure on the series-list card, for the series segmentation has nothing
  to say about. `drift.ts` moved from `src/cli/reports.ts` to `src/lib/graphs/`
  (cluster.ts's precedent: dependencies run `src/cli` → `src/lib` and never back),
  so the card and `series --drift` print the same two medians. The five signatures
  in the table below show **+10%, +45%, +29%, +14% and +7.7%** on their cards,
  matching the CLI figure for figure — including 5350957, the 10% regression with
  no bar and no alert that this was built for.

  Two bars keep an uninvited badge honest, both borrowed from changes.ts rather
  than invented: the detector's floor and `CHANGE_ALPHA`. And the row could not
  hold a fourth item — measured, 28 characters against the 49 a busy card wants,
  so the figure was being truncated to "+4…" — so `.sub` wraps to two clamped
  lines with both reserved, and the cards are 87px whether they use one or two.
  See graphs.md, "The drift figure, for the series with no bars".

  This closes the UI half of the three items that pointed at it below. What is
  still open is *detecting* the shape, which is a different question and is still
  parked where it was.

- The trend band: a rolling p25 / median / p75 over the drift figure's own window,
  `trend.ts` (+ tests), `trend=1`, off by default. The badge says the ends of the
  range differ; this is the shape of the path between them, and its two end medians
  *are* the badge's two numbers by construction.

  **It is quartiles rather than a moving average because the data said so.** Mode
  analysis over three of the drifting idb-open signatures found that 5350975's +45%
  is not a climb at all — its fast mode never moved (623 → 642 ms, in place) and a
  new mode at 917 ms took 67% of the runs — so a single smoothed line there would
  run through the gap between two modes, a value almost nothing ever measured. In
  all three cases the badge's percentage is about double the movement of the typical
  run. What changes in these series is the distribution's shape, which two edges can
  show and one line cannot. AWSY's `Explicit Memory` (5141330) is the case that keeps
  the median line honest: its push means sit in at least four clusters (~540, 558, 585,
  612 MB), so the median hops between them as the mixture shifts and lands in a sparse
  gap when a window splits near 50/50 — the band being wide from end to end is what
  tells the reader not to trust the middle. Its rank-statistic behaviour is also why
  the line **steps** where a moving average would glide: measured there, one push
  entering the window moves the median up to 18.6 MB against the mean's 3.5.

  Checked on four real graphs, and two things changed because of what they showed:
  the quartiles are **stroked as well as filled** (a faint fill under the series' own
  dots is invisible below ~30px of width — on 5350975 the whole finding is the two
  edges, and they could not be seen), and one shape claim in the docs was wrong until
  the picture corrected it. The four readings — floor-holds, both-edges-rise,
  narrow-and-sliding, permanently-wide — are listed in graphs.md, "The trend band".

  Names: **"band" in the code means the comparison card's density band**
  (comparison.md), which already owned the word — hence `trend.ts`, `TrendPoint`,
  `showTrend`.

- Three point modes in place of the Replicates checkbox — `replicates` / `runs` /
  `none` (`AppState.pointMode`, `pts=`, a button group in the header). The band's
  companion: it is drawn under every dot of every series, and on the
  128m_encrypt/decrypt pair the dots' outliers scale the axis to ~45k–115k where
  the band lives in ~64k–72k. So `none` drops the dots *and* the connecting line,
  and the y axis follows what is drawn — `extentOf` measures the band instead
  (`trendExtent`, over exactly the vertices `trendSpan` gives the drawing), which
  is ~7× the vertical resolution on that pair. Hit-testing goes off with the ink,
  the selection survives, and the detail graph explains itself when the dots are
  off with no band on. See graphs.md, "Replicates".

- The graph header rebuilt as two labelled groups, `RANGE` and `SHOW`, sharing the
  picker's control-block idiom (`.control-*` in app.css) and its rule for which row
  a control belongs on: what loads against what shows. Free at wide widths, ~30px
  taller between 1280 and 980, and it no longer overflows its own pane at the
  narrow end — measured table in graphs.md, "The header is two groups".

## Next

- [ ] **File the treeherder bug for `/performance/alertsummary/<id>/`.** Its
      batched queries were only ever wired into `list()`, so the detail route does
      several sequential queries per alert and costs ~30 ms each: 2.7 s at 94
      alerts, 18.9 s at 636. This app no longer waits on it — `fetchAlertSummary`
      goes through `?id=` instead, which is 12x faster for byte-identical content
      — so this is somebody else's win to collect, not a blocker here. The
      write-up with the measurements and the query analysis is in the treeherder
      checkout as `proposal-alertsummary-detail-perf.md`. Landing it would not
      change any code here: `list()` is where the batching lives and where future
      batching will be added, so `?id=` stays the right route.

- [ ] **The alerts list request is now the floor on marker latency**, at
      1.0–1.5 s per plotted signature. It cannot be narrowed with the parameters
      that exist: each summary arrives carrying every other signature's alerts
      (548 of them for the one signature we asked about on 5825019), and there is
      no way to ask for less. Attacking it needs a new endpoint, which is the same
      conclusion the "who else alerted on this push" note below reached from the
      other direction — see the `getCommonAlerts` entry in "Open questions".

- [ ] **A selection outside the band is invisible in `points: None`.** The axis
      covers the band there, so a selected run mean above p75 or below p25 has its
      ring clipped at the plot edge while the details pane goes on describing it.
      `selectionInView` only asks about x, so nothing says so. Two candidate fixes
      and neither is obviously right: union the selected value into the domain (an
      axis that moves when you select), or extend `selectionInView` to y and let
      the pane say "outside the band" (a fourth reason a selection can be off
      screen, in a pane that already explains two). Reachable only by keyboard or a
      link, since nothing in that mode is clickable.

- [ ] **The band's curves do not say what they are.** Nothing on the plot states the
      window is 24 pushes, or that the middle line is a rolling *median* rather than
      a fit or a moving average. The checkbox tooltip now says both, and the first
      person to use the feature still asked "what is that line?" — with two correct
      observations attached (on AWSY it sits on neither visible band, and it reacts
      too fast for a moving average) that took a histogram of push means and a
      median-vs-mean comparison to answer. A feature whose first question needs an
      offline analysis to answer is under-labelled. The answers are now in graphs.md,
      "The median line is the least trustworthy of the three", but a doc is not where
      that reader was.

      **A hover readout is the obvious form**: at the pointer's push, something like
      *"median 564.4 MB · middle half 559.0–575.9 · over 24 pushes"*. It would make
      the curves self-describing, and it is the one place the window size can be
      stated without adding another control.

      **Where it goes is now settled, and this is the remaining work.** The tension
      this item recorded — that a tooltip for the band would be the graph's first —
      is gone: the canvas has a tooltip layer (design.md, "Tooltips: for what the
      canvas paints"), the alert triangles and the change bars use it, and the
      marks' wording lives in `graphTooltip.ts` beside where the band's would. So the decision left is not
      *whether* to open a box on the plot but what the band's hit test is: unlike a
      triangle or a bar, the band has no target — the readout is about the pointer's
      *column*, at every x, which is the one thing the marks' tooltips
      deliberately are not (a dot gets no tooltip, because the details pane already
      describes it). The shape to work out is how a column readout coexists with the
      hover preview the pane draws for the dot under the same pointer.

- [ ] **A graph of subtests opens the picker on collapsed parents.** Plot two
      `perf_reftest_singletons` subtests, then "Derive filter": the filter is
      right and the list is one collapsed `perf_reftest_singletons` row per repo,
      with the siblings you wanted behind the disclosure caret and no swatch to
      show that two of its children are already plotted. The filter can't fix
      this — the parents carry the same suite, platform and options, so they
      match it on their own — and neither can `matchSubtests`, which only
      auto-expands parents that qualified *via* a child (`filterResult` in
      `pickerState.svelte.ts`). What fits is expanding a parent that *has* a
      plotted child, and marking it: `plotted` is keyed by `Series.key`, and
      `childrenByParent` already relates the two, but only once the subtests=1
      payload is in — so this also has to decide whether the graph's context
      alone is enough reason to pull it. Reported as "the filter isn't prefilled
      because they're all subtests"; the prefill was a separate bug, now fixed,
      and this is the half of the complaint that survives it.

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
  span instead of six notches.

  **The "way to say it in the UI" this was parked behind now exists twice** — the
  drift badge, which states the figure without claiming to know the shape, and the
  trend band, which shows the shape without naming it (both under Done). What is
  still open is the *detection*: the bars are unchanged, so signature 5350963 still
  shows five notches for one net climb, and a reader now gets "+14% drift" and a
  rising band beside them rather than instead of them.

  Two things the band changed about this item. It is now cheap to *see* whether a
  window is a slope or a staircase, which is the input a slope fit would need anyway
  — so the fit, if it happens, can be checked against a picture. And the shape it
  reveals in the four macOS rows is not the clean ramp this item assumed: 5350975's
  band fans open rather than sliding, because a second mode arrived. A slope fitted
  to that would report a ramp that never happened, so "recognise the shape" has to
  mean at least three shapes — ramp, widening, staircase — not two.

  **It is no longer only synthetic — load these.** A six-month CLI trial over the
  idb-open family found every one of twelve signatures slower at the end of the
  window than the start — +7.7% to +45%, each at p < 0.01 — and the four macOS rows
  below are the shape in real data. Each URL opens this app on the window the
  figures were measured over (2026-02-11 → 2026-08-10, absolute, so they stay
  pointed at it until treeherder expires the runs about a year after the run).
  Drift is `series --drift`: medians of 24 pushes at each end, the window
  `changes.ts` already exports.

  | Graph | Drift over the range | Bars | What it shows |
  | --- | --- | --- | --- |
  | [5350957 — idb-open-many-seq `time_duration`, macOS](https://perfherder2.netlify.app/?series=autoland,5350957,13&range=1770768000000,1786320000000) | 6,326 → 6,978 ms, **+10%**, p < 0.001 | **0** | The witness for "gradual drift is invisible by construction" below. 1,158 pushes, a climb visible in the sparkline, and **neither a bar nor a perfherder alert anywhere in six months.** A 10% regression that neither this app's detector nor perfherder says one word about |
  | [5350975 — idb-open-few-seq `time_duration`, macOS](https://perfherder2.netlify.app/?series=autoland,5350975,13&range=1770768000000,1786320000000) | 622 → 900 ms, **+45%**, p < 0.001 | 1 | The largest of the twelve, and the mixed case: one bar, the +27% step on 2026-07-14, and a further **+14% left over as slope** with no bar anywhere. Drift and steps are not alternatives — this series has both and only one of them is on screen |
  | [5350972 — idb-open-few-par `time_duration`, macOS](https://perfherder2.netlify.app/?series=autoland,5350972,13&range=1770768000000,1786320000000) | 702 → 902 ms, **+29%**, p 0.005 | 1 | The same split again: one bar of +16% on 2026-07-22, +11% unaccounted. Its p of 0.005 is the weakest of the four, which is the honest part — a slope this gradual is near the edge of what two windows can establish |
  | [5350963 — idb-open-many-par `time_duration`, macOS](https://perfherder2.netlify.app/?series=autoland,5350963,13&range=1770768000000,1786320000000) | 27,817 → 31,796 ms, **+14%**, p < 0.001 | **5** | *This* is "a run of steps": +2.5%, +5.3%, +5.6%, −7.0%, +6.4% between March and August — five notches, one of them backwards, for one net climb, and no single one of them the event |
  | [all four together](https://perfherder2.netlify.app/?series=autoland,5350957,13&series=autoland,5350975,13&series=autoland,5350972,13&series=autoland,5350963,13&range=1770768000000,1786320000000) | — | — | The family drifting in parallel, which is the reading no per-series view gives |

  For contrast, and worth loading beside them so the distinction stays sharp:
  [5691620 — the same many-par test on Linux](https://perfherder2.netlify.app/?series=autoland,5691620,13&range=1770768000000,1786320000000)
  drifts +7.7% over the same window, and it is **not** the same shape — its
  sparkline is flat, then steps, then flat, and its two bars (+3.0% and +7.1%,
  the second carrying alert #50971 / bug 2048556) between them account for the
  whole of it. Segmentation is right about that one. The question is only what to
  do about the four above it.

  **`series --drift` was the candidate answer to "a way to say it", and the
  framing survived**: two medians, both windows' dates printed, and a p-value
  labelled as saying the ends differ rather than that anything stepped. It is now
  also the badge on the series-list card, which was the UI form predicted here —
  a figure next to the change count, not another line on a plot that already draws
  every replicate. The five rows above are the fixture it was checked against, so
  load them again before changing anything in `drift.ts`.
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
    The +2.0% macOS step is exactly what they are tuned to keep. **And for the
    siblings the user has loaded, the pane's Landing block answers the rest of
    it** — "seen in 9 of 9 plotted series" — for the same nothing, since those
    series' changes are already computed (graphs.md, "One landing, not nine
    bars").
- **Detected changes: what's left.** The detector and its bars are done (see
  graphs.md); five things it doesn't do.
  - *A landing is only visible after a click.* The pane says "seen in 9 of 9
    plotted series" once a bar is selected; the graph itself gives no sign that
    nine bars in a column are one event until then. Highlighting the other
    members when one is hovered or selected is the obvious form — a third `kind`
    in `drawChangeHighlight`, and the hits are already in `landings`. It is left
    for now because a selected bar already runs a full-height guide up its
    column, and at the zooms where a landing is interesting the members sit in
    that column: the marginal thing the highlight adds is small next to a third
    kind of bar decoration to keep in step with the other two.
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
  - *Gradual drift is invisible to the bars by construction — but no longer to the
    UI.* Segmentation looks for steps, so a series that slides 8% over three months
    has no step in it and gets no bar. That is still true and still honest. What has
    changed is that it is no longer silent: the series-list card carries a drift
    figure (see Done), so signature 5350957 — 10% over six months and 1,158 pushes
    with zero bars and zero perfherder alerts — now says "+10% drift" on its card
    where it used to say only "1,161 points". It is the first row of the table under
    "A smooth drift is reported as a run of steps" above. Load it before reasoning
    about this one.
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

  **It came up, and what shipped is not a moving average — deliberately.** Twelve of
  twelve idb-open signatures drifted over six months, four of them shown in the table
  under "A smooth drift is reported as a run of steps", and one of those is a 10%
  regression with no bar and no alert. That was the condition this item was parked
  behind. Two things then shipped instead of the three menu items perf.webkit.org
  has: the drift badge, which costs no control and no ink, and the trend band, which
  is the *shape* — both under Done.

  **The moving averages are now not-doing rather than deferred.** The mode analysis
  recorded in the band's Done entry is the argument: on a series whose slow mode is
  taking over, a mean or an EMA draws a confident line through the gap between two
  modes, and on a series that alternates push-by-push it draws one through the empty
  middle. A quartile band degrades gracefully in both cases — it gets wide, which is
  the honest report. If someone still wants a single line after using the band, the
  cheap version is to draw the band's median alone, which already exists; adding
  simple/cumulative/exponential variants of a statistic we have reason to distrust
  would be three more ways to say the same wrong thing.
- **Retrigger / delta-vs-previous readouts.** Treeherder's tooltip shows the
  delta from the previous data point and a retrigger count. We show the
  retrigger count, and hovering any dot gives the delta against the *selected*
  point rather than against the previous one. "What changed here" is now one
  click — the pane's "Compare with the previous push", or <kbd>P</kbd> on the
  graph (see comparison.md) — which answers it with the whole comparison card
  rather than a single number in a tooltip. What's still missing is the delta
  *without* selecting anything. A tooltip is no longer the obstacle it was when
  this was written — the canvas has a layer now, and the marks use it — but the reason
  to decline it stands: a box that opened on every dot the pointer crossed would
  cover the plot it is about, and the pane's hover preview is the same answer with
  room to be a distribution. It is the band's column readout (above) that would
  settle the shape of a per-push box, and this would follow that, not lead it.
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
