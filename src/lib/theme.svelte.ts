// The app-wide theme, as one reactive singleton.
//
// A singleton rather than something threaded down from App.svelte because the
// theme is read in two places that have no props relationship: the CSS (via an
// attribute on `<html>`) and AppState's series colors. Passing it into AppState
// would make every test construct one, and passing it into the charts would
// mean five components forwarding a prop they don't use themselves.
//
// See theme.ts for the resolution rule and the canvas palette.

import {
  CHART_PALETTES,
  parseThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ChartPalette,
  type Theme,
  type ThemePreference,
} from './theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

class ThemeController {
  #preference = $state<ThemePreference>('system');
  #systemPrefersDark = $state(false);

  readonly resolved: Theme = $derived(resolveTheme(this.#preference, this.#systemPrefersDark));
  readonly chartPalette: ChartPalette = $derived(CHART_PALETTES[this.resolved]);

  get preference(): ThemePreference {
    return this.#preference;
  }

  constructor() {
    this.#preference = parseThemePreference(readStored());
    const query = matchDark();
    if (query) {
      this.#systemPrefersDark = query.matches;
      // No teardown: the singleton lives as long as the document does, so
      // there is no lifetime to tie the listener to.
      query.addEventListener('change', (e) => {
        this.#systemPrefersDark = e.matches;
        this.#apply();
      });
    }
    this.#apply();
  }

  setPreference(preference: ThemePreference): void {
    this.#preference = preference;
    writeStored(preference);
    this.#apply();
  }

  // Applied imperatively from the three places that can change the outcome,
  // rather than from an `$effect`: effects only run inside a component or an
  // `$effect.root`, and this module is neither. It also means the attribute is
  // already correct when the caller returns, so a canvas repaint in the same
  // task can't read a stale one.
  #apply(): void {
    document.documentElement?.setAttribute('data-theme', this.resolved);
  }
}

function matchDark(): MediaQueryList | null {
  // `matchMedia` is missing under some test environments and in JSDOM-alikes;
  // its absence just means "no OS preference to follow".
  return typeof matchMedia === 'function' ? matchMedia(DARK_QUERY) : null;
}

// localStorage throws rather than no-ops when a browser has storage blocked
// (Safari's private mode historically, enterprise policy today). A theme
// preference is not worth taking the app down for, so both ends swallow it: the
// session simply doesn't remember the choice.
function readStored(): string | null {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStored(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Ignored; see above.
  }
}

export const theme = new ThemeController();
