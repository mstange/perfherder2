// How the three-pane shell responds to the window it's given.
//
// The shell is a series list, a graph and a details pane, and the two side
// panes are a fixed 600px between them. Left alone that is a hard floor the
// graph pays for: at a 900px window it leaves 300px of plot, at 640px it leaves
// 40px, and below 600px the middle column is *zero* and the graph's own chrome
// paints over the pane beside it. The graph is the content and the side panes
// are apparatus, so the rule is the other way round — **the graph keeps a
// usable width, and a side pane that no longer fits stops being a column.**
//
// Which gives three arrangements, and the thresholds are arithmetic rather than
// taste: a tier ends exactly where its columns would push the graph below
// `GRAPH_MIN_WIDTH`. See docs/design.md, "The shell has three arrangements".

/** Must match `--sidebar-width` in app.css. */
export const SIDEBAR_WIDTH = 280;
/** Must match `--details-width` in app.css. */
export const DETAILS_WIDTH = 320;

// What the graph stops being worth drawing below. Measured rather than chosen:
// the header's own wrapping is the first thing to go, and the table in
// graphs.md, "The header is two groups" puts a 380px pane at a 188px header —
// a quarter of a laptop's viewport spent on controls, with the axis labels
// eating into what's left. 440px is the width at which the header settles to
// two rows and the plot keeps more height than its chrome.
export const GRAPH_MIN_WIDTH = 440;

/** Below this the details pane cannot be a column. */
export const THREE_COLUMN_MIN = SIDEBAR_WIDTH + GRAPH_MIN_WIDTH + DETAILS_WIDTH;
/** Below this the series list cannot be a column either. */
export const TWO_COLUMN_MIN = SIDEBAR_WIDTH + GRAPH_MIN_WIDTH;

/**
 * `wide` — three columns, the arrangement everything else is a retreat from.
 * `medium` — two columns; the details pane moves under the graph, which buys
 *   the graph the pane's full 320px of *width* and costs it height instead.
 *   The right trade for a time series, which is read across.
 * `narrow` — one pane at a time, chosen by a switcher. Nothing fits beside
 *   anything, so rather than three cramped things, each gets the window.
 */
export type LayoutMode = 'wide' | 'medium' | 'narrow';

export function layoutForWidth(width: number): LayoutMode {
  if (width >= THREE_COLUMN_MIN) return 'wide';
  if (width >= TWO_COLUMN_MIN) return 'medium';
  return 'narrow';
}

/** The panes the narrow switcher chooses between, in the order it shows them. */
export type NarrowPane = 'series' | 'graph' | 'selection';

export const NARROW_PANES: { pane: NarrowPane; label: string }[] = [
  { pane: 'series', label: 'Series' },
  { pane: 'graph', label: 'Graph' },
  { pane: 'selection', label: 'Selection' },
];

/**
 * The pane to actually show, given the one the user last asked for.
 *
 * Only one thing can invalidate that choice: `selection` with nothing selected
 * is a pane whose entire content is "click a point in the graph", and the user
 * can arrive there without touching the switcher — removing the last series, or
 * a Back that drops the selection, both clear it from under them. Fall back to
 * the graph, which is where the instruction points anyway.
 */
export function resolveNarrowPane(requested: NarrowPane, hasSelection: boolean): NarrowPane {
  return requested === 'selection' && !hasSelection ? 'graph' : requested;
}
