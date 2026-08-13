import { describe, expect, it } from 'vitest';
import { buildDrift } from './drift';
import type { PushGroup } from './graphData';
import { trendWindow, rollingTrend } from './trend';

const BASE_TIME = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;

function pushesOf(values: readonly number[]): PushGroup[] {
  return values.map((mean, i) => ({
    pushId: 1000 + i,
    revision: `rev${i}`,
    x: BASE_TIME + i * HOUR,
    runs: [],
    mean,
    xRoom: Infinity,
  }));
}

describe('rollingTrend', () => {
  it('gives one point per push, at the push', () => {
    const trend = rollingTrend(pushesOf(Array.from({ length: 60 }, (_, i) => i)));
    expect(trend).toHaveLength(60);
    expect(trend[0].x).toBe(BASE_TIME);
    expect(trend[59].x).toBe(BASE_TIME + 59 * HOUR);
  });

  it('ends where the drift badge says it does', () => {
    // The invariant the whole module hangs on: the curve's first and last medians
    // are the two numbers `buildDrift` reports, so the badge is the endpoints of
    // this line and neither can drift from the other.
    for (const n of [12, 13, 30, 47, 48, 60, 500]) {
      const values = Array.from({ length: n }, (_, i) => 100 + i * 0.7 + (i % 5));
      const pushes = pushesOf(values);
      const trend = rollingTrend(pushes);
      const drift = buildDrift(pushes)!;
      expect(trend[0].median).toBeCloseTo(drift.first.median, 9);
      expect(trend[trend.length - 1].median).toBeCloseTo(drift.last.median, 9);
    }
  });

  it('uses the same window rule the drift figure does', () => {
    expect(trendWindow(1000)).toBe(24);
    expect(trendWindow(48)).toBe(24);
    expect(trendWindow(30)).toBe(15);
    expect(trendWindow(13)).toBe(6);
  });

  it('says nothing at all below twelve pushes', () => {
    expect(rollingTrend(pushesOf(Array.from({ length: 11 }, () => 5)))).toEqual([]);
    expect(rollingTrend(pushesOf(Array.from({ length: 12 }, () => 5)))).toHaveLength(12);
  });

  it('keeps every window the same width, including at the ends', () => {
    // A shrinking end window would make the curve noisier exactly where a reader
    // looks for "where is it now".
    const flat = Array.from({ length: 60 }, () => 10);
    // One outlier in the first window. If the first point summarised 1 push it
    // would *be* the outlier; over 24 it barely moves the median.
    flat[0] = 1000;
    const trend = rollingTrend(pushesOf(flat));
    expect(trend[0].median).toBe(10);
    expect(trend[0].p75).toBe(10);
  });

  it('tracks a step as a step, centred on it rather than lagging', () => {
    // 30 flat, then 30 at a new level. A trailing window would put the crossing
    // twelve pushes late; centred, the median crosses the midpoint of the climb
    // within a push or two of the step itself.
    const trend = rollingTrend(
      pushesOf([...Array.from({ length: 30 }, () => 100), ...Array.from({ length: 30 }, () => 200)]),
    );
    const mid = trend.findIndex((p) => p.median >= 150);
    expect(mid).toBeGreaterThanOrEqual(28);
    expect(mid).toBeLessThanOrEqual(32);
  });

  it('opens the band when a second level appears, without moving its floor', () => {
    // 5350975's shape: a fast level that stays put while a slow one takes over.
    // The floor holds and the ceiling climbs — the thing a single line cannot say.
    const alternating = Array.from({ length: 60 }, (_, i) =>
      i < 24 ? 620 : i % 3 === 0 ? 620 : 900,
    );
    const trend = rollingTrend(pushesOf(alternating));
    const first = trend[0];
    const last = trend[trend.length - 1];
    expect(first.p75 - first.p25).toBe(0);
    expect(last.p75 - last.p25).toBeGreaterThan(200);
    expect(last.p25).toBeCloseTo(620, 0);
    expect(last.p75).toBeCloseTo(900, 0);
  });

  it('slides the whole band for a real level change', () => {
    // The contrast case: a rigid shift, where floor, median and ceiling all move
    // together. That is what "the level changed" looks like, against the above.
    const noisy = (level: number, count: number) =>
      Array.from({ length: count }, (_, i) => level + (i % 4) - 1.5);
    const trend = rollingTrend(pushesOf([...noisy(100, 30), ...noisy(130, 30)]));
    const first = trend[0];
    const last = trend[trend.length - 1];
    expect(last.p25 - first.p25).toBeCloseTo(30, 0);
    expect(last.median - first.median).toBeCloseTo(30, 0);
    expect(last.p75 - first.p75).toBeCloseTo(30, 0);
  });

  it('orders the three curves, always', () => {
    const values = Array.from({ length: 200 }, (_, i) => Math.sin(i) * 50 + i);
    for (const p of rollingTrend(pushesOf(values))) {
      expect(p.p25).toBeLessThanOrEqual(p.median);
      expect(p.median).toBeLessThanOrEqual(p.p75);
    }
  });
});
