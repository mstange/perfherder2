import { describe, expect, it } from 'vitest';
import {
  contentKey,
  placeTooltip,
  POINTER_OFFSET_X,
  POINTER_OFFSET_Y,
  TOOLTIP_MAX_WIDTH,
  TOOLTIP_MIN_WIDTH,
  tooltipMaxWidth,
  VIEWPORT_MARGIN,
  type Anchor,
} from './tooltip';

const VIEWPORT = { width: 1000, height: 800 };
const BOX = { width: 200, height: 100 };

function atPointer(x: number, y: number): Anchor {
  return { x, y };
}

describe('contentKey', () => {
  it('separates content that differs anywhere', () => {
    const base = { title: 'a', lines: ['b'], hint: 'c' };
    expect(contentKey(base)).toBe(contentKey({ ...base }));
    expect(contentKey(base)).not.toBe(contentKey({ ...base, lines: ['b2'] }));
    expect(contentKey(base)).not.toBe(contentKey({ ...base, hint: 'c2' }));
    expect(contentKey(base)).not.toBe(
      contentKey({ ...base, source: { label: 'x', color: '#f00' } }),
    );
  });

  // The swatch is part of what is drawn, so a content change that only recolors
  // it still has to be measured — nothing else would notice.
  it('separates two colors of one label', () => {
    const a = { source: { label: 'x', color: '#f00' } };
    const b = { source: { label: 'x', color: '#00f' } };
    expect(contentKey(a)).not.toBe(contentKey(b));
  });
});

describe('tooltipMaxWidth', () => {
  it('caps at the maximum on a wide viewport', () => {
    expect(tooltipMaxWidth(1600)).toBe(TOOLTIP_MAX_WIDTH);
  });

  it('leaves both margins on a narrow one', () => {
    expect(tooltipMaxWidth(300)).toBe(300 - 2 * VIEWPORT_MARGIN);
  });

  it('stops narrowing at the minimum rather than going to one word per line', () => {
    expect(tooltipMaxWidth(120)).toBe(TOOLTIP_MIN_WIDTH);
  });
});

describe('placeTooltip, pointer anchor', () => {
  it('sits below and right of the cursor when there is room', () => {
    expect(placeTooltip(atPointer(400, 300), BOX, VIEWPORT)).toEqual({
      left: 400 + POINTER_OFFSET_X,
      top: 300 + POINTER_OFFSET_Y,
    });
  });

  it('flips to the left of the cursor near the right edge', () => {
    const place = placeTooltip(atPointer(950, 300), BOX, VIEWPORT);
    expect(place.left).toBe(950 - POINTER_OFFSET_X - BOX.width);
    expect(place.top).toBe(300 + POINTER_OFFSET_Y);
  });

  it('flips above the cursor near the bottom edge', () => {
    const place = placeTooltip(atPointer(400, 780), BOX, VIEWPORT);
    expect(place.left).toBe(400 + POINTER_OFFSET_X);
    expect(place.top).toBe(780 - POINTER_OFFSET_Y - BOX.height);
  });

  it('flips on both axes in a corner', () => {
    expect(placeTooltip(atPointer(990, 790), BOX, VIEWPORT)).toEqual({
      left: 990 - POINTER_OFFSET_X - BOX.width,
      top: 790 - POINTER_OFFSET_Y - BOX.height,
    });
  });

  // The flip only helps if the flipped box is itself on screen. A box 900px wide
  // under a cursor in the middle of a 1000px viewport fits on neither side of
  // it, so it is clamped to the far margin instead of hanging off an edge.
  it('clamps rather than flipping off the far edge', () => {
    const wide = { width: 900, height: 100 };
    const place = placeTooltip(atPointer(400, 300), wide, VIEWPORT);
    expect(place.left).toBe(VIEWPORT.width - VIEWPORT_MARGIN - wide.width);
    expect(place.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
  });

  it('pins a box taller than the viewport to the top margin', () => {
    const tall = { width: 200, height: 900 };
    expect(placeTooltip(atPointer(400, 300), tall, VIEWPORT).top).toBe(VIEWPORT_MARGIN);
  });

  // Whatever else it does, the box has to stay inside the viewport — that is the
  // one property every caller depends on. Swept over the whole plane.
  it('keeps the box inside the viewport from anywhere', () => {
    for (let x = 0; x <= VIEWPORT.width; x += 37) {
      for (let y = 0; y <= VIEWPORT.height; y += 37) {
        const place = placeTooltip(atPointer(x, y), BOX, VIEWPORT);
        expect(place.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
        expect(place.top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
        expect(place.left + BOX.width).toBeLessThanOrEqual(VIEWPORT.width - VIEWPORT_MARGIN);
        expect(place.top + BOX.height).toBeLessThanOrEqual(VIEWPORT.height - VIEWPORT_MARGIN);
      }
    }
  });

  it('never covers the cursor', () => {
    for (let x = 0; x <= VIEWPORT.width; x += 53) {
      for (let y = 0; y <= VIEWPORT.height; y += 53) {
        const place = placeTooltip(atPointer(x, y), BOX, VIEWPORT);
        const insideX = x > place.left && x < place.left + BOX.width;
        const insideY = y > place.top && y < place.top + BOX.height;
        expect(insideX && insideY).toBe(false);
      }
    }
  });
});
