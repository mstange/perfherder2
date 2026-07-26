<script lang="ts">
  import {
    FILTER_FIELDS,
    chipToString,
    isFilterField,
    parseChip,
    type Filter,
    type FilterChip,
  } from './filter';

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
  let textValue = $state('');

  // Snapshot of the filter we've most recently handed to the parent. Used
  // to distinguish "the parent bounced our commit back" (ignore — the input
  // already has the right text) from "the parent replaced filter.text
  // externally" (adopt into textValue). Without this the debounce would
  // clobber the input mid-typing, because during the debounce window
  // `filter.text` still holds the pre-typing value.
  let lastCommittedFilter: Filter = filter;

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
    // whitespace between tokens is treated as the boundary.
    // eslint-disable-next-line no-useless-escape
    const pattern = /(\S+?):(\S+)(\s+)/g;
    let residue = raw.replace(pattern, (_full, f, v) => {
      if (isFilterField(f) && v.length > 0) {
        chipsFromText.push({ field: f, value: v.toLowerCase() });
        return ''; // consume the chip out of the text
      }
      // Not a known field — leave the token in-place so the user can keep
      // typing / see their mistake.
      return _full;
    });

    // Collapse leftover whitespace so we don't accumulate double spaces.
    residue = residue.replace(/\s+/g, ' ').replace(/^ /, '');

    let nextChips = filter.chips;
    if (chipsFromText.length > 0) {
      const seen = new Set(nextChips.map((c) => `${c.field}:${c.value}`));
      nextChips = [...nextChips];
      for (const c of chipsFromText) {
        const key = `${c.field}:${c.value}`;
        if (!seen.has(key)) {
          nextChips.push(c);
          seen.add(key);
        }
      }
    }
    textValue = residue;
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
    const next = filter.chips.filter(
      (c) => !(c.field === chip.field && c.value === chip.value),
    );
    commitNow({ ...filter, chips: next });
    inputEl?.focus();
  }

  const chipClass = (field: string) => `chip-field chip-field-${field}`;
</script>

<div class="filter-column">
  <div class="filter-input" role="search">
    {#each filter.chips as chip (chipToString(chip))}
      <span class="chip-pill" title={`Remove ${chip.field} filter`}>
        <span class={chipClass(chip.field)}>{chip.field}</span>
        <span class="chip-value">{chip.value}</span>
        <button
          type="button"
          class="chip-remove"
          aria-label={`Remove ${chip.field}:${chip.value}`}
          onclick={() => removeChip(chip)}
        >×</button>
      </span>
    {/each}
    <!-- svelte-ignore a11y_autofocus -->
    <input
      bind:this={inputEl}
      class="filter-text"
      type="text"
      placeholder={filter.chips.length === 0
        ? "Filter — free text, or field:value (e.g. repo:autoland, application:chrome)"
        : ''}
      value={textValue}
      oninput={onInput}
      onkeydown={onKeydown}
      autocomplete="off"
      spellcheck="false"
      autofocus
    />
  </div>

  <div class="filter-hint">
    <span>Fields:</span>
    {#each FILTER_FIELDS as f, i}<code>{f}</code>{i < FILTER_FIELDS.length - 1 ? ' ' : ''}{/each}
  </div>
</div>

<style>
  .filter-column {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-width: 300px;
  }
  .filter-input {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px;
    padding: 4px 6px;
    background: #fff;
    border: 1px solid #d0d7de;
    border-radius: 6px;
  }
  .filter-input:focus-within {
    border-color: #0969da;
    box-shadow: 0 0 0 3px rgba(9, 105, 218, 0.15);
  }
  .filter-text {
    flex: 1;
    min-width: 160px;
    border: 0;
    outline: 0;
    padding: 4px 4px;
    font: inherit;
    background: transparent;
  }
  .chip-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 2px 2px 6px;
    background: #eef1ff;
    border: 1px solid #b1c2ff;
    border-radius: 999px;
    font-size: 12px;
    line-height: 1.2;
    color: #24292f;
  }
  .chip-field {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 1px 4px;
    border-radius: 3px;
    background: #dbe4ff;
    color: #383f9c;
  }
  .chip-field-repo {
    background: #ffddec;
    color: #a4133c;
  }
  .chip-field-platform {
    background: #dbe4ff;
    color: #383f9c;
  }
  .chip-field-application {
    background: #cff0ff;
    color: #0a4b70;
  }
  .chip-field-option {
    background: #e5e7eb;
    color: #374151;
  }
  .chip-field-tag {
    background: #ddf4ff;
    color: #0e4c74;
  }
  .chip-field-suite,
  .chip-field-test {
    background: #dafbe1;
    color: #116329;
  }
  .chip-value {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }
  .chip-remove {
    padding: 0 6px;
    margin: 0;
    height: 18px;
    line-height: 1;
    background: transparent;
    border: 0;
    color: #57606a;
    cursor: pointer;
    font-size: 14px;
    border-radius: 999px;
  }
  .chip-remove:hover {
    background: rgba(0, 0, 0, 0.08);
    color: #1f2328;
  }
  .filter-hint {
    font-size: 11px;
    color: #57606a;
    padding-left: 4px;
  }
  .filter-hint code {
    background: #f6f8fa;
    padding: 0 3px;
    border-radius: 3px;
    font-size: 11px;
  }
</style>
