// Kernel density estimation and mode detection — pure maths, no DOM.
//
// Ported from PerfCompare's `src/utils/kde.js` and `src/utils/kdeAnalysis.ts`
// (mozilla/perfcompare, MPL-2.0, same licence as this project), which is in
// turn a port of KDEpy (https://github.com/tommyod/KDEpy, BSD 3-Clause).
// The mode-detection half — `argrelmax`, `areaFracs`, `fitModesFromKde`,
// `assignLetters` — is faithful, so the same replicate pool yields the same
// modes in both tools.
//
// The estimation half is not. PerfCompare convolves a linearly-binned sample
// with a truncated Gaussian on a 1024-point grid via a hand-rolled FFT, and
// picks its bandwidth with the improved Sheather-Jones iteration, which lives
// on a DCT of the same binning. All of that exists to make large samples
// affordable. Our samples are one push's replicates — tens to a few hundred
// values — where the direct O(n · gridPoints) Gaussian sum below is under a
// millisecond and exact rather than binned. See docs/comparison.md for the
// crossover at which that stops being the right trade.
//
// References:
//   Silverman, B. W. (1986): Density Estimation for Statistics and Data
//     Analysis. Chapman and Hall.
//   Botev, Z. I., Grotowski, J. F. and Kroese, D. P. (2010): Kernel density
//     estimation via diffusion. Ann. Stat. 38(5), 2916-2957.

// ---------------------------------------------------------------------------
// Sample summaries the bandwidth rule needs
// ---------------------------------------------------------------------------

// Linear interpolation between order statistics — numpy.quantile's default
// method, so the bandwidth matches the Python-side reference implementations.
// `sorted` must be ascending and non-empty.
export function quantileSorted(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next === undefined ? sorted[base] : sorted[base] + rest * (next - sorted[base]);
}

// ---------------------------------------------------------------------------
// Bandwidth
// ---------------------------------------------------------------------------

// Silverman's rule of thumb in its robust form:
//
//   bw = 0.9 · min(σ, IQR / 1.34) · n^(-1/5)
//
// The `min` is what makes it robust: a single outlier inflates σ but barely
// moves the IQR, so the narrower of the two is the better scale estimate.
//
// This is PerfCompare's `approximateSJBandwidth`, which it uses for exactly
// our case — sparse, non-subtest pools, where it found the data-driven ISJ
// bandwidth over-fits. (KDEpy's own `silvermans_rule` is the normal-reference
// variant, ~6% wider; we take the robust form as-is, with no smoothing
// multiplier on top — see "No knobs" in docs/comparison.md.)
//
// The `0.001 · |mean|` fallback covers a degenerate sample whose σ and IQR are
// both zero — every value identical, which happens on integer-valued metrics —
// so callers always get a positive bandwidth and never a zero-width kernel.
export function silvermanBandwidth(values: readonly number[]): number {
  if (values.length === 0) return 1;
  if (values.length < 2) return Math.abs(values[0]) * 0.001 || 1;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const iqr = quantileSorted(sorted, 0.75) - quantileSorted(sorted, 0.25);
  let sum = 0;
  for (const v of sorted) sum += v;
  const mean = sum / n;
  let sq = 0;
  for (const v of sorted) sq += (v - mean) * (v - mean);
  const std = Math.sqrt(sq / n);
  const sigma = Math.min(std, iqr / 1.34);
  if (!(sigma > 0)) return Math.abs(mean) * 0.001 || 1;
  return 0.9 * sigma * Math.pow(n, -1 / 5);
}

// How far from its centre a Gaussian kernel still contributes more than `atol`,
// solved analytically from the PDF. Used as the grid's padding so the curve has
// room to taper to ~0 instead of being cut off mid-slope — an abrupt edge reads
// as a mode boundary that isn't there.
//
// When the bandwidth is so large that even the kernel's peak is below `atol`,
// there is no such x; fall back to 3σ, which still covers 99.7% of the kernel.
export function gaussianSupport(bandwidth: number, atol = 1e-4): number {
  const inner = atol * Math.sqrt(2 * Math.PI) * bandwidth;
  if (inner >= 1) return 3 * bandwidth;
  return bandwidth * Math.sqrt(-2 * Math.log(inner));
}

// ---------------------------------------------------------------------------
// Density estimation
// ---------------------------------------------------------------------------

// `count` evenly spaced values covering [lo, hi] inclusive. A degenerate
// [lo, lo] would otherwise produce a grid of identical x values, which makes
// every downstream trapezoid zero-width.
export function linearGrid(lo: number, hi: number, count: number): number[] {
  const n = Math.max(2, Math.floor(count));
  const span = hi > lo ? hi - lo : Math.abs(lo) * 0.02 || 1;
  const start = hi > lo ? lo : lo - span / 2;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) out[i] = start + (span * i) / (n - 1);
  return out;
}

// Gaussian KDE evaluated directly at every point of `grid`.
//
// Each sample contributes N(grid[j] − value, bandwidth²) / n. Summing over
// samples rather than binning-and-convolving costs n · grid multiplications,
// which at our pool sizes is cheaper than the FFT's setup — and avoids the
// binning approximation entirely, so a pool of 5 values gives 5 exact bumps
// instead of 5 bumps smeared over their neighbouring grid cells.
//
// Returns a zero curve for an empty sample rather than NaNs, so a caller that
// has no data yet renders a flat line instead of nothing.
export function gaussianKde(
  values: readonly number[],
  bandwidth: number,
  grid: readonly number[],
): number[] {
  const y = new Array<number>(grid.length).fill(0);
  const n = values.length;
  if (n === 0 || !(bandwidth > 0)) return y;
  const norm = 1 / (n * bandwidth * Math.sqrt(2 * Math.PI));
  const twoVar = 2 * bandwidth * bandwidth;
  // The kernel is negligible past its practical support; skipping the tail
  // turns the inner loop from "every sample" into "the nearby ones", which is
  // what keeps a 300-value pool on a 1024-point grid off the frame budget.
  const reach = gaussianSupport(bandwidth);
  const sorted = [...values].sort((a, b) => a - b);
  let lo = 0;
  let hi = 0;
  for (let j = 0; j < grid.length; j++) {
    const x = grid[j];
    // Both bounds only ever move forward: the grid is ascending, so the window
    // of in-reach samples slides rather than being re-found per grid point.
    while (lo < n && sorted[lo] < x - reach) lo++;
    if (hi < lo) hi = lo;
    while (hi < n && sorted[hi] <= x + reach) hi++;
    let sum = 0;
    for (let i = lo; i < hi; i++) {
      const d = x - sorted[i];
      sum += Math.exp((-d * d) / twoVar);
    }
    y[j] = sum * norm;
  }
  return y;
}

// ---------------------------------------------------------------------------
// Mode detection — ported from PerfCompare, thresholds and all
// ---------------------------------------------------------------------------

// Indices where `y` is strictly greater than every neighbour within `order`
// positions on each side. scipy.signal.argrelmax's semantics, including the
// exclusion of the `order` points at each end. A larger `order` suppresses
// narrow noise spikes at the cost of merging genuinely close peaks.
export function argrelmax(y: readonly number[], order = 1): number[] {
  const peaks: number[] = [];
  for (let i = order; i < y.length - order; i++) {
    let isMax = true;
    for (let j = 1; j <= order; j++) {
      if (y[i] <= y[i - j] || y[i] <= y[i + j]) {
        isMax = false;
        break;
      }
    }
    if (isMax) peaks.push(i);
  }
  return peaks;
}

// Fraction of the curve's total area in each bucket delimited by `boundaries`:
// bucket 0 is x ≤ boundaries[0], the last is x > the final boundary. Trapezoid
// rule over the grid. Falls back to a uniform split when the total area is
// zero, so callers never divide by it.
export function areaFracs(
  x: readonly number[],
  y: readonly number[],
  boundaries: readonly number[],
): number[] {
  const buckets = new Array<number>(boundaries.length + 1).fill(0);
  let total = 0;
  for (let i = 1; i < x.length; i++) {
    const area = 0.5 * (y[i] + y[i - 1]) * (x[i] - x[i - 1]);
    total += area;
    let m = 0;
    while (m < boundaries.length && x[i] > boundaries[m]) m++;
    buckets[m] += area;
  }
  return total > 0 ? buckets.map((b) => b / total) : buckets.map(() => 1 / buckets.length);
}

export type FittedModes = {
  // Peak x positions, ascending.
  peakLocs: number[];
  // The x of the deepest valley between consecutive peaks; one fewer than
  // `peakLocs`. These are what bucket raw samples by mode.
  boundaries: number[];
};

// Detect modes on an already-computed KDE curve.
//
// Split out from the estimation the way PerfCompare splits it, because the
// threshold is the interesting knob and re-fitting on a fixed curve is cheap:
// re-running the KDE to answer "and what if a shallower valley counted?" would
// make that a question you can't afford to ask.
//
// - `vt` — valley-depth threshold. Two adjacent peaks are separate modes only
//   if the lowest point between them dips below `vt ×` the shorter peak. 0
//   never splits, 1 always does.
// - `mpf` — minimum peak height, as a fraction of the tallest peak.
// - `mdf` — minimum share of the total area a mode must hold to be kept.
//
// Always returns at least one peak: a curve with no interior local maximum
// (monotonic, or a single spike at the very edge of the grid) still has a
// global maximum, and reporting "no modes" for it would be a lie.
export function fitModesFromKde(
  x: readonly number[],
  y: readonly number[],
  vt: number,
  mpf = 0.05,
  mdf = 0.05,
): FittedModes {
  if (x.length === 0 || y.length === 0) return { peakLocs: [], boundaries: [] };

  let yMax = 0;
  for (const v of y) if (v > yMax) yMax = v;
  const peaks = argrelmax(y, 3).filter((i) => y[i] >= mpf * yMax);
  const globalMax = (): FittedModes => {
    let gm = 0;
    for (let i = 1; i < y.length; i++) if (y[i] > y[gm]) gm = i;
    return { peakLocs: [x[gm]], boundaries: [] };
  };
  if (peaks.length === 0) return globalMax();

  // Valley-depth filter. Walk left to right; a peak either starts a new mode
  // or, if the valley before it is too shallow, merges into the running one —
  // taking its position if it is the taller of the two.
  const good = [peaks[0]];
  for (let k = 1; k < peaks.length; k++) {
    const next = peaks[k];
    const prev = good[good.length - 1];
    let valleyMin = y[prev];
    for (let j = prev; j <= next; j++) if (y[j] < valleyMin) valleyMin = y[j];
    if (valleyMin < vt * Math.min(y[prev], y[next])) good.push(next);
    else if (y[next] > y[prev]) good[good.length - 1] = next;
  }

  const boundariesFor = (ps: number[]): number[] => {
    const bs: number[] = [];
    for (let i = 0; i < ps.length - 1; i++) {
      let mi = ps[i];
      for (let j = ps[i]; j <= ps[i + 1]; j++) if (y[j] < y[mi]) mi = j;
      bs.push(x[mi]);
    }
    return bs;
  };
  const tallestOf = (ps: number[]): number => ps.reduce((a, b) => (y[a] > y[b] ? a : b));

  // Area filter: a mode that holds 2% of the density is a bump, not a mode.
  const fracs = areaFracs(x, y, boundariesFor(good));
  const kept = good.filter((_, i) => fracs[i] >= mdf);
  if (kept.length < 2) return { peakLocs: [x[tallestOf(good)]], boundaries: [] };

  const locs = kept.map((i) => x[i]);
  // Minimum-separation guard. KDE on near-integer data (a metric that only
  // ever reports 0 or 1) can put two "peaks" within a hair of each other;
  // reporting those as distinct modes is noise dressed up as structure.
  const minSep = Math.max(2, (x[x.length - 1] - x[0]) * 0.05);
  for (let k = 1; k < locs.length; k++) {
    if (locs[k] - locs[k - 1] < minSep) {
      return { peakLocs: [x[tallestOf(kept)]], boundaries: [] };
    }
  }
  return { peakLocs: locs, boundaries: boundariesFor(kept) };
}

// A, B, C … by ascending peak position, returned in the *input* order so
// `letters[i]` labels `locs[i]`. Ascending order means A is always the fastest
// path for a lower-is-better metric, which is the convention PerfCompare's
// mode blurbs use.
export function assignLetters(locs: readonly number[]): string[] {
  const order = locs.map((_, i) => i).sort((a, b) => locs[a] - locs[b]);
  const out = new Array<string>(locs.length);
  order.forEach((i, rank) => {
    out[i] = String.fromCharCode(65 + rank);
  });
  return out;
}

// One side's mode summary: where the peaks are, how the curve is partitioned
// between them, how much of the density each holds, and their labels.
export type ModeInfo = FittedModes & {
  // Share of the total area per mode; same length as `peakLocs`.
  fracs: number[];
  letters: string[];
};

export const EMPTY_MODE_INFO: ModeInfo = {
  peakLocs: [],
  boundaries: [],
  fracs: [],
  letters: [],
};

export function computeModeInfo(
  x: readonly number[],
  y: readonly number[],
  vt: number,
): ModeInfo {
  const fitted = fitModesFromKde(x, y, vt);
  if (fitted.peakLocs.length === 0) return EMPTY_MODE_INFO;
  return {
    ...fitted,
    fracs: areaFracs(x, y, fitted.boundaries),
    letters: assignLetters(fitted.peakLocs),
  };
}
