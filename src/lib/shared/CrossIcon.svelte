<script lang="ts">
  // The cross on every dismiss control: the picker's close button, a filter
  // chip's remove, a series card's remove. One component so the three stay in
  // step — they sit at three different sizes and are meant to read as one mark.
  //
  // Takes its color from `currentColor`, so a button's hover rule only has to
  // set `color`.
  let { size = 12 }: { size?: number } = $props();

  // Stroke width is in viewBox units, so a fixed one would thin out as `size`
  // shrinks. This keeps the drawn line ~1.1px at every size.
  const strokeWidth = $derived((1.1 * 16) / size);
</script>

<svg
  viewBox="0 0 16 16"
  width={size}
  height={size}
  fill="none"
  stroke="currentColor"
  stroke-width={strokeWidth}
  stroke-linecap="round"
  aria-hidden="true"
>
  <path d="M4 4 12 12M12 4 4 12" />
</svg>
