// Tooltips: what one says, and where it goes.
//
// **Pure.** The reactive singleton that holds the currently shown tooltip is
// [tooltipState.svelte.ts](tooltipState.svelte.ts); the one element on screen is
// [Tooltip.svelte](Tooltip.svelte). Same split as theme.ts / theme.svelte.ts /
// ThemeToggle.svelte, and for the same reason: the arithmetic is the part worth
// testing, and it shouldn't need a DOM to exercise.
//
// **This exists for what the canvas paints, and nothing else.** An alert triangle
// and a detected-change bar have no element to hang a `title` on, so their
// explanation has to be drawn; every ordinary control in this app still uses
// `title`. See docs/design.md, "Tooltips: for what the canvas paints".

export type TooltipContent = {
  // Bold first row: what the thing under the pointer *is*.
  title?: string;
  // Body rows, in order.
  lines?: string[];
  // Which series a finding belongs to, with that series' plot color as a
  // swatch. Only worth filling in when more than one series is on the graph —
  // see graphTooltip.ts. `title` could not do this, which is half of why the
  // marks get a drawn box.
  source?: { label: string; color: string };
  // Muted last row, usually what a click would do.
  hint?: string;
};

// Where to put the box: viewport coordinates of the cursor. There is no
// element-anchored form, because a mark in a canvas is not an element and cannot
// be focused — the keyboard path to an alert is the graph's own <kbd>A</kbd>
// stepper, which moves the selection and so answers in the details pane.
export type Anchor = { x: number; y: number };

export type Size = { width: number; height: number };
export type Viewport = { width: number; height: number };
export type Placement = { left: number; top: number };

// The box never gets wider than this, however much room there is. A tooltip is
// read in a glance; a 900px line is read by moving your eyes.
export const TOOLTIP_MAX_WIDTH = 340;
// Never gets narrower than this either, however little room there is: at some
// point one word per line is worse than overflowing a margin.
export const TOOLTIP_MIN_WIDTH = 140;
// Clearance from the edges of the viewport.
export const VIEWPORT_MARGIN = 8;
// Clearance from the cursor. Asymmetric because a cursor hotspot is at the top
// left of a glyph that extends down and to the right, so the same gap that
// clears it sideways doesn't clear it downward.
export const POINTER_OFFSET_X = 14;
export const POINTER_OFFSET_Y = 18;

// Identity of what is being said, as opposed to where it is being said. The one
// place it matters is measurement: the box has to be measured once per *content*
// and not once per pointer move, and a key is what tells those two apart. See
// Tooltip.svelte.
export function contentKey(content: TooltipContent): string {
  return [
    content.title ?? '',
    ...(content.lines ?? []),
    content.source?.label ?? '',
    content.source?.color ?? '',
    content.hint ?? '',
  ].join('\u0000');
}

// **The cap depends on the viewport and on nothing else — deliberately.** The
// obvious refinement, capping to the room left on the side the box lands on, is
// a feedback loop: a narrower cap rewraps the text, which changes the height,
// which can change which side fits, which changes the cap. Sizing first and
// placing second makes the measured box a fact, and `placeTooltip` only has to
// choose where to put a rectangle it already knows.
export function tooltipMaxWidth(viewportWidth: number): number {
  return Math.max(TOOLTIP_MIN_WIDTH, Math.min(TOOLTIP_MAX_WIDTH, viewportWidth - 2 * VIEWPORT_MARGIN));
}

// Top-left corner for a box of `size`, in viewport coordinates.
//
// Below-right of the cursor by default, flipping to the left of it and/or above
// it when the box would leave the viewport, and clamped when neither side fits.
// The two axes are decided independently: in a bottom-right corner the box goes
// above *and* to the left, which is one call each rather than four cases.
export function placeTooltip(anchor: Anchor, size: Size, viewport: Viewport): Placement {
  return {
    left: onAxis(
      anchor.x + POINTER_OFFSET_X,
      anchor.x - POINTER_OFFSET_X - size.width,
      size.width,
      viewport.width,
    ),
    top: onAxis(
      anchor.y + POINTER_OFFSET_Y,
      anchor.y - POINTER_OFFSET_Y - size.height,
      size.height,
      viewport.height,
    ),
  };
}

// One axis of the above: the preferred position if the box fits there, the
// flipped one if it fits there, otherwise the preferred one clamped.
//
// Clamping rather than picking the roomier side is what keeps a tooltip near
// what it is about: a box too tall for the viewport pinned to the top margin
// still starts where its first line is readable, where centring it would put
// the title off screen.
function onAxis(
  preferred: number,
  flipped: number,
  extent: number,
  viewportExtent: number,
): number {
  const lo = VIEWPORT_MARGIN;
  const hi = viewportExtent - VIEWPORT_MARGIN - extent;
  if (preferred >= lo && preferred <= hi) return preferred;
  if (flipped >= lo && flipped <= hi) return flipped;
  // `hi < lo` when the box doesn't fit on this axis at all; `max` last means the
  // near margin wins, which is the readable end.
  return Math.max(lo, Math.min(hi, preferred));
}
