import { describe, expect, it } from 'vitest';
import {
  CHART_PALETTES,
  isThemePreference,
  nextThemePreference,
  parseThemePreference,
  resolveTheme,
  THEME_PREFERENCES,
} from './theme';
import { SERIES_COLORS, SERIES_COLORS_DARK, styleForIndex } from './chart';

describe('parseThemePreference', () => {
  it('accepts the three preferences', () => {
    for (const p of THEME_PREFERENCES) expect(parseThemePreference(p)).toBe(p);
  });

  it('falls back to following the system for anything else', () => {
    // A missing key, a value from a future version, and a hand-edited one all
    // land here. Falling back to "system" rather than to a fixed theme means a
    // corrupt value is invisible to a user whose OS preference we'd have
    // matched anyway.
    for (const raw of [null, undefined, '', 'Dark', 'auto', 0, {}]) {
      expect(parseThemePreference(raw)).toBe('system');
    }
  });

  it('guards the type', () => {
    expect(isThemePreference('dark')).toBe(true);
    expect(isThemePreference('darker')).toBe(false);
  });
});

describe('resolveTheme', () => {
  it('follows the system query when the preference is "system"', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('ignores the system query when a theme is forced', () => {
    // The point of forcing: a user on a dark desktop who wants this one tab
    // light must not be overridden by the OS.
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('nextThemePreference', () => {
  it('leaves "system" when the toggle disagrees with the OS', () => {
    // The only way to get an override: the user wants the theme the OS isn't
    // asking for.
    expect(nextThemePreference('system', true)).toBe('light');
    expect(nextThemePreference('system', false)).toBe('dark');
  });

  it('returns to "system" when the destination is what the OS asks for', () => {
    // Storing 'dark' here would look identical today and diverge the moment the
    // OS flips, so the preference that keeps following it wins.
    expect(nextThemePreference('light', true)).toBe('system');
    expect(nextThemePreference('dark', false)).toBe('system');
  });

  it('keeps overriding when the OS already agrees with the current theme', () => {
    // A forced light theme on a light desktop: the destination is dark, which is
    // not what the OS asks for, so it has to be stored explicitly.
    expect(nextThemePreference('light', false)).toBe('dark');
    expect(nextThemePreference('dark', true)).toBe('light');
  });

  it('always flips the resolved theme, and round-trips to "system"', () => {
    // The two properties the control's two visual states rest on: one click
    // always changes what's on screen, and two clicks always put it back —
    // without leaving a redundant override behind.
    for (const systemPrefersDark of [true, false]) {
      for (const preference of THEME_PREFERENCES) {
        const before = resolveTheme(preference, systemPrefersDark);
        const once = nextThemePreference(preference, systemPrefersDark);
        expect(resolveTheme(once, systemPrefersDark)).not.toBe(before);
        const twice = nextThemePreference(once, systemPrefersDark);
        expect(resolveTheme(twice, systemPrefersDark)).toBe(before);
      }
    }
    expect(nextThemePreference(nextThemePreference('system', true), true)).toBe('system');
    expect(nextThemePreference(nextThemePreference('system', false), false)).toBe('system');
  });
});

describe('chart palettes', () => {
  it('defines every key in both themes', () => {
    // The canvas palette is the one place a color can't fall back to a CSS
    // token, so a key missing from one theme paints `undefined` — which canvas
    // silently ignores, leaving the previous fillStyle in place.
    expect(Object.keys(CHART_PALETTES.dark).sort()).toEqual(
      Object.keys(CHART_PALETTES.light).sort(),
    );
    for (const palette of Object.values(CHART_PALETTES)) {
      for (const value of Object.values(palette)) expect(value).toMatch(/^(#|rgba?\()/);
    }
  });
});

describe('styleForIndex across themes', () => {
  it('defaults to treeherder’s palette', () => {
    // Everything that doesn't know about themes — the tests in chart.test.ts
    // that pin treeherder parity, most of all — has to keep getting the light
    // colors.
    expect(styleForIndex(0).color).toBe(SERIES_COLORS[0]);
    expect(styleForIndex(0, 'light').color).toBe(SERIES_COLORS[0]);
  });

  it('swaps the palette but not the position', () => {
    // A theme switch recolors each series in place. If the two lists were ever
    // different lengths the wrap would diverge and switching themes would
    // reshuffle which series is which color.
    expect(SERIES_COLORS_DARK).toHaveLength(SERIES_COLORS.length);
    for (let i = 0; i < 13; i++) {
      const light = styleForIndex(i, 'light');
      const dark = styleForIndex(i, 'dark');
      expect(dark.color).toBe(SERIES_COLORS_DARK[i % SERIES_COLORS_DARK.length]);
      expect(dark.symbol).toEqual(light.symbol);
    }
  });

  it('keeps the dark palette distinguishable', () => {
    expect(new Set(SERIES_COLORS_DARK).size).toBe(SERIES_COLORS_DARK.length);
  });

  it('lightens every dark-mode color enough to see on a dark canvas', () => {
    // The reason the dark palette exists: three of treeherder's six sit under
    // 2:1 against #0d1117, which is a series you cannot find on the graph. 4.5:1
    // is WCAG's text threshold; a 3px dot needs at least as much.
    for (const color of SERIES_COLORS_DARK) {
      expect(contrast(color, '#0d1117')).toBeGreaterThan(4.5);
    }
  });
});

// WCAG relative luminance and contrast ratio, for the assertion above.
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
