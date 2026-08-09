import { describe, expect, it } from 'vitest';
import {
  axisLines,
  columnFor,
  densityRow,
  formatDurationMs,
  formatUtc,
  markerRow,
  sparkline,
  table,
  truncate,
  wrap,
} from './format';

describe('table', () => {
  it('pads columns and trims the trailing gap', () => {
    const lines = table(
      ['A', 'BB'],
      [
        ['x', 'y'],
        ['long', 'z'],
      ],
    );
    expect(lines).toEqual(['A     BB', 'x     y', 'long  z']);
  });

  it('right-aligns where asked', () => {
    const lines = table(['N'], [['1'], ['100']], ['right']);
    expect(lines).toEqual(['  N', '  1', '100']);
  });

  it('tolerates a short row', () => {
    expect(table(['A', 'B'], [['x']])).toEqual(['A  B', 'x']);
  });
});

describe('truncate', () => {
  it('leaves a short string alone and marks a cut one', () => {
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abcdef', 5)).toBe('abcd…');
  });
});

describe('formatUtc', () => {
  it('prints UTC, marked, to the minute', () => {
    expect(formatUtc(Date.parse('2026-06-23T16:04:31Z'))).toBe('2026-06-23 16:04Z');
  });
});

describe('formatDurationMs', () => {
  it('picks a unit by magnitude', () => {
    expect(formatDurationMs(30 * 60_000)).toBe('30 min');
    expect(formatDurationMs(5 * 3_600_000)).toBe('5.0 hours');
    expect(formatDurationMs(72 * 3_600_000)).toBe('3.0 days');
  });
});

describe('sparkline', () => {
  it('scales between the extremes of what it was given', () => {
    expect(sparkline([0, 1, 2, 3, 4, 5, 6, 7], 8)).toBe('▁▂▃▄▅▆▇█');
  });

  it('draws a flat series flat rather than stretching its rounding noise', () => {
    expect(sparkline([5, 5, 5], 3)).toBe('▄▄▄');
  });

  it('resamples down to the requested width', () => {
    expect(sparkline([0, 0, 7, 7], 2)).toHaveLength(2);
  });

  it('never draws more columns than it has values', () => {
    expect(sparkline([1, 2], 40)).toHaveLength(2);
  });
});

describe('densityRow', () => {
  // Both curves of a comparison share one scale, so a row has to be readable
  // against a peak that is not its own.
  const peak = (at: number, width: number): number[] =>
    Array.from({ length: 64 }, (_, i) => Math.exp(-(((i - at) / 3) ** 2)) * width);

  it('draws the taller curve full height', () => {
    const row = densityRow(peak(32, 1), 32, 1);
    expect(row).toContain('█');
  });

  it('still shows a curve eight times shorter than the shared peak', () => {
    // The bug this guards: a linear scale over eight block characters renders
    // anything past 8× as an empty row, which reads as "no data" rather than as
    // "shorter". A 4-value push against a 7-value push measured exactly that on
    // the first real series this was run against.
    const row = densityRow(peak(32, 1 / 8), 32, 1);
    expect(row.trim()).not.toBe('');
  });

  it('leaves the tails blank so the curve has a visible extent', () => {
    const row = densityRow(peak(32, 1), 40, 1);
    expect(row.startsWith(' ')).toBe(true);
  });

  it('is empty for a curve of nothing', () => {
    expect(densityRow([], 20, 1)).toBe('');
  });
});

describe('columnFor and markerRow', () => {
  it('places a value in the column its position implies', () => {
    expect(columnFor(0, 0, 10, 11)).toBe(0);
    expect(columnFor(5, 0, 10, 11)).toBe(5);
    expect(columnFor(10, 0, 10, 11)).toBe(10);
  });

  it('clamps a value outside the domain rather than running off the row', () => {
    expect(columnFor(-5, 0, 10, 11)).toBe(0);
    expect(columnFor(15, 0, 10, 11)).toBe(10);
  });

  it('puts each label at its column, first one winning a collision', () => {
    expect(markerRow([{ column: 2, label: 'A' }, { column: 5, label: 'B' }], 8)).toBe('  A  B');
    expect(markerRow([{ column: 1, label: 'A' }, { column: 1, label: 'B' }], 4)).toBe(' A');
  });
});

describe('axisLines', () => {
  it('draws a ruler and three labels within the width', () => {
    const [ruler, labels] = axisLines(100, 200, 21, 'ms');
    expect(ruler).toHaveLength(21);
    expect(ruler.startsWith('┼')).toBe(true);
    expect(ruler.endsWith('┼')).toBe(true);
    expect(labels).toContain('100');
    expect(labels).toContain('150');
    expect(labels).toContain('200 ms');
  });

  it('gives up rather than drawing an illegible ruler', () => {
    expect(axisLines(0, 1, 3, '')).toEqual([]);
  });
});

describe('wrap', () => {
  it('breaks on words and never mid-word', () => {
    expect(wrap('one two three four', 9)).toEqual(['one two', 'three', 'four']);
  });

  it('keeps a word longer than the width on its own line', () => {
    expect(wrap('supercalifragilistic ok', 6)).toEqual(['supercalifragilistic', 'ok']);
  });
});
