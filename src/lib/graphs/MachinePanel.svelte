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
  // The panel is deliberately just names and counts. Ranking the pool by how far
  // each machine reads from the rest is a real question and a much heavier one
  // (see machines.ts, `relativeLevel`); it is `perfherder-cli machines`, where a
  // statistic can be explained in a paragraph rather than in a 32px row.

  import type { AppState } from './appState.svelte';
  import ChevronIcon from '../shared/ChevronIcon.svelte';

  type Props = { app: AppState };
  let { app }: Props = $props();

  // Transient, like the graph header's own `controlsOpen`: whether a panel is
  // open right now is not part of what a shared link shows.
  let open = $state(false);
  let root = $state<HTMLElement | null>(null);

  const census = $derived(app.machineCensus);
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
        {#each census.machines as machine (machine.name)}
          <li>
            <button
              type="button"
              class="row"
              class:on={app.focusedMachine === machine.name}
              aria-pressed={app.focusedMachine === machine.name}
              title="{machine.points.toLocaleString()} point{machine.points === 1
                ? ''
                : 's'} from this machine"
              onpointerenter={() => app.setHoveredMachine(machine.name)}
              onpointerleave={() => app.setHoveredMachine(null)}
              onfocus={() => app.setHoveredMachine(machine.name)}
              onblur={() => app.setHoveredMachine(null)}
              onclick={() => toggle(machine.name)}
            >
              <span class="name mono">{machine.name}</span>
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
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
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
  .count {
    flex: none;
    color: var(--fg-muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .count.none {
    font-variant-numeric: normal;
  }
  /* The list is driven as much by a thumb as by a pointer, and a 24px row is not
     a target. The floor is app.css's one number; see design.md, "Touch". */
  @media (pointer: coarse) {
    .row {
      min-height: 32px;
    }
  }
</style>
