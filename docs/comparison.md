# Distributions and comparison mode

Companion to [graphs.md](graphs.md). Two features that share one piece of
machinery:

1. **Push distributions.** Selecting a dot shows, in the details pane, the
   distribution of *every* value that series recorded on that push — a kernel
   density curve with detected modes, and the raw values below it as a jittered
   strip. Under the chart the same values appear as chips, grouped by the job
   that produced them, so a retriggered build's runs can be compared one by one
   and any of their values can be selected directly.
2. **Comparison mode.** Shift-clicking a second dot pins it as a comparison.
   The pane then draws both distributions on one axis and adds the statistics
   and links that only make sense for a pair: Mann-Whitney U, Cliff's delta, a
   pushlog range, a perf.compare link.

Hovering a dot with a selection active shows the same comparison as an
unpinned preview. See "Interaction" below for the keyboard equivalent.

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
  this build", which is the question the pane's "Values on this push" section
  exists to answer — and it is the one-row form of the same chart a comparison
  fills with two rows, in the same place. It is
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

## Interaction

| Gesture | Effect |
|---|---|
| click a dot | select it |
| shift-click a dot | pin it as the comparison's other end; shift-clicking it again unpins |
| shift-click with nothing selected | selects it *and* marks it, so the pin has something to hang off |
| hover a dot (with a selection) | preview the comparison a shift-click would pin |
| hold shift while hovering | the ring goes dashed: that click pins rather than selects |
| <kbd>C</kbd> on the focused graph | pin the *selected* point, then walk away from it with the arrow keys |
| <kbd>P</kbd>, or "Compare with the previous push" in the pane | pin the push before the selected one; again unpins |
| click an alert marker | select the alerted push *and* pin the one perfherder measured against, in one history entry |
| <kbd>A</kbd> / <kbd>shift-A</kbd> on the focused graph | the same, stepping to the next or previous alert; stops at the ends |
| Escape, or click empty space | unpin the comparison; a second press clears the selection |

**"Compare with the previous push" is a button because it is the question a
single selected point raises.** Every other pair needs the user to say which two
points they mean, but "what changed here" names its own second end, and reaching
it by hand means aiming at one dot inside the previous push's replicate cloud —
the fiddliest shift-click in the app, and the one whose result doesn't depend on
which dot you hit, since the pool is the whole push. `compareWithPreviousPush`
pins that push's latest retrigger and carries the replicate slot across the way
the arrow keys do. It sits in the hint box, which is exactly where the
comparison card it produces will appear.

**An alert marker is the same shortcut with its second end already named.** It
pins `prev_push_id` — the push perfherder measured against, which is not always
the graph's previous push — and ignores modifiers, since there is no second
thing left for shift to mean. The comparison it produces will not match the
numbers on the Alert card, because perfherder's are window averages over 12–24
pushes; see graphs.md, "Alerts".

**Pinning the selected point is a state, not an error.** It's the middle step of
the keyboard path — there is no keyboard gesture for "shift-click *that* dot",
so the marking has to come first — and it's also where arrowing back onto a
pinned point lands. `AppState.comparisonMarkedHere` is that state, and the pane
says what to do next rather than showing a comparison that failed. The
alternative, silently dropping a pin the selection happens to land on, throws
away a mark the user set deliberately whenever they walk left and then right.

**It is also where a shift-click with nothing selected lands.** A pin without a
selection is a comparison with one end, and `comparisonSource` reports none
without a selection — so that gesture used to write `cmp=` to the URL and then
display nothing whatsoever, until a later plain click sprang a comparison
against a dot chosen minutes earlier with no clue where it had come from.
`comparePoint` now selects the point as well, which is the same marked state
the keyboard path produces. The two gestures converge rather than shift-click
having a silent state of its own, and the graph stays honest: the hover ring
said this click would pin the dot, and it did. Unpinning is still the gesture's
own undo, and it leaves the selection behind — dropping that too would be two
undos for one shift-click.

**The pane does not move while the pointer does.** The comparison block is two
slots with reserved heights — 89px for the headline (or the hint, or "marked")
and 203px for the chart — so crossing a dot changes what is *in* them and
nothing below. It was 419px of movement before: the full card is 508px against
the 89px hint it replaced, and the chart it drew was a second copy of one
DetailsPane was drawing 250px lower, so the two swapping places moved another
154px the other way. Now there is one chart in one place, with a second strip
row when there is something to compare — `distributionHeight` puts the two forms
20px apart, 55px with the extra legend row, which is what the reserve costs.
Only pinning grows the block, by adding the stats, the sides and the links below
the chart; pinning is deliberate and may rearrange the pane, hovering may not.

**Escape unwinds one level at a time**, comparison before selection. Doing both
at once makes the commoner action — drop the comparison, keep looking at the
point — unreachable.

Three highlights can be on screen at once, and they're drawn independently:
filled with a solid ring for the selection, filled and dashed for the pin,
hollow for the hover. The hover is hollow because it is provisional — a filled
disc following the pointer reads as a selection that keeps moving.

**The hover ring answers one question: what does a click do right now.** Shift
down and it is dashed — that click pins this dot as the comparison. Shift up
and it is solid — that click selects it. Nothing else changes it, so the rule
holds with nothing selected, with a selection, and with a comparison already
pinned. `chartDraw.ts::hoverRingKind` is the whole of it, and it returns null
only when there is no dot under the pointer.

It used to key off `comparisonSource` instead, which made the ring answer a
different question in each state — and no question at all in one. With a
comparison pinned the hovered dot got no ring whatsoever, in the single state
where a click has two possible outcomes and so needs the feedback most. A
tester found it; the shape of the bug was that the ring was doing two jobs
(what a click does, and what the pane is previewing) through one channel.

Job two now sits entirely with the pane, which was already equipped for it: a
hovered comparison card has a dashed border, a quieter fill and a "shift-click
to pin" hint. So the ring is what a click *will* do and the card is what you
*would* get — one channel each. The cost is that the dashed card no longer
always pairs with a dashed ring; with shift up you get a dashed card beside a
solid ring, which is correct, because pinning it takes shift.

**Shift is tracked from two sources**, because either alone has a hole:
`onhover` reports `e.shiftKey` so shift held *before* the pointer reached the
graph counts, and window `keydown`/`keyup` catch shift pressed or released
while the pointer sits still, which no pointer event would report. Window
`blur` resets it, or tabbing away leaves the graph believing it is still held.

**The hover path is cheap enough to run on pointer moves.** Measured with four
series over 90 days, sweeping the pointer across dots: the whole
hover → recompute → repaint chain is a median of 0.3 ms and a worst case of
6 ms (39 moves, 25 of them landing on a new dot; ScatterChart dedupes the rest).
The work is two `summarize`s, a rank-sum test, two 256-point KDEs and one small
canvas. If a pool ever gets large enough for that to matter, the split to make
is cheap-statistics-on-hover versus full-statistics-on-pin.

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
  never from the sign of the delta alone — and only for the `push` kind, the one
  case that is a single thing measured twice. Windows being slower than macOS on
  one build is not a regression; two retriggers of one build differing is noise;
  and two *different* series on two different pushes aren't a before and an
  after, however well-defined their delta is. Labelling any of those would be a
  category error dressed up as a finding.
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
- **That domain is anchored to the selection, not fitted to the pair on screen**
  (`distribution.ts::stableAxis` → `AppState.selectionChart` →
  `buildDistribution`'s `axis` argument). The pane redraws on every hover, and
  fitting the axis to the two pools meant the *selected* side — the one thing the
  reader is holding still — moved under the pointer on every dot. Measured over one
  series' 84 pushes, hovering each against a fixed selection: the fitted axis width
  swung 12% and the selected pool's median slid 15px across a 260px plot.

  The anchor is what the *selected* pool would get to itself, widened by
  `AXIS_HEADROOM` (0.4) on each side — `stableScales` computes it alongside the
  density ceiling below, since both are the same bargain in different directions. A hovered pool whose values fall inside that
  headroom changes nothing at all; one that doesn't still widens the axis, in
  `buildDistribution`, because both distributions have to fit and a strip dot off
  the end of the plot would be worse. So the axis is a function of the selection
  alone, and the headroom decides how often that's the whole story.

  **The first version of this took the union over every push a hover could reach**,
  which is stable by construction and was wrong: it is only tight when the series
  is. On the series that produced the complaint — a zoom window holding outliers 8
  score apart, with a selected pool 0.18 wide — it gave the selected distribution
  **2% of the plot**. The anchored version gives it 15%, and in the browser the
  selected side holds still on 55% of hovers there against 0% before. Measured
  alternatives for the headroom, on that series and on a tight one:

  | headroom | axis unchanged | selected pool fills |
  |---|---|---|
  | 0.2 | 34% / 100% | 19% / 38% |
  | **0.4** | **63% / 100%** | **15% / 29%** |
  | 0.6 | 87% / 100% | 12% / 24% |

  A hover onto another *series* is the case no headroom helps: two distributions
  four score apart need an axis that spans them, and then the selected one is a
  sliver whatever the rule.
- **The density band's height scale is shared between the sides, with headroom.**
  Shared is deliberate: both curves integrate to 1, so height *is* spread, and
  normalizing each side to its own peak would throw away the one reading that says
  which distribution is tighter. But shared also means a taller hovered curve
  squashes the selected one, so `stableScales` reserves `DENSITY_HEADROOM` (0.5)
  above the selected pool's own peak, and a hovered peak inside that changes
  nothing. Measured by sweeping the pointer in the browser, distinct values of the
  band's scale: 25 across 33 hovers before, 11 after, with the reserved ceiling
  holding for 67% of them on one series and 95% on another.

  The cost is that the selected curve tops out at 1/1.5 = 67% of the band instead
  of filling it, and **the worst case is not improved at all**: the hovered peak
  reaches 16–20× the selected one when a hovered push happens to be a single tight
  run, and on the worst decile of hovers the selected curve is squashed to a third
  of the band or less whatever the headroom is. Only compressing the scale (sqrt or
  log) would fix that, at the price of the plain height-is-spread reading — see
  graphs-todo.md.
- **The band keeps its space when a hover could produce a curve** even if neither
  pool on screen has one (`distributionHeight`'s `reserveBand`, from
  `selectionChart`). A series whose pushes straddle `MIN_CURVE_VALUES` — most with
  enough replicates for a curve, one with three — otherwise grew and shrank by 73px
  as the pointer moved between them. This half *does* scan the zoom window, since
  what matters is whether a pool the pointer can reach has a curve. Where none can
  (every awsy signature) nothing is reserved, so those charts stay 61px rather than
  carrying a permanently empty band.
- **Overlapping dots darken.** The strip's dots are translucent and drawn in
  interleaved paths so that several values landing on the same spot accumulate;
  see graphs.md, "Dots are translucent, and jittered sideways", for why one
  batched path silently defeats that.
- **The jitter is deterministic**, from a hash of the value's index, not
  `Math.random()`. A Svelte `$derived` re-runs whenever anything it reads
  changes; random jitter would make every dot jump on an unrelated state
  change. (PerfCompare hit this too and worked around it by hoisting the
  jitter into a `useMemo` keyed on the values — the same fix, expressed in a
  different framework.) The hash is `chart.ts::jitterAt`, shared with the
  time-series graphs' horizontal jitter — see graphs.md, "Dots are translucent,
  and jittered sideways", where the stake is higher than shimmer.
- **Mode detail goes below the chart, not on it.** The details pane is 320px
  wide; PerfCompare's on-chart labels ("Base A: 123.4 (67%)") need most of
  that each and it staggers them vertically to cope. Here the chart carries
  only the letter and the text list below carries the rest, which stays
  readable at pane width and can't collide.
- **The height is a pure function of the data**, not of anything the user does
  to it: one strip row per side, and the density band only when at least one side
  has a curve. So it can change when the selection or the comparison changes —
  which is a moment the whole pane is being rewritten anyway — but never while
  the user is reading it. `distributionHeight` is that function, and the
  component sets it on the wrapper so the pane doesn't reflow as the canvas
  measures itself. (Reserving the band unconditionally would be steadier still,
  at the cost of a labelled empty box in every narrow-pool case. See design.md,
  "Layout stability", for the rule this bends.)

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
| `cmp` | Pinned comparison point, same `<repo>,<signatureId>,<datumId>,<replicateIndex>` shape as `sel`. Only written alongside a `sel`, since a comparison needs two ends |

The hover preview is deliberately *not* in the URL: it's transient by
definition, and writing it would put a history entry (or a URL rewrite) on
every mouse movement.

`cmp` is resolved against loaded data exactly like `sel`, and dropped when it
names a point that isn't there.

## Code map

Pure, and unit tested:

- `kde.ts` — Gaussian KDE, the bandwidth rule, mode fitting.
- `stats.ts` — Mann-Whitney U, Cliff's delta, CLES, pool summaries, the
  improvement/regression reading.
- `distribution.ts` — one or two pools → curves, modes, jitter, and the chart's
  geometry. The jitter hash itself is `chart.ts::jitterAt`, since both charts
  scatter overlapping dots with it.
- `compare.ts` — kinds, side ordering, pools, labels, outgoing links.
- `graphData.ts::pushValues` / `indexInPushValues` / `replicateGroups` — the
  pooling rule itself, which belongs with the push/run/replicate structure, and
  the same values grouped by job for the chip list.
- `links.ts::perfCompareUrl` / `perfCompareSubtestsUrl`, and
  `chart.ts`'s signed/percent/p-value formatting.

Not pure:

- `distributionDraw.ts` — canvas painting. Takes every coordinate from a
  `DistributionLayout`. One exception is tested: `modeLabelY`, whose failure mode
  is a glyph that silently isn't drawn.
- `DistributionChart.svelte` — the canvas, its size, and the HTML half of the
  legend.
- `appState.svelte.ts` — `comparedPoint`, `hoveredPoint`, `comparisonSource`,
  `comparison`, `comparisonMarkedHere`.
- `ComparisonSection.svelte` — the comparison card, in all three of its
  states (compared, marked-here, and the hint that says the gesture exists).
- `DetailsPane.svelte` — the push distribution, and everything else in the
  pane.

Open items — a bootstrap CI, per-run shading inside a push pool, comparing more
than two points — live in [graphs-todo.md](graphs-todo.md).
