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

Replicates are always plotted — one dot per replicate value, not one per run.

**The URL is the view.** Series and their order, the absolute time range, the
zoom, the selected point and the picker's state all live in the query string,
so any view can be linked. The range is stored as absolute timestamps rather
than "last 14 days" precisely so that a linked data point can't drift out of
view as time passes.

## Development

```sh
npm install
npm run dev      # vite dev server
npm test         # vitest, pure-logic unit tests
npx svelte-check # types + a11y; must be clean
npm run build
```

## Where to read next

- [docs/design.md](docs/design.md) — the picker: filter model, caching,
  virtual scrolling, and the Perfherder data-model quirks that bit us.
- [docs/graphs.md](docs/graphs.md) — the graphs: API quirks, the
  push/run/replicate model, rendering, URL state, and every deliberate
  deviation from treeherder.
- [docs/graphs-todo.md](docs/graphs-todo.md) — what's next and what's
  deferred.

Both design docs are meant to be read before making non-trivial changes;
they record the *why* behind things that look arbitrary.
