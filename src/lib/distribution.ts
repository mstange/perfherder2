// The model behind the details pane's distribution chart: one or two pools of
// measurements turned into density curves, detected modes, and a jittered strip
// of the raw values. Pure — the canvas painting is in distributionDraw.ts and
// the pixels are DistributionChart.svelte's.
//
// Which values end up in a pool, and what the sides are called, is compare.ts's
// job (see docs/comparison.md). This module only knows it has one or two lists
// of numbers to describe on a shared axis.

import { makeScale, type Range, type Scale } from './chart';
import {
  computeModeInfo,
  EMPTY_MODE_INFO,
  gaussianKde,
  gaussianSupport,
  linearGrid,
  silvermanBandwidth,
  type ModeInfo,
} from './kde';
import { summarize, type PoolSummary } from './stats';

// Grid resolution for every curve. 256 is enough to place a mode to within a
// pixel at pane width, and — unlike PerfCompare's 1024 — doesn't need to be a
// power of two, since nothing here runs an FFT.
export const GRID_POINTS = 256;

// PerfCompare's default valley-depth threshold, deliberately matched: the same
// pool should yield the same modes in both tools. Fixed rather than exposed as
// a control — a knob that changes how many modes are "detected" invites turning
// it until the answer is the desired one.
export const VALLEY_THRESHOLD = 0.5;

// Fewer values than this and the pool gets a strip but no curve. A density
// estimated from two or three points is a picture of the bandwidth rule, not of
// the data, and drawing one implies a confidence the sample can't support.
export const MIN_CURVE_VALUES = 4;

export type DistributionInput = {
  // Shown in the chart's legend and the mode list.
  label: string;
  color: string;
  values: readonly number[];
  // Index into `values` of the point the user actually clicked, or -1 when the
  // pool has no distinguished member. The strip rings it, which is what
  // connects the chart back to the dot on the time-series graph.
  markedIndex: number;
};

// One raw value on the strip: its position on the value axis, plus where in the
// strip's band it sits.
export type StripDot = {
  value: number;
  // In [-1, 1]. Deterministic (see `jitterAt`), so a re-render can't reshuffle
  // the strip.
  jitter: number;
  marked: boolean;
};

export type DistributionSeries = {
  label: string;
  color: string;
  values: readonly number[];
  bandwidth: number;
  // Density at each point of the plot's shared grid. Empty when the pool is
  // below MIN_CURVE_VALUES.
  density: number[];
  modes: ModeInfo;
  summary: PoolSummary | null;
  strip: StripDot[];
};

export type DistributionPlot = {
  // The shared value axis. Both sides are drawn against it — two curves on
  // separate domains can't be compared by eye, which is the entire point.
  domain: Range;
  grid: number[];
  series: DistributionSeries[];
  // Peak density across every side, for the density band's y scale. Shared, so
  // a tighter distribution legitimately draws taller: both curves integrate to
  // 1, so height is spread, in comparable units.
  maxDensity: number;
  // False when nothing has a curve, so the chart can give the strip the whole
  // height instead of reserving space for an empty band.
  hasCurves: boolean;
};

// Deterministic jitter in [-1, 1] from a value's index and its side.
//
// Not `Math.random()`. A Svelte `$derived` re-runs whenever anything it reads
// changes, and random jitter would make every dot in the strip jump when an
// unrelated part of the state moved. (PerfCompare hit the same thing from the
// other direction — its jitter visibly re-rolled while dragging the
// valley-depth slider — and fixed it by hoisting the roll into a `useMemo`.)
//
// The mix is the finaliser from MurmurHash3, which decorrelates neighbouring
// indices well enough that consecutive equal values don't stack up.
export function jitterAt(index: number, side: number): number {
  let h = (index * 0x9e3779b1 + side * 0x85ebca6b) | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x21f0aaad);
  h ^= h >>> 15;
  h = Math.imul(h, 0x735a2d97);
  h ^= h >>> 15;
  return ((h >>> 0) / 0x100000000) * 2 - 1;
}

export function buildDistribution(inputs: readonly DistributionInput[]): DistributionPlot {
  const bandwidths = inputs.map((input) => silvermanBandwidth(input.values));

  // Each side's own [min − support, max + support]: padded by *its* bandwidth,
  // so every curve has room to taper to ~0 inside the domain rather than being
  // cut off mid-slope. A cliff at the edge of the plot reads as a mode boundary
  // that isn't there.
  let lo = Infinity;
  let hi = -Infinity;
  let allNonNegative = true;
  inputs.forEach((input, i) => {
    if (input.values.length === 0) return;
    const pad = gaussianSupport(bandwidths[i]);
    for (const v of input.values) {
      if (v - pad < lo) lo = v - pad;
      if (v + pad > hi) hi = v + pad;
      if (v < 0) allNonNegative = false;
    }
  });
  // Perf metrics don't go negative, and an axis that runs to -8 ms because the
  // kernel is wider than the values are large is worse than a curve clipped at
  // zero — which is where the true density stops anyway.
  if (allNonNegative && lo < 0) lo = 0;
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }

  const grid = linearGrid(lo, hi, GRID_POINTS);
  const domain: Range = { min: grid[0], max: grid[grid.length - 1] };

  let maxDensity = 0;
  const series = inputs.map((input, side): DistributionSeries => {
    const enoughForCurve = input.values.length >= MIN_CURVE_VALUES;
    const density = enoughForCurve ? gaussianKde(input.values, bandwidths[side], grid) : [];
    for (const d of density) if (d > maxDensity) maxDensity = d;
    return {
      label: input.label,
      color: input.color,
      values: input.values,
      bandwidth: bandwidths[side],
      density,
      modes: enoughForCurve ? computeModeInfo(grid, density, VALLEY_THRESHOLD) : EMPTY_MODE_INFO,
      summary: summarize(input.values),
      strip: input.values.map((value, i) => ({
        value,
        jitter: jitterAt(i, side),
        marked: i === input.markedIndex,
      })),
    };
  });

  return {
    domain,
    grid,
    series,
    maxDensity,
    hasCurves: series.some((s) => s.density.length > 0),
  };
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
//
// Pure geometry, so the component only has to own a canvas and its width. Two
// stacked bands over one shared value axis: densities on top, one strip row per
// side below, tick labels at the bottom.

// Room for the outermost tick label to sit under its tick without being clipped,
// and for the axis labels below the last strip row.
export const DISTRIBUTION_PAD = { left: 18, right: 18, top: 6, bottom: 15 };
export const DENSITY_HEIGHT = 68;
export const BAND_GAP = 5;
export const STRIP_ROW_HEIGHT = 20;

// The chart is as tall as its content needs and no taller. This *is* a height
// that changes with the data — a pool too small for a density loses the band —
// but only when the selection changes, which redraws the whole pane anyway. The
// alternative is a labelled empty box in every narrow-pool case.
export function distributionHeight(sideCount: number, hasCurves: boolean): number {
  const bands = hasCurves ? DENSITY_HEIGHT + BAND_GAP : 0;
  return (
    DISTRIBUTION_PAD.top +
    bands +
    Math.max(1, sideCount) * STRIP_ROW_HEIGHT +
    DISTRIBUTION_PAD.bottom
  );
}

export type StripRow = { y0: number; y1: number; centerY: number };

export type DistributionLayout = {
  width: number;
  height: number;
  // Plot area horizontally; every band shares it, so a value is at the same x
  // in the curve and in the strip below it.
  x0: number;
  x1: number;
  // Density band. Zero-height (y0 === y1) when no side has a curve.
  bandY0: number;
  bandY1: number;
  rows: StripRow[];
  // Where the value axis line and its labels go.
  axisY: number;
  xScale: Scale;
  // Density → pixels inside the band. Inverted, like the graphs' y scale.
  densityScale: Scale;
};

export function distributionLayout(
  width: number,
  plot: DistributionPlot,
): DistributionLayout {
  const pad = DISTRIBUTION_PAD;
  const sideCount = Math.max(1, plot.series.length);
  const height = distributionHeight(plot.series.length, plot.hasCurves);
  const x0 = pad.left;
  const x1 = Math.max(pad.left + 1, width - pad.right);
  const bandY0 = pad.top;
  const bandY1 = plot.hasCurves ? bandY0 + DENSITY_HEIGHT : bandY0;
  const rowsTop = plot.hasCurves ? bandY1 + BAND_GAP : bandY0;
  const rows: StripRow[] = [];
  for (let i = 0; i < sideCount; i++) {
    const y0 = rowsTop + i * STRIP_ROW_HEIGHT;
    const y1 = y0 + STRIP_ROW_HEIGHT;
    rows.push({ y0, y1, centerY: (y0 + y1) / 2 });
  }
  return {
    width,
    height,
    x0,
    x1,
    bandY0,
    bandY1,
    rows,
    axisY: rowsTop + sideCount * STRIP_ROW_HEIGHT,
    xScale: makeScale(plot.domain.min, plot.domain.max, x0, x1),
    // `maxDensity` of 0 (no curves) would divide by zero in makeScale; it
    // special-cases a zero-width domain, so the scale is still safe to build.
    densityScale: makeScale(0, plot.maxDensity, bandY1, bandY0),
  };
}
