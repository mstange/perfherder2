<script lang="ts">
  // The machine census, as a button in the graph header that opens a list of
  // every worker behind the dots on screen.
  //
  // **Hovering a row previews, clicking it pins.** That pair is the whole
  // interaction, and it is the pair because the two questions are different
  // sizes: "which dots are that machine's?" is asked of forty rows in a row and
  // answered by pointing, while "show me this machine while I read the graph" is
  // one deliberate choice that belongs in the URL. Making the preview a click
  // would mean forty clicks and forty history entries to scan a pool; making the
  // pin a hover would mean the finding evaporates the moment you reach for the
  // graph. Keyboard focus previews too — a Tab through the list is the same
  // gesture — and on a touch screen, where there is no hover at all, the click
  // alone still does the whole job.
  //
  // **The panel used to be just names and counts**, on the grounds that ranking
  // the pool was heavier than a 32px row could carry and belonged in
  // `perfherder-cli machines`, where a statistic gets a paragraph. Both halves of
  // that have changed. The cost went away when the level started measuring
  // against a run's own push where it can (machines.ts) — one pass, no window —
  // and the doubt went away when the noise trial measured the levels as stable:
  // 0.95–0.97 correlation across three independent metrics, 0.91 between halves
  // of a month. Meanwhile the finding that prompted all of this was invisible
  // here: 53 alphabetical rows of names and counts, hiding two device families
  // 4.3% apart.
  //
  // So the level is a column, with the same ± the CLI prints, and the order is a
  // choice — **name and level answer different questions**. Name is for finding a
  // machine you can already name, and it is what makes families contiguous;
  // level is for the case where you cannot name it.

  import type { AppState } from './appState.svelte';
  import { formatPercent, formatSignedPercent } from '../shared/chart';
  import type { MachineLevel } from './machines';
  import ChevronIcon from '../shared/ChevronIcon.svelte';

  type Props = { app: AppState };
  let { app }: Props = $props();

  // Transient, like the graph header's own `controlsOpen`: whether a panel is
  // open right now is not part of what a shared link shows.
  let open = $state(false);
  let root = $state<HTMLElement | null>(null);

  const census = $derived(app.machineCensus);

  // Transient like `open`: which way a list is sorted is a way of reading it,
  // not a thing a shared link should reproduce.
  let sort = $state<'name' | 'level'>('name');

  // Machines with no level fall to the bottom rather than sorting as zero, which
  // would file a machine we know nothing about among the ones we do.
  const rows = $derived.by(() => {
    if (sort === 'name') return census.machines;
    return [...census.machines].sort((a, b) => {
      if (a.relativeLevel === null) return b.relativeLevel === null ? 0 : 1;
      if (b.relativeLevel === null) return -1;
      return Math.abs(b.relativeLevel) - Math.abs(a.relativeLevel);
    });
  });

  // What a row's level means, spelled out once. The ± is the part that stops a
  // nine-run machine from reading like a finding.
  function levelTitle(m: MachineLevel): string {
    const level = m.relativeLevel === null ? null : formatSignedPercent(m.relativeLevel);
    if (level === null) {
      return `${m.points.toLocaleString()} points from this machine. Too few pushes in view to say how it reads.`;
    }
    const error = m.levelError === null ? '' : ` ± ${formatPercent(m.levelError)}`;
    const spread = m.relativeSpread === null ? '' : `, its own runs scattering ${formatPercent(m.relativeSpread)}`;
    return (
      `${m.points.toLocaleString()} points from this machine, reading ${level}${error} ` +
      `against the rest of the pool where it ran${spread}.`
    );
  }
  // A pinned machine that has no dots in the window — zoomed away, or a series
  // hidden since the link was made. It still has to be listed, or the only way
  // out of a focus that appears to do nothing would be the URL.
  const pinnedMissing = $derived(
    app.focusedMachine !== null && !census.machines.some((m) => m.name === app.focusedMachine),
  );

  // Nothing to open the panel for, and nothing pinned to clear: every run in the
  // window is older than treeherder's job retention window, or there is no data.
  // Disabled rather than removed, so the header doesn't reflow as a fetch lands.
  const empty = $derived(census.machines.length === 0 && app.focusedMachine === null);

  function close(): void {
    open = false;
    // The rows' own `pointerleave` never fires if they are unmounted under the
    // pointer, which is exactly what closing does — and a preview with nothing
    // left on screen naming it is a graph dimmed for no visible reason.
    app.setHoveredMachine(null);
  }

  function toggle(name: string | null): void {
    app.setMachineFocus(name);
  }

  // Open the list on the machine that is already pinned. A pool of 78 workers is
  // a scroller, and the alphabetical order that makes one findable is exactly
  // what buries the one in force — the panel would open on nuc13-001 with the
  // answer forty rows down, and the row highlight would be doing nothing.
  //
  // `block: 'nearest'` so a pin near the top doesn't scroll the list at all, and
  // `instant` because this is the panel's initial state rather than a movement
  // the reader should watch.
  $effect(() => {
    if (!open || !root) return;
    root
      .querySelector('.row.on:not(.all)')
      ?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  });
</script>

<svelte:window
  onpointerdown={(e) => {
    if (open && root && !root.contains(e.target as Node)) close();
  }}
  onkeydown={(e) => {
    if (open && e.key === 'Escape') {
      close();
      // Back to the button that opened it, or the focus lands on <body> and the
      // next Tab restarts from the top of the page.
      (root?.querySelector('button') as HTMLButtonElement | null)?.focus();
    }
  }}
/>

<div class="machines" bind:this={root}>
  <button
    type="button"
    class="btn btn-compact machine-toggle"
    class:btn-selected={app.focusedMachine !== null}
    aria-expanded={open}
    aria-controls="machine-list"
    disabled={empty}
    title={app.focusedMachine
      ? `Showing ${app.focusedMachine} at full strength and the other machines faded. Open the list to change it, or pick “All machines”.`
      : 'Which machines ran the jobs behind these points — hover one to pick it out of the graph, click to keep it'}
    onclick={() => (open ? close() : (open = true))}
  >
    {app.focusedMachine ?? 'Machines'}
    <ChevronIcon dir={open ? 'up' : 'down'} />
  </button>

  {#if open}
    <div class="panel" id="machine-list">
      <p class="head">
        {#if census.machines.length === 0}
          No machine is recorded for the runs in view.
        {:else}
          {census.machines.length.toLocaleString()}
          machine{census.machines.length === 1 ? '' : 's'} ran the jobs in view.
          <span class="hint">Hover to pick one out; click to keep it.</span>
          <!-- Two orders because they answer different questions, and the one
               that is *not* the default is the one that found the pool's
               families: see the note at the top of this file. -->
          <span class="sort">
            sort
            {#each ['name', 'level'] as const as option (option)}
              <button
                type="button"
                class="sort-option"
                class:on={sort === option}
                aria-pressed={sort === option}
                onclick={() => (sort = option)}>{option}</button
              >
            {/each}
          </span>
        {/if}
      </p>
      <ul>
        <li>
          <button
            type="button"
            class="row all"
            class:on={app.focusedMachine === null}
            aria-pressed={app.focusedMachine === null}
            onpointerenter={() => app.setHoveredMachine(null)}
            onfocus={() => app.setHoveredMachine(null)}
            onclick={() => toggle(null)}
          >
            <span class="name">All machines</span>
          </button>
        </li>
        {#if pinnedMissing}
          <li>
            <button
              type="button"
              class="row"
              class:on={true}
              aria-pressed="true"
              title="Pinned, but none of its runs are in the window on screen"
              onclick={() => toggle(null)}
            >
              <span class="name mono">{app.focusedMachine}</span>
              <span class="count none">not in view</span>
            </button>
          </li>
        {/if}
        {#each rows as machine (machine.name)}
          <li>
            <button
              type="button"
              class="row"
              class:on={app.focusedMachine === machine.name}
              aria-pressed={app.focusedMachine === machine.name}
              title={levelTitle(machine)}
              onpointerenter={() => app.setHoveredMachine(machine.name)}
              onpointerleave={() => app.setHoveredMachine(null)}
              onfocus={() => app.setHoveredMachine(machine.name)}
              onblur={() => app.setHoveredMachine(null)}
              onclick={() => toggle(machine.name)}
            >
              <span class="name mono">{machine.name}</span>
              <!-- Quiet, and to the right of the name where the eye can run down
                   it. No bar: at this width a bar is four pixels of resolution
                   for a figure whose whole interest is the second digit. -->
              <span class="level" class:none={machine.relativeLevel === null}>
                {machine.relativeLevel === null ? '—' : formatSignedPercent(machine.relativeLevel)}
              </span>
              <span class="count">{machine.runs.toLocaleString()}</span>
            </button>
          </li>
        {/each}
      </ul>
      <!-- Stated rather than silently omitted: `machine_name` is joined off the
           job row and expires with it, so the older end of a long range has no
           machine at all and the counts above would otherwise fail to add up to
           the graph. See machines.ts. -->
      {#if census.unattributedRuns > 0}
        <p class="foot">
          {census.unattributedRuns.toLocaleString()} run{census.unattributedRuns === 1 ? '' : 's'} have
          no machine — treeherder had already expired their jobs.
        </p>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Deliberately *not* a positioned ancestor: the panel hangs off the control
     block, not off this button. See `.panel`. */
  .machines {
    display: contents;
  }
  /* Its resting label is "Machines" and a pinned one is a nine-to-twelve
     character name, so without a floor the button shrinks when a focus is set
     and the two controls after it slide left mid-interaction. The floor is the
     resting width; a longer name still grows it, which is the right way round —
     truncating the one word that says what the graph is showing would be worse
     than a header that grew by a few pixels. */
  .machine-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 9ch;
    justify-content: space-between;
  }
  /* A layer over the graph, so it needs the same standing the series sheet has:
     it sits above the canvases, casts a shadow, and does not push the header
     around when it opens.

     **Anchored to the control block, not to the button** — GraphPane's `header`
     is the `position: relative` that makes this work, and the two comments say
     so at both ends. Anchoring it to the button is the obvious thing and it does
     not survive the header wrapping: at a 760px window this button is the first
     item of a wrapped line, a couple of hundred pixels from the pane's left
     edge, and a 240px panel hanging off its right edge started 26px outside the
     window. Off the block it cannot leave the pane at any width, and it falls
     below the whole bar rather than over the switches next to it. */
  .panel {
    position: absolute;
    z-index: 5;
    top: calc(100% + 4px);
    right: 12px;
    min-width: 240px;
    /* The second bound is the phone: 320 - the block's own padding. */
    max-width: min(320px, calc(100% - 24px));
    padding: 6px;
    border: 1px solid var(--border-default);
    border-radius: 8px;
    background: var(--bg-canvas);
    box-shadow: var(--shadow-lifted);
  }
  .head {
    margin: 2px 6px 6px;
    color: var(--fg-muted);
    font-size: 12px;
  }
  .hint {
    display: block;
  }
  ul {
    /* Forty workers is an ordinary pool, and a list that long over a graph would
       be the whole pane. Scrolled, with the height cut mid-row so the overflow
       is visible rather than ending flush and looking complete. */
    max-height: 46vh;
    overflow-y: auto;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .foot {
    margin: 6px 6px 2px;
    padding-top: 6px;
    border-top: 1px solid var(--border-muted);
    color: var(--fg-muted);
    font-size: 12px;
  }
  /* Not a `.btn`: this is a list row, and the recipe in app.css is for a control
     with a border and a fill of its own. See design.md, "One button, defined
     once" — a row that wears a button's chrome forty times over reads as a
     toolbar. */
  /* A grid rather than a flex row, so the two number columns line up down the
     list — the level column is only readable as a column. Each cell is placed
     explicitly, since the rows that have no level ("All machines", a pinned
     machine that is out of view) would otherwise pull their count leftwards. */
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 4px 6px;
    border: 0;
    border-radius: 5px;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row:hover {
    background: var(--bg-hover);
  }
  /* The row whose machine is *pinned*. Deliberately not applied to the hovered
     one: hover already shows itself, and the graph is where a preview is meant
     to be read. Two rows highlighted at once would make the list the thing being
     looked at instead of the dots. */
  .row.on {
    background: var(--accent-subtle);
    color: var(--accent-on-subtle);
  }
  .row.on .count {
    color: inherit;
  }
  .row.on:hover {
    background: var(--accent-tint-hover);
  }
  .all {
    /* The way out, so it reads as a heading for the list rather than as its
       first member. */
    font-weight: 600;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  /* How far this machine reads from the rest of the pool where it ran. Quiet:
     it is context for the name, and the row is a control for picking dots out of
     the graph before it is a statistic. */
  .level {
    grid-column: 2;
    justify-self: end;
    min-width: 3.4em;
    text-align: right;
    color: var(--fg-muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .level.none {
    font-variant-numeric: normal;
  }
  .row.on .level {
    color: inherit;
  }
  .count {
    grid-column: 3;
    justify-self: end;
    min-width: 1.6em;
    text-align: right;
    color: var(--fg-muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .count.none {
    font-variant-numeric: normal;
  }
  /* Two words and a label, not a `.btn` pair: this sits inside a sentence in the
     panel's head line, and a bordered control there would outweigh the list it
     orders. Same reasoning as the machine name's own button; see design.md,
     "One button, defined once". */
  .sort {
    color: var(--fg-muted);
  }
  .sort-option {
    font: inherit;
    padding: 0 3px;
    border: 0;
    border-radius: 3px;
    background: none;
    color: var(--accent-fg);
    cursor: pointer;
  }
  .sort-option:hover {
    background: var(--bg-hover);
  }
  .sort-option.on {
    color: inherit;
    font-weight: 600;
    background: var(--accent-subtle);
  }
  @media (pointer: coarse) {
    .sort-option {
      min-height: 32px;
    }
  }
  /* The list is driven as much by a thumb as by a pointer, and a 24px row is not
     a target. The floor is app.css's one number; see design.md, "Touch". */
  @media (pointer: coarse) {
    .row {
      min-height: 32px;
    }
  }
</style>
