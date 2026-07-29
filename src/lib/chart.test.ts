import { describe, expect, it } from 'vitest';
import {
  formatPValue,
  formatSignedPercent,
  formatSignedValue,
  formatTickValue,
  formatValue,
  hitTestAll,
  hitTestSeries,
  lowerBound,
  makeGeometry,
  makeScale,
  niceStep,
  padDomain,
  pickTimeStep,
  SERIES_COLORS,
  SERIES_SYMBOLS,
  styleForIndex,
  timeTicks,
  unionRange,
  valueTicks,
} from './chart';
import type { SeriesPoint } from './graphData';

const DAY = 86400000;
const HOUR = 3600000;

function pts(xs: number[]): SeriesPoint[] {
  return xs.map((x, i) => ({ x, y: x, datumId: i, replicateIndex: 0 }));
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
    { x: 10, y: 10, datumId: 1, replicateIndex: 0 },
    { x: 50, y: 50, datumId: 2, replicateIndex: 0 },
    { x: 52, y: 55, datumId: 2, replicateIndex: 1 },
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
});

describe('hitTestAll', () => {
  const xScale = makeScale(0, 100, 0, 100);
  const yScale = makeScale(0, 100, 0, 100);
  const a = { points: [{ x: 10, y: 10, datumId: 1, replicateIndex: 0 }] };
  const b = { points: [{ x: 12, y: 12, datumId: 2, replicateIndex: 0 }] };

  it('picks the closest point across series', () => {
    expect(hitTestAll([a, b], xScale, yScale, 12, 12, 10)?.seriesIndex).toBe(1);
    expect(hitTestAll([a, b], xScale, yScale, 10, 10, 10)?.seriesIndex).toBe(0);
  });

  it('returns null when every series misses', () => {
    expect(hitTestAll([a, b], xScale, yScale, 80, 80, 3)).toBeNull();
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
