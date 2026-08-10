# CLAUDE.md

Project-specific instructions for Claude Code.

**Read [docs/design.md](docs/design.md) first**, starting with its "Which
document" map — it routes to the right file for the area you're touching, and
its second table lists the changes that have gone wrong before and the section
that explains each. It has the *why* behind non-obvious choices, and every
non-trivial change should be checked against it.

## Answering performance questions: use `bin/perfherder-cli`, not the source

**When you are asked a question *about Firefox performance data* — how two
browsers compare, when something regressed, what caused a step, what a
distribution looks like — run `./bin/perfherder-cli`. Do not read this codebase to
work out what URL the UI would build, and do not hand-write `curl` calls
against treeherder.** The CLI is built from the same `src/lib` modules the app
runs, so its answers are the app's answers, and it does the parts that are easy
to get wrong (which alerts to hide, which threshold a subtest inherits, why a
push mean is not a pooled replicate) already.

```sh
./bin/perfherder-cli --help              # commands and worked examples
./bin/perfherder-cli <command> --help    # one command's options
```

Typical shape of an investigation:

```sh
# 1. Find the signature. The first column is the ref every other command takes.
./bin/perfherder-cli search speedometer3 android --repo mozilla-central

# 2. Levels over a window — this is the "A vs B" answer.
./bin/perfherder-cli series mozilla-central,270490 mozilla-central,230167 --range 60d

# 3. When did it move, and what landed?
./bin/perfherder-cli changes autoland,5350953 --range 6mo --commits

# 4. What kind of change was it? Statistics, distributions, and whether the
#    modes moved or just their weights.
./bin/perfherder-cli compare autoland,5350953@<beforeRev> <afterRev> --range 6mo

# 5. Which subtests drove a suite-level move, and did other platforms see it?
./bin/perfherder-cli search --parent autoland,5352597 --limit 100
./bin/perfherder-cli step <subtest refs...> --at <rev> --range 60d
```

**`step` is the one to reach for when `changes` says nothing on a platform you
expected it to.** A quiet graph is often an under-sampled one, not an unaffected
one, and `step` measures the move at a point you name and reports which of the
detector's bars it failed.

Notes that save a round trip:

- A ref is `<repo>,<signatureId>` — the framework id is optional and is
  discovered from the response. The three-field form is what a `series=`
  parameter in the app's URL contains, so refs paste both ways.
- Responses are cached on disk, so iterating a search is cheap. `--no-cache`
  when you need it fresh.
- `--json` gives the same object the text was rendered from, for piping.
- Every command prints a link into the app. Include it when reporting a
  finding — it is how the human checks you.
- If the tool can't express the question, that is worth saying, and possibly
  worth a new command. Read [docs/cli.md](docs/cli.md) first.

## Working style for this repo

- **VCS is jj.** Commit with `jj commit -m "…"`, one logical change per
  commit. Descriptive first-line summary, blank line, then rationale.
- **Pure logic goes in `src/lib/picker/filter.ts` (or a similar module) and gets
  a unit test in `filter.test.ts`.** Do not add business logic to
  `.svelte` files if it can live in a testable pure function. The same rule
  runs through `src/cli`: fetching and printing live in `main.ts`, and
  everything that decides what an answer *is* lives in a pure module beside
  it with a test.
- **Run `npm run check` and `npm test` before commits.** Both must be
  clean. `npm run build` and `npm run build:cli` must also succeed. These are
  the four steps `.github/workflows/ci.yml` runs, so a green local run means a
  green CI run.
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
