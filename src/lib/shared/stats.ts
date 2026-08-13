// Pure statistics for comparing two pools of measurements.
//
// All of it runs client-side. Treeherder has a compare endpoint that computes
// most of this, but it takes two revisions and a framework — it can't express
// half the comparisons this app offers (two runs of one push, two series on one
// push), and it would put a network round-trip on the hover preview. See
// docs/comparison.md.
//
// The two sides are `base` and `next`. Which of the two clicked points becomes
// which is decided in compare.ts, and the labels the UI shows come from there
// too: this module never claims to know which side is "new".

// ---------------------------------------------------------------------------
// Sample summaries
// ---------------------------------------------------------------------------

export type PoolSummary = {
  count: number;
  mean: number;
  median: number;
  // Sample standard deviation (n − 1), which is what "how noisy is this" means
  // when the values are a sample of a noisy process rather than a population.
  stdDev: number;
  // Coefficient of variation, stdDev / |mean|. The comparable-across-metrics
  // noise number: 2 ms of spread means something different at 20 ms than at
  // 20 s. NaN-free: zero for a zero mean rather than Infinity.
  cv: number;
  min: number;
  max: number;
};

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

// A quantile by linear interpolation between order statistics — R's type 7, and
// numpy's default. `median(v)` and `quantile(v, 0.5)` agree by construction.
//
// The interpolation matters at the sizes this is used on: a quarter of 24 values
// falls between the 6th and 7th, and taking the nearer one would make a band edge
// jump by a whole order statistic as the window slides one push.
export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 1) return s[0];
  const pos = (s.length - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (pos - lo) * (s[hi] - s[lo]);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

// Null rather than a summary full of NaNs for an empty pool: callers have to
// handle "no values" anyway, and a null makes them do it at the top.
export function summarize(values: readonly number[]): PoolSummary | null {
  const n = values.length;
  if (n === 0) return null;
  const m = mean(values);
  let sq = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    sq += (v - m) * (v - m);
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const stdDev = n > 1 ? Math.sqrt(sq / (n - 1)) : 0;
  return {
    count: n,
    mean: m,
    median: median(values),
    stdDev,
    cv: m !== 0 ? stdDev / Math.abs(m) : 0,
    min,
    max,
  };
}

// ---------------------------------------------------------------------------
// Normal distribution
// ---------------------------------------------------------------------------

// Abramowitz & Stegun 7.1.26 — max absolute error 1.5e-7, which is four orders
// of magnitude finer than any p-value we display.
export function erf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const p =
    t *
    (0.254829592 +
      t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  return (x >= 0 ? 1 : -1) * (1 - p * Math.exp(-x * x));
}

export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

// ---------------------------------------------------------------------------
// Mann-Whitney U
// ---------------------------------------------------------------------------

// The conventional α. Reported alongside the p-value rather than instead of it:
// "not significant" on 5 values a side and on 300 are very different claims,
// and only the sample sizes distinguish them.
export const SIGNIFICANCE_ALPHA = 0.05;

// Below this many values on either side, the normal approximation the test uses
// is worth a caveat in the UI (`MannWhitneyResult.smallSample`).
export const SMALL_SAMPLE = 5;

// Romano et al.'s thresholds on |δ|, the ones PerfCompare's documentation
// describes, so a delta reads the same in both tools.
export type EffectSize = 'negligible' | 'small' | 'medium' | 'large';

export function cliffsInterpretation(delta: number): EffectSize {
  const d = Math.abs(delta);
  if (d < 0.147) return 'negligible';
  if (d < 0.33) return 'small';
  if (d < 0.474) return 'medium';
  return 'large';
}

export type MannWhitneyResult = {
  // U for `base` as the first sample: the number of (base, next) pairs where
  // the base value is larger, counting ties as a half.
  u: number;
  // Standardized U under the null, with a continuity correction.
  z: number;
  // Two-sided.
  pValue: number;
  significant: boolean;
  // (#base > next − #base < next) / (nBase · nNext). Negative means `next`
  // tends to be *higher*, matching PerfCompare's sign convention.
  cliffsDelta: number;
  effectSize: EffectSize;
  // P(a next value is below a base value) = U / (nBase · nNext). The same
  // quantity as δ, in the form someone can act on: "next is faster 78% of the
  // time". Exactly 0.5 means the two pools are interleaved.
  cles: number;
  nBase: number;
  nNext: number;
  // True when either side is small enough that the normal approximation is
  // shaky. The test still runs; the UI says so.
  smallSample: boolean;
  // True when every value in both pools is identical, so there is no ordering
  // information at all and the p-value is 1 by construction rather than by
  // evidence.
  degenerate: boolean;
};

// Two-sided Mann-Whitney U (Wilcoxon rank-sum), normal approximation with the
// standard tie correction and a continuity correction.
//
// Non-parametric on purpose: the replicate clouds this compares are routinely
// multi-modal (that's why we detect modes at all), and a t-test on a bimodal
// sample tests a mean that no measurement is near.
//
// Returns null when either side is empty. For tiny samples the approximation is
// conservative rather than wrong — it cannot reach p < 0.05 at 3-vs-3, which is
// correct, since the exact test can't either — but `smallSample` flags it.
export function mannWhitneyU(
  base: readonly number[],
  next: readonly number[],
): MannWhitneyResult | null {
  const nBase = base.length;
  const nNext = next.length;
  if (nBase === 0 || nNext === 0) return null;

  // Rank the pooled values, averaging ranks within each tie group, and total
  // the ranks that belong to `base`.
  const pooled: { value: number; isBase: boolean }[] = [];
  for (const v of base) pooled.push({ value: v, isBase: true });
  for (const v of next) pooled.push({ value: v, isBase: false });
  pooled.sort((a, b) => a.value - b.value);

  const total = pooled.length;
  let rankSumBase = 0;
  // Σ(t³ − t) over tie groups; zero when every value is distinct.
  let tieTerm = 0;
  let i = 0;
  while (i < total) {
    let j = i;
    while (j + 1 < total && pooled[j + 1].value === pooled[i].value) j++;
    const size = j - i + 1;
    // Mean of the 1-based ranks i+1 … j+1.
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (pooled[k].isBase) rankSumBase += avgRank;
    if (size > 1) tieTerm += size * size * size - size;
    i = j + 1;
  }

  const u = rankSumBase - (nBase * (nBase + 1)) / 2;
  const product = nBase * nNext;
  const cles = u / product;
  const cliffsDelta = 2 * cles - 1;

  const mu = product / 2;
  const variance =
    total > 1 ? (product / 12) * (total + 1 - tieTerm / (total * (total - 1))) : 0;
  const sigma = Math.sqrt(Math.max(0, variance));

  // A single tie group covering everything (all values equal) leaves no
  // variance: U is forced to mu and there is nothing to test.
  const degenerate = sigma === 0;
  let z = 0;
  if (!degenerate) {
    const diff = u - mu;
    // Continuity correction: pull |U − mu| half a step toward mu, since U is
    // discrete and the normal is not. Clamped at zero so a U within half a
    // step of mu gives z = 0 rather than a sign flip.
    const magnitude = Math.max(0, Math.abs(diff) - 0.5);
    z = (diff < 0 ? -magnitude : magnitude) / sigma;
  }
  const pValue = degenerate ? 1 : Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));

  return {
    u,
    z,
    pValue,
    significant: pValue < SIGNIFICANCE_ALPHA,
    cliffsDelta,
    effectSize: cliffsInterpretation(cliffsDelta),
    cles,
    nBase,
    nNext,
    smallSample: Math.min(nBase, nNext) < SMALL_SAMPLE,
    degenerate,
  };
}

// ---------------------------------------------------------------------------
// Reading a delta
// ---------------------------------------------------------------------------

// Relative change, as a fraction. Null when the baseline is zero: a percentage
// against zero is either infinite or undefined, and neither is worth printing.
export function relativeChange(baseValue: number, nextValue: number): number | null {
  if (baseValue === 0 || !Number.isFinite(baseValue)) return null;
  return (nextValue - baseValue) / baseValue;
}

// What a change means for the metric, which is never the sign of the delta
// alone — half of Perfherder's metrics are higher-is-better.
//
// `significant` gates it deliberately: a 0.4% median shift that the test can't
// distinguish from noise is not an improvement, and colouring it green would be
// the single most misleading thing this pane could do. Callers that want the
// raw direction have the delta.
export type ChangeDirection = 'improvement' | 'regression' | 'none';

export function changeDirection(
  baseValue: number,
  nextValue: number,
  lowerIsBetter: boolean,
  significant: boolean,
): ChangeDirection {
  if (!significant || baseValue === nextValue) return 'none';
  const wentUp = nextValue > baseValue;
  return wentUp === lowerIsBetter ? 'regression' : 'improvement';
}
