<script lang="ts">
  // The comparison between the selected point and a second one — shift-clicked
  // to pin it, or merely hovered, in which case this is a preview that goes
  // away with the pointer. Sits at the top of the details pane, above the
  // single-point sections: when there are two points on screen, the difference
  // between them is the headline and everything else is supporting detail.
  //
  // Its states are all here, because they are one slot: the pinned comparison,
  // the hover preview, the "marked, now move" step of the keyboard path, and
  // the hint that says the gesture exists at all.
  //
  // Two reserved slots, and the reason for both is layout. The full card used to
  // be 508px against the 89px hint it replaced, so sweeping the pointer across
  // dots moved "Replicate" and everything under it by 419px, over and over,
  // which is what reading a graph looks like.
  //
  //   `.cmp-lede`  — the headline, or the hint, or "marked".
  //   `.cmp-chart` — the distribution. **Always.**
  //
  // **Both slots reserve themselves, and neither has a pixel value written
  // down.** Each renders its alternatives on every paint, stacked in the same
  // grid cell and hidden, so the slot is as tall as the tallest thing that can
  // appear in it — measured by the browser, on the spot, rather than by someone
  // with a screenshot. The two `.cmp-*` rules in the styles below are the whole
  // mechanism; what makes it sound in each case is that every stacked state is
  // *hover-independent*, since a sizer the pointer can change reserves nothing.
  //
  // The chart is the whole point of the second slot. There is only ever one
  // distribution on screen, but it used to be drawn by two components in two
  // *places* — this one for a comparison, DetailsPane for the push on its own —
  // each suppressing the other, so swapping between them moved 154px of pane.
  // One chart in one place instead: one strip row for this push, two when
  // comparing, which `distributionHeight` puts `STRIP_ROW_HEIGHT` apart.
  // Reserving the taller buys a chart that never moves and never blinks out —
  // and seeing the distributions while sweeping the pointer is the point of
  // hovering at all.
  //
  // Only a *pinned* comparison gets the rest: the stats table, the side list and
  // the links, below the chart. Pinning is a deliberate act and may reasonably
  // rearrange the pane; hovering may not.

  import type { AppState } from './appState.svelte';
  import {
    formatPValue,
    formatSignedPercent,
    formatSignedValue,
    formatTimestamp,
    formatValue,
  } from '../shared/chart';
  import {
    comparisonLinks,
    hasDistribution,
    type Comparison,
    type ComparisonSide,
  } from './compare';
  import DistributionChart from './DistributionChart.svelte';
  import { buildDistribution, MAX_DISTRIBUTION_SIDES } from './distribution';
  import {
    indexInPushValues,
    pushValues,
    runRangeInPushValues,
    seriesLabel,
  } from './graphData';
  import { jobsUrl, revisionUrl, shortRevision } from '../shared/links';
  import CommitList from './CommitList.svelte';
  import { pushlogCaveat, pushlogLabel } from './pushlog';
  import { SIGNIFICANCE_ALPHA } from '../shared/stats';

  type Props = { app: AppState };
  let { app }: Props = $props();

  const cmp = $derived(app.comparison);

  const pinned = $derived(app.comparisonSource === 'pinned');
  const sel = $derived(app.selection);

  const scales = $derived(app.selectionChart?.scales ?? null);
  const reserveBand = $derived(app.selectionChart?.reserveBand ?? false);

  // The selected push on its own — the same plot DetailsPane used to render
  // further down the pane, moved here so that gaining and losing the second row
  // is the only thing that ever changes about the chart.
  //
  // Derived whether or not it is the one being shown, because it reads only the
  // selection: that makes it hover-independent, which is what lets it double as
  // the sizer holding the slot open when a comparison takes the chart over.
  const restingPlot = $derived.by(() => {
    // Every value the series recorded on this push, retriggers included: the
    // question is "how noisy is this measurement on this build". Below two
    // values there is nothing a strip can say that the headline hasn't — that
    // is every awsy signature, where the backend returns one row carrying the
    // summary value.
    const pool = sel ? pushValues(sel.push) : [];
    if (!sel || pool.length < 2) return null;
    return buildDistribution(
      [
        {
          label: `${sel.push.runs.length} run${sel.push.runs.length === 1 ? '' : 's'}`,
          color: sel.entry.color,
          values: pool,
          markedIndex: indexInPushValues(sel.push, sel.run.datumId, sel.replicateIndex),
          // Which dots came out of the job the user clicked. Only with
          // retriggers: on a single-run push every dot is in the group, and
          // haloing all of them says nothing. A mean selection gets the halo
          // too — no dot to ring, but the cluster it averages is what the
          // reader is looking for.
          markedGroup:
            sel.push.runs.length > 1 ? runRangeInPushValues(sel.push, sel.run.datumId) : null,
        },
      ],
      scales,
    );
  });

  // The two-row form. Both plots pass `app.selectionChart.scales`, so a value
  // sits at the same x whichever is showing and the second row appears without
  // sliding the first.
  const comparisonPlot = $derived(
    cmp && hasDistribution(cmp)
      ? buildDistribution(
          [cmp.base, cmp.next].map((side) => ({
            label: side.label,
            color: side.color,
            values: side.values,
            markedIndex: side.markedIndex,
          })),
          scales,
        )
      : null,
  );

  // The one chart. A replicate comparison has no distribution of its own, so it
  // falls back to the selected push rather than blanking the slot.
  const plot = $derived(comparisonPlot ?? restingPlot);

  const restingUnit = $derived(sel?.entry.meta?.measurementUnit ?? '');
  const plotUnit = $derived((cmp ? cmp.unit : sel?.entry.meta?.measurementUnit) ?? '');

  // A comparison that hasn't happened, drawn to no one: two sides with no
  // values, which is all the chart needs to lay out the taller form. Used only
  // for its height — see `.cmp-chart`. Two empty pools mean no curve, so the
  // density band comes from `reserveBand`, which is the pane's precomputed
  // answer to "could a pool the pointer can reach have one".
  const reservePlot = $derived(
    buildDistribution(
      Array.from({ length: MAX_DISTRIBUTION_SIDES }, () => ({
        label: '—',
        color: 'transparent',
        values: [],
        markedIndex: -1,
      })),
      scales,
    ),
  );

  // `swapped` means the baseline is the shift-clicked (or hovered) point, so the
  // selection is the *later* side. Reported per side rather than as a footnote,
  // because otherwise "before" silently means "the one you clicked second".
  const baseIsSelection = $derived(cmp ? !cmp.swapped : false);
  const otherRole = $derived(app.comparisonSource === 'hover' ? 'hovering' : 'pinned');

  const cmpLinks = $derived(
    cmp ? comparisonLinks(cmp, app.repoLinkFor(cmp.base.ref.repository)) : null,
  );

  // The inline pushlog, and the repository its revisions are browsed in. Both
  // sides share a repository whenever there is a range at all (appState,
  // `pushlogRangeRef`), so the base's record is the right one for every row.
  const pushlogRange = $derived(app.pushlogRange);
  const repoLink = $derived(cmp ? app.repoLinkFor(cmp.base.ref.repository) : null);

  // The fourth link, and the only one that isn't a pure function of the two
  // points: it takes a job lookup and an artifact list per side to know whether
  // both runs uploaded a comparable profile, so it appears a beat after the rest
  // of the card. See AppState.profileComparison.
  const profileCmp = $derived(app.profileComparison);

  // What actually tells the two sides apart, and so what each side's line
  // should say. Across pushes it's the revision; within one push it's the job;
  // within one job the label already carries the replicate index, so the only
  // thing left worth printing is the value.
  const sideDetail = $derived.by((): 'revision' | 'job' | 'value' => {
    if (!cmp) return 'value';
    if (cmp.base.push.revision !== cmp.next.push.revision) return 'revision';
    return cmp.base.run.datumId !== cmp.next.run.datumId ? 'job' : 'value';
  });
  const sidesDifferBySeries = $derived(
    !!cmp && cmp.base.ref.signatureId !== cmp.next.ref.signatureId,
  );
  // Two counterparts of one test in different repositories have identical suite,
  // test and platform, so the series line has to name the repository or it prints
  // the same string twice and explains nothing.
  const sidesDifferByRepo = $derived(
    !!cmp && cmp.base.ref.repository !== cmp.next.ref.repository,
  );

  const sideRows = $derived.by((): { side: ComparisonSide; role: string; isBase: boolean }[] =>
    cmp
      ? [
          { side: cmp.base, role: baseIsSelection ? 'selected' : otherRole, isBase: true },
          { side: cmp.next, role: baseIsSelection ? otherRole : 'selected', isBase: false },
        ]
      : [],
  );
</script>

<!-- Each state defined once, as a snippet, because the lede renders every one
     of them on every paint: the live one, and the others stacked underneath it
     with `visibility: hidden` purely for their height. See `.cmp-lede`. -->

{#snippet headlineBody(c: Comparison | null)}
  <div class="cmp-head">
    <h3>Comparison</h3>
    {#if c && pinned}
      <button
        type="button"
        class="btn unpin"
        title="Stop comparing"
        onclick={() => app.clearComparison()}>Unpin</button
      >
    {:else}
      <span class="muted">shift-click to pin</span>
    {/if}
  </div>
  <p class="value">
    {c ? formatSignedValue(c.medianDelta) : '0'}
    {#if c?.unit}<span class="unit">{c.unit}</span>{/if}
    {#if c && c.medianDeltaFraction !== null}
      <span class="muted">({formatSignedPercent(c.medianDeltaFraction)})</span>
    {/if}
    {#if c && c.direction !== 'none'}
      <span class="verdict {c.direction}">{c.direction}</span>
    {/if}
  </p>
  <!-- Clipped to one line rather than wrapped. The labels are revisions and
       platform strings, so their length is not ours to predict, and a line
       that sometimes becomes two would put the jump straight back. The
       comparison's own kind ("one series, two pushes") is dropped for the
       same reason — it is a second variable-length line saying what the two
       labels here already show. -->
  <p class="cmp-sub muted one-line">
    {#if c}{#if c.kind !== 'replicate'}median,{' '}{/if}{c.base.label} → {c.next
        .label}{:else}&nbsp;{/if}
  </p>
{/snippet}

<!-- The pin is on this very point, so there is nothing to compare yet.
     That's the keyboard path's middle step, and it's also where arrowing
     back onto a pinned point lands, so it has to say what to do next
     rather than look like a comparison that failed. -->
{#snippet markedBody()}
  <p class="cmp-hint marked">
    <span>Marked for comparison — now move to another point.</span>
    <button type="button" class="btn unpin" onclick={() => app.clearComparison()}>
      Unmark
    </button>
  </p>
{/snippet}

<!-- The affordance sits exactly where its result will appear, which is
     the only place a user looking at one selected point would find it.
     Nothing else on screen says the gesture exists.

     The button leads, because "what changed here" is the question a
     single selected point actually raises, and the answer is one click
     rather than a hunt for a dot in the previous push's cloud. The
     gestures below it reach every *other* pair. -->
{#snippet hintBody()}
  <div class="cmp-hint">
    {#if app.previousPush}
      <button
        type="button"
        class="btn cmp-prev"
        title="Pin the push before this one as the comparison (P, with the graph focused)"
        onclick={() => app.compareWithPreviousPush()}
      >
        Compare with the previous push
      </button>
    {/if}
    <p class="muted">
      Shift-click another point to compare it with this one, or press
      <kbd>C</kbd> to mark this one and walk away with the arrow keys.
    </p>
  </div>
{/snippet}

<!-- One structure for every state, so only the *contents* of the two reserved
     slots change as the pointer moves. See the note at the top of this file. -->
<section class="cmp-block" class:carded={!!cmp} class:preview={!!cmp && !pinned}>
  <div class="cmp-lede">
    <!-- The other three states, stacked in the same cell and hidden. They are
         what makes the slot as tall as its tallest state without anyone having
         measured one. -->
    <div data-sizer>{@render hintBody()}</div>
    <div data-sizer>{@render markedBody()}</div>
    <div data-sizer>{@render headlineBody(null)}</div>

    <div>
      {#if cmp}
        {@render headlineBody(cmp)}
      {:else if app.comparisonMarkedHere}
        {@render markedBody()}
      {:else}
        {@render hintBody()}
      {/if}
    </div>
  </div>

  <!-- Always rendered, and always the height of the tallest form a hover can
       produce. This is the slot that used to blink between here and "Values on
       this push". The two sizers are the same component drawn to no one, so
       there is no skeleton to keep in step with the real thing. -->
  <div class="cmp-chart">
    <div data-sizer>
      <DistributionChart plot={reservePlot} {reserveBand} legendDetail={false} />
    </div>
    {#if restingPlot}
      <div data-sizer>
        <DistributionChart plot={restingPlot} unit={restingUnit} {reserveBand} legendDetail />
      </div>
    {/if}
    {#if plot}
      <div>
        <DistributionChart {plot} unit={plotUnit} {reserveBand} legendDetail={pinned || !cmp} />
      </div>
    {/if}
  </div>

  {#if cmp && pinned}
    {#if cmp.warning}
      <p class="warn">{cmp.warning}</p>
    {/if}

    {#if cmp.test}
      {@const t = cmp.test}
      <dl>
        <dt title="Mann-Whitney U, two-sided, computed in this page">Significance</dt>
        <dd>
          p = {formatPValue(t.pValue)} —
          {t.significant ? `significant at ${SIGNIFICANCE_ALPHA}` : 'not significant'}
        </dd>
        <dt
          title="Cliff's delta: how often a value from one side beats one from the other, on a scale from -1 to 1"
          >Effect</dt
        >
        <!-- Two decimals always: δ runs from -1 to 1, so trimming "1.00"
             to "1" loses the only scale the number has. -->
        <dd>{t.effectSize} (δ {t.cliffsDelta.toFixed(2)})</dd>
        <!-- CLES. Named on one side only: with two platform strings for
             labels, "P(windows11-64-24h2-shippable <
             macosx1500-aarch64-shippable)" is wider than the pane. -->
        <dt
          title="Common-language effect size: draw one value from each side at random, and this is how often the second is the lower of the two"
          >Lower</dt
        >
        <dd>{cmp.next.label} in {Math.round(t.cles * 100)}% of pairs</dd>
        <dt>Values</dt>
        <dd>
          {t.nBase} vs {t.nNext}
          {#if t.smallSample}
            <!-- The test is a normal approximation; below a handful of
                 values a side it is conservative rather than wrong, but
                 "not significant" then says very little. -->
            <span class="muted">— too few for a confident verdict</span>
          {/if}
        </dd>
      </dl>
    {/if}

    <ul class="sides">
      {#each sideRows as row (row.side.label)}
        <li>
          <!-- The chart's own key: a solid rule for the emphatic side, a
               dashed one for the baseline. The two sides can share a color
               (one series across two pushes), so the dash is what carries
               the distinction in both places. -->
          <span
            class="key"
            class:dashed={row.isBase}
            style:--key-color={row.side.color}
            aria-hidden="true"
          ></span>
          <div class="side-body">
            <div class="side-head">
              <span class="side-label">{row.side.label}</span>
              <span class="side-role">{row.role}</span>
            </div>
            <div class="side-detail muted">
              {#if sideDetail === 'revision'}
                {@const link = app.repoLinkFor(row.side.ref.repository)}
                {#if link}
                  <a
                    href={revisionUrl(link, row.side.push.revision)}
                    target="_blank"
                    rel="noopener"
                    class="mono">{shortRevision(row.side.push.revision)}</a
                  >
                {:else}
                  <span class="mono">{shortRevision(row.side.push.revision)}</span>
                {/if}
                {formatTimestamp(row.side.push.x)}
              {:else if sideDetail === 'job' && row.side.run.jobId !== null}
                <a
                  href={jobsUrl(
                    row.side.ref.repository,
                    row.side.push.revision,
                    row.side.run.jobId,
                  )}
                  target="_blank"
                  rel="noopener">job {row.side.run.jobId}</a
                >
              {:else if sideDetail === 'job'}
                datum {row.side.run.datumId}
              {:else}
                {formatValue(row.side.value)}{#if cmp.unit}{' '}{cmp.unit}{/if}
              {/if}
            </div>
            {#if sidesDifferBySeries}
              <!-- Two different series: which one each side is matters more
                   than the revision they share. -->
              <div class="side-detail muted">
                {row.side.meta
                  ? seriesLabel(row.side.meta)
                  : `signature ${row.side.ref.signatureId}`}
                {#if row.side.meta?.platform}· {row.side.meta.platform}{/if}
                {#if sidesDifferByRepo}· {row.side.ref.repository}{/if}
              </div>
            {/if}
          </div>
        </li>
      {/each}
    </ul>

    <!-- `profileCmp` is checked separately from `cmpLinks`, which is null for
         two runs of one push — one revision, so no pushlog range and no
         perf.compare — and that is precisely a pair whose profiles are worth
         comparing. -->
    {#if cmpLinks?.pushlog || cmpLinks?.perfCompare || profileCmp}
      <div class="cmp-links">
        {#if cmpLinks?.pushlog}
          <a href={cmpLinks.pushlog} target="_blank" rel="noopener">pushlog</a>
        {/if}
        {#if cmpLinks?.perfCompare}
          <a href={cmpLinks.perfCompare} target="_blank" rel="noopener">perf.compare</a>
        {/if}
        {#if cmpLinks?.perfCompareSubtests}
          <a href={cmpLinks.perfCompareSubtests} target="_blank" rel="noopener">
            subtests
          </a>
        {/if}
        {#if profileCmp}
          <a
            href={profileCmp.url}
            target="_blank"
            rel="noopener"
            title="Compare the two runs' {profileCmp.benchmark} profiles in the Firefox Profiler"
            >profile comparison</a
          >
        {/if}
      </div>
    {/if}

    <!-- What landed in the range. Collapsed, but with the count in the summary:
         the number is most of the answer, and a disclosure that has to be opened
         to find out how much is behind it saves nothing. The row's height is one
         line in every state, so loading it moves nothing below it. -->
    {#if app.pushlogStatus !== 'absent'}
      <details class="pushlog">
        <summary>
          {#if app.pushlogStatus === 'loading'}
            <span class="muted">loading commits…</span>
          {:else if app.pushlogStatus === 'failed'}
            <span class="muted">commits unavailable</span>
          {:else if pushlogRange}
            {pushlogLabel(pushlogRange)}
          {/if}
        </summary>
        {#if pushlogRange}
          {#if pushlogCaveat(pushlogRange)}
            <p class="pushlog-caveat muted">
              {pushlogCaveat(pushlogRange)}
              {#if cmpLinks?.pushlog}
                <a href={cmpLinks.pushlog} target="_blank" rel="noopener">Full pushlog</a>.
              {/if}
            </p>
          {/if}
          <div class="pushlog-body">
            <CommitList commits={pushlogRange.commits} {repoLink} />
          </div>
        {/if}
      </details>
    {/if}
  {/if}
</section>

<style>
  /* One box for every state, with constant padding and a constant border width
     so the chart below the lede sits at the same y whether or not there is a
     comparison to frame. Only the border's *color* and the fill change. */
  .cmp-block {
    padding: 8px 10px 10px;
    border: 1px solid transparent;
    border-radius: 6px;
    margin-bottom: 14px;
  }
  /* Tinted once there are two points, so the two-point reading is visibly a
     different thing from the single-point sections under it. */
  .cmp-block.carded {
    border-color: var(--border-default);
    background: var(--bg-canvas);
  }
  /* A hovered comparison is a preview, not a commitment, and says so on its
     own: the graph's ring no longer stands in for this. That ring now tracks
     the shift key rather than the preview — it answers "what does a click do",
     which is a different question and one the pane can't answer (see
     chartDraw.ts::hoverRingKind). So the dashed border, the quieter fill and
     the "shift-click to pin" hint carry the whole message here. */
  .cmp-block.preview {
    border-style: dashed;
    background: var(--bg-nested-quiet);
  }
  /* The lede reserves itself. Every state is rendered on every paint — the live
     one, and the other three stacked in the same grid cell with
     `visibility: hidden` — so the slot is as tall as its tallest state by
     construction, and the number nobody has to write down is 89px.

     What makes this sound rather than merely convenient: all four states are
     *hover-independent*. Their wording is fixed, `previousPush` and
     `comparisonMarkedHere` are functions of the selection, and the headline is
     three fixed rows because `.cmp-sub` is `.one-line`. So nothing the pointer
     does can change the height of the stack, which is the whole invariant.

     It also tracks changes the old literal couldn't: reword the hint and the
     reserve follows, and a selection with no previous push (no button, so a
     shorter hint) now reserves 64px rather than spending 89px on a state it
     can't reach.

     `min-width: 0` is load-bearing, not tidiness. An auto grid track is floored
     by its items' min-content width, and the headline's `.cmp-sub` is
     `nowrap` — without this the track sizes to the *unwrapped* label, 395px
     against a 273px cell, which scrolls the pane sideways and re-wraps the hint
     against the wider track, making the stack measure the wrong thing. */
  .cmp-lede {
    display: grid;
  }
  .cmp-lede > * {
    grid-area: 1 / 1;
    min-width: 0;
  }
  .cmp-lede > [data-sizer] {
    visibility: hidden;
  }
  /* The chart slot reserves itself the same way, but it cannot stack every
     state: the tall one is a comparison, whose pools arrive with the hover it
     is supposed to be reserving for. So it stacks two *bounds*, both drawn by
     the real component rather than by a skeleton that could drift from it:

       `reservePlot`  two sides with no values — the two-row form, whose legend
                      rows are content-independent because `.key-head` is one
                      clipped line. This is the bound a hover can reach.
       `restingPlot`  the selected push on its own, exactly, since it reads only
                      the selection. Rendered with `legendDetail` on because
                      that is what the resting state shows, whatever the live
                      chart happens to be showing right now.

     The slot is the taller of the two, and both are hover-independent, so the
     slot is. No number is written down anywhere: the canvas heights come from
     `distributionHeight` and the legend heights from the legend.

     It replaces `min-height: 171px`, which was the two-row form measured once
     at the pane's 320px. It also self-corrects where the literal could not —
     `reserveBand` false (an awsy series, which never draws a curve) drops 73px
     of band from the reserve instead of spending it on a state the pointer
     cannot reach.

     Pinning is deliberately outside the budget: it may rearrange the pane,
     hovering may not. */
  .cmp-chart {
    display: grid;
    padding-top: 6px;
  }
  .cmp-chart > * {
    grid-area: 1 / 1;
    min-width: 0;
  }
  .cmp-chart > [data-sizer] {
    visibility: hidden;
  }
  .cmp-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .cmp-head .muted {
    font-size: 11px;
  }
  /* Smaller than `.btn-compact`: these sit inline in a sentence rather than
     in a toolbar. Used nowhere else, so the size stays here. */
  .unpin,
  .cmp-prev {
    font-size: 11px;
    padding: 1px 6px;
  }
  .cmp-hint {
    margin: 0;
    padding: 6px 8px;
    border: 1px dashed var(--border-default);
    border-radius: 6px;
    font-size: 11px;
  }
  .cmp-lede .value {
    margin: 2px 0 0;
    font-size: 18px;
  }
  .cmp-lede .cmp-sub {
    margin: 0;
  }
  .one-line {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cmp-hint p {
    margin: 0;
  }
  .cmp-prev + p {
    margin-top: 6px;
  }
  /* The marked state is a step the user took, not a suggestion, so it reads like
     the comparison card it is about to become. */
  .cmp-hint.marked {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    border-style: solid;
    border-color: var(--accent-muted);
    background: var(--accent-subtle);
  }
  kbd {
    font: inherit;
    font-family: var(--font-mono);
    padding: 0 3px;
    border: 1px solid var(--border-default);
    border-radius: 3px;
    background: var(--bg-canvas);
  }
  /* Not the pane-wide `max-content` label column. A label here can be a platform
     string, and `max-content` on one of those makes the grid wider than the pane
     and pushes every value out of sight. Fixed label column, wrapping values. */
  .cmp-block dl {
    grid-template-columns: 6.5em minmax(0, 1fr);
    font-size: 11px;
  }
  .cmp-block dt,
  .cmp-block dd {
    overflow-wrap: anywhere;
  }
  .cmp-sub {
    margin: 0 0 8px;
    font-size: 11px;
  }
  .verdict {
    font-size: 11px;
    font-weight: 600;
    padding: 1px 6px;
    border-radius: 10px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    vertical-align: 2px;
  }
  .verdict.improvement {
    background: var(--success-subtle);
    color: var(--success-strong-fg);
  }
  .verdict.regression {
    background: var(--danger-subtle);
    color: var(--danger-strong-fg);
  }
  .warn {
    margin: 0 0 8px;
    padding: 5px 7px;
    border: 1px solid var(--attention-border);
    border-radius: 6px;
    background: var(--attention-subtle);
    font-size: 11px;
  }
  .sides {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 11px;
  }
  .sides li {
    display: grid;
    grid-template-columns: 16px 1fr;
    gap: 5px;
    align-items: start;
  }
  /* Duplicated from DistributionChart's legend on purpose — Svelte scopes styles
     per component, and the two keys have to look identical to read as the same
     vocabulary. Change one, change the other. */
  .key {
    height: 0;
    margin-top: 6px;
    border-top: 2px solid var(--key-color);
  }
  .key.dashed {
    border-top-style: dashed;
  }
  .side-body {
    min-width: 0;
  }
  .side-head {
    display: flex;
    gap: 6px;
    align-items: baseline;
  }
  .side-label {
    font-weight: 600;
  }
  .side-role {
    color: var(--fg-subtle);
  }
  .side-detail {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
  .cmp-links {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border-muted);
    font-size: 11px;
  }

  /* The disclosure. `list-style: none` plus the ::marker rule is what it takes
     to replace the default triangle in both engines; the row is one line tall
     in every state, loading included, so nothing below it moves. */
  .pushlog {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border-muted);
    font-size: 11px;
  }

  .pushlog > summary {
    cursor: pointer;
    list-style: none;
    user-select: none;
    line-height: 16px;
  }

  .pushlog > summary::-webkit-details-marker {
    display: none;
  }

  .pushlog > summary::before {
    content: '▸';
    display: inline-block;
    width: 12px;
    color: var(--text-muted);
  }

  .pushlog[open] > summary::before {
    content: '▾';
  }

  .pushlog-caveat {
    margin: 6px 0 0 12px;
  }

  /* Indented to the disclosure's text, so the list reads as its contents. */
  .pushlog-body {
    padding-left: 12px;
  }
</style>
