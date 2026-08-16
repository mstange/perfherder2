<script lang="ts">
  // The chevron on every control that opens something or points a direction: the
  // graph header's Controls toggle, the Add-series panel's load-row summary, the
  // card list's sort direction. One component for the same reason `CrossIcon` is
  // one — they sit next to each other at three sizes and have to read as one
  // mark.
  //
  // It replaces the text glyphs `▾ ▴ ▲ ▼`, which are the wrong size at every
  // font size the app uses: a triangle drawn at 13px sits at about 6px of ink
  // beside a 13px label, and shrinking the label's font to fix it made a control
  // whose *text* was too small instead. A drawn chevron is sized in px, so it can
  // be as big as the line it sits on.
  //
  // Takes its color from `currentColor` and its direction from `dir`, so a
  // button's own rules only set `color`.
  let { size = 12, dir = 'down' }: { size?: number; dir?: 'down' | 'up' } = $props();

  // Stroke width is in viewBox units, so a fixed one would thin as `size` grows.
  // This keeps the drawn line ~1.4px at every size — heavier than CrossIcon's
  // 1.1, because a chevron is two strokes where a cross is four and reads lighter
  // at the same weight.
  const strokeWidth = $derived((1.4 * 16) / size);
</script>

<svg
  viewBox="0 0 16 16"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width={strokeWidth}
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <!-- One path, flipped rather than a second `d`: the two directions are the
       same mark and have to stay identical if either is ever adjusted. -->
  <path d="M4 6.5 8 10.5 12 6.5" transform={dir === 'up' ? 'rotate(180 8 8)' : undefined} />
</svg>
