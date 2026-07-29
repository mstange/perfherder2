import { describe, expect, it } from 'vitest';
import {
  changeDirection,
  cliffsInterpretation,
  erf,
  mannWhitneyU,
  mean,
  median,
  normalCdf,
  relativeChange,
  summarize,
} from './stats';

// U counted the way the definition reads — every (base, next) pair, ties as a
// half — rather than through the rank sum. The two agreeing is the whole reason
// to trust the rank-sum shortcut and its tie handling.
function bruteForceU(base: number[], next: number[]): number {
  let u = 0;
  for (const b of base) {
    for (const n of next) {
      if (b > n) u += 1;
      else if (b === n) u += 0.5;
    }
  }
  return u;
}

describe('median and mean', () => {
  it('averages the middle pair for an even count', () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([3, 1, 2])).toBe(2);
    expect(mean([1, 2, 3, 4])).toBe(2.5);
  });

  it('is NaN for an empty sample', () => {
    expect(median([])).toBeNaN();
    expect(mean([])).toBeNaN();
  });
});

describe('summarize', () => {
  it('reports the sample standard deviation and coefficient of variation', () => {
    const s = summarize([2, 4, 4, 4, 5, 5, 7, 9])!;
    expect(s.count).toBe(8);
    expect(s.mean).toBe(5);
    expect(s.median).toBe(4.5);
    // Population sd is 2; the n-1 version is sqrt(32/7).
    expect(s.stdDev).toBeCloseTo(Math.sqrt(32 / 7), 12);
    expect(s.cv).toBeCloseTo(Math.sqrt(32 / 7) / 5, 12);
    expect(s.min).toBe(2);
    expect(s.max).toBe(9);
  });

  it('gives a single value zero spread rather than NaN', () => {
    const s = summarize([12])!;
    expect(s.stdDev).toBe(0);
    expect(s.cv).toBe(0);
  });

  it('keeps cv finite when the mean is zero', () => {
    expect(summarize([-1, 1])!.cv).toBe(0);
  });

  it('is null for an empty pool', () => {
    expect(summarize([])).toBeNull();
  });
});

describe('normalCdf', () => {
  it('matches the standard normal at the usual landmarks', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1)).toBeCloseTo(0.8413447, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 6);
    expect(normalCdf(-2.5758293)).toBeCloseTo(0.005, 6);
  });

  it('erf is odd', () => {
    expect(erf(-0.7)).toBeCloseTo(-erf(0.7), 12);
  });
});

describe('mannWhitneyU', () => {
  it('agrees with a brute-force U, ties included', () => {
    const cases: [number[], number[]][] = [
      [[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]],
      [[1, 2, 2, 3, 3, 3], [2, 3, 3, 4, 5, 5]],
      [[5], [1, 2, 3]],
      [[10, 20, 30, 40], [10, 20, 30, 40]],
      [[3, 1, 4, 1, 5, 9, 2, 6], [2, 7, 1, 8, 2, 8]],
    ];
    for (const [base, next] of cases) {
      expect(mannWhitneyU(base, next)!.u).toBeCloseTo(bruteForceU(base, next), 12);
    }
  });

  it('reports a fully separated pair as significant with delta -1', () => {
    const r = mannWhitneyU([1, 2, 3, 4, 5], [6, 7, 8, 9, 10])!;
    expect(r.u).toBe(0);
    expect(r.z).toBeCloseTo(-2.506718, 5);
    expect(r.pValue).toBeCloseTo(0.0121858, 6);
    expect(r.significant).toBe(true);
    // Negative delta means `next` sits higher — PerfCompare's convention.
    expect(r.cliffsDelta).toBe(-1);
    expect(r.effectSize).toBe('large');
    expect(r.cles).toBe(0);
    expect(r.smallSample).toBe(false);
  });

  it('cannot reach significance at three values a side', () => {
    // The exact test's smallest two-sided p at 3-vs-3 is 0.1, so an
    // approximation that claimed 0.04 here would be actively wrong.
    const r = mannWhitneyU([1, 2, 3], [4, 5, 6])!;
    expect(r.pValue).toBeGreaterThan(0.05);
    expect(r.significant).toBe(false);
    expect(r.smallSample).toBe(true);
  });

  it('treats identical pools as no evidence at all', () => {
    const r = mannWhitneyU([7, 7, 7], [7, 7, 7, 7])!;
    expect(r.degenerate).toBe(true);
    expect(r.pValue).toBe(1);
    expect(r.z).toBe(0);
    expect(r.cliffsDelta).toBe(0);
    expect(r.cles).toBe(0.5);
    expect(r.significant).toBe(false);
  });

  it('is antisymmetric in its arguments', () => {
    const a = [4, 8, 15, 16, 23, 42];
    const b = [3, 9, 14, 20, 21, 30, 44];
    const forward = mannWhitneyU(a, b)!;
    const backward = mannWhitneyU(b, a)!;
    expect(backward.cliffsDelta).toBeCloseTo(-forward.cliffsDelta, 12);
    expect(backward.cles).toBeCloseTo(1 - forward.cles, 12);
    expect(backward.pValue).toBeCloseTo(forward.pValue, 12);
  });

  it('applies the tie correction, which sharpens rather than blunts', () => {
    // Same U (0) and same sizes; only the ties differ. The correction shrinks
    // the null variance, so the tied comparison is the more significant one.
    // The sign of that effect is easy to get backwards, so pin it.
    const untied = mannWhitneyU([1, 2, 3, 4, 5], [6, 7, 8, 9, 10])!;
    const tied = mannWhitneyU([1, 1, 1, 1, 1], [6, 7, 8, 9, 10])!;
    expect(tied.u).toBe(untied.u);
    expect(Math.abs(tied.z)).toBeGreaterThan(Math.abs(untied.z));
    expect(tied.pValue).toBeLessThan(untied.pValue);
  });

  it('is null when a side is empty', () => {
    expect(mannWhitneyU([], [1, 2])).toBeNull();
    expect(mannWhitneyU([1, 2], [])).toBeNull();
  });

  it('handles one value against one value', () => {
    const r = mannWhitneyU([10], [20])!;
    expect(r.u).toBe(0);
    expect(r.cliffsDelta).toBe(-1);
    // A single pair can never be significant.
    expect(r.significant).toBe(false);
  });
});

describe('cliffsInterpretation', () => {
  it('uses the Romano thresholds and ignores sign', () => {
    expect(cliffsInterpretation(0)).toBe('negligible');
    expect(cliffsInterpretation(-0.146)).toBe('negligible');
    expect(cliffsInterpretation(0.147)).toBe('small');
    expect(cliffsInterpretation(-0.33)).toBe('medium');
    expect(cliffsInterpretation(0.474)).toBe('large');
    expect(cliffsInterpretation(-1)).toBe('large');
  });
});

describe('relativeChange', () => {
  it('is a fraction of the baseline', () => {
    expect(relativeChange(100, 110)).toBeCloseTo(0.1, 12);
    expect(relativeChange(100, 90)).toBeCloseTo(-0.1, 12);
  });

  it('is null against a zero or non-finite baseline', () => {
    expect(relativeChange(0, 5)).toBeNull();
    expect(relativeChange(NaN, 5)).toBeNull();
  });
});

describe('changeDirection', () => {
  it('reads the sign through lowerIsBetter', () => {
    expect(changeDirection(100, 110, true, true)).toBe('regression');
    expect(changeDirection(100, 90, true, true)).toBe('improvement');
    expect(changeDirection(100, 110, false, true)).toBe('improvement');
    expect(changeDirection(100, 90, false, true)).toBe('regression');
  });

  it('is none without significance, whatever the delta', () => {
    expect(changeDirection(100, 200, true, false)).toBe('none');
    expect(changeDirection(100, 100, true, true)).toBe('none');
  });
});
