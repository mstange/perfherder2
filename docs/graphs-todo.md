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
- `DetailsPane.svelte` — build / run / replicate, with external links
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
- Per-series visibility (click the swatch), carried in the URL
- Drag-to-reorder in the series list, with the ↑/↓ buttons as the
  keyboard-reachable equivalent
- Run activity in the picker — a per-row run count and density strip over the
  selected time range, fetched in batches for the visible window only
  (`activity.ts`, `activityApi.ts`, + tests). See design.md, "Run activity is
  fetched for the visible window only"
- Push value distributions and comparison mode — `kde.ts`, `stats.ts`,
  `distribution.ts`, `distributionDraw.ts`, `compare.ts`,
  `DistributionChart.svelte` (+ tests for all the pure halves). See
  [comparison.md](comparison.md)

## Next

- [ ] A full repaint of the detail graph at 100k+ dots takes ~60ms, which is
      one dropped frame on a discrete action like resetting the zoom.
      Decimating the overview by pixel column would be the first thing to
      try if that starts to matter.

## Open questions / deferred

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
- **Mixed units on one y-axis.** Following treeherder for now; the axis says
  "mixed units" when it happens. A per-series normalized mode ("% of the
  first value") would be the real fix.
- **Alert markers.** Treeherder highlights alert summaries on the graph and
  can create alerts from the tooltip. Not implemented; the create path needs
  auth, the display path needs `/performance/alertsummary/`.
- **Retrigger / delta-vs-previous readouts.** Treeherder's tooltip shows the
  delta from the previous data point and a retrigger count. We show the
  retrigger count, and hovering any dot gives the delta against the *selected*
  point rather than against the previous one — strictly more useful, but it
  doesn't answer "what changed here" with nothing selected. A one-click
  "compare with the previous push" would.
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
- **Highlighting the clicked run's contribution to a push pool.** With
  retriggers, the push distribution pools every run, and which dots came from
  the run you clicked is a question the strip could answer by shading them.
  `DistributionInput.markedIndex` would become a set.
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
