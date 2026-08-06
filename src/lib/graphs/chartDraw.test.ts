import { describe, expect, it } from 'vitest';
import { hoverRingKind } from './chartDraw';

describe('hoverRingKind', () => {
  // The invariant the old per-state rule broke: whenever there is a dot under
  // the pointer there is a ring on it, whatever else is selected or pinned.
  // With a comparison pinned, hovering used to produce nothing at all.
  it('always rings a hovered dot', () => {
    for (const shift of [false, true]) {
      expect(hoverRingKind(true, shift)).not.toBeNull();
    }
  });

  it('rings nothing when the pointer is not over a dot', () => {
    expect(hoverRingKind(false, false)).toBeNull();
    expect(hoverRingKind(false, true)).toBeNull();
  });

  // The ring names the outcome of a click, and shift is the only thing that
  // changes that outcome.
  it('says "select" without shift and "compare" with it', () => {
    expect(hoverRingKind(true, false)).toBe('hoverable');
    expect(hoverRingKind(true, true)).toBe('hovered');
  });
});
