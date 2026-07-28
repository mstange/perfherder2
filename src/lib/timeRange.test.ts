import { describe, expect, it } from 'vitest';
import {
  clampSpan,
  describeSpan,
  defaultSpan,
  DEFAULT_RANGE_SECONDS,
  matchingPreset,
  presetSpan,
  RANGE_PRESETS,
} from './timeRange';

const DAY = 86400000;
const MINUTE = 60000;
const NOW = Date.UTC(2026, 6, 27, 12, 34, 56);

describe('presetSpan', () => {
  it('snaps the end up to the minute so the URL is stable', () => {
    const span = presetSpan(7 * 86400, NOW);
    expect(span.end % MINUTE).toBe(0);
    expect(span.end).toBeGreaterThanOrEqual(NOW);
    expect(span.end - span.start).toBe(7 * DAY);
  });

  it('defaults to 14 days, matching perfherder', () => {
    expect(DEFAULT_RANGE_SECONDS).toBe(14 * 86400);
    expect(defaultSpan(NOW).end - defaultSpan(NOW).start).toBe(14 * DAY);
  });
});

describe('matchingPreset', () => {
  it('recognizes a span it just produced', () => {
    for (const preset of RANGE_PRESETS) {
      expect(matchingPreset(presetSpan(preset.seconds, NOW), NOW)?.label).toBe(preset.label);
    }
  });

  it('still recognizes it a couple of minutes later', () => {
    const span = presetSpan(7 * 86400, NOW);
    expect(matchingPreset(span, NOW + 3 * MINUTE)?.label).toBe('7 days');
  });

  it('stops recognizing it once the end is well in the past', () => {
    const span = presetSpan(7 * 86400, NOW);
    expect(matchingPreset(span, NOW + 2 * DAY)).toBeNull();
  });

  it('returns null for a hand-picked span that matches no preset', () => {
    expect(matchingPreset({ start: NOW - 3 * DAY, end: NOW }, NOW)).toBeNull();
  });
});

describe('describeSpan', () => {
  it('omits the year when the span is inside the current one', () => {
    const s = { start: Date.UTC(2026, 6, 14, 12), end: Date.UTC(2026, 6, 28, 12) };
    expect(describeSpan(s, NOW)).not.toMatch(/2026/);
  });

  it('includes the year when the span reaches into another one', () => {
    const s = { start: Date.UTC(2025, 11, 20, 12), end: Date.UTC(2026, 0, 5, 12) };
    expect(describeSpan(s, NOW)).toMatch(/2025/);
  });
});

describe('clampSpan', () => {
  const outer = { start: 100, end: 200 };

  it('clips an overhanging inner span', () => {
    expect(clampSpan({ start: 50, end: 150 }, outer)).toEqual({ start: 100, end: 150 });
  });

  it('returns null when the inner span covers the outer one', () => {
    expect(clampSpan({ start: 0, end: 500 }, outer)).toBeNull();
  });

  it('returns null when the spans do not overlap', () => {
    expect(clampSpan({ start: 300, end: 400 }, outer)).toBeNull();
  });
});
