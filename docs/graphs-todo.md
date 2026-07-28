# Graphs view — implementation status

Living checklist. Update in the same commit as the work it describes.

## Done

_(nothing yet)_

## In progress

- [ ] `graphApi.ts` — summary / push / job fetches

## Planned

- [ ] `graphData.ts` — flat API rows → push/run/replicate structure (+ tests)
- [ ] `chart.ts` — scales, tick generation, y-domain, hit-testing (+ tests)
- [ ] `palette.ts` — series color assignment
- [ ] `urlState.ts` — parse/serialize the whole view state (+ tests)
- [ ] `appState.svelte.ts` — reactive app state, fetch orchestration
- [ ] Three-pane shell; Add-series picker becomes an overlay
- [ ] `ScatterChart.svelte` — canvas detail graph, axes, lines
- [ ] Overview graph + brush-to-zoom
- [ ] Click-to-select + right-hand details pane
- [ ] URL sync both directions
- [ ] Relative time-range control that bakes absolute bounds into the URL

## Open questions / deferred

- **Mixed units on one y-axis.** Following treeherder for now. A per-series
  normalized mode ("% of first value") would be the obvious fix.
- **Alert markers.** Treeherder highlights alert summaries on the graph and
  can create alerts from the tooltip. Not implemented; needs auth for the
  create path, and the display path needs `/performance/alertsummary/`.
- **Series visibility toggle** (treeherder's legend cards can hide a series
  without removing it). Planned but not in the first cut.
- **Retrigger count / delta vs previous point** — treeherder shows these in
  the tooltip. Candidates for the details pane later.
- **Data volume.** No cap on how many series can be added; a 90-day range
  across 10 series with replicates may be tens of MB. Measure before
  optimizing.
