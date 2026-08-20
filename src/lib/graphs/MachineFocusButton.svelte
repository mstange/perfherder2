<script lang="ts">
  // A machine name that is also the control picking that machine out of the
  // graph: point at it for a preview, click to keep it. The same
  // hover-previews-click-pins pair as the machine panel in the graph header, so
  // learning it once is enough — see graphs.md, "Machines".
  //
  // Its own component because two places in the details pane name a machine —
  // the Run section, for the selected point, and the comparison card, once per
  // side — and a control whose affordance and pinned state were declared twice
  // is the recipe that drifted five ways for buttons (design.md, "One button,
  // defined once").

  import type { AppState } from './appState.svelte';

  type Props = { app: AppState; machine: string };
  let { app, machine }: Props = $props();

  const pinned = $derived(app.focusedMachine === machine);
</script>

<button
  type="button"
  class="machine-focus"
  class:on={pinned}
  aria-pressed={pinned}
  title={pinned
    ? `Showing ${machine} at full strength. Click to show every machine again.`
    : `Point at this to pick ${machine}’s measurements out of the graph; click to keep them picked`}
  onpointerenter={() => app.setHoveredMachine(machine)}
  onpointerleave={() => app.setHoveredMachine(null)}
  onfocus={() => app.setHoveredMachine(machine)}
  onblur={() => app.setHoveredMachine(null)}
  onclick={() => app.setMachineFocus(machine)}
>
  {machine}
</button>

<style>
  /* Quiet by default, for the reason the pane's other inline controls are: it
     sits among plain facts, and a bordered button there would claim to be the
     important one. The border arrives on hover, which is also the moment the
     preview arrives on the plot — one gesture, two things lighting up.

     **Nondescript at rest is the decision, not an oversight.** A resting mark
     was tried — a small scatter with one dot picked out, drawn beside the name —
     and taken out again: nothing here needs discovering on a schedule. A reader
     who suspects a machine is behind what they are looking at will put the
     pointer on the machine name, and that is when the feature should appear. A
     permanent icon spends attention, in the pane's densest column, on a question
     most readers of most points are not asking.

     The type is the pane's `.mono` scale spelled out rather than borrowed, since
     this component carries its own appearance wherever it is dropped. Bespoke
     rather than `.btn` for the reason in design.md, "One button, defined once":
     a `.btn` here would be a 26px control in an 18px row. */
  .machine-focus {
    font: inherit;
    font-family: var(--font-mono);
    font-size: 12px;
    padding: 0 4px;
    margin-left: -4px;
    border: 1px solid transparent;
    border-radius: 4px;
    background: none;
    color: inherit;
    cursor: pointer;
  }
  .machine-focus:hover {
    border-color: var(--border-default);
    background: var(--bg-hover);
  }
  /* Pinned. The same accent fill the machine panel's pinned row wears, so the
     places that can set a focus agree about what "set" looks like. */
  .machine-focus.on {
    border-color: var(--accent-emphasis);
    background: var(--accent-subtle);
    color: var(--accent-on-subtle);
  }
  @media (pointer: coarse) {
    /* Not a `.btn`, so it takes app.css's one floor by hand — and the negative
       margin keeps the text on the same left edge as the rows around it while
       the target grows. See design.md, "Touch". */
    .machine-focus {
      min-height: 32px;
    }
  }
</style>
