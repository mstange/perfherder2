<script lang="ts">
  // Middle pane: a thin overview graph over the full time range, and below it
  // the (possibly zoomed) detail graph.

  import type { AppState, Selection, SeriesEntry } from './appState.svelte';
  import { hoverRingKind, type Highlight } from './chartDraw';
  import { jitterForSelection } from './graphData';
  import { alertTooltip, changeTooltip, type MarkContext } from './graphTooltip';
  import ScatterChart, {
    type ChartAlertHit,
    type ChartChangeHit,
    type ChartHit,
  } from './ScatterChart.svelte';
  import type { PointMode, SelectedPoint } from '../urlState';
  import { describeSpan, matchingPreset, RANGE_PRESETS } from '../shared/timeRange';

  type Props = { app: AppState };
  let { app }: Props = $props();

  // The three point modes, coarsening left to right, which is the order the
  // buttons sit in: more ink to less. A button group rather than a `<select>`
  // because `None` is the option nobody would think to look for — the whole
  // reason it exists is that a reader who has turned the trend band on wants the
  // scatter out of the way — and a dropdown that has to be opened before it
  // admits to a third choice would not get found. It is also the same shape the
  // range presets beside it already use for a one-of-several choice, which is
  // what makes the checkboxes next to it read as the independent switches they
  // are.
  //
  // Each title says what the dots *are*, not what the switch does: "one dot per
  // run" is the fact someone reading a graph needs, and the mode names alone
  // ("Run means") don't say whether a retrigger gets its own dot.
  const POINT_CHOICES: { mode: PointMode; label: string; title: string }[] = [
    {
      mode: 'replicates',
      label: 'Replicates',
      title: 'One dot per replicate value — every measurement the harness reported',
    },
    {
      mode: 'runs',
      label: 'Run means',
      title: 'One dot per run, at its mean — so a retriggered push keeps one dot per retrigger',
    },
    {
      mode: 'none',
      label: 'None',
      title:
        'No dots and no connecting line, leaving the trend band and the marks. The y axis then covers the band, and the details pane still lists a selected run’s replicates.',
    },
  ];

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

  // Is shift down? It decides what a click on the hovered dot would do, and so
  // which ring goes on it (see `hoverRingKind`).
  //
  // Two sources, because either alone has a hole. The window listeners catch
  // shift pressed or released while the pointer sits still, which no pointer
  // event would report; `onhover` catches shift that was already down before
  // the pointer reached the graph, which no keydown of ours ever saw. Blur
  // resets it, or a shift-tab away from the page leaves the graph believing it
  // is still held.
  let shiftHeld = $state(false);

  // Rings for the selection, the pinned comparison, and whatever the pointer is
  // over. Only for points that are actually plotted: a hidden series' selection
  // stays in the URL but not on the canvas.
  //
  // The hovered ring is drawn from `app.hoveredPoint` rather than kept inside
  // ScatterChart, so the graph and the pane can never disagree about which dot
  // the pointer is on.
  //
  // The three rings are independent, deliberately. They used to be a chain of
  // `else if` over `comparisonSource`, which meant a pinned comparison
  // swallowed the hover ring entirely — no feedback at all in the one state
  // where a click has two outcomes.
  const highlights = $derived.by((): Highlight[] => {
    const out: Highlight[] = [];
    const ring = (sel: Selection | null, kind: Highlight['kind'] | null) => {
      if (!sel || !kind || !sel.entry.visible) return;
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
    // Last, so the ring for what the *next* click does sits over the rings for
    // what previous ones did.
    ring(app.hoveredResolved, hoverRingKind(app.hoveredResolved !== null, shiftHeld));
    return out;
  });

  // Which marker to draw as selected. The rule is the details pane's: the alert
  // on the selected push, i.e. exactly the one the pane's Alert card is
  // describing, so the graph and the pane can't disagree about which alert is
  // being looked at. Not "the alert whose two pushes are still both pinned" —
  // shift-clicking a third dot moves the comparison without changing what the
  // Alert card says, and the marker following that would take the mark off the
  // push the pane is still talking about.
  //
  // Indices into what the chart was given, the same discipline as `pointFor`: a
  // hidden series isn't in `visibleSeries`, so its selected marker resolves to
  // nothing, which is right — nothing of that series is drawn.
  const selectedAlert = $derived.by((): ChartAlertHit | null => {
    const sel = app.selection;
    const alert = app.selectedAlert;
    if (!sel || !alert) return null;
    const seriesIndex = app.visibleSeries.indexOf(sel.entry);
    const alertIndex = sel.entry.alerts.indexOf(alert);
    if (seriesIndex < 0 || alertIndex < 0) return null;
    return { seriesIndex, alertIndex };
  });

  // Same rule, one layer simpler: the pane's Detected-change card is keyed on
  // the selected push, so the marked bar is the one that card is about.
  const selectedChange = $derived.by((): ChartChangeHit | null => {
    const sel = app.selection;
    const change = app.selectedChange;
    if (!sel || !change) return null;
    const seriesIndex = app.visibleSeries.indexOf(sel.entry);
    const changeIndex = sel.entry.changes.indexOf(change);
    if (seriesIndex < 0 || changeIndex < 0) return null;
    return { seriesIndex, changeIndex };
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
  // visible subset of series, and the point set `pointMode` chose. So in `runs`
  // this resolves to the run's MEAN_REPLICATE point rather than a replicate the
  // user can't see, and in `none` there are no hits to resolve at all.
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

  // Same index discipline as `pointFor`: the chart was handed the *visible*
  // series and each one's `alerts` array untouched, so both indices are
  // straight lookups.
  function onAlertSelect(hit: ChartAlertHit): void {
    const entry = app.visibleSeries[hit.seriesIndex];
    const alert = entry?.alerts[hit.alertIndex];
    if (entry && alert) app.selectAlert(entry.ref, alert);
  }

  function onChangeSelect(hit: ChartChangeHit): void {
    const entry = app.visibleSeries[hit.seriesIndex];
    const change = entry?.changes[hit.changeIndex];
    if (entry && change) app.selectChange(entry.ref, change);
  }

  // What a mark's tooltip needs to know about the series it belongs to.
  //
  // **The series is named only when more than one is plotted.** With one series
  // the question "which of these is it?" cannot arise, and the line would be a
  // third of the box restating the header of the pane next door. The name itself
  // is `AppState.seriesLabels` — the distinguishing attributes, so it reads as
  // the series list's card for the same series.
  function markContext(entry: SeriesEntry): MarkContext {
    return {
      unit: entry.meta?.measurementUnit ?? '',
      label: app.visibleSeries.length > 1 ? (app.seriesLabels.get(entry.key) ?? null) : null,
      color: entry.color,
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

<!-- Shift changes what a click does, so the graph has to know about it even
     when the pointer isn't moving. -->
<svelte:window
  onkeydown={(e) => {
    if (e.key === 'Shift') shiftHeld = true;
  }}
  onkeyup={(e) => {
    if (e.key === 'Shift') shiftHeld = false;
  }}
  onblur={() => (shiftHeld = false)}
/>

<section class="graph-pane">
  <!-- Two groups, one grid row each, and the split is the same one the
       Add-series panel's control block draws: what gets *loaded*, then what of
       it gets *shown*. The range is the fetch — `dataKey` is series plus range,
       so changing it sends requests — which is why the loading count is its
       row's aside, while the zoom, a window onto data already in hand, is the
       drawing row's. The alignment is `.control-grid` in app.css, shared with
       the panel; see docs/design.md, "The control block is two groups". -->
  <header class="control-grid">
    <span class="control-label">Range</span>
    <div class="row">
      <div class="ranges">
        <!-- Finishes the row's sentence — *range: last 14 days* — rather than
             being a second thing in the rail's style naming a group. It sits
             outside the track: the track holds the options and nothing else. -->
        <span class="control-word" aria-hidden="true">last</span>
        <div class="btn-group" role="group" aria-label="Time range">
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
        </div>
      </div>
      <span class="span-text" title="The URL pins these absolute bounds">
        {describeSpan(app.range)}
      </span>
      <!-- Always present, so the header doesn't reflow when a fetch starts or
           finishes. On this row because the range is what causes the fetching. -->
      <span class="loading-slot trailing" class:visible={app.anyLoading}>
        Loading {app.loadingCount}…
      </span>
    </div>

    <span class="control-label">Show</span>
    <div class="row draw-options">
      <!-- All drawing switches, not fetch switches: replicates are always
           fetched, both analyses run on data already in hand, so every one of
           these is instant and the details pane is unaffected by all of them. -->
      <div class="points">
        <span class="control-word" aria-hidden="true">points</span>
        <div class="btn-group" role="group" aria-label="Data points">
          {#each POINT_CHOICES as choice (choice.mode)}
            <button
              type="button"
              class="btn btn-compact"
              class:btn-selected={app.pointMode === choice.mode}
              aria-pressed={app.pointMode === choice.mode}
              title={choice.title}
              onclick={() => app.setPointMode(choice.mode)}
            >
              {choice.label}
            </button>
          {/each}
        </div>
      </div>
      <!-- Steps this app found for itself, as opposed to the alert markers,
           which are perfherder's. See changes.ts. -->
      <label
        class="control-toggle"
        title="Mark steps detected in the data itself — not perfherder's alerts"
      >
        <input
          type="checkbox"
          checked={app.changeDetection}
          onchange={(e) => app.setChangeDetection(e.currentTarget.checked)}
        />
        Detected changes
      </label>
      <!-- The shape of a drift the series-list badge states as one number. Off by
           default, unlike the switches around it — see AppState.showTrend. -->
      <!-- Concrete about the window and the statistic, because the first question
           anyone asked about this feature was "what is that line?" — and the honest
           answer is short: a rolling median, not a fit and not a moving average. -->
      <label
        class="control-toggle"
        title="Draw a rolling quartile band: for each push, the median and the middle half (p25–p75) of the 24 pushes centred on it. A rolling median, so it steps between levels rather than gliding like a moving average."
      >
        <input
          type="checkbox"
          checked={app.showTrend}
          onchange={(e) => app.setShowTrend(e.currentTarget.checked)}
        />
        Trend band
      </label>
      <!-- Both the label and the button stay put whether or not there's a zoom:
           swapping in a longer string used to push this whole group onto a second
           row, shoving the graphs down mid-interaction. -->
      <div class="control-aside-line trailing">
        <span class="zoom-label" class:hint={!app.zoom}>
          {app.zoom ? `Zoomed: ${describeSpan(app.zoom)}` : 'Drag the overview to zoom'}
        </span>
        <button
          type="button"
          class="btn btn-compact"
          disabled={!app.zoom}
          onclick={() => app.resetZoom()}
        >
          Reset zoom
        </button>
      </div>
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
      showPoints={app.drawPoints}
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
      showPoints={app.drawPoints}
      showLines={app.drawPoints}
      showAxes={true}
      showAlerts={true}
      showChanges={app.changeDetection}
      interaction="select"
      {highlights}
      {selectedAlert}
      {selectedChange}
      onselect={onDetailSelect}
      onalertselect={onAlertSelect}
      onchangeselect={onChangeSelect}
      alertTip={(hit) => {
        const entry = app.visibleSeries[hit.seriesIndex];
        const alert = entry?.alerts[hit.alertIndex];
        return entry && alert ? alertTooltip(alert, markContext(entry)) : null;
      }}
      changeTip={(hit) => {
        const entry = app.visibleSeries[hit.seriesIndex];
        const change = entry?.changes[hit.changeIndex];
        return entry && change ? changeTooltip(change, markContext(entry)) : null;
      }}
      onhover={(hit, modifiers) => {
        shiftHeld = modifiers.shift;
        app.setHoveredPoint(pointFor(hit));
      }}
      onbrush={(span) => app.setZoom(span)}
      onkeymove={(axis, delta) =>
        axis === 'run' ? app.stepRun(delta) : app.stepReplicate(delta)}
      onkeycompare={() => app.comparePoint(app.selectedPoint)}
      onkeyalert={(delta) => app.stepAlert(delta)}
      onkeyprevious={() => app.compareWithPreviousPush()}
      ariaLabel="Detail graph; click a point to inspect it, shift-click a second to compare, click an alert marker or a detected-change bar to compare the two pushes it spans, P to compare with the previous push, A and shift-A to step between alerts, or use the arrow keys and C to mark a point for comparison"
    />
    {#if app.series.length === 0}
      <p class="overlay-note">Add a series to see data.</p>
    {:else if app.visibleSeries.length === 0}
      <p class="overlay-note">Every series is hidden.</p>
    {:else if !app.hasData}
      <p class="overlay-note">
        {app.anyLoading ? 'Loading…' : 'No data in this time range.'}
      </p>
    {:else if app.noValuesDrawn}
      <!-- Last in the chain, because it is the only one of these that is not a
           problem: the data is there and the user asked for it not to be drawn.
           It exists because `points: None` with the band off is otherwise
           indistinguishable from a broken graph, and it names the two switches
           that lead back out. The marks may still be on the plot underneath — the
           note is pointer-transparent and sits in the middle, clear of the alert
           row at the top and the change bars along the floor. -->
      <p class="overlay-note">
        Data points are hidden. Turn on the trend band, or show run means.
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
    /* The container the header's narrow-width rule measures against. It has to
       be this box and not the viewport: the pane is the elastic middle column of
       a three-column shell, so it is ~600px narrower than the window and the two
       numbers are not interchangeable. Safe to contain — the column is
       `minmax(0, 1fr)`, so nothing inside was sizing it anyway. */
    container: graph-pane / inline-size;
  }
  header {
    /* The label rail, the baseline rule and the column gap come from
       `.control-grid`. Two differences, both because this is a bar over a graph
       rather than a card in a panel:

       - **Two columns, not three.** The panel gives each group's secondary
         controls their own column, which lines the rails up down the block. Here
         that column would reserve its widest member's width (the zoom label's
         23ch plus a button, ~250px) on *every* row, and the range presets need
         every pixel: measured at a 680px pane, a reserved aside column put the
         seven presets on three lines and the header at 156px against this
         layout's 134 (both before the segmented tracks, which cost 4px a row).
         So each aside is the last item of its own row instead, pushed right by
         `.trailing` — a right rail while there is room for one, and the thing
         that wraps first when there isn't.
       - **An 8px row gap** rather than 18px. That figure exists to keep a right
         rail's *second* line with the group above it; no rail here has one, and
         every px of this bar is a px the graph doesn't get. */
    grid-template-columns: auto minmax(0, 1fr);
    row-gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-default);
    font: 13px/1.4 system-ui, sans-serif;
  }
  /* One row per group, wrapping as whole items: each segmented track stays intact
     — wrapping happens *inside* it, see `.btn-group` in app.css — and the
     descriptive text beside it drops to the next line first, which is the order
     that keeps a control usable while the pane narrows. */
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  /* The lowercase word stays on its track's line, and the track shrinks instead.
     Letting this wrap costs a whole line for one word: a flex item whose
     max-content doesn't fit takes a line of its own, so the track dropped below
     "last" and left it alone up there — measured at a 500px pane, where it took
     the header from 166px to 188px. `min-width: 0` is what lets the track narrow
     past its max-content and wrap inside itself instead. */
  .ranges,
  .points {
    display: flex;
    flex-wrap: nowrap;
    /* Baseline, so the word sits level with the *first* row of segments. Centred
       leaves it floating between the two rows once a track wraps, pointing at
       neither. */
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }
  /* The two independent switches sit further from the points group than its own
     buttons do from each other, so the group reads as one control rather than as
     five things in a row. */
  .draw-options {
    column-gap: 16px;
  }
  /* Right rail while the row has room, first thing to wrap when it doesn't. On a
     wrapped line `auto` still pushes it to that line's right edge, so it reads as
     a rail either way. */
  .trailing {
    margin-left: auto;
  }
  /* A flex item's automatic minimum is its *min-content* width, which for
     "2 days" is the width of "days" — nothing above stops a button from shrinking
     to that and wrapping inside itself. Measured before this: at a 552px pane the
     presets started splitting their own labels, and at 424px the group grew from
     77px to 187px for the same seven buttons. */
  header .btn {
    white-space: nowrap;
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
    /* Reserved even when idle: the slot appearing must not be able to push the
       row over its width and take a second line with it. */
    min-width: 8ch;
    color: var(--fg-muted);
    visibility: hidden;
    white-space: nowrap;
  }
  .loading-slot.visible {
    visibility: visible;
  }
  .zoom-label {
    /* Wide enough for the longest form ("Zoomed: Jul 19 – Jul 25") so neither
       this row's width nor the button's position depends on whether a zoom is
       active. */
    min-width: 23ch;
    font-variant-numeric: tabular-nums;
  }
  /* Panes this narrow are a graph about 300px wide, and the only thing that can
     still overflow one is the zoom line: 23ch of reserved label plus a button is
     ~250px of unwrappable row. Give up the reservation there — a zoom whose
     description changes width is a fair trade for a header that stays inside its
     pane — and let the pair wrap. */
  @container graph-pane (width < 360px) {
    .control-aside-line {
      flex-wrap: wrap;
    }
    .zoom-label {
      min-width: 0;
    }
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
