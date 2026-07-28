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

// Everything a drag needs from the layout, measured once when the card is
// lifted. The per-move path is then a clamp, a bisection and a map — it never
// touches the DOM or re-derives geometry.
export type DragGeometry = {
  // The lifted card, as an index into the frozen layout.
  from: number;
  // Per slot, the `dy` at which the lifted card lands in that slot exactly.
  // Strictly increasing, and `slots[from]` is 0.
  slots: number[];
  // How far each card between origin and target steps aside.
  displacement: number;
};

// Landing in a slot *above* the origin means the card's top ends up where that
// card's top is now; landing *below* it means its bottom ends up where that
// card's bottom is now. That isn't an approximation — splice the card out and
// back in and the cards in between each shift by one `displacement`, which
// works out to exactly this. So `slots` is the drop position of every slot,
// and everything else is arithmetic on it.
//
// Positions come from the frozen layout, not from where the cards have since
// slid to. That's what makes the interaction stable: the thresholds don't move
// under the pointer, so a card stepping aside can't immediately satisfy the
// reverse test and oscillate.
export function dragGeometry(boxes: readonly CardBox[], from: number): DragGeometry {
  if (from < 0 || from >= boxes.length) {
    return { from, slots: boxes.map(() => 0), displacement: 0 };
  }
  const bottom = boxes[from].top + boxes[from].height;
  const slots = boxes.map((box, j) => {
    if (j < from) return box.top - boxes[from].top;
    if (j > from) return box.top + box.height - bottom;
    return 0;
  });
  return { from, slots, displacement: displacement(boxes, from) };
}

// Keeps the lifted card in the list: it may travel exactly as far as the first
// and last slots and no further. Without this it follows the pointer off the
// top or bottom of the panel, and since a translated element counts towards
// its scroller's overflow, stretches the scrollable area as it goes.
//
// Clamping to the slot positions is what makes both ends reachable *and* keeps
// the card inside the content, whatever the relative card heights: at the
// clamp the card is sitting in the end slot, not merely near it.
export function clampDy({ slots }: DragGeometry, dy: number): number {
  if (slots.length === 0) return 0;
  return Math.max(slots[0], Math.min(slots[slots.length - 1], dy));
}

// Where the lifted card would land if the pointer were released now, as an
// index into the list *with the dragged card taken out* — which is exactly
// what `AppState.reorderSeries` splices into.
//
// The card takes the slot it is nearest, so the threshold between two slots is
// the midpoint between their two drop positions — half a card's travel, not a
// whole one. Reordering when the card has merely *entered* the slot it's aimed
// at is the point: waiting until it has crossed the neighbour outright means
// the list only rearranges after you've already dragged past your target.
export function dropIndex({ slots }: DragGeometry, dy: number): number {
  let to = 0;
  // Ties resolve downwards, consistently in both directions; it only decides
  // which side of a single pixel hands over the slot.
  while (to + 1 < slots.length && dy >= (slots[to] + slots[to + 1]) / 2) to++;
  return to;
}

// How far to translate each card mid-drag. The lifted card follows the pointer
// exactly; everything between its origin and its target steps aside by one
// `displacement`; everything else stays put.
//
// Note that at `dy === slots[to]` these offsets describe the committed layout
// exactly — the cards are already where `reorderSeries` will put them. That is
// what keeps the drop cheap: `animate:flip` has nothing to do for any card but
// the lifted one, because their before/after rects match.
export function dragOffsets(geom: DragGeometry, to: number, dy: number): number[] {
  const { from, slots, displacement: shift } = geom;
  return slots.map((_, j) => {
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
