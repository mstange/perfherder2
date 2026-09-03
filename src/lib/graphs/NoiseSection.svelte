<script lang="ts">
  // What this series' scatter is made of, over the loaded range — the pane's
  // answer to "how much of what I am looking at is the measurement?".
  //
  // **A fold, closed, with the answer in its summary.** Two numbers change what
  // a reader does — how noisy a job is, and the smallest difference two pushes
  // could show — and they fit on the summary line, so the table behind it is for
  // the reader who wants to know *why*. Closed also keeps a series-level block
  // out of the way of the dot-level sections it sits between; see graphs.md,
  // "The details pane, top to bottom".
  //
  // **Nothing here is fetched and nothing here moves.** Every level comes out of
  // the response the dots were drawn from (`AppState.selectedNoise`), so the
  // section is complete on the first paint and changes only when the plotted
  // range does — not as the pointer sweeps, and not a beat later.
  //
  // The maths, and every rule in it, is noise.ts.

  import { formatPercent, formatValue } from '../shared/chart';
  import { WINDOW_PUSHES } from './changes';
  import { noiseHeadline, type NoiseBudget, type NoiseTerm } from './noise';

  type Props = { budget: NoiseBudget; unit: string };
  let { budget, unit }: Props = $props();

  // Every row the table can show, in the order the levels nest. Built as data so
  // the markup below is one loop rather than eight near-identical blocks, and so
  // "which rows exist" is a property of the budget rather than of the template.
  type Row = { label: string; term: NoiseTerm | null; nested: boolean; share: boolean };
  const rows = $derived.by((): Row[] =>
    (
      [
        { label: 'one replicate', term: budget.replicate, nested: false, share: false },
        { label: 'one job', term: budget.job, nested: false, share: true },
        { label: 'device', term: budget.device, nested: true, share: true },
        { label: 'replicate mean', term: budget.replicateShare, nested: true, share: true },
        { label: 'unexplained', term: budget.unexplained, nested: true, share: true },
        { label: 'one push mean', term: budget.push, nested: false, share: false },
        { label: 'vs its neighbours', term: budget.local, nested: true, share: false },
      ] satisfies Row[]
    ).filter((r) => r.term !== null),
  );

  // Share of the *job* level's variance, which is the one place these add up.
  const jobSd = $derived(budget.job?.sd ?? null);
  function share(term: NoiseTerm): string {
    if (jobSd === null || jobSd <= 0) return '';
    return `${Math.round((100 * term.sd * term.sd) / (jobSd * jobSd))}%`;
  }

  // What job noise over this push's retriggers accounts for, which is the figure
  // the build reading is a comparison against.
  const perPushSd = $derived(
    budget.job && budget.runsPerPush > 0 ? budget.job.sd / Math.sqrt(budget.runsPerPush) : null,
  );

  const withUnit = (v: number) => `${formatValue(v)}${unit ? ` ${unit}` : ''}`;
</script>

{#if rows.length > 0}
  <section>
    <h3>Noise</h3>
    <details class="noise fold">
      <summary>{noiseHeadline(budget)}</summary>

      <div class="noise-body">
        <div class="grid" role="table" aria-label="Noise by level">
          {#each rows as row (row.label)}
            {@const term = row.term as NoiseTerm}
            <span class="level" class:nested={row.nested}>{row.label}</span>
            <span class="num">{withUnit(term.sd)}</span>
            <span class="num">{formatPercent(term.cv)}</span>
            <span class="num muted">{row.share ? share(term) : ''}</span>
          {/each}
        </div>

        <!-- The reading that changes what a reader should do with the graph, so
             it is a sentence rather than another row. Either the line between push
             means carries something the jobs do not explain, or it does not and
             only a window means anything. -->
        {#if budget.job && budget.local && perPushSd !== null}
          <p class="note">
            {#if budget.build}
              A build differs from its neighbours by {formatPercent(budget.build.cv)} more
              than its own jobs explain ({withUnit(perPushSd)} of the
              {withUnit(budget.local.sd)} observed).
            {:else}
              A push mean is a draw, not a measurement of its build: they sit no further
              apart than job noise over {budget.runsPerPush}
              {budget.runsPerPush === 1 ? 'run' : 'runs'} accounts for ({withUnit(perPushSd)}
              against {withUnit(budget.local.sd)}). Read the trend band and the change
              bars.
            {/if}
          </p>
        {/if}

        {#if budget.pushPairResolution !== null && budget.windowResolution !== null}
          <p class="note">
            Two single pushes resolve {formatPercent(budget.pushPairResolution)};
            {WINDOW_PUSHES} pushes a side resolve {formatPercent(budget.windowResolution)}.
          </p>
        {/if}

        <!-- Two different sentences, because "some runs are unattributed" and
             "none is" are different facts: the first qualifies the device row,
             the second explains why there isn't one. The machine name is joined
             off the job row and treeherder expires those (graphs.md,
             "Machines"). -->
        {#if budget.attributedRuns === 0}
          <p class="note muted">
            No run here carries a machine name — treeherder had already expired their
            jobs — so nothing is attributed to the device.
          </p>
        {:else if budget.attributedRuns < budget.runs}
          <p class="note muted">
            {(budget.runs - budget.attributedRuns).toLocaleString()} of {budget.runs.toLocaleString()}
            runs {budget.runs - budget.attributedRuns === 1 ? 'carries' : 'carry'} no machine
            name, so the device row is estimated from the rest.
          </p>
        {/if}
      </div>
    </details>
  </section>
{/if}

<style>
  /* The marker, the triangle and the turn are `.fold` in detailsPane.css, shared
     with the comparison card's pushlog and the Run section's chip list. */
  .noise > summary {
    line-height: 18px;
  }

  /* Indented to the disclosure's text, so the table reads as its contents — the
     same offset the pushlog's commit list uses. */
  .noise-body {
    padding-left: 12px;
  }

  /* Four columns rather than the pane's `dl`, which is a label and a value: this
     is one label and three numbers, and the numbers have to line up down the
     column for the nesting to be readable at all. `minmax(0, …)` on the label so
     a long one clips instead of widening the pane. */
  .grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto 2.5em;
    gap: 1px 8px;
    margin: 4px 0 6px;
    font-size: 11px;
  }
  .level {
    color: var(--fg-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* The parts of a level, offset so that "device" reads as part of "one job"
     rather than as a level of its own. */
  .level.nested {
    padding-left: 10px;
  }
  .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .note {
    margin: 0 0 6px;
    font-size: 11px;
  }
</style>
