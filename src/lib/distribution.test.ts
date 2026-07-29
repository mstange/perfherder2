import { describe, expect, it } from 'vitest';
import {
  buildDistribution,
  GRID_POINTS,
  jitterAt,
  MIN_CURVE_VALUES,
  type DistributionInput,
} from './distribution';

function input(values: number[], over: Partial<DistributionInput> = {}): DistributionInput {
  return { label: 'A', color: '#000', values, markedIndex: -1, ...over };
}

describe('jitterAt', () => {
  it('is deterministic and in range', () => {
    for (let i = 0; i < 500; i++) {
      const j = jitterAt(i, i % 2);
      expect(j).toBeGreaterThanOrEqual(-1);
      expect(j).toBeLessThanOrEqual(1);
      expect(jitterAt(i, i % 2)).toBe(j);
    }
  });

  it('differs between the two sides at the same index', () => {
    // Otherwise both sides' strips would carry an identical pattern of
    // offsets, which reads as a relationship between the pools that isn't
    // there.
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

describe('buildDistribution', () => {
  const pool = (n: number, base: number) => Array.from({ length: n }, (_, i) => base + (i % 5));

  it('puts both sides on one grid covering both', () => {
    const plot = buildDistribution([
      input(pool(20, 100), { label: 'before' }),
      input(pool(20, 300), { label: 'after', color: '#f00' }),
    ]);
    expect(plot.grid).toHaveLength(GRID_POINTS);
    expect(plot.domain.min).toBeLessThan(100);
    expect(plot.domain.max).toBeGreaterThan(304);
    expect(plot.series.map((s) => s.density.length)).toEqual([GRID_POINTS, GRID_POINTS]);
    expect(plot.series.map((s) => s.label)).toEqual(['before', 'after']);
  });

  it('finds each side its own mode', () => {
    const plot = buildDistribution([
      input(pool(30, 100)),
      input(pool(30, 300), { color: '#f00' }),
    ]);
    const [a, b] = plot.series;
    expect(a.modes.peakLocs).toHaveLength(1);
    expect(b.modes.peakLocs).toHaveLength(1);
    expect(a.modes.peakLocs[0]).toBeLessThan(150);
    expect(b.modes.peakLocs[0]).toBeGreaterThan(250);
    expect(a.modes.letters).toEqual(['A']);
  });

  it('shares one density scale across sides', () => {
    const tight = Array.from({ length: 40 }, (_, i) => 100 + (i % 2) * 0.1);
    const loose = Array.from({ length: 40 }, (_, i) => 100 + i);
    const plot = buildDistribution([input(tight), input(loose, { color: '#f00' })]);
    const peak = (i: number) => Math.max(...plot.series[i].density);
    // Both curves integrate to 1, so the tighter pool is legitimately taller,
    // and maxDensity is the taller of the two.
    expect(peak(0)).toBeGreaterThan(peak(1));
    expect(plot.maxDensity).toBeCloseTo(peak(0), 12);
  });

  it('withholds the curve from a pool too small to support one', () => {
    const plot = buildDistribution([input([10, 11, 12])]);
    expect(MIN_CURVE_VALUES).toBe(4);
    expect(plot.series[0].density).toEqual([]);
    expect(plot.series[0].modes.peakLocs).toEqual([]);
    expect(plot.hasCurves).toBe(false);
    // The strip still carries every value — that's the honest picture.
    expect(plot.series[0].strip).toHaveLength(3);
    expect(plot.series[0].summary?.count).toBe(3);
  });

  it('keeps a curve for one side when only the other is too small', () => {
    const plot = buildDistribution([input(pool(20, 100)), input([300], { color: '#f00' })]);
    expect(plot.series[0].density).toHaveLength(GRID_POINTS);
    expect(plot.series[1].density).toEqual([]);
    expect(plot.hasCurves).toBe(true);
    // The domain still has to reach the lone value, or its strip dot lands
    // outside the plot.
    expect(plot.domain.max).toBeGreaterThan(300);
  });

  it('marks the clicked value on the strip, and only that one', () => {
    const plot = buildDistribution([input([5, 6, 5, 7], { markedIndex: 2 })]);
    expect(plot.series[0].strip.map((d) => d.marked)).toEqual([false, false, true, false]);
  });

  it('does not run a non-negative axis below zero', () => {
    // Values small relative to the kernel width would otherwise pad the domain
    // into negative milliseconds.
    const plot = buildDistribution([input([0.1, 0.2, 0.15, 0.3, 0.25])]);
    expect(plot.domain.min).toBe(0);
  });

  it('pads below zero when the data genuinely goes there', () => {
    const plot = buildDistribution([input([-5, -3, -1, 2, 4])]);
    expect(plot.domain.min).toBeLessThan(-5);
  });

  it('survives an empty pool', () => {
    const plot = buildDistribution([input([])]);
    expect(plot.grid).toHaveLength(GRID_POINTS);
    expect(plot.domain.max).toBeGreaterThan(plot.domain.min);
    expect(plot.series[0].strip).toEqual([]);
    expect(plot.series[0].summary).toBeNull();
    expect(plot.hasCurves).toBe(false);
  });

  it('gives an all-identical pool an axis with width', () => {
    const plot = buildDistribution([input([7, 7, 7, 7, 7, 7])]);
    expect(plot.domain.max).toBeGreaterThan(plot.domain.min);
    expect(plot.series[0].modes.peakLocs).toHaveLength(1);
    expect(plot.series[0].modes.peakLocs[0]).toBeCloseTo(7, 1);
  });
});
