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
// **And the pane that stops being a column is the series list, at every width
// below the one where all three fit.** It is the apparatus of the three: the
// selection is read once per tap and the graph is read continuously, while the
// list is opened once a session to add something or to check a color. So below
// `THREE_COLUMN_MIN` it becomes a *sheet* behind a button in the bottom bar that
// states its count — see `listIsSheet` — and the two panes that are about the
// data keep their columns for as long as they fit.
//
// **That rule replaced two tiers with one, and both of them were paying for the
// list's column in the wrong currency.** There used to be a `medium` that kept
// `list │ graph` and moved the details pane into a *row* under the graph, and a
// `short` below it for windows with no height to spare, where the details pane
// went back to taking turns with the graph in a switcher. Two things were wrong
// with that, and they are the same thing twice:
//
//   - The list's 280px of width was charged to the graph as 40% of its *height*,
//     forever, and a column costs its width once. At a 900px window the row
//     arrangement left the graph 620×432 and dropping the list leaves it 580×843
//     — 34% more plot for 40px less width. The comparison goes the same way at
//     every window in the band; there is no width where the row wins.
//   - Worse, the boundary between them ran backwards. At 900×716 `short` gave the
//     graph 620×655; four more pixels of window height tipped it into `medium`,
//     which spent 40% of the height on the row and left 620×432. A window growing
//     made the graph a third smaller.
//
// With nothing in a row above one column, the height axis stops mattering there
// at all — which is also what makes the old `short` unnecessary rather than
// merely improved. It existed because a *row* needs height the way a column needs
// width; no rows, no tier. Height is now consulted at exactly one boundary, the
// one where the columns have already run out.
//
// Which gives four arrangements, and the thresholds are arithmetic rather than
// taste: a tier ends exactly where its columns or rows would push the graph
// below `GRAPH_MIN_WIDTH` / `GRAPH_MIN_HEIGHT`. See docs/design.md, "The shell
// has four arrangements".

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
// value headline. Measured off the live pane.
//
// **Only one arrangement puts it in a row now**, the one-column `narrow`, and
// there this is a term in the threshold rather than a checked consequence — see
// `NARROW_STACK_MIN_HEIGHT`. It used to be neither: `medium` stacked a row too and
// sized it as a bare percentage, so 200 was something `layout.test.ts` confirmed
// the arithmetic had happened to clear.
export const DETAILS_MIN_ROW = 200;

/**
 * The bottom bar — the series button, the switcher, or both — mirrored from `.bar`
 * in App.svelte: 44px of touch target, 6px of padding either side, 1px of border.
 *
 * Every arrangement below `wide` has one, since every one of them keeps the series
 * list behind its button. It is the price of the list's 280px column, and it is a
 * good price in both axes: 57px of height back for 280px of width, once.
 *
 * **A term in the one-column threshold, and leaving it out put a 667px phone's
 * graph under its floor.** The details row there is a percentage of the *grid*,
 * and the grid is the whole window: the bar's 57px come off the graph's share, not
 * off the row's, so a threshold derived from the fraction alone is 57px optimistic.
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
 * **A reserve rather than a fixed cap, and the difference is which
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

/** Below this all three panes cannot be columns: the list is the one that goes. */
export const THREE_COLUMN_MIN = SIDEBAR_WIDTH + GRAPH_MIN_WIDTH + DETAILS_WIDTH;
/**
 * Below this the *remaining two* cannot be columns either, and the arrangement
 * drops to one.
 *
 * **`GRAPH_MIN_WIDTH + DETAILS_WIDTH`, not `SIDEBAR_WIDTH + GRAPH_MIN_WIDTH`.** It
 * used to be the latter, because the pane that kept its column beside the graph
 * used to be the list; it is the details pane now, and the sum has to name the two
 * panes actually in the row. 760 rather than 720, so a 730px window is one column
 * where it used to be two — and better off for it, since the graph goes from
 * 450×540 with a details row to 730×483 with one.
 */
export const TWO_COLUMN_MIN = GRAPH_MIN_WIDTH + DETAILS_WIDTH;
/**
 * Below this the details pane cannot be a *row* either, and the two panes go back
 * to taking turns: a window dragged small in both axes, and a phone with the
 * keyboard up.
 *
 * **A sum, and the only place height decides anything.** The row's reserve has
 * already guaranteed the graph its floor at every height (see
 * `NARROW_DETAILS_ROW_FRACTION`), so what is left to ask is whether what remains
 * is a pane worth stacking: 325 + 57 + 200 = 582. `DETAILS_MIN_ROW` is therefore a
 * term in the arithmetic rather than something a test confirms the arithmetic
 * cleared.
 *
 * There was a second height threshold above this one, `STACKED_MIN_HEIGHT`, for
 * the tier that stacked a row at *two* columns. Nothing is a row above one column
 * any more, so it is gone along with the tier — see the note at the top of this
 * file for why the arrangement it guarded was the wrong trade in the first place.
 */
export const NARROW_STACK_MIN_HEIGHT = NARROW_GRAPH_RESERVE + DETAILS_MIN_ROW;

/**
 * `wide` — three columns, the arrangement everything else is a retreat from, and
 *   the only one where the series list is a pane. Nothing stacks, so height has no
 *   say: a short window makes every column short and no rearrangement helps.
 * `medium` — two columns, `graph │ selection`, with the list a 280px drawer behind
 *   the bar's button. Height has no say here either, for the same reason — which
 *   is the point of the arrangement. An iPad in landscape, a tiled half-screen
 *   window, a landscape phone.
 * `narrow` — one column: the graph over a details row, the list still behind the
 *   button. A phone in portrait. Nothing is switched — the two panes worth seeing
 *   at once are both on screen.
 * `narrow-short` — one column with no height to stack in, which is the one place
 *   left where the graph and the details pane take turns in a switcher. A browser
 *   window dragged small in both axes, and a phone with the keyboard up.
 *
 * Read as a sequence of retreats: the list's column goes first, then the details
 * pane's column becomes a row, then the row becomes a turn in a switcher. Each
 * gives up the least it can.
 */
export type LayoutMode = 'wide' | 'medium' | 'narrow' | 'narrow-short';

export function layoutFor(width: number, height: number): LayoutMode {
  if (width >= THREE_COLUMN_MIN) return 'wide';
  if (width >= TWO_COLUMN_MIN) return 'medium';
  return height >= NARROW_STACK_MIN_HEIGHT ? 'narrow' : 'narrow-short';
}

/**
 * Is the series list a sheet behind a button here, rather than a pane of its own?
 *
 * Everywhere but `wide`, which is to say: the moment all three panes stop fitting
 * as columns, the list is the one that goes. See the note at the top of this file
 * for why it is the list and not the details pane, and for what the arrangement
 * this replaced was paying instead.
 *
 * Asked of the shell rather than folded into `switchedPanes` because a sheet is
 * not a turn in the switcher — it is a pane the button reveals and a close button
 * dismisses, and the switcher must not offer it.
 */
export function listIsSheet(mode: LayoutMode): boolean {
  return mode !== 'wide';
}

/**
 * Does the sheet take the whole window, or open as a drawer over the left of it?
 *
 * **A drawer wherever a drawer leaves the graph its width, which is exactly the
 * two-column tier**, and 280px of list beside 480px of graph at the tightest such
 * window. Sizing it to the window everywhere was the first version and it is
 * plainly wrong at 1039px: three cards and a header, stretched across a window
 * wide enough for the arrangement it just replaced. The drawer is the same 280px
 * column the list has in `wide`, in the same place, which is the other half of why
 * it reads as the list coming back rather than as a new screen.
 *
 * At one column there is no "beside" left to preserve — 280px of drawer would
 * leave a 110px sliver of graph on a phone — so there it takes the window. That
 * also decides whether the panes behind it go `inert`: a drawer leaves them
 * visible, so reaching them by Tab or by click is not reaching anything hidden,
 * and the sheet is non-modal for the same reason the Add-series panel is.
 */
export function listSheetCoversWindow(mode: LayoutMode): boolean {
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
  return mode === 'narrow-short' ? ['graph', 'selection'] : [];
}

/**
 * Is this pane on screen? A pane that isn't switched always is — it has a cell
 * of its own — and a switched one only when it is the active choice.
 *
 * Asking it this way rather than "which pane is showing" is what lets the shell
 * set one attribute per slot and keep one CSS rule for hiding the rest — and the
 * list slot answers a different question entirely (is its sheet open), which the
 * shell resolves into the same attribute so that one rule still covers it.
 */
export function isPaneVisible(pane: Pane, active: Pane, panes: Pane[]): boolean {
  return !panes.includes(pane) || pane === active;
}

/**
 * The pane to actually show, given the one the user last asked for.
 *
 * One thing can invalidate that choice: a pane that isn't switched in this
 * arrangement can't be the active one — resizing from `narrow-short` to `medium`
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
