import { describe, expect, it } from 'vitest';

import {
  DETAILS_WIDTH,
  GRAPH_MIN_WIDTH,
  SIDEBAR_WIDTH,
  THREE_COLUMN_MIN,
  TWO_COLUMN_MIN,
  layoutForWidth,
  resolveNarrowPane,
} from './layout';

describe('layoutForWidth', () => {
  it('is three columns while the graph can keep its minimum beside both panes', () => {
    expect(layoutForWidth(1920)).toBe('wide');
    expect(layoutForWidth(THREE_COLUMN_MIN)).toBe('wide');
  });

  it('drops the details column exactly where the graph would go under', () => {
    expect(layoutForWidth(THREE_COLUMN_MIN - 1)).toBe('medium');
    expect(layoutForWidth(TWO_COLUMN_MIN)).toBe('medium');
  });

  it('drops to one pane exactly where the list would take the graph under', () => {
    expect(layoutForWidth(TWO_COLUMN_MIN - 1)).toBe('narrow');
    expect(layoutForWidth(390)).toBe('narrow');
    expect(layoutForWidth(0)).toBe('narrow');
  });

  // The point of the tiers: whatever the window, the graph is either at its
  // minimum or above it. This is the property the thresholds exist to hold, and
  // it is the one that breaks if someone edits a constant without the others.
  it('never leaves the graph below its minimum', () => {
    for (let width = TWO_COLUMN_MIN; width <= 2000; width++) {
      const mode = layoutForWidth(width);
      const apparatus = mode === 'wide' ? SIDEBAR_WIDTH + DETAILS_WIDTH : SIDEBAR_WIDTH;
      expect(width - apparatus).toBeGreaterThanOrEqual(GRAPH_MIN_WIDTH);
    }
  });

  // Below the last threshold the graph gets the whole window, so the guarantee
  // survives down to a window narrower than the minimum itself — at which point
  // there is nothing left to give and no arrangement can help.
  it('gives the graph the whole window once nothing fits beside it', () => {
    expect(layoutForWidth(TWO_COLUMN_MIN - 1)).toBe('narrow');
    expect(layoutForWidth(GRAPH_MIN_WIDTH)).toBe('narrow');
  });
});

describe('resolveNarrowPane', () => {
  it('honours the pane the user asked for', () => {
    expect(resolveNarrowPane('series', false)).toBe('series');
    expect(resolveNarrowPane('graph', false)).toBe('graph');
    expect(resolveNarrowPane('selection', true)).toBe('selection');
  });

  it('falls back to the graph when the selection it would show is gone', () => {
    expect(resolveNarrowPane('selection', false)).toBe('graph');
  });

  it('leaves the other panes alone when there is no selection', () => {
    expect(resolveNarrowPane('series', false)).toBe('series');
  });
});
