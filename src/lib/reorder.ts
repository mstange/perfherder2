// Geometry for the series list's drag-to-reorder. Pure, so the index and
// offset math is unit-testable without a DOM: the component measures boxes and
// applies numbers, it doesn't decide anything.
//
// Cards are not all the same height — a card's text wraps to two or three lines
// depending on how much distinguishes it — so nothing here may assume a
// uniform row pitch.

// One card's frozen layout box, in the scroller's *content* coordinates (top
// relative to the scrolled content, not the viewport), so that auto-scrolling
// mid-drag doesn't invalidate the measurement.
export type CardBox = { top: number; height: number };

// The vertical distance every card between the drag's origin and its target
// has to travel: the space the lifted card frees up, i.e. its own height plus
// the list's gap. The gap is read back out of the measured boxes rather than
// passed in, so changing `gap` in CSS can't silently desync this.
export function displacement(boxes: readonly CardBox[], from: number): number {
  const n = boxes.length;
  if (n < 2 || from < 0 || from >= n) return 0;
  // The pitch between two adjacent cards is (earlier card's height + gap), so
  // either neighbour pair yields the gap.
  const gap =
    from + 1 < n
      ? boxes[from + 1].top - boxes[from].top - boxes[from].height
      : boxes[from].top - boxes[from - 1].top - boxes[from - 1].height;
  return boxes[from].height + gap;
}

function centerOf(boxes: readonly CardBox[], i: number): number {
  return boxes[i].top + boxes[i].height / 2;
}

// Keeps the lifted card in the list. Its centre may travel between the first
// and last cards' centres and no further — without this it follows the pointer
// off the top or bottom of the panel, and since a translated element counts
// towards its scroller's overflow, stretches the scrollable area as it goes.
//
// The clamp is on the *centre* rather than on the card's box, because that is
// precisely the range in which every slot is still reachable: `dropIndex` picks
// the first or last slot exactly when the centre reaches the first or last
// card's centre. Clamping the box inside the content instead would leave the
// end slots unreachable whenever the dragged card is taller than the card at
// that end. The card can therefore overhang each end by up to half the height
// difference between it and the card there, which is a few pixels in practice.
export function clampDy(boxes: readonly CardBox[], from: number, dy: number): number {
  const n = boxes.length;
  if (n === 0 || from < 0 || from >= n) return 0;
  const center = centerOf(boxes, from);
  return Math.max(centerOf(boxes, 0) - center, Math.min(centerOf(boxes, n - 1) - center, dy));
}

// Where the lifted card would land if the pointer were released now, as an
// index into the list *with the dragged card taken out* — which is exactly
// what `AppState.reorderSeries` splices into.
//
// Midpoints come from the frozen layout, not from where the cards have since
// slid to. That's what makes it stable: the card swaps when the pointer passes
// where its neighbour *was*, so a card sliding out from under the pointer
// can't immediately trigger the reverse swap and oscillate.
export function dropIndex(boxes: readonly CardBox[], from: number, dy: number): number {
  const n = boxes.length;
  if (n === 0 || from < 0 || from >= n) return 0;
  const center = centerOf(boxes, from) + dy;
  let before = 0;
  for (let j = 0; j < n; j++) {
    if (j === from) continue;
    const c = centerOf(boxes, j);
    // Both directions swap at the same place — when the two centres meet — but
    // the comparison has to be inclusive on the far side, so that a drag
    // clamped to exactly the first or last centre still reaches that slot.
    if (j > from ? c <= center : c < center) before++;
  }
  return before;
}

// How far to translate each card mid-drag. The lifted card follows the pointer
// exactly; everything between its origin and its target steps aside by one
// `displacement`; everything else stays put.
export function dragOffsets(
  boxes: readonly CardBox[],
  from: number,
  to: number,
  dy: number,
): number[] {
  const shift = displacement(boxes, from);
  return boxes.map((_, j) => {
    if (j === from) return dy;
    if (j > from && j <= to) return -shift;
    if (j < from && j >= to) return shift;
    return 0;
  });
}

// Pixels to scroll this frame so a drag can reach past the visible part of the
// list. Zero unless the pointer is inside `edge` of either end, then ramping up
// to `max` at the very edge — HTML5 drag-and-drop did this for us for free, and
// without it a list taller than its scroller can't be fully reordered.
export function autoScrollDelta(
  pointerY: number,
  top: number,
  bottom: number,
  edge: number,
  max: number,
): number {
  if (edge <= 0 || bottom - top <= 0) return 0;
  const above = top + edge - pointerY;
  if (above > 0) return -max * Math.min(above, edge) / edge;
  const below = pointerY - (bottom - edge);
  if (below > 0) return max * Math.min(below, edge) / edge;
  return 0;
}
