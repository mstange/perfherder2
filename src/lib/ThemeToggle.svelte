<script lang="ts">
  // Three-way theme control: follow the OS, or force light or dark.
  //
  // A segmented radio group rather than a button that cycles, because "System"
  // is not a third appearance — it's the absence of a choice, and a cycling
  // button can't show you that you're on it without also showing you the two
  // you aren't. Three labelled options make the current state readable at a
  // glance and reaching any other one a single click.

  import { theme } from './theme.svelte';
  import { THEME_PREFERENCES, type ThemePreference } from './theme';

  // Glyphs, not words: the group sits in a header row that already carries the
  // range presets and the zoom state, and "System / Light / Dark" spelled out
  // is another 90px of a row that wraps at narrow widths. Every option keeps
  // its full name in `title` and `aria-label`.
  const LABELS: Record<ThemePreference, { glyph: string; name: string }> = {
    system: { glyph: '◐', name: 'Follow the system theme' },
    light: { glyph: '☀', name: 'Light theme' },
    dark: { glyph: '☾', name: 'Dark theme' },
  };
</script>

<!-- A radiogroup, not a set of buttons: the three are one exclusive choice, and
     that's what lets a screen reader say "2 of 3" instead of reading three
     unrelated toggles. Arrow-key navigation within the group comes from the
     radio inputs for free. -->
<div class="theme-toggle" role="radiogroup" aria-label="Theme">
  {#each THEME_PREFERENCES as preference (preference)}
    {@const label = LABELS[preference]}
    <label class="option" class:active={theme.preference === preference} title={label.name}>
      <input
        type="radio"
        name="theme"
        value={preference}
        checked={theme.preference === preference}
        aria-label={label.name}
        onchange={() => theme.setPreference(preference)}
      />
      <span aria-hidden="true">{label.glyph}</span>
    </label>
  {/each}
</div>

<style>
  .theme-toggle {
    display: inline-flex;
    /* One shared border around the three, so they read as one control. */
    border: 1px solid var(--border-default);
    border-radius: 6px;
    overflow: hidden;
  }
  .option {
    display: flex;
    align-items: center;
    justify-content: center;
    /* Fixed, so switching the active option can't change the group's width and
       shove the rest of the header row sideways. */
    width: 26px;
    height: 22px;
    background: var(--bg-canvas);
    color: var(--fg-muted);
    cursor: pointer;
    /* Separators between the segments, without doubling up on the outer
       border. */
    border-left: 1px solid var(--border-default);
  }
  .option:first-child {
    border-left: 0;
  }
  .option:hover {
    background: var(--bg-hover);
  }
  .option.active {
    background: var(--accent-emphasis);
    color: var(--fg-on-emphasis);
  }
  /* The radio itself is the accessible control and the focus target; it's the
     label around it that's visible. Hidden with clip rather than
     `display: none`, which would take it out of the tab order and out of the
     accessibility tree along with it. */
  .option input {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .option:focus-within {
    outline: 2px solid var(--accent-fg);
    outline-offset: -2px;
  }
</style>
