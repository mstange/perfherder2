import { describe, expect, it } from 'vitest';
import { makeScale } from '../shared/chart';
import {
  ALERT_HIT_HALF_WIDTH,
  ALERT_HIT_HEIGHT,
  ALERT_MAX_ROWS,
  ALERT_ROW_HEIGHT,
  alertRowTop,
  changeBarBand,
  changeBarTop,
  CHANGE_BAR_HEIGHT,
  CHANGE_BAR_HIT_SLOP,
  CHANGE_BAR_MIN_WIDTH,
  hitTestAlertSlots,
  hitTestChangeBars,
  layoutAlertMarkers,
  layoutChangeBars,
  packRows,
} from './annotations';

// 100 time units across 100px of plot, offset so x0 isn't 0 — a bug that
// forgets the left padding still passes when the plot starts at the origin.
const xScale = makeScale(0, 100, 20, 120);
const geom = { x0: 20, x1: 120, y0: 8, y1: 200 };

describe('packRows', () => {
  const rows = (spans: [number, number][], gap = 1, maxRows = 3) =>
    packRows(
      spans.map(([start, end]) => ({ start, end })),
      gap,
      maxRows,
    );

  it('keeps everything on one row when nothing overlaps', () => {
    expect(rows([[0, 10], [20, 30], [40, 50]])).toEqual([0, 0, 0]);
  });

  it('stacks overlapping spans', () => {
    expect(rows([[0, 10], [5, 15], [8, 20]])).toEqual([0, 1, 2]);
  });

  it('reuses the lowest free row rather than always adding one', () => {
    // The third span clears the first, so it belongs back on row 0 — otherwise
    // one early collision pushes everything after it down a row for good.
    expect(rows([[0, 10], [5, 15], [12, 20]])).toEqual([0, 1, 0]);
  });

  it('counts the gap as part of the span', () => {
    expect(rows([[0, 10], [11, 20]], 1)).toEqual([0, 0]);
    expect(rows([[0, 10], [11, 20]], 2)).toEqual([0, 1]);
  });

  it('doubles up rather than growing past maxRows', () => {
    // The ceiling exists so twelve alerts in one week can't turn the top of the
    // plot into a wall of triangles. Past it the overlap comes back, which is
    // the behaviour every mark had before rows existed.
    const packed = rows([[0, 10], [1, 11], [2, 12], [3, 13]], 1, 3);
    expect(packed.slice(0, 3)).toEqual([0, 1, 2]);
    expect(packed[3]).toBeLessThan(3);
  });
});

describe('layoutAlertMarkers', () => {
  // Rounded to pixel 40.5 and 90.5 by the same +0.5 the draw loop applies.
  const one = [{ alerts: [{ x: 20, isRegression: true }, { x: 70, isRegression: false }] }];

  it('projects and rounds the way the draw loop does', () => {
    const slots = layoutAlertMarkers(one, xScale, geom);
    expect(slots.map((s) => s.x)).toEqual([40.5, 90.5]);
    expect(slots.map((s) => s.row)).toEqual([0, 0]);
    expect(slots.map((s) => s.isRegression)).toEqual([true, false]);
  });

  it('drops markers outside the plot', () => {
    // Zoomed past them. Keeping them would pile a row of triangles against the
    // clip edge and imply alerts at the window's boundary.
    const outside = [{ alerts: [{ x: -50, isRegression: true }, { x: 150, isRegression: true }] }];
    expect(layoutAlertMarkers(outside, xScale, geom)).toEqual([]);
  });

  it('stacks two markers that would otherwise draw on top of each other', () => {
    // The case graphs-todo.md nominated this for: speedometer3's 2026-06-02
    // regression and improvement are 14 hours apart, about 5px at a 90-day
    // range against an 8px triangle, so red and green landed on one blob.
    const near = [{ alerts: [{ x: 50, isRegression: true }, { x: 53, isRegression: false }] }];
    expect(layoutAlertMarkers(near, xScale, geom).map((s) => s.row)).toEqual([0, 1]);
  });

  it('packs markers of different series together', () => {
    // Two series alerting on nearby pushes overlap on screen exactly as two
    // alerts of one series would, so they have to be packed as one set.
    const two = [
      { alerts: [{ x: 50, isRegression: true }] },
      { alerts: [{ x: 52, isRegression: true }] },
    ];
    const slots = layoutAlertMarkers(two, xScale, geom);
    expect(slots.map((s) => [s.seriesIndex, s.row])).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it('skips a series with no alerts', () => {
    expect(layoutAlertMarkers([{}, ...one], xScale, geom).every((s) => s.seriesIndex === 1)).toBe(
      true,
    );
    expect(layoutAlertMarkers([{ alerts: [] }], xScale, geom)).toEqual([]);
  });
});

describe('hitTestAlertSlots', () => {
  const one = layoutAlertMarkers(
    [{ alerts: [{ x: 20, isRegression: true }, { x: 70, isRegression: false }] }],
    xScale,
    geom,
  );

  it('finds the marker under the cursor', () => {
    expect(hitTestAlertSlots(one, geom, 40, 10)).toEqual({ seriesIndex: 0, alertIndex: 0 });
    expect(hitTestAlertSlots(one, geom, 90, 10)).toMatchObject({ alertIndex: 1 });
  });

  it('only answers inside the band at the top of the plot', () => {
    // The guide line runs the full height; a hit area that followed it would
    // swallow clicks meant for the dots it passes.
    expect(hitTestAlertSlots(one, geom, 40, geom.y0 - 1)).toBeNull();
    expect(hitTestAlertSlots(one, geom, 40, geom.y0 + ALERT_HIT_HEIGHT)).not.toBeNull();
    expect(hitTestAlertSlots(one, geom, 40, geom.y0 + ALERT_HIT_HEIGHT + 1)).toBeNull();
  });

  it('reaches ALERT_HIT_HALF_WIDTH either side and no further', () => {
    const at = (px: number) => hitTestAlertSlots(one, geom, px, 10);
    expect(at(40.5 + ALERT_HIT_HALF_WIDTH)).not.toBeNull();
    expect(at(40.5 - ALERT_HIT_HALF_WIDTH)).not.toBeNull();
    expect(at(40.5 + ALERT_HIT_HALF_WIDTH + 0.5)).toBeNull();
  });

  it('makes two stacked markers separately clickable by row', () => {
    // The payoff of the packing: overlapping markers used to be answerable only
    // by whichever column happened to be nearer, so one of them was effectively
    // unreachable. Now the answer follows where you point vertically.
    const near = layoutAlertMarkers(
      [{ alerts: [{ x: 50, isRegression: true }, { x: 51, isRegression: false }] }],
      xScale,
      geom,
    );
    const row0 = alertRowTop(geom, 0) + 2;
    const row1 = alertRowTop(geom, 1) + 2;
    expect(hitTestAlertSlots(near, geom, 70.5, row0)?.alertIndex).toBe(0);
    expect(hitTestAlertSlots(near, geom, 70.5, row1)?.alertIndex).toBe(1);
  });

  it('still picks the nearest column inside one row', () => {
    const near = layoutAlertMarkers(
      [{ alerts: [{ x: 50, isRegression: true }, { x: 53, isRegression: false }] }],
      xScale,
      geom,
    );
    // Both land on row 0 only if they don't collide; these do, so aim at row 0
    // for the first and check the horizontal rule with two far-apart markers.
    const far = layoutAlertMarkers(
      [{ alerts: [{ x: 50, isRegression: true }, { x: 60, isRegression: false }] }],
      xScale,
      geom,
    );
    expect(far.map((s) => s.row)).toEqual([0, 0]);
    expect(hitTestAlertSlots(far, geom, 71, 10)?.alertIndex).toBe(0);
    expect(hitTestAlertSlots(far, geom, 79, 10)?.alertIndex).toBe(1);
    expect(near.length).toBe(2);
  });

  it('gives rows above the last one a band that stops at the next row', () => {
    // Otherwise the generous 16px band of a stacked marker reaches straight
    // through the row below it and the stacking buys nothing.
    const near = layoutAlertMarkers(
      [{ alerts: [{ x: 50, isRegression: true }, { x: 51, isRegression: false }] }],
      xScale,
      geom,
    );
    const belowRow0 = alertRowTop(geom, 0) - 1 + ALERT_ROW_HEIGHT + 1;
    expect(hitTestAlertSlots(near, geom, 70.5, belowRow0)?.alertIndex).toBe(1);
  });

  it('answers nothing with no slots', () => {
    expect(hitTestAlertSlots([], geom, 40, 10)).toBeNull();
  });

  it('never stacks past ALERT_MAX_ROWS', () => {
    const many = [
      {
        alerts: Array.from({ length: 8 }, (_, i) => ({ x: 50 + i * 0.5, isRegression: true })),
      },
    ];
    const slots = layoutAlertMarkers(many, xScale, geom);
    expect(Math.max(...slots.map((s) => s.row))).toBeLessThan(ALERT_MAX_ROWS);
  });
});

describe('layoutChangeBars', () => {
  const bar = (x0: number, x1: number, changeX = (x0 + x1) / 2, isRegression = true) => ({
    x0,
    x1,
    changeX,
    isRegression,
  });

  it('projects a bar onto the pushes it spans', () => {
    const slots = layoutChangeBars([{ changes: [bar(20, 70, 40)] }], xScale, geom);
    expect(slots).toHaveLength(1);
    expect(slots[0]).toMatchObject({ x0: 40, x1: 90, changeX: 60, row: 0 });
  });

  it('widens a bar that would be too thin to see', () => {
    // A change over 48 pushes is a few pixels wide at a year's zoom, and a bar
    // you can't see is a finding you don't get.
    const slots = layoutChangeBars([{ changes: [bar(50, 51)] }], xScale, geom);
    expect(slots[0].x1 - slots[0].x0).toBe(CHANGE_BAR_MIN_WIDTH);
  });

  it('clips to the plot rather than dropping, unlike a marker', () => {
    // A bar is a range: one that starts before the window still has something
    // true to say inside it.
    const slots = layoutChangeBars([{ changes: [bar(-50, 50, 0)] }], xScale, geom);
    expect(slots[0].x0).toBe(geom.x0);
    expect(slots[0].x1).toBe(70);
    // …and the notch is clamped into the visible part rather than drawn off it.
    expect(slots[0].changeX).toBe(geom.x0);
  });

  it('drops a bar that does not reach the window at all', () => {
    expect(layoutChangeBars([{ changes: [bar(-80, -50)] }], xScale, geom)).toEqual([]);
    expect(layoutChangeBars([{ changes: [bar(150, 180)] }], xScale, geom)).toEqual([]);
  });

  it('stacks overlapping bars', () => {
    const slots = layoutChangeBars(
      [{ changes: [bar(0, 40), bar(30, 70), bar(80, 95)] }],
      xScale,
      geom,
    );
    expect(slots.map((s) => s.row)).toEqual([0, 1, 0]);
  });
});

describe('hitTestChangeBars', () => {
  const slots = layoutChangeBars(
    [{ changes: [{ x0: 20, x1: 40, changeX: 30, isRegression: true }] }],
    xScale,
    geom,
  );
  const inside = changeBarTop(geom, 0) + 2;

  it('answers anywhere along the bar', () => {
    expect(hitTestChangeBars(slots, geom, 45, inside)).toEqual({
      seriesIndex: 0,
      changeIndex: 0,
    });
    expect(hitTestChangeBars(slots, geom, 60 - 1, inside)).not.toBeNull();
  });

  it('reaches CHANGE_BAR_HIT_SLOP past each end and no further', () => {
    expect(hitTestChangeBars(slots, geom, 60 + CHANGE_BAR_HIT_SLOP, inside)).not.toBeNull();
    expect(hitTestChangeBars(slots, geom, 60 + CHANGE_BAR_HIT_SLOP + 1, inside)).toBeNull();
  });

  it('only answers inside its own row band', () => {
    const band = changeBarBand(geom, 0);
    expect(hitTestChangeBars(slots, geom, 45, band.top)).not.toBeNull();
    expect(hitTestChangeBars(slots, geom, 45, band.top - 1)).toBeNull();
    expect(hitTestChangeBars(slots, geom, 45, band.bottom)).not.toBeNull();
    expect(hitTestChangeBars(slots, geom, 45, band.bottom + 1)).toBeNull();
    // The band must not reach up into the dots — a bar sits well below them.
    expect(band.top).toBeGreaterThan(geom.y1 - CHANGE_BAR_HEIGHT - 8);
  });

  it('separates two stacked bars by row', () => {
    const stacked = layoutChangeBars(
      [
        {
          changes: [
            { x0: 0, x1: 40, changeX: 20, isRegression: true },
            { x0: 30, x1: 70, changeX: 50, isRegression: false },
          ],
        },
      ],
      xScale,
      geom,
    );
    const at = (row: number) => changeBarTop(geom, row) + 2;
    // 55px is inside both bars horizontally; only the row tells them apart.
    expect(hitTestChangeBars(stacked, geom, 55, at(0))?.changeIndex).toBe(0);
    expect(hitTestChangeBars(stacked, geom, 55, at(1))?.changeIndex).toBe(1);
  });
});
