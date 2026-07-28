import { describe, expect, it } from 'vitest';
import {
  colorForIndex,
  formatTickValue,
  formatValue,
  hitTestSeries,
  lowerBound,
  makeScale,
  niceStep,
  padDomain,
  pickTimeStep,
  SERIES_COLORS,
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

describe('colorForIndex', () => {
  it('cycles the palette', () => {
    expect(colorForIndex(0)).toBe(SERIES_COLORS[0]);
    expect(colorForIndex(SERIES_COLORS.length)).toBe(SERIES_COLORS[0]);
  });
});
