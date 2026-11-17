<script lang="ts">
  // A quiet icon button that copies `text` to the clipboard, and says so by
  // swapping its icon for a check mark for a moment.
  //
  // It exists for one request: a sheriff who has found the culprit pastes its
  // full revision into the alert summary. The link beside it shows the
  // twelve-character form, and selecting a link's text by dragging follows the
  // link half the time, so copying it was harder than it should be.
  //
  // The confirmation is the icon, not a word, so the button keeps its size and
  // nothing beside it moves (design.md, "Layout stability"). A failed copy
  // (no clipboard permission, or an insecure origin) shows a cross and says
  // why in its `title`, rather than pretending it worked.
  //
  // Bespoke rather than `.btn`, for the reason MachineFocusButton gives: a
  // `.btn` is a 26px control, and this sits in an 18px row of a definition list.

  type Props = {
    text: string;
    // What is being copied, for the title: "Copy the full revision".
    what: string;
  };
  let { text, what }: Props = $props();

  // How long the check mark (or the cross) stays before the copy icon returns.
  const FEEDBACK_MS = 1500;

  let state = $state<'idle' | 'copied' | 'failed'>('idle');
  let timer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => () => clearTimeout(timer));

  // A new value to copy is a new button as far as the reader is concerned: a
  // check mark left over from the previous point would claim this one was
  // copied too.
  $effect(() => {
    void text;
    clearTimeout(timer);
    state = 'idle';
  });

  async function copy(): Promise<void> {
    clearTimeout(timer);
    try {
      await navigator.clipboard.writeText(text);
      state = 'copied';
    } catch {
      state = 'failed';
    }
    timer = setTimeout(() => (state = 'idle'), FEEDBACK_MS);
  }

  const title = $derived(
    state === 'copied'
      ? 'Copied'
      : state === 'failed'
        ? 'Copying failed: the browser refused clipboard access'
        : `Copy ${what}`,
  );
</script>

<button
  type="button"
  class="copy"
  class:copied={state === 'copied'}
  class:failed={state === 'failed'}
  {title}
  aria-label={title}
  onclick={copy}
>
  <svg
    viewBox="0 0 16 16"
    width="13"
    height="13"
    fill="none"
    stroke="currentColor"
    stroke-width="1.3"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {#if state === 'copied'}
      <path d="M3 8.5 6.5 12 13 4.5" />
    {:else if state === 'failed'}
      <path d="M4 4 12 12M12 4 4 12" />
    {:else}
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" />
    {/if}
  </svg>
</button>

<style>
  /* Quiet at rest, like the pane's other inline controls: muted ink, no border.
     The border arrives on hover. */
  .copy {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 18px;
    padding: 0;
    margin-left: 2px;
    /* Negative block margins, so the button sits on the text's line without
       making that line any taller: an 18px inline box centred on the middle of
       the x-height stuck out of the pane's 19px line box, and made the
       Revision row 0.2px taller than the same row without it. */
    margin-block: -2px;
    vertical-align: middle;
    border: 1px solid transparent;
    border-radius: 4px;
    background: none;
    color: var(--fg-muted);
    cursor: pointer;
  }
  .copy:hover {
    border-color: var(--border-default);
    background: var(--bg-hover);
    color: var(--fg-default);
  }
  .copy.copied {
    color: var(--success-fg);
  }
  .copy.failed {
    color: var(--danger-fg);
  }
  @media (pointer: coarse) {
    /* Not a `.btn`, so it takes app.css's one floor by hand. See design.md,
       "Touch". */
    .copy {
      min-width: 32px;
      min-height: 32px;
    }
  }
</style>
