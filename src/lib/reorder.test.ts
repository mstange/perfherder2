import { describe, expect, it } from 'vitest';
import {
  autoScrollDelta,
  clampDy,
  displacement,
  dragGeometry,
  dragOffsets,
  dropIndex,
  type CardBox,
} from './reorder';

// Three cards of different heights, 6px apart — the list's real gap, and
// deliberately not a uniform pitch.
const BOXES: CardBox[] = [
  { top: 0, height: 40 },
  { top: 46, height: 60 },
  { top: 112, height: 40 },
];
const GAP = 6;

// Stacks heights into boxes the way the flex column does, so the geometry can
// be checked against a layout actually performed rather than against the same
// arithmetic restated in the assertion.
function stack(heights: readonly number[]): CardBox[] {
  let top = 0;
  return heights.map((height) => {
    const box = { top, height };
    top += height + GAP;
    return box;
  });
}

// The list as `reorderSeries(from, to)` leaves it, laid out afresh.
function reordered(boxes: readonly CardBox[], from: number, to: number): CardBox[] {
  const heights = boxes.map((b) => b.height);
  heights.splice(to, 0, ...heights.splice(from, 1));
  return stack(heights);
}

describe('displacement', () => {
  it('is the dragged card’s height plus the gap', () => {
    expect(displacement(BOXES, 0)).toBe(46);
    expect(displacement(BOXES, 1)).toBe(66);
  });

  it('reads the gap off the preceding pair for the last card', () => {
    expect(displacement(BOXES, 2)).toBe(46);
  });

  it('is zero when there is nothing to reorder', () => {
    expect(displacement([{ top: 0, height: 40 }], 0)).toBe(0);
    expect(displacement([], 0)).toBe(0);
  });
});

describe('dragGeometry', () => {
  it('gives the travel to each slot, with zero for the card’s own', () => {
    // Dragging the first card: landing in slot 1 means its bottom ends up where
    // card 1's bottom is now (46 + 60 - 40), and in slot 2 where card 2's is.
    expect(dragGeometry(BOXES, 0).slots).toEqual([0, 66, 112]);
    // From the middle, slot 0 means its top ends up where card 0's top is.
    expect(dragGeometry(BOXES, 1).slots).toEqual([-46, 0, 46]);
    expect(dragGeometry(BOXES, 2).slots).toEqual([-112, -66, 0]);
  });

  it('keeps the slots in order, so the thresholds derived from them are too', () => {
    for (let from = 0; from < BOXES.length; from++) {
      const { slots } = dragGeometry(BOXES, from);
      expect(slots[from]).toBe(0);
      for (let j = 1; j < slots.length; j++) expect(slots[j]).toBeGreaterThan(slots[j - 1]);
    }
  });

  it('is where the card really lands, for every from/to pair', () => {
    // The align-tops-going-up, align-bottoms-going-down rule is the whole
    // basis for the thresholds, so it is checked against a re-layout: drop the
    // card in slot `to` and it must sit exactly where the committed order puts
    // it. A second fixture with one card much taller than the rest, because
    // that is where a rule that only works for a uniform pitch would show.
    for (const boxes of [BOXES, stack([100, 40, 40]), stack([40, 40, 100])]) {
      for (let from = 0; from < boxes.length; from++) {
        const { slots } = dragGeometry(boxes, from);
        for (let to = 0; to < boxes.length; to++) {
          expect(boxes[from].top + slots[to]).toBe(reordered(boxes, from, to)[to].top);
        }
      }
    }
  });

  it('is inert for an out-of-range card', () => {
    const geom = dragGeometry(BOXES, 7);
    expect(geom.slots).toEqual([0, 0, 0]);
    expect(geom.displacement).toBe(0);
  });
});

describe('dropIndex', () => {
  it('stays put when nothing has moved', () => {
    expect(dropIndex(dragGeometry(BOXES, 0), 0)).toBe(0);
    expect(dropIndex(dragGeometry(BOXES, 1), 0)).toBe(1);
    expect(dropIndex(dragGeometry(BOXES, 2), 0)).toBe(2);
  });

  it('hands over the slot halfway between two drop positions', () => {
    // Slots for card 0 are at 0, 66 and 112, so the thresholds are 33 and 89 —
    // half of the card's travel, not a whole neighbour.
    const geom = dragGeometry(BOXES, 0);
    expect(dropIndex(geom, 32)).toBe(0);
    expect(dropIndex(geom, 33)).toBe(1);
    expect(dropIndex(geom, 88)).toBe(1);
    expect(dropIndex(geom, 89)).toBe(2);
  });

  it('uses the same thresholds dragging up', () => {
    // Slots for the last card are at -112, -66 and 0, so the thresholds are
    // -33 and -89: the mirror image of the case above.
    const geom = dragGeometry(BOXES, 2);
    expect(dropIndex(geom, -32)).toBe(2);
    expect(dropIndex(geom, -34)).toBe(1);
    expect(dropIndex(geom, -88)).toBe(1);
    expect(dropIndex(geom, -90)).toBe(0);
  });

  it('resolves a threshold-exact drag downwards, in both directions', () => {
    // Only decides which side of a single pixel hands over the slot, but it
    // should at least be the same rule going up as going down.
    expect(dropIndex(dragGeometry(BOXES, 0), 33)).toBe(1);
    expect(dropIndex(dragGeometry(BOXES, 2), -33)).toBe(2);
    expect(dropIndex(dragGeometry(BOXES, 2), -89)).toBe(1);
  });

  it('walks all the way to either end', () => {
    expect(dropIndex(dragGeometry(BOXES, 0), 500)).toBe(2);
    expect(dropIndex(dragGeometry(BOXES, 2), -500)).toBe(0);
  });

  it('is an index into the list without the dragged card', () => {
    // Which is what reorderSeries splices into: dragging the first card to the
    // bottom of three is target 2, not 3.
    expect(dropIndex(dragGeometry(BOXES, 0), 200)).toBe(2);
  });
});

describe('clampDy', () => {
  it('passes a drag inside the list through untouched', () => {
    expect(clampDy(dragGeometry(BOXES, 0), 40)).toBe(40);
    expect(clampDy(dragGeometry(BOXES, 2), -40)).toBe(-40);
  });

  it('stops the lifted card in the first and last slots', () => {
    expect(clampDy(dragGeometry(BOXES, 0), 5000)).toBe(112);
    expect(clampDy(dragGeometry(BOXES, 0), -5000)).toBe(0);
    expect(clampDy(dragGeometry(BOXES, 2), -5000)).toBe(-112);
    expect(clampDy(dragGeometry(BOXES, 1), 5000)).toBe(46);
  });

  it('leaves both end slots reachable at the clamp', () => {
    // The reason to clamp to slot positions rather than to the content box: at
    // the clamp the card is *in* the end slot, so the drop index agrees.
    const first = dragGeometry(BOXES, 0);
    expect(dropIndex(first, clampDy(first, 5000))).toBe(2);
    const last = dragGeometry(BOXES, 2);
    expect(dropIndex(last, clampDy(last, -5000))).toBe(0);
  });

  it('leaves them reachable for a card taller than the ones at the ends', () => {
    // The case that rules out clamping the card's box inside the content:
    // aligning a tall card's bottom with the content bottom would leave it short
    // of the last slot.
    const tall: CardBox[] = [
      { top: 0, height: 100 },
      { top: 106, height: 40 },
      { top: 152, height: 40 },
    ];
    const first = dragGeometry(tall, 0);
    expect(dropIndex(first, clampDy(first, 5000))).toBe(2);
    const last = dragGeometry(tall, 2);
    expect(dropIndex(last, clampDy(last, -5000))).toBe(0);
  });

  it('pins a single card in place', () => {
    expect(clampDy(dragGeometry([{ top: 0, height: 40 }], 0), 500)).toBe(0);
  });
});

describe('dragOffsets', () => {
  it('is all zeros for an idle drag', () => {
    expect(dragOffsets(dragGeometry(BOXES, 1), 1, 0)).toEqual([0, 0, 0]);
  });

  it('moves the cards the dragged one passes downward out of the way', () => {
    // Card 0 travels down past card 1: card 1 steps up by card 0's pitch.
    expect(dragOffsets(dragGeometry(BOXES, 0), 1, 40)).toEqual([40, -46, 0]);
    expect(dragOffsets(dragGeometry(BOXES, 0), 2, 200)).toEqual([200, -46, -46]);
  });

  it('moves them down when the drag goes up', () => {
    expect(dragOffsets(dragGeometry(BOXES, 2), 0, -200)).toEqual([46, 46, -200]);
  });

  it('tracks the pointer exactly on the dragged card', () => {
    // No snapping: the lifted card sits under the finger, whatever the slot.
    expect(dragOffsets(dragGeometry(BOXES, 1), 1, 17)[1]).toBe(17);
  });

  it('previews the committed layout exactly, at a slot’s drop position', () => {
    // Ties the two halves of the module together: park the card in slot `to`
    // and the transforms describe precisely the layout `reorderSeries` will
    // produce. That equality is what lets `animate:flip` cover the commit
    // without anything jumping.
    for (const boxes of [BOXES, stack([100, 40, 40])]) {
      for (let from = 0; from < boxes.length; from++) {
        const geom = dragGeometry(boxes, from);
        for (let to = 0; to < boxes.length; to++) {
          const offsets = dragOffsets(geom, to, geom.slots[to]);
          const drawnTop = boxes.map((b, j) => b.top + offsets[j]);
          const order = [...boxes.keys()];
          order.splice(to, 0, ...order.splice(from, 1));
          expect(order.map((j) => drawnTop[j])).toEqual(
            reordered(boxes, from, to).map((b) => b.top),
          );
        }
      }
    }
  });
});

describe('autoScrollDelta', () => {
  const [top, bottom, edge, max] = [100, 500, 40, 12];

  it('is zero away from the edges', () => {
    expect(autoScrollDelta(300, top, bottom, edge, max)).toBe(0);
    expect(autoScrollDelta(top + edge, top, bottom, edge, max)).toBe(0);
    expect(autoScrollDelta(bottom - edge, top, bottom, edge, max)).toBe(0);
  });

  it('ramps up towards each edge', () => {
    expect(autoScrollDelta(120, top, bottom, edge, max)).toBe(-6);
    expect(autoScrollDelta(480, top, bottom, edge, max)).toBe(6);
    expect(autoScrollDelta(top, top, bottom, edge, max)).toBe(-max);
    expect(autoScrollDelta(bottom, top, bottom, edge, max)).toBe(max);
  });

  it('clamps beyond the edges instead of accelerating', () => {
    expect(autoScrollDelta(top - 400, top, bottom, edge, max)).toBe(-max);
    expect(autoScrollDelta(bottom + 400, top, bottom, edge, max)).toBe(max);
  });

  it('is zero for a degenerate scroller', () => {
    expect(autoScrollDelta(300, 100, 100, edge, max)).toBe(0);
    expect(autoScrollDelta(300, top, bottom, 0, max)).toBe(0);
  });
});
