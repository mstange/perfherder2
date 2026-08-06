<script lang="ts">
  // Right pane: everything about the clicked dot. Ordered by how immediately
  // each fact bears on that dot — value, then the push's whole spread, then the
  // job, then the build — rather than by the shape of the data model, which
  // would put the twenty-commit pushlog first. See graphs.md, "The details
  // pane, top to bottom".

  import './detailsPane.css';
  import { alertStatusLabel, summaryStatusLabel } from './alerts';
  import type { AppState } from './appState.svelte';
  import { formatTimestamp, formatValue } from '../shared/chart';
  import { hasDistribution } from './compare';
  import ComparisonSection from './ComparisonSection.svelte';
  import DistributionChart from './DistributionChart.svelte';
  import { buildDistribution } from './distribution';
  import {
    indexInPushValues,
    MEAN_REPLICATE,
    pushValues,
    replicateGroups,
    runRangeInPushValues,
    seriesLabel,
  } from './graphData';
  import {
    alertSummaryUrl,
    bugsInComment,
    bugUrl,
    jobsUrl,
    pushLogRangeUrl,
    revisionUrl,
    shortRevision,
    splitCommitMessage,
    taskUrl,
  } from '../shared/links';

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

  const repoLink = $derived(app.repoLinkFor(repo));

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

  const alert = $derived(app.selectedAlert);

  // Whether ComparisonSection is drawing a distribution of its own. Both ends
  // read compare.ts::hasDistribution so the two can't disagree about it — see
  // `pushDistribution`, which is suppressed exactly when this is true.
  const comparisonDrawsDistribution = $derived(
    !!app.comparison && hasDistribution(app.comparison),
  );

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
    if (!sel || comparisonDrawsDistribution || pushPool.length < 2) return null;
    return buildDistribution(
      [
        {
          label: `${sel.push.runs.length} run${sel.push.runs.length === 1 ? '' : 's'}`,
          color: sel.entry.color,
          values: pushPool,
          markedIndex: indexInPushValues(sel.push, sel.run.datumId, sel.replicateIndex),
          // Which of these dots came out of the job the user clicked. Only with
          // retriggers: on a single-run push every dot is in the group, and
          // haloing all of them says nothing. A mean selection gets the halo
          // too — no dot to ring, but the cluster it averages is exactly what
          // the reader is looking for.
          markedGroup:
            sel.push.runs.length > 1
              ? runRangeInPushValues(sel.push, sel.run.datumId)
              : null,
        },
      ],
      // The same scales the comparison chart uses, so a value sits at the same x in
      // both and the hover preview replacing this one doesn't slide it sideways.
      app.selectionChart?.scales ?? null,
    );
  });

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
          <button
            type="button"
            class="btn btn-compact"
            onclick={() => app.toggleSeriesVisibility(sel.entry.ref)}
          >
            Show it
          </button>
        </p>
      {:else if !app.selectionInView}
        <p class="offscreen">
          This point is outside the zoomed range.
          <button type="button" class="btn btn-compact" onclick={() => app.resetZoom()}>Show it</button>
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

      <ComparisonSection {app} />

      <!-- Perfherder's own verdict on this build, when it has one. Above the
           single-point sections for the same reason the comparison card is: it
           is a statement about two pushes, and it is the loudest fact about the
           point — a sheriff looking at this graph is usually here because of
           it. Read-only: creating and triaging alerts needs an authenticated
           session, which this app deliberately doesn't have. -->
      {#if alert}
        <section class="alert-card">
          <div class="cmp-head">
            <h3>Alert</h3>
            <a href={alertSummaryUrl(alert.summaryId)} target="_blank" rel="noopener">
              #{alert.summaryId} on perfherder
            </a>
          </div>
          <p class="value">
            {alert.amountPct.toFixed(2)}<span class="unit">%</span>
            <span class="verdict {alert.isRegression ? 'regression' : 'improvement'}">
              {alert.isRegression ? 'regression' : 'improvement'}
            </span>
          </p>
          <p class="cmp-sub muted">
            {formatValue(alert.prevValue)} → {formatValue(alert.newValue)}
            {#if sel.entry.meta?.measurementUnit}{' '}{sel.entry.meta.measurementUnit}{/if}
            <!-- The alert compares this push with the one perfherder analysed
                 before it, which is not always the previous push in *this*
                 graph: a series with no data on a push isn't analysed there. -->
            against the previous analysed push
          </p>
          <dl>
            <dt title="Perfherder's own status for this series' alert">Alert</dt>
            <dd>{alertStatusLabel(alert.alertStatus)}</dd>
            <dt title="The triage state of the whole push's alert summary">Summary</dt>
            <dd>{summaryStatusLabel(alert.summaryStatus)}</dd>
            {#if alert.tValue !== null}
              <!-- Perfherder's own t, not the Mann-Whitney U this pane computes
                   for a comparison. Named as theirs so the two aren't read as
                   one number that disagrees with itself. -->
              <dt title="Perfherder's t-value for the change it detected">t-value</dt>
              <dd>{alert.tValue.toFixed(2)}</dd>
            {/if}
            {#if alert.bugNumber !== null}
              <dt>Bug</dt>
              <dd>
                <a href={bugUrl(alert.bugNumber)} target="_blank" rel="noopener">
                  {alert.bugNumber}
                </a>
              </dd>
            {/if}
          </dl>
        </section>
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
                        class="btn"
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
            <!-- Profiles the run uploaded, linked into profiler.firefox.com
                 rather than at the file: an artifact named `profile_*` is one
                 the profiler can open, and downloading a zip to re-upload it is
                 the step this row removes. Same rule and same URLs as
                 treeherder's artifact list.

                 Drawn as soon as there is a task to ask about — "loading…"
                 included — rather than appearing a beat after the rest of the
                 job details land, because it is not a rare row: nearly every
                 perf job uploads at least the resource-usage profile. -->
            {#if app.selectedProfilesStatus !== 'absent'}
              <dt title="Artifacts named profile_*, opened in profiler.firefox.com">
                Profiles
              </dt>
              <dd>
                {#if app.selectedProfilesStatus === 'loading'}
                  <span class="muted">loading…</span>
                {:else if app.selectedProfilesStatus === 'failed'}
                  <span class="muted">Artifact lookup failed.</span>
                {:else if app.selectedProfiles.length === 0}
                  <span class="muted">none uploaded</span>
                {:else}
                  <ul class="profiles">
                    {#each app.selectedProfiles as profile (profile.artifact)}
                      <li>
                        <a
                          href={profile.url}
                          target="_blank"
                          rel="noopener"
                          title="Open {profile.artifact} in the Firefox Profiler"
                          >{profile.label}</a
                        >
                      </li>
                    {/each}
                  </ul>
                {/if}
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
                class="mono">{shortRevision(sel.push.revision)}</a
              >
            {:else}
              <span class="mono">{shortRevision(sel.push.revision)}</span>
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
                      class="mono">{shortRevision(rev.revision)}</a
                    >
                  {:else}
                    <span class="mono">{shortRevision(rev.revision)}</span>
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
    flex: none;
  }
  .scroll {
    flex: 1;
    overflow-y: auto;
    padding: 10px 12px 24px;
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
  h4 {
    margin: 10px 0 4px;
    font-size: 12px;
    color: var(--fg-muted);
  }
  dd.bad {
    color: var(--danger-fg);
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
  /* One profile per line. A run has one or two of these and their labels are
     test names, so a wrapped inline run of them would read as one phrase —
     "idb-open-many-seq resource-usage" — rather than as two links. */
  .profiles {
    list-style: none;
    margin: 0;
    padding: 0;
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
  /* Chrome from `.btn`; the size is this list's own — see the measurement
     above, which is what decides how much of a retriggered push fits. */
  .replicates button {
    font-size: 12px;
    padding: 1px 4px;
    border-radius: 4px;
    /* Aligned digits, so a run's spread reads down the column the wrapping
       happens to make of it. */
    font-variant-numeric: tabular-nums;
  }
  /* `.btn` in the selector, not just on the element: it has to outrank
     `.btn:hover` in app.css, or pointing at the selected value drops its
     accent fill. */
  .replicates li.selected button.btn,
  .replicates li.selected button.btn:hover {
    border-color: var(--accent-emphasis);
    background: var(--accent-subtle);
  }
  /* Carded like the comparison, for the same reason: it is a two-push statement
     sitting above a run of single-point sections. Its own border color, because
     an alert is somebody else's finding about this build rather than something
     this pane computed. */
  section.alert-card {
    padding: 8px 10px 10px;
    border: 1px solid var(--attention-border);
    border-radius: 6px;
    background: var(--bg-canvas);
  }
  section.alert-card dl {
    grid-template-columns: 6.5em minmax(0, 1fr);
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
