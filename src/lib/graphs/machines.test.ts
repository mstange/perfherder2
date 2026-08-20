import { describe, expect, it } from 'vitest';
import { buildMachineCensus, buildMachineLevels } from './machines';
import type { PushGroup, Run } from './graphData';

const BASE_TIME = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;

// One push per entry, each holding one run per (machine, values) pair given. The
// same shape the real builder produces, since the census walks `push.runs` and
// reads `machineName` and `values` off each.
function pushesOf(
  spec: readonly (readonly { machine: string | null; values: number[] }[])[],
): PushGroup[] {
  return spec.map((runSpecs, i) => {
    const runs: Run[] = runSpecs.map((r, k) => ({
      datumId: i * 100 + k,
      jobId: r.machine === null ? null : i * 100 + k,
      machineName: r.machine,
      pushId: 1000 + i,
      x: BASE_TIME + i * HOUR,
      revision: `rev${i}`,
      values: [...r.values].sort((a, b) => a - b),
      mean: r.values.reduce((s, v) => s + v, 0) / r.values.length,
    }));
    return {
      pushId: 1000 + i,
      revision: `rev${i}`,
      x: BASE_TIME + i * HOUR,
      runs,
      mean: runs.reduce((s, r) => s + r.mean, 0) / runs.length,
      xRoom: Infinity,
    };
  });
}

// A machine alternating with `others`, at `level` while everyone else is at 100.
function alternating(count: number, suspect: string, level: number): PushGroup[] {
  return pushesOf(
    Array.from({ length: count }, (_, i) => {
      const odd = i % 4 === 0;
      return [
        odd
          ? { machine: suspect, values: [level, level] }
          : { machine: `good-${i % 7}`, values: [100, 100] },
      ];
    }),
  );
}

describe('buildMachineCensus', () => {
  it('counts runs and points per machine, sorted by name', () => {
    const census = buildMachineCensus([
      pushesOf([
        [{ machine: 'nuc13-103', values: [1, 2, 3] }],
        [{ machine: 'nuc13-9', values: [1, 2] }],
        [{ machine: 'nuc13-103', values: [4] }],
      ]),
    ]);
    // Numerically aware, so 9 comes before 103 — the pool does not always pad.
    expect(census.machines.map((m) => m.name)).toEqual(['nuc13-9', 'nuc13-103']);
    expect(census.machines).toEqual([
      { name: 'nuc13-9', runs: 1, points: 2 },
      { name: 'nuc13-103', runs: 2, points: 4 },
    ]);
  });

  it('adds one machine up across the series it ran jobs for', () => {
    // The case the panel exists for: a focus is one name over the whole graph,
    // because one worker runs every signature that targets its platform.
    const a = pushesOf([[{ machine: 'nuc13-1', values: [1] }]]);
    const b = pushesOf([
      [{ machine: 'nuc13-1', values: [1, 2] }],
      [{ machine: 'nuc13-2', values: [3] }],
    ]);
    const census = buildMachineCensus([a, b]);
    expect(census.machines).toEqual([
      { name: 'nuc13-1', runs: 2, points: 3 },
      { name: 'nuc13-2', runs: 1, points: 1 },
    ]);
  });

  it('counts expired runs rather than dropping them', () => {
    // Everything older than treeherder's job retention window looks like this,
    // which on a six-month range is the first two months of it.
    const census = buildMachineCensus([
      pushesOf([
        [{ machine: null, values: [1] }],
        [{ machine: null, values: [2, 3] }],
        [{ machine: 'nuc13-1', values: [4] }],
      ]),
    ]);
    expect(census.machines).toEqual([{ name: 'nuc13-1', runs: 1, points: 1 }]);
    expect(census.unattributedRuns).toBe(2);
    expect(census.unattributedPoints).toBe(3);
  });

  it('counts only the pushes in the span', () => {
    const pushes = pushesOf([
      [{ machine: 'early', values: [1] }],
      [{ machine: 'late', values: [2] }],
      [{ machine: 'late', values: [3] }],
    ]);
    const census = buildMachineCensus([pushes], {
      start: BASE_TIME + HOUR,
      end: BASE_TIME + 2 * HOUR,
    });
    expect(census.machines.map((m) => m.name)).toEqual(['late']);
    expect(census.machines[0].runs).toBe(2);
  });

  it('has nothing to say about no series', () => {
    expect(buildMachineCensus([])).toEqual({
      machines: [],
      unattributedRuns: 0,
      unattributedPoints: 0,
    });
  });
});

describe('buildMachineLevels', () => {
  it('finds the machine that reads high, and clears the ones that do not', () => {
    const levels = buildMachineLevels([alternating(40, 'bad-1', 110)]);
    const bad = levels.machines.find((m) => m.name === 'bad-1');
    expect(bad?.relativeLevel).toBeGreaterThan(0.03);
    for (const m of levels.machines) {
      if (m.name === 'bad-1') continue;
      expect(Math.abs(m.relativeLevel ?? 0)).toBeLessThan(0.01);
    }
  });

  it('signs a machine that reads low the other way', () => {
    const levels = buildMachineLevels([alternating(40, 'bad-1', 90)]);
    expect(levels.machines.find((m) => m.name === 'bad-1')?.relativeLevel).toBeLessThan(-0.03);
  });

  it('does not blame the machine that happened to be in rotation for a step', () => {
    // The trap the local baseline exists for. Every push doubles at the halfway
    // mark, and one machine ran only the second half: against a series mean it
    // would read +100%, against its own neighbourhood it reads ~0.
    const pushes = pushesOf(
      Array.from({ length: 60 }, (_, i) =>
        i < 30
          ? [{ machine: `before-${i % 5}`, values: [100, 100] }]
          : [{ machine: 'after-only', values: [200, 200] }],
      ),
    );
    const after = buildMachineLevels([pushes]).machines.find((m) => m.name === 'after-only');
    expect(Math.abs(after?.relativeLevel ?? 1)).toBeLessThan(0.05);
  });

  it('reports no level for a series too short to have a local one', () => {
    // Below the band's floor there is nothing to compare a run against, and a
    // made-up baseline would be worse than an empty column.
    const levels = buildMachineLevels([pushesOf([[{ machine: 'nuc13-1', values: [1] }]])]);
    expect(levels.machines).toEqual([{ name: 'nuc13-1', runs: 1, points: 1, relativeLevel: null }]);
  });

  it('carries the census through unchanged', () => {
    const pushes = pushesOf([
      [{ machine: null, values: [1] }],
      [{ machine: 'nuc13-1', values: [2] }],
    ]);
    const levels = buildMachineLevels([pushes]);
    expect(levels.unattributedRuns).toBe(1);
    expect(levels.machines.map((m) => m.name)).toEqual(buildMachineCensus([pushes]).machines.map((m) => m.name));
  });
});
