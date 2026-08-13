import { describe, expect, it } from 'vitest';
import {
  buildDrift,
  driftBadgeLabel,
  driftBadgeTitle,
  driftIsRegression,
  driftWorthReporting,
} from './drift';
import {
  DEFAULT_ALERT_THRESHOLD,
  placeholderMeta,
  type AlertThreshold,
  type PushGroup,
  type SeriesMeta,
} from './graphData';

// The same fixture shape changes.test.ts uses: only `mean`, `x` and `pushId` are
// read, and the rest is filled so these are real `PushGroup`s.
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

// Deterministic noise, for the same reason changes.test.ts has its own: a test
// that asserts whether a figure is reportable must not flake.
function noisy(level: number, count: number, amplitude: number): number[] {
  let seed = 12345;
  return Array.from({ length: count }, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return level + ((seed / 0x7fffffff) * 2 - 1) * amplitude;
  });
}

describe('buildDrift', () => {
  it('compares the ends of the range, which is the question a step cannot answer', () => {
    // A linear climb has no step in it (graphs-todo.md, "Gradual drift is
    // invisible by construction"), and this is the figure that describes it.
    const climb = Array.from({ length: 60 }, (_, i) => 100 + i);
    const drift = buildDrift(pushesOf(climb))!;
    expect(drift.windowPushes).toBe(24);
    expect(drift.first.median).toBeCloseTo(111.5, 5);
    expect(drift.last.median).toBeCloseTo(147.5, 5);
    expect(drift.deltaFraction).toBeCloseTo(36 / 111.5, 5);
    expect(drift.test?.pValue).toBeLessThan(0.01);
  });

  it('keeps the windows from overlapping when the range is short', () => {
    // 30 pushes is 15 a side, not 24 of 30 twice.
    const drift = buildDrift(pushesOf(Array.from({ length: 30 }, () => 10)))!;
    expect(drift.windowPushes).toBe(15);
    expect(drift.first.pushCount).toBe(15);
    expect(drift.last.pushCount).toBe(15);
  });

  it('refuses a range too short to say anything, rather than dividing three by three', () => {
    // Six a side is the detector's own minimum for a level.
    expect(buildDrift(pushesOf([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]))).toBeNull();
    expect(buildDrift(pushesOf(Array.from({ length: 12 }, () => 5)))).not.toBeNull();
  });

  it('reports each window\'s own dates, so "February" can be checked', () => {
    const drift = buildDrift(pushesOf(Array.from({ length: 60 }, () => 7)))!;
    expect(drift.first.startMs).toBe(BASE_TIME);
    expect(drift.last.endMs).toBe(BASE_TIME + 59 * HOUR);
    expect(drift.first.endMs! < drift.last.startMs!).toBe(true);
  });

  it('leaves the delta null rather than dividing by zero', () => {
    const flat = [...Array.from({ length: 24 }, () => 0), ...Array.from({ length: 24 }, () => 5)];
    expect(buildDrift(pushesOf(flat))!.deltaFraction).toBeNull();
  });
});

describe('driftWorthReporting', () => {
  const worth = (values: readonly number[], threshold: AlertThreshold = DEFAULT_ALERT_THRESHOLD) => {
    const drift = buildDrift(pushesOf(values));
    return drift ? driftWorthReporting(drift, threshold) : null;
  };

  it('reports the case it was built for — a climb with no step in it', () => {
    // 60 pushes climbing 10%, which is signature 5350957's shape and which the
    // detector draws no bar for.
    const climb = Array.from({ length: 60 }, (_, i) => 100 * (1 + (0.1 * i) / 59));
    expect(worth(climb)).toBe(true);
  });

  it('says nothing about a flat series', () => {
    expect(worth(noisy(100, 60, 1))).toBe(false);
  });

  it('says nothing when the ends differ by less than the signature earns', () => {
    // A rank test on two clean 24-push windows will certify a 0.1% difference
    // happily. The floor — a quarter of the 2% default — is what stops it.
    const tiny = [...Array.from({ length: 30 }, () => 100), ...Array.from({ length: 30 }, () => 100.1)];
    const drift = buildDrift(pushesOf(tiny))!;
    expect(drift.test!.pValue).toBeLessThan(0.001);
    expect(driftWorthReporting(drift, DEFAULT_ALERT_THRESHOLD)).toBe(false);
  });

  it('takes the floor from the signature, not from a constant', () => {
    // The same 1% climb, against a metric that alerts at 2% and one that alerts
    // at 8%. A quarter of 8% is 2%, so the second one keeps quiet about it.
    const climb = [...Array.from({ length: 30 }, () => 100), ...Array.from({ length: 30 }, () => 101)];
    expect(worth(climb, { kind: 'percentage', value: 2 })).toBe(true);
    expect(worth(climb, { kind: 'percentage', value: 8 })).toBe(false);
  });

  it('holds an absolute-threshold metric to its own units', () => {
    // 102400 bytes is the installer-size threshold's shape: a quarter of it is
    // 25600, so a 20000-byte climb is below the floor however clean it is.
    const threshold: AlertThreshold = { kind: 'absolute', value: 102_400 };
    const small = [
      ...Array.from({ length: 30 }, () => 5_000_000),
      ...Array.from({ length: 30 }, () => 5_020_000),
    ];
    const big = [
      ...Array.from({ length: 30 }, () => 5_000_000),
      ...Array.from({ length: 30 }, () => 5_100_000),
    ];
    expect(worth(small, threshold)).toBe(false);
    expect(worth(big, threshold)).toBe(true);
  });

  it('says nothing about a climb the series\' own noise cannot distinguish from flat', () => {
    // A 5% climb buried in ±20% scatter. The floor is cleared and the test is
    // not, which is the bar that keeps a badge off every noisy card.
    const loud = [...noisy(100, 30, 20), ...noisy(105, 30, 20)];
    const drift = buildDrift(pushesOf(loud))!;
    expect(Math.abs(drift.deltaFraction!)).toBeGreaterThan(0.005);
    expect(drift.test!.pValue).toBeGreaterThan(0.01);
    expect(driftWorthReporting(drift, DEFAULT_ALERT_THRESHOLD)).toBe(false);
  });

  it('holds to the detector\'s α rather than the comparison card\'s', () => {
    // A difference that lands between 0.01 and 0.05 is reportable on a card the
    // user pinned and not in a badge that drew itself — see CHANGE_ALPHA.
    const drift = buildDrift(pushesOf([...noisy(100, 12, 8), ...noisy(105, 12, 8)]))!;
    expect(drift.test!.pValue).toBeGreaterThan(0.01);
    expect(drift.test!.pValue).toBeLessThan(0.05);
    expect(driftWorthReporting(drift, DEFAULT_ALERT_THRESHOLD)).toBe(false);
  });

  it('cannot report a drift with no delta', () => {
    const fromZero = [...Array.from({ length: 24 }, () => 0), ...Array.from({ length: 24 }, () => 5)];
    expect(worth(fromZero)).toBe(false);
  });
});

describe('driftBadgeLabel / driftBadgeTitle', () => {
  const ref = { repository: 'autoland', signatureId: 5350957, frameworkId: 13 };
  const metaOf = (over: Partial<SeriesMeta> = {}): SeriesMeta => ({
    ...placeholderMeta(ref),
    measurementUnit: 'ms',
    ...over,
  });
  // A tenth of a percent per push over 60 pushes, which is the shape of the
  // signature this feature was built for.
  const climb = buildDrift(pushesOf(Array.from({ length: 60 }, (_, i) => 100 * (1 + i / 590))))!;

  it('puts the percentage in the badge and nothing else', () => {
    expect(driftBadgeLabel(climb)).toBe('+6.0% drift');
  });

  it('puts the numbers the badge cannot hold in the title', () => {
    const title = driftBadgeTitle(climb, metaOf());
    // The two medians with their unit, so "+6.0%" can be checked.
    expect(title).toContain('101.95 → 108.05 ms');
    expect(title).toContain('+6.0%');
    // Both windows' dates, and how many pushes each holds. Matched by shape
    // rather than by text: `describeSpan` formats in the local locale and drops
    // the year only for the current one, so asserting the literal dates would
    // make this test fail on a machine in another timezone and again next year.
    expect(title).toContain('Medians of 24 pushes at each end');
    expect(title).toMatch(/— \w{3} \d+.* against \w{3} \d+/);
    expect(title).toContain('p <0.001');
    // And the disclaimer that keeps it from reading as a detected step.
    expect(title).toContain('does not say that anything stepped');
  });

  it('takes worse and better from the metric', () => {
    expect(driftBadgeTitle(climb, metaOf({ lowerIsBetter: true }))).toContain('(worse)');
    expect(driftBadgeTitle(climb, metaOf({ lowerIsBetter: false }))).toContain('(better)');
  });

  it('omits a unit it does not have, rather than printing an empty one', () => {
    expect(driftBadgeTitle(climb, metaOf({ measurementUnit: '' }))).toContain('101.95 → 108.05,');
  });

  it('says nothing about direction for a series with no metadata yet', () => {
    const title = driftBadgeTitle(climb, null);
    expect(title).not.toContain('worse');
    expect(title).not.toContain('better');
  });
});

describe('driftIsRegression', () => {
  const driftOf = (values: readonly number[]) => buildDrift(pushesOf(values))!;
  const up = driftOf([...Array.from({ length: 24 }, () => 100), ...Array.from({ length: 24 }, () => 110)]);
  const down = driftOf([...Array.from({ length: 24 }, () => 110), ...Array.from({ length: 24 }, () => 100)]);

  it('reads the direction against the metric, not against the sign', () => {
    expect(driftIsRegression(up, true)).toBe(true);
    expect(driftIsRegression(up, false)).toBe(false);
    expect(driftIsRegression(down, true)).toBe(false);
    expect(driftIsRegression(down, false)).toBe(true);
  });

  it('has no direction for a series that did not move', () => {
    const flat = driftOf(Array.from({ length: 48 }, () => 100));
    expect(driftIsRegression(flat, true)).toBeNull();
  });
});
