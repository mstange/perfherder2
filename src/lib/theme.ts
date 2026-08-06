// Theming: the vocabulary, the resolution rule, and the one palette that can't
// live in CSS.
//
// Everything the *document* is painted with comes from custom properties in
// src/app.css, switched by a `data-theme` attribute on `<html>`. That attribute
// always holds a resolved theme — "light" or "dark", never "system" — because
// the OS query is answered here, in JS, rather than by a media query in the
// stylesheet. Resolving in exactly one place is what lets the canvas palette
// below and the CSS tokens agree about which theme is in effect; a `@media
// (prefers-color-scheme: dark)` block would be a second, independent answer to
// the same question, and forcing a theme would have to override it.
//
// See theme.svelte.ts for the reactive controller that owns the preference, and
// the inline script in index.html that applies it before first paint.

export type Theme = 'light' | 'dark';

// What the user picked. "system" is the default and is *not* rewritten to the
// theme it currently resolves to — a stored "dark" would stop following the OS.
export type ThemePreference = 'system' | Theme;

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];

export const THEME_STORAGE_KEY = 'perfherder2:theme';

export function isThemePreference(value: unknown): value is ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference);
}

// Anything unrecognised — absent key, a value from a future version, a user who
// edited localStorage — falls back to following the OS rather than to a guess.
export function parseThemePreference(raw: unknown): ThemePreference {
  return isThemePreference(raw) ? raw : 'system';
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): Theme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

// What flipping the toggle should store, given what's on screen now.
//
// The control shows the *resolved* theme and switches to the other one, so the
// destination is never in doubt. The subtlety is which preference expresses it:
// when the destination is what the OS asks for, "system" and the explicit theme
// look identical today but not tomorrow, and the one that keeps following the OS
// is the better default. So an override only gets stored when it actually
// overrides something — which also means the round trip
// light → dark → light lands back on "system" rather than leaving a redundant
// override behind. See https://lea.verou.me/blog/2026/dark-mode-toggles/.
export function nextThemePreference(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ThemePreference {
  const resolved = resolveTheme(preference, systemPrefersDark);
  const destination: Theme = resolved === 'dark' ? 'light' : 'dark';
  const systemTheme: Theme = systemPrefersDark ? 'dark' : 'light';
  return destination === systemTheme ? 'system' : destination;
}

// ---------------------------------------------------------------------------
// Canvas palette
// ---------------------------------------------------------------------------

// The graphs paint onto a canvas, so their colors can't be custom properties:
// there is no element to inherit them, and reading them back out with
// getComputedStyle would make the draw functions depend on the DOM and on the
// attribute having already been applied. They're plain values passed into the
// draw calls instead, which also keeps chartDraw.ts and distributionDraw.ts
// pure enough to reason about.
//
// The cost is that these duplicate their CSS counterparts. They are the only
// colors in the app that exist twice, and each line names the token it mirrors
// so a change to one is a visible prompt to change the other.
export type ChartPalette = {
  axis: string; // --border-default
  grid: string; // --bg-inset
  text: string; // --fg-muted
  ring: string; // --fg-default — the outline around a selected/compared dot
  rowTint: string; // --bg-subtle — the distribution chart's second strip row
  brushDim: string; // dims the overview outside the zoomed window
  brushLine: string; // --accent-emphasis — the brush edges and handles
  // Alert markers. Red and green rather than the series color, because what an
  // alert marker says is "a sheriff-visible change happened here, in this
  // direction" — a fact about the push, not about which line it belongs to. The
  // series color is still on the marker's outline.
  alertRegression: string; // --danger-fg
  alertImprovement: string; // --success-fg
};

export const CHART_PALETTES: Record<Theme, ChartPalette> = {
  light: {
    axis: '#d0d7de',
    grid: '#eef1f4',
    text: '#57606a',
    ring: '#1f2328',
    rowTint: '#f6f8fa',
    brushDim: 'rgba(31, 35, 40, 0.1)',
    brushLine: '#0969da',
    alertRegression: '#cf222e',
    alertImprovement: '#116329',
  },
  dark: {
    axis: '#3d444d',
    grid: '#21262d',
    text: '#9198a1',
    ring: '#e6edf3',
    rowTint: '#161b22',
    // Darkens rather than lightens, same as the light theme: "outside the
    // window" has to read as receding, and a white veil over a dark plot makes
    // the excluded region the brightest thing on the chart.
    brushDim: 'rgba(1, 4, 9, 0.5)',
    brushLine: '#4493f8',
    alertRegression: '#f85149',
    alertImprovement: '#3fb950',
  },
};
