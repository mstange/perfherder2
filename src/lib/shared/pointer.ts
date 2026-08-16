// What kind of pointer is driving the app, for the two decisions that turn on
// it. Pure, so both are testable without a browser: the query goes in as a
// matcher rather than being read off `window`.

export type MediaMatcher = (query: string) => { matches: boolean };

/** The real one. Only a component may call this — it touches `window`. */
export const mediaMatcher: MediaMatcher = (query) => window.matchMedia(query);

/**
 * Should a panel's text field take focus as soon as the panel opens?
 *
 * Only where the primary pointer is fine — a mouse, a trackpad, a stylus. There,
 * focusing the filter box saves the user a click and costs nothing, which is why
 * it has always done it. On a touch device it summons the on-screen keyboard,
 * which on a phone covers between a third and a half of the window: the panel
 * opens with its list behind a keyboard the user never asked for, before they
 * have decided whether they are typing or scrolling. Measured on a 390×844
 * viewport, a 336px keyboard left the list 2px tall.
 *
 * `(pointer: fine)` and not `(hover: hover)` or a touch-support test: the
 * question is what the *primary* input is, and a laptop with a touchscreen or an
 * iPad with a trackpad attached answers this one correctly in both directions.
 */
export function shouldAutofocus(match: MediaMatcher): boolean {
  return match('(pointer: fine)').matches;
}
