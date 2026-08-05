import { describe, expect, it } from 'vitest';
import {
  AXIS_HEADROOM,
  buildDistribution,
  DENSITY_HEIGHT,
  distributionHeight,
  distributionLayout,
  GRID_POINTS,
  MIN_CURVE_VALUES,
  paddedExtent,
  stableAxis,
  STRIP_ROW_HEIGHT,
  type DistributionInput,
} from './distribution';

function input(values: number[], over: Partial<DistributionInput> = {}): DistributionInput {
  return { label: 'A', color: '#000', values, markedIndex: -1, ...over };
}

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

  // The details pane hands in an axis derived from the whole selection, so that
  // swapping one side for another — which is what a hover does, on every dot —
  // can't rescale the chart under the reader.
  describe('with a fixed axis', () => {
    const wide = { min: 0, max: 1000 };

    it('uses it instead of fitting the pools', () => {
      const plot = buildDistribution([input(pool(20, 100))], wide);
      expect(plot.domain.min).toBe(0);
      expect(plot.domain.max).toBe(1000);
    });

    it('gives two different pools the same axis', () => {
      const a = buildDistribution([input(pool(20, 100)), input(pool(20, 120))], wide);
      const b = buildDistribution([input(pool(20, 100)), input(pool(5, 800))], wide);
      expect(a.domain).toEqual(b.domain);
      // …and therefore the shared side is drawn identically in both.
      expect(a.series[0].density).toEqual(b.series[0].density);
    });

    it('still widens for a pool the axis does not cover', () => {
      // A compared point in another series, or outside the zoom the axis came
      // from: its strip dots have to land on the plot, not off the end of it.
      const plot = buildDistribution([input(pool(20, 100)), input([5000])], wide);
      expect(plot.domain.min).toBe(0);
      expect(plot.domain.max).toBeGreaterThan(5000);
    });
  });

  it('gives an all-identical pool an axis with width', () => {
    const plot = buildDistribution([input([7, 7, 7, 7, 7, 7])]);
    expect(plot.domain.max).toBeGreaterThan(plot.domain.min);
    expect(plot.series[0].modes.peakLocs).toHaveLength(1);
    expect(plot.series[0].modes.peakLocs[0]).toBeCloseTo(7, 1);
  });
});

describe('distributionHeight', () => {
  it('grows by one row per side', () => {
    expect(distributionHeight(2, true) - distributionHeight(1, true)).toBe(STRIP_ROW_HEIGHT);
  });

  it('drops the density band when nothing has a curve', () => {
    expect(distributionHeight(1, true) - distributionHeight(1, false)).toBeGreaterThanOrEqual(
      DENSITY_HEIGHT,
    );
  });

  it('reserves a row even for no sides at all', () => {
    expect(distributionHeight(0, false)).toBe(distributionHeight(1, false));
  });

  it('keeps the band when it is reserved but nothing has a curve', () => {
    // The height a hover can land on has to be the height the chart already has,
    // or the pane grows and shrinks by a whole band under the pointer.
    expect(distributionHeight(2, false, true)).toBe(distributionHeight(2, true));
    expect(distributionHeight(2, true, true)).toBe(distributionHeight(2, true));
  });
});

describe('paddedExtent', () => {
  it('covers every pool plus room for its curve to taper', () => {
    const r = paddedExtent([[100, 104], [130, 134]]);
    expect(r.min).toBeLessThan(100);
    expect(r.max).toBeGreaterThan(134);
  });

  it('stops at zero for a non-negative pool', () => {
    // An axis that runs to -8ms because the kernel is wider than the values are
    // large is worse than a curve clipped where the true density stops anyway.
    expect(paddedExtent([[1, 2, 3]]).min).toBe(0);
    expect(paddedExtent([[-5, 1]]).min).toBeLessThan(-5);
  });

  it('ignores empty pools and falls back to a unit range', () => {
    expect(paddedExtent([[], [5, 6]])).toEqual(paddedExtent([[5, 6]]));
    expect(paddedExtent([])).toEqual({ min: 0, max: 1 });
    expect(paddedExtent([[]])).toEqual({ min: 0, max: 1 });
  });

  it('is what buildDistribution fits its own domain to', () => {
    const values = Array.from({ length: 20 }, (_, i) => 100 + (i % 5));
    const plot = buildDistribution([input(values)]);
    const fit = paddedExtent([values]);
    expect(plot.domain.min).toBeCloseTo(fit.min, 9);
    expect(plot.domain.max).toBeCloseTo(fit.max, 9);
  });
});

describe('stableAxis', () => {
  const pool = Array.from({ length: 20 }, (_, i) => 100 + (i % 5));

  it('is the pool own fit plus headroom on each side', () => {
    const fit = paddedExtent([pool]);
    const axis = stableAxis(pool);
    const width = fit.max - fit.min;
    expect(axis.min).toBeCloseTo(fit.min - width * AXIS_HEADROOM, 9);
    expect(axis.max).toBeCloseTo(fit.max + width * AXIS_HEADROOM, 9);
  });

  it('leaves the pool centred, so the headroom is on both sides', () => {
    const fit = paddedExtent([pool]);
    const axis = stableAxis(pool);
    expect((fit.min + fit.max) / 2).toBeCloseTo((axis.min + axis.max) / 2, 9);
  });

  it('is what makes a nearby pool a no-op and a distant one not', () => {
    const near = pool.map((v) => v + 1);
    const far = pool.map((v) => v + 500);
    const axis = stableAxis(pool);
    const with_ = (other: number[]) =>
      buildDistribution([input(pool), input(other, { color: '#f00' })], axis).domain;
    expect(with_(near)).toEqual(axis);
    expect(with_(far).max).toBeGreaterThan(axis.max);
  });
});

describe('distributionLayout', () => {
  const twoSides = buildDistribution([
    input(Array.from({ length: 20 }, (_, i) => 100 + (i % 4))),
    input(Array.from({ length: 20 }, (_, i) => 130 + (i % 4)), { color: '#f00' }),
  ]);

  it('stacks the bands without overlap and ends at the axis', () => {
    const l = distributionLayout(300, twoSides);
    expect(l.height).toBe(distributionHeight(2, true));
    expect(l.bandY1).toBeGreaterThan(l.bandY0);
    expect(l.rows).toHaveLength(2);
    expect(l.rows[0].y0).toBeGreaterThanOrEqual(l.bandY1);
    expect(l.rows[1].y0).toBe(l.rows[0].y1);
    expect(l.axisY).toBe(l.rows[1].y1);
    expect(l.axisY).toBeLessThan(l.height);
  });

  it('keeps the strip rows where they are when the band is reserved', () => {
    const flat = buildDistribution([input([100, 101]), input([130, 131], { color: '#f00' })]);
    expect(flat.hasCurves).toBe(false);
    const withBand = distributionLayout(300, flat, true);
    // Identical geometry to a chart whose curves exist, so a hover between the
    // two can't move a single row.
    expect(withBand.height).toBe(distributionLayout(300, twoSides).height);
    expect(withBand.rows.map((r) => r.y0)).toEqual(
      distributionLayout(300, twoSides).rows.map((r) => r.y0),
    );
    expect(withBand.axisY).toBe(distributionLayout(300, twoSides).axisY);
  });

  it('maps the domain across the padded plot width', () => {
    const l = distributionLayout(300, twoSides);
    expect(l.xScale.toPixel(twoSides.domain.min)).toBeCloseTo(l.x0, 9);
    expect(l.xScale.toPixel(twoSides.domain.max)).toBeCloseTo(l.x1, 9);
    expect(l.x0).toBeGreaterThan(0);
    expect(l.x1).toBeLessThan(300);
  });

  it('puts zero density on the band floor and the peak on its ceiling', () => {
    const l = distributionLayout(300, twoSides);
    expect(l.densityScale.toPixel(0)).toBeCloseTo(l.bandY1, 9);
    expect(l.densityScale.toPixel(twoSides.maxDensity)).toBeCloseTo(l.bandY0, 9);
  });

  it('collapses the band and keeps a usable scale when there are no curves', () => {
    const l = distributionLayout(300, buildDistribution([input([1, 2])]));
    expect(l.bandY1).toBe(l.bandY0);
    // maxDensity is 0 here; the scale must still return a finite pixel.
    expect(Number.isFinite(l.densityScale.toPixel(0))).toBe(true);
  });

  it('survives a zero width without inverting the plot area', () => {
    const l = distributionLayout(0, twoSides);
    expect(l.x1).toBeGreaterThan(l.x0);
  });
});
