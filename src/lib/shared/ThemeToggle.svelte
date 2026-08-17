<script lang="ts">
  // Two-state theme control: one click target, showing the theme you're in.
  //
  // The preference behind it is still three-way (see theme.ts), but "system" is
  // not a third *appearance* — at any moment it looks exactly like light or like
  // dark, so a control with three visual states spends a third of itself
  // distinguishing two things that are on screen identical. This shows the
  // resolved theme and switches to the other one; the preference is inferred
  // (`nextThemePreference`), preferring "system" whenever the destination is
  // what the OS asks for anyway.
  //
  // The cost is that "am I following the OS?" is no longer visible. That's a
  // question users ask far less often than "make this light" — and the answer is
  // in the tooltip.

  import { theme } from './theme.svelte';

  // Glyphs, not words: the control shares the series pane's footer with "Remove
  // all", inside a 280px column, and a spelled-out label would crowd it. The
  // full name goes in `title` and `aria-label`.
  const isDark = $derived(theme.resolved === 'dark');
  const destination = $derived(isDark ? 'light' : 'dark');
  // The tooltip is where the third state goes. Worth saying, because it's the
  // difference between "this tab is dark" and "this tab is dark because the
  // desktop is" — but not worth a pixel of the control, since it changes nothing
  // about what the next click does.
  const description = $derived(
    `${theme.resolved} theme${theme.preference === 'system' ? ', following the system' : ''}` +
      ` — click for ${destination}`,
  );
</script>

<!-- role="switch", not two buttons and not a radiogroup: there is one control
     with an on and an off, and that's what gets a screen reader to announce the
     state change on the same element the user just activated. A checkbox input
     would announce "checked", which says nothing about which theme won. -->
<button
  type="button"
  class="theme-toggle"
  role="switch"
  aria-checked={isDark}
  aria-label="Dark theme"
  title={description}
  onclick={() => theme.toggle()}
>
  <!-- Both glyphs are always rendered, and the thumb travels between them: the
       one under the thumb is the theme you're in, the other is where a click
       takes you. Swapping a single glyph would leave it ambiguous which of the
       two a lone sun meant. -->
  <span class="thumb" class:dark={isDark} aria-hidden="true"></span>
  <span class="glyph" class:lit={!isDark} aria-hidden="true">☼</span>
  <span class="glyph" class:lit={isDark} aria-hidden="true">☾</span>
</button>

<style>
  .theme-toggle {
    position: relative;
    display: inline-flex;
    align-items: stretch;
    /* Fixed, and sized to the two halves below, so nothing about the current
       theme can change the control's width and shove the rest of the header row
       sideways. */
    width: 54px;
    height: 24px;
    padding: 0;
    border: 1px solid var(--border-default);
    border-radius: 6px;
    background: var(--bg-canvas);
    cursor: pointer;
  }
  /* A 54×24 switch is a fingertip miss, and the thumb slides by half the width,
     so both halves have to grow together — the fixed width is the point of the
     control (see above), so this is a second fixed size rather than a floor.
     The height is app.css's 32 all the same: that is the app's only touch size —
     the bar beside this one used to hold a second, 44 — and a lone 36 here would
     have been one more to remember. */
  @media (pointer: coarse) {
    .theme-toggle {
      width: 72px;
      height: 32px;
    }
  }
  .theme-toggle:hover {
    background: var(--bg-hover);
  }
  .theme-toggle:focus-visible {
    outline: 2px solid var(--accent-fg);
    outline-offset: -2px;
  }
  .glyph {
    display: flex;
    flex: 1;
    align-items: center;
    justify-content: center;
    color: var(--fg-muted);
    /* Above the thumb, so the active glyph reads against the accent fill. */
    position: relative;
    z-index: 1;
  }
  /* The lit half. A positioned element rather than a background on the glyph
     itself, so it can slide instead of jumping — the movement is what makes the
     control read as one switch with two positions. */
  .thumb {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 50%;
    border-radius: 5px;
    background: var(--accent-emphasis);
    transition: transform 120ms ease;
  }
  .thumb.dark {
    transform: translateX(100%);
  }
  /* The glyph the thumb is under, which needs to read against the accent fill
     rather than against the track. */
  .glyph.lit {
    color: var(--fg-on-emphasis);
  }
  @media (prefers-reduced-motion: reduce) {
    .thumb {
      transition: none;
    }
  }
</style>
