<script lang="ts">
  // Middle pane: a thin overview graph over the full time range, and below it
  // the (possibly zoomed) detail graph.

  import type { AppState, Selection } from './appState.svelte';
  import type { Highlight } from './chartDraw';
  import { jitterForSelection } from './graphData';
  import ScatterChart, { type ChartHit } from './ScatterChart.svelte';
  import type { SelectedPoint } from '../urlState';
  import { describeSpan, matchingPreset, RANGE_PRESETS } from '../shared/timeRange';

  type Props = { app: AppState };
  let { app }: Props = $props();

  // Both graphs use the same horizontal padding so their plot areas line up —
  // that alignment is what lets the overview read as a map of the detail view.
  const DETAIL_PAD = { left: 56, right: 12, top: 8, bottom: 20 };
  const OVERVIEW_PAD = { left: 56, right: 12, top: 4, bottom: 16 };

  // Big enough for a circle, a square and a diamond to be told apart — the
  // point of carrying treeherder's symbols at all. (Treeherder's own dots are
  // bigger still, but it never draws more than six series, and only after a
  // y-padding that leaves the data in half the plot height.) The overview stays
  // small: it's a density map, not something you read point by point.
  const DETAIL_DOT = 3;
  const OVERVIEW_DOT = 1.25;

  const xDetail = $derived({ min: app.detailSpan.start, max: app.detailSpan.end });
  const xFull = $derived({ min: app.range.start, max: app.range.end });

  // Recomputed whenever the range changes. `Date.now()` isn't reactive, so a
  // range that ages out of its preset while the tab sits open keeps its
  // highlight until something else changes — harmless, and the alternative is
  // a timer that exists only to un-highlight a button.
  const activePreset = $derived(matchingPreset(app.range, Date.now()));

  // Rings for the selection, the pinned comparison, and whatever the pointer is
  // over. Only for points that are actually plotted: a hidden series' selection
  // stays in the URL but not on the canvas.
  //
  // The hovered ring is drawn from `app.hoveredPoint` rather than kept inside
  // ScatterChart, so it agrees with the comparison the pane is previewing —
  // dashed while it previews one, and solid when it can't (nothing is selected,
  // so a click would select rather than compare).
  const highlights = $derived.by((): Highlight[] => {
    const out: Highlight[] = [];
    const ring = (sel: Selection | null, kind: Highlight['kind']) => {
      if (!sel || !sel.entry.visible) return;
      out.push({
        x: sel.run.x,
        y: sel.value,
        // The dot was drawn some way off its push time, so the ring has to be
        // too. Recomputed from the push rather than read off a point, because a
        // selection is a resolved URL triple and never carries one.
        jitter: jitterForSelection(sel.push, sel.run.datumId, sel.replicateIndex),
        xRoom: sel.push.xRoom,
        color: sel.entry.color,
        kind,
      });
    };
    ring(app.selection, 'selected');
    if (app.comparisonSource === 'pinned') ring(app.comparedSelection, 'compared');
    else if (app.comparisonSource === 'hover') ring(app.hoveredSelection, 'hovered');
    else if (!app.selection) ring(app.hoveredResolved, 'hoverable');
    return out;
  });

  const unitLabel = $derived.by(() => {
    const units = new Set(
      app.visibleSeries.map((s) => s.meta?.measurementUnit).filter((u): u is string => !!u),
    );
    if (units.size === 0) return '';
    // Several units on one axis is a known wart (see docs/graphs.md); at
    // least say so rather than labelling the axis with a lie.
    return units.size === 1 ? [...units][0] : 'mixed units';
  });

  // A chart hit is a pair of indices into what the chart was *given*: the
  // visible subset of series, and the point set `showReplicates` chose. So with
  // replicates off this resolves to the run's MEAN_REPLICATE point rather than a
  // replicate the user can't see.
  function pointFor(hit: ChartHit | null): SelectedPoint | null {
    if (!hit) return null;
    const entry = app.visibleSeries[hit.seriesIndex];
    const point = entry?.plot.points[hit.pointIndex];
    if (!entry || !point) return null;
    return {
      repository: entry.ref.repository,
      signatureId: entry.ref.signatureId,
      datumId: point.datumId,
      replicateIndex: point.replicateIndex,
    };
  }

  function onDetailSelect(hit: ChartHit | null, modifiers: { shift: boolean }): void {
    const point = pointFor(hit);
    if (modifiers.shift) {
      // Shift-clicking empty space is not "clear everything"; it's a missed dot.
      if (point) app.comparePoint(point);
      return;
    }
    if (!point) {
      // Escape and clicking empty space unwind one level at a time: the pinned
      // comparison first, the selection second. Throwing both away on one press
      // makes the more common action (drop the comparison, keep looking at the
      // point) unreachable.
      if (app.comparisonSource === 'pinned') app.clearComparison();
      else app.selectPoint(null);
      return;
    }
    app.selectPoint(point);
  }
</script>

<section class="graph-pane">
  <header>
    <div class="ranges" role="group" aria-label="Time range">
      <span class="label">Last</span>
      {#each RANGE_PRESETS as preset (preset.seconds)}
        <button
          type="button"
          class="btn btn-compact"
          class:btn-selected={activePreset?.seconds === preset.seconds}
          aria-pressed={activePreset?.seconds === preset.seconds}
          onclick={() => app.setRangePreset(preset.seconds)}
        >
          {preset.label}
        </button>
      {/each}
      <span class="span-text" title="The URL pins these absolute bounds">
        {describeSpan(app.range)}
      </span>
    </div>
    <!-- A drawing switch, not a fetch switch: replicates are always fetched,
         so this is instant and the details pane keeps listing them either
         way. -->
    <label class="draw-replicates" title="Draw every replicate, or one dot per run at its mean">
      <input
        type="checkbox"
        checked={app.showReplicates}
        onchange={(e) => app.setShowReplicates(e.currentTarget.checked)}
      />
      Replicates
    </label>
    <div class="zoom-state">
      <!-- The loading slot is always present so the header doesn't reflow
           when a fetch starts or finishes. -->
      <span class="loading-slot" class:visible={app.anyLoading}>
        Loading {app.loadingCount}…
      </span>
      <!-- Both the label and the button stay put whether or not there's a
           zoom: swapping in a longer string used to push this whole group
           onto a second row, shoving the graphs down mid-interaction. -->
      <span class="zoom-label" class:hint={!app.zoom}>
        {app.zoom ? `Zoomed: ${describeSpan(app.zoom)}` : 'Drag the overview to zoom'}
      </span>
      <button type="button" class="btn btn-compact" disabled={!app.zoom} onclick={() => app.resetZoom()}>
        Reset zoom
      </button>
    </div>
  </header>

  {#if app.failedSeries.length > 0}
    <div class="errors" role="alert">
      <div class="error-list">
        {#each app.failedSeries as entry (entry.key)}
          <div>
            <strong>{entry.ref.repository} / {entry.ref.signatureId}</strong>: {entry.error}
          </div>
        {/each}
      </div>
      <button type="button" class="btn btn-compact" onclick={() => app.retryAllFailed()}>Retry</button>
    </div>
  {/if}

  <div class="overview">
    <ScatterChart
      series={app.visibleSeries}
      xDomain={xFull}
      yDomain={app.fullYDomain}
      pad={OVERVIEW_PAD}
      dotRadius={OVERVIEW_DOT}
      showLines={false}
      showAxes={true}
      interaction="brush"
      brush={app.zoom}
      onbrush={(span, live) => app.setZoom(span, live)}
      ariaLabel="Overview graph showing the full time range"
    />
  </div>

  <div class="detail">
    {#if unitLabel}<span class="unit">{unitLabel}</span>{/if}
    <ScatterChart
      series={app.visibleSeries}
      xDomain={xDetail}
      yDomain={app.detailYDomain}
      pad={DETAIL_PAD}
      dotRadius={DETAIL_DOT}
      showLines={true}
      showAxes={true}
      showAlerts={true}
      interaction="select"
      {highlights}
      onselect={onDetailSelect}
      onhover={(hit) => app.setHoveredPoint(pointFor(hit))}
      onbrush={(span) => app.setZoom(span)}
      onkeymove={(axis, delta) =>
        axis === 'run' ? app.stepRun(delta) : app.stepReplicate(delta)}
      onkeycompare={() => app.comparePoint(app.selectedPoint)}
      onkeyprevious={() => app.compareWithPreviousPush()}
      ariaLabel="Detail graph; click a point to inspect it, shift-click a second to compare, P to compare it with the previous push, or use the arrow keys and C to mark a point for comparison"
    />
    {#if app.series.length === 0}
      <p class="overlay-note">Add a series to see data.</p>
    {:else if app.visibleSeries.length === 0}
      <p class="overlay-note">Every series is hidden.</p>
    {:else if !app.hasData}
      <p class="overlay-note">
        {app.anyLoading ? 'Loading…' : 'No data in this time range.'}
      </p>
    {/if}
  </div>
</section>

<style>
  .graph-pane {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--bg-canvas);
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-default);
    font: 13px/1.4 system-ui, sans-serif;
  }
  .ranges,
  .zoom-state {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  /* Wraps as whole items. Without this the group is one unwrappable line whose
     items shrink instead, and every child of it is text that will break: at a
     680px pane the presets are still one row, at 552px they start splitting
     their own labels ("2 / days"), and at 424px the header grows from 77px to
     187px — a fifth of the pane — for the same seven buttons. */
  .ranges {
    flex-wrap: wrap;
  }
  /* The other half of that: a flex item's automatic minimum is its *min-content*
     width, which for "2 days" is the width of "days". Nothing above stops a
     button from shrinking to that and wrapping inside itself; this does. */
  .ranges > .btn,
  .label {
    white-space: nowrap;
  }
  .label {
    color: var(--fg-muted);
  }
  /* Named for the control, not the data: DetailsPane's chip list of replicate
     values is also `.replicates`, and while Svelte scopes both, a
     `document.querySelectorAll('.replicates')` in a throwaway measurement
     script silently measured this checkbox instead. */
  .draw-replicates {
    display: flex;
    align-items: center;
    gap: 5px;
    white-space: nowrap;
    cursor: pointer;
  }
  .draw-replicates input {
    margin: 0;
    cursor: pointer;
  }
  .span-text {
    margin-left: 6px;
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
    /* Drops to its own wrapped line when the presets fill the first one, rather
       than being squeezed to a 24px column of one character per line. It is not
       hidden at narrow widths: when the graph is zoomed this is the only place
       the fetched range is stated, and the axis below shows the zoom instead. */
    white-space: nowrap;
  }
  .hint {
    color: var(--fg-subtle);
  }
  .loading-slot {
    /* Reserved even when idle: "Loading 8…" must not shove the zoom controls
       sideways the moment a fetch begins. */
    min-width: 8ch;
    color: var(--fg-muted);
    visibility: hidden;
  }
  .loading-slot.visible {
    visibility: visible;
  }
  .zoom-label {
    /* Wide enough for the longest form ("Zoomed: Jul 19 – Jul 25") so the
       row's width doesn't depend on whether a zoom is active. */
    min-width: 23ch;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .errors {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--danger-border);
    background: var(--danger-subtle);
    color: var(--danger-fg);
    font: 12px/1.5 system-ui, sans-serif;
  }
  .error-list {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .overview {
    height: 84px;
    flex: none;
    border-bottom: 1px solid var(--border-muted);
  }
  .detail {
    position: relative;
    flex: 1;
    min-height: 0;
  }
  .unit {
    position: absolute;
    top: 4px;
    left: 8px;
    font: 11px system-ui, sans-serif;
    color: var(--fg-muted);
    pointer-events: none;
  }
  .overlay-note {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0;
    color: var(--fg-subtle);
    font: 14px system-ui, sans-serif;
    pointer-events: none;
  }
</style>
