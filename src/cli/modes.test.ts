import { describe, expect, it } from 'vitest';
import { computeModeInfo, gaussianKde, linearGrid, silvermanBandwidth } from '../lib/graphs/kde';
import { VALLEY_THRESHOLD } from '../lib/graphs/distribution';
import { compareModes, describeModeComparison, type ModeSide } from './modes';

// A side built the way `buildDistribution` builds one, so the modes under test
// are the modes the app would report for the same values rather than ones
// hand-written to suit the assertion.
function sideOf(label: string, values: readonly number[], domain: [number, number]): ModeSide {
  const bandwidth = silvermanBandwidth(values);
  const grid = linearGrid(domain[0], domain[1], 256);
  const density = gaussianKde(values, bandwidth, grid);
  return {
    label,
    modes: computeModeInfo(grid, density, VALLEY_THRESHOLD),
    bandwidth,
    hasCurve: values.length >= 4,
  };
}

// `count` values clustered tightly around `centre`, spread just enough that the
// bandwidth rule has something to work with.
function cluster(centre: number, count: number, spread = 1): number[] {
  return Array.from({ length: count }, (_, i) => centre + ((i % 5) - 2) * spread);
}

const DOMAIN: [number, number] = [80, 220];
const fmt = {
  value: (v: number) => v.toFixed(1),
  unit: 'ms',
  baseLabel: 'before',
  nextLabel: 'after',
};

describe('compareModes', () => {
  it('reports insufficient when a side has no curve', () => {
    const base = sideOf('before', cluster(100, 20), DOMAIN);
    const next = sideOf('after', [100, 101], DOMAIN);
    const cmp = compareModes(base, next);
    expect(cmp.verdict).toBe('insufficient');
    expect(describeModeComparison(cmp, fmt)).toMatch(/too few values/);
  });

  it('calls one unimodal pool against itself unchanged', () => {
    const values = cluster(100, 30);
    const cmp = compareModes(sideOf('before', values, DOMAIN), sideOf('after', values, DOMAIN));
    expect(cmp.verdict).toBe('unchanged');
    expect(cmp.pairs).toHaveLength(1);
    expect(cmp.pairs[0].moved).toBe(false);
  });

  it('calls a displaced unimodal pool shifted', () => {
    const cmp = compareModes(
      sideOf('before', cluster(100, 30), DOMAIN),
      sideOf('after', cluster(160, 30), DOMAIN),
    );
    expect(cmp.verdict).toBe('shifted');
    expect(cmp.pairs[0].moved).toBe(true);
    expect(cmp.pairs[0].shift).toBeGreaterThan(50);
    expect(describeModeComparison(cmp, fmt)).toMatch(/the level shifting/);
  });

  it('does not call a shift smaller than the KDE resolves a movement', () => {
    // The whole point of the analysis. A peak displacement below the bandwidth
    // is the kernel talking, and reporting it as a movement would hide the
    // interesting case — modes in place, weights moved — behind a false one.
    const base = sideOf('before', cluster(100, 30), DOMAIN);
    const next = sideOf('after', cluster(100 + base.bandwidth * 0.4, 30), DOMAIN);
    const cmp = compareModes(base, next);
    expect(cmp.pairs[0].moved).toBe(false);
    expect(cmp.verdict).toBe('unchanged');
  });

  it('reports a reweighting when the peaks hold and the shares move', () => {
    // Two modes in the same two places on both sides; the second mode goes from
    // a quarter of the samples to three quarters.
    const base = sideOf('before', [...cluster(110, 30), ...cluster(180, 10)], DOMAIN);
    const next = sideOf('after', [...cluster(110, 10), ...cluster(180, 30)], DOMAIN);
    const cmp = compareModes(base, next);

    expect(cmp.baseCount).toBe(2);
    expect(cmp.nextCount).toBe(2);
    expect(cmp.verdict).toBe('reweighted');
    expect(cmp.pairs.every((p) => !p.moved)).toBe(true);
    expect(cmp.pairs[1].baseShare).toBeLessThan(cmp.pairs[1].nextShare);

    const sentence = describeModeComparison(cmp, fmt);
    expect(sentence).toMatch(/modes stayed where they were/);
    expect(sentence).toMatch(/how often each path is taken/);
  });

  it('reports a restructure when a mode disappears, and names it', () => {
    const cmp = compareModes(
      sideOf('before', [...cluster(110, 20), ...cluster(180, 20)], DOMAIN),
      sideOf('after', cluster(180, 40), DOMAIN),
    );
    expect(cmp.verdict).toBe('restructured');
    expect(cmp.unmatched).toHaveLength(1);
    expect(cmp.unmatched[0].side).toBe('base');
    expect(cmp.unmatched[0].loc).toBeLessThan(140);

    const sentence = describeModeComparison(cmp, fmt);
    expect(sentence).toMatch(/before has 2 modes, after has 1/);
    expect(sentence).toMatch(/Gone:/);
  });

  it('pairs equal mode counts by rank, so A means A and B means B', () => {
    const cmp = compareModes(
      sideOf('before', [...cluster(110, 20), ...cluster(180, 20)], DOMAIN),
      sideOf('after', [...cluster(115, 20), ...cluster(185, 20)], DOMAIN),
    );
    expect(cmp.pairs.map((p) => [p.baseLetter, p.nextLetter])).toEqual([
      ['A', 'A'],
      ['B', 'B'],
    ]);
    // Pairing by nearest would be tempting and wrong here: the two modes are
    // 70 apart and both moved by 5, so nearest happens to agree — but if both
    // sides shifted by 40 it would pair before's B with after's A.
    expect(cmp.pairs[0].baseLoc).toBeLessThan(cmp.pairs[1].baseLoc);
  });

  it('takes the resolution from the coarser of the two estimates', () => {
    const base = sideOf('before', cluster(100, 30, 0.2), DOMAIN);
    const next = sideOf('after', cluster(100, 30, 8), DOMAIN);
    expect(compareModes(base, next).resolution).toBe(Math.max(base.bandwidth, next.bandwidth));
  });
});
