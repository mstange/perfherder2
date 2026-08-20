<script lang="ts">
  import { untrack } from 'svelte';
  import {
    addChip,
    chipToString,
    parseChip,
    toggleChipNegation,
    type Filter,
    type FilterChip,
  } from './filter';
  import CrossIcon from '../shared/CrossIcon.svelte';
  import { mediaMatcher, shouldAutofocus } from '../shared/pointer';

  type Props = {
    filter: Filter;
    onchange: (next: Filter) => void;
    // Coalesce free-text edits into a single commit after this many ms of
    // typing quiet. Structural changes (chip add/remove, backspace-restore,
    // Enter) always commit immediately. Set 0 to disable.
    //
    // Why: every commit re-runs the picker's filter pipeline, which walks
    // every visible row and every badge inside it. On a 500-row list that
    // costs ~100ms of Svelte-flush work per keystroke (measured), and the
    // keypress handler blocks the input until it's done. Debouncing keeps
    // the input responsive; the expensive work happens between keystrokes.
    textDebounceMs?: number;
  };
  let { filter, onchange, textDebounceMs = 150 }: Props = $props();

  let inputEl: HTMLInputElement | undefined = $state();

  // The <input> value; we don't bind directly to filter.text because we need
  // to snip out `field:value` prefixes as chips whenever the user types a
  // trailing space, and we don't want that mid-flight parse to be observable
  // to the parent as a raw filter.text update.
  //
  // **Seeded from the prop, and it has to be.** This is the only part of the
  // filter the input doesn't render straight out of `filter` — the chips come
  // from `filter.chips` on every render, but the text lives here. Starting it
  // at '' meant a filter that arrived with text already in it (a shared link
  // carrying `pf=`, or reopening the panel on a filter the user left text in)
  // rendered an empty-looking box over a list that was very much still
  // filtered, with no way to see or clear the term doing it. The adopt-effect
  // below can't cover for that: it fires only when `filter.text` differs from
  // `lastCommittedFilter.text`, and at construction those are the same object.
  let textValue = $state(untrack(() => filter.text));

  // Snapshot of the filter we've most recently handed to the parent. Used
  // to distinguish "the parent bounced our commit back" (ignore — the input
  // already has the right text) from "the parent replaced filter.text
  // externally" (adopt into textValue). Without this the debounce would
  // clobber the input mid-typing, because during the debounce window
  // `filter.text` still holds the pre-typing value.
  //
  // `untrack` on the initializer makes it explicit that we want the
  // *current* value of the `filter` prop at construction time, not a
  // reactive subscription to it — Svelte 5 warns on plain reads of props
  // outside an effect / derived because that's a common footgun. The
  // snapshot semantics is exactly what we want, so we opt out of tracking.
  let lastCommittedFilter: Filter = untrack(() => filter);

  // A text-only edit that we've computed but haven't yet handed to the
  // parent. Cleared when the timer fires (or we commit immediately for
  // some other reason).
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingFilter: Filter | null = null;

  $effect(() => {
    // Adopt an external change to filter.text (parent replaced it without
    // going through our commit path). Ignore echoes of our own commits.
    if (filter.text !== lastCommittedFilter.text) {
      textValue = filter.text;
      lastCommittedFilter = filter;
      // The pending debounce holds the pre-external text. Drop it so it
      // can't fire and overwrite the value the parent just set.
      cancelPending();
    }
  });

  // On teardown, drop any pending commit rather than firing it — the
  // parent may be going away, and half-typed text isn't worth persisting.
  $effect(() => () => cancelPending());

  function cancelPending() {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    pendingFilter = null;
  }

  function commitNow(next: Filter) {
    cancelPending();
    lastCommittedFilter = next;
    onchange(next);
  }

  function scheduleTextCommit(next: Filter) {
    pendingFilter = next;
    if (textDebounceMs <= 0) {
      flushPending();
      return;
    }
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(flushPending, textDebounceMs);
  }

  function flushPending() {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (pendingFilter) commitNow(pendingFilter);
  }

  // Called on every input event: try to extract completed `field:value`
  // tokens (those followed by whitespace) and turn them into chips. Also
  // publish the remaining text back to the parent.
  function reconcile(raw: string) {
    const chipsFromText: FilterChip[] = [];
    // Match `field:value` where the value ends at whitespace. Any run of
    // whitespace between tokens is treated as the boundary. `parseChip` decides
    // what is a chip, rather than a second copy of the rules here — that is
    // what makes a typed `-application:firefox` mean the same as one out of a
    // URL or a CLI term.
    const pattern = /(\S+?):(\S+)(\s+)/g;
    let residue = raw.replace(pattern, (_full, f, v) => {
      const chip = parseChip(`${f}:${v}`);
      if (chip) {
        chipsFromText.push(chip);
        return ''; // consume the chip out of the text
      }
      // Not a known field — leave the token in-place so the user can keep
      // typing / see their mistake.
      return _full;
    });

    // Collapse leftover whitespace so we don't accumulate double spaces.
    residue = residue.replace(/\s+/g, ' ').replace(/^ /, '');

    // `addChip` rather than a de-dup set of our own: it also replaces a chip's
    // opposite-polarity twin, so typing `-application:firefox` over an existing
    // `application:firefox` reads as a correction instead of building the pair
    // that matches nothing.
    let nextChips = filter.chips;
    for (const c of chipsFromText) {
      nextChips = addChip({ chips: nextChips, text: '' }, c).chips;
    }
    textValue = residue;
    // The <input> is `value={textValue}`, so Svelte writes the DOM only when
    // that signal *changes* — and `residue` is often the value the signal
    // already had, while the raw text the user put in the box is still sitting
    // there. Typing a `field:value` token character by character gets away with
    // it (the signal passes through the partial token on the way), but pasting
    // one in goes from '' straight back to '', and the pasted text would stay
    // visible next to the chip it just became. Push it explicitly.
    if (inputEl && inputEl.value !== residue) inputEl.value = residue;
    const next: Filter = { chips: nextChips, text: residue };
    // Chip mutations are structural — commit immediately so the pill
    // appears without lag. Pure free-text edits are debounced so each
    // keystroke doesn't cascade through the whole filter pipeline.
    if (chipsFromText.length > 0) commitNow(next);
    else scheduleTextCommit(next);
  }

  function onInput(e: Event) {
    const raw = (e.currentTarget as HTMLInputElement).value;
    reconcile(raw);
  }

  // Backspace on an empty input pops the last chip back into the input for
  // editing. This matches the UX of GitHub / Gmail / Linear search boxes.
  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Backspace' && textValue === '' && filter.chips.length > 0) {
      e.preventDefault();
      const last = filter.chips[filter.chips.length - 1];
      const next = filter.chips.slice(0, -1);
      const restored = chipToString(last);
      textValue = restored;
      commitNow({ chips: next, text: restored });
      return;
    }
    if (e.key === 'Enter') {
      // Commit whatever the user has typed as if they hit space — lets
      // them submit a bare `field:value` without a trailing space. Flush
      // any pending debounce so Enter is always immediate.
      e.preventDefault();
      reconcile(textValue + ' ');
      flushPending();
    }
  }

  function removeChip(chip: FilterChip) {
    const next = filter.chips.filter((c) => c !== chip);
    commitNow({ ...filter, chips: next });
    inputEl?.focus();
  }

  // Include ⇄ exclude, in place. The badges in the list do this with alt-click,
  // which a touch or keyboard user hasn't got; the pill is a plain button, so
  // this is the path that is always there — and the one that makes the feature
  // discoverable, since the pill says which way it is pointing.
  function flipPolarity(chip: FilterChip) {
    commitNow(toggleChipNegation(filter, chip));
  }

  const chipClass = (field: string) => `chip-field chip-field-${field}`;

  // Take focus on mount, where that is a courtesy rather than a hijack. This
  // used to be the `autofocus` attribute, but that is unreliable when the input
  // appears in a panel rather than on initial page load, and it needed an a11y
  // suppression. Reading `inputEl` makes this run once when the binding lands.
  //
  // The condition is `shouldAutofocus` in shared/pointer.ts, and it is there for
  // the reason recorded beside it: on a phone this line was opening the on-screen
  // keyboard over the list the panel exists to show, before the user had decided
  // whether they were typing or scrolling.
  $effect(() => {
    if (shouldAutofocus(mediaMatcher)) inputEl?.focus();
  });
</script>

<div class="filter-input" role="search">
  {#each filter.chips as chip (chipToString(chip))}
    <span class="chip-pill" class:chip-negated={chip.negated}>
      <button
        type="button"
        class="chip-body"
        title={chip.negated
          ? `Excluding ${chip.field}:${chip.value} — click to filter to only it instead`
          : `Filtered to ${chip.field}:${chip.value} — click to exclude it instead`}
        aria-label={chip.negated
          ? `Filter to only ${chip.field}:${chip.value} instead of excluding it`
          : `Exclude ${chip.field}:${chip.value} instead of filtering to it`}
        onclick={() => flipPolarity(chip)}
      >
        <span class={chipClass(chip.field)}
          >{chip.negated ? `not ${chip.field}` : chip.field}</span
        >
        <span class="chip-value">{chip.value}</span>
      </button>
      <button
        type="button"
        class="chip-remove"
        title={`Remove ${chip.field} filter`}
        aria-label={`Remove ${chipToString(chip)}`}
        onclick={() => removeChip(chip)}
      >
        <CrossIcon size={9} />
      </button>
    </span>
  {/each}
  <input
    bind:this={inputEl}
    class="filter-text"
    type="text"
    placeholder={filter.chips.length === 0
      ? 'Filter — free text, or field:value (e.g. repo:autoland, -application:chrome)'
      : ''}
    value={textValue}
    oninput={onInput}
    onkeydown={onKeydown}
    autocomplete="off"
    spellcheck="false"
  />
</div>

<style>
  .filter-input {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    background: var(--bg-canvas);
    border: 1px solid var(--border-default);
    border-radius: 6px;
    /* Grow to fill the filter row (previously on the .filter-column
       wrapper we dropped when removing the Fields hint). */
    flex: 1;
    /* **No `min-width` here, and that is load-bearing.** This box sits in the
       control block's middle grid track, which is `minmax(0, 1fr)`; the right
       rail's track is `auto` and does not shrink. A floor on the box therefore
       does not make the row wider, it makes the box *overflow its own track* and
       run under the rail — measured: at a 596px window the "Derive filter" button
       sat 32px inside the filter box, and it was still 8px at 620. The chips'
       own min-content width is the honest floor (a long platform chip is ~230px),
       and below the widths where even that fits, the container query in app.css
       has already folded the block to one column. */
    min-width: 0;
  }
  /* A derived filter can be six chips, and at a phone's width each one takes a
     line of its own — 300px of panel, most of it spent restating the graph the
     user came from. Capped at three lines and scrolled: every chip stays present
     and removable, which a "+3 more" summary would not manage, and the box stops
     competing with the list. The container is the picker panel (`picker-panel`,
     declared in AddSeriesPicker), so this fires on the same width as the rest of
     the panel's folding. */
  @container picker-panel (width < 560px) {
    .filter-input {
      max-height: 96px;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
  }
  .filter-input:focus-within {
    border-color: var(--accent-emphasis);
    box-shadow: 0 0 0 3px var(--accent-focus-ring);
  }
  .filter-text {
    flex: 1;
    /* Enough to see a token being typed, and no more: this is the other floor
       that can push the box past its track (see above). */
    min-width: 120px;
    border: 0;
    outline: 0;
    padding: 4px 4px;
    font: inherit;
    background: transparent;
  }
  .chip-pill {
    display: inline-flex;
    align-items: center;
    padding: 2px 2px 2px 0;
    background: var(--chip-pill-bg);
    border: 1px solid var(--chip-pill-border);
    border-radius: 999px;
    font-size: 12px;
    line-height: 1.2;
    color: var(--chip-pill-fg);
  }
  /* An exclusion, in the colour the app uses for taking things away. The pill
     also says "not" in front of the field name, and that is the part doing the
     work — the tint is for spotting it in a row of six. */
  .chip-negated {
    background: var(--danger-subtle);
    border-color: var(--danger-border);
  }
  /* The field name and value are one button: click flips the chip between
     include and exclude. Everything but the padding it took over from the pill
     is undone `<button>` styling. */
  .chip-body {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0 4px 0 6px;
    margin: 0;
    border: 0;
    background: transparent;
    font: inherit;
    color: inherit;
    cursor: pointer;
    border-radius: 999px 3px 3px 999px;
  }
  .chip-body:hover {
    background: var(--bg-overlay-hover);
  }
  .chip-field {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--field-platform-chip-bg);
    color: var(--field-platform-fg);
  }
  .chip-field-repo {
    background: var(--field-repo-chip-bg);
    color: var(--field-repo-fg);
  }
  /* No `.chip-field-platform`: platform's colours are `.chip-field`'s own
     default above, and a rule restating them was two spellings of one pair. */
  .chip-field-application {
    background: var(--field-app-bg);
    color: var(--field-app-fg);
  }
  .chip-field-option {
    background: var(--field-option-chip-bg);
    color: var(--field-option-chip-fg);
  }
  .chip-field-suite,
  .chip-field-test {
    background: var(--field-suite-bg);
    color: var(--field-suite-fg);
  }
  .chip-value {
    font-family: var(--font-mono);
    font-size: 12px;
  }
  .chip-remove {
    display: grid;
    place-items: center;
    padding: 0 6px;
    margin: 0;
    height: 18px;
    background: transparent;
    border: 0;
    color: var(--fg-muted);
    cursor: pointer;
    border-radius: 999px;
  }
  .chip-remove:hover {
    background: var(--bg-overlay-active);
    color: var(--fg-default);
  }

  /* Touch sizing for the controls in here, and they have to come *after* the
     base rules: a media query adds no specificity, so an earlier block loses to a
     later declaration of the same property. (It did, and the taps stayed 18px.)
     - `.chip-remove` at 21×18, in a row of them, is a mis-tap that removes the
       wrong filter. The pill grows with it, which is a touch-only cost.
     - `.chip-body` is the polarity flip, and the only one of the three ways to
       negate a chip that a touch device has — alt-click needs a keyboard and
       typing `-field:value` needs the reader to know the syntax. It gets the
       same floor as the remover beside it.
     - `.filter-text` inherits the panel's 14px, and iOS zooms the page when a
       field under 16px takes focus — scaling the layout viewport up and pushing
       half the panel off screen. app.css's coarse rule can't reach this one:
       `font: inherit` in a scoped component style outranks a global
       `input[type='text']`, so the override belongs where the shorthand is. */
  @media (pointer: coarse) {
    .chip-remove {
      padding: 0 10px;
      height: 32px;
    }
    .chip-body {
      min-height: 32px;
    }
    .filter-text {
      font-size: 16px;
      min-height: 32px;
    }
  }
</style>
