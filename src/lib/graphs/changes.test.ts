import { describe, expect, it } from 'vitest';
import { detectChanges, relocateBoundary, segmentValues } from './changes';
import type { PushGroup } from './graphData';

// Only `mean`, `x` and `pushId` are read; the rest is filled so the fixtures
// are real `PushGroup`s and a field added to that type shows up here.
function pushesOf(values: readonly number[]): PushGroup[] {
  return values.map((mean, i) => ({
    pushId: 1000 + i,
    revision: `rev${i}`,
    x: 10_000 + i * 100,
    runs: [],
    mean,
    xRoom: Infinity,
  }));
}

// A tiny LCG, so "noise" means the same thing on every run. Random noise in a
// test that asserts *how many* segments were found is a flake generator.
function noisy(level: number, count: number, amplitude: number): number[] {
  let seed = 12345;
  return Array.from({ length: count }, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return level + ((seed / 0x7fffffff) * 2 - 1) * amplitude;
  });
}

function step(before: number, after: number, each = 20, amplitude = 1): number[] {
  return [...noisy(before, each, amplitude), ...noisy(after, each, amplitude)];
}

describe('segmentValues', () => {
  it('leaves a series with no step in one segment', () => {
    expect(segmentValues(noisy(100, 40, 2))).toEqual([0, 40]);
  });

  it('finds a clean step', () => {
    expect(segmentValues(step(100, 110))).toEqual([0, 20, 40]);
  });

  it('finds two steps', () => {
    const values = [...noisy(100, 20, 1), ...noisy(115, 20, 1), ...noisy(103, 20, 1)];
    expect(segmentValues(values)).toEqual([0, 20, 40, 60]);
  });

  it('never emits a segment of one point', () => {
    // MIN_SEGMENT is 2 because a single value has no sample variance, so it
    // scores at the floor and buys an unbounded discount — one outlier could
    // otherwise pay for a segment of its own out of nothing.
    //
    // It does *not* stop an outlier from being segmented off into a short
    // segment, and this fixture is one that is: what stops that reaching the
    // graph is the confirmation stage, which is asserted under `detectChanges`.
    const values = noisy(100, 21, 1);
    values[10] = 200;
    const boundaries = segmentValues(values);
    for (let i = 1; i < boundaries.length; i++) {
      expect(boundaries[i] - boundaries[i - 1]).toBeGreaterThanOrEqual(2);
    }
  });

  it('is stable against a large offset', () => {
    // `Σx² − (Σx)²/n` on uncentred values this size loses every significant
    // digit of a variance of 1, which used to make the costs noise.
    const values = step(1_000_000, 1_000_100);
    expect(segmentValues(values)).toEqual([0, 20, 40]);
  });

  it('returns one segment for a series too short to split', () => {
    expect(segmentValues([])).toEqual([0, 0]);
    expect(segmentValues([1, 2, 3])).toEqual([0, 3]);
  });

  it('always returns strictly increasing boundaries from 0 to n', () => {
    // Gridding appends the grid edge as a candidate; a bug there would produce
    // a duplicate or an out-of-order boundary that nothing else would catch.
    const values = [...noisy(100, 300, 3), ...noisy(120, 300, 3)];
    const boundaries = segmentValues(values, 250);
    expect(boundaries[0]).toBe(0);
    expect(boundaries.at(-1)).toBe(600);
    for (let i = 1; i < boundaries.length; i++) {
      expect(boundaries[i]).toBeGreaterThan(boundaries[i - 1]);
    }
  });
});

describe('relocateBoundary', () => {
  // The shape that motivates relocation, from autoland signature 299010 on
  // 2026-07-23 and scaled: a flat level, one push whose mean a single bad job
  // dragged below *both* levels, seven more pushes still at the old level, then
  // the real step. The segmentation's boundary lands on the bad push, because
  // holding it out of the pre-step segment is worth more in variance than
  // putting it in the post-step one costs — that segment spanning the real step
  // either way.
  function outlierBeforeStep(): number[] {
    const values = [...noisy(100, 32, 0.5), ...noisy(96, 16, 0.5)];
    values[24] = 92.5;
    return values;
  }

  it('moves a boundary sitting on an outlier onto the step', () => {
    // Rank separation peaks at the step (index 32), not at the outlier the
    // variance cost preferred (24). Re-minimising that cost inside the window
    // would pick 24 all over again — the point of using a rank statistic is that
    // it counts one value out of place, not how far out of place it is.
    expect(relocateBoundary(outlierBeforeStep(), 0, 48, 24)).toBe(32);
  });

  it('leaves a boundary that is already the best split alone', () => {
    const clean = step(100, 110, 24);
    expect(relocateBoundary(clean, 0, 48, 24)).toBe(24);
  });

  it('never lands within six pushes of the window edge', () => {
    // The same floor the test itself observes: an estimate resting on fewer
    // pushes than MIN_WINDOW_PUSHES would be one the confirmation stage would
    // have refused to make, and the notch has to stay inside its own bar.
    const late = [...noisy(100, 45, 0.5), ...noisy(130, 3, 0.5)];
    expect(relocateBoundary(late, 0, 48, 24)).toBeLessThanOrEqual(42);
  });
});

describe('detectChanges', () => {
  it('finds a clean step and describes it', () => {
    const found = detectChanges(pushesOf(step(100, 110)), true);
    expect(found).toHaveLength(1);
    const change = found[0];
    expect(change.index).toBe(20);
    expect(change.beforeValue).toBeCloseTo(100, 0);
    expect(change.afterValue).toBeCloseTo(110, 0);
    expect(change.relativeChange).toBeCloseTo(0.1, 2);
    expect(change.isRegression).toBe(true);
    expect(change.pValue).toBeLessThan(0.05);
    expect(change.effectSize).toBe('large');
  });

  it('reads the direction off the metric, never off the sign', () => {
    // Half of perfherder's metrics are higher-is-better, so the same step is a
    // regression on one series and an improvement on the next.
    const up = pushesOf(step(100, 110));
    expect(detectChanges(up, true)[0].isRegression).toBe(true);
    expect(detectChanges(up, false)[0].isRegression).toBe(false);
    const down = pushesOf(step(110, 100));
    expect(detectChanges(down, true)[0].isRegression).toBe(false);
    expect(detectChanges(down, false)[0].isRegression).toBe(true);
  });

  it('names the two pushes either side of the step', () => {
    // What a click on the bar pins as a comparison.
    const found = detectChanges(pushesOf(step(100, 110)), true);
    expect(found[0].beforePushId).toBe(1019);
    expect(found[0].afterPushId).toBe(1020);
    // …and the notch sits between their two timestamps.
    expect(found[0].changeX).toBe((10_000 + 19 * 100 + (10_000 + 20 * 100)) / 2);
  });

  it('spans the pushes it compared', () => {
    const found = detectChanges(pushesOf(step(100, 110)), true);
    const change = found[0];
    expect(change.windowStart).toBe(0);
    expect(change.windowEnd).toBe(40);
    expect(change.beforeCount).toBe(20);
    expect(change.afterCount).toBe(20);
    expect(change.x0).toBe(10_000);
    expect(change.x1).toBe(10_000 + 39 * 100);
  });

  it('caps the window at 24 pushes a side', () => {
    // Matching perfherder's own alert window, so the two "before → after" pairs
    // the details pane can show at once are on the same scale.
    const found = detectChanges(pushesOf(step(100, 110, 60)), true);
    expect(found).toHaveLength(1);
    expect(found[0].beforeCount).toBe(24);
    expect(found[0].afterCount).toBe(24);
    expect(found[0].windowStart).toBe(36);
    expect(found[0].windowEnd).toBe(84);
  });

  it('finds nothing in noise', () => {
    expect(detectChanges(pushesOf(noisy(100, 60, 4)), true)).toEqual([]);
  });

  it('finds nothing around a single outlier', () => {
    const values = noisy(100, 41, 1);
    values[20] = 260;
    expect(detectChanges(pushesOf(values), true)).toEqual([]);
  });

  it('drops a step too small to be worth a mark', () => {
    // 0.2%, well inside MIN_RELATIVE_CHANGE. With this little noise the test
    // can see it perfectly well; it is just not something to draw on a graph.
    const found = detectChanges(pushesOf(step(100, 100.2, 20, 0.01)), true);
    expect(found).toEqual([]);
  });

  it('keeps a step perfherder would not have alerted on', () => {
    // The case that motivates the whole feature (graphs-todo.md, "Common
    // alerts"): +2.0% on macOS where Windows moved +9.9% and only Windows got
    // an alert. Well under perfherder's threshold, well over ours.
    const found = detectChanges(pushesOf(step(100, 102, 20, 0.5)), true);
    expect(found).toHaveLength(1);
    expect(found[0].relativeChange).toBeCloseTo(0.02, 3);
  });

  it('needs six pushes either side before it will say anything', () => {
    // Not a limitation to hide: a rank statistic on small pools has a floor on
    // the p-value it can reach however cleanly they separate, and below six a
    // side that floor is above CHANGE_ALPHA. A verdict there would come from
    // arithmetic rather than from evidence. These two fixtures are perfectly
    // separated, so only the pool sizes decide.
    const short = [...noisy(100, 5, 0.5), ...noisy(130, 10, 0.5)];
    expect(detectChanges(pushesOf(short), true)).toEqual([]);
    const enough = [...noisy(100, 6, 0.5), ...noisy(130, 10, 0.5)];
    expect(detectChanges(pushesOf(enough), true)).toHaveLength(1);
  });

  it('does not manufacture a change at a grid edge', () => {
    // It did, before grid edges stopped being candidates: on this shape the
    // edge at 500 produced a fourth "change" of −1.0% at p = 0.028 out of the
    // noise between two real steps. See GRID_SIZE.
    let level = 100;
    const values: number[] = [];
    for (let i = 0; i < 4; i++) {
      values.push(...noisy(level, 225, 3));
      level *= 1.05;
    }
    const found = detectChanges(pushesOf(values), true);
    expect(found.map((c) => c.index)).toEqual([225, 450, 675]);
  });

  it('finds both of two steps', () => {
    const values = [...noisy(100, 20, 1), ...noisy(115, 20, 1), ...noisy(103, 20, 1)];
    const found = detectChanges(pushesOf(values), true);
    expect(found.map((c) => c.index)).toEqual([20, 40]);
    expect(found.map((c) => c.isRegression)).toEqual([true, false]);
    // Neither window crosses the other change: the second step's "before" pool
    // must not reach back past the first one.
    expect(found[0].windowEnd).toBeLessThanOrEqual(40);
    expect(found[1].windowStart).toBeGreaterThanOrEqual(20);
  });

  it('says nothing about a series with almost no pushes', () => {
    expect(detectChanges(pushesOf([]), true)).toEqual([]);
    expect(detectChanges(pushesOf([1, 2, 3, 4, 5]), true)).toEqual([]);
  });
});
