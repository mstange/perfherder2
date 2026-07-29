<script lang="ts">
  // Right pane: everything about the clicked dot, grouped the way the data is
  // structured — build (push), run (job), replicate.

  import type { AppState } from './appState.svelte';
  import {
    formatPValue,
    formatSignedPercent,
    formatSignedValue,
    formatTimestamp,
    formatValue,
  } from './chart';
  import { comparisonLinks, type ComparisonSide } from './compare';
  import DistributionChart from './DistributionChart.svelte';
  import { buildDistribution } from './distribution';
  import { indexInPushValues, MEAN_REPLICATE, pushValues, seriesLabel } from './graphData';
  import {
    bugsInComment,
    bugUrl,
    jobsUrl,
    pushLogRangeUrl,
    revisionUrl,
    splitCommitMessage,
    taskUrl,
    type RepoLinkInfo,
  } from './links';
  import { SIGNIFICANCE_ALPHA } from './stats';

  type Props = { app: AppState };
  let { app }: Props = $props();

  const sel = $derived(app.selection);
  const repo = $derived(sel?.entry.ref.repository ?? '');

  function linkInfoFor(repository: string): RepoLinkInfo | null {
    const info = app.repoInfo.get(repository);
    return info ? { name: info.name, dvcs_type: info.dvcs_type, url: info.url } : null;
  }

  const repoLink = $derived(linkInfoFor(repo));

  // Runs of the same push are retriggers of the same build.
  const retriggerCount = $derived(sel ? sel.push.runs.length - 1 : 0);

  const replicateValues = $derived(sel ? sel.run.values : []);
  const runMean = $derived(sel ? sel.run.mean : 0);
  // Clicking a dot with replicate drawing off selects the run itself, so the
  // headline value is the mean and there is no "replicate i of n" to report.
  const meanSelected = $derived(sel?.replicateIndex === MEAN_REPLICATE);

  const cmp = $derived(app.comparison);

  // Both sides on one axis. Withheld for the `replicate` kind, where each side
  // is a single value and two one-dot strips say less than the push
  // distribution below does.
  const comparisonDistribution = $derived.by(() => {
    if (!cmp || cmp.kind === 'replicate') return null;
    return buildDistribution(
      [cmp.base, cmp.next].map((side) => ({
        label: side.label,
        color: side.color,
        values: side.values,
        markedIndex: side.markedIndex,
      })),
    );
  });

  // Every value the series recorded on the clicked push, as a distribution. The
  // pool is the push's whole replicate cloud — retriggers included — because the
  // question this answers is "how noisy is this measurement on this build";
  // see docs/comparison.md.
  //
  // Suppressed while a comparison is drawing its own chart: one of that chart's
  // two rows *is* this pool, and showing it twice invites the reader to look for
  // a difference between them.
  const pushDistribution = $derived.by(() => {
    if (!sel || comparisonDistribution) return null;
    const values = pushValues(sel.push);
    if (values.length === 0) return null;
    return buildDistribution([
      {
        label: `${sel.push.runs.length} run${sel.push.runs.length === 1 ? '' : 's'}`,
        color: sel.entry.color,
        values,
        markedIndex: indexInPushValues(sel.push, sel.run.datumId, sel.replicateIndex),
      },
    ]);
  });

  // `swapped` means the baseline is the shift-clicked (or hovered) point, so the
  // selection is the *later* side. Reported per side rather than as a footnote,
  // because otherwise "before" silently means "the one you clicked second".
  const baseIsSelection = $derived(cmp ? !cmp.swapped : false);
  const otherRole = $derived(app.comparisonSource === 'hover' ? 'hovering' : 'pinned');

  const cmpLinks = $derived(
    cmp ? comparisonLinks(cmp, linkInfoFor(cmp.base.ref.repository)) : null,
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

  function sideRows(): { side: ComparisonSide; role: string; isBase: boolean }[] {
    if (!cmp) return [];
    return [
      { side: cmp.base, role: baseIsSelection ? 'selected' : otherRole, isBase: true },
      { side: cmp.next, role: baseIsSelection ? otherRole : 'selected', isBase: false },
    ];
  }

  function shortRev(rev: string): string {
    return rev.slice(0, 12);
  }

  function jobDuration(startS: number | null, endS: number | null): string {
    if (!startS || !endS || endS < startS) return '';
    const total = endS - startS;
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }
</script>

<aside class="details">
  <header><h2>Selection</h2></header>

  {#if !sel}
    <p class="empty">Click a point in the graph to see its build, run and value.</p>
  {:else}
    <div class="scroll">
      {#if app.selectionHiddenBySeries}
        <p class="offscreen">
          This series is hidden.
          <button type="button" onclick={() => app.toggleSeriesVisibility(sel.entry.ref)}>
            Show it
          </button>
        </p>
      {:else if !app.selectionInView}
        <p class="offscreen">
          This point is outside the zoomed range.
          <button type="button" onclick={() => app.resetZoom()}>Show it</button>
        </p>
      {/if}
      <!-- The full attribute set, spelled out and labelled. The series list
           deliberately shows only what distinguishes one card from the next
           (see seriesSummary.ts), so this pane is the one place that answers
           "which series is this, exactly?" — every field it has goes here,
           including `application`, which isn't part of the server-composed
           `name` and so was missing before. -->
      <section class="series">
        <!-- Same shape vocabulary as the series list, so the two agree about
             which series this is. -->
        <span
          class="swatch {sel.entry.symbol.shape}"
          style:background={sel.entry.color}
          aria-hidden="true"
        ></span>
        <div>
          <div class="title">
            {sel.entry.meta ? seriesLabel(sel.entry.meta) : `signature ${sel.entry.ref.signatureId}`}
          </div>
          <dl>
            {#if sel.entry.meta?.platform}
              <dt>Platform</dt>
              <dd>{sel.entry.meta.platform}</dd>
            {/if}
            {#if sel.entry.meta?.application}
              <dt>Application</dt>
              <dd>{sel.entry.meta.application}</dd>
            {/if}
            {#if sel.entry.meta?.options}
              <dt>Options</dt>
              <dd>{sel.entry.meta.options}</dd>
            {/if}
            <dt>Repository</dt>
            <dd class="mono">{repo}</dd>
          </dl>
        </div>
      </section>

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
                class="unpin"
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
            <DistributionChart plot={comparisonDistribution} unit={cmp.unit} />
          {/if}

          <ul class="sides">
            {#each sideRows() as row (row.side.label)}
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
                      {@const link = linkInfoFor(row.side.ref.repository)}
                      {#if link}
                        <a
                          href={revisionUrl(link, row.side.push.revision)}
                          target="_blank"
                          rel="noopener"
                          class="mono">{shortRev(row.side.push.revision)}</a
                        >
                      {:else}
                        <span class="mono">{shortRev(row.side.push.revision)}</span>
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
                      {row.side.meta ? seriesLabel(row.side.meta) : `signature ${row.side.ref.signatureId}`}
                      {#if row.side.meta?.platform}· {row.side.meta.platform}{/if}
                    </div>
                  {/if}
                </div>
              </li>
            {/each}
          </ul>

          {#if cmpLinks && (cmpLinks.pushlog || cmpLinks.perfCompare)}
            <div class="cmp-links">
              {#if cmpLinks.pushlog}
                <a href={cmpLinks.pushlog} target="_blank" rel="noopener">what landed</a>
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
      {/if}

      <section>
        <h3>{meanSelected ? 'Run mean' : 'Replicate'}</h3>
        <p class="value">
          {formatValue(sel.value)}
          {#if sel.entry.meta?.measurementUnit}
            <span class="unit">{sel.entry.meta.measurementUnit}</span>
          {/if}
          <span class="muted">
            ({sel.entry.meta?.lowerIsBetter === false ? 'higher' : 'lower'} is better)
          </span>
        </p>
        <dl>
          {#if meanSelected}
            <dt>Replicates</dt>
            <dd>{replicateValues.length} averaged</dd>
          {:else}
            <dt>Replicate</dt>
            <dd>{sel.replicateIndex + 1} of {replicateValues.length}</dd>
            <dt>Run mean</dt>
            <dd>{formatValue(runMean)}</dd>
          {/if}
        </dl>
        <!-- Listed whether or not the dots are drawn: with replicates hidden
             this is the only way to see a run's spread, and picking one from
             here moves the selection ring onto that value. -->
        {#if replicateValues.length > 1}
          <ol class="replicates">
            {#each replicateValues as v, i}
              <li class:selected={i === sel.replicateIndex}>
                <button
                  type="button"
                  onclick={() =>
                    app.selectPoint({
                      repository: repo,
                      signatureId: sel.entry.ref.signatureId,
                      datumId: sel.run.datumId,
                      replicateIndex: i,
                    })}
                >
                  <span class="idx">{i + 1}</span>
                  <span class="num">{formatValue(v)}</span>
                </button>
              </li>
            {/each}
          </ol>
        {/if}
      </section>

      <section>
        <h3>Run</h3>
        <dl>
          <dt>Job</dt>
          <dd>
            {#if sel.run.jobId !== null}
              <a
                href={jobsUrl(repo, sel.push.revision, sel.run.jobId)}
                target="_blank"
                rel="noopener">{sel.run.jobId}</a
              >
              on treeherder
            {:else}
              <a href={jobsUrl(repo, sel.push.revision)} target="_blank" rel="noopener">
                this push
              </a>
              on treeherder
            {/if}
          </dd>
          {#if app.selectedJob}
            {@const job = app.selectedJob}
            <dt>Type</dt>
            <dd class="mono">{job.job_type_name}</dd>
            <dt>Result</dt>
            <dd class:bad={job.result !== 'success'}>{job.result}</dd>
            <dt>Machine</dt>
            <dd class="mono">{job.machine_name}</dd>
            <dt>Started</dt>
            <dd>{job.start_timestamp ? formatTimestamp(job.start_timestamp * 1000) : '—'}</dd>
            <dt>Duration</dt>
            <dd>{jobDuration(job.start_timestamp, job.end_timestamp) || '—'}</dd>
            {#if job.task_id}
              <dt>Task</dt>
              <dd>
                <a href={taskUrl(job.task_id)} target="_blank" rel="noopener" class="mono">
                  {job.task_id}
                </a>
              </dd>
            {/if}
          {:else if app.selectedJobStatus === 'expired'}
            <!-- Treeherder keeps performance data much longer than the jobs
                 that produced it, so for older points there is no job row to
                 describe. Say that, rather than spin on "loading…". -->
            <dt>Details</dt>
            <dd class="muted">
              Job expired — treeherder drops job records after a few months.
            </dd>
          {:else if app.selectedJobStatus === 'failed'}
            <dt>Details</dt>
            <dd class="muted">Job lookup failed.</dd>
          {:else}
            <dt>Details</dt>
            <dd class="muted">loading…</dd>
          {/if}
          {#if retriggerCount > 0}
            <dt>Retriggers</dt>
            <dd>{retriggerCount} other run{retriggerCount === 1 ? '' : 's'} of this push</dd>
            <!-- Worth spelling out only when there is more than one run:
                 otherwise it just repeats the run mean. This is the value the
                 connecting line passes through, which is why the line can sit
                 off a retriggered push's individual dots. -->
            <dt>Push mean</dt>
            <dd>{formatValue(sel.push.mean)}</dd>
          {/if}
        </dl>
      </section>

      <section>
        <h3>Build</h3>
        <dl>
          <dt>Push time</dt>
          <dd>{formatTimestamp(sel.push.x)}</dd>
          <dt>Revision</dt>
          <dd>
            {#if repoLink}
              <a
                href={revisionUrl(repoLink, sel.push.revision)}
                target="_blank"
                rel="noopener"
                class="mono">{shortRev(sel.push.revision)}</a
              >
            {:else}
              <span class="mono">{shortRev(sel.push.revision)}</span>
            {/if}
          </dd>
          {#if app.selectedPush}
            <dt>Author</dt>
            <dd class="wrap">{app.selectedPush.author}</dd>
          {/if}
          {#if app.previousPush && repoLink}
            <dt>Since previous</dt>
            <dd>
              <a
                href={pushLogRangeUrl(repoLink, app.previousPush.revision, sel.push.revision)}
                target="_blank"
                rel="noopener">pushlog</a
              >
            </dd>
          {/if}
        </dl>

        <!-- The spread of everything this series measured on this build. The
             time-series graph shows one dot per replicate at one x, which stacks
             them into a vertical smear; spreading them along the value axis is
             what makes a second mode visible. -->
        {#if pushDistribution}
          <h4>Values on this push</h4>
          <DistributionChart
            plot={pushDistribution}
            unit={sel.entry.meta?.measurementUnit ?? ''}
          />
        {/if}

        {#if app.selectedPush}
          {@const push = app.selectedPush}
          <h4>
            {push.revision_count} commit{push.revision_count === 1 ? '' : 's'}
          </h4>
          <ul class="commits">
            {#each push.revisions.slice(0, 20) as rev (rev.revision)}
              {@const parts = splitCommitMessage(rev.comments)}
              <li>
                <div class="commit-summary">{parts.summary}</div>
                <div class="muted commit-meta">
                  {#if repoLink}
                    <a
                      href={revisionUrl(repoLink, rev.revision)}
                      target="_blank"
                      rel="noopener"
                      class="mono">{shortRev(rev.revision)}</a
                    >
                  {:else}
                    <span class="mono">{shortRev(rev.revision)}</span>
                  {/if}
                  {#each bugsInComment(parts.summary) as bug (bug)}
                    <a href={bugUrl(bug)} target="_blank" rel="noopener">bug {bug}</a>
                  {/each}
                </div>
              </li>
            {/each}
          </ul>
          {#if push.revisions.length > 20}
            <p class="muted">…and {push.revisions.length - 20} more.</p>
          {/if}
        {:else}
          <p class="muted">Loading push details…</p>
        {/if}
      </section>
    </div>
  {/if}
</aside>

<style>
  .details {
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid #d0d7de;
    background: #f6f8fa;
    font: 13px/1.45 system-ui, sans-serif;
  }
  header {
    padding: 10px 12px;
    border-bottom: 1px solid #d0d7de;
  }
  h2 {
    margin: 0;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #57606a;
  }
  .empty {
    padding: 12px;
    margin: 0;
    color: #57606a;
  }
  .offscreen {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: 0 0 10px;
    padding: 6px 8px;
    border: 1px solid #d4a72c;
    border-radius: 6px;
    background: #fff8c5;
    font-size: 12px;
  }
  .offscreen button {
    font: inherit;
    flex: none;
    padding: 2px 8px;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    background: #fff;
    cursor: pointer;
  }
  .offscreen button:hover {
    background: #f3f4f6;
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
    padding: 10px 12px 24px;
  }
  section {
    margin-bottom: 14px;
  }
  section.series {
    display: grid;
    grid-template-columns: 10px 1fr;
    gap: 8px;
    padding-bottom: 10px;
    border-bottom: 1px solid #d0d7de;
  }
  section.series dl {
    margin-top: 3px;
    font-size: 12px;
  }
  .swatch {
    width: 10px;
    height: 10px;
    margin-top: 3px;
    border-radius: 2px;
  }
  .swatch.circle {
    border-radius: 50%;
  }
  .swatch.diamond {
    width: 8px;
    height: 8px;
    margin: 4px 1px 0;
    border-radius: 1px;
    transform: rotate(45deg);
  }
  .title {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  h3 {
    margin: 0 0 4px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #57606a;
  }
  h4 {
    margin: 10px 0 4px;
    font-size: 12px;
    color: #57606a;
  }
  .value {
    margin: 0 0 6px;
    font-size: 18px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .value .unit {
    font-size: 13px;
    font-weight: 400;
    color: #57606a;
  }
  .value .muted {
    font-size: 12px;
    font-weight: 400;
  }
  dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    gap: 2px 8px;
    margin: 0;
  }
  dt {
    color: #57606a;
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  dd.bad {
    color: #cf222e;
  }
  .muted {
    color: #57606a;
  }
  .mono {
    font-family: ui-monospace, monospace;
    font-size: 12px;
  }
  .wrap {
    overflow-wrap: anywhere;
  }
  .replicates {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    margin: 8px 0 0;
    padding: 0;
  }
  .replicates button {
    font: inherit;
    display: flex;
    gap: 4px;
    padding: 1px 5px;
    border: 1px solid #d0d7de;
    border-radius: 4px;
    background: #fff;
    cursor: pointer;
    font-variant-numeric: tabular-nums;
  }
  .replicates button:hover {
    background: #f3f4f6;
  }
  .replicates li.selected button {
    border-color: #0969da;
    background: #ddf4ff;
  }
  .replicates .idx {
    color: #8c959f;
    font-size: 11px;
  }
  /* The comparison sits in a tinted card so the two-point reading is visibly a
     different thing from the single-point sections under it. */
  section.comparison {
    padding: 8px 10px 10px;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    background: #fff;
  }
  /* A hovered comparison is a preview, not a commitment: dashed, to match the
     dashed ring the graph puts around the point it came from. */
  section.comparison.preview {
    border-style: dashed;
    background: #fbfcfd;
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
  .unpin {
    font: inherit;
    font-size: 11px;
    padding: 1px 6px;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    background: #fff;
    cursor: pointer;
  }
  .unpin:hover {
    background: #f3f4f6;
  }
  .cmp-kind {
    margin: 0 0 6px;
    font-size: 11px;
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
    background: #dafbe1;
    color: #0a5c2b;
  }
  .verdict.regression {
    background: #ffebe9;
    color: #a40e26;
  }
  .warn {
    margin: 0 0 8px;
    padding: 5px 7px;
    border: 1px solid #d4a72c;
    border-radius: 6px;
    background: #fff8c5;
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
    color: #8c959f;
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
    border-top: 1px solid #eaeef2;
    font-size: 11px;
  }
  .commits {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .commit-summary {
    overflow-wrap: anywhere;
  }
  .commit-meta {
    display: flex;
    gap: 8px;
    font-size: 12px;
  }
</style>
