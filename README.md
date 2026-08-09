# perfherder2

A client-side reimplementation of Mozilla's [Perfherder](https://treeherder.mozilla.org/perfherder/graphs)
performance-graphs UI, built with Svelte 5 and Vite.

It talks to `treeherder.mozilla.org` directly — that API sends
`access-control-allow-origin: *`, so there is no backend of our own.

## What it does

**Add series.** One flat, searchable list across repos instead of Perfherder's
framework → repo → platform → suite drill-down. Type free text, or
`field:value` tokens (`repo:autoland`, `option:fission`), or click any badge in
the table to toggle the corresponding filter. Expand a row to reach its
subtests.

**Graphs.** Three panes:

- **Left** — the plotted series. Their order decides both the legend order and
  the colors, and can be changed.
- **Middle** — a thin overview graph over the full time range, and below it the
  detail graph. Drag on the overview to zoom; drag the window's edges to
  resize it or its middle to slide it. The detail graph zooms on a drag too,
  and resets on a double-click.
- **Right** — everything about the point you clicked, grouped the way the data
  is: the replicate's value (and its siblings from the same run), the run/job
  that produced it, and the build/push it came from, with links out to
  treeherder, the pushlog and Bugzilla.

Replicates are plotted individually by default — one dot per replicate value,
not one per run. The **Replicates** checkbox above the graphs collapses each
run to a single dot at its mean, which is much easier to read on a long range.
Either way replicates are fetched, so the toggle is instant and the right-hand
pane still lists a run's individual values.

**A command line.** `bin/perfherder` answers the same questions without a
browser, built from the same modules — search for signatures, summarize and
compare series over a range, list the steps this app detects alongside
perfherder's alerts and the commits that caused them, and compare two pushes
with the statistics and the mode analysis the details pane shows, and measure a
known change across several series at once. Every command prints a link back
into the app.

```sh
./bin/perfherder search speedometer3 android
./bin/perfherder changes autoland,5350953 --range 6mo --commits
./bin/perfherder compare autoland,5350953@c6d6d959a537 4138203b7be1
./bin/perfherder step autoland,5352617 autoland,5690973 --at 080629dcb120
```

**The URL is the view.** Series and their order, the absolute time range, the
zoom, the selected point and the picker's state all live in the query string,
so any view can be linked. The range is stored as absolute timestamps rather
than "last 14 days" precisely so that a linked data point can't drift out of
view as time passes.

## Development

```sh
npm install
npm run dev       # vite dev server
npm run check     # svelte-check (types + a11y), and tsc over the vite and CLI configs
npm test          # vitest, pure-logic unit tests
npm run build
npm run build:cli # dist-cli/perfherder.mjs; bin/perfherder does this for you when stale
```

The last four must all be clean; [.github/workflows/ci.yml](.github/workflows/ci.yml)
runs exactly those, in that order, on every push and pull request.

## Where to read next

- [docs/design.md](docs/design.md) — the picker: filter model, caching,
  virtual scrolling, and the Perfherder data-model quirks that bit us.
- [docs/graphs.md](docs/graphs.md) — the graphs: API quirks, the
  push/run/replicate model, rendering, URL state, and every deliberate
  deviation from treeherder.
- [docs/cli.md](docs/cli.md) — the `bin/perfherder` command line: its
  commands, its cache, and the two things it adds that the app answers with a
  picture instead of in words.
- [docs/graphs-todo.md](docs/graphs-todo.md) — what's next and what's
  deferred.

Both design docs are meant to be read before making non-trivial changes;
they record the *why* behind things that look arbitrary.

## License

[Mozilla Public License 2.0](LICENSE.txt), the same license as
[treeherder](https://github.com/mozilla/treeherder) itself. The license
applies to every file in the repository unless a file states otherwise.

This project is governed by Mozilla's
[Community Participation Guidelines](CODE_OF_CONDUCT.md).
