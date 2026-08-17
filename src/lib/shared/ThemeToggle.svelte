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

  // Marks, not words: the control sits in the shell's bottom-left corner at a
  // fixed 54px, and a spelled-out label would not fit in half of it. The full
  // name goes in `title` and `aria-label`.
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
  <!-- Both marks are always rendered, and the thumb travels between them: the
       one under the thumb is the theme you're in, the other is where a click
       takes you. Swapping a single mark would leave it ambiguous which of the
       two a lone sun meant.

       Drawn, not the text glyphs `☼ ☾` these used to be, for the reason
       ChevronIcon exists — except that here the font decided the *shape* and not
       just the size: `☾` has no filled form to ask for, so on Android it came out
       a hairline outline against the thumb's accent fill, and `☼` a ring with a
       dot. Inline rather than two components in shared/, unlike CrossIcon and the
       other two: those are one component each because they have three call sites
       at three sizes to keep in step, and this pair has one call site and is only
       legible as a pair. -->
  <span class="thumb" class:dark={isDark} aria-hidden="true"></span>
  <span class="glyph" class:lit={!isDark}>
    <!-- Filled disc, stroked rays. The moon opposite it is solid, and a sun that
         was also a ring would read as the lighter of the two marks rather than as
         its equal. Rays are in viewBox units from r=5.1 out to r=6.6, so the
         stroke width is the ~1.4px the other icons draw at. -->
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="8" r="3.4" fill="currentColor" />
      <path
        d="M8 2.9V1.4M8 13.1v1.5M2.9 8H1.4M13.1 8h1.5M4.39 4.39 3.33 3.33M11.61 11.61l1.06 1.06M11.61 4.39l1.06-1.06M4.39 11.61l-1.06 1.06"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
      />
    </svg>
  </span>
  <span class="glyph" class:lit={isDark}>
    <!-- One closed path: the long way around a r=6 circle at (8,8), then back
         along a r=5.6 circle centred up and to the right, which is the bite. Two
         arcs of one subpath rather than a disc with a masked-out second disc,
         because a mask needs an id and this component is rendered once per app
         but has no guarantee of that. -->
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M13.8 9.6A6 6 0 1 1 6.4 2.2A5.6 5.6 0 0 0 13.8 9.6Z" fill="currentColor" />
    </svg>
  </span>
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
