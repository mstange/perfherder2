# Distributions and comparison mode

Companion to [graphs.md](graphs.md). Two features that share one piece of
machinery:

1. **Push distributions.** Selecting a dot shows, in the details pane, the
   distribution of *every* value that series recorded on that push — a kernel
   density curve with detected modes, and the raw values below it as a jittered
   strip.
2. **Comparison mode.** Shift-clicking a second dot pins it as a comparison.
   The pane then draws both distributions on one axis and adds the statistics
   and links that only make sense for a pair: Mann-Whitney U, Cliff's delta, a
   pushlog range, a perf.compare link.

Hovering a dot with a selection active shows the same comparison as an
unpinned preview.

The prior art is [PerfCompare](https://github.com/mozilla/perfcompare)'s
expandable row (`src/components/CompareResults/CommonGraph.tsx` and
`src/utils/kde*`). Both projects are MPL-2.0, so the KDE and mode-fitting
maths is a port rather than a reimplementation; the deviations are listed
under "Deviations from PerfCompare" below.

## What a distribution is *of*

The plotted dots and the distribution answer different questions, so they pool
values differently.

- **A selection with no comparison** pools **every replicate of every run of
  the selected push**. That is the answer to "how noisy is this measurement on
  this build", which is the question the push section exists to answer. It is
  deliberately *not* filtered by `showReplicates`: that flag decides what gets
  *drawn* on the time-series graph (see graphs.md), and collapsing the pool to
  one mean per run would leave a 4-value distribution where 60 real
  measurements exist. The pane says how many values came from how many runs so
  the pooling is never a guess.
- **A comparison of two pushes** pools each push the same way. This is the
  case the whole feature is shaped around.
- **A comparison of two runs of the same push** pools each *run* separately —
  the two sides would otherwise be identical, since both runs are in the same
  push pool. This is the case that doesn't fit the per-push framing, and the
  pane relabels itself accordingly.
- **A comparison of two replicates of one run** is just the two numbers, one
  value per side. Both the push and the run pool would hand the two sides the
  same values.
- **A comparison of two series on the same push** pools each series' push.

Which pool a side gets is decided in one place, `compare.ts`, so the chart, the
statistics and the labels can't disagree about what they are describing.

## Comparison kinds

Two selected points are related in one of five ways, and what the pane can
usefully say depends on which:

| Kind | Same series? | Same push? | Pools | What it answers |
|---|---|---|---|---|
| `push` | yes | no | each push | Did this change between builds? (before/after) |
| `series` | no | yes | each push | How do two configurations compare on one build? (firefox vs chrome) |
| `run` | yes | yes | each run | Do two retriggers of one build agree? |
| `replicate` | yes | same run | one value each | Just the two numbers |
| `unrelated` | no | no | each push | Neither; the pane still reports the delta and the test |

`series` requires the same repository *and* the same push id — ids are
per-repository, so two repos' "push 12345" are unrelated builds. Same trap as
`Series.key`; see design.md, "Row identity".

**Base and new are assigned, not clicked.** Base is the chronologically
earlier point — "did it get better or worse" only reads correctly in time
order, and the pushlog and perf.compare links need `fromchange` to be the
ancestor. One rule covers every kind (`compare.ts::sideOrder`: push time, then
job, then datum, then replicate index), and it degenerates to "leave them
alone" exactly where there is no time order to use: two series on one push
share a push timestamp and their runs are unordered with respect to each other,
so there `sideOrder` returns 0 and click order stands. The pane reports
`swapped` when it reordered, because otherwise "before" would silently mean
"the one you clicked second".

## Statistics

All computed client-side in `stats.ts` — treeherder's compare endpoint wants
two revisions and a framework, not two arbitrary value pools, and half the
comparisons here (two runs, two series) aren't expressible in its terms.

- **Mann-Whitney U**, normal approximation with a tie correction and a
  continuity correction. Non-parametric, so it doesn't assume the replicate
  cloud is normal — which, given the modes we go to the trouble of detecting,
  it frequently isn't. Significance is reported at α = 0.05 and the p-value is
  shown, because "not significant" on 5 replicates a side means something very
  different from "not significant" on 300.
- **Cliff's delta** — the same U, rescaled to [-1, 1]: the probability that a
  new value exceeds a base value minus the reverse. Interpreted with the
  conventional Romano thresholds (0.147 / 0.33 / 0.474 →
  negligible / small / medium / large), which is what PerfCompare's
  documentation describes.
- **CLES** (common-language effect size) — P(new < base), which is the same
  quantity again in the form "how often is new faster". Reported because it's
  the one number in the group that a non-statistician can act on.
- **Median and mean deltas**, absolute and percent. Median leads, since a
  multi-modal cloud's mean sits between its modes where no measurement is.
- **Improvement or regression** comes from the base series' `lowerIsBetter`,
  never from the sign of the delta alone — and only for the two kinds that are a
  change over *time*. Windows being slower than macOS on one build is not a
  regression, and two retriggers of one build differing is noise; labelling
  either would be a category error dressed up as a finding.
- **Nothing at all for two replicates of one job.** One value against one value
  yields p = 1 and a "large" Cliff's delta every time. The two numbers and their
  difference are the whole answer there.

Everything above is O(n log n) on pool sizes in the hundreds, which is what
makes the hover preview affordable.

## The chart

Canvas, like the time-series graphs, for the same reason the app doesn't pull
in a charting library: the existing `chart.ts` already owns scales, ticks and
value formatting, and reusing them is what keeps the two charts' numbers
formatted identically.

Layout, top to bottom, in one canvas:

```
   ╭─ density band ──────────────────────╮   KDE curve(s), filled at low alpha
   │        ╱‾╲          ╱‾╲             │   mode markers: dashed line + letter
   │   ────╯   ╰────────╯   ╰───         │
   ╰─────────────────────────────────────╯
   ╭─ strip band ────────────────────────╮   raw values, vertical jitter
   │  · ·:·· ·      ·  ·::· ·            │   one row per side
   ╰─────────────────────────────────────╯
     100      120      140      160  ms      shared value axis
```

- **Both sides share one x domain and one KDE grid.** Two curves drawn on
  separate domains cannot be compared by eye, which is the entire point.
- **The jitter is deterministic**, from a hash of the value's index, not
  `Math.random()`. A Svelte `$derived` re-runs whenever anything it reads
  changes; random jitter would make every dot jump on an unrelated state
  change. (PerfCompare hit this too and worked around it by hoisting the
  jitter into a `useMemo` keyed on the values — the same fix, expressed in a
  different framework.)
- **Mode detail goes below the chart, not on it.** The details pane is 320px
  wide; PerfCompare's on-chart labels ("Base A: 123.4 (67%)") need most of
  that each and it staggers them vertically to cope. Here the chart carries
  only the letter and the text list below carries the rest, which stays
  readable at pane width and can't collide.
- **The bands have fixed heights.** The chart occupies the same space before
  and after the values arrive, and whether there are one or two sides. See
  design.md, "Layout stability".

## Deviations from PerfCompare

- **Direct KDE evaluation, not FFT.** PerfCompare convolves on a 1024-point
  grid via a hand-rolled FFT because it also runs over subtest tables with
  large pools. A push's replicate pool is tens to a few hundred values, so a
  plain O(n·grid) Gaussian sum over a 256-point grid is well under a
  millisecond and drops ~700 lines of FFT, DCT and root-finding. If a pool
  ever reaches tens of thousands of values, revisit — that's the crossover.
- **Silverman-family bandwidth only.** With FFT went the ISJ (improved
  Sheather-Jones) bandwidth, whose iteration lives on the DCT. PerfCompare
  itself uses its Silverman-ish `approximateSJBandwidth` for exactly our case
  (sparse, non-subtest pools) on the grounds that ISJ over-fits there, so this
  costs less than it sounds.
- **Mode fitting is a faithful port** (`fitModesFromKde`, `areaFracs`,
  `argrelmax`, `assignLetters`), valley-depth threshold and all — including the
  0.5 default, so the same pool yields the same modes in both tools.
- **No knobs.** PerfCompare's expanded row carries a valley-depth slider and a
  smoothing multiplier. Both are constants here. A control that changes how
  many modes are "detected" invites turning it until the answer is the desired
  one, and the honest version of the problem it solves is the next point.
- **A pool under `MIN_CURVE_VALUES` (4) gets no curve, only the strip.** A
  density estimated from two or three values is a picture of the bandwidth rule
  rather than of the data, and drawing one implies a confidence the sample
  can't support. This is the case a smoothing slider would otherwise be reached
  for.
- **A non-negative pool's axis stops at zero.** The grid is padded by the
  kernel's practical support so curves taper to ~0 inside the plot instead of
  being cut off mid-slope, but for values small relative to that padding the
  padding alone would run the axis into negative milliseconds. Clipping at zero
  cuts the curve where the true density stops anyway.

## URL state

One new parameter, alongside `sel` (see graphs.md):

| Param | Meaning |
|---|---|
| `cmp` | Pinned comparison point, same `<repo>,<signatureId>,<datumId>,<replicateIndex>` shape as `sel` |

The hover preview is deliberately *not* in the URL: it's transient by
definition, and writing it would put a history entry (or a URL rewrite) on
every mouse movement.

`cmp` is resolved against loaded data exactly like `sel`, and dropped when it
names a point that isn't there.

## Status

Checked off as it lands; this list is the plan until then.

- [x] Design (this document)
- [x] `kde.ts` — Gaussian KDE, bandwidth, mode fitting (+ tests)
- [x] `stats.ts` — Mann-Whitney U, Cliff's delta, CLES, summaries (+ tests)
- [x] `distribution.ts` — shared grid, curves, modes, jitter (+ tests)
- [x] `DistributionChart.svelte` / `distributionDraw.ts`
- [x] Push distribution in the details pane
- [x] `compare.ts` — kinds, pools, labels, links (+ tests)
- [x] `cmp` URL state, shift-click, comparison highlights
- [x] Comparison section in the details pane
- [x] Hover preview

Open items — a bootstrap CI, per-run shading inside a push pool, comparing more
than two points — live in [graphs-todo.md](graphs-todo.md).
