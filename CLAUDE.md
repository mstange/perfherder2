# CLAUDE.md

Project-specific instructions for Claude Code.

**Read [docs/design.md](docs/design.md) first.** It has the *why* behind
non-obvious choices (cache-fallback preference, filter model, layout
constraints, Svelte whitespace gotcha, Perfherder data quirks). Every
non-trivial change should be checked against that document.

## Working style for this repo

- **VCS is jj.** Commit with `jj commit -m "…"`, one logical change per
  commit. Descriptive first-line summary, blank line, then rationale.
- **Pure logic goes in `src/lib/picker/filter.ts` (or a similar module) and gets
  a unit test in `filter.test.ts`.** Do not add business logic to
  `.svelte` files if it can live in a testable pure function.
- **Run `npm run check` and `npm test` before commits.** Both must be
  clean. `npm run build` must also succeed. These are the three steps
  `.github/workflows/ci.yml` runs, so a green local run means a green CI
  run.
- **No committed browser tests.** Smoke-test in a browser from
  `tools/visual/`, which is gitignored and carries **its own** puppeteer
  install. Write a `.mjs` there, run it against `npm run dev` with
  `node tools/visual/whatever.mjs`, delete it or leave it. Leave the
  install alone either way — being gitignored, it is meant to persist
  between sessions (`npm i puppeteer --prefix tools/visual` if it's ever
  missing). Never install puppeteer into the app's `package.json`, not
  even temporarily: it pulls a ~200 MB Chromium CI has no use for, and
  the install/uninstall cycle rewrites the root lockfile. See
  docs/design.md, "Measuring".
- **Layout stability matters.** New UI must not shift when data loads or
  when the user first interacts with it. Budget space for loading and
  empty states from the start.
- **No hardcoded colors.** Every color comes from a custom property in
  `src/app.css`, which defines both themes. A literal hex in a component
  is a color that only exists in one of them. Two documented exceptions,
  both of which can't reach a custom property: the graphs' canvas palette
  (see "Theming" in docs/design.md) and `public/favicon.svg`.
- **Plain buttons use `.btn` from `src/app.css`**, plus `.btn-compact` /
  `.btn-primary` / `.btn-confirm`. Don't re-declare border, radius, fill,
  hover or disabled in a component — that recipe was copied five times and
  drifted five ways. Bespoke buttons (badges, swatches, icon toggles) skip
  `.btn` entirely; see "One button, defined once" in docs/design.md.

## What this project is

A Svelte 5 SPA reimplementing Perfherder's "Add series" dialog with one
flat, searchable list across repos. Fetches directly from
`treeherder.mozilla.org` (CORS is `*`).
