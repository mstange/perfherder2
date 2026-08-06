<script lang="ts">
  // The comparison between the selected point and a second one — shift-clicked
  // to pin it, or merely hovered, in which case this is a preview that goes
  // away with the pointer. Sits at the top of the details pane, above the
  // single-point sections: when there are two points on screen, the difference
  // between them is the headline and everything else is supporting detail.
  //
  // Its three states are all here, because they are one slot: the comparison
  // itself, the "marked, now move" step of the keyboard path, and the hint that
  // says the gesture exists at all.

  import type { AppState } from './appState.svelte';
  import {
    formatPValue,
    formatSignedPercent,
    formatSignedValue,
    formatTimestamp,
    formatValue,
  } from '../shared/chart';
  import { comparisonLinks, hasDistribution, type ComparisonSide } from './compare';
  import DistributionChart from './DistributionChart.svelte';
  import { buildDistribution } from './distribution';
  import { seriesLabel } from './graphData';
  import { jobsUrl, revisionUrl, shortRevision } from '../shared/links';
  import { SIGNIFICANCE_ALPHA } from '../shared/stats';

  type Props = { app: AppState };
  let { app }: Props = $props();

  const cmp = $derived(app.comparison);

  // Both sides on one axis. Withheld for the `replicate` kind, where each side
  // is a single value — see compare.ts::hasDistribution, which the details pane
  // also reads so it knows to keep its own push distribution.
  const comparisonDistribution = $derived.by(() => {
    if (!cmp || !hasDistribution(cmp)) return null;
    return buildDistribution(
      [cmp.base, cmp.next].map((side) => ({
        label: side.label,
        color: side.color,
        values: side.values,
        markedIndex: side.markedIndex,
      })),
      // The scales are the selection's, not this pair's, so sweeping the pointer
      // across pushes doesn't rescale the chart on every dot. See
      // AppState.selectionChart.
      app.selectionChart?.scales ?? null,
    );
  });

  // `swapped` means the baseline is the shift-clicked (or hovered) point, so the
  // selection is the *later* side. Reported per side rather than as a footnote,
  // because otherwise "before" silently means "the one you clicked second".
  const baseIsSelection = $derived(cmp ? !cmp.swapped : false);
  const otherRole = $derived(app.comparisonSource === 'hover' ? 'hovering' : 'pinned');

  const cmpLinks = $derived(
    cmp ? comparisonLinks(cmp, app.repoLinkFor(cmp.base.ref.repository)) : null,
  );

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

<!-- Above the single-point sections, because when there are two points on
     screen the difference between them is the headline and everything
     below is supporting detail. A hovered comparison is styled as a
     preview: it isn't the user's yet, and it disappears when the pointer
     leaves the graph. -->
{#if cmp}
  <section class="comparison" class:preview={app.comparisonSource === 'hover'}>
    <div class="cmp-head">
      <h3>Comparison</h3>
      {#if app.comparisonSource === 'pinned'}
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
    <p class="cmp-kind muted">{cmp.headline}</p>

    <p class="value">
      {formatSignedValue(cmp.medianDelta)}
      {#if cmp.unit}<span class="unit">{cmp.unit}</span>{/if}
      {#if cmp.medianDeltaFraction !== null}
        <span class="muted">({formatSignedPercent(cmp.medianDeltaFraction)})</span>
      {/if}
      {#if cmp.direction !== 'none'}
        <span class="verdict {cmp.direction}">{cmp.direction}</span>
      {/if}
    </p>
    <p class="cmp-sub muted">
      <!-- "median" only where there is a distribution to take one of; two
           replicates of a job are just two numbers. -->
      {#if cmp.kind !== 'replicate'}median,{' '}{/if}{cmp.base.label} → {cmp.next.label}
    </p>

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

    {#if comparisonDistribution}
      <DistributionChart
        plot={comparisonDistribution}
        unit={cmp.unit}
        reserveBand={app.selectionChart?.reserveBand ?? false}
      />
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

    {#if cmpLinks && (cmpLinks.pushlog || cmpLinks.perfCompare)}
      <div class="cmp-links">
        {#if cmpLinks.pushlog}
          <a href={cmpLinks.pushlog} target="_blank" rel="noopener">pushlog</a>
        {/if}
        {#if cmpLinks.perfCompare}
          <a href={cmpLinks.perfCompare} target="_blank" rel="noopener">perf.compare</a>
        {/if}
        {#if cmpLinks.perfCompareSubtests}
          <a href={cmpLinks.perfCompareSubtests} target="_blank" rel="noopener">
            subtests
          </a>
        {/if}
      </div>
    {/if}
  </section>
{:else if app.comparisonMarkedHere}
  <!-- The pin is on this very point, so there is nothing to compare yet.
       That's the keyboard path's middle step, and it's also where arrowing
       back onto a pinned point lands, so it has to say what to do next
       rather than look like a comparison that failed. -->
  <p class="cmp-hint marked">
    <span>Marked for comparison — now move to another point.</span>
    <button type="button" class="btn unpin" onclick={() => app.clearComparison()}>
      Unmark
    </button>
  </p>
{:else}
  <!-- The affordance sits exactly where its result will appear, which is
       the only place a user looking at one selected point would find it.
       Nothing else on screen says the gesture exists.

       The button leads, because "what changed here" is the question a
       single selected point actually raises, and the answer is one click
       rather than a hunt for a dot in the previous push's cloud. The
       gestures below it reach every *other* pair. -->
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
{/if}

<style>
  section.comparison {
    padding: 8px 10px 10px;
    border: 1px solid var(--border-default);
    border-radius: 6px;
    background: var(--bg-canvas);
  }
  /* A hovered comparison is a preview, not a commitment: dashed, to match the
     dashed ring the graph puts around the point it came from. */
  section.comparison.preview {
    border-style: dashed;
    background: var(--bg-nested-quiet);
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
  .cmp-kind {
    margin: 0 0 6px;
    font-size: 11px;
  }
  .cmp-hint {
    margin: 0 0 14px;
    padding: 6px 8px;
    border: 1px dashed var(--border-default);
    border-radius: 6px;
    font-size: 11px;
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
  section.comparison dl {
    grid-template-columns: 6.5em minmax(0, 1fr);
    font-size: 11px;
  }
  section.comparison dt,
  section.comparison dd {
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
</style>
