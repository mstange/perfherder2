import { describe, expect, it } from 'vitest';
import {
  areaFracs,
  argrelmax,
  assignLetters,
  computeModeInfo,
  fitModesFromKde,
  gaussianKde,
  gaussianSupport,
  linearGrid,
  quantileSorted,
  silvermanBandwidth,
} from './kde';

// A reproducible normal-ish sample: Box-Muller on a seeded LCG, so the mode
// tests below assert on fixed data rather than on whatever Math.random gives.
function sample(n: number, mean: number, sd: number, seed = 1): number[] {
  let s = seed >>> 0;
  const rand = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 8) / 0x1000000;
  };
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const u = Math.max(1e-12, rand());
    const v = rand();
    out.push(mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
  }
  return out;
}

function trapezoid(x: readonly number[], y: readonly number[]): number {
  let total = 0;
  for (let i = 1; i < x.length; i++) total += 0.5 * (y[i] + y[i - 1]) * (x[i] - x[i - 1]);
  return total;
}

describe('quantileSorted', () => {
  it('interpolates linearly between order statistics', () => {
    const s = [1, 2, 3, 4];
    expect(quantileSorted(s, 0)).toBe(1);
    expect(quantileSorted(s, 1)).toBe(4);
    // pos = 3 * 0.5 = 1.5 → halfway between 2 and 3.
    expect(quantileSorted(s, 0.5)).toBeCloseTo(2.5, 12);
    expect(quantileSorted(s, 0.25)).toBeCloseTo(1.75, 12);
  });

  it('handles a single value', () => {
    expect(quantileSorted([7], 0.5)).toBe(7);
  });
});

describe('silvermanBandwidth', () => {
  it('follows 0.9 * min(sd, IQR/1.34) * n^(-1/5)', () => {
    const values = [1, 2, 3, 4, 5];
    // sd (population) = sqrt(2) ≈ 1.4142; IQR = 2, /1.34 ≈ 1.4925.
    const expected = 0.9 * Math.sqrt(2) * Math.pow(5, -1 / 5);
    expect(silvermanBandwidth(values)).toBeCloseTo(expected, 12);
  });

  it('is robust to a single outlier', () => {
    const tight = [10, 10.1, 9.9, 10.2, 9.8];
    const withOutlier = [...tight, 400];
    // The outlier multiplies the standard deviation but not the IQR, and the
    // rule takes the smaller of the two.
    expect(silvermanBandwidth(withOutlier)).toBeLessThan(1);
  });

  it('returns a positive bandwidth for a degenerate sample', () => {
    expect(silvermanBandwidth([5, 5, 5, 5])).toBeGreaterThan(0);
    expect(silvermanBandwidth([0, 0, 0])).toBeGreaterThan(0);
    expect(silvermanBandwidth([42])).toBeGreaterThan(0);
    expect(silvermanBandwidth([])).toBeGreaterThan(0);
  });

  it('narrows as the sample grows', () => {
    const wide = silvermanBandwidth(sample(20, 100, 5));
    const narrow = silvermanBandwidth(sample(2000, 100, 5));
    expect(narrow).toBeLessThan(wide);
  });
});

describe('gaussianSupport', () => {
  it('lands where the kernel has decayed to atol', () => {
    for (const bw of [0.5, 1, 7, 250]) {
      const x = gaussianSupport(bw, 1e-4);
      const density = Math.exp(-(x * x) / (2 * bw * bw)) / (Math.sqrt(2 * Math.PI) * bw);
      expect(density).toBeCloseTo(1e-4, 9);
    }
  });

  it('grows with the bandwidth', () => {
    expect(gaussianSupport(2)).toBeGreaterThan(gaussianSupport(1));
  });

  it('falls back to 3 sigma when the kernel peak is already below atol', () => {
    // atol * sqrt(2pi) * bw >= 1 needs a huge bandwidth for the default atol.
    expect(gaussianSupport(1e5)).toBeCloseTo(3e5, 6);
  });
});

describe('linearGrid', () => {
  it('spans the range inclusively', () => {
    const g = linearGrid(0, 10, 11);
    expect(g).toHaveLength(11);
    expect(g[0]).toBe(0);
    expect(g[10]).toBeCloseTo(10, 12);
  });

  it('gives a degenerate range some width', () => {
    const g = linearGrid(5, 5, 8);
    expect(g[0]).toBeLessThan(5);
    expect(g[7]).toBeGreaterThan(5);
  });
});

describe('gaussianKde', () => {
  it('integrates to one over a grid wide enough to hold the tails', () => {
    const values = sample(200, 100, 4);
    const bw = silvermanBandwidth(values);
    const pad = gaussianSupport(bw) * 2;
    const grid = linearGrid(Math.min(...values) - pad, Math.max(...values) + pad, 1024);
    expect(trapezoid(grid, gaussianKde(values, bw, grid))).toBeCloseTo(1, 3);
  });

  it('peaks at a lone sample value', () => {
    const grid = linearGrid(0, 20, 201);
    const y = gaussianKde([10], 1, grid);
    let arg = 0;
    for (let i = 1; i < y.length; i++) if (y[i] > y[arg]) arg = i;
    expect(grid[arg]).toBeCloseTo(10, 6);
  });

  it('matches a naive full sum', () => {
    const values = sample(50, 30, 3);
    const bw = 1.2;
    const grid = linearGrid(10, 50, 128);
    const naive = grid.map((x) => {
      let sum = 0;
      for (const v of values) sum += Math.exp(-((x - v) ** 2) / (2 * bw * bw));
      return sum / (values.length * bw * Math.sqrt(2 * Math.PI));
    });
    const got = gaussianKde(values, bw, grid);
    // The windowed sum drops kernel tails below `atol`, so agreement is to
    // that tolerance rather than exact.
    for (let i = 0; i < grid.length; i++) expect(got[i]).toBeCloseTo(naive[i], 4);
  });

  it('returns zeros rather than NaNs for an empty sample', () => {
    const grid = linearGrid(0, 10, 16);
    expect(gaussianKde([], 1, grid).every((v) => v === 0)).toBe(true);
    expect(gaussianKde([1, 2], 0, grid).every((v) => v === 0)).toBe(true);
  });
});

describe('argrelmax', () => {
  it('finds strict local maxima and excludes the ends', () => {
    expect(argrelmax([0, 2, 0, 3, 0], 1)).toEqual([1, 3]);
    // A maximum at index 0 or the last index is never reported.
    expect(argrelmax([5, 1, 1, 1, 5], 1)).toEqual([]);
  });

  it('a wider order suppresses close peaks', () => {
    const y = [0, 1, 0, 1, 0, 0, 0, 5, 0, 0, 0];
    expect(argrelmax(y, 1)).toEqual([1, 3, 7]);
    // With order 2, indices 1 and 3 each have a taller neighbour in range.
    expect(argrelmax(y, 2)).toEqual([7]);
  });
});

describe('areaFracs', () => {
  it('splits a flat curve by boundary position', () => {
    const x = linearGrid(0, 10, 101);
    const y = x.map(() => 1);
    const fracs = areaFracs(x, y, [4]);
    expect(fracs).toHaveLength(2);
    expect(fracs[0]).toBeCloseTo(0.4, 2);
    expect(fracs[1]).toBeCloseTo(0.6, 2);
    expect(fracs[0] + fracs[1]).toBeCloseTo(1, 12);
  });

  it('falls back to a uniform split when there is no area', () => {
    const x = linearGrid(0, 10, 11);
    expect(areaFracs(x, x.map(() => 0), [3, 6])).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });
});

describe('fitModesFromKde', () => {
  const curve = (values: number[]) => {
    const bw = silvermanBandwidth(values);
    const pad = gaussianSupport(bw);
    const x = linearGrid(Math.min(...values) - pad, Math.max(...values) + pad, 1024);
    return { x, y: gaussianKde(values, bw, x) };
  };

  it('finds one mode in a unimodal sample', () => {
    const { x, y } = curve(sample(200, 100, 5));
    const fit = fitModesFromKde(x, y, 0.75);
    expect(fit.peakLocs).toHaveLength(1);
    expect(fit.boundaries).toHaveLength(0);
    expect(fit.peakLocs[0]).toBeGreaterThan(90);
    expect(fit.peakLocs[0]).toBeLessThan(110);
  });

  it('separates two well-separated clusters', () => {
    const values = [...sample(120, 100, 3, 7), ...sample(120, 160, 3, 99)];
    const { x, y } = curve(values);
    const fit = fitModesFromKde(x, y, 0.75);
    expect(fit.peakLocs).toHaveLength(2);
    expect(fit.boundaries).toHaveLength(1);
    expect(fit.peakLocs[0]).toBeLessThan(fit.boundaries[0]);
    expect(fit.boundaries[0]).toBeLessThan(fit.peakLocs[1]);
  });

  it('a zero valley threshold never splits', () => {
    const values = [...sample(120, 100, 3, 7), ...sample(120, 160, 3, 99)];
    const { x, y } = curve(values);
    expect(fitModesFromKde(x, y, 0).peakLocs).toHaveLength(1);
  });

  it('falls back to the global maximum on a monotonic curve', () => {
    const x = linearGrid(0, 10, 64);
    const fit = fitModesFromKde(x, x.map((v) => v), 0.75);
    expect(fit.peakLocs).toEqual([x[x.length - 1]]);
    expect(fit.boundaries).toEqual([]);
  });

  it('reports nothing for an empty curve', () => {
    expect(fitModesFromKde([], [], 0.75)).toEqual({ peakLocs: [], boundaries: [] });
  });

  it('drops a mode holding too little of the area', () => {
    // 200 values around 100 plus a lone straggler far out: separated enough to
    // be its own peak, but the area filter (5%) rejects it.
    const values = [...sample(200, 100, 3, 11), 400];
    const { x, y } = curve(values);
    expect(fitModesFromKde(x, y, 0.9).peakLocs).toHaveLength(1);
  });
});

describe('assignLetters', () => {
  it('labels by ascending position but returns input order', () => {
    expect(assignLetters([160, 100, 130])).toEqual(['C', 'A', 'B']);
  });

  it('handles the empty and single cases', () => {
    expect(assignLetters([])).toEqual([]);
    expect(assignLetters([5])).toEqual(['A']);
  });
});

describe('computeModeInfo', () => {
  it('bundles fractions and letters that line up with the peaks', () => {
    const values = [...sample(200, 100, 3, 3), ...sample(100, 170, 3, 5)];
    const bw = silvermanBandwidth(values);
    const pad = gaussianSupport(bw);
    const x = linearGrid(Math.min(...values) - pad, Math.max(...values) + pad, 1024);
    const info = computeModeInfo(x, gaussianKde(values, bw, x), 0.75);
    expect(info.peakLocs).toHaveLength(2);
    expect(info.letters).toEqual(['A', 'B']);
    expect(info.fracs.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    // Twice as many samples in the lower cluster.
    expect(info.fracs[0]).toBeGreaterThan(info.fracs[1]);
  });

  it('returns the empty summary for an empty curve', () => {
    expect(computeModeInfo([], [], 0.75).peakLocs).toEqual([]);
  });
});
