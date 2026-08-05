# Working plan: details-pane order + dot legibility

Scratch file for the current batch of work. Delete it when the last box is
ticked and the outcome has landed in [graphs.md](graphs.md) /
[comparison.md](comparison.md) / [graphs-todo.md](graphs-todo.md).

## Asked for

1. **Details pane order.** The push-distribution chart should sit near the top.
   The replicate list should cover *every* job on the push, grouped by job.
   The pushlog stays near the bottom.
2. **The job status ("success") is not important.** Either drop it or push it
   far down its list.
3. **Dots need partial transparency** so a dense cloud reads as density, plus
   **horizontal jitter** — scaled by the distance between consecutive pushes —
   so replicates of one run stop being a vertical line.

## Plan

- [x] `graphData.ts::replicateGroups` — pure: a push's runs, each with the
      selected replicate marked. + test.
- [x] `DetailsPane.svelte` — new section order; replicate chips per job;
      `Result` demoted to the end of the Run list.
- [x] Dot alpha + jitter, pure half: `SeriesPoint.jitter`, `pointJitter`,
      `chart.ts::jitterAmplitudePx`. + tests.
- [x] Wire jitter through `chartDraw`, `hitTest*`, `Highlight`, `ScatterChart`,
      `GraphPane`.
- [x] Docs: graphs.md ("Rendering"), comparison.md code map if it moves.
- [x] Screenshot check in the real app (puppeteer, then uninstall).

## Notes

- Jitter is **pixel-space at draw time, from room measured in x units at build
  time**, capped at a multiple of the dot radius. Two rejected shapes, both tried:
  a pure data-space offset baked into `SeriesPoint.x` (no pixel cap, so a deep zoom
  smears one build across the plot — and it breaks the x-sorted order), and one
  amplitude per chart from the median push gap (measured on real autoland data the
  median gap is four minutes, because landings come in bursts, so every isolated
  push stayed a vertical line).
- The unit offset (`SeriesPoint.jitter`, in [-1, 1]) is stored on the point, so
  drawing, hit-testing and the selection ring all read the same number instead
  of three copies of a hash.
