import { describe, expect, it } from 'vitest';
import { candidateBoundaries, detectChanges, relocateBoundary } from './changes';
import { DEFAULT_ALERT_THRESHOLD, type AlertThreshold, type PushGroup } from './graphData';
import wandering from '../fixtures/push-means-wandering.json';

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

describe('candidateBoundaries', () => {
  const cuts = (values: readonly number[]) => candidateBoundaries(values).map((c) => c.cut);

  it('proposes nothing in a series with no step', () => {
    expect(cuts(noisy(100, 40, 2))).toEqual([]);
  });

  it('proposes a clean step', () => {
    expect(cuts(step(100, 110))).toEqual([20]);
  });

  it('proposes both of two steps', () => {
    const values = [...noisy(100, 20, 1), ...noisy(115, 20, 1), ...noisy(103, 20, 1)];
    expect(cuts(values)).toEqual([20, 40]);
  });

  it('proposes a small step standing next to a large one', () => {
    // What the dynamic program this replaced could not do, and the whole reason
    // for the recursion: the 30% step sets the scale for the series, and beside it
    // the 0.8% step is nothing. Scored inside its own half, once the big move has
    // been split off, it is obvious.
    const values = [...noisy(100, 40, 0.3), ...noisy(130, 40, 0.3), ...noisy(131, 40, 0.3)];
    expect(cuts(values)).toEqual([40, 80]);
  });

  it('scores each stretch against its own noise', () => {
    // Same 2% step twice, once in a quiet stretch and once in a loud one. Both are
    // proposed, and a scale taken over the whole series would have found neither
    // the quiet one (drowned) nor stopped at the loud one (over-split).
    const values = [
      ...noisy(100, 30, 0.2),
      ...noisy(102, 30, 0.2),
      ...noisy(102, 30, 2),
      ...noisy(104, 30, 2),
    ];
    const found = cuts(values);
    expect(found).toContain(30);
    expect(found.some((c) => Math.abs(c - 90) <= 2)).toBe(true);
  });

  it('is stable against a large offset', () => {
    const values = step(1_000_000, 1_000_100);
    expect(cuts(values)).toEqual([20]);
  });

  it('proposes nothing for a series too short to test', () => {
    expect(cuts([])).toEqual([]);
    expect(cuts([1, 2, 3])).toEqual([]);
    // Eleven is one short of two testable pools.
    expect(cuts([...noisy(100, 5, 0.1), ...noisy(130, 6, 0.1)])).toEqual([]);
  });

  it('proposes ascending, unique cuts, none within six of an end', () => {
    const values = [...noisy(100, 300, 3), ...noisy(120, 300, 3)];
    const found = cuts(values);
    expect(found).toEqual([...found].sort((a, b) => a - b));
    expect(new Set(found).size).toBe(found.length);
    for (const cut of found) {
      expect(cut).toBeGreaterThanOrEqual(6);
      expect(cut).toBeLessThanOrEqual(values.length - 6);
    }
  });

  it('does not recurse forever on a flat series', () => {
    expect(cuts(new Array(100).fill(7))).toEqual([]);
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

  it('lands only where the rank test could clear α', () => {
    // Looser than the gate's six a side, because the proposal stage cannot put a
    // cut closer than that to the end of a stretch and the step sometimes is. Three
    // pushes is where the arithmetic stops: 3 against 45 can reach p = 0.004 and 2
    // against 46 cannot reach α however cleanly it separates, so a step at 45 is
    // found exactly and one at 47 is reported as far out as the test can support.
    expect(relocateBoundary([...noisy(100, 45, 0.5), ...noisy(130, 3, 0.5)], 0, 48, 24)).toBe(45);
    expect(relocateBoundary([...noisy(100, 47, 0.5), ...noisy(130, 1, 0.5)], 0, 48, 24)).toBe(45);
    expect(relocateBoundary([...noisy(100, 3, 0.5), ...noisy(130, 45, 0.5)], 0, 48, 24)).toBe(3);
  });

  // Three pushes is where `canReachAlpha` stops, and bare Cliff's delta walks
  // straight to it: a pool that small separates perfectly on a run of ordinary
  // low values, and 1.000 beats a real step's 0.90. The standard-error penalty is
  // what keeps the estimate off the floor of the window. See `relocateBoundary`.
  function lowRunBeforeStep(): number[] {
    // A clean step at 24 that doesn't *quite* separate — the two levels overlap
    // by a value or two, so δ there is 0.90 rather than 1 — and three unremarkable
    // low pushes at the start of the window.
    const values = [...noisy(100, 24, 4), ...noisy(105, 24, 4)];
    values[0] = 92;
    values[1] = 91;
    values[2] = 92.5;
    return values;
  }

  it('does not fence off a run of low values into a tiny pool', () => {
    // Bare δ scores the 3-vs-45 split 1.000 against the step's 0.903 and reports
    // the change 21 pushes early. Both splits could clear α, so `canReachAlpha`
    // does not save it: 3 against 45 reaches p = 0.004.
    expect(relocateBoundary(lowRunBeforeStep(), 0, 48, 24)).toBe(24);
  });

  it('still prefers the smaller pool when it separates a lot better', () => {
    // The penalty is a charge, not a floor. A genuine step three pushes from the
    // window's edge separates perfectly where nothing else comes close, and pays
    // the 0.35 standard error of a 3-vs-45 split out of a margin bigger than that.
    expect(relocateBoundary([...noisy(100, 3, 0.5), ...noisy(130, 45, 0.5)], 0, 48, 24)).toBe(3);
  });
});

describe('detectChanges', () => {
  it('finds a clean step and describes it', () => {
    const found = detectChanges(pushesOf(step(100, 110)), true, DEFAULT_ALERT_THRESHOLD);
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
    expect(detectChanges(up, true, DEFAULT_ALERT_THRESHOLD)[0].isRegression).toBe(true);
    expect(detectChanges(up, false, DEFAULT_ALERT_THRESHOLD)[0].isRegression).toBe(false);
    const down = pushesOf(step(110, 100));
    expect(detectChanges(down, true, DEFAULT_ALERT_THRESHOLD)[0].isRegression).toBe(false);
    expect(detectChanges(down, false, DEFAULT_ALERT_THRESHOLD)[0].isRegression).toBe(true);
  });

  it('names the two pushes either side of the step', () => {
    // What a click on the bar pins as a comparison.
    const found = detectChanges(pushesOf(step(100, 110)), true, DEFAULT_ALERT_THRESHOLD);
    expect(found[0].beforePushId).toBe(1019);
    expect(found[0].afterPushId).toBe(1020);
    // …and the notch sits on the second of them, where the connecting line
    // kinks. Halfway between the two is the honester estimate and reads as a
    // misdrawn mark; see `changeX`.
    expect(found[0].changeX).toBe(10_000 + 20 * 100);
  });

  it('spans the pushes it compared', () => {
    const found = detectChanges(pushesOf(step(100, 110)), true, DEFAULT_ALERT_THRESHOLD);
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
    const found = detectChanges(pushesOf(step(100, 110, 60)), true, DEFAULT_ALERT_THRESHOLD);
    expect(found).toHaveLength(1);
    expect(found[0].beforeCount).toBe(24);
    expect(found[0].afterCount).toBe(24);
    expect(found[0].windowStart).toBe(36);
    expect(found[0].windowEnd).toBe(84);
  });

  it('is not silenced by an outlier segmented off next to the step', () => {
    // The segmentation fences the bad push at 40 into a segment of its own, four
    // pushes short of the real step at 45. Clipping each candidate's window at
    // its immediate neighbour left both of them with four or five pushes on one
    // side — under MIN_WINDOW_PUSHES, so neither could be tested at all, and a
    // step with thirty clean pushes either side of it went unmarked because
    // something twitched four pushes earlier. See `wallsAround`.
    const values = [...noisy(100, 45, 0.5), ...noisy(96, 30, 0.5)];
    values[40] = 92.5;
    expect(candidateBoundaries(values).map((c) => c.cut)).toContain(45);

    const found = detectChanges(pushesOf(values), true, DEFAULT_ALERT_THRESHOLD);
    expect(found).toHaveLength(1);
    expect(found[0].index).toBe(45);
    expect(found[0].relativeChange).toBeCloseTo(-0.04, 2);
  });

  it('marks a regression and its backout as two changes', () => {
    // What keeps the neighbourhood dedupe honest: these two steps are close
    // together and they are not the same step, and the only thing that says so is
    // that they point opposite ways.
    const values = [...noisy(100, 24, 0.5), ...noisy(104, 6, 0.5), ...noisy(100, 24, 0.5)];
    const found = detectChanges(pushesOf(values), true, DEFAULT_ALERT_THRESHOLD);
    expect(found.map((c) => c.index)).toEqual([24, 30]);
    expect(found.map((c) => c.isRegression)).toEqual([true, false]);
  });

  it('finds nothing in noise', () => {
    expect(detectChanges(pushesOf(noisy(100, 60, 4)), true, DEFAULT_ALERT_THRESHOLD)).toEqual([]);
  });

  it('finds nothing around a single outlier', () => {
    const values = noisy(100, 41, 1);
    values[20] = 260;
    expect(detectChanges(pushesOf(values), true, DEFAULT_ALERT_THRESHOLD)).toEqual([]);
  });

  it('drops a step too small to be worth a mark', () => {
    // 0.2%, a fifth of the floor perfherder's default 2% puts at 0.5%. With this
    // little noise the test can see it perfectly well; it is just not something to
    // draw on a graph.
    const found = detectChanges(pushesOf(step(100, 100.2, 20, 0.01)), true, DEFAULT_ALERT_THRESHOLD);
    expect(found).toEqual([]);
  });

  it('holds a series to a quarter of its own percentage threshold', () => {
    // awsy declares 0.25%, so a step of 0.2% is over its floor of 0.0625% and under
    // the 0.5% that perfherder's default would have set. The old fixed floor was
    // four times awsy's entire alerting bar.
    const awsy: AlertThreshold = { kind: 'percentage', value: 0.25 };
    const values = pushesOf(step(100, 100.2, 20, 0.01));
    expect(detectChanges(values, true, awsy)).toHaveLength(1);
    expect(detectChanges(values, true, DEFAULT_ALERT_THRESHOLD)).toEqual([]);
  });

  it('measures an absolute threshold in the metric’s own units', () => {
    // installer size: 100 KB, so a floor of 25600 bytes. Both steps here are far
    // below any percentage floor worth having — 0.014% and 0.004% of a 185 MB
    // binary — and one of them is a real 340 KB regression.
    const installer: AlertThreshold = { kind: 'absolute', value: 102400 };
    const real = pushesOf(step(185_000_000, 185_340_000, 20, 2000));
    const drift = pushesOf(step(185_000_000, 185_008_000, 20, 2000));
    const found = detectChanges(real, true, installer);
    expect(found).toHaveLength(1);
    expect(found[0].afterValue - found[0].beforeValue).toBeGreaterThan(25600);
    // Statistically just as clean, and 8 KB is not a step worth a mark.
    expect(detectChanges(drift, true, installer)).toEqual([]);
    // The percentage default drops both: 0.18% doesn't reach 0.5%, which is the
    // bug this replaced — every installer-size step is invisible to a percentage
    // floor calibrated for timings.
    expect(detectChanges(real, true, DEFAULT_ALERT_THRESHOLD)).toEqual([]);
  });

  it('keeps a step perfherder would not have alerted on', () => {
    // The case that motivates the whole feature (graphs-todo.md, "Common
    // alerts"): +2.0% on macOS where Windows moved +9.9% and only Windows got
    // an alert. Well under perfherder's threshold, well over ours.
    const found = detectChanges(pushesOf(step(100, 102, 20, 0.5)), true, DEFAULT_ALERT_THRESHOLD);
    expect(found).toHaveLength(1);
    expect(found[0].relativeChange).toBeCloseTo(0.02, 3);
  });

  it('says nothing when no split could clear α', () => {
    // Not a limitation to hide: a rank statistic on small pools has a floor on the
    // p-value it can reach however cleanly they separate, so a verdict there would
    // come from arithmetic rather than from evidence. These fixtures are perfectly
    // separated, so only the pool sizes decide — three pushes before the step is not
    // enough for any split of them, and neither is three after.
    expect(detectChanges(pushesOf([...noisy(100, 3, 0.5), ...noisy(130, 20, 0.5)]), true, DEFAULT_ALERT_THRESHOLD)).toEqual(
      [],
    );
    expect(detectChanges(pushesOf([...noisy(100, 30, 0.5), ...noisy(130, 3, 0.5)]), true, DEFAULT_ALERT_THRESHOLD)).toEqual(
      [],
    );
  });

  it('puts a step near the start of the range on the right push', () => {
    // The proposal stage cannot offer a cut closer than six pushes to the start of
    // the series, so the gate runs on pools that straddle this step — and if the
    // estimate were held to the same floor, the mark would sit two pushes late with a
    // delta diluted by the two post-step values on the wrong side of it, and a click
    // would pin two pushes that are both after the step. See `relocateBoundary`,
    // "any split the test could reach α at".
    const found = detectChanges(pushesOf([...noisy(100, 5, 0.5), ...noisy(130, 10, 0.5)]), true, DEFAULT_ALERT_THRESHOLD);
    expect(found).toHaveLength(1);
    expect(found[0].index).toBe(5);
    expect(found[0].relativeChange).toBeCloseTo(0.3, 2);
    expect(found[0].beforePushId).toBe(1004);
    expect(found[0].afterPushId).toBe(1005);
    expect(found[0].pValue).toBeLessThan(0.01);
  });

  it('needs five pushes after a change before it will say anything', () => {
    // The last cut the proposal stage can offer is six from the end, so the gate here
    // runs on an after-pool of one pre-step push and five post-step ones — and when
    // that fires, the estimate slides onto the step itself. Five is therefore the
    // latency floor for a clean step, and it holds at 2% as firmly as at 30%: the
    // gate's own six-a-side requirement is what sets it, not the size of the step.
    const values = (after: number) => [...noisy(100, 30, 0.5), ...noisy(104, after, 0.5)];
    expect(detectChanges(pushesOf(values(4)), true, DEFAULT_ALERT_THRESHOLD)).toEqual([]);
    const found = detectChanges(pushesOf(values(5)), true, DEFAULT_ALERT_THRESHOLD);
    expect(found).toHaveLength(1);
    expect(found[0].index).toBe(30);
    expect(found[0].afterCount).toBe(5);
  });

  it('finds every step in a long series and invents none between them', () => {
    // Four levels 5% apart over 900 pushes. Under the dynamic program this shape
    // was where a grid edge every 500 pushes manufactured a −1.0% "change" at
    // p = 0.028 out of the noise; there are no grids now, and the recursion has to
    // find the third step inside a stretch bounded by the first two.
    let level = 100;
    const values: number[] = [];
    for (let i = 0; i < 4; i++) {
      values.push(...noisy(level, 225, 3));
      level *= 1.05;
    }
    const found = detectChanges(pushesOf(values), true, DEFAULT_ALERT_THRESHOLD);
    expect(found.map((c) => c.index)).toEqual([225, 450, 675]);
  });

  it('finds both of two steps', () => {
    const values = [...noisy(100, 20, 1), ...noisy(115, 20, 1), ...noisy(103, 20, 1)];
    const found = detectChanges(pushesOf(values), true, DEFAULT_ALERT_THRESHOLD);
    expect(found.map((c) => c.index)).toEqual([20, 40]);
    expect(found.map((c) => c.isRegression)).toEqual([true, false]);
    // Neither window crosses the other change: the second step's "before" pool
    // must not reach back past the first one.
    expect(found[0].windowEnd).toBeLessThanOrEqual(40);
    expect(found[1].windowStart).toBeGreaterThanOrEqual(20);
  });

  it('finds the step in a series whose level wanders around it', () => {
    // Real data, because no synthetic fixture reproduces what makes this hard: the
    // step is 6σ against its own neighbourhood and nothing at all against the spread
    // of the whole series, one push in six being measured several times less
    // precisely than the rest. A dynamic program scoring 500 pushes as one unit
    // covered everything past push 290 with a single segment, so the confirmation
    // stage was never offered the boundary and perfherder's alert #243130 stood
    // unanswered. See `candidateBoundaries`.
    const found = detectChanges(
      pushesOf(wandering.means),
      wandering.lowerIsBetter,
      DEFAULT_ALERT_THRESHOLD,
    );
    const step = found.find((c) => Math.abs(c.index - wandering.alertedStepIndex) <= 2);
    expect(step).toBeDefined();
    expect(step!.isRegression).toBe(true);
    // Perfherder's own alert on this push says +2.6%; ours is a difference of
    // means over up to 24 pushes a side, so the two don't have to agree exactly.
    expect(step!.relativeChange).toBeGreaterThan(0.015);
    expect(step!.pValue).toBeLessThan(0.001);
  });

  it('says nothing about a series with almost no pushes', () => {
    expect(detectChanges(pushesOf([]), true, DEFAULT_ALERT_THRESHOLD)).toEqual([]);
    expect(detectChanges(pushesOf([1, 2, 3, 4, 5]), true, DEFAULT_ALERT_THRESHOLD)).toEqual([]);
  });
});
