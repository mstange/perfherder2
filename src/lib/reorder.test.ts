import { describe, expect, it } from 'vitest';
import {
  autoScrollDelta,
  clampDy,
  displacement,
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

// The midpoints of the fixture, for reference: 20, 76, 132.

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

describe('dropIndex', () => {
  it('stays put when nothing has moved', () => {
    expect(dropIndex(BOXES, 0, 0)).toBe(0);
    expect(dropIndex(BOXES, 1, 0)).toBe(1);
    expect(dropIndex(BOXES, 2, 0)).toBe(2);
  });

  it('swaps once the dragged card’s centre reaches its neighbour’s', () => {
    // Card 0's centre is at 20; card 1's at 76. 55px of travel isn't enough.
    expect(dropIndex(BOXES, 0, 55)).toBe(0);
    expect(dropIndex(BOXES, 0, 56)).toBe(1);
    expect(dropIndex(BOXES, 0, 57)).toBe(1);
  });

  it('swaps at the same place in both directions', () => {
    // Dragging card 1 up to card 0's centre is the mirror of the case above:
    // both hand over the slot exactly when the two centres meet.
    expect(dropIndex(BOXES, 1, -55)).toBe(1);
    expect(dropIndex(BOXES, 1, -56)).toBe(0);
  });

  it('walks all the way to either end', () => {
    expect(dropIndex(BOXES, 0, 500)).toBe(2);
    expect(dropIndex(BOXES, 2, -500)).toBe(0);
  });

  it('ignores the dragged card’s own midpoint when counting', () => {
    // Dragging the middle card up past card 0 must give 0, not 1 — the count
    // is over the *other* cards only.
    expect(dropIndex(BOXES, 1, -60)).toBe(0);
  });

  it('is an index into the list without the dragged card', () => {
    // Which is what reorderSeries splices into: dragging the first card to the
    // bottom of three is target 2, not 3.
    expect(dropIndex(BOXES, 0, 200)).toBe(2);
  });
});

describe('clampDy', () => {
  it('passes a drag inside the list through untouched', () => {
    expect(clampDy(BOXES, 0, 40)).toBe(40);
    expect(clampDy(BOXES, 2, -40)).toBe(-40);
  });

  it('stops the lifted card at the first and last centres', () => {
    // Centres are 20, 76 and 132, so card 0 can travel 112px down and none up.
    expect(clampDy(BOXES, 0, 5000)).toBe(112);
    expect(clampDy(BOXES, 0, -5000)).toBe(0);
    expect(clampDy(BOXES, 2, -5000)).toBe(-112);
    expect(clampDy(BOXES, 1, 5000)).toBe(56);
  });

  it('leaves both end slots reachable at the clamp', () => {
    // The whole point of clamping the centre rather than the card's box.
    expect(dropIndex(BOXES, 0, clampDy(BOXES, 0, 5000))).toBe(2);
    expect(dropIndex(BOXES, 2, clampDy(BOXES, 2, -5000))).toBe(0);
  });

  it('leaves the end slots reachable for a card taller than the ends', () => {
    // Box-clamping would fail here: aligning the tall card's bottom with the
    // content bottom leaves its centre above the last card's.
    const tall: CardBox[] = [
      { top: 0, height: 100 },
      { top: 106, height: 40 },
      { top: 152, height: 40 },
    ];
    expect(dropIndex(tall, 0, clampDy(tall, 0, 5000))).toBe(2);
    expect(dropIndex(tall, 2, clampDy(tall, 2, -5000))).toBe(0);
  });

  it('pins a single card in place', () => {
    expect(clampDy([{ top: 0, height: 40 }], 0, 500)).toBe(0);
  });
});

describe('dragOffsets', () => {
  it('is all zeros for an idle drag', () => {
    expect(dragOffsets(BOXES, 1, 1, 0)).toEqual([0, 0, 0]);
  });

  it('moves the cards the dragged one passes downward out of the way', () => {
    // Card 0 travels down past card 1: card 1 steps up by card 0's pitch.
    expect(dragOffsets(BOXES, 0, 1, 57)).toEqual([57, -46, 0]);
    expect(dragOffsets(BOXES, 0, 2, 200)).toEqual([200, -46, -46]);
  });

  it('moves them down when the drag goes up', () => {
    expect(dragOffsets(BOXES, 2, 0, -200)).toEqual([46, 46, -200]);
  });

  it('tracks the pointer exactly on the dragged card', () => {
    // No snapping: the lifted card sits under the finger, whatever the slot.
    expect(dragOffsets(BOXES, 1, 1, 17)[1]).toBe(17);
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
