import { describe, expect, it } from 'vitest';
import { buildNoiseBudget } from './noise';
import type { PushGroup, Run } from './graphData';

const DAY = 86400000;

function run(datumId: number, machineName: string | null, values: number[]): Run {
  return {
    datumId,
    jobId: datumId + 1000,
    machineName,
    pushId: 0,
    x: 0,
    revision: '',
    values: [...values].sort((a, b) => a - b),
    mean: values.reduce((a, b) => a + b, 0) / values.length,
  };
}

function push(pushId: number, runs: Run[]): PushGroup {
  const fixed = runs.map((r) => ({ ...r, pushId, x: pushId * DAY, revision: `r${pushId}` }));
  return {
    pushId,
    revision: `r${pushId}`,
    x: pushId * DAY,
    runs: fixed,
    xRoom: Infinity,
    mean: fixed.reduce((s, r) => s + r.mean, 0) / fixed.length,
  };
}

// A pool of two machines, one reading 20 low and one 20 high, on a series whose
// level never moves. Every push draws both, so the push means are exact and the
// whole of the job-to-job scatter is the device.
function twoMachinePool(pushCount: number): PushGroup[] {
  return Array.from({ length: pushCount }, (_, i) =>
    push(i + 1, [
      run(i * 10 + 1, 'slow', [1020, 1020, 1020, 1020]),
      run(i * 10 + 2, 'fast', [980, 980, 980, 980]),
    ]),
  );
}

describe('buildNoiseBudget', () => {
  it('is null for a series with no runs', () => {
    expect(buildNoiseBudget([])).toBeNull();
  });

  it('separates the three levels a measurement has', () => {
    // Replicates spread within each run, runs spread within each push, and the
    // push means are deliberately identical so the build term is zero.
    const pushes = Array.from({ length: 8 }, (_, i) =>
      push(i + 1, [
        run(i * 10 + 1, 'a', [90, 100, 110]),
        run(i * 10 + 2, 'b', [190, 200, 210]),
      ]),
    );
    const b = buildNoiseBudget(pushes)!;
    expect(b.level).toBe(150);
    expect(b.runs).toBe(16);
    expect(b.retriggeredPushes).toBe(8);
    expect(b.runsPerPush).toBe(2);
    expect(b.replicatesPerRun).toBe(3);
    // Each run's replicates have sd 10; the runs sit 100 apart, so pooled around
    // their push mean that is 50 either side.
    expect(b.replicate!.sd).toBeCloseTo(10, 6);
    expect(b.job!.sd).toBeCloseTo(Math.sqrt(2) * 50, 6);
    // Identical push means: no push-level scatter at all, and so no build term.
    expect(b.push!.sd).toBeCloseTo(0, 9);
    expect(b.build).toBeNull();
  });

  it('attributes job scatter to the device when the device is what it is', () => {
    const b = buildNoiseBudget(twoMachinePool(10))!;
    expect(b.level).toBe(1000);
    // 20 either side of the push mean, so the pooled job sd is 20·√2.
    expect(b.job!.sd).toBeCloseTo(20 * Math.SQRT2, 6);
    // The replicates are constant, so nothing is sampling error, and a
    // leave-one-out correction removes essentially all of the rest.
    expect(b.replicate!.sd).toBe(0);
    expect(b.device!.cv / b.job!.cv).toBeGreaterThan(0.99);
    expect(b.unexplained!.sd).toBeLessThan(0.01);
    expect(b.attributedRuns).toBe(20);
  });

  it('does not credit the device with noise a machine cannot explain', () => {
    // One machine, alternating high and low within each push: the scatter is
    // real and no machine offset can predict any of it.
    const pushes = Array.from({ length: 10 }, (_, i) =>
      push(i + 1, [
        run(i * 10 + 1, 'only', [1020, 1020]),
        run(i * 10 + 2, 'only', [980, 980]),
      ]),
    );
    const b = buildNoiseBudget(pushes)!;
    expect(b.job!.sd).toBeCloseTo(20 * Math.SQRT2, 6);
    expect(b.device!.sd).toBeCloseTo(0, 6);
    expect(b.unexplained!.sd).toBeCloseTo(20 * Math.SQRT2, 6);
  });

  it('reads per-push offsets as build-to-build scatter', () => {
    // 60 pushes, each with a level of its own inside ±50, and two tight jobs
    // each. A rolling median estimates the level around a push without tracking
    // the push itself, so what is left is the build's own offset, and no amount
    // of job noise explains it.
    let state = 11;
    const offsets = Array.from({ length: 60 }, () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return ((state / 0x7fffffff) * 2 - 1) * 50;
    });
    const pushes = offsets.map((offset, i) =>
      push(i + 1, [
        run(i * 10 + 1, 'a', [1005 + offset, 1005 + offset]),
        run(i * 10 + 2, 'b', [995 + offset, 995 + offset]),
      ]),
    );
    const b = buildNoiseBudget(pushes)!;
    // The jobs sit 5 either side of every push mean, so the pooled job sd is
    // 5·√2 and a push mean inherits 5 of it.
    expect(b.job!.sd).toBeCloseTo(5 * Math.SQRT2, 6);
    expect(b.build).not.toBeNull();
    expect(b.build!.sd).toBeGreaterThan(20);
    // Uniform ±50 has sd 28.9, and both push rows should see about that: there
    // is no trend here for the local row to remove.
    expect(b.local!.sd).toBeGreaterThan(20);
    expect(Math.abs(b.local!.sd - b.push!.sd)).toBeLessThan(6);
  });

  it('does not read a drifting series as build-to-build scatter', () => {
    // 60 pushes sliding 0.5 up each — 30 end to end — with two jobs 30 apart.
    // Around the series level that slide is most of the scatter; around each
    // push's own neighbourhood almost nothing is left, and what is left is
    // smaller than the jobs explain. This is the case that made the build term
    // read 1.77% on a real series before it was measured locally.
    const pushes = Array.from({ length: 60 }, (_, i) =>
      push(i + 1, [
        run(i * 10 + 1, 'a', [1015 + i * 0.5, 1015 + i * 0.5]),
        run(i * 10 + 2, 'b', [985 + i * 0.5, 985 + i * 0.5]),
      ]),
    );
    const b = buildNoiseBudget(pushes)!;
    expect(b.push!.sd).toBeGreaterThan(8);
    // Not zero: the first and last windows are clamped rather than shortened
    // (trend.ts), so the ends of a sloping series sit off their own baseline.
    expect(b.local!.sd).toBeLessThan(b.push!.sd / 3);
    expect(b.build).toBeNull();
  });

  it('has no local row, and so no build term, in too short a range', () => {
    // trend.ts will not draw a band under a dozen pushes, and this borrows its
    // floor rather than inventing a second one: a rolling median of three values
    // is not a level.
    const b = buildNoiseBudget(twoMachinePool(8))!;
    expect(b.push).not.toBeNull();
    expect(b.local).toBeNull();
    expect(b.build).toBeNull();
  });

  it('turns the job figure into what a single push pair can resolve', () => {
    const b = buildNoiseBudget(twoMachinePool(10))!;
    // job sd 28.28 over 2 runs → se 20; a difference needs 1.96·√2·20 = 55.4.
    expect(b.pushPairResolution! * b.level).toBeCloseTo(1.959964 * Math.SQRT2 * 20, 4);
    // The detector's window is 24 pushes a side, so √24 finer.
    expect(b.windowResolution!).toBeCloseTo(b.pushPairResolution! / Math.sqrt(24), 9);
  });

  it('says nothing about jobs when no push was retriggered', () => {
    const pushes = Array.from({ length: 6 }, (_, i) =>
      push(i + 1, [run(i, 'a', [100 + i, 102 + i])]),
    );
    const b = buildNoiseBudget(pushes)!;
    expect(b.retriggeredPushes).toBe(0);
    expect(b.job).toBeNull();
    expect(b.device).toBeNull();
    expect(b.pushPairResolution).toBeNull();
    // The two levels that *are* measurable still are.
    expect(b.replicate!.sd).toBeCloseTo(Math.sqrt(2), 6);
    expect(b.push).not.toBeNull();
  });

  it('leaves the runs whose job expired out of the device estimate', () => {
    const pushes = Array.from({ length: 6 }, (_, i) =>
      push(i + 1, [
        run(i * 10 + 1, null, [1020, 1020]),
        run(i * 10 + 2, null, [980, 980]),
      ]),
    );
    const b = buildNoiseBudget(pushes)!;
    expect(b.attributedRuns).toBe(0);
    expect(b.job!.sd).toBeGreaterThan(0);
    // Nothing to calibrate with, so none of it is attributed to the device.
    expect(b.device!.sd).toBe(0);
  });
});
