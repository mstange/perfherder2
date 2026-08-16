import { describe, expect, it } from 'vitest';

import { isCoarsePointer, shouldAutofocus, type MediaMatcher } from './pointer';

/** A matcher that answers one query and asserts nothing else is asked. */
function matcherFor(query: string, matches: boolean): MediaMatcher {
  return (q) => {
    expect(q).toBe(query);
    return { matches };
  };
}

describe('shouldAutofocus', () => {
  it('takes focus where the pointer is a mouse or trackpad', () => {
    expect(shouldAutofocus(matcherFor('(pointer: fine)', true))).toBe(true);
  });

  it('leaves the keyboard closed on a touch device', () => {
    expect(shouldAutofocus(matcherFor('(pointer: fine)', false))).toBe(false);
  });
});

describe('isCoarsePointer', () => {
  it('is the finger case, asked as its own question', () => {
    expect(isCoarsePointer(matcherFor('(pointer: coarse)', true))).toBe(true);
    expect(isCoarsePointer(matcherFor('(pointer: coarse)', false))).toBe(false);
  });

  // Not the negation of `shouldAutofocus`: a device can answer no to both (a
  // TV remote, `pointer: none`), and the two are asked for different reasons.
  it('is a separate query from the autofocus one', () => {
    const seen: string[] = [];
    const spy = (q: string) => {
      seen.push(q);
      return { matches: false };
    };
    shouldAutofocus(spy);
    isCoarsePointer(spy);
    expect(seen).toEqual(['(pointer: fine)', '(pointer: coarse)']);
  });
});
