// The band: a rolling quartile summary of a series, for reading the shape of a
// drift off the plot. **Pure.**
//
// [drift.ts](drift.ts) states that the ends of the range differ and deliberately
// says nothing about the path between them. This is that path — the same
// statistic, the same window, evaluated everywhere instead of only at the two
// ends. Its first and last median are `buildDrift`'s two medians *by
// construction* (see `trendWindow`), so the badge is literally the endpoints of
// this curve and the two can't disagree.
//
// **Why quartiles rather than one smoothed line.** A moving average was the
// obvious thing and the data talked us out of it. Pooling 24 pushes at each end of
// a six-month window and running the mode analysis over three of the drifting
// idb-open signatures:
//
//   - 5350975, badge +45%: one mode at 623 ms became *two*, the fast one still at
//     641 ms and a new one at 917 ms taking 67% of the runs. The typical run never
//     got slower; a slow path started being taken. A single line here climbs
//     622 → 900 through the gap *between* the two modes — a value almost no
//     measurement ever took.
//   - 5350957, badge +10%: unimodal at both ends, and the peak moved less than the
//     KDE can resolve. The badge's 10% is mostly a growing upper tail.
//   - 5350963, badge +14%: unimodal, peak genuinely moved, but +6.1% of level
//     against a +14% badge — again half of it is the tail.
//
// In all three the story is the *distribution changing shape*, and one line per
// series cannot carry that. p25 and p75 can: a fanning band is a spread growing, a
// band whose floor holds while its ceiling climbs is a tail growing, and a band
// that slides rigidly is a real level change.
//
// **The median line is drawn but is the least trustworthy of the three**, and the
// band is what says so. All three curves are *quantiles of a mixture*, and a
// quantile of a mixture is not a level of anything — it is "where the k-th ranked
// push of these 24 sits", which coincides with a mode only while one mode holds a
// clear majority of the window.
//
// AWSY's Explicit Memory (signature 5141330) is the case that shows it. Its push
// means over Aug–Nov 2025 fall in at least four clusters — roughly 540, 558, 585
// and 612 MB, with sparse gaps between them — so as the mixture shifts over months
// the median hops from cluster to cluster, and where the window splits near 50/50 it
// lands in a *gap*, on a value few pushes ever took. Two consequences a reader has
// to be told about, both measured on that series:
//
//   - **It steps rather than glides.** One push entering the window moves this
//     median by up to 18.6 MB where a 24-push moving *mean* moves by at most 3.5 —
//     5× — and over ten pushes it swung 32.8 MB against the mean's 5.2. That is the
//     median being a rank statistic, not a bug and not smoothing gone wrong.
//   - **Its position tracks the mixture ratio, not a level.** A jump means the
//     majority of the window changed cluster, which is a real event and not the one
//     the reader will assume ("it got 30 MB slower") unless the band is read with it.
//
// Both read correctly *because* the band is wide: a wide band means "there is no
// typical value here", which is the truth about that series and something no single
// line can say about itself.

import { MIN_WINDOW_PUSHES, WINDOW_PUSHES } from './changes';
import type { PushGroup } from './graphData';
import { median, quantile } from '../shared/stats';

export type TrendPoint = {
  // The push this window is centred on — so the band has a vertex per push, like
  // the connecting line, rather than per pixel.
  x: number;
  p25: number;
  median: number;
  p75: number;
};

// Below this there is no band. The same floor `buildDrift` uses, and for the same
// reason: six pushes a side is the least the detector will say anything about a
// level from, and a quartile of three values is not a quartile.
const MIN_PUSHES = 2 * MIN_WINDOW_PUSHES;

// How many pushes one window holds. **The same rule `buildDrift` uses**, which is
// what makes the curve's ends equal the badge's two numbers at every range length
// rather than only past 48 pushes.
export function trendWindow(pushCount: number): number {
  return Math.min(WINDOW_PUSHES, Math.floor(pushCount / 2));
}

// Which vertices of a band fall in an x window: the ones inside it, plus one on
// each side, so the ribbon enters and leaves the plot instead of stopping short
// of its edges. Null when fewer than two vertices are in play, which is the one
// case nothing can be drawn from.
//
// **Here rather than in chartDraw, because two callers need the same answer.**
// The drawing asks it to place the ribbon; `extentOf` asks it to scale the y
// axis when the band is the only thing on the plot (see `AppState.pointMode`).
// If those two disagreed about which vertices are in play, the axis would be
// scaled to a stretch of band that isn't painted.
export function trendSpan(
  trend: readonly TrendPoint[],
  xMin: number,
  xMax: number,
): [number, number] | null {
  if (trend.length < 2) return null;
  let lo = 0;
  while (lo + 1 < trend.length && trend[lo + 1].x < xMin) lo++;
  let hi = trend.length - 1;
  while (hi > lo + 1 && trend[hi - 1].x > xMax) hi--;
  return hi > lo ? [lo, hi] : null;
}

// The band's vertical extent over an x window: the floor of its p25 and the
// ceiling of its p75, over exactly the vertices `trendSpan` says are drawn.
// Null when there is no band to measure.
export function trendExtent(
  trend: readonly TrendPoint[],
  xMin: number,
  xMax: number,
): { min: number; max: number } | null {
  const span = trendSpan(trend, xMin, xMax);
  if (!span) return null;
  const [lo, hi] = span;
  let min = Infinity;
  let max = -Infinity;
  for (let i = lo; i <= hi; i++) {
    if (trend[i].p25 < min) min = trend[i].p25;
    if (trend[i].p75 > max) max = trend[i].p75;
  }
  return { min, max };
}

// One point per push, each summarising the window centred on it.
//
// **Centred, not trailing.** A trailing window is the cheaper thing and every
// moving average does it, but it lags by half a window: on a series with a real
// step the curve's kink would sit twelve pushes to the right of the change bar
// marking the same event, and two marks disagreeing about where something happened
// is worse than one mark fewer.
//
// **Clamped at the ends rather than shortened.** The first and last windows slide
// inward instead of shrinking, so every point summarises the same number of
// pushes and the ends are not noisier than the middle — and the first and last
// windows are then exactly `buildDrift`'s two.
export function rollingTrend(pushes: readonly PushGroup[]): TrendPoint[] {
  const n = pushes.length;
  if (n < MIN_PUSHES) return [];
  const w = trendWindow(n);
  const half = Math.floor(w / 2);
  const out: TrendPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const start = Math.min(Math.max(0, i - half), n - w);
    const values: number[] = new Array(w);
    for (let k = 0; k < w; k++) values[k] = pushes[start + k].mean;
    out[i] = {
      x: pushes[i].x,
      p25: quantile(values, 0.25),
      median: median(values),
      p75: quantile(values, 0.75),
    };
  }
  return out;
}
