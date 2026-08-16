<script lang="ts">
  // Right pane: everything about the clicked dot. Ordered by how immediately
  // each fact bears on that dot — value, then the push's whole spread, then the
  // job, then the build — rather than by the shape of the data model, which
  // would put the twenty-commit pushlog first. See graphs.md, "The details
  // pane, top to bottom".

  import './detailsPane.css';
  import {
    alertDelta,
    alertStatusLabel,
    signedAmountFraction,
    summaryStatusLabel,
  } from './alerts';
  import type { AppState, Selection } from './appState.svelte';
  import {
    formatPValue,
    formatSignedPercent,
    formatTimestamp,
    formatValue,
  } from '../shared/chart';
  import ComparisonSection from './ComparisonSection.svelte';
  import { MEAN_REPLICATE, pushValues, replicateGroups, seriesLabel } from './graphData';
  import {
    alertSummaryUrl,
    bugUrl,
    jobsUrl,
    revisionUrl,
    shortRevision,
    taskUrl,
  } from '../shared/links';
  import ChangeHeadline from './ChangeHeadline.svelte';
  import CommitList from './CommitList.svelte';
  import { landingSeriesCount, landingWindowLabel } from './cluster';
  import { jobDuration, shortJobType } from './job';
  import { commitsOfPush } from './pushlog';

  import { isCoarsePointer, mediaMatcher } from '../shared/pointer';

  type Props = { app: AppState };
  let { app }: Props = $props();

  // Which gestures this reader has, for the empty state's instruction. See
  // shared/pointer.ts, and design.md, "Copy that names a gesture has to name one
  // the reader has".
  const coarsePointer = isCoarsePointer(mediaMatcher);

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
  const change = $derived(app.selectedChange);
  // The other series that step where this one does, if any — see the Landing
  // block in the change card.
  const landing = $derived(app.selectedLanding);

  // Only whether there is a spread worth listing. The chart built from this pool
  // lives in ComparisonSection now, as the one-row form of the one chart the
  // pane draws; `pushValues` explains why the pool is the whole push.
  const pushPool = $derived(sel ? pushValues(sel.push) : []);

  // Where "Values on this push" stops being a list and starts being a wall.
  // Measured on autoland signature 299010: one run 114px, three 341px, and the
  // seven-retrigger push that prompted this 386px — a fifth of the whole pane
  // for a spread the chart above already draws with the clicked run haloed.
  // More runs than this and the section folds. The height is really driven by
  // replicate chips rather than by run count, so three unfolded is still not
  // short; the run count is what a reader can see coming.
  const MANY_RUNS = 3;
</script>

<!-- Every run of the push, not just the selected one: the pane used to list the
     clicked run's values alone, which made a retriggered build look like it
     recorded five numbers when it recorded fifteen, and left the other runs'
     values reachable only by hunting for their dots on the graph. Listed
     whether or not the dots are drawn — with replicates hidden this is the only
     way to see the spread — and ascending, since there's no execution order to
     show instead.

     A snippet because it is rendered from two places now, folded and not. -->
{#snippet runList(sel: Selection)}
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
{/snippet}

<aside class="details">
  <header><h2>Selection</h2></header>

  {#if !sel}
    <p class="empty">
      {#if coarsePointer}
        Tap a point in the graph to see its build, run and value. Tap a
        detected-change bar to compare the two pushes it spans.
      {:else}
        Click a point in the graph to see its build, run and value. Shift-click a
        second point to compare the two.
      {/if}
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
          <!-- `amountPct` is a magnitude and `is_regression` carries the
               direction, so this was the card printing an unsigned number
               beside two signed ones. `alerts.ts` puts it in the same terms as
               the others; the sign is the one the values below it show. -->
          <ChangeHeadline
            percent={signedAmountFraction(alert)}
            delta={alertDelta(alert)}
            unit={sel.entry.meta?.measurementUnit ?? ''}
            verdict={alert.isRegression ? 'regression' : 'improvement'}
          />
          <p class="cmp-sub muted">
            {formatValue(alert.prevValue)} → {formatValue(alert.newValue)}
            {#if sel.entry.meta?.measurementUnit}{' '}{sel.entry.meta.measurementUnit}{/if}
            <!-- Not "against the previous push", which this said until the
                 numbers were checked against treeherder. `prev_value` and
                 `new_value` are `historical_stats["avg"]` and
                 `forward_stats["avg"]` (treeherder/perf/alerts.py) — means over
                 a window of 12-24 data points back and 12 forward, not over one
                 push each. On alert #51605 that is +121% where the two pushes
                 alone moved +194%, so a reader who took this for a two-push
                 figure would think the comparison card below contradicted it.
                 It doesn't; they measure different things, and both say which. -->
            perfherder's window averages, 12–24 pushes before against 12 after
          </p>
          <dl>
            <!-- One row for the two triage states. They are different facts —
                 this series' alert against the whole push's summary — so both
                 are still here and the second is still named; what they are not
                 is two findings, and two labelled rows in a card this size read
                 as two. -->
            <dt
              title="Perfherder's status for this series' alert, then the triage state of the whole push's alert summary"
              >Triage</dt
            >
            <!-- A reassigned alert is drawn on the push it was reassigned *to*,
                 so the marker is deliberately not on the push perfherder's
                 analysis flagged — which this has to name, or the card and the
                 summary link above it quietly disagree with the alert view.
                 "from" once the move happened, "to" when it couldn't (the target
                 push isn't in this graph, or its lookup failed) and the marker is
                 still on the detected push. Perfherder's alert table words the
                 two cases the same way. `{' '}` per the whitespace gotcha in
                 design.md: the space before a block is otherwise stripped. -->
            <dd>
              {alertStatusLabel(alert.alertStatus)}
              {#if alert.reassignment}
                {@const moved = alert.reassignment.toSummaryId === alert.summaryId}
                {@const other = moved
                  ? alert.reassignment.fromSummaryId
                  : alert.reassignment.toSummaryId}
                {' '}{moved ? 'from' : 'to'}{' '}<a
                  href={alertSummaryUrl(other)}
                  target="_blank"
                  rel="noopener">#{other}</a
                >
              {/if}
              <span class="muted">· summary {summaryStatusLabel(alert.summaryStatus)}</span>
            </dd>
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

      <!-- This app's own reading of the same build, when it found a step there.
           Below the Alert card because perfherder's verdict is the one a
           sheriff came for and is the only one with a bug number attached, and
           above the single-point sections for the reason the Alert card is:
           it's a statement about two stretches of the graph rather than about
           the dot. Most of the time only one of the two cards exists — that is
           rather the point of having this one. -->
      {#if change}
        <section class="change-card">
          <div class="cmp-head"><h3>Detected change</h3></div>
          <ChangeHeadline
            percent={change.relativeChange}
            delta={change.afterValue - change.beforeValue}
            unit={sel.entry.meta?.measurementUnit ?? ''}
            verdict={change.isRegression ? 'regression' : 'improvement'}
          />
          <p class="cmp-sub muted">
            {formatValue(change.beforeValue)} → {formatValue(change.afterValue)}
            {#if sel.entry.meta?.measurementUnit}{' '}{sel.entry.meta.measurementUnit}{/if}
            <!-- Spelled out for the same reason the Alert card spells out its
                 window: the comparison card below quotes these two builds and
                 will print a different number, and a reader who took both for
                 two-push figures would think one of them was wrong. -->
            means over {change.beforeCount} pushes before against {change.afterCount} after
          </p>
          <dl>
            <dt title="Two-sided Mann-Whitney U over the two windows of push means">
              Mann-Whitney p
            </dt>
            <dd>{formatPValue(change.pValue)}</dd>
            <dt title="Cliff's delta, interpreted with the Romano thresholds">Effect</dt>
            <dd>{change.effectSize}</dd>
          </dl>
          <!-- The same step, as the other plotted series saw it. Twelve
               signatures on one graph produce twelve sets of bars and no
               statement that nine of them are one event; this is that
               statement, and it is free — the changes are computed, the push
               times are in memory, and the grouping is arithmetic (cluster.ts).

               It sits inside the Detected-change card because it is a fact
               about *this* bar rather than a section of its own, and below the
               statistics because the reader wants to know what moved before
               they want to know who else saw it. -->
          {#if landing && landingSeriesCount(landing) > 1}
            <h4>Same landing</h4>
            <p class="cmp-sub muted">
              <!-- Two claims, and the second is the one the grouping buys: each
                   series brackets the step between the two pushes either side
                   of its bar, and the intersection of those brackets is
                   narrower than any one of them — often a single push. See
                   cluster.ts. -->
              Seen in {landingSeriesCount(landing)} of {app.visibleSeries.length} plotted
              series · {landingWindowLabel(landing)}
              {#if landing.regressions > 0 && landing.improvements > 0}
                <!-- Both directions at one instant is a trade-off rather than a
                     coincidence, which is why direction is not part of the
                     grouping key. Only said when it happens. -->
                · {landing.regressions} regressions, {landing.improvements} improvements
              {/if}
            </p>
            <p class="cmp-sub muted window">
              {formatTimestamp(landing.startMs)}
              {#if landing.endMs !== landing.startMs}
                {' → '}{formatTimestamp(landing.endMs)}
              {/if}
            </p>
            <ul class="landing">
              {#each landing.events as event (event.ref + event.atMs)}
                {@const member = event.payload.series}
                {@const current = event.payload.change === change}
                <li>
                  <!-- A click moves the selection to that series' bar, the same
                       thing clicking the bar on the graph does. The current
                       member is still a button: pressing it is a no-op, and
                       disabling one row in a list of otherwise identical rows
                       reads as "this one is broken" rather than "you are here",
                       which is what `aria-current` and the mark are for. -->
                  <button
                    type="button"
                    class="member"
                    class:current
                    aria-current={current ? 'true' : undefined}
                    onclick={() => app.selectChange(member.ref, event.payload.change)}
                  >
                    <span
                      class="swatch {member.symbol.shape}"
                      style:background={member.color}
                      aria-hidden="true"
                    ></span>
                    <span class="member-label">{event.label}</span>
                    <span class="member-change {event.isRegression ? 'regression' : 'improvement'}">
                      {event.relativeChange === null
                        ? ''
                        : formatSignedPercent(event.relativeChange)}
                    </span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
          <p class="cmp-sub muted">
            Found in the data by this app, not by perfherder — there may be no
            alert for it.
          </p>
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
          <!-- No chart here any more. The push's strip is the one-row form of
               the chart ComparisonSection now holds, which is what stops it
               vanishing and reappearing 250px up the pane every time the
               pointer crosses a dot. This section keeps the numbers. -->
          <!-- Heavily retriggered pushes are where this section stops being
               readable: seven runs is 386px, a fifth of the whole pane, for a
               spread the chart above already draws with the clicked run haloed.
               Past MANY_RUNS it folds, and the summary carries what the fold
               hides — how many runs, and the push mean the connecting line
               passes through. Nothing changes on the common one-run push, and
               nothing here loads or moves on its own: the fold only ever opens
               because someone opened it. -->
          {#if runGroups.length > MANY_RUNS}
            <details class="run-fold">
              <summary>
                {runGroups.length} runs
                <span class="muted">· push mean {formatValue(sel.push.mean)}</span>
              </summary>
              {@render runList(sel)}
            </details>
          {:else}
            {@render runList(sel)}
            <!-- The value the connecting line passes through, which is why the
                 line can sit off a retriggered push's individual dots. Only
                 worth spelling out when there is more than one run; otherwise it
                 repeats the run mean above. Folded, it is in the summary. -->
            {#if runGroups.length > 1}
              <dl class="push-mean">
                <dt>Push mean</dt>
                <dd>{formatValue(sel.push.mean)}</dd>
              </dl>
            {/if}
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
            <!-- Shortened, with the whole of it on hover. The full name opens
                 with the platform and the build config — four wrapped lines of
                 monospace here, and both already spelled out at the top of this
                 pane. See job.ts for what is and isn't safe to strip. -->
            <dt>Type</dt>
            <dd class="mono" title={job.job_type_name}>
              {shortJobType(job.job_type_name, job.platform)}
            </dd>
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
        </dl>

        <!-- No "since previous → pushlog" row here any more. It built exactly
             the range `comparePrevious` pins, and pinning now answers it in the
             card above with the commits inline, the delta, the distributions
             and the same link — so this was a trip out to hg for a subset of
             one keypress. -->
        {#if app.selectedPush}
          {@const commits = commitsOfPush(app.selectedPush)}
          <h4>
            {app.selectedPush.revision_count} commit{app.selectedPush.revision_count === 1
              ? ''
              : 's'}
          </h4>
          <CommitList commits={commits.commits} {repoLink} />
          <!-- Against `revision_count`, not against the length of the list:
               `revisions` is capped at 20 by the serializer, so a check on the
               rendered length can never fire and a 164-commit merge used to
               show twenty of them under a heading saying 164, with nothing to
               say the rest existed. -->
          {#if commits.hiddenRevisions > 0}
            <p class="muted">
              …and {commits.hiddenRevisions} more; treeherder names at most 20 per push.
            </p>
          {/if}
        {:else}
          <p class="muted">Loading push details…</p>
        {/if}
      </section>
    </div>
  {/if}
</aside>

<style>
  /* No border: which of this pane's sides face another pane depends on where
     the shell has put it, and the shell is the only thing that knows. It draws
     the seam on the slot — see `main` in App.svelte. */
  .details {
    display: flex;
    flex-direction: column;
    min-height: 0;
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
    /* The third of the app's three scrollers, and the same rule: reaching the
       bottom of a selection ends the gesture rather than rubber-banding the
       document behind it. */
    overscroll-behavior: contain;
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
  /* Same disclosure idiom as the comparison card's pushlog: no native marker,
     a triangle that turns, and a summary line whose height doesn't change with
     its state. */
  .run-fold > summary {
    cursor: pointer;
    list-style: none;
    user-select: none;
    line-height: 18px;
  }
  .run-fold > summary::-webkit-details-marker {
    display: none;
  }
  .run-fold > summary::before {
    content: '▸';
    display: inline-block;
    width: 12px;
    color: var(--fg-subtle);
  }
  .run-fold[open] > summary::before {
    content: '▾';
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
  /* The same card, in the app's own voice: a plain border rather than the
     alert card's attention color, because this is something the pane computed
     and not a finding a sheriff has looked at. The two can be on screen
     together and the difference has to survive that. */
  section.change-card {
    padding: 8px 10px 10px;
    border: 1px solid var(--border-default);
    border-radius: 6px;
    background: var(--bg-canvas);
  }
  section.change-card dl {
    grid-template-columns: 9em minmax(0, 1fr);
    font-size: 11px;
  }
  section.change-card .cmp-sub:last-child {
    margin-top: 6px;
  }
  .window {
    font-variant-numeric: tabular-nums;
  }
  /* One row per series that saw the landing. Modelled on `.run-mean` above: a
     list row that happens to be clickable, so it wears no button chrome until
     the pointer is on it — a dozen bordered buttons stacked in a card would
     read as a toolbar, and this is a list of findings. */
  .landing {
    list-style: none;
    margin: 4px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .member {
    display: grid;
    /* Swatch, name, number. The number is last and right-aligned so a column of
       percentages can be compared down the list. */
    grid-template-columns: 10px minmax(0, 1fr) auto;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 2px 4px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: none;
    color: inherit;
    font: inherit;
    font-size: 11px;
    text-align: left;
    cursor: pointer;
  }
  /* The pane's `.swatch` is sized for the series header, where it sits beside a
     two-line block; here the row centres it. */
  .member .swatch {
    margin: 0;
  }
  .member:hover {
    border-color: var(--border-default);
    background: var(--bg-hover);
  }
  /* "You are here", in the same accent the selected replicate and the selected
     run mean wear. */
  .member.current {
    border-color: var(--accent-emphasis);
    background: var(--accent-subtle);
  }
  .member-label {
    overflow-wrap: anywhere;
  }
  .member-change {
    font-variant-numeric: tabular-nums;
  }
  .member-change.regression {
    color: var(--danger-fg);
  }
  .member-change.improvement {
    color: var(--success-fg);
  }
</style>
