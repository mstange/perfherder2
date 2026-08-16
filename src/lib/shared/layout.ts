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
// Which gives five arrangements, and the thresholds are arithmetic rather than
// taste: a tier ends exactly where its columns or rows would push the graph
// below `GRAPH_MIN_WIDTH` / `GRAPH_MIN_HEIGHT`. See docs/design.md, "The shell
// has five arrangements".
//
// **The series list is the pane that stops being a pane.** On a phone all three
// used to take turns in a switcher, which made "what is plotted" and "what did I
// just tap" cost the same as each other — and they are not worth the same. The
// selection is read once per tap and the list is opened once a session, so at the
// widths where nothing fits beside anything the list becomes a *sheet* behind a
// button that states its count, and the selection gets the bottom of the screen
// under the graph. See `listIsSheet`.
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

// The same sum with the header collapsed to its one-line bar — 41px instead of
// 138–164 (graphs.md, "A pane too small for the bar collapses it to one line").
// 41 + 84 + 200 = 325.
//
// **This is a second floor, not a correction of the first, and which one applies
// is decided by what the retreat from stacking costs.** `GRAPH_MIN_HEIGHT` is
// what the graph is worth drawing at *with its controls open*, and `medium` holds
// out for it because the tier below it — `short` — keeps the series list as a
// column and only moves the details pane back into a switcher. That is cheap.
// `narrow`'s retreat is not: there the switcher is the only way to reach the
// selection at all, so every point the reader inspects costs two taps out of the
// graph and back. Paying for that with a collapsed header is the better trade,
// and it is a trade the graph pane makes for itself anyway — `collapsible` fires
// at exactly `GRAPH_MIN_HEIGHT`, so a stacked narrow graph under 430px tall has a
// one-line header whether this constant exists or not. What the constant does is
// stop the *threshold* from pretending otherwise and refusing to stack a 667px
// phone that would have been fine.
export const GRAPH_MIN_HEIGHT_COMPACT = 325;

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
// quietly stops meaning what it says. The one-column row is sized differently and
// has its own pair below.
export const DETAILS_ROW_FRACTION = 0.4;
export const DETAILS_ROW_MAX = 320;

/**
 * The bottom bar — the series button, the switcher, or both — mirrored from
 * `.bar` in App.svelte: 44px of touch target, 6px of padding either side, 1px of
 * border.
 *
 * **A term in the one-column threshold, and leaving it out put a 667px phone's
 * graph under its floor.** The row below is a percentage of the *grid*, and the
 * grid is the whole window: the bar's 57px come off the graph's share, not off
 * the details row's, so a threshold derived from the fraction alone is 57px
 * optimistic. `medium` has no equivalent term because it has no bar.
 */
export const BOTTOM_BAR_HEIGHT = 57;

/**
 * What the one-column details row may not eat into: the graph's collapsed floor
 * plus the bar. Mirrored as the `382px` in `main[data-layout='narrow']`'s
 * `grid-template-rows`.
 */
export const NARROW_GRAPH_RESERVE = GRAPH_MIN_HEIGHT_COMPACT + BOTTOM_BAR_HEIGHT;

/**
 * The one-column details row: `min(45%, 100% − NARROW_GRAPH_RESERVE)`, mirrored
 * from App.svelte.
 *
 * **A reserve rather than `medium`'s fixed 320px cap, and the difference is which
 * end of the phone range it protects.** A cap protects the *graph* on a tall
 * window and does nothing for a short one, which is backwards here: what varies
 * across phones is not how much the pane could use — it could use all of it, the
 * content runs past 1000px — but how little the graph can be squeezed to. So the
 * row takes 45% where there is 45% to spare and everything above the graph's floor
 * where there isn't, which means a 667px phone lands the graph *exactly* on 325
 * and spends the remaining 285 on the pane, and a 932px one gets its 45% with
 * room over.
 *
 * 45%, and not more, because the row is where you *read* the selection but the
 * graph above it is where you *pick* one: past about half the screen the plot
 * stops having the vertical range to tell two levels apart, and every point in it
 * is a tap target. It is the one number here chosen by eye rather than derived,
 * and it is a one-line change in both places.
 */
export const NARROW_DETAILS_ROW_FRACTION = 0.45;

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
 * pointer types**, because the touch floor in app.css is worth ~20px of this
 * block and these widths are overwhelmingly phones:
 *
 * | content width | coarse | fine | chips |
 * | --- | --- | --- | --- |
 * | 358 | 446 | 422 | 3 lines |
 * | 416–556 | 382 | 361 | 2 |
 * | 564–668 | 413 | 396 | 4 — see below |
 * | 756 | 335 | 323 | 2 |
 * | 1096 | 278 | 269 | 1 |
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
 * case's cost, which is ~30px it does not spend, and 30px there is the difference
 * between five card rows and six. The boundary is `CONTROL_BLOCK_NARROW` itself
 * rather than a number near it, because that threshold *is* the cause.
 */
export function pickerChromeCost(contentWidth: number): number {
  // The other boundaries are where the chips were *measured* to rewrap — 358
  // takes three lines, 416 takes two, 1096 takes one — rather than round numbers
  // near them, so a panel just inside a band is not charged the cheaper tier.
  if (contentWidth < 416) return 446;
  if (contentWidth < CONTROL_BLOCK_NARROW) return 382;
  if (contentWidth < 700) return 413;
  return 335;
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
 * The same question one column wide, and **a sum rather than a division**,
 * because the row's reserve has already guaranteed the graph its floor at every
 * height: what is left to ask is whether what remains is a pane worth stacking.
 * 325 + 57 + 200 = 582. So the graph's floor never decides this tier — it is
 * `DETAILS_MIN_ROW` that does, which is the opposite way round from `medium`,
 * where the row is a bare percentage and the floor is the whole question.
 *
 * Below it there is no useful row to be had and the two panes go back to taking
 * turns: a window dragged small in both axes, and a phone with the keyboard up.
 */
export const NARROW_STACK_MIN_HEIGHT = NARROW_GRAPH_RESERVE + DETAILS_MIN_ROW;

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
 * `narrow` — one column: the graph over a details row, the same bargain `medium`
 *   strikes, and the series list demoted out of the layout altogether to a sheet
 *   behind a button that counts it. A phone in portrait. Nothing is switched
 *   here — the two panes worth seeing at once are both on screen.
 * `narrow-short` — one column with no height to stack in, which is the one place
 *   left where the graph and the details pane take turns in a switcher. A
 *   browser window dragged small in both axes, and a phone with the keyboard up.
 *   The list is a sheet here too: a window this size has even less to spare for a
 *   pane that is read once a session.
 */
export type LayoutMode = 'wide' | 'medium' | 'short' | 'narrow' | 'narrow-short';

export function layoutFor(width: number, height: number): LayoutMode {
  if (width < TWO_COLUMN_MIN) {
    return height >= NARROW_STACK_MIN_HEIGHT ? 'narrow' : 'narrow-short';
  }
  if (width >= THREE_COLUMN_MIN) return 'wide';
  return height >= STACKED_MIN_HEIGHT ? 'medium' : 'short';
}

/**
 * Is the series list a sheet behind a button here, rather than a pane of its own?
 *
 * The one-column tiers, and both of them: what makes the list the pane to demote
 * is not how much height there is but that there is no room for it *beside*
 * anything. See the note at the top of this file for why it is the list rather
 * than the details pane that goes.
 *
 * Asked of the shell rather than folded into `switchedPanes` because a sheet is
 * not a turn in the switcher — it is a pane the button opens over the whole
 * window and a close button dismisses, and the switcher must not offer it.
 */
export function listIsSheet(mode: LayoutMode): boolean {
  return mode === 'narrow' || mode === 'narrow-short';
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
 * rather than being a second decision: at those widths it would be buttons that
 * do nothing.
 *
 * **`series` is never in it.** It was, at the one width that switched all three,
 * and that arrangement charged the same tap for "what did I just select" as for
 * "what is plotted" — see the note at the top of this file. The list is a sheet
 * now (`listIsSheet`), so the switcher is at most the two panes that are both
 * about the data.
 *
 * `graph` is in every non-empty answer, which is what `resolvePane` falls back
 * to.
 */
export function switchedPanes(mode: LayoutMode): Pane[] {
  switch (mode) {
    case 'short':
    case 'narrow-short':
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
 * One thing can invalidate that choice: a pane that isn't switched in this
 * arrangement can't be the active one — resizing from `narrow-short` to `short`
 * while on Selection would otherwise leave both switcher buttons unpressed and
 * the graph hidden. It falls back to the graph, which every arrangement that
 * switches anything offers.
 *
 * **A `selection` with nothing selected used to fall back here too, and that was
 * a switcher button that ate the tap.** The pane's content is then "tap a point
 * in the graph", which is worth reading — it is the instruction for how to fill
 * it, and on a touchscreen it is the only place the *gesture* is named. What made
 * the fallback look right is that the user can also arrive at an empty selection
 * without asking to: removing the last series, or a Back that drops the point.
 * But that is a reason to move the switcher off Selection **at the moment the
 * selection goes**, which is one `$effect` in App.svelte beside the one that
 * moves it *onto* Selection when a point is picked — and not a reason to refuse a
 * tap the user just made. Deciding it here, on every render, could not tell the
 * two apart, so it treated a deliberate tap as a stale one and left a pressed
 * button, an unpressed button and a hover the finger had no way to clear.
 */
export function resolvePane(requested: Pane, panes: Pane[]): Pane {
  return panes.includes(requested) ? requested : 'graph';
}
