<script lang="ts">
  // The distribution chart in the details pane: a density band with detected
  // modes over a jittered strip of the raw values, plus the numbers that don't
  // fit on a 300px-wide canvas.
  //
  // Everything numeric comes in already computed (distribution.ts); this
  // component owns the canvas, its size, and the HTML half of the legend. The
  // split between the two is deliberate — see docs/comparison.md, "Mode detail
  // goes below the chart, not on it".

  import { formatValue } from '../shared/chart';
  import { distributionHeight, distributionLayout, type DistributionPlot } from './distribution';
  import { drawDistribution } from './distributionDraw';
  import { theme } from '../shared/theme.svelte';

  type Props = {
    plot: DistributionPlot;
    unit?: string;
    // Keep the density band's space even when nothing is drawn in it. The pane
    // sets this when some other pool the pointer could land on *does* have a
    // curve, so the chart doesn't change height under the reader — see
    // AppState.selectionChart.
    reserveBand?: boolean;
    // The *second* line of each legend row — the spread and cv, or the mode
    // breakdown. Off for the hover preview. The labels and `n · med` stay, so
    // the rows are still named; only the detail goes, and it is the expensive
    // half: two of these lines are 35px, which is most of what the pane has to
    // reserve for a comparison that may never be pinned. See ComparisonSection,
    // `.cmp-chart`, for the arithmetic that reserve comes out of.
    legendDetail?: boolean;
  };
  let { plot, unit = '', reserveBand = false, legendDetail = true }: Props = $props();

  let wrapper: HTMLDivElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();
  let width = $state(0);

  const height = $derived(
    distributionHeight(plot.series.length, plot.hasCurves, reserveBand),
  );
  const layout = $derived(distributionLayout(width, plot, reserveBand));

  // A single side is the plain "this push" case; two sides are a comparison, and
  // the first is drawn dashed and hollow. Mirrors `isBaseSide` in
  // distributionDraw.ts.
  const comparing = $derived(plot.series.length > 1);

  $effect(() => {
    if (!wrapper) return;
    const ro = new ResizeObserver((entries) => {
      width = entries[0].contentRect.width;
    });
    ro.observe(wrapper);
    return () => ro.disconnect();
  });

  $effect(() => {
    if (!canvas || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const bw = Math.round(width * dpr);
    const bh = Math.round(height * dpr);
    // Assigning either clears the backing store, so only do it on a real change.
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // `theme.chartPalette` is read inside the effect so a theme change
    // repaints — a canvas can't be restyled by CSS.
    drawDistribution(ctx, layout, plot, theme.chartPalette);
  });

  function withUnit(v: number): string {
    return unit ? `${formatValue(v)} ${unit}` : formatValue(v);
  }

  // Mode shares are coarse by nature — "62%" of the density is as precise as the
  // idea gets.
  function percent(fraction: number): string {
    return `${Math.round(fraction * 100)}%`;
  }

  // The coefficient of variation is routinely under 1%, where rounding to whole
  // percent prints "0%" for every well-behaved measurement and throws away the
  // only interesting thing about it. One decimal below 10%.
  function cvPercent(fraction: number): string {
    const pct = fraction * 100;
    return `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
  }

  // What a screen reader gets instead of the picture. The medians and the mode
  // count are the two things the chart is read for.
  const summaryText = $derived(
    plot.series
      .map((s) =>
        s.summary
          ? `${s.label}: ${s.summary.count} values, median ${withUnit(s.summary.median)}` +
            (s.modes.peakLocs.length > 1 ? `, ${s.modes.peakLocs.length} modes` : '')
          : `${s.label}: no values`,
      )
      .join('. '),
  );
</script>

<div class="distribution">
  <!-- Fixed height from the layout, so the pane doesn't reflow as the canvas
       measures itself.

       `role="img"` goes on the wrapper rather than on the <canvas>, which can't
       carry it (a canvas is an interactive element as far as ARIA is concerned).
       The canvas itself is hidden from assistive tech; `summaryText` is what
       replaces the picture. -->
  <div
    class="canvas-wrap"
    bind:this={wrapper}
    style:height="{height}px"
    role="img"
    aria-label={summaryText}
  >
    <canvas bind:this={canvas} aria-hidden="true"></canvas>
  </div>

  <ul class="legend">
    {#each plot.series as side, i (side.label + i)}
      <li>
        <span
          class="key"
          class:dashed={comparing && i === 0}
          style:--key-color={side.color}
          aria-hidden="true"
        ></span>
        <div class="key-body">
          <div class="key-head">
            <!-- `title` because the label is clipped rather than wrapped, and a
                 platform string runs well past the room this row has. -->
            <span class="key-label" title={side.label}>{side.label}</span>
            {#if side.summary}
              <span class="key-stats">
                n={side.summary.count} · med {withUnit(side.summary.median)}
              </span>
            {/if}
          </div>
          {#if side.summary && legendDetail}
            <div class="key-detail">
              {#if side.modes.peakLocs.length > 1}
                <!-- Modes are worth naming only when there is more than one;
                     drawModes applies the same rule to the canvas. -->
                modes
                {#each side.modes.peakLocs as loc, m (m)}<span class="mode"
                    ><b>{side.modes.letters[m]}</b> {formatValue(loc)} ({percent(
                      side.modes.fracs[m],
                    )})</span
                  >{' '}{/each}
              {:else if side.density.length === 0}
                {side.summary.count} value{side.summary.count === 1 ? '' : 's'} — too few to
                estimate a distribution
              {:else}
                <!-- One unit for the pair, not one each: "50.35 score – 50.96
                     score" says the same thing twice in a 300px column. -->
                spread {formatValue(side.summary.min)} – {withUnit(side.summary.max)}, cv
                {cvPercent(side.summary.cv)}
              {/if}
            </div>
          {:else if legendDetail}
            <div class="key-detail">no values</div>
          {/if}
        </div>
      </li>
    {/each}
  </ul>
</div>

<style>
  .distribution {
    margin: 6px 0 0;
  }
  .canvas-wrap {
    position: relative;
    width: 100%;
  }
  canvas {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
  }
  .legend {
    list-style: none;
    margin: 2px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 11px;
  }
  /* `minmax(0, 1fr)`, not `1fr`: a `1fr` track's automatic minimum is its
     min-content width, and `.key-label` below is a single unbreakable line, so
     a platform string would push the row wider than the pane instead of being
     clipped by it. */
  .legend li {
    display: grid;
    grid-template-columns: 16px minmax(0, 1fr);
    gap: 5px;
    align-items: start;
  }
  /* The same vocabulary the canvas uses: a solid rule for the emphatic side, a
     dashed one for the baseline. Colors can be identical (one series across two
     pushes), so the dash is what carries the distinction.

     ComparisonSection's `.key` is the same rule, duplicated because Svelte
     scopes styles per component. Change one, change the other. */
  .key {
    height: 0;
    margin-top: 6px;
    border-top: 2px solid var(--key-color);
  }
  .key.dashed {
    border-top-style: dashed;
  }
  .key-body {
    min-width: 0;
  }
  /* One line, never two. A wrapped head row is 18px taller, and the details
     pane reserves this chart's height so that hovering can't move the sections
     below it — see ComparisonSection, `.cmp-chart`. The labels here are
     revisions and platform strings, so their length is not ours to predict,
     which is the same reason `.cmp-sub` next door is `.one-line`. Wrapping put
     a cross-series hover 36px over its reserve.

     Clipping the label is what pays for it: `.key-stats` is the half that must
     stay whole (a truncated median says nothing), the label survives as a
     prefix, and the pinned card lists both sides in full below the chart. */
  .key-head {
    display: flex;
    flex-wrap: nowrap;
    gap: 6px;
    justify-content: space-between;
  }
  .key-label {
    font-weight: 600;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .key-stats {
    flex: none;
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  /* Two lines at most, for the same reason the head row is one. This line does
     wrap — a three-mode breakdown genuinely needs two lines, and 16px of it is
     inside the reserve — but a five-mode pool would take a third and put the
     resting state over the top of it. The canvas letters the modes anyway, so
     a clamped tail loses a repeat rather than the fact. */
  .key-detail {
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
  .mode b {
    font-weight: 600;
    color: var(--fg-default);
  }
</style>
