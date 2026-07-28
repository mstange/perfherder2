<script lang="ts">
  // Right pane: everything about the clicked dot, grouped the way the data is
  // structured — build (push), run (job), replicate.

  import type { AppState } from './appState.svelte';
  import { formatTimestamp, formatValue } from './chart';
  import { seriesLabel } from './graphData';
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

  type Props = { app: AppState };
  let { app }: Props = $props();

  const sel = $derived(app.selection);
  const repo = $derived(sel?.entry.ref.repository ?? '');
  const repoLink = $derived.by((): RepoLinkInfo | null => {
    const info = app.repoInfo.get(repo);
    return info ? { name: info.name, dvcs_type: info.dvcs_type, url: info.url } : null;
  });

  // Runs of the same push are retriggers of the same build.
  const retriggerCount = $derived(sel ? sel.push.runs.length - 1 : 0);

  const replicateValues = $derived(sel ? sel.run.values : []);
  const runMean = $derived(sel ? sel.run.mean : 0);

  function shortRev(rev: string): string {
    return rev.slice(0, 12);
  }

  function jobDuration(startS: number, endS: number): string {
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
      {#if !app.selectionInView}
        <p class="offscreen">
          This point is outside the zoomed range.
          <button type="button" onclick={() => app.resetZoom()}>Show it</button>
        </p>
      {/if}
      <section class="series">
        <span class="swatch" style:background={sel.entry.color} aria-hidden="true"></span>
        <div>
          <div class="title">
            {sel.entry.meta ? seriesLabel(sel.entry.meta) : `signature ${sel.entry.ref.signatureId}`}
          </div>
          <div class="muted">{sel.entry.meta?.platform ?? ''}</div>
          {#if sel.entry.meta?.options}
            <div class="muted">{sel.entry.meta.options}</div>
          {/if}
          <div class="muted mono">{repo}</div>
        </div>
      </section>

      <section>
        <h3>Replicate</h3>
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
          <dt>Replicate</dt>
          <dd>{sel.replicateIndex + 1} of {replicateValues.length}</dd>
          <dt>Run mean</dt>
          <dd>{formatValue(runMean)}</dd>
        </dl>
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
            <a href={jobsUrl(repo, sel.push.revision, sel.run.jobId)} target="_blank" rel="noopener">
              {sel.run.jobId}
            </a>
            on treeherder
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
          {:else}
            <dt>Type</dt>
            <dd class="muted">loading…</dd>
          {/if}
          {#if retriggerCount > 0}
            <dt>Retriggers</dt>
            <dd>{retriggerCount} other run{retriggerCount === 1 ? '' : 's'} of this push</dd>
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
  .swatch {
    width: 10px;
    height: 10px;
    margin-top: 3px;
    border-radius: 2px;
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
