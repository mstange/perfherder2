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

## Next

- [ ] A full repaint of the detail graph at 100k+ dots takes ~60ms, which is
      one dropped frame on a discrete action like resetting the zoom.
      Decimating the overview by pixel column would be the first thing to
      try if that starts to matter.

## Open questions / deferred

- **Mixed units on one y-axis.** Following treeherder for now; the axis says
  "mixed units" when it happens. A per-series normalized mode ("% of the
  first value") would be the real fix.
- **Alert markers.** Treeherder highlights alert summaries on the graph and
  can create alerts from the tooltip. Not implemented; the create path needs
  auth, the display path needs `/performance/alertsummary/`.
- **Retrigger / delta-vs-previous readouts.** Treeherder's tooltip shows the
  delta from the previous data point and a retrigger count. We show the
  retrigger count; the delta is not implemented.
- **History granularity.** Every discrete action pushes a history entry; a
  zoom drag and everything inside the Add-series panel replace. Whether that's
  the right granularity (should a repo toggle in the picker be undoable?) is
  untested with real use.
- **Data volume.** No cap on how many series can be added; a 90-day range
  across 10 series with replicates may be tens of MB and hundreds of
  thousands of dots. Drawing is batched but not decimated. Measure before
  optimizing.
- **Picker state a link still can't carry.** Its filter, repos, interval,
  subtest mode and sort now round-trip (see "URL state" in graphs.md), but the
  scroll position, which rows are expanded, and which rows are checked-but-not-
  yet-added do not. Expansion is the interesting one: it's a `Map` keyed by
  `Series.key`, so it *could* be serialized, but a link that reopens on a
  half-expanded tree seems more confusing than useful. The pending check set
  deliberately doesn't persist — a shared link should not arrive with an
  un-pressed "Add 4".
