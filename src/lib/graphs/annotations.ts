// The marks in the margins of the detail plot: perfherder's alert triangles
// along the top, detected-change bars along the floor.
//
// **Pure.** Two things live here because both of them need it:
//
// - **Rows.** Two marks on nearby pushes used to be drawn on top of each other.
//   Nudging them sideways would lie about which column they mark, so they stack
//   instead — which is the fix graphs-todo.md nominated for the alert markers,
//   and the only sane way to draw range bars that overlap at all. The packing is
//   perf.webkit.org's (`time-series-chart.js::_layoutAnnotationBars`).
// - **One layout, read twice.** The draw loop and the hit test must agree to the
//   pixel or the graph answers clicks somewhere other than where it drew — the
//   same discipline as `jitterOffsetPx`, and it matters more here, because rows
//   are the whole reason two overlapping marks are separately clickable. So the
//   caller computes a layout once and hands the *same array* to both.

import type { Scale } from '../shared/chart';

// ---------------------------------------------------------------------------
// Row packing
// ---------------------------------------------------------------------------

export type Span = { start: number; end: number };

// Assign each span the first row it fits in, given `gap` pixels of clearance
// between neighbours. Returns one row index per input span, in input order.
//
// **`spans` must be sorted by `start`** — greedy packing is only optimal (in
// rows used) on sorted input, and both callers sort by pixel x anyway.
//
// Past `maxRows` the packing gives up and doubles a span onto whichever row has
// the most space left. That is a deliberate ceiling rather than an unbounded
// stack: twelve alerts in one week should not turn the top of the plot into a
// wall of triangles, and the overlap it falls back to is exactly the behaviour
// every mark had before rows existed.
export function packRows(
  spans: readonly Span[],
  gap: number,
  maxRows: number,
): number[] {
  const rowEnds: number[] = [];
  const rows = new Array<number>(spans.length);
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    let row = rowEnds.findIndex((end) => end + gap <= span.start);
    if (row === -1) {
      if (rowEnds.length < maxRows) {
        row = rowEnds.length;
        rowEnds.push(-Infinity);
      } else {
        let widest = 0;
        for (let r = 1; r < rowEnds.length; r++) {
          if (rowEnds[r] < rowEnds[widest]) widest = r;
        }
        row = widest;
      }
    }
    rowEnds[row] = Math.max(rowEnds[row], span.end);
    rows[i] = row;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Alert markers
// ---------------------------------------------------------------------------
//
// A triangle hanging from the top of the plot, over a faint full-height guide.
// See chartDraw.ts for why an alert is marked by its pixel column rather than
// by its dot.

export const ALERT_TRIANGLE_HALF = 4;
export const ALERT_TRIANGLE_HEIGHT = 7;
// The first row's top edge, as an offset from the plot's top.
export const ALERT_MARKER_TOP = 1;
// Pitch between rows. Two pixels of air under a 7px triangle is enough to read
// two of them as stacked rather than as one tall shape.
export const ALERT_ROW_HEIGHT = ALERT_TRIANGLE_HEIGHT + 2;
// Beyond three the markers eat the top of the plot; see `packRows`.
export const ALERT_MAX_ROWS = 3;

// The click target is deliberately larger than the ink. The triangle is 8x7,
// which is under the ~24px a pointer can be aimed at reliably; these widen it
// without drawing anything, the way a small icon button gets padding.
export const ALERT_HIT_HALF_WIDTH = 6;
// Applies to the *last* row only. Rows above it get `ALERT_ROW_HEIGHT`, since
// their generous band would otherwise swallow the row below and undo the whole
// point of stacking. With one row — much the commonest case — this is the only
// band there is, and it is unchanged from before rows existed.
export const ALERT_HIT_HEIGHT = 16;

export function alertRowTop(geom: { y0: number }, row: number): number {
  return geom.y0 + ALERT_MARKER_TOP + row * ALERT_ROW_HEIGHT;
}

export type AlertSlot = {
  seriesIndex: number;
  alertIndex: number;
  // Pixel x, rounded the way a 1px line wants to be so the marker and its guide
  // land on the same column.
  x: number;
  row: number;
  isRegression: boolean;
};

type AlertInput = { alerts?: readonly { x: number; isRegression: boolean }[] };

// Every visible alert marker, placed. Markers of *all* series are packed
// together — two series alerting on nearby pushes overlap on screen exactly as
// two alerts of one series would.
//
// Markers outside the plot are dropped here rather than clipped, so a zoom
// can't leave one piled against the edge implying an alert at the window's
// boundary — and so nothing invisible stays clickable.
export function layoutAlertMarkers(
  list: readonly AlertInput[],
  xScale: Scale,
  geom: { x0: number; x1: number },
): AlertSlot[] {
  const slots: AlertSlot[] = [];
  for (let s = 0; s < list.length; s++) {
    const alerts = list[s].alerts;
    if (!alerts) continue;
    for (let a = 0; a < alerts.length; a++) {
      const x = Math.round(xScale.toPixel(alerts[a].x)) + 0.5;
      if (x < geom.x0 || x > geom.x1) continue;
      slots.push({
        seriesIndex: s,
        alertIndex: a,
        x,
        row: 0,
        isRegression: alerts[a].isRegression,
      });
    }
  }
  slots.sort((a, b) => a.x - b.x);
  const rows = packRows(
    slots.map((slot) => ({
      start: slot.x - ALERT_TRIANGLE_HALF,
      end: slot.x + ALERT_TRIANGLE_HALF,
    })),
    1,
    ALERT_MAX_ROWS,
  );
  for (let i = 0; i < slots.length; i++) slots[i].row = rows[i];
  return slots;
}

export type AlertHit = { seriesIndex: number; alertIndex: number };

// The marker under the cursor, or null.
//
// Rows are what makes this useful: two alerts 5px apart (seen on speedometer3,
// whose 2026-06-02 regression and improvement are 14 hours apart) are now on
// separate rows, so pointing at the one you want is a matter of aiming at its
// row rather than of guessing which side of an overlap wins.
//
// Within a row it is still nearest-column, which keeps the doubled-up case
// (`packRows` past ALERT_MAX_ROWS) answerable at all.
//
// A linear scan: a series has tens of alerts over a year, against the tens of
// thousands of dots that made `hitTestSeries` binary-search.
export function hitTestAlertSlots(
  slots: readonly AlertSlot[],
  geom: { y0: number },
  px: number,
  py: number,
): AlertHit | null {
  if (slots.length === 0) return null;
  let lastRow = 0;
  for (const slot of slots) if (slot.row > lastRow) lastRow = slot.row;

  let best: AlertSlot | null = null;
  let bestDistance = Infinity;
  for (const slot of slots) {
    const top = alertRowTop(geom, slot.row) - 1;
    const bottom = top + (slot.row === lastRow ? ALERT_HIT_HEIGHT : ALERT_ROW_HEIGHT);
    if (py < top || py > bottom) continue;
    const d = Math.abs(slot.x - px);
    if (d > ALERT_HIT_HALF_WIDTH || d >= bestDistance) continue;
    best = slot;
    bestDistance = d;
  }
  return best ? { seriesIndex: best.seriesIndex, alertIndex: best.alertIndex } : null;
}

// ---------------------------------------------------------------------------
// Detected-change bars
// ---------------------------------------------------------------------------
//
// A step this app found itself (changes.ts), drawn as a bar spanning the pushes
// the test compared.
//
// **Inside the plot, hugging the floor, rather than in a reserved band below
// it.** perf.webkit.org shrinks its chart by the height of its annotation rows;
// here the row count is a function of the *zoom* (two bars overlap at a year
// and don't at a week), so a reserved band would resize the plot mid-drag —
// against the layout-stability rule in design.md, and in the one place the user
// is watching most closely. Drawn as an overlay the row count costs nothing,
// at the price of covering a few pixels of the lowest dots.

export const CHANGE_BAR_HEIGHT = 5;
export const CHANGE_BAR_GAP = 2;
// Air between the lowest bar and the plot's bottom edge.
export const CHANGE_BAR_FLOOR = 2;
export const CHANGE_BAR_MAX_ROWS = 3;
// A change over 48 pushes is only a few pixels wide at a year's zoom, and a bar
// you can't see is a finding you don't get. Widened about its centre.
export const CHANGE_BAR_MIN_WIDTH = 8;
// Padding on the click target. Horizontally it can be generous, since a short
// bar is the case it exists for. Vertically it cannot: rows are 7px apart, and
// a band that reached into the row above would undo the stacking exactly where
// the stacking is what made two bars separately clickable. Row 0 gets the strip
// of dead plot floor below it as a bonus, which is the row that exists in every
// case worth optimizing for.
export const CHANGE_BAR_HIT_SLOP = 3;
export const CHANGE_BAR_HIT_PAD = 1;

// Rows stack *upward* from the floor, so row 0 is always in the same place
// whatever else is on screen.
export function changeBarTop(geom: { y1: number }, row: number): number {
  return (
    geom.y1 - CHANGE_BAR_FLOOR - CHANGE_BAR_HEIGHT - row * (CHANGE_BAR_HEIGHT + CHANGE_BAR_GAP)
  );
}

export function changeBarBand(
  geom: { y1: number },
  row: number,
): { top: number; bottom: number } {
  const top = changeBarTop(geom, row);
  return {
    top: top - CHANGE_BAR_HIT_PAD,
    bottom: top + CHANGE_BAR_HEIGHT + (row === 0 ? CHANGE_BAR_FLOOR : CHANGE_BAR_HIT_PAD),
  };
}

export type ChangeSlot = {
  seriesIndex: number;
  changeIndex: number;
  // Pixels, clipped to the plot.
  x0: number;
  x1: number;
  // Where the step itself sits, clamped into [x0, x1]. The bar is the evidence;
  // this is the column the evidence is about.
  changeX: number;
  row: number;
  isRegression: boolean;
};

type ChangeInput = {
  changes?: readonly { x0: number; x1: number; changeX: number; isRegression: boolean }[];
};

// Every visible change bar, placed. Clipped rather than dropped when it runs
// off the edge — unlike an alert marker, a bar is a *range*, and one that
// starts before the window still has something true to say inside it. Dropped
// only when it doesn't reach the window at all.
export function layoutChangeBars(
  list: readonly ChangeInput[],
  xScale: Scale,
  geom: { x0: number; x1: number },
): ChangeSlot[] {
  const slots: ChangeSlot[] = [];
  for (let s = 0; s < list.length; s++) {
    const changes = list[s].changes;
    if (!changes) continue;
    for (let c = 0; c < changes.length; c++) {
      const change = changes[c];
      let x0 = xScale.toPixel(change.x0);
      let x1 = xScale.toPixel(change.x1);
      if (x1 < geom.x0 || x0 > geom.x1) continue;
      if (x1 - x0 < CHANGE_BAR_MIN_WIDTH) {
        const centre = (x0 + x1) / 2;
        x0 = centre - CHANGE_BAR_MIN_WIDTH / 2;
        x1 = centre + CHANGE_BAR_MIN_WIDTH / 2;
      }
      x0 = Math.max(geom.x0, x0);
      x1 = Math.min(geom.x1, x1);
      slots.push({
        seriesIndex: s,
        changeIndex: c,
        x0,
        x1,
        changeX: Math.min(x1, Math.max(x0, xScale.toPixel(change.changeX))),
        row: 0,
        isRegression: change.isRegression,
      });
    }
  }
  slots.sort((a, b) => a.x0 - b.x0);
  const rows = packRows(
    slots.map((slot) => ({ start: slot.x0, end: slot.x1 })),
    CHANGE_BAR_GAP,
    CHANGE_BAR_MAX_ROWS,
  );
  for (let i = 0; i < slots.length; i++) slots[i].row = rows[i];
  return slots;
}

export type ChangeHit = { seriesIndex: number; changeIndex: number };

// The bar under the cursor, or null. Nearest by horizontal distance to the bar
// itself (zero anywhere inside it), which only decides anything in the doubled
// -up case, since bars on one row never overlap.
export function hitTestChangeBars(
  slots: readonly ChangeSlot[],
  geom: { y1: number },
  px: number,
  py: number,
): ChangeHit | null {
  let best: ChangeSlot | null = null;
  let bestDistance = Infinity;
  for (const slot of slots) {
    const band = changeBarBand(geom, slot.row);
    if (py < band.top || py > band.bottom) continue;
    const d = Math.max(0, slot.x0 - px, px - slot.x1);
    if (d > CHANGE_BAR_HIT_SLOP || d >= bestDistance) continue;
    best = slot;
    bestDistance = d;
  }
  return best ? { seriesIndex: best.seriesIndex, changeIndex: best.changeIndex } : null;
}
