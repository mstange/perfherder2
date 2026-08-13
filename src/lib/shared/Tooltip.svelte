<script lang="ts">
  // The one tooltip box, mounted once in App.svelte. Everything about *what* it
  // says is in tooltipState.svelte.ts (the singleton) and tooltip.ts (the
  // placement); this file owns pixels and the measurement.
  //
  // It exists for the marks the graph paints into its canvas, which have no
  // element to hang a `title` on. Ordinary controls in this app still use `title`
  // — see docs/design.md, "Tooltips: for what the canvas paints".

  import { placeTooltip, tooltipMaxWidth } from './tooltip';
  import { tooltip } from './tooltipState.svelte';

  let el: HTMLDivElement | undefined = $state();
  let size = $state({ width: 0, height: 0 });
  // Which content the size above belongs to. Placement is only honest once the
  // box has been measured, and the box changes size when the words change.
  let measuredKey = $state<string | null>(null);
  let viewportWidth = $state(0);
  let viewportHeight = $state(0);

  const content = $derived(tooltip.content);
  const anchor = $derived(tooltip.anchor);
  // Capped by the viewport and by nothing else, so the wrap — and therefore the
  // height — is decided before the side is. See tooltip.ts::tooltipMaxWidth.
  const maxWidth = $derived(tooltipMaxWidth(viewportWidth));
  const place = $derived(
    anchor
      ? placeTooltip(anchor, size, { width: viewportWidth, height: viewportHeight })
      : { left: 0, top: 0 },
  );
  // Placement before measurement would put the box at the cursor's bottom right
  // whether or not it fits. The measure lands in the same update — effects run
  // before the browser paints — so this hides nothing the user could have seen.
  const measured = $derived(measuredKey !== null && measuredKey === tooltip.key);

  // Measured on content change, not on pointer move: `getBoundingClientRect`
  // forces layout, and a tooltip that follows the cursor would otherwise pay for
  // one per move while saying the same thing. `tooltip.key` is what distinguishes
  // the two, which is why the controller keeps it separate from the content.
  $effect(() => {
    const key = tooltip.key;
    if (!el || key === null) {
      measuredKey = null;
      return;
    }
    const rect = el.getBoundingClientRect();
    size = { width: rect.width, height: rect.height };
    measuredKey = key;
  });

  // Three ways an open tooltip stops being about anything, none of which the
  // owner can see: a scroll moves what it describes out from under the pointer,
  // a click means the user has moved on, and Escape is the universal dismiss.
  //
  // The scroll listener has to capture: the series list and the details pane are
  // their own scrollers, and scroll events from them don't reach `window` on the
  // bubble path.
  $effect(() => {
    const dismiss = () => tooltip.hideAll();
    document.addEventListener('scroll', dismiss, true);
    document.addEventListener('pointerdown', dismiss, true);
    return () => {
      document.removeEventListener('scroll', dismiss, true);
      document.removeEventListener('pointerdown', dismiss, true);
    };
  });
</script>

<svelte:window
  bind:innerWidth={viewportWidth}
  bind:innerHeight={viewportHeight}
  onkeydown={(e) => {
    if (e.key === 'Escape') tooltip.hideAll();
  }}
/>

<!-- `role="tooltip"` for what it is, but nothing points `aria-describedby` at it
     and so it carries no id: a mark in a canvas is not an element, so there is
     nothing for a description to hang off. The
     keyboard path to an alert is the graph's own A / shift-A stepper, which moves
     the selection and answers in the details pane. `aria-live` is deliberately
     absent too — a box that announced itself on every hover would talk over
     everything else. -->
{#if content}
  <div
    bind:this={el}
    role="tooltip"
    class="tooltip"
    class:measured
    style:left="{place.left}px"
    style:top="{place.top}px"
    style:max-width="{maxWidth}px"
  >
    {#if content.title}<span class="title">{content.title}</span>{/if}
    {#each content.lines ?? [] as line, i (i)}
      {#if line}<span class="line">{line}</span>{/if}
    {/each}
    {#if content.source}
      <span class="source">
        <span class="swatch" style:background={content.source.color}></span>
        {content.source.label}
      </span>
    {/if}
    {#if content.hint}<span class="hint">{content.hint}</span>{/if}
  </div>
{/if}

<style>
  /* Fixed, and above the Add-series overlay (z-index 10): a tooltip belongs to
     the pointer, not to the pane it happens to be over. `pointer-events: none`
     is load-bearing rather than tidy — the box follows the cursor closely
     enough that a hittable one would land under it, take the pointer off the
     element being described, and close itself. */
  .tooltip {
    position: fixed;
    z-index: 100;
    /* `max-content` is load-bearing, and it took a measurement to find out.
       A fixed box with `width: auto` is shrink-to-fit against the space between
       its `left` and the viewport's right edge — so placing it 1254px into a
       1500px window made it 246px wide and wrapped its text to three lines,
       which is the size the measurement then read. Placing from that flipped it
       to the left, where the same box is 340px and two lines: the measurement
       and the box on screen disagreed, and the flip was decided from a size that
       only existed at the position it was flipping away from. With `max-content`
       the box is as wide as its text (up to `max-width`) wherever it sits, which
       is what "size first, place second" needs to be true. */
    width: max-content;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 6px 8px;
    border: 1px solid var(--border-default);
    border-radius: 6px;
    background: var(--bg-subtle);
    color: var(--fg-default);
    box-shadow: var(--shadow-lifted);
    font: 12px/1.45 system-ui, sans-serif;
    pointer-events: none;
    /* Not `display: none` before the measure: the box has to be laid out to have
       a size to read. */
    opacity: 0;
  }
  .tooltip.measured {
    opacity: 1;
  }
  .title {
    font-weight: 600;
  }
  .hint {
    color: var(--fg-muted);
  }
  .source {
    display: flex;
    align-items: center;
    gap: 5px;
    color: var(--fg-muted);
  }
  .swatch {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }
</style>
