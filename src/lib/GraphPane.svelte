<script lang="ts">
  // Middle pane: a thin overview graph over the full time range, and below it
  // the (possibly zoomed) detail graph.

  import type { AppState } from './appState.svelte';
  import ScatterChart from './ScatterChart.svelte';
  import { describeSpan, matchingPreset, RANGE_PRESETS } from './timeRange';

  type Props = { app: AppState };
  let { app }: Props = $props();

  // Both graphs use the same horizontal padding so their plot areas line up —
  // that alignment is what lets the overview read as a map of the detail view.
  const DETAIL_PAD = { left: 56, right: 12, top: 8, bottom: 20 };
  const OVERVIEW_PAD = { left: 56, right: 12, top: 4, bottom: 16 };

  const xDetail = $derived({ min: app.detailSpan.start, max: app.detailSpan.end });
  const xFull = $derived({ min: app.range.start, max: app.range.end });

  // Recomputed whenever the range changes. `Date.now()` isn't reactive, so a
  // range that ages out of its preset while the tab sits open keeps its
  // highlight until something else changes — harmless, and the alternative is
  // a timer that exists only to un-highlight a button.
  const activePreset = $derived(matchingPreset(app.range, Date.now()));

  const highlight = $derived.by(() => {
    const sel = app.selection;
    return sel ? { x: sel.run.x, y: sel.value, color: sel.entry.color } : null;
  });

  const unitLabel = $derived.by(() => {
    const units = new Set(
      app.series.map((s) => s.meta?.measurementUnit).filter((u): u is string => !!u),
    );
    if (units.size === 0) return '';
    // Several units on one axis is a known wart (see docs/graphs.md); at
    // least say so rather than labelling the axis with a lie.
    return units.size === 1 ? [...units][0] : 'mixed units';
  });

  function onDetailSelect(hit: { seriesIndex: number; pointIndex: number } | null): void {
    if (!hit) {
      app.selectPoint(null);
      return;
    }
    const entry = app.series[hit.seriesIndex];
    const point = entry?.data.points[hit.pointIndex];
    if (!entry || !point) return;
    app.selectPoint({
      repository: entry.ref.repository,
      signatureId: entry.ref.signatureId,
      datumId: point.datumId,
      replicateIndex: point.replicateIndex,
    });
  }
</script>

<section class="graph-pane">
  <header>
    <div class="ranges" role="group" aria-label="Time range">
      <span class="label">Last</span>
      {#each RANGE_PRESETS as preset (preset.seconds)}
        <button
          type="button"
          class:active={activePreset?.seconds === preset.seconds}
          onclick={() => app.setRangePreset(preset.seconds)}
        >
          {preset.label}
        </button>
      {/each}
      <span class="span-text" title="The URL pins these absolute bounds">
        {describeSpan(app.range)}
      </span>
    </div>
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
      <button type="button" disabled={!app.zoom} onclick={() => app.resetZoom()}>
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
      <button type="button" onclick={() => app.retryAllFailed()}>Retry</button>
    </div>
  {/if}

  <div class="overview">
    <ScatterChart
      series={app.series}
      xDomain={xFull}
      yDomain={app.fullYDomain}
      pad={OVERVIEW_PAD}
      dotRadius={1}
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
      series={app.series}
      xDomain={xDetail}
      yDomain={app.detailYDomain}
      pad={DETAIL_PAD}
      dotRadius={2}
      showLines={true}
      showAxes={true}
      interaction="select"
      {highlight}
      onselect={onDetailSelect}
      onbrush={(span) => app.setZoom(span)}
      onkeymove={(axis, delta) =>
        axis === 'run' ? app.stepRun(delta) : app.stepReplicate(delta)}
      ariaLabel="Detail graph; click a point to inspect it, or use the arrow keys"
    />
    {#if app.series.length === 0}
      <p class="overlay-note">Add a series to see data.</p>
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
    background: #fff;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
    padding: 8px 12px;
    border-bottom: 1px solid #d0d7de;
    font: 13px/1.4 system-ui, sans-serif;
  }
  .ranges,
  .zoom-state {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .label {
    color: #57606a;
  }
  .span-text {
    margin-left: 6px;
    color: #57606a;
    font-variant-numeric: tabular-nums;
  }
  .hint {
    color: #8c959f;
  }
  .loading-slot {
    /* Reserved even when idle: "Loading 8…" must not shove the zoom controls
       sideways the moment a fetch begins. */
    min-width: 8ch;
    color: #57606a;
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
  button:disabled {
    opacity: 0.45;
    cursor: default;
  }
  button:disabled:hover {
    background: #fff;
  }
  .errors {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 12px;
    border-bottom: 1px solid #ffcecb;
    background: #fff5f5;
    color: #cf222e;
    font: 12px/1.5 system-ui, sans-serif;
  }
  .error-list {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  button {
    font: inherit;
    padding: 3px 8px;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    background: #fff;
    cursor: pointer;
  }
  button:hover {
    background: #f3f4f6;
  }
  button.active {
    background: #0969da;
    border-color: #0969da;
    color: #fff;
  }
  .overview {
    height: 84px;
    flex: none;
    border-bottom: 1px solid #eaeef2;
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
    color: #57606a;
    pointer-events: none;
  }
  .overlay-note {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0;
    color: #8c959f;
    font: 14px system-ui, sans-serif;
    pointer-events: none;
  }
</style>
