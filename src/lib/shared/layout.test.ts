import { describe, expect, it } from 'vitest';

import {
  CONTROL_BLOCK_NARROW,
  DETAILS_MIN_ROW,
  DETAILS_WIDTH,
  GRAPH_MIN_HEIGHT,
  GRAPH_MIN_HEIGHT_COMPACT,
  GRAPH_MIN_WIDTH,
  BOTTOM_BAR_HEIGHT,
  NARROW_DETAILS_ROW_FRACTION,
  NARROW_GRAPH_RESERVE,
  NARROW_STACK_MIN_HEIGHT,
  SIDEBAR_WIDTH,
  THREE_COLUMN_MIN,
  TWO_COLUMN_MIN,
  PICKER_LIST_MIN,
  foldPickerLoadRow,
  isPaneVisible,
  layoutFor,
  listIsSheet,
  listSheetCoversPanes,
  pickerChromeCost,
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

  // The list's column is the first thing given up, and height has no say in it:
  // both remaining panes are still columns, so there is nothing a taller or
  // shorter window would rearrange.
  it('drops the list to a sheet exactly where three columns stop fitting', () => {
    expect(layoutFor(THREE_COLUMN_MIN - 1, TALL)).toBe('medium');
    expect(layoutFor(TWO_COLUMN_MIN, TALL)).toBe('medium');
    for (const height of [300, 390, 600, 717, 1200]) {
      expect(layoutFor(900, height)).toBe('medium');
    }
  });

  // The iPad in landscape with Safari's chrome, which is the window that prompted
  // this: it used to be the tier where the graph and the selection took turns, so
  // you could only ever look at one of the two things the app is for.
  it('keeps both data panes on screen for an iPad in landscape', () => {
    expect(layoutFor(1024, 648)).toBe('medium');
    expect(layoutFor(1024, 768)).toBe('medium');
  });

  // A landscape phone, too. It used to be the case that justified a whole tier —
  // `short` — and nothing is in a row here, so there is nothing for it to guard.
  it('keeps both data panes on screen for a landscape phone', () => {
    expect(layoutFor(844, 390)).toBe('medium');
    expect(layoutFor(915, 412)).toBe('medium');
  });

  it('drops to one column exactly where those two columns stop fitting', () => {
    expect(layoutFor(TWO_COLUMN_MIN - 1, TALL)).toBe('narrow');
    expect(layoutFor(390, TALL)).toBe('narrow');
    expect(layoutFor(0, TALL)).toBe('narrow');
  });

  // `GRAPH_MIN_WIDTH + DETAILS_WIDTH`, not the old list-plus-graph sum: the pane
  // keeping its column beside the graph is the details pane now.
  it('measures the two-column floor from the two panes actually in it', () => {
    expect(TWO_COLUMN_MIN).toBe(GRAPH_MIN_WIDTH + DETAILS_WIDTH);
    expect(layoutFor(730, TALL)).toBe('narrow');
  });

  // The phones the one-column arrangement is for, and the point of deriving its
  // threshold from the *collapsed* header floor rather than the open-header one:
  // at 717 the 667px phone would have gone to the switching tier.
  it('stacks every phone held upright, down to a 667px one', () => {
    expect(layoutFor(390, 844)).toBe('narrow');
    expect(layoutFor(430, 932)).toBe('narrow');
    expect(layoutFor(375, 667)).toBe('narrow');
    expect(NARROW_STACK_MIN_HEIGHT).toBeLessThan(667);
  });

  it('unstacks one column exactly where the graph would go under', () => {
    expect(layoutFor(390, NARROW_STACK_MIN_HEIGHT)).toBe('narrow');
    expect(layoutFor(390, NARROW_STACK_MIN_HEIGHT - 1)).toBe('narrow-short');
  });

  // A phone with the on-screen keyboard up: `appHeight` hands the shell the
  // visual viewport, which is roughly half of an 844px window.
  it('unstacks a phone whose keyboard has taken the bottom of the window', () => {
    expect(layoutFor(390, 508)).toBe('narrow-short');
  });

  // Nothing is in a row at two columns or more, so a short window has nothing to
  // gain from a rearrangement and keeps what it can afford in width. Height is
  // consulted at exactly one boundary, and it is the one below.
  it('lets a wide window stay wide however short it is', () => {
    expect(layoutFor(1600, 300)).toBe('wide');
  });

  it('has exactly one boundary that height decides', () => {
    const boundaries = new Set<number>();
    for (let width = 200; width <= 2000; width += 1) {
      for (const height of [300, 600, 900]) {
        if (layoutFor(width, height) !== layoutFor(width, height + 1)) boundaries.add(width);
      }
    }
    // Only widths below the two-column floor can answer differently by height.
    for (const width of boundaries) expect(width).toBeLessThan(TWO_COLUMN_MIN);
  });

  // The point of the tiers: whatever the window, the graph is either at its
  // minimum or above it. This is the property the thresholds exist to hold, and
  // it is the one that breaks if someone edits a constant without the others.
  it('never leaves the graph below its minimum width', () => {
    for (let width = TWO_COLUMN_MIN; width <= 2000; width++) {
      const mode = layoutFor(width, TALL);
      // What the arrangement spends beside the graph. `medium` no longer spends
      // the sidebar at all — that is the whole change — so its apparatus is the
      // details column alone.
      const apparatus =
        mode === 'wide' ? SIDEBAR_WIDTH + DETAILS_WIDTH : DETAILS_WIDTH;
      expect(width - apparatus).toBeGreaterThanOrEqual(GRAPH_MIN_WIDTH);
    }
  });

  // The other axis. Only one arrangement puts a pane in a row now, and there the
  // row itself holds the property by reserving the graph's floor and the bar
  // before taking its share — so this passes at every height rather than only
  // above the threshold. It is the check that the `calc()` in App.svelte and the
  // reserve here are the same number: an earlier version sized the row as a bare
  // 45% and a 667px phone stacked with a 310px graph.
  it('never leaves a stacked one-column graph below its collapsed minimum', () => {
    for (let height = 200; height <= 2000; height++) {
      if (layoutFor(390, height) !== 'narrow') continue;
      const graph = height - narrowDetailsRow(height) - BOTTOM_BAR_HEIGHT;
      expect(graph).toBeGreaterThanOrEqual(GRAPH_MIN_HEIGHT_COMPACT);
    }
  });

  // And the pane on the other side of those divisions gets enough to be worth
  // stacking. Not a term in either threshold — this is the check that it didn't
  // need to be.
  it('never stacks a details row too short to say anything', () => {
    for (let height = NARROW_STACK_MIN_HEIGHT; height <= 2000; height++) {
      expect(narrowDetailsRow(height)).toBeGreaterThanOrEqual(DETAILS_MIN_ROW);
    }
  });

  /** What `min(45%, calc(100% - 382px))` in App.svelte's narrow grid resolves to. */
  function narrowDetailsRow(height: number): number {
    return Math.min(NARROW_DETAILS_ROW_FRACTION * height, height - NARROW_GRAPH_RESERVE);
  }
});

describe('listIsSheet', () => {
  it('gives the list a column only where all three fit', () => {
    expect(listIsSheet('wide')).toBe(false);
  });

  // The moment three columns stop fitting, the list is the one that goes — it is
  // the apparatus of the three. See layout.ts for what the arrangement this
  // replaced was paying instead.
  it('demotes it to a sheet everywhere below that', () => {
    for (const mode of ['medium', 'narrow', 'narrow-short'] as const) {
      expect(listIsSheet(mode)).toBe(true);
    }
  });
});

describe('listSheetCoversPanes', () => {
  // A drawer wherever a drawer leaves the graph its width, which is the
  // two-column tier: 280px of list beside 480px of graph at the tightest such
  // window.
  it('opens as a drawer at two columns', () => {
    expect(listSheetCoversPanes('medium')).toBe(false);
    expect(TWO_COLUMN_MIN - SIDEBAR_WIDTH).toBeGreaterThanOrEqual(GRAPH_MIN_WIDTH);
  });

  // At one column there is no beside left to preserve: a 280px drawer would leave
  // a 110px sliver of graph on a phone, so it rises from the bottom over both.
  // Neither presentation covers the bar — see `listSheetCoversPanes`.
  it('covers both panes at one column', () => {
    expect(listSheetCoversPanes('narrow')).toBe(true);
    expect(listSheetCoversPanes('narrow-short')).toBe(true);
  });
});

describe('switchedPanes', () => {
  it('switches nothing where every pane has a cell of its own', () => {
    expect(switchedPanes('wide')).toEqual([]);
    expect(switchedPanes('medium')).toEqual([]);
  });

  // One column and the height to stack in: the graph and the selection are both
  // on screen, so there is nothing to take turns.
  it('switches nothing at one column when it can stack instead', () => {
    expect(switchedPanes('narrow')).toEqual([]);
  });

  // Exactly one arrangement left, and it is the smallest. Taking turns is the last
  // retreat, after the list's column and after the details pane's.
  it('switches the two data panes only where nothing else fits', () => {
    expect(switchedPanes('narrow-short')).toEqual(['graph', 'selection']);
    expect(switchedPanes('narrow-short')).toContain('graph');
  });

  // It used to, at the one tier that switched all three, and that made "what is
  // plotted" cost the same tap as "what did I just select". The list is a sheet
  // now; see `listIsSheet`.
  it('never offers the series list', () => {
    for (const mode of ['wide', 'medium', 'narrow', 'narrow-short'] as const) {
      expect(switchedPanes(mode)).not.toContain('series');
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
    const panes = switchedPanes('narrow-short');
    expect(isPaneVisible('selection', 'selection', panes)).toBe(true);
    expect(isPaneVisible('graph', 'selection', panes)).toBe(false);
  });

  // The case a single active-pane comparison gets wrong. The list is never a
  // switched pane, so a `pane === active` test would hide it whenever the switcher
  // was on something else — and the shell would then have no way to say "the sheet
  // is open" through the same attribute.
  it('keeps an unswitched pane on screen while others take turns', () => {
    const panes = switchedPanes('narrow-short');
    expect(isPaneVisible('series', 'selection', panes)).toBe(true);
    expect(isPaneVisible('graph', 'selection', panes)).toBe(false);
    expect(isPaneVisible('selection', 'selection', panes)).toBe(true);
  });
});

describe('resolvePane', () => {
  const switched = switchedPanes('narrow-short');

  it('honours the pane the user asked for', () => {
    expect(resolvePane('graph', switched)).toBe('graph');
    expect(resolvePane('selection', switched)).toBe('selection');
  });

  // The tap that used to be swallowed. There is nothing selected in either of
  // these — that is not this function's business any more, because it cannot tell
  // a tap the user just made from a selection that has since gone. App.svelte
  // moves the switcher off Selection when the point goes; see the doc comment.
  it('shows the selection pane whether or not anything is selected', () => {
    expect(resolvePane('selection', switched)).toBe('selection');
  });

  it('falls back to the graph for a pane this arrangement does not switch', () => {
    expect(resolvePane('series', switched)).toBe('graph');
    expect(resolvePane('selection', [])).toBe('graph');
    expect(resolvePane('series', [])).toBe('graph');
  });
});

// The panel's fold is a question about height — what folding buys is list — with
// width entering only as "how tall is the block here". Each case is a real
// viewport, with the panel's content box worked out from it: a narrow window
// gives the panel the whole width (less its 16px padding either side), and a
// wider one docks it past the sidebar and inside the overlay's 16px.
describe('foldPickerLoadRow', () => {
  const phone = { w: 390 - 32, h: 844 - 32 };
  const phoneWithKeyboard = { w: 390 - 32, h: 508 - 32 };
  const phoneSe = { w: 375 - 32, h: 667 - 32 };
  const tallNarrowWindow = { w: 596 - 32, h: 900 - 32 };
  const shortNarrowWindow = { w: 596 - 32, h: 400 - 32 };
  const dockedSmallLaptop = { w: 900 - 280 - 32 - 32, h: 900 - 32 - 32 };
  const desktop = { w: 1440 - 280 - 32 - 32, h: 900 - 32 - 32 };
  const desktopStrip = { w: 1440 - 280 - 32 - 32, h: 500 - 32 - 32 };
  const fold = (v: { w: number; h: number }) => foldPickerLoadRow(v.w, v.h);

  it('keeps the group open where the window has the height for it', () => {
    expect(fold(tallNarrowWindow)).toBe(false);
    expect(fold(dockedSmallLaptop)).toBe(false);
    expect(fold(desktop)).toBe(false);
  });

  // The case that made this a height question: same 596px width, and the answer
  // has to differ.
  it('folds the same width when the window is short', () => {
    expect(fold(shortNarrowWindow)).toBe(true);
  });

  it('folds a phone, whose chrome is three lines of repository chips tall', () => {
    expect(fold(phone)).toBe(true);
    expect(fold(phoneSe)).toBe(true);
  });

  it('folds when a keyboard has taken half the window', () => {
    expect(fold(phoneWithKeyboard)).toBe(true);
  });

  it('folds a desktop window dragged down to a strip', () => {
    expect(fold(desktopStrip)).toBe(true);
  });

  // The property the constants exist for: whatever the panel, an unfolded block
  // leaves the list its floor.
  it('never leaves the list under its floor with the group open', () => {
    for (const width of [358, 420, 556, 564, 700, 756, 1096]) {
      for (let height = 200; height <= 1400; height += 10) {
        if (foldPickerLoadRow(width, height)) continue;
        expect(height - pickerChromeCost(width)).toBeGreaterThanOrEqual(PICKER_LIST_MIN);
      }
    }
  });

  it('estimates the chrome as a step, in the direction that folds', () => {
    // Three lines of chips, two, one — and each tier takes its band's worst case.
    expect(pickerChromeCost(358)).toBeGreaterThan(pickerChromeCost(556));
    expect(pickerChromeCost(556)).toBeGreaterThan(pickerChromeCost(1096));
  });

  // The band boundary that isn't about the chips rewrapping: at
  // CONTROL_BLOCK_NARROW the label rail and the aside column come back and take
  // width off the chips, so the block just above the threshold costs *more* than
  // the block just below it. A monotonic estimate charges the docked 900px window
  // the wider case's cost and folds a panel with room for five rows.
  it('charges the rails-are-back band more than the one below it', () => {
    expect(pickerChromeCost(CONTROL_BLOCK_NARROW)).toBeGreaterThan(
      pickerChromeCost(CONTROL_BLOCK_NARROW - 1),
    );
  });
});
