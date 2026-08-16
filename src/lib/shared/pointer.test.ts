import { describe, expect, it } from 'vitest';

import { shouldAutofocus, type MediaMatcher } from './pointer';

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
