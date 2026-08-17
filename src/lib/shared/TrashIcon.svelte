<script lang="ts">
  // "Remove all", in the series list's header. A distinct mark from `CrossIcon`
  // on purpose: the cross is what removes *one* series, on each card, and the two
  // sit in the same pane a few pixels apart. Same shape for both would make the
  // scope of the action a matter of remembering which one you are looking at.
  //
  // Takes its color from `currentColor`, so a button's own rules only set `color`.
  let { size = 14 }: { size?: number } = $props();

  // Stroke width is in viewBox units, so a fixed one would thin out as `size`
  // grows. Matches ChevronIcon's ~1.4px rather than CrossIcon's 1.1: this is five
  // strokes where the cross is two, and it reads lighter at the same weight.
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
  <!-- Lid, then can, then the two ribs. Drawn rather than a glyph for the reason
       the other two icons are: a text glyph is the wrong size at every font size
       this app uses, and an SVG is sized in px. -->
  <path d="M2.5 4.5h11M6.5 4.5V3h3v1.5" />
  <path d="M4 4.5l.6 8.2a1 1 0 0 0 1 .8h4.8a1 1 0 0 0 1-.8l.6-8.2" />
  <path d="M6.8 7v4M9.2 7v4" />
</svg>
