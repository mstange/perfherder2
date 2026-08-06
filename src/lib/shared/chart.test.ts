import { describe, expect, it } from 'vitest';
import {
  formatPValue,
  formatSignedPercent,
  formatSignedValue,
  formatTickValue,
  formatValue,
  hitTestAlerts,
  hitTestAll,
  hitTestSeries,
  ALERT_HIT_HALF_WIDTH,
  ALERT_HIT_HEIGHT,
  JITTER_MAX_RADII,
  jitterAt,
  jitterOffsetPx,
  lowerBound,
  makeGeometry,
  makeScale,
  niceStep,
  makeJitterScale,
  padDomain,
  pickTimeStep,
  pixelSpan,
  SERIES_COLORS,
  SERIES_SYMBOLS,
  styleForIndex,
  timeTicks,
  unionRange,
  valueTicks,
} from './chart';
import type { SeriesPoint } from '../graphs/graphData';

const DAY = 86400000;
const HOUR = 3600000;

function point(o: Partial<SeriesPoint> & { x: number; y: number }): SeriesPoint {
  return { datumId: 1, replicateIndex: 0, jitter: 0, xRoom: Infinity, ...o };
}

function pts(xs: number[]): SeriesPoint[] {
  return xs.map((x, i) => point({ x, y: x, datumId: i }));
}

describe('makeScale', () => {
  it('maps domain onto pixel range and back', () => {
    const s = makeScale(0, 10, 100, 200);
    expect(s.toPixel(0)).toBe(100);
    expect(s.toPixel(10)).toBe(200);
    expect(s.toPixel(5)).toBe(150);
    expect(s.toValue(150)).toBe(5);
  });

  it('supports an inverted pixel range, as the y axis needs', () => {
    const s = makeScale(0, 10, 200, 0);
    expect(s.toPixel(0)).toBe(200);
    expect(s.toPixel(10)).toBe(0);
    expect(s.toValue(100)).toBe(5);
  });

  it('centres a zero-width domain instead of dividing by zero', () => {
    const s = makeScale(5, 5, 0, 100);
    expect(s.toPixel(5)).toBe(50);
    expect(Number.isFinite(s.toPixel(7))).toBe(true);
  });
});

describe('padDomain', () => {
  it('pads by 5% of the span on each side', () => {
    expect(padDomain(0, 100)).toEqual({ min: -5, max: 105 });
  });

  it('gives a flat series a usable width', () => {
    const r = padDomain(200, 200);
    expect(r.max - r.min).toBeGreaterThan(0);
    expect(r.min).toBeLessThan(200);
  });

  it('handles a flat series at zero', () => {
    expect(padDomain(0, 0)).toEqual({ min: -1, max: 1 });
  });

  it('falls back to a unit domain for non-finite input', () => {
    expect(padDomain(Infinity, -Infinity)).toEqual({ min: 0, max: 1 });
  });
});

describe('unionRange', () => {
  it('unions extents', () => {
    expect(unionRange([{ min: 3, max: 7 }, { min: 1, max: 5 }])).toEqual({ min: 1, max: 7 });
  });

  it('skips empty extents and returns null when all are empty', () => {
    expect(unionRange([{ min: Infinity, max: -Infinity }, { min: 2, max: 4 }])).toEqual({
      min: 2,
      max: 4,
    });
    expect(unionRange([])).toBeNull();
  });
});

describe('niceStep', () => {
  it('picks 1/2/5 x 10^k', () => {
    expect(niceStep(100, 5)).toBe(20);
    expect(niceStep(10, 5)).toBe(2);
    expect(niceStep(1, 5)).toBe(0.2);
    expect(niceStep(37, 5)).toBe(10);
  });

  it('degrades gracefully on a zero span', () => {
    expect(niceStep(0, 5)).toBe(1);
  });
});

describe('valueTicks', () => {
  it('covers the range on round numbers', () => {
    expect(valueTicks({ min: 0, max: 100 }, 5)).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it('starts at the first round value inside the range', () => {
    expect(valueTicks({ min: 3, max: 19 }, 4)).toEqual([5, 10, 15]);
  });

  it('does not emit float noise', () => {
    expect(valueTicks({ min: 0, max: 1 }, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });
});

describe('formatTickValue', () => {
  it('abbreviates large magnitudes', () => {
    expect(formatTickValue(0)).toBe('0');
    expect(formatTickValue(1500)).toBe('1500');
    expect(formatTickValue(25000)).toBe('25k');
    expect(formatTickValue(2_500_000)).toBe('2.5M');
    expect(formatTickValue(3e9)).toBe('3G');
  });

  it('keeps precision below 1', () => {
    expect(formatTickValue(0.25)).toBe('0.25');
  });
});

describe('formatValue', () => {
  it('shows two decimals but drops trailing zeros', () => {
    expect(formatValue(12.3456)).toBe('12.35');
    expect(formatValue(12)).toBe('12');
  });

  it('reports non-finite input rather than printing NaN', () => {
    expect(formatValue(NaN)).toBe('N/A');
  });
});

describe('pickTimeStep', () => {
  it('scales the unit to the span', () => {
    expect(pickTimeStep(2 * HOUR, 8)).toBe(15 * 60000);
    expect(pickTimeStep(14 * DAY, 8)).toBe(2 * DAY);
    expect(pickTimeStep(365 * DAY, 8)).toBe(90 * DAY);
  });
});

describe('timeTicks', () => {
  it('lands day-resolution ticks on local midnight', () => {
    const start = new Date(2026, 6, 1, 5, 0, 0).getTime();
    const ticks = timeTicks({ min: start, max: start + 10 * DAY }, 8);
    expect(ticks.length).toBeGreaterThan(2);
    for (const t of ticks) {
      const d = new Date(t.value);
      expect([d.getHours(), d.getMinutes()]).toEqual([0, 0]);
    }
  });

  it('stays inside the range', () => {
    const start = new Date(2026, 6, 1, 5, 0, 0).getTime();
    const range = { min: start, max: start + 3 * DAY };
    for (const t of timeTicks(range, 6)) {
      expect(t.value).toBeGreaterThanOrEqual(range.min);
      expect(t.value).toBeLessThanOrEqual(range.max);
    }
  });

  it('returns nothing for an empty range', () => {
    expect(timeTicks({ min: 5, max: 5 })).toEqual([]);
  });

  it('labels sub-day ticks with a clock time', () => {
    const start = new Date(2026, 6, 1, 1, 0, 0).getTime();
    const ticks = timeTicks({ min: start, max: start + 6 * HOUR }, 6);
    expect(ticks[0].label).toMatch(/^\d\d:\d\d$/);
  });
});

describe('lowerBound', () => {
  const p = pts([10, 20, 20, 30]);

  it('finds the first index at or after x', () => {
    expect(lowerBound(p, 5)).toBe(0);
    expect(lowerBound(p, 20)).toBe(1);
    expect(lowerBound(p, 25)).toBe(3);
    expect(lowerBound(p, 99)).toBe(4);
  });
});

describe('hitTestSeries', () => {
  // x in [0,100] -> px [0,100]; y likewise, un-inverted for simplicity.
  const xScale = makeScale(0, 100, 0, 100);
  const yScale = makeScale(0, 100, 0, 100);
  const points: SeriesPoint[] = [
    point({ x: 10, y: 10, datumId: 1 }),
    point({ x: 50, y: 50, datumId: 2 }),
    point({ x: 52, y: 55, datumId: 2, replicateIndex: 1 }),
  ];

  it('finds the nearest point inside the radius', () => {
    expect(hitTestSeries(points, xScale, yScale, 51, 51, 6)?.pointIndex).toBe(1);
    expect(hitTestSeries(points, xScale, yScale, 52, 54, 6)?.pointIndex).toBe(2);
  });

  it('misses when nothing is within the radius', () => {
    expect(hitTestSeries(points, xScale, yScale, 80, 80, 5)).toBeNull();
  });

  it('handles an empty series', () => {
    expect(hitTestSeries([], xScale, yScale, 0, 0, 5)).toBeNull();
  });

  it('reports squared distance so callers can compare across series', () => {
    const hit = hitTestSeries(points, xScale, yScale, 13, 14, 10);
    expect(hit?.distanceSq).toBe(25);
  });

  // The dots are drawn at their jittered position, so the cursor has to be
  // tested against that position and not against the push time.
  describe('with jitter', () => {
    const jittered: SeriesPoint[] = [
      point({ x: 50, y: 50, datumId: 1, jitter: -1 }),
      point({ x: 50, y: 50, datumId: 2, jitter: 1 }),
    ];

    // maxPx 8, and enough room that the ceiling governs: the two dots are drawn
    // at px 42 and 58.
    const scale = { pxPerValue: 1, maxPx: 8 };

    it('measures from the jittered position', () => {
      expect(hitTestSeries(jittered, xScale, yScale, 42, 50, 3, scale)?.pointIndex).toBe(0);
      expect(hitTestSeries(jittered, xScale, yScale, 58, 50, 3, scale)?.pointIndex).toBe(1);
      // And the un-jittered position between them is now a miss, which is the
      // whole point: that gap is empty on screen too.
      expect(hitTestSeries(jittered, xScale, yScale, 50, 50, 3, scale)).toBeNull();
    });

    it('finds a dot the jitter pushed outside the search window', () => {
      // Without widening the x-sorted scan by the ceiling, the binary search for
      // px 58 ± 3 would start past this point and miss it entirely.
      const far = [point({ x: 50, y: 50, jitter: 1 })];
      expect(hitTestSeries(far, xScale, yScale, 58, 50, 3, scale)?.pointIndex).toBe(0);
    });
  });
});

describe('hitTestAll', () => {
  const xScale = makeScale(0, 100, 0, 100);
  const yScale = makeScale(0, 100, 0, 100);
  const a = { points: [point({ x: 10, y: 10, datumId: 1 })] };
  const b = { points: [point({ x: 12, y: 12, datumId: 2 })] };

  it('picks the closest point across series', () => {
    expect(hitTestAll([a, b], xScale, yScale, 12, 12, 10)?.seriesIndex).toBe(1);
    expect(hitTestAll([a, b], xScale, yScale, 10, 10, 10)?.seriesIndex).toBe(0);
  });

  it('returns null when every series misses', () => {
    expect(hitTestAll([a, b], xScale, yScale, 80, 80, 3)).toBeNull();
  });

  it('offsets by each point own room', () => {
    // Two series over the same push time, one of them with a crowded neighbour
    // and so almost no room to spread into.
    const roomy = { points: [point({ x: 50, y: 50, jitter: -1, xRoom: 10 })] };
    const tight = { points: [point({ x: 50, y: 50, jitter: -1, xRoom: 2 })] };
    const scale = { pxPerValue: 1, maxPx: 20 };
    expect(hitTestAll([roomy, tight], xScale, yScale, 40, 50, 3, scale)?.seriesIndex).toBe(0);
    expect(hitTestAll([roomy, tight], xScale, yScale, 48, 50, 3, scale)?.seriesIndex).toBe(1);
  });
});

describe('hitTestAlerts', () => {
  // 100 time units across 100px of plot, offset so x0 isn't 0 — a bug that
  // forgets the left padding still passes when the plot starts at the origin.
  const xScale = makeScale(0, 100, 20, 120);
  const geom = { x0: 20, x1: 120, y0: 8 };
  // Rounded to pixel 40.5 and 90.5 by the same +0.5 the draw loop applies.
  const one = { alerts: [{ x: 20 }, { x: 70 }] };

  it('finds the marker under the cursor', () => {
    expect(hitTestAlerts([one], xScale, geom, 40, 10)).toMatchObject({
      seriesIndex: 0,
      alertIndex: 0,
    });
    expect(hitTestAlerts([one], xScale, geom, 90, 10)).toMatchObject({ alertIndex: 1 });
  });

  it('only answers inside the band at the top of the plot', () => {
    // The guide line runs the full height; a hit area that followed it would
    // swallow clicks meant for the dots it passes.
    expect(hitTestAlerts([one], xScale, geom, 40, geom.y0 - 1)).toBeNull();
    expect(hitTestAlerts([one], xScale, geom, 40, geom.y0 + ALERT_HIT_HEIGHT)).not.toBeNull();
    expect(hitTestAlerts([one], xScale, geom, 40, geom.y0 + ALERT_HIT_HEIGHT + 1)).toBeNull();
  });

  it('reaches ALERT_HIT_HALF_WIDTH either side and no further', () => {
    const at = (px: number) => hitTestAlerts([one], xScale, geom, px, 10);
    expect(at(40.5 + ALERT_HIT_HALF_WIDTH)).not.toBeNull();
    expect(at(40.5 - ALERT_HIT_HALF_WIDTH)).not.toBeNull();
    expect(at(40.5 + ALERT_HIT_HALF_WIDTH + 0.5)).toBeNull();
  });

  it('picks the nearest of two overlapping markers', () => {
    // The case from graphs-todo.md: two alerts hours apart draw as one blob at
    // a long range, but they are still two separate click targets.
    const near = { alerts: [{ x: 50 }, { x: 53 }] };
    expect(hitTestAlerts([near], xScale, geom, 70, 10)?.alertIndex).toBe(0);
    expect(hitTestAlerts([near], xScale, geom, 74, 10)?.alertIndex).toBe(1);
  });

  it('picks the nearest across series', () => {
    const a = { alerts: [{ x: 50 }] };
    const b = { alerts: [{ x: 54 }] };
    expect(hitTestAlerts([a, b], xScale, geom, 71, 10)?.seriesIndex).toBe(0);
    expect(hitTestAlerts([a, b], xScale, geom, 74, 10)?.seriesIndex).toBe(1);
  });

  it('ignores markers the draw loop clipped', () => {
    // Zoomed past them. Drawing skips these so they don't pile up against the
    // edge; if the hit test kept them, the plot's border would be a row of
    // invisible buttons.
    const outside = { alerts: [{ x: -50 }, { x: 150 }] };
    expect(hitTestAlerts([outside], xScale, geom, geom.x0, 10)).toBeNull();
    expect(hitTestAlerts([outside], xScale, geom, geom.x1, 10)).toBeNull();
  });

  it('skips a series with no alerts', () => {
    expect(hitTestAlerts([{}, one], xScale, geom, 40, 10)?.seriesIndex).toBe(1);
    expect(hitTestAlerts([{ alerts: [] }], xScale, geom, 40, 10)).toBeNull();
  });
});

describe('jitterAt', () => {
  it('is deterministic and in range', () => {
    for (let i = 0; i < 500; i++) {
      const j = jitterAt(i, i % 2);
      expect(j).toBeGreaterThanOrEqual(-1);
      expect(j).toBeLessThanOrEqual(1);
      expect(jitterAt(i, i % 2)).toBe(j);
    }
  });

  it('differs between two salts at the same index', () => {
    // For the distribution strip, otherwise both sides carry an identical
    // pattern of offsets, which reads as a relationship between the pools that
    // isn't there. For the graphs, otherwise every replicate of a run lands on
    // the same offset and the vertical line the jitter exists to break up
    // survives unchanged.
    for (let i = 0; i < 20; i++) expect(jitterAt(i, 0)).not.toBe(jitterAt(i, 1));
  });

  it('spreads consecutive indices across the band', () => {
    // Equal neighbouring values (an integer-valued metric) must not stack up.
    const first = Array.from({ length: 40 }, (_, i) => jitterAt(i, 0));
    const above = first.filter((j) => j > 0).length;
    expect(above).toBeGreaterThan(10);
    expect(above).toBeLessThan(30);
  });
});

describe('makeJitterScale and jitterOffsetPx', () => {
  // 100 units of time onto 1000px, so one unit is 10px.
  const xScale = makeScale(0, 100, 0, 1000);

  it('scales a point room into pixels', () => {
    const scale = makeJitterScale(xScale, 100);
    // 2 units of room is 20px, and the dot radius is far too big to cap it.
    expect(jitterOffsetPx({ jitter: 1, xRoom: 2 }, scale)).toBeCloseTo(20);
    expect(jitterOffsetPx({ jitter: -0.5, xRoom: 2 }, scale)).toBeCloseTo(-10);
    expect(jitterOffsetPx({ jitter: 0, xRoom: 2 }, scale)).toBe(0);
  });

  it('caps at a multiple of the dot radius', () => {
    // A push isolated by a weekend has hours of room; without the cap its
    // replicates would smear across a quarter of the plot.
    const scale = makeJitterScale(xScale, 3);
    expect(jitterOffsetPx({ jitter: 1, xRoom: 50 }, scale)).toBe(3 * JITTER_MAX_RADII);
  });

  it('grows as you zoom in, since the room is in data units', () => {
    const zoomed = makeJitterScale(makeScale(0, 10, 0, 1000), 100);
    expect(jitterOffsetPx({ jitter: 1, xRoom: 2 }, zoomed)).toBeCloseTo(200);
  });

  it('falls back to the ceiling for a lone push', () => {
    // `xRoom` is Infinity there, and Infinity × a zero-width domain's scale is
    // NaN — which would spread from one dot into every coordinate on the canvas.
    const scale = makeJitterScale(xScale, 3);
    expect(jitterOffsetPx({ jitter: 1, xRoom: Infinity }, scale)).toBe(3 * JITTER_MAX_RADII);
    const degenerate = makeJitterScale(makeScale(5, 5, 0, 1000), 3);
    expect(jitterOffsetPx({ jitter: 1, xRoom: Infinity }, degenerate)).toBe(
      3 * JITTER_MAX_RADII,
    );
  });

  it('is positive-going for an inverted scale', () => {
    // pxPerValue is a magnitude; a reversed x scale must not flip every dot's
    // offset, which would put the ring on the wrong side of its dot.
    const scale = makeJitterScale(makeScale(0, 100, 1000, 0), 100);
    expect(jitterOffsetPx({ jitter: 1, xRoom: 2 }, scale)).toBeCloseTo(20);
  });
});

describe('pixelSpan', () => {
  it('converts a pixel width into data units', () => {
    expect(pixelSpan(makeScale(0, 100, 0, 1000), 50)).toBeCloseTo(5);
  });

  it('is positive for an inverted scale', () => {
    // The y scale is built inverted (p0 = bottom), so a negative answer here
    // would silently reverse whichever window a caller widens with it.
    expect(pixelSpan(makeScale(0, 100, 1000, 0), 50)).toBeCloseTo(5);
  });
});

describe('makeGeometry', () => {
  const pad = { left: 50, right: 10, top: 5, bottom: 20 };

  it('lays out the plot area inside the padding', () => {
    const g = makeGeometry(400, 200, pad, { min: 0, max: 10 }, { min: 0, max: 100 });
    expect([g.x0, g.x1, g.y0, g.y1]).toEqual([50, 390, 5, 180]);
    expect(g.plotWidth).toBe(340);
    expect(g.plotHeight).toBe(175);
  });

  it('inverts the y scale so larger values are higher', () => {
    const g = makeGeometry(400, 200, pad, { min: 0, max: 10 }, { min: 0, max: 100 });
    expect(g.yScale.toPixel(0)).toBe(180);
    expect(g.yScale.toPixel(100)).toBe(5);
  });

  it('never produces a negative-size plot area', () => {
    const g = makeGeometry(10, 10, pad, { min: 0, max: 10 }, { min: 0, max: 100 });
    expect(g.plotWidth).toBeGreaterThan(0);
    expect(g.plotHeight).toBeGreaterThan(0);
  });
});

describe('styleForIndex', () => {
  // The first six are treeherder's, in the order treeherder hands them out —
  // which is the reverse of the order its constants file declares them, because
  // it pops both lists. Getting this wrong would give every shared graph a
  // different look from the treeherder equivalent, and nothing else in the app
  // would notice.
  it('matches treeherder for the first six series', () => {
    expect([0, 1, 2, 3, 4, 5].map((i) => styleForIndex(i).color)).toEqual([
      '#464876',
      '#16BCDE',
      '#C92D2F',
      '#921181',
      '#FFB851',
      '#4C3146',
    ]);
    expect([0, 1, 2, 3, 4, 5].map((i) => styleForIndex(i).symbol)).toEqual([
      { shape: 'circle', filled: true },
      { shape: 'circle', filled: false },
      { shape: 'square', filled: true },
      { shape: 'square', filled: false },
      { shape: 'diamond', filled: true },
      { shape: 'diamond', filled: false },
    ]);
  });

  it('cycles the colors', () => {
    expect(styleForIndex(SERIES_COLORS.length).color).toBe(SERIES_COLORS[0]);
  });

  it('never repeats a (color, symbol) pair within 36 series', () => {
    const seen = new Set<string>();
    for (let i = 0; i < SERIES_COLORS.length * SERIES_SYMBOLS.length; i++) {
      const s = styleForIndex(i);
      seen.add(`${s.color}|${s.symbol.shape}|${s.symbol.filled}`);
    }
    expect(seen.size).toBe(36);
  });

  it('gives the seventh series a different symbol from the first', () => {
    // Where treeherder simply stops drawing. Same color, so the shape is all
    // that separates them.
    expect(styleForIndex(6).color).toBe(styleForIndex(0).color);
    expect(styleForIndex(6).symbol).not.toEqual(styleForIndex(0).symbol);
  });

  it('is defined for junk indices', () => {
    expect(styleForIndex(-1)).toEqual(styleForIndex(0));
    expect(styleForIndex(1.7).color).toBe(SERIES_COLORS[1]);
  });
});

describe('formatSignedValue', () => {
  it('always shows a sign', () => {
    expect(formatSignedValue(95)).toBe('+95');
    expect(formatSignedValue(-95.256)).toBe('-95.26');
    expect(formatSignedValue(0)).toBe('+0');
  });

  it('takes the sign from the input, not from the rounded string', () => {
    // -0.001 rounds to "0"; without reading the sign off the input it would
    // print "+0" for a decrease.
    expect(formatSignedValue(-0.001)).toBe('-0');
  });

  it('reports a non-finite delta rather than printing NaN', () => {
    expect(formatSignedValue(NaN)).toBe('N/A');
  });
});

describe('formatSignedPercent', () => {
  it('keeps precision where a perf regression lives', () => {
    expect(formatSignedPercent(0.004)).toBe('+0.40%');
    expect(formatSignedPercent(-0.052)).toBe('-5.2%');
    expect(formatSignedPercent(0.931)).toBe('+93%');
  });

  it('reports a non-finite fraction', () => {
    expect(formatSignedPercent(Infinity)).toBe('N/A');
  });
});

describe('formatPValue', () => {
  it('caps the precision and the small end', () => {
    expect(formatPValue(0.0121858)).toBe('0.012');
    expect(formatPValue(0.4)).toBe('0.400');
    expect(formatPValue(1)).toBe('1.000');
    expect(formatPValue(1e-9)).toBe('<0.001');
  });
});
