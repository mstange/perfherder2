# CLAUDE.md

Project-specific instructions for Claude Code.

**Read [docs/design.md](docs/design.md) first.** It has the *why* behind
non-obvious choices (cache-fallback preference, filter model, layout
constraints, Svelte whitespace gotcha, Perfherder data quirks). Every
non-trivial change should be checked against that document.

## Working style for this repo

- **VCS is jj.** Commit with `jj commit -m "…"`, one logical change per
  commit. Descriptive first-line summary, blank line, then rationale.
- **Pure logic goes in `src/lib/filter.ts` (or a similar module) and gets
  a unit test in `filter.test.ts`.** Do not add business logic to
  `.svelte` files if it can live in a testable pure function.
- **Run `npm run check` and `npm test` before commits.** Both must be
  clean. `npm run build` must also succeed. These are the three steps
  `.github/workflows/ci.yml` runs, so a green local run means a green CI
  run.
- **No committed browser tests.** During development, spawn puppeteer for
  smoke tests, then uninstall it before committing so `package.json`
  stays lean. See docs/design.md for the pattern.
- **Layout stability matters.** New UI must not shift when data loads or
  when the user first interacts with it. Budget space for loading and
  empty states from the start.
- **No hardcoded colors.** Every color comes from a custom property in
  `src/app.css`, which defines both themes. A literal hex in a component
  is a color that only exists in one of them. The graphs' canvas palette
  is the documented exception — see "Theming" in docs/design.md.

## What this project is

A Svelte 5 SPA reimplementing Perfherder's "Add series" dialog with one
flat, searchable list across repos. Fetches directly from
`treeherder.mozilla.org` (CORS is `*`).
