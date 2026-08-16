import { describe, expect, it } from 'vitest';

import {
  DETAILS_MIN_ROW,
  DETAILS_ROW_FRACTION,
  DETAILS_ROW_MAX,
  DETAILS_WIDTH,
  GRAPH_MIN_HEIGHT,
  GRAPH_MIN_WIDTH,
  SIDEBAR_WIDTH,
  STACKED_MIN_HEIGHT,
  THREE_COLUMN_MIN,
  TWO_COLUMN_MIN,
  isPaneVisible,
  layoutFor,
  resolvePane,
  switchedPanes,
} from './layout';

// A window tall enough that height never decides anything, for the tests that
// are only about width.
const TALL = 1200;

describe('layoutFor', () => {
  it('is three columns while the graph can keep its minimum beside both panes', () => {
    expect(layoutFor(1920, TALL)).toBe('wide');
    expect(layoutFor(THREE_COLUMN_MIN, TALL)).toBe('wide');
  });

  it('drops the details column exactly where the graph would go under', () => {
    expect(layoutFor(THREE_COLUMN_MIN - 1, TALL)).toBe('medium');
    expect(layoutFor(TWO_COLUMN_MIN, TALL)).toBe('medium');
  });

  it('drops to one pane exactly where the list would take the graph under', () => {
    expect(layoutFor(TWO_COLUMN_MIN - 1, TALL)).toBe('narrow');
    expect(layoutFor(390, TALL)).toBe('narrow');
    expect(layoutFor(0, TALL)).toBe('narrow');
  });

  it('unstacks the details pane exactly where the graph would go under', () => {
    expect(layoutFor(900, STACKED_MIN_HEIGHT)).toBe('medium');
    expect(layoutFor(900, STACKED_MIN_HEIGHT - 1)).toBe('short');
  });

  // The case that started this: at 844×390 the old width-only tier said
  // `medium`, and the details row plus the graph's own header left the detail
  // plot 12px tall.
  it('does not stack a landscape phone', () => {
    expect(layoutFor(844, 390)).toBe('short');
    expect(layoutFor(915, 412)).toBe('short');
  });

  it('still stacks a tablet held upright', () => {
    expect(layoutFor(768, 1024)).toBe('medium');
  });

  // Three columns don't stack anything, so a short window has nothing to gain
  // from a rearrangement and keeps the arrangement it can afford in width.
  it('lets a wide window stay wide however short it is', () => {
    expect(layoutFor(1600, 300)).toBe('wide');
  });

  // The point of the tiers: whatever the window, the graph is either at its
  // minimum or above it. This is the property the thresholds exist to hold, and
  // it is the one that breaks if someone edits a constant without the others.
  it('never leaves the graph below its minimum width', () => {
    for (let width = TWO_COLUMN_MIN; width <= 2000; width++) {
      const mode = layoutFor(width, TALL);
      const apparatus = mode === 'wide' ? SIDEBAR_WIDTH + DETAILS_WIDTH : SIDEBAR_WIDTH;
      expect(width - apparatus).toBeGreaterThanOrEqual(GRAPH_MIN_WIDTH);
    }
  });

  // Same property in the other axis, and the only tier that can break it is the
  // one that puts a pane in a row: everywhere else the graph has the window's
  // full height.
  it('never leaves the graph below its minimum height', () => {
    for (let height = 200; height <= 2000; height++) {
      if (layoutFor(900, height) !== 'medium') continue;
      expect(height - detailsRow(height)).toBeGreaterThanOrEqual(GRAPH_MIN_HEIGHT);
    }
  });

  // And the pane on the other side of that division gets enough to be worth
  // stacking. Not a term in the threshold — this is the check that it didn't
  // need to be.
  it('never stacks a details row too short to say anything', () => {
    for (let height = STACKED_MIN_HEIGHT; height <= 2000; height++) {
      expect(detailsRow(height)).toBeGreaterThanOrEqual(DETAILS_MIN_ROW);
    }
  });

  /** What `min(40%, 320px)` in App.svelte's medium grid resolves to. */
  function detailsRow(height: number): number {
    return Math.min(DETAILS_ROW_FRACTION * height, DETAILS_ROW_MAX);
  }
});

describe('switchedPanes', () => {
  it('switches nothing where every pane has a cell of its own', () => {
    expect(switchedPanes('wide')).toEqual([]);
    expect(switchedPanes('medium')).toEqual([]);
  });

  it('switches all three when nothing fits beside anything', () => {
    expect(switchedPanes('narrow')).toEqual(['series', 'graph', 'selection']);
  });

  it('leaves the series list a column when only height is short', () => {
    expect(switchedPanes('short')).toEqual(['graph', 'selection']);
  });

  it('always offers the graph, which is what the fallbacks return', () => {
    for (const mode of ['narrow', 'short'] as const) {
      expect(switchedPanes(mode)).toContain('graph');
    }
  });
});

describe('isPaneVisible', () => {
  it('shows every pane when none of them is switched', () => {
    for (const pane of ['series', 'graph', 'selection'] as const) {
      expect(isPaneVisible(pane, 'graph', [])).toBe(true);
    }
  });

  it('shows only the active one among the switched panes', () => {
    const panes = switchedPanes('narrow');
    expect(isPaneVisible('series', 'series', panes)).toBe(true);
    expect(isPaneVisible('graph', 'series', panes)).toBe(false);
  });

  // The case a single active-pane comparison gets wrong: the list is a column
  // here, so it stays on screen while the other two take turns.
  it('keeps an unswitched pane on screen while others take turns', () => {
    const panes = switchedPanes('short');
    expect(isPaneVisible('series', 'selection', panes)).toBe(true);
    expect(isPaneVisible('graph', 'selection', panes)).toBe(false);
    expect(isPaneVisible('selection', 'selection', panes)).toBe(true);
  });
});

describe('resolvePane', () => {
  const narrow = switchedPanes('narrow');
  const short = switchedPanes('short');

  it('honours the pane the user asked for', () => {
    expect(resolvePane('series', false, narrow)).toBe('series');
    expect(resolvePane('graph', false, narrow)).toBe('graph');
    expect(resolvePane('selection', true, narrow)).toBe('selection');
  });

  it('falls back to the graph when the selection it would show is gone', () => {
    expect(resolvePane('selection', false, narrow)).toBe('graph');
  });

  it('falls back to the graph for a pane this arrangement does not switch', () => {
    expect(resolvePane('series', false, short)).toBe('graph');
    expect(resolvePane('series', false, [])).toBe('graph');
  });

  it('leaves the other panes alone when there is no selection', () => {
    expect(resolvePane('series', false, narrow)).toBe('series');
  });
});
