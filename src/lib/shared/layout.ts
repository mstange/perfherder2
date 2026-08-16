// How the three-pane shell responds to the window it's given.
//
// The shell is a series list, a graph and a details pane, and the two side
// panes are a fixed 600px between them. Left alone that is a hard floor the
// graph pays for: at a 900px window it leaves 300px of plot, at 640px it leaves
// 40px, and below 600px the middle column is *zero* and the graph's own chrome
// paints over the pane beside it. The graph is the content and the side panes
// are apparatus, so the rule is the other way round — **the graph keeps a
// usable size, and a side pane that no longer fits stops being a column.**
//
// Which gives four arrangements, and the thresholds are arithmetic rather than
// taste: a tier ends exactly where its columns or rows would push the graph
// below `GRAPH_MIN_WIDTH` / `GRAPH_MIN_HEIGHT`. See docs/design.md, "The shell
// has four arrangements".
//
// **Both axes are consulted, and the height one was missing for a while.** The
// tier used to be a function of width alone, which is right for the columns and
// wrong the moment a pane becomes a *row*: a landscape phone (844×390) is wide
// enough for two columns, took the arrangement that stacks the details pane
// under the graph, and left the detail plot 12px tall. `medium`'s bargain is
// that the graph pays for the pane's width in height, and that assumes there is
// height to pay with.

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

// The same question in the other axis, and measured the same way. The graph pane
// is three things stacked: the header, which is 138–164px across the widths the
// stacked tier covers; the overview, a fixed 84px; and the detail graph, which
// needs ~200px before it stops being a second copy of the overview — 28px of it
// is the plot's own padding, and five labelled y ticks want 150px between them.
// 430px is the sum, and it is the floor every arrangement below has to respect.
export const GRAPH_MIN_HEIGHT = 430;

// What the details pane needs before a *row* of it says anything: its own 40px
// header, the 108px identity block naming the selected series, and the 46px
// value headline. Measured off the live pane. Not a term in any threshold — the
// row is a percentage, so it comes out at 286px at the tightest window that
// stacks at all — but it is the reason that is comfortable rather than lucky,
// and `layout.test.ts` checks it.
export const DETAILS_MIN_ROW = 200;

// The stacked row's own sizing, mirrored from `grid-template-rows` in
// App.svelte's `main[data-layout='medium']`. Here because the threshold below is
// computed from it, and a copy that drifts from the CSS is a threshold that
// quietly stops meaning what it says.
export const DETAILS_ROW_FRACTION = 0.4;
export const DETAILS_ROW_MAX = 320;

/**
 * The width at which a control block gives up its label rail and becomes a
 * single column. **Must match the `@container (width < 560px)` rule in
 * app.css**, the way the two constants above must match their custom properties:
 * a container query's condition cannot be a custom property, so the number is
 * written twice and this is the copy the picker reads to decide whether to fold
 * its load row away as well. Same reasoning as the rail: below this the block
 * costs more than it says.
 */
export const CONTROL_BLOCK_NARROW = 560;

// ---------------------------------------------------------------------------
// The Add-series panel's own fold
//
// The panel's control block has two groups, and the loading one — the repository
// chips and the time range — folds behind a line that states it when there isn't
// room to keep it open. **That is a question about height, not width**: what
// folding buys is list, and the list is what the panel is for. A 596×900 window
// has plenty of room for the block and used to fold it anyway, because the first
// version asked about width.
//
// Width still comes into it, but only as "how tall is the block here" — the four
// repository chips take three lines on a phone and one on a desktop.

/**
 * What the panel spends above its list, with the loading group open, at a given
 * panel *content* width — so the panel's own 16px padding is already outside
 * these numbers. Measured with `tools/visual/picker-chrome-cost.mjs`, at **both
 * pointer types**, because the touch floor in app.css is worth ~50px of this
 * block and these widths are overwhelmingly phones:
 *
 * | content width | coarse | fine | chips |
 * | --- | --- | --- | --- |
 * | 358 | 482 | 422 | 3 lines |
 * | 416–556 | 402 | 361 | 2 |
 * | 564–668 | 445 | 396 | 4 — see below |
 * | 756 | 359 | 323 | 2 |
 * | 1096 | 299 | 269 | 1 |
 *
 * Bands rather than a fit through those points, because what the cost really
 * tracks is how many lines the repository chips wrap to — and that is a step.
 * Each band takes the *largest* cost in it, **coarse included**, so the estimate
 * errs towards folding twice over: for a mouse on a narrow window, and for a
 * panel whose chips happen to wrap one line short of its band's worst case. That
 * is the recoverable direction — the fold is one tap from being undone and a
 * squeezed list is not.
 *
 * **The cost is not monotonic in the width, which is why there are four bands
 * and not three.** At `CONTROL_BLOCK_NARROW` the label rail and the aside column
 * come back, and between them they take enough width off the chips to cost a
 * line that a 528px panel with no rails does not pay — so 564 is dearer than 556.
 * Folding one band over the two of them charges a docked 900px window the 564px
 * case's 445, which is 43px it does not spend, and 43px there is the difference
 * between five card rows and a fold. The boundary is `CONTROL_BLOCK_NARROW`
 * itself rather than a number near it, because that threshold *is* the cause.
 */
export function pickerChromeCost(contentWidth: number): number {
  // The other boundaries are where the chips were *measured* to rewrap — 358
  // takes three lines, 416 takes two, 1096 takes one — rather than round numbers
  // near them, so a panel just inside a band is not charged the cheaper tier.
  if (contentWidth < 416) return 482;
  if (contentWidth < CONTROL_BLOCK_NARROW) return 402;
  if (contentWidth < 700) return 445;
  return 359;
}

/**
 * The list's floor: five card rows at `CARD_ROW_HEIGHT`. Below that the list
 * stops being a list and becomes a preview of one — and five is also where a
 * phone lands once the loading group is folded away, which is the case this
 * threshold exists to catch.
 */
export const PICKER_LIST_MIN = 400;

/** Does the panel have to fold its loading group to keep the list usable? */
export function foldPickerLoadRow(contentWidth: number, contentHeight: number): boolean {
  return contentHeight - pickerChromeCost(contentWidth) < PICKER_LIST_MIN;
}

/** Below this the details pane cannot be a column. */
export const THREE_COLUMN_MIN = SIDEBAR_WIDTH + GRAPH_MIN_WIDTH + DETAILS_WIDTH;
/** Below this the series list cannot be a column either. */
export const TWO_COLUMN_MIN = SIDEBAR_WIDTH + GRAPH_MIN_WIDTH;
/**
 * Below this the details pane cannot be a *row*: the fraction it takes would
 * leave the graph under its height floor. A division rather than a sum because
 * the row is sized as a percentage of the window — at every height above this
 * the graph keeps `GRAPH_MIN_HEIGHT` by construction.
 */
export const STACKED_MIN_HEIGHT = Math.ceil(GRAPH_MIN_HEIGHT / (1 - DETAILS_ROW_FRACTION));

/**
 * `wide` — three columns, the arrangement everything else is a retreat from.
 *   Nothing stacks, so it is the one tier height has no say in: a short window
 *   makes every column short and there is no rearrangement that would help.
 * `medium` — two columns; the details pane moves under the graph, which buys
 *   the graph the pane's full 320px of *width* and costs it height instead.
 *   The right trade for a time series, which is read across.
 * `short` — two columns, but the window has no height to give: the details pane
 *   stops being a row and joins the graph in the switcher. The series list is
 *   still a column, so only two panes are switched. This is a landscape phone,
 *   and a laptop window someone has dragged down to a strip.
 * `narrow` — one pane at a time, chosen by a switcher. Nothing fits beside
 *   anything, so rather than three cramped things, each gets the window.
 */
export type LayoutMode = 'wide' | 'medium' | 'short' | 'narrow';

export function layoutFor(width: number, height: number): LayoutMode {
  if (width < TWO_COLUMN_MIN) return 'narrow';
  if (width >= THREE_COLUMN_MIN) return 'wide';
  return height >= STACKED_MIN_HEIGHT ? 'medium' : 'short';
}

/** The three panes, in the order the switcher shows them. */
export type Pane = 'series' | 'graph' | 'selection';

export const PANE_LABELS: Record<Pane, string> = {
  series: 'Series',
  graph: 'Graph',
  selection: 'Selection',
};

/**
 * The panes that share one cell in `mode`, in switcher order — and so also the
 * panes the switcher is rendered for. Empty where every pane has its own column
 * or row, which is what makes the switcher's own existence fall out of the tier
 * rather than being a second decision: at those widths it would be three
 * buttons that do nothing.
 *
 * `graph` is in every non-empty answer, which is what `resolvePane` falls back
 * to and what `initialPane` may be overridden away from.
 */
export function switchedPanes(mode: LayoutMode): Pane[] {
  switch (mode) {
    case 'narrow':
      return ['series', 'graph', 'selection'];
    case 'short':
      return ['graph', 'selection'];
    default:
      return [];
  }
}

/**
 * Is this pane on screen? A pane that isn't switched always is — it has a cell
 * of its own — and a switched one only when it is the active choice.
 *
 * Asking it this way rather than "which pane is showing" is what lets the shell
 * set one attribute per slot and keep one CSS rule for hiding the rest: in
 * `short` the series list is a column *and* two other panes are being switched,
 * and a single active-pane comparison gets that case wrong by hiding the list.
 */
export function isPaneVisible(pane: Pane, active: Pane, panes: Pane[]): boolean {
  return !panes.includes(pane) || pane === active;
}

/**
 * The pane to actually show, given the one the user last asked for.
 *
 * Two things can invalidate that choice. A pane that isn't switched in this
 * arrangement can't be the active one — resizing from `narrow` to `short` while
 * on Series would otherwise leave both switcher buttons unpressed and the graph
 * hidden. And `selection` with nothing selected is a pane whose entire content
 * is "click a point in the graph", which the user can arrive at without
 * touching the switcher: removing the last series, or a Back that drops the
 * selection, both clear it from under them.
 *
 * Both fall back to the graph, which is where the instruction points anyway.
 */
export function resolvePane(requested: Pane, hasSelection: boolean, panes: Pane[]): Pane {
  if (!panes.includes(requested)) return 'graph';
  if (requested === 'selection' && !hasSelection) return 'graph';
  return requested;
}
