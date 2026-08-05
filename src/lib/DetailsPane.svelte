<script lang="ts">
  // Right pane: everything about the clicked dot. Ordered by how immediately
  // each fact bears on that dot — value, then the push's whole spread, then the
  // job, then the build — rather than by the shape of the data model, which
  // would put the twenty-commit pushlog first. See graphs.md, "The details
  // pane, top to bottom".

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
  import {
    indexInPushValues,
    MEAN_REPLICATE,
    pushValues,
    replicateGroups,
    seriesLabel,
  } from './graphData';
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

  // Said in two places — over the selected replicate's rank and over each run's
  // list of values — so it lives in one. See `Run.values`: the index is a rank
  // over values we sorted ourselves, because the API neither orders its
  // replicate rows nor says which trial each came from.
  const REPLICATE_ORDER_HINT =
    'Replicates are ordered by value: treeherder returns them in an arbitrary ' +
    'order and does not yet expose which trial each came from (bug 1981623)';

  const sel = $derived(app.selection);
  const repo = $derived(sel?.entry.ref.repository ?? '');

  function linkInfoFor(repository: string): RepoLinkInfo | null {
    const info = app.repoInfo.get(repository);
    return info ? { name: info.name, dvcs_type: info.dvcs_type, url: info.url } : null;
  }

  const repoLink = $derived(linkInfoFor(repo));

  // Every value the build recorded, grouped by job. More than one group means
  // the push was retriggered.
  const runGroups = $derived(
    sel ? replicateGroups(sel.push, sel.run.datumId, sel.replicateIndex) : [],
  );

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
      // The scales are the selection's, not this pair's, so sweeping the pointer
      // across pushes doesn't rescale the chart on every dot. See
      // AppState.selectionChart.
      app.selectionChart?.scales ?? null,
    );
  });

  // Every value the series recorded on the clicked push — retriggers included,
  // because the question the section answers is "how noisy is this measurement on
  // this build"; see docs/comparison.md.
  //
  // Below two values there is nothing to say that the headline value above hasn't
  // already said, and the whole section is dropped. Where a harness records no
  // replicates the backend falls back to one row carrying the summary value, so
  // the "distribution" would be a strip with a single dot on it and the chip list
  // a single chip repeating the number above. That is every awsy signature (talos,
  // by contrast, records 20 replicates for a ts_paint).
  const pushPool = $derived(sel ? pushValues(sel.push) : []);

  // Suppressed while a comparison is drawing its own chart: one of that chart's
  // two rows *is* this pool, and showing it twice invites the reader to look for
  // a difference between them.
  const pushDistribution = $derived.by(() => {
    if (!sel || comparisonDistribution || pushPool.length < 2) return null;
    return buildDistribution(
      [
        {
          label: `${sel.push.runs.length} run${sel.push.runs.length === 1 ? '' : 's'}`,
          color: sel.entry.color,
          values: pushPool,
          markedIndex: indexInPushValues(sel.push, sel.run.datumId, sel.replicateIndex),
        },
      ],
      // The same scales the comparison chart uses, so a value sits at the same x in
      // both and the hover preview replacing this one doesn't slide it sideways.
      app.selectionChart?.scales ?? null,
    );
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
    <p class="empty">
      Click a point in the graph to see its build, run and value. Shift-click a second
      point to compare the two.
    </p>
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
          <button type="button" class="unpin" onclick={() => app.clearComparison()}>
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
              class="cmp-prev"
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

      <section>
        <!-- "Replicate" and "Run mean" both promise a set this value came out of.
             With one measurement there is no such set — the common case for the
             frameworks that record no replicates — so it's just the value. -->
        <h3>{meanSelected ? 'Run mean' : replicateValues.length > 1 ? 'Replicate' : 'Value'}</h3>
        <p class="value">
          {formatValue(sel.value)}
          {#if sel.entry.meta?.measurementUnit}
            <span class="unit">{sel.entry.meta.measurementUnit}</span>
          {/if}
          <span class="muted">
            ({sel.entry.meta?.lowerIsBetter === false ? 'higher' : 'lower'} is better)
          </span>
        </p>
        {#if replicateValues.length > 1}
          <dl>
            {#if meanSelected}
              <dt>Replicates</dt>
              <dd>{replicateValues.length} averaged</dd>
            {:else}
              <!-- A rank, not a trial number. Trial ordering isn't implemented
                   on the API side (bug 1981623): the endpoint returns a datum's
                   replicate rows in a different order on every request and exposes
                   no trial number, so we sort by value and say so rather than
                   implying an execution order we don't have. See graphData.ts,
                   `Run.values`. -->
              <dt title={REPLICATE_ORDER_HINT}>Replicate</dt>
              <dd>
                {sel.replicateIndex + 1} of {replicateValues.length}
                <span class="muted">by value</span>
              </dd>
              <dt>Run mean</dt>
              <dd>{formatValue(runMean)}</dd>
            {/if}
          </dl>
        {/if}
      </section>

      <!-- Directly under the selected value, because it is the context that
           value needs: a number 3% off the last one means one thing when the
           build's own replicates span 1% and another when they span 10%. It used
           to sit at the bottom of the Build section, below the commit list,
           where it was off-screen unless you went looking.
           `pushValues` explains why the pool is the whole push. -->
      {#if pushPool.length > 1}
        <section>
          <h3>Values on this push</h3>
          {#if pushDistribution}
            <DistributionChart
              plot={pushDistribution}
              unit={sel.entry.meta?.measurementUnit ?? ''}
              reserveBand={app.selectionChart?.reserveBand ?? false}
            />
          {/if}
          <!-- Every run of the push, not just the selected one: the pane used to
               list the clicked run's values alone, which made a retriggered build
               look like it recorded five numbers when it recorded fifteen, and
               left the other runs' values reachable only by hunting for their
               dots on the graph. Listed whether or not the dots are drawn — with
               replicates hidden this is the only way to see the spread — and
               ascending, since there's no execution order to show instead. -->
          <ul class="runs">
            {#each runGroups as group (group.run.datumId)}
              <li class:selected={group.selectedRun}>
                <div class="run-head">
                  <span class="run-name">
                    {runGroups.length > 1
                      ? `Run ${group.ordinal} of ${runGroups.length}`
                      : 'Replicates'}
                  </span>
                  <!-- Only worth a link when there's more than one run; with a
                       single one this would repeat the Run section right below. -->
                  {#if runGroups.length > 1 && group.run.jobId !== null}
                    <a
                      href={jobsUrl(repo, sel.push.revision, group.run.jobId)}
                      target="_blank"
                      rel="noopener">job {group.run.jobId}</a
                    >
                  {/if}
                  {#if group.run.values.length > 1}
                    <!-- Selectable, not just printed. A run's mean is a point the
                         app has — it's what the `means` drawing mode plots, and
                         what a `sel=…,-1` link names — but with replicates drawn
                         its dot isn't on the graph, so clicking a chip below used
                         to be a one-way door: nothing in the pane led back to the
                         run as a whole. It stays in the head rather than joining
                         the chip row, because a mean sitting in a row of measured
                         values is a different kind of number wearing the same
                         clothes. -->
                    <button
                      type="button"
                      class="run-mean"
                      class:selected={group.selectedRun && meanSelected}
                      aria-pressed={group.selectedRun && meanSelected}
                      title="Select this run's mean"
                      onclick={() =>
                        app.selectPoint({
                          repository: repo,
                          signatureId: sel.entry.ref.signatureId,
                          datumId: group.run.datumId,
                          replicateIndex: MEAN_REPLICATE,
                        })}
                    >
                      mean {formatValue(group.run.mean)}
                    </button>
                  {/if}
                </div>
                <!-- Values only. The chips used to lead with the replicate's
                     index, which cost about a quarter of each chip's width — two
                     fewer per line — to print a number that means nothing: it's a
                     rank over values we sorted ourselves (see `Run.values`), so it
                     names no trial and no order the harness ran in. An `<ol>`
                     still, because ascending *is* the order, and assistive tech
                     can number the items itself if it wants to. -->
                <ol class="replicates" title={REPLICATE_ORDER_HINT}>
                  {#each group.run.values as v, i}
                    <li class:selected={i === group.selectedIndex}>
                      <button
                        type="button"
                        onclick={() =>
                          app.selectPoint({
                            repository: repo,
                            signatureId: sel.entry.ref.signatureId,
                            datumId: group.run.datumId,
                            replicateIndex: i,
                          })}
                      >
                        {formatValue(v)}
                      </button>
                    </li>
                  {/each}
                </ol>
              </li>
            {/each}
          </ul>
          <!-- The value the connecting line passes through, which is why the line
               can sit off a retriggered push's individual dots. Only worth
               spelling out when there is more than one run; otherwise it just
               repeats the run mean above. -->
          {#if runGroups.length > 1}
            <dl class="push-mean">
              <dt>Push mean</dt>
              <dd>{formatValue(sel.push.mean)}</dd>
            </dl>
          {/if}
        </section>
      {/if}

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
            <!-- Last on purpose. It reads "success" for all but a handful of
                 points — a job that failed outright recorded no performance
                 data to click on — so it's the least informative line here,
                 and putting it near the top pushed the facts that do vary
                 (machine, duration) down the pane. Kept rather than dropped
                 because `bad` styling makes the rare exception jump out. -->
            <dt>Result</dt>
            <dd class:bad={job.result !== 'success'}>{job.result}</dd>
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
    border-left: 1px solid var(--border-default);
    background: var(--bg-subtle);
    font: 13px/1.45 system-ui, sans-serif;
  }
  header {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border-default);
  }
  h2 {
    margin: 0;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--fg-muted);
  }
  .empty {
    padding: 12px;
    margin: 0;
    color: var(--fg-muted);
  }
  .offscreen {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: 0 0 10px;
    padding: 6px 8px;
    border: 1px solid var(--attention-border);
    border-radius: 6px;
    background: var(--attention-subtle);
    font-size: 12px;
  }
  .offscreen button {
    font: inherit;
    flex: none;
    padding: 2px 8px;
    border: 1px solid var(--border-default);
    border-radius: 6px;
    background: var(--bg-canvas);
    cursor: pointer;
  }
  .offscreen button:hover {
    background: var(--bg-hover);
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
    border-bottom: 1px solid var(--border-default);
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
    color: var(--fg-muted);
  }
  h4 {
    margin: 10px 0 4px;
    font-size: 12px;
    color: var(--fg-muted);
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
    color: var(--fg-muted);
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
    color: var(--fg-muted);
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  dd.bad {
    color: var(--danger-fg);
  }
  .muted {
    color: var(--fg-muted);
  }
  .mono {
    font-family: ui-monospace, monospace;
    font-size: 12px;
  }
  .wrap {
    overflow-wrap: anywhere;
  }
  /* One block per run of the push. The vertical rule is what keeps a
     three-retrigger push from reading as one long undifferentiated chip field:
     the values of one job belong together. */
  .runs {
    list-style: none;
    margin: 6px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .runs > li {
    padding-left: 7px;
    border-left: 2px solid var(--border-muted);
  }
  .runs > li.selected {
    border-left-color: var(--accent-emphasis);
  }
  .run-head {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    font-size: 11px;
    color: var(--fg-muted);
  }
  /* The run the selection is in, named plainly while the others stay muted. It
     carries the mark on its own for a run-mean selection, where no individual
     value is highlighted. */
  .runs > li.selected .run-name {
    font-weight: 600;
    color: var(--fg-default);
  }
  /* Quieter than a replicate chip — borderless until it's hovered or selected —
     because it sits in the muted head line and must not read as a fifth
     measurement in a run of four. */
  .run-mean {
    font: inherit;
    font-size: 11px;
    padding: 0 4px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: none;
    color: inherit;
    cursor: pointer;
    font-variant-numeric: tabular-nums;
  }
  .run-mean:hover {
    border-color: var(--border-default);
    background: var(--bg-hover);
  }
  .run-mean.selected {
    border-color: var(--accent-emphasis);
    background: var(--accent-subtle);
    color: var(--fg-default);
  }
  .push-mean {
    margin-top: 8px;
  }
  /* One chip per measurement, so how many fit on a line decides how much of a
     retriggered push is readable without scrolling. 12px and 4px of side padding,
     against the pane's 13px and 5px — small enough to matter, still a comfortable
     click target. Measured on a 12-retrigger push of 5 replicates each: 59.2px per
     chip before this and the index came off, 43.8px after, which takes each run
     from two lines to one, the section from 1088px to 787px, and the pane's whole
     scroll height from 1916px to 1615px. */
  .replicates {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    margin: 4px 0 0;
    padding: 0;
  }
  .replicates button {
    font: inherit;
    font-size: 12px;
    padding: 1px 4px;
    border: 1px solid var(--border-default);
    border-radius: 4px;
    background: var(--bg-canvas);
    cursor: pointer;
    /* Aligned digits, so a run's spread reads down the column the wrapping
       happens to make of it. */
    font-variant-numeric: tabular-nums;
  }
  .replicates button:hover {
    background: var(--bg-hover);
  }
  .replicates li.selected button {
    border-color: var(--accent-emphasis);
    background: var(--accent-subtle);
  }
  /* The comparison sits in a tinted card so the two-point reading is visibly a
     different thing from the single-point sections under it. */
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
  .unpin,
  .cmp-prev {
    font: inherit;
    font-size: 11px;
    padding: 1px 6px;
    border: 1px solid var(--border-default);
    border-radius: 6px;
    background: var(--bg-canvas);
    cursor: pointer;
  }
  .unpin:hover,
  .cmp-prev:hover {
    background: var(--bg-hover);
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
    font-family: ui-monospace, monospace;
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
