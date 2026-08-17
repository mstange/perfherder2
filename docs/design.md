# Design notes

Read this before making non-trivial changes. It captures the *why* behind
choices that aren't obvious from the code, and warns about gotchas that have
already burned us once.

## Which document

This file is two things: the **app-wide conventions** every change has to
obey, and the **picker** — the "Add series" panel. The graphs half of the app
is documented elsewhere.

| Looking for | Go to |
| --- | --- |
| The picker: filtering, sorting, badges, virtual scrolling, run activity | this file |
| Conventions: theming, buttons, layout stability, response validation, testing, measuring | this file, "Key design decisions" onward |
| The graphs view: panes, fetch, the run/replicate hierarchy, canvas drawing, alerts, detected changes, the drift figure and trend band | [graphs.md](graphs.md) |
| What the details pane does with a selection: distributions, comparison mode, statistics | [comparison.md](comparison.md) |
| The `bin/perfherder-cli` CLI: its commands, its caching, the mode analysis it adds, and how it is published | [cli.md](cli.md) |
| What's built, what's next, what was deliberately deferred and why | [graphs-todo.md](graphs-todo.md) for the app, [cli-todo.md](cli-todo.md) for the CLI |
| What we assume about treeherder that it never promised, and what it looks like when one of those assumptions breaks | [api-assumptions.md](api-assumptions.md) — read it before depending on a new endpoint, and when a display is subtly wrong for no reason the diff explains |
| Which module owns a thing | "Architecture" below, graphs.md "Code map", comparison.md "Code map", cli.md "Code map" |

**If you touch X, read Y first.** Each of these is a place where the obvious
change is wrong for a reason the code doesn't show:

| Changing | Read |
| --- | --- |
| A URL parameter | three sections that have to agree: "Architecture" below (`urlState.ts` owns the whole schema), graphs.md "URL state", comparison.md "URL state" |
| `FilterInput.svelte`, or anything holding filter state | "The one component that owns state" — this has bitten us twice |
| When the picker's filter gets written for the user | "Opening the picker prefills its filter" and "Deriving the filter, and clearing it" — deciding *when* to overwrite a filter by inspecting it has been wrong once already; the rule is now one `isFilterActive` check plus a button |
| Adding a control above the picker's list, or to the graph header | "The control block is two groups: what loads, and what shows" (and "A panel with no room for the loading group folds it away" — which group a control joins decides whether it survives a small panel, and nothing in the middle column may carry a `min-width`) — which row it goes on follows from whether it fetches, and the last arrangement that was decided by eye put two controls in each other's group. Both blocks share `.control-*` in `src/app.css`; the header's own departures are in graphs.md, "The header is two groups" |
| Markup with two adjacent badges | "Whitespace between adjacent badges (Svelte gotcha)" |
| A color, anywhere | "Theming: one resolved attribute, one exception" — there are exactly two, and neither is new |
| A button | "One button, defined once", and "Touch: a floor under the controls a thumb drives" if it is smaller than `.btn` |
| A size for a control, or an instruction naming a click or a key | "Touch: a floor under the controls a thumb drives, and copy that names a gesture the reader has" — the floor is **one number, 32**, in one `pointer: coarse` block in app.css, and raising it is how three now-deleted workaround rules got written the first time; also: neither a media query nor a `@container` query adds any specificity (so both go *after* what they override, and four rules have been silently dead for this), a scoped `font: inherit` outranks the global rule, and a control that isn't a `.btn` gets no floor at all until someone writes one for it |
| A spinner, a skeleton, or any "still loading" mark | "Two loading cues, and which wait each one is for" — there are two classes in app.css, the choice between them is what the wait *is*, and a third hand-rolled one is the mistake |
| A hover explanation | "Tooltips: for what the canvas paints". Ordinary controls use `title`; the drawn box is for the marks in the graph's canvas, which have no element to hang one on |
| A percentage or a delta in the details pane | graphs.md, "The three change cards say it the same way" — one component draws all three headlines, and the sign is the measurement's, never the verdict's |
| Anything that renders before its data arrives | "Layout stability" |
| A text field that takes focus, or anything sized to the window's height | "The on-screen keyboard has to take height from the app, not cover it" — `100dvh` is not what a keyboard shrinks, and an autofocus is a keyboard nobody asked for |
| Where a pane sits, how wide it is, or a border between two panes | "The shell has four arrangements, and the graph keeps its size" — there are four, the thresholds are computed from the pane sizes in `shared/layout.ts` rather than chosen, a pane that draws its own border draws a doubled one as soon as the arrangement moves it, and **below `wide` the series list is not a pane at all** but a sheet behind the bottom bar's button. Read that section's "The pane that stops being a pane is the series list" before adding a tier or moving a pane: two tiers were deleted for paying the list's 280px column out of the graph's *height*, and one of them was why an iPad in landscape could only show the graph or the selection |
| An animation, or the series sheet's presentation | "The sheet rises from the handle and leaves it on screen" — a sheet that took the whole window with no motion, no shadow and no dim read as a *page*, and the fix is five cues rather than any one of them. Two mechanisms animate the shell (CSS `@starting-style` for the always-mounted sheet, Svelte transitions for the `{#if}`-mounted panel) and they duplicate one duration between `MOTION_MS` and `--sheet-motion`. The sheet must not cover the bar: that is what makes the handle its own dismissal |
| A fetch, or a new endpoint | "Validating API responses" and [api-assumptions.md](api-assumptions.md); plus "Cache key" if the result is cached, and "The picker's caches live at module scope" if it is the picker doing the fetching — a cache on `PickerState` does not survive the panel closing |
| `SeriesMeta`, or anything that reads a series' metadata | "Two endpoints describe a series" below. It arrives from one of two responses, `source` says which, and two of its fields are answerable by only one of them — api-assumptions.md, "Two null fields mean different things depending on `source`" |
| A treeherder *list* endpoint | its default page is 10 rows and truncation is silent — a partial answer is shaped exactly like a complete one. comparison.md, "The inline pushlog", and the `getCommonAlerts` note in graphs-todo.md |
| How a row is identified | "Row identity: `Series.key`, composed at construction" |
| A loading or empty state for subtests | "`has_subtests` is a claim, not a promise" — `has_subtests` does not mean a subtests=1 fetch will return any |
| Canvas drawing | graphs.md "Rendering" and "Dots are translucent, and jittered sideways" |
| The change detector's constants | graphs.md "Detected changes", and the reasoning and measurements recorded beside each constant in `changes.ts`. **Open the graph first**: graphs.md "The series behind the tuning" is a table of URLs, one per signature those constants were measured on, and every constant that has been wrong was wrong because it was reasoned about instead of loaded. `drift.ts` borrows the floor and `CHANGE_ALPHA` too, so a change moves the series-list drift badge as well as the bars |
| A statistic | comparison.md "Statistics" and "Deviations from PerfCompare" |
| A row in the picker's list, or the virtualizer's row height | "A panel a phone wide lists cards, not columns" — there are two row layouts over one flat list, three snippets are shared by both, and every row in the list has to be exactly `rowHeight` tall, notes included |
| Anything under `src/lib` | cli.md — `bin/perfherder-cli` is built from the same modules, so a change here changes its answers too, and it is checked by a third tsconfig `npm run check` runs |

## What this is

A Svelte 5 SPA that reimplements Treeherder Perfherder's "Add series" dialog
with one big flat list instead of a harness → platform → suite drill-down.
The user types free text and clicks badges; the list narrows.

The whole app is client-side. Signatures are fetched directly from
`treeherder.mozilla.org` — its API has `access-control-allow-origin: *`, so
we don't need a backend proxy. **If Mozilla ever tightens CORS, this
architecture breaks.**

## Architecture

### Layout

```
src/lib/
  shared/   http, links, chart, layout, stats, pointer, theme(+.svelte,
            ThemeToggle), timeRange, tooltip(+State.svelte, Tooltip),
            ChevronIcon, CrossIcon
  picker/   the Add-series panel: signaturesApi, series, pickerOptions, filter,
            activity(+Api), pickerState.svelte, AddSeriesPicker, FilterInput
  graphs/   the graphs view and its two side panes: graphApi, graphData,
            alerts(+Api), appState.svelte, chartDraw, ScatterChart, GraphPane,
            SeriesList, seriesSummary, reorder, and the details pane's
            compare, distribution(+Draw), kde, DistributionChart, DetailsPane,
            ComparisonSection, detailsPane.css
  urlState.ts   the whole app's URL schema — it names picker state and graph
                state alike, so it sits above both rather than inside either
  schema.test.ts + fixtures/   recorded payloads for both halves
```

Two things this layout is claiming, both of which were checked against the
import graph rather than assumed:

- **Dependencies run feature → shared, and `graphs` → `picker` but never
  back.** There are five edges into the picker, in two groups. Two are
  `appState` and `seriesSummary` reaching for `filter.ts`, which is the
  graph's context reaching the panel — as a prefill on open and as its
  "Derive filter" button (see "Opening the picker prefills its filter"). The
  `GraphContext` they meet over is declared in `urlState.ts` for exactly this
  reason: either feature owning it would be an edge one way or the other.
  The other three are the graphs view fetching a signature's *identity* before
  its data (see "Two endpoints describe a series"): `appState` and
  `graphData` reach for `signaturesApi.ts`, whose endpoint and row schema are
  not picker-specific, and `appState` reaches for `activity.ts`'s
  `chunkIds` / `MAX_IDS_PER_REQUEST`, which are a fact about treeherder's
  request-line limit rather than about the picker. **Those two are the ones
  to watch**: if a third feature ever wants the signature endpoint, or if
  `signaturesApi.ts` starts importing picker state, the fix is to move it to
  `shared/` — not to copy its schema, which would be two schemas for one
  endpoint. There is
  exactly one edge the wrong way: `shared/chart.ts` imports the `SeriesPoint`
  *type* from `graphs/graphData.ts`, because some of its helpers plot points while
  the rest (formatting, `padDomain`, `Range`) are generic and the details
  pane's distributions use them. Type-only, so nothing pulls at runtime. If
  it ever grows, the fix is to split the graph-point helpers out of chart.ts,
  not to move chart.ts into `graphs/`.
- **The details pane is part of the graphs view, not a third feature.** It
  was tried as its own folder and produced a cycle in both directions —
  `appState` builds the comparison, and `DetailsPane`/`compare` read
  `graphData` and `alerts`. Two halves of one view, so one folder.

### The modules worth knowing about

- [src/lib/shared/http.ts](../src/lib/shared/http.ts) — the only place that calls `fetch`.
  Validates every response against a valibot schema; see "Validating API
  responses" below. `HttpError` and `SchemaError` both keep their messages
  short enough for an error banner.
- [src/lib/picker/signaturesApi.ts](../src/lib/picker/signaturesApi.ts) — schemas +
  inferred types and the network calls for the signature endpoints.
- [src/lib/picker/series.ts](../src/lib/picker/series.ts) — **pure logic**. `Series`, the
  row the picker renders, and `toSeries` (raw signature → enriched `Series`).
  Framework map + option-collection map are fetched once and passed in.
  `toSeries` bakes `Series.key` (`${repo}|${id}`) and `Series.parentKey` in at
  construction, so callers never recompose the compound identity — using
  `signatureHash` alone would collide across repos. Unit-tested.
  (Transport and domain are separate here for the same reason as
  graphApi/graphData, alertsApi/alerts and activityApi/activity: the
  projection is the part worth testing from a fixture, and it shouldn't drag
  a fetch client into the import graph of everything that names a `Series`.)
- [src/lib/picker/pickerOptions.ts](../src/lib/picker/pickerOptions.ts) — the repo and
  time-range choices the panel offers. Neither is discovered from the API;
  both mirror Perfherder's own Graphs view.
- [src/lib/picker/fetchStore.ts](../src/lib/picker/fetchStore.ts) — **pure logic**.
  A keyed cache with a TTL, a bound and in-flight dedupe. Exists because the
  picker is unmounted every time the panel closes, so a cache on
  `PickerState` doesn't survive it; the instances are module scope in
  `pickerState.svelte.ts`. Unit-tested. See "The picker's caches live at
  module scope, because the picker doesn't".
- [src/lib/graphs/reorder.ts](../src/lib/graphs/reorder.ts) — **pure logic**. Drag
  geometry for the series list: drop index, per-card offsets, auto-scroll
  ramp. Unit-tested.
- [src/lib/graphs/seriesSummary.ts](../src/lib/graphs/seriesSummary.ts) — **pure logic**.
  Splits a list of series into the attributes they all share and the ones
  that distinguish each, and names the page from the shared half; see "The
  series list shows differences, not descriptions" below. Unit-tested.
- [src/lib/shared/theme.ts](../src/lib/shared/theme.ts) — **pure logic**. The theme
  vocabulary, the preference→theme resolution rule, and the canvas palette
  that can't live in CSS; see "Theming" below.
  [theme.svelte.ts](../src/lib/shared/theme.svelte.ts) is the reactive singleton
  around it.
- [src/lib/shared/tooltip.ts](../src/lib/shared/tooltip.ts) — **pure logic**. What a
  drawn tooltip says (`TooltipContent`) and where the box goes (`placeTooltip`),
  including the width cap that has to be settled before the position is.
  Unit-tested. [tooltipState.svelte.ts](../src/lib/shared/tooltipState.svelte.ts) is
  the reactive singleton and [Tooltip.svelte](../src/lib/shared/Tooltip.svelte) the
  one box on screen. **Only the graph's canvas marks use this**; see "Tooltips"
  below.
- [src/lib/picker/filter.ts](../src/lib/picker/filter.ts) — **pure logic**. Filter
  model (chips + free text), `matchesRow`, sort comparator, cache-key +
  fallback picker, child grouping. Unit-tested.
- [src/lib/picker/pickerState.svelte.ts](../src/lib/picker/pickerState.svelte.ts) — the
  reactive core of the picker: a `PickerState` class holding every
  `$state` cell, the `$derived` graph, the `$effect` that triggers
  fetches, and the mutation methods. No template code lives here, so
  every seam is exercisable without a DOM.
- [src/lib/picker/FilterInput.svelte](../src/lib/picker/FilterInput.svelte) — the chip +
  text input widget. Owns its in-progress text value; publishes committed
  chips + residual text upward via `onchange`. **That local copy is the
  only piece of filter state not rendered straight from the prop, and it
  has bitten us twice** — see "The one component that owns state" below.
- [src/lib/picker/AddSeriesPicker.svelte](../src/lib/picker/AddSeriesPicker.svelte) —
  a thin renderer over `PickerState`. Instantiates the class and wires
  DOM events to its methods; adds no reactive state of its own.
- [src/App.svelte](../src/App.svelte) — thin host.

**State ownership rule.** All shared UI state (filter, sort, cache,
selection, expansion) lives on the `PickerState` instance created by
`AddSeriesPicker.svelte`. `FilterInput.svelte` is dumb — the only local
state it has is the in-progress `textValue`, so mid-typing parses
don't round-trip through the parent on every keystroke.

## Data flow

```
User controls                              Fetch state
─────────────                              ───────────
selectedRepos      ─┐         seriesCache: Map<key, Series[]>
timeRangeSeconds   ─┼→ $effect ─→ loadRepo() per missing key
needSubtestsFetch  ─┘            key = "repo|subtests|interval"
  (derived from matchSubtests
   or any manual expansion)

Rendering pipeline
──────────────────
combined      = union of pickCachedForRepo(cache, repo, interval) for repo in selectedRepos
                (prefers subtests=1 cache; falls back to subtests=0)
                ↓
filteredParents = combined.filter(!isSubtest && matchesRow(row, filter))
                          .sort(compareRows(_, _, sort))
                ↓
flatRows       = parents ⊕ (expanded parents' children / notes) — a flat list
                 the virtual scroller windows into.
```

## Key design decisions

### One big fetch instead of dropdown-driven fetches

Perfherder makes you pick framework → repo → platform before showing any
tests. This wastes clicks when you already know the suite name and don't
care about the harness. Measured fetch numbers (14-day interval):

| Repo | no subtests | with subtests |
|---|---|---|
| autoland | 4.1 MB / 0.3 s | 12.2 MB / 0.8 s |
| mozilla-central | 5.3 MB / 0.5 s | 18.7 MB / 1.0 s |
| mozilla-beta | 2.7 MB / 0.3 s | 5.6 MB / 0.5 s |
| try | 6.9 MB / 0.6 s | 22.6 MB / 0.9 s |

Default view (central + autoland, no subtests) is ~9 MB / ~0.5 s parallel.
Fetches are cheap enough that this approach is viable. **If the API ever
gets much slower or larger, revisit this trade-off.**

### Cache key: `repo|subtests|interval`, with a fallback preference

The cache is keyed by the tuple that identifies a distinct API response.
Toggling "Match inside subtests" naively switches the lookup key and would
blank the list until the fatter response arrives. Fix, in
[filter.ts::pickCachedForRepo](../src/lib/picker/filter.ts): **prefer the
subtests=1 cache if loaded; fall back to subtests=0.** This is safe because
a subtests=1 fetch is a strict superset of subtests=0 — the top-level rows
are identical in both. Do not break this invariant without also revisiting
the disclosure UX.

### The picker's caches live at module scope, because the picker doesn't

`AddSeriesPicker` is mounted inside `{#if app.pickerOpen}` (App.svelte),
so `PickerState` — and every cache declared as a field on it — is
constructed when the panel opens and thrown away when it closes. Closing
and reopening therefore refetched the entire signature list. Measured
against production: **1622 ms and three requests on the first open, 2 ms
and none on the second.**

Nothing else was going to cover it. The request URL is *stable* — the
rolling window is expressed as `interval=1209600`, a duration the server
resolves against its own clock, so the same bytes are asked for every
time — but the endpoint sends no `cache-control`, no `etag` and no
`last-modified`, so the browser has nothing to revalidate against and
nothing to compute heuristic freshness from.

So the caches are module-scope `FetchStore`s
([fetchStore.ts](../src/lib/picker/fetchStore.ts)), owned by
`pickerState.svelte.ts` and shared by every opening of the panel. The
store does three things, and the panel needs all three:

- **A TTL** (`SIGNATURES_TTL_MS`, 10 minutes). That the URL is a duration
  cuts both ways: a cached answer is never wrong, only increasingly
  behind. Ten minutes is deliberately shorter than the data's real rate
  of change — new signatures appear over hours — because the person most
  likely to be hurt is the one chasing a regression that landed this
  morning. Dated from when the fetch *started*, the conservative end.
- **A bound** (`MAX_SIGNATURE_ENTRIES`, 6). One subtests=1 entry is tens
  of thousands of `Series`, and the key space is repo × subtests ×
  interval. Same eviction discipline as the activity cache: insertion
  order, least recently fetched.
- **In-flight dedupe.** Close and reopen the panel while the first fetch
  is running and the second `PickerState` would otherwise start the same
  multi-megabyte download again — the case the cache exists for, and the
  one where a miss costs most.

Two things about wiring it up that are easy to get wrong:

- **Priming is synchronous, and it happens in `seed`.** Not in the
  constructor, because the keys aren't known until `seed` has run — the
  repos, the interval and `matchSubtests` all arrive with it. And not via
  `loadRepo`, which would land the rows a microtask later: the fetch
  effect runs in between, sees an empty cache, and the panel renders a
  screen of skeleton over data it is already holding. `metadataReady` is
  taken the same way and for the same reason — it *gates* the fetch
  effect, so a microtask of `false` is a microtask in which the primed
  signature cache goes unread.
- **A rejection is not cached.** `PickerState.failedFetches` decides
  whether a failure is worth retrying (it says no until the repo is
  re-checked), and a store that remembered failures would take that
  decision away from it.

Deliberately **not** moved: the run-activity cache. Its values go stale
much faster — a run count over a rolling window changes on every push —
and the pop-in it causes on reopen is one small batched request, not a
multi-megabyte one.

The flip side of module scope is that one test's fetch answers the next
one's, so `pickerState.test.svelte.ts` calls `resetPickerCaches()` in
`beforeEach`. Its `settle()` helper also had to stop counting microtask
hops and drain to a macrotask instead: routing fetches through the store
added two `.then`s, and a hop-counting helper failed fourteen tests for a
reason no reader would have connected to the change.

### Row identity: `Series.key`, composed at construction

`Series.key` = `${repository}|${id}`, populated in
[series.ts::toSeries](../src/lib/picker/series.ts). It's used anywhere a row needs
stable per-row identity across the union of caches — expansion state,
parent-child grouping, bulk-action scope, and the `#each` key in
[AddSeriesPicker.svelte](../src/lib/picker/AddSeriesPicker.svelte)'s virtual
scroller. Subtest rows also carry `Series.parentKey` (their parent's
`key`), so [filter.ts::groupChildrenByParent](../src/lib/picker/filter.ts) can
bucket children without repeating the compound-key recipe.

**Signature-hash aliasing (two failure modes we've been burned by).**
`signature_hash` is *not* a globally unique identifier — the picker used
to key rows by `${repository}|${signatureHash}`, and both of these bit us:

1. **Across repos.** The same test has the same hash on autoland and
   mozilla-central. Keying by hash alone lets autoland children get
   attached to a mozilla-central parent (and vice versa). Fixed once by
   including the repo in the key.
2. **Within a repo, across `application`.** Two rows that differ *only*
   by application (custom-car vs chrome for the same suite/platform)
   share a hash — apparently `application` is not part of the hash
   input. `${repo}|${hash}` still collides, and
   `groupChildrenByParent` then merges children across applications; the
   virtual `#each` throws `each_key_duplicate` when both parents are on
   screen and expanded.

Fix: **key by the API's row `id`**, which is per-signature and globally
unique in the treeherder DB. `parentKey` can no longer be constructed
from the raw `parent_signature` (also a hash — same aliasing) — the
[toSeries](../src/lib/picker/series.ts) pass builds a lookup from
`(hash, application) → parentId` and stores `parentKey =
${repo}|${parentId}` on each child. The assumption is that a child
inherits its parent's `application`, which holds in every sample we've
checked; a warning-worthy fallback would be to leave `parentKey` null
and render the child as an orphan, but we've not needed it.

Consequences for anyone touching this code:

- **Never key rows by `signatureHash` alone.** Not in maps, not in
  `#each` blocks, not in cache lookups. Use `Series.key`.
- **Never derive `parentKey` from `parent_signature` directly.** Go
  through the parent's `Series.key` — that's the whole point of the
  field.
- **If you invent a new lookup keyed by `(repo, hash)`,** convince
  yourself the collision doesn't matter (or add the disambiguator).

### "Match inside subtests" is a filter semantic; fetching is separate

`matchSubtests` (the checkbox on the filter row) means one thing: when
on AND the filter is active, a parent qualifies if it OR any of its
children match. Parents that only match via a child are auto-expanded,
and under any expanded parent only the matched children are rendered
(see `PickerState.childrenForParent` /
[filter.ts::matchParentWithChildren](../src/lib/picker/filter.ts)).

Whether we actually *fetch* the fatter subtests=1 payload is a
different, derived question. `PickerState.needSubtestsFetch` returns
true when `matchSubtests` is on OR any row has been manually expanded —
either case makes child rows part of what's visible on screen. Manual
expansion no longer flips `matchSubtests`, so expanding one row can't
silently rearrange the whole filtered list.

Why the split: with the old "include subtests" toggle, clicking a
subtest badge added a `test:<name>` chip that no parent could satisfy
(parent rows have an empty `test` field), so the list went empty.
Descending the filter into subtests fixes that, and auto-expansion
makes the *reason* a parent survived visible. Coupling that filter
semantic to the fetch trigger, and coupling the fetch trigger to
manual expansion, made cause and effect impossible to reason about.
Do not conflate `matchSubtests=false` with "hide subtests" — subtests
are still visible under manually expanded parents in that mode; the
flag only means "the filter does not descend."

**Auto-flip trip-wire.** The user could still walk into the empty-list
dead end by expanding a parent, then clicking a badge on a subtest row
(a `test:<name>` badge in particular). To keep this natural action from
hitting a wall, the badge snippet in
[AddSeriesPicker.svelte](../src/lib/picker/AddSeriesPicker.svelte) passes
`fromSubtest: true` to `toggleFilterChip` when the click originated on
a subtest row, and `PickerState.toggleFilterChip` auto-enables
`matchSubtests` in that case. It's a one-way nudge — we only flip on
chip *addition*, not removal, and only if the checkbox was off — so the
user's explicit off-state is preserved for badge clicks on parent rows
and for chips typed into the FilterInput. Users can uncheck the box
after the fact to reset.

### `has_subtests` is a claim, not a promise — never make it the loading state

A parent row's `has_subtests` decides whether it gets a disclosure caret, and
that's all it's good for. It does **not** guarantee that a `subtests=1` fetch
will return any child rows for that parent: the flag is set when subtests are
first ingested and never cleared, so it outlives them when the job stops
reporting them or when treeherder's data cycling deletes the child signatures.
Live example — autoland `installer size` / osx-cross-aarch64 / opt (signature
5688441): `has_subtests: true`, and `?parent_signature=<its hash>` answers
`{}` at any interval.

The note under an expanded parent used to be chosen as "`has_subtests` and no
children loaded → *Loading subtests…*", which for that row was a spinner with
nothing behind it. `PickerState.subtestStatus` now decides from what the fetch
has actually done:

| Status | Means | Note |
| --- | --- | --- |
| `children` | children matched | the "overall score" note, then the rows |
| `no-matches` | children exist, the filter hid all of them | "No subtests match the current filter." |
| `loading` | the subtests=1 payload for this repo+interval is genuinely in flight | "Loading subtests…" |
| `failed` | that fetch failed | "Subtests failed to load." (the error banner has the reason) |
| `none` | it landed and had no children for this parent | "No subtests in the selected time range." |

The rule generalises: **"we haven't got it yet" must be read off the fetch, not
inferred from data being absent.** Absent data is also what a completed fetch
of nothing looks like.

Telling `failed` from `loading` needs `PickerState.failedFetches`, a set of
cache keys whose fetch lost. The fetch effect skips those too, which fixed a
second bug in the same area: the effect's guard was `seriesCache.has(key) ||
loadingRepos.has(key)`, and since the failure path deletes the key from
`loadingRepos`, every failure immediately re-triggered the effect — an
unbounded retry loop appending a banner line per attempt. The only retry now on
offer is unchecking and re-checking the repo chip, which clears that repo's
failed keys in `toggleRepo`.

### Framework is searchable but not shown

Perfherder cares deeply about `framework` (talos vs browsertime vs awsy).
Users of this tool don't. The framework name is:
- **Not** shown as a column, chip filter, or dropdown.
- **Included** in `row.searchText` so typing "browsertime" as free text
  still narrows correctly.
- Available via `row.frameworkId` / `row.framework` if you need to
  reintroduce it later.

### Structured filter model: chips + free text

`Filter = { chips: FilterChip[], text: string }`. Each chip is a strict
`(field, value)` equality; each free-text token is a substring match against
`row.searchText`. Rules:

- **Every chip ANDs**, including two chips of the same field.
- Free-text tokens are all ANDed on top.
- Empty filter = wildcard.

**Same-field chips AND, which is not the faceted-search convention.** The usual
rule — OR within a facet, AND across facets — exists for facets whose values
are mutually exclusive, where AND would only ever produce the empty set. Only
one of our fields isn't like that: a row's `options` is a *list*, so
`option:opt option:etw-profile` has a perfectly good AND reading ("has both"),
and under OR it *widened* the result set. Adding a chip that returns more rows
than you started with is indefensible in a control whose entire job is
narrowing, and it was a live bug: `commonFilterChips` seeds one `option:` chip
per option the plotted series share, so a filter meant to say "these rows'
siblings" said "anything sharing any one of these options".

Applying AND to the mutually-exclusive fields too, rather than special-casing
`option`, keeps one rule the user can hold in their head. The cost is that
typing `repo:autoland repo:mozilla-central` matches nothing instead of acting
as a whitelist — acceptable, because it isn't reachable by clicking: badges
only exist on rows currently on screen, and a row that failed `repo:autoland`
is not on screen to offer its `mozilla-central` badge. Multi-select over a
single-valued field would need a real control, not two chips.

Chip values are stored **lowercase** so equality is stable regardless of
how a badge happened to be cased. Only known field names (`suite`, `test`,
`application`, `repo`, `platform`, `option`) become chips. Everything else
stays as free text (typos are visible, not silently swallowed).

**We used to expose a `tag:` field.** Per the Perfherder data model
cheat sheet below, `tags` is a subset of `extra_options` whose membership
reflects historical harness wiring, not a semantic distinction the user
should reason about. A `tag:webrender` chip would silently omit rows
where webrender is an option but not a tag — same string, arbitrary
partition. The `option:` field is a strict superset and is what users
actually want; the `tag:` chip was removed.

### The one component that owns state: FilterInput's `textValue`

The chips in the filter box are rendered from `filter.chips` on every
render, so they cannot disagree with what the picker is filtering by. The
free-text half is different: it lives in the component, as `textValue`,
because the parse that turns `field:value ` into a chip has to happen
between keystrokes without the half-typed token being visible to the
parent. Everything that has gone wrong in this widget has gone wrong there,
in the same way — **the local copy diverging from the filter it stands
for**, which reads to the user as "the filter box is empty but the list is
still filtered":

- `textValue` started at `''` instead of at `filter.text`, so a filter
  that *arrived* with text in it drew an empty box over a filtered list.
  Reachable two ways: a shared link carrying `pf=`, and reopening the
  Add-series panel on a filter the user had typed into (the prefill made
  that an everyday path). The adopt-effect can't cover it — it compares
  `filter.text` against `lastCommittedFilter.text`, and at construction
  those are the same object.
- `reconcile` sets `textValue = residue`, and Svelte writes the `<input>`
  only when that signal *changes*. Typing `application:chrome ` one
  character at a time survives because the signal passes through the
  partial token, but pasting it goes `'' → ''` and the pasted text stayed
  in the box next to the chip it had just become. `reconcile` now pushes
  the residue into the element when the two disagree.

Hence [FilterInput.test.svelte.ts](../src/lib/picker/FilterInput.test.svelte.ts):
the one **committed component test**, mounting the real thing under
happy-dom with `mount` + `flushSync`. This is not the puppeteer situation
below — no browser, no download — and no other kind of test can see this
class of bug, because every layer underneath is correct while it happens.
It needed one config line: `resolve.conditions = ['browser']` under
`VITEST`, or `svelte`'s node export wins and `mount()` comes from
`index-server.js`.

If you add state to a component, ask what happens on its *second* mount
with a non-default prop.

### Every badge in the table is a filter toggle

A badge's click adds the corresponding chip; if the chip already exists,
click removes it. Visual affordance: hover shows a `+` cue; active shows a
`×` cue and a blue outline. Badge is a `<button>`, not a `<span>` — full
keyboard support falls out of that. `title` attributes describe the action
for screen readers and hover-hint.

### Two endpoints describe a series, and the cheap one answers first

A card's text — suite, test, platform, application, options, unit — is
`SeriesMeta`, and it can come from either of two responses:

| | `/performance/signatures/?id=…` | `/performance/summary/` |
| --- | --- | --- |
| Cost, measured | 866 B, 163 ms, **all series in a repo at once** | 1.4–9 MB, 0.4–1.3 s, one series |
| Carries | identity only | identity *and* every data point |
| `source` | `'signature'` | `'summary'` |

**The split exists because the identity is the part the user is waiting to
read.** Before it, a shared two-series URL showed a column of "signature
5257392 / loading…" for as long as the biggest data response took — 1.3 s on the
90-day speedometer3 link, and much longer on a slow connection. Now the cards are
named at ~160 ms, and the spinner in the point-count slot is the only thing still
saying "not yet" (see "Two loading cues"). Measured on the production build: the
names land at ~500 ms cold, against 2.2 s for the second series' dots.

Four things follow, and each one is a mistake someone would otherwise make:

- **The identity cache is keyed by signature, not by (signature, range).** A
  signature's name doesn't depend on the window, so changing the range keeps
  every card named instead of blanking the list — which is what it did when the
  only metadata came bundled with the range's data.
- **One request per *repository*, not per series.** `id` is an `id__in` filter
  but the repository is in the path, so a graph spanning autoland and
  mozilla-central makes two. Both are chunked on activity.ts's
  `MAX_IDS_PER_REQUEST`, which is the request-line ceiling, not a tuning knob.
- **The summary's metadata wins when both exist**, because two of its fields —
  `alertThreshold` and `parentSignatureId` — are the only ones the signatures
  endpoint can't answer. Every other field is identical, verified field for field
  against production, so the swap is invisible.
- **Null in those two fields means something different depending on `source`**,
  and reading them off a `'signature'` meta would silently compute a drift badge
  against the wrong alerting floor. Nothing does today, structurally rather than
  by type. api-assumptions.md has the invariant and what breaking it looks like.

This is also the one place the graphs view reaches across to the picker for
transport rather than pure logic (`signaturesApi.ts`, plus `activity.ts` for the
chunking) — an allowed direction, and listed in "Architecture" above.

### The series list shows differences, not descriptions

A plotted set is usually one test sliced along one axis: the same
speedometer3 on the same platform under chrome / safari / safari-tp /
custom-car, or the same bing-search subtest cold / warm / bytecode-cached
across autoland and mozilla-central. Spelling each card out in full made
four cards that were textually 95% identical, and finding the one word
that differed meant diffing long strings by eye.

So [SeriesList.svelte](../src/lib/graphs/SeriesList.svelte) hoists everything the
series have in common into one header ("All series share …") and leaves
each card with only its own attributes. The split is
[seriesSummary.ts::splitCommonAttrs](../src/lib/graphs/seriesSummary.ts).

**The header has two modes**, because with one series there is nothing to
intersect. `AttrSplit.mode` says which, and the heading follows it:

- `multi` — "All series share …", the case above.
- `single` — "This series". The split is by *role* rather than by agreement:
  the header takes the series' details and the card keeps only its name
  (suite + test). Splitting it this way rather than leaving the card to spell
  itself out in full keeps the one card short and puts its attributes where
  the eye already looks for context. The card can't be left with nothing —
  it carries the swatch, the point count and the controls, so it needs a
  name; suite + test is that name, and `suite` alone carries it for a
  summary series, whose `test` is `''`.

`commonAttrs` is deliberately a separate function from `splitCommonAttrs`,
and over one series it returns that series' attributes **whole**, name
included. Two callers depend on that — the picker prefill and
`documentTitle` — and neither wants the name peeled off. Only the display
splits them.

**Unit and better-direction live outside `SeriesAttrs`.** They're a property
of the measurement, not part of the series' identity, and `SeriesAttrs` feeds
`commonFilterChips` and `documentTitle`, which want neither a `unit:` chip
nor "ms" in the tab title. So `commonMeasurement` / `measurementParts` travel
separately and reach only the header, as a quieter second line: `score ·
higher is better`.

- **Judged independently, each shown only when unanimous.** Two series in
  different units that agree on direction still get "higher is better";
  suppressing it because the units differ would withhold something true.
  Nothing is printed for a fact that isn't unanimous — no "mixed units"
  string, since the y-axis already says that.
- **The direction has no other unconditional home**, which is why this is
  worth the line. [DetailsPane](../src/lib/graphs/DetailsPane.svelte) states it only
  for a *selected* point, and the graph's y-axis only ever shows the unit —
  so before this, loading a graph and just looking at it told you nothing
  about which way was good.
- **Placeholders are excluded**, as they are from `attrsForEntry`. A
  placeholder's `lowerIsBetter: true` is a default nobody stated, so counting
  it would report a unanimous direction derived from one real opinion.
- **An empty unit is ignored rather than counted as disagreement**, matching
  the y-axis label: one unitless series alongside two in `ms` still says
  `ms`.
- The header renders when there are shared attributes **or** a measurement
  line, so two series sharing nothing but their unit still have somewhere to
  say so.

Points worth knowing before changing it:

- **Options are compared token by token, not as a string.** The server
  hands back `options` as one space-joined string
  ("opt bytecode-cached cold fission webrender"); comparing those whole
  would find nothing in common between the cold and warm variants. The
  intersection is over tokens, so "opt fission webrender" goes to the
  header and "bytecode-cached cold" stays on the card.
- **Series whose metadata hasn't arrived are excluded from the
  intersection**, not treated as a series with empty attributes. Otherwise
  one in-flight fetch would make every field "differ", dumping the whole
  header into the cards and then pulling it back out as the fetch lands.
- **With fewer than two loaded series there is no header at all** — a
  single series has nothing to be compared against, and hoisting its
  attributes would leave the card blank.
- **Both ends render through the same `chipRow` snippet**, so the header
  and the cards read identically; only weight and color differ. The suite
  and test always carry the title weight, wherever they land.
- **A card can legitimately have nothing left** (two signatures identical
  in every attribute we display). It falls back to `signature <id>`.
- The header sits *outside* the list's scroller. Once a card is down to
  the word "chrome", it is unreadable without the header, so the header
  must not be able to scroll away from it.
- **Known exception to the layout-stability rule below:** the header
  appears when the first two series' metadata lands, pushing the cards
  down once. There's no honest placeholder for "what these series share"
  before we know it, and reserving space would leave a labelled empty
  block in the cases where nothing is shared. The cards' own text is
  changing at that same moment anyway.

The details pane is the counterweight: it shows the selected series'
*full* attribute set, labelled, because the list deliberately doesn't.
That includes `application`, which is not part of the server-composed
`name` string and so has to be read off `SeriesMeta` explicitly — it was
missing from that pane for exactly that reason.

**`document.title` reuses the same intersection**
([`documentTitle`](../src/lib/graphs/seriesSummary.ts), rendered by a
`<svelte:head>` in App.svelte). It used to be a static
"Perfherder Graphs — Add Series" in index.html, which named a dialog that
is closed almost all the time. Naming a graph by what its series *share*
is the same insight as the header: a graph is nearly always one test
sliced along one axis, and the shared part names the whole thing, with the
count saying how many slices. Two differences from the header:

- **The fields are a fixed subset, ordered coarse-to-fine**: suite, test,
  application, platform. A tab strip shows perhaps twenty characters, so
  the most identifying part has to come first and the long platform string
  has to trail. `repo` and `options` are left out entirely — context and
  noise respectively, and either would push the test name out of view.
- **A single series still gets named**, unlike the header, which suppresses
  itself below two series because hoisting would leave the card blank.
  There's no card to leave blank here.

The title narrows as fetches land ("2 series" → the first-loaded series'
attributes → the true intersection). That churn is accepted: the
alternative is showing the bare app name until every fetch is in, which
would leave a shared link nameless for a second and permanently if one
series failed. index.html keeps a plain "Perfherder Graphs" for the
pre-mount moment.

### Drag-to-reorder uses pointer events, and moves nothing until the drop

Order decides both legend order and color, so reordering is a real action
and worth making feel direct. The series list's handles run on **pointer
events, not HTML5 drag-and-drop**: `dragover` fires on the element under
the cursor rather than continuously, so the best it can express is
"highlight the card you're over". Pointer capture gives every position,
which is what lets the other cards step aside as the pointer travels.
Two things fall out for free — no `draggable` attribute anywhere, so card
text stays selectable, and touch/pen work, which HTML5 drag never did on
mobile.

The mechanism, split between
[reorder.ts](../src/lib/graphs/reorder.ts) (all the arithmetic, unit-tested) and
[SeriesList.svelte](../src/lib/graphs/SeriesList.svelte) (measure, listen, apply):

- **No app state changes until the pointer is released.** During the drag
  the lifted card gets a `translateY` under the pointer and the cards
  between origin and target get one of exactly `±displacement`. On
  release, `reorderSeries` runs once. Reordering live would push a history
  entry per crossing.
- **`animate:flip` covers the commit.** Dropping the transforms and
  committing the order in the same update means flip measures the cards
  where the drag left them and animates to the new layout, so nothing
  jumps. The corollary: the neighbours' `transition: transform` is scoped
  to `.sliding` (present only during a drag), because a transition still
  running when flip starts would fight it over the same property.

  Two details of Svelte's implementation make this work, and both are
  worth knowing before touching it. Flip takes its `from` rect
  *synchronously* during reconciliation, while the drag transform is
  still applied, but applies the animation in a *microtask*, by which
  time the child effect has cleared it — so `from` is the card's visual
  position and `to` is its new layout slot, which is what we want. And it
  skips the animation entirely when those two rects match, which is the
  common case here: `dragOffsets` already describes the committed layout
  (see `reorder.test.ts`), so on a settled drop only the lifted card
  animates at all. Note also that flip bakes
  `getComputedStyle(node).transform` into every keyframe, so an inline
  transform left on a flipped element gets added on top of the
  translation rather than replaced.

  **A drop must not make the user wait.** An earlier attempt let the
  cards transition into place first and committed only once they had
  stopped, which removes the handover entirely — but it means the app
  disagrees with what you just did for the length of an animation, and
  that reads as lag however correct it is. The order commits on
  `pointerup`, full stop.
- **The geometry is a list of slot positions, measured once.**
  `dragGeometry` returns, per slot, the `dy` at which the lifted card
  lands in that slot *exactly*: aligned tops with the card currently
  there for slots above the origin, aligned bottoms for slots below.
  That's not an approximation — splice the card out and back in, and the
  cards in between each shift by one `displacement`, which works out to
  precisely those two alignments. Every other question is then arithmetic
  on that one array, and the per-move path never touches the DOM. (Same
  shape as the profiler's `Reorderable`, which is where the approach comes
  from.)
- **A card takes the slot it is nearest**, so the threshold between two
  slots is the midpoint between their drop positions — *half* a card's
  travel. The obvious-looking alternative, swapping when the dragged
  card's centre crosses its neighbour's centre, is a whole slot too late:
  the list only rearranges once you have dragged past the place you were
  aiming for, which reads as lag. Reordering as soon as the card is more
  in the new slot than the old one is what makes it feel direct.
- **Slot positions come from the frozen layout, not from where cards have
  slid to.** The thresholds must not move under the pointer, or a card
  stepping aside immediately satisfies the reverse test and oscillates.
- **Cards are not a uniform height** — a card's text wraps to one, two or
  three lines depending on how much distinguishes it — so nothing may
  assume a row pitch. `displacement` reads the gap back out of the
  measured boxes, and the top/bottom alignment rule above is what keeps
  the slot positions exact for mixed heights. `reorder.test.ts` checks
  them against an actual re-layout, on fixtures with one card much taller
  than its neighbours, rather than against the same sum written twice.
- **`clampDy` keeps the lifted card in the list**, so it can't be dragged
  out over the graph or off the panel. Clamping to the first and last
  *slot positions* is what makes both ends reachable and keeps the card
  inside the content at the same time: at the clamp the card is sitting
  *in* the end slot, so `dropIndex` agrees by construction and there is
  no overhang to tolerate.
- **Boxes are measured in the scroller's content coordinates**, so
  auto-scrolling mid-drag doesn't invalidate them.
- **Auto-scroll is clamped to the pre-drag scroll range.** A translated
  element counts towards its scroller's overflow, so the lifted card grows
  `scrollHeight` as it travels; auto-scrolling against a live measurement
  chases its own tail and runs off the end of the list into empty space.
  (Auto-scroll exists at all because HTML5 drag gave it to us for free and
  a list taller than its scroller can't otherwise be fully reordered.)
- `touch-action: none` on the handle, or the browser claims the gesture
  for scrolling before we see a `pointermove`.
- **Escape and `pointercancel` abort rather than commit.** A drag the
  user didn't finish shouldn't decide an order they were still choosing,
  and since the drag never touched app state there is nothing to undo —
  dropping the transforms puts the cards back. The `keydown` handler
  lives on `<svelte:window>` so there's no listener lifetime to manage;
  it's a no-op unless a drag is in flight. The drag also records its
  `pointerId`, so a second finger landing on another card's handle can't
  end it.

The ↑/↓ buttons stay as the keyboard path: the handle is `aria-hidden`
and not focusable, so the drag is a pointer affordance only.

### Opening the picker prefills its filter from the plotted series

The same observation that shapes the series list — a graph is one test
sliced along one axis — says what you're most likely to add next: a
sibling of what's already plotted. So `AppState.setPickerOpen(true)`
seeds `pickerView.filter` with `commonFilterChips(commonAttrs(...))`, and
four plotted speedometer3 series open the picker on the seven rows that
share their suite, platform and options instead of on all 25,000.

The rules that make this safe:

- **Only into a panel with no filter to show.** `isFilterActive` is the
  whole guard: an active filter is never overwritten, whoever wrote it.
  So the prefill fires on the first open of a fresh graph, and again
  after Clear — and asking for the context at any other moment is a
  button, not a guess (next section).

  This replaced a guard that also re-derived a filter still *literally
  equal* to the last prefill (`sameFilter` against a remembered
  `pickerFilterSeed`), so that the prefill kept following the series
  list while one edited chip pinned it. It was a provenance test done by
  comparing content, and it could only recognise filters we had written
  ourselves. Everything else it mistook for "the user's own work",
  including the one filter that is *most* obviously spent: the search
  someone typed on an empty graph to find the series they then added. It
  pinned the panel to that search forever, and no reopen could recover.
  Two more paths reached the same dead end — a filter that arrived in a
  link (the seed is null after a load) and a reload of an untouched
  prefill (the seed doesn't survive it).

  The interval and sort now survive a firing prefill. They used to be
  reset with it, on the grounds that an untouched filter stood for an
  untouched panel; it no longer stands for that — it fires whenever the
  filter is empty, including on a graph with nothing plotted — so a
  90-day window the user chose has to outlive a reopen.
- **The repository is a repo selection, not a chip.** The picker's
  checkbox row already *is* a repo filter, and it's what decides what
  gets fetched; a `repo:` chip would be a second mechanism that can't
  fetch anything and silently matches nothing when its repo is
  unchecked. The prefill's `repos` (the union of the plotted series'
  repositories, not just a shared one — beta+central series need *both*
  fetched) seeds `PickerState.selectedRepos` instead. A useful
  side-effect: a central-only graph no longer pulls autoland's 4 MB.
- **`PickerState.seed` must run during setup**, before the constructor's
  fetch effect first fires, or the picker fetches the default repos and
  interval and then the seeded ones.
- **A `test:` chip in a seed turns on `matchSubtests`** — same dead end
  as the `fromSubtest` nudge above (parent rows have no `test` of their
  own, so the chip would match nothing), reached differently: any prefill
  derived from subtest series carries a `test:` chip, and so does any
  hand-written link that filters on one. The nudge lives in `seed`, and
  only fires when the seed leaves `matchSubtests` *unspecified*: a link
  that says `psub=0` is the user having unchecked the box, and it wins.
  That three-valued-ness is the whole reason `psub` is written even when
  false — see "URL state" in graphs.md.
- **Placeholder metadata is excluded** (`attrsForEntry` /
  `isPlaceholder`, i.e. `SeriesMeta.source === 'none'`). A signature with
  no data in the range gets a synthesized `suite: "signature 1234"`;
  prefilling on that would open the picker on an empty list. Metadata from
  the signatures endpoint is *not* excluded — it is real, it just arrived
  first, which is what lets "Derive filter" answer before the dots do.
- The intersection here is `commonAttrs`, not `splitCommonAttrs` — with
  one series plotted there's no header to render but that one series is
  exactly the context to search from.

The prefill goes through the normal `pickerView` state, so it lands in the
URL (`pc=` / `pr=` params) like anything else the panel shows and a shared
link reopens on the same rows.

### The control block is two groups: what loads, and what shows

**Two blocks in the app take this shape**, and they share it down to the CSS:
the picker's controls above its list, described here, and the graph header,
whose two departures from it are recorded in graphs.md, "The header is two
groups". The alignment lives in `.control-grid` / `.control-label` /
`.control-aside` / `.control-word` / `.control-toggle` in
[app.css](../src/app.css) — one definition, for the reason `.btn` is one
definition — and each component keeps only its own frame: a bordered card here,
a bar with a bottom rule there.

Everything above the list is one CSS grid with three columns — a label
rail, the group's main control, and a right rail for that group's
secondary controls — and exactly one row per group:

```
FILTER      [ chips + free text ................. ]   [Derive filter] [Clear filter]
                                                      ☑ Match inside subtests
LOAD FROM   [☑ autoland 11,923] [mozilla-central] …   last [14 days ▾]
```

**Which row a control goes on is decided by `cacheKey`, not by taste.**
It is `repo | subtests | interval` (see "Cache key"), so the repos and
the time range *are* the fetch: change either and a request goes out and
the list is rebuilt from a different set of signatures. Everything else
narrows what is already loaded. That is the line the two rows draw, and
it is why the block used to look arbitrary: the time range sat inside the
row labelled `FILTER`, and `Match inside subtests` — a pure filter
semantic, see its own section — sat past it, at the far end of the panel
from the box it modifies. Each control was in the other one's group.

`Match inside subtests` is the one control the rule doesn't place by
itself, since turning it on can trigger a subtests=1 fetch. It goes with
the filter anyway: what it *means* is whether the filter descends, and
the fetch is derived from that (`needSubtestsFetch`), not the other way
round.

- **A grid, so the rails line up by construction.** The previous version
  was two flex rows that lined up because each label carried
  `min-width: 80px` and the taller row's label carried a `padding-top: 8px`
  to fake first-line alignment, with a second, different `padding-top: 4px`
  on the controls at the other end. Three measured numbers, all of them
  facts about one screenshot: reword a label, change a font size, and
  they are quietly wrong.
- **Vertical alignment is `baseline`, between the label and the *right
  rail*.** A 12px uppercase label has to drop a few px to sit level with
  the 14px controls beside it, and that offset is nobody's to type: it
  falls out of the two fonts. This is "Layout stability"'s
  prefer-stacking-to-measuring rule applied to alignment — let the
  browser find the number.

  **Which two things share the baseline is the part that took a second
  go.** A grid row's baseline-aligned items form one group, positioned by
  the largest ascent in it, so a group is only as stable as its tallest
  member. Pairing the label with the row's main control — the obvious
  choice — tied it to the one box in the row whose first line changes
  height: clearing the last chip swaps a 12px chip pill for the 14px text
  input, and everything in the group slid down a few px on a click that
  should only have made the box shorter. The right rail's first line is a
  button, or a select, and neither ever changes, so the label pairs with
  that. The main control is left at `start`, where nothing it does to its
  own height can move anything else.

  What still moves when the filter is cleared is the `LOAD FROM` row and
  the list below it, because the block genuinely got shorter. The rail
  floors the row at its own height, so that shrink is 13px rather than
  the box's full 28.
- **The row gap beats the right rail's own gap about 3:1** (18px vs 6px).
  A rail's second line is the only thing in the block not anchored to a
  label, so it is the only thing whose group could be misread; the
  spacing is what settles it.
- **"last" is lowercase and `aria-hidden`.** It finishes the row's
  sentence — *load from these repos, last 14 days* — rather than being a
  second thing in the rail's uppercase style claiming to name a group,
  which is what the old `TIME RANGE` inline label did. The `<select>`
  carries `aria-label="Time range"`, so the accessible name is the real
  one.
- **Nothing in the middle column may carry a `min-width`.** That track is
  `minmax(0, 1fr)` and the right rail's is `auto`, which does not shrink — so a
  floor on the filter box does not make the row wider, it makes the box overflow
  its own track and run *under* the rail. Measured before it was removed: at a
  596px window "Derive filter" sat 32px inside the filter box, and it was still
  8px over at 620. The chips' own min-content width is the honest floor, and below
  the widths where even that fits, the container query has already folded the
  block to one column.
- **The status row belongs to the list.** It counts the rows below it and
  acts on them in bulk, so it sits in the same flex column as the
  scroller, 6px above it, rather than floating equidistant between the
  controls and the table the way it did (12px each way — visibly a member
  of neither). That wrapper repeats `flex: 1; min-height: 0`, which every
  level of the chain has to carry; see "The Add-series dialog has exactly
  one scroller".

#### A panel with no room for the loading group folds it away

The block is two groups, and on a 390px panel it was 299px tall before a chip
had been added to it — with the header and the status row, 461 of an 844px screen
spent before the first row of the list. So the `LOAD FROM` group folds behind one
line that states it:

```
[ speedometer3 .................................... ]
[Derive filter] [Clear filter]
☐ Match inside subtests
[ autoland, mozilla-central · last 14 days       ▾ ]
```

The list goes from 321px to 518px — 8 table rows to 6 cards, and to 2 with a
keyboard up, from none at all.

**Whether to fold is a question about height, not width** — what folding buys is
list, and the list is what the panel is for. The first version asked about width
(`CONTROL_BLOCK_NARROW`, because that is where the block gives up its label rail)
and folded a 596×900 window that had all the room in the world for the block.
`foldPickerLoadRow` in layout.ts asks instead whether the list would keep
`PICKER_LIST_MIN` — five card rows — with the group open. Width still comes into
it, but only through `pickerChromeCost`, as *how tall is the block here*: the four
repository chips wrap to three lines on a phone and one on a desktop, so the block
is 482px there and 359 here. Four bands, each taking the largest cost measured in
it (`tools/visual/picker-chrome-cost.mjs`), because the estimate should err
towards folding — a fold is one tap from being undone and a squeezed list is not.

Two things about that measurement, both of which the first version of the table
got wrong:

- **It is taken with a coarse pointer as well as a fine one, and the coarse
  number is the one a band keeps.** The touch floor is worth ~50px of this block,
  and the widths these bands describe are overwhelmingly phones — so a table
  measured with a mouse underestimates exactly the case the fold exists for. The
  first one was, by 44px at a phone's width, and taking the larger of the two errs
  towards folding on a narrow window with a mouse, which is the recoverable
  direction.
- **The cost is not monotonic in the width, which is why there are four bands.**
  At `CONTROL_BLOCK_NARROW` the label rail and the aside column come back, and
  between them they take enough width off the chips to cost a line a 528px panel
  with no rails does not pay: 564 is dearer than 556. One band over the two of
  them charges a docked 900px window 43px it does not spend, which there is the
  difference between six card rows and a fold. The extra boundary is
  `CONTROL_BLOCK_NARROW` itself, not a number near it, because that threshold *is*
  the cause.

Where it lands, measured with `tools/visual/picker-fold-cases.mjs`:

| Viewport | Folds | List |
| --- | --- | --- |
| 390×844 phone | yes | 6 cards |
| 390×508 (phone, keyboard up) | yes | 2 cards |
| 375×667 phone SE | yes | 4 cards |
| 596×900 | **no** | 6 cards |
| 596×400 | yes | 1 card |
| 768×1024 iPad portrait, docked | no | 7 cards |
| 900×900, panel docked | no | 6 cards |
| 1440×900 | no | 16 table rows |
| 1440×500 | yes | 5 table rows |

Every one of these is at or above where it was before the panel's chrome got a
touch floor, and 900×900 gained a row: at 556px of content and below, a group's
secondary controls now wrap as a row instead of stacking as a rail that isn't
there. See "Touch" below for the table of what the floor's height costs — it is
the reason that floor is 32 and not 36.

Which group folds is not a matter of taste either:

- **The filter group stays open, all of it.** It is what the panel is for, and
  the two buttons and the subtest switch are all things a phone user reaches for
  *while* searching. The loading group is set once and then left alone — and it
  is the expensive one to draw, since four repository chips with their counts
  take three lines at this width.
- **The line says what it folded.** `loadSummary` in filter.ts, unit-tested:
  two repositories are named, three or more are counted, and the time range
  follows. A control that folds without saying what it is set to makes the reader
  open it to find out, which is the tap folding it was meant to save. Same rule
  as the graph header's collapsed bar (graphs.md, "A pane too short for the bar").
- **The three things that give way ask three different questions.** The fold asks
  about height, as above. The hint paragraph and the two reserved widths in the
  status row are about horizontal room and stay in the container query in app.css.
  The counts' wording is horizontal too but has to be read in JS, because it is a
  different string and not a different style — `CONTROL_BLOCK_NARROW` is the one
  copy of that number, and it must match the `@container` rule the way
  `SIDEBAR_WIDTH` must match `--sidebar-width`, since a container query's
  condition cannot be a custom property.
- **The summary line spans every column of the grid.** Auto-placement puts a grid
  item in the next free cell, which for this one is the *label rail* of the second
  row — and the rail is an `auto` track, so a full-width button in it grew the
  first column and took ~200px straight out of the filter box beside it (seen at a
  656×619 window: wide enough to keep the rail, short enough to fold).
  `grid-column: 1 / -1` is also what the line means: it stands in for a whole
  group, not for a label.
- **The folded group is hidden, not unmounted**, so `aria-controls` points at
  something real. That needs an explicit `display: none` per element: `[hidden]`'s
  UA rule is zero-specificity and every one of these carries a class that sets
  `display`.
- **The hint paragraph goes too**, and the status row's counts lose the words
  that name them (`19 / 11,925`, with the wording in a `title`).
- **The status row has its own, wider threshold.** It carries four things once the
  card layout adds a sort control — counts, sort, `Add all`, `Done` — and below
  ~600px of panel they cannot share a line; a wrap costs 44px of list. So
  `STATUS_ROW_ONE_LINE` drops the two that have
  somewhere else to be: the *N* on the graph count (what a tap did is still
  visible on the row it acted on, which turns into a tinted `Remove` carrying the
  series' colour) and the bulk button (a row's own Add is one tap away, and the
  series list's header carries `Remove all`). Above it, both stay — including at a
  900px window, where the panel folds its load row but has room for the row.
  Deliberately *not* the fold's threshold: in the table layout there is no sort
  control, so three items fit all the way down to the fold, and reusing one number
  would have taken the bulk button away from a desktop that had room for it.

### A panel a phone wide lists cards, not columns

The table has a floor — `TABLE_MIN`, 832px, which is the `64em` its `min-width`
used to spell — and below it the scroller handed out a horizontal scrollbar. On a
390px phone that meant `Add`, `Suite / Test`, `Repo` and half of `Platform` on
screen, with the platform, the application, the options and the runs strip
reachable only by dragging a horizontal scrollbar that lives inside a vertical
one. Four of those five hidden columns are filter controls — every badge is a
chip toggle (see "Every badge in the table is a filter toggle") — so the panel's
whole mechanism was off screen.

Below that floor each row is a card of two lines instead:

```
[+ Add] ▶ speedometer3                                    90 ▁▃▂▅▃▁
autoland  android-hw-a55-14-0-aarch64-shippable  fenix
opt  webrender  score
```

Same rows, same badges, same actions, nothing sideways. What holds it together:

- **The three pieces of a row are snippets shared by both layouts** — the pick
  button, the activity mark, and the attribute badges. The table wraps each in a
  `<td>`; the card puts them on two lines. A second copy of what a row *says* is
  how the two would drift apart, and the badge snippet in particular carries the
  `fromSubtest` nudge described under "'Match inside subtests'".
- **`rowHeight` is per layout and the CSS reads it back.** 36px for a table row,
  80px for a card — a 26px head and two 20px badge lines inside 8px of padding.
  The virtualizer's arithmetic is unchanged, because it was never about tables; it
  needs one number and both `--row-height` and every height in the stylesheet come
  from it. **Every row in the flat list has to honour it, including the notes**
  under an expanded parent: the table's got that free from `tbody td`, the card
  list says it explicitly, and `tools/visual/picker-card-pitch.mjs` checks that the
  rendered heights sum to `rows × slot`.
- **Which layout is chosen from `panelWidth`, which starts at `Infinity`** — so
  the panel's *first* paint is the table, however narrow it is, until the
  ResizeObserver fires. It corrects within a frame or two in practice and nothing
  measures wrong afterwards, but it is worth knowing about for two reasons. It is a
  layout shift at the moment the panel opens, in a panel whose other shifts this
  file is careful about. And it makes any script that samples the panel after a
  *fixed* delay unreliable: `picker-fold-cases.mjs` reported 36px rows in a 424px
  panel twice in a row under load, which reads exactly like a real regression, and
  now waits for the row height to agree with the panel's width instead.
- **The attribute line is clamped to two lines, not left to wrap.** The number of
  options a row carries is unbounded, and a row three lines tall would put every
  row below it in the wrong place. Two lines fit the busiest realistic row —
  speedometer3 on an android platform with five options, which is the case that
  was clipping before the clamp — measured rather than chosen.
- **80px against 60px was the deliberate trade.** A one-line attribute row fits 8
  cards on a phone instead of 6, and clipped the tail of every one of them. All of
  the information on 6 rows beats most of it on 8 in a panel whose job is telling
  two near-identical series apart.
- **What still gives way is a long subtest name**, against the run count and its
  strip on the same line. The strip stays — whether a series has runs at all is
  the reason it is on the card — and the name carries a `title`.
- **Two things the table had, replaced rather than dropped.** Sorting was a click
  on a column header, so the card list gets a select and a direction button on the
  status row (`setSortColumn` / `toggleSortDirection`, which offer "as loaded" as
  a choice rather than as the third click of `cycleSort`'s cycle). And the badges'
  `+` cue, which reserves 10px in every badge so a hover can't resize it, is
  dropped for inactive badges here: there is no hover on the devices this layout
  is for, and the reserve costs 10px six times on the tightest line of the card.
- **This bites before the phone**, at any panel under 832px — a docked panel in a
  1100px window. That is on purpose: horizontal scrolling inside a vertical
  scroller is bad on a trackpad too, and the card shows what the scrolled-away
  columns did.

### The on-screen keyboard has to take height from the app, not cover it

Three things, because no single one of them is enough:

- **`FilterInput` only takes focus where the primary pointer is fine**
  (`shouldAutofocus` in shared/pointer.ts). On a mouse it saves a click and costs
  nothing. On a phone it summoned the keyboard over the list the panel exists to
  show, before the user had decided whether they were typing or scrolling.
- **`interactive-widget=resizes-content` in the viewport meta**, which asks the
  browser to take the keyboard's height out of the *layout* viewport. The app is
  one non-scrolling screen with its own scrollers inside it, so the default
  (`resizes-visual`, which slides a viewport the page cannot see) has nothing to
  reveal by scrolling.
- **`appHeight` in App.svelte for the browsers that ignore it**, iOS Safari being
  the one that matters: it leaves the layout viewport alone, so `100dvh` stays the
  whole window, a `position: fixed` panel keeps its full height, and the keyboard
  covers the bottom of a pane that cannot scroll. `visualViewport.height` is the
  part actually on screen, and `main` and the overlay are sized from it.

  **Gated on `visualViewport.scale`**, because pinch-zoom shrinks the visual
  viewport too — following it there would re-lay-out the app to the magnified
  region, which is a rearrangement nobody asked for. A keyboard leaves the scale
  at 1.

  The overlay carries `bottom: auto` plus a height for this, rather than pinning
  both edges: top + bottom + height is over-constrained, and the browser resolves
  it by dropping one of the three silently.

Measured on a 390×844 viewport with a 336px keyboard: the picker's list was 2px
tall, and is 202px — five rows — with the panel's chrome folded as above. **The
iOS half of this is the one thing here not verified on the device it is for**;
Chrome's emulation cannot produce a real keyboard, so it was checked by shrinking
the viewport to what one would leave.

### Deriving the filter, and clearing it

Two buttons in the filter row's right rail, and between them they replace
everything the old prefill guard was trying to infer:

- **Derive filter** applies the same thing the prefill applies — what the
  plotted series share — at any moment, on request. That is the answer to
  every case an open-time guess gets wrong: a filter the user typed, one
  that arrived in a link, one left over from finding the series now on
  the graph, or a graph whose metadata landed after the panel was already
  open.
- **Clear filter** empties the chips and the free text together. The
  chips have their own `×` for undoing one click; this is for eight chips
  and a search you're done with. Clear plus a reopen is also the way back
  to the graph's context, since an empty filter is what the prefill is
  allowed to write into.

**Both labels take "filter" as their grammatical object, and that is the
point.** The first draft read *Filter to graph* / *Clear*, which is wrong
in a dialog whose entire job is changing the graph: a verb with no object
beside the word "graph" reads as an action *on the graph*. Someone who
has typed a search and is hunting for the way to commit it reads "Filter
to graph" as *filter my graph by this* — the Apply button this panel
deliberately doesn't have (see "The row's pick control") — two controls
away from `Add all 24`, which encourages the same reading. Clicking it
would then throw away the search they were about to use. "Clear" alone
had a milder version of it, sitting a row above `Remove all`.

Naming the filter fixes it, and the pair then reads as fill it / empty
it. Rejected on the way: *Filter to plotted series*, which still leads
with a verb that could be read as acting on the graph and is three times
the length; and *Reset filter*, which is accurate — the derived filter
*is* the default — but collides with `Clear filter` beside it, since
both then sound like undo. The row's `FILTER` label can't carry this on
its own: buttons get read alone and out of order. What "Derive filter"
can't say is what it derives *from*, so every tooltip says it, and the
disabled ones say why they can't (see `graphContextState`).

What makes this cheap rather than another mechanism to keep in sync:

- **One derivation, two consumers.** `AppState.graphContext` is a
  `$derived` holding a `GraphContext` (`{ filter, repos }`); the prefill
  reads it on open and the button reads it live. `graphContextFilter` in
  `seriesSummary.ts` is where the filter comes from, so there is no
  second definition of "what this graph is about" to drift.
  `GraphContext` is declared in `urlState.ts` — not because it is URL
  state, but because it is a contract between the two halves and that
  module is already above both. Declaring it on either side would mean
  the picker importing from `graphs/`, which the dependency rule in
  "Architecture" forbids.
- **`graphContextState` has four answers, not two** (`filter.ts`). Three
  of them disable the button, and they disable it for reasons the user
  can act on differently: `none` (nothing plotted), `pending` (plotted,
  metadata still in flight — it will light up on its own), and `same`.
  That last one is the most useful thing on the row: a disabled *because
  your filter already is your graph's context* is the only place the
  panel says the two agree. A single `disabled` boolean would have made
  all three look like the same shrug.
- **The button spells the filter out in its `title`**, chip by chip, as
  `suite:x · platform:y`. It replaces the filter rather than adding to
  it, so the text it is about to put in the box is the only honest
  preview.
- **Both stay mounted, with fixed labels.** Disabled is the only thing
  that changes, so the row can't resize as series load or as the filter
  changes — see "Layout stability".
- **`applyGraphContext` is additive on repos and never subtractive.** It
  checks a repo the graph needs (a plotted series in an unchecked repo
  means a context filter that matches nothing — the same dead end as a
  `test:` chip without `matchSubtests`) and gives an unpinned one a chip,
  as `seed` does. It never unchecks: unchecking is how the user controls
  what gets *fetched*, and this is a filter control. It carries the
  `test:` chip nudge for the same reason `seed` does, and it leaves the
  interval and sort alone — resetting a time range mid-session would be
  a reset nobody asked for.
- **Clear is the filter only.** Repos, interval and sort are the panel's
  scope rather than its query, and an empty repo set in particular would
  be a blank slate with no rows on it to look at. It doesn't touch
  `matchSubtests` either: with no active filter that flag matches
  nothing anyway, and switching it off would discard the fatter
  subtests=1 data the panel already holds.

Still missing, and worth knowing before you conclude the panel is done:
a graph of *subtests* lands on collapsed parent rows. The context filter
describes the parents too (they carry the same suite, platform and
options), so they match on their own, and `matchSubtests` doesn't help —
it only auto-expands parents that qualified *via* a child. What would fix
it is expanding a parent that has a plotted child, which needs the
subtests=1 data and so is its own change. See graphs-todo.md.

### The row's pick control: a verb, and it acts immediately

Each row carries one button in the `Add` column — `+ Add`, or a series
swatch plus `Remove` if it's already plotted — and clicking it changes
the graph there and then. There is no staged selection and no commit
step. `PickerState` has no `picked` map; the only "is this series in?"
state is `plotted`, which the app owns and syncs down.

It used to be a checkbox plus an `Add n` footer button. User testing
found people didn't recognise the checkbox as "the way to get this series
onto the graph" and reached instead for the disclosure caret — the only
control on the row that looked like it led somewhere — then stalled among
the subtests, unsure which one to pick. Three things caused that:

- **A checked checkbox is a promise, not an action.** Nothing visible
  happened on click except a faint row tint and a counter in the status
  row, far away. Nowhere on the row was there a verb.
- **The caret out-competed it.** Two small controls side by side, one of
  them a filled glyph implying direction.
- **The outcome was invisible.** The panel covers the graph, so nothing
  confirmed that picking and plotting were the same act.

The fix is one change with three parts. The button supplies the verb.
Acting immediately means the verb is *true* — the row flips to `Remove`,
the count moves, and the series list beside the panel grows a new entry
(see the next section) — so the control teaches its own meaning
instead of promising something that only happens later. And expanding a
parent now inserts a note row saying the parent *is* the overall score,
which answers "which subtest do I pick?" where the question gets asked.

Consequences worth knowing:

- **Every add and every remove is its own `syncUrl('push')`.** Deliberate,
  not an oversight: with no commit step, Back *is* the undo, and one
  click should cost one Back. A bulk action is one push, though, which is
  why `AppState.removeSeries` takes an array like `addSeries` does —
  looping the single-ref form would charge 49 Back presses for one click.
- **The footer commits nothing.** `Add n` became `Done`, which only
  closes; Escape is no longer capable of throwing away work the user
  thought they'd done. `Clear` (which cleared the staging map) had
  nothing left to mean and is gone.
- **The master checkbox left the column header**, which now says `Add`. A
  checkbox at the head of a column of Add buttons re-teaches the control
  we just replaced. It became the status row's one bulk button, which
  offers `Add all n` until everything the filter shows is plotted and then
  flips to `Remove all n` — the same toggle it always was, retargeted from
  a staged selection to the graph. `PickerState.bulkAction` decides which.
  The count is in the label rather than a tooltip because `Add all 24,913`
  has to be able to talk the user out of it.
- **Both buttons occupy one fixed box** (`.pick` is `width: 100%` in a
  fixed-width column; `.pick-cue` and `.pick-swatch` reserve the same
  9px). Labels of different lengths in one column would otherwise give it
  an edge that moves as you click. Same reason the bulk button is
  right-aligned with a `min-width`: a growing count eats the gap to its
  left instead of shoving `Done` sideways.
- **`plotted` must stay synced, not seeded.** It changes under the panel
  on every click now.
- **Rejected: the caret carrying its subtest count** (`▶ 28`), tried as a
  way to make it read as a fact rather than an entry point. It earned too
  little to justify the wider column, which left a visible gap in the
  common state where the subtest payload hasn't loaded and there is no
  count to show.

### The shell has four arrangements, and the graph keeps its size

`main` is a series list, a graph and a details pane. The two side panes are a
fixed 600px between them, and for a long time that was a hard floor the graph
paid for: at a 900px window it left 300px of plot, at 640px it left 40px, and
below 600px the middle column was **zero** — the graph's own chrome painting
over the pane beside it, which was itself clipped off the right-hand edge. The
app was unusable in a tiled half-screen window, which is where a lot of people
read a graph somebody linked in a bug.

The rule is the other way round: **the graph is the content, the side panes are
apparatus, and a pane that no longer fits stops being a column rather than
squeezing the graph.** That gives four arrangements, and the thresholds are
arithmetic rather than taste — each tier ends exactly where its columns or rows
would push the graph below `GRAPH_MIN_WIDTH` / `GRAPH_MIN_HEIGHT`:

| Window | Tier | Arrangement | Graph gets |
| --- | --- | --- | --- |
| w ≥ 1040 | `wide` | `list │ graph │ details` | w − 600 |
| w 760–1039 | `medium` | `graph │ details`, list a **drawer** behind a bar button | w − 320, h − 45 |
| w < 760, h ≥ 570 | `narrow` | graph over a details row, list behind the same button | w, h − 45% − 45 |
| w < 760, h < 570 | `narrow-short` | graph and details taking turns, list behind the same button | w, h − 45 |

Read down the table as a sequence of retreats, each giving up the least it can:
**the list's column goes first, then the details pane's column becomes a row, then
the row becomes a turn in a switcher.** Which pane goes first is the whole design;
the next section is about it.

**Only one boundary is decided by height, and there used to be two.** Height only
ever matters where a pane is a *row*, because a row needs height the way a column
needs width — an 844×390 landscape phone is wide enough for two columns, and when
it took an arrangement that stacked a row it was left with a **12px** detail plot.
There is now exactly one arrangement with a row in it, so there is exactly one
place to ask, and `wide` and `medium` both answer height the same way: a short
window makes every column short and no rearrangement helps.

#### The pane that stops being a pane is the series list

**The list is the apparatus of the three.** The graph is read continuously and the
selection once per point; the list is opened once a session to add something or to
check a color. So the moment three columns stop fitting, it is the one that goes
(`listIsSheet`) — and the two panes that are about the data keep their columns for
as long as those fit.

That rule arrived in two steps, and the first one stopped short. It was applied at
one column only, where all three panes had been taking turns in a switcher — an
arrangement that charged the same tap for "what did I just select" as for "what is
plotted", so a phone paid a round trip out of the graph and back for every dot it
inspected. Two tiers above it kept the list as a column and paid for it in the
graph's height instead, and **both were paying in the wrong currency**:

- `medium` kept `list │ graph` and put the details pane in a **row** under the
  graph. A column costs its width once; a row costs 40% of the height forever. At
  a 900px window that arrangement left the graph 620×432, and dropping the list
  leaves it 580×843 — **34% more plot for 40px less width**, and the comparison
  goes the same way at every width in the band.
- `short` sat below it for windows with no height for that row, and there the
  details pane took turns with the graph. That is the arrangement where **you can
  only ever see one of the two things the app is for** — which is what an iPad in
  landscape got, Safari's chrome putting it at 1024×648.
- Worse, the boundary between them ran backwards. At 900×716 `short` gave the graph
  620×655; four more pixels of window height tipped it into `medium`, which spent
  40% of the height on the row and left 620×432. **A window growing made the graph
  a third smaller.**

Applying the rule at every width below `wide` collapses those two tiers into one
and deletes `short` outright — not because it was improved but because it existed
to guard a row, and there is no row at two columns any more. An iPad in landscape
now gets `graph │ selection`, 704×591 and 320×591; a landscape phone gets 524×333
and 320×333, both on screen, where before it had to choose.

- **The list becomes a sheet behind one button in the bottom bar**, which states
  its count and carries the series' colors as overlapping dots. The dots are a
  count cue and not a legend — a swatch identifies a series by *shape* as well as
  color (see the series list and the details pane), and half of that would be
  worse than none; the number beside them is the real answer. Four things dismiss
  it: the handle again, a cross in its header, Escape, and a tap on the dimmed strip
  of graph it leaves showing.
- **How much of the panes it takes depends on how much there is to preserve**
  (`listSheetCoversPanes`). At two columns it is a **drawer**: 280px over the left,
  the same width and the same place as the list's column in `wide`, so it reads as
  that column coming back rather than as a new screen. Sizing it to the window
  everywhere was the first version and it is plainly wrong at 1039px — three cards
  and a header stretched across a window wide enough for the arrangement it just
  replaced. At one column there is no "beside" left to preserve, since 280px would
  leave a 110px sliver of graph on a phone, so there it is a **bottom sheet** across
  both panes — see the next section for what makes it read as one.
- **That same question decides whether it is modal.** A drawer leaves everything it
  overlaps visible, so reaching the graph behind it by Tab or by click is not
  reaching anything hidden: nothing goes `inert`, there is no backdrop, and the
  shadow is what says it is on top — non-modal in the same way, and for the same
  reason, as the Add-series panel docked beside this list in `wide`.

  **A bottom sheet does have to take the panes it covers out of the DOM**, the same
  two the panel does and for the same reason: `z-index` is a paint order and
  Tab follows the DOM, so without `inert` the first thing Tab reached behind the
  sheet was the button that had just opened it. `inert` blurs whatever it is applied
  to, which would leave a keyboard user at the top of the document, so the sheet's
  *slot* takes the focus — the shell's own element, so nothing has to be threaded
  through SeriesList, and a `tabindex="-1"` container is the better target anyway:
  Tab from there walks the sheet's controls in their own order. Coming back is the
  handle. Both focus moves are `queueMicrotask`ed, because on open the slot is still
  `display: none` and on close the handle is still `inert`.

  **The bar is not among the things either presentation covers**, so it is never
  `inert` for the sheet's sake — only for the Add-series panel's, which does cover
  it. See the next section.

#### The sheet rises from the handle and leaves it on screen

Everything above decides *what the sheet is*. This is about whether anyone can tell
— and for one revision nobody could. At 400×684 the list arrived as a full-window,
opaque, motionless replacement for the graph, and the honest reading of it was that
the app had navigated to a page. Reported as: "I don't know how it relates
hierarchically to the rest of the app… do I need to keep clicking to make
progress?"

**The presentation was carrying none of the load, and it takes five things to
carry it.** Each is cheap on its own; the failure was that all five were absent at
once, so no single one of them is the fix.

- **It stops at the bar** (`grid-row: 1 / -2`), instead of spanning every row
  including the one that opened it. This is the important one. The handle stays on
  screen, keeps its place, and its chevron — which has always flipped to point the
  way the sheet moves — is now visible to flip: under the old placement the sheet
  covered the one affordance saying "tap this again", so the app implemented a
  toggle and then hid half of it. Summoning and dismissing are the same tap in the
  same place, which is what answers "the close button is at the opposite corner from
  what I just tapped". The header's cross stays, because a sheet needs a dismissal
  where the eye is as well as one where the thumb is.
- **It leaves a peek of the graph** above it — 80px in `narrow`, 48px in
  `narrow-short`. Derived rather than chosen: the graph pane's header collapses to a
  41px bar, so `narrow-short` shows the header and nothing else, and `narrow` shows
  it plus enough of the plot below to read as a graph rather than as a stray
  toolbar. A fixed offset, not a sheet sized to its content: bottom-anchored content
  sizing would move the whole sheet under the thumb every time a series was removed
  from it, and "layout must not shift when the user first interacts" applies hardest
  to the surface a thumb is already resting on.
- **The peek is dimmed** with `--backdrop`, and tapping the dim closes the sheet.
  The dim is the fourth exit and the only one that is also a statement: the graph is
  still there and it is out of play. The dim stops at the bar with the sheet — the
  bar is the one thing on screen that is never out of play, and dimming the control
  that dismisses the sheet would say the opposite.
- **It has a lifted edge**: 12px top corners and `--shadow-overlay`. Which is where
  the tint problem shows up. The list pane is `--bg-subtle`, and in the light theme
  that is *darker* than the graph's `--bg-canvas` — light comes from above, so a
  darker surface reads as behind. (In the dark theme `--bg-subtle` is the lighter of
  the two and it reads correctly, which is why this only ever looked wrong in one
  theme.) **The tint stays as it is**, because it is the same pane in the same colour
  as the `wide` column and forking it would mean forking the cards inside it too;
  the shadow and the dim are what carry the elevation here instead.
- **It slides**, 220ms, in from the bottom and back down *behind* the bar — which is
  why the bar takes a `z-index` above it. `translateY(100%)` moves the sheet by
  exactly its own height, and since it stops at the bar's top edge that lands it
  over the bar; without the stacking order the bar would vanish under a departing
  sheet and blink back at the end.

**Two mechanisms animate this, and which one applies follows from how the element
comes and goes.** The sheet is only ever shown and hidden — `display: none` on an
always-mounted slot, one rule for every slot and worth keeping — so it animates in
CSS with `@starting-style` for the entry and `transition-behavior: allow-discrete`
on `display` for the exit, and reads `prefers-reduced-motion` in a media query. The
Add-series panel is mounted by an `{#if}`, and an element that has already been
removed from the DOM cannot transition out, so its entry and exit are Svelte
`fly`/`fade` transitions with a duration that JS has to compute. The duration is
therefore written twice — `MOTION_MS` in the script, `--sheet-motion` in the style
block — because the two mechanisms cannot share it. Keep them in step.

**The panel rises too, and only where it takes the window.** At one column it is
summoned from the same corner as the sheet and arrives from the same direction,
which is what makes a panel opened from *inside* the sheet legible as a third layer
rather than as a second page. Docked in `wide` it has nowhere to rise from, so it
fades with its backdrop and stays put. The panel keeps `opacity: 1` on its own
transition: the backdrop it sits in is already fading, and two fades compound into a
panel that is 25% opaque halfway through.

Where `@starting-style` and `allow-discrete` are unsupported the sheet simply
appears and disappears, which is the behaviour this replaced.
- **The bar is in the bottom-left corner at every width, and it is the app's only
  chrome of its own.** Up to three things: the sheet's handle, the switcher where a
  tier switches, and the theme toggle — which is the one always present, and the
  reason the bar exists in `wide` at all (see "Theming", where it explains why the
  toggle was previously smuggled into the series list's footer). The bottom is where
  every touch platform puts primary navigation, and it is the reachable edge on the
  devices least able to reach the top of their own screen. `short` used to keep its
  copy on *top*; there is one bar and one place for it now.

  **It spans one column, not the window** — under the series list in `wide`, under
  the graph in `medium`. So the details pane keeps its full height wherever it is a
  column, which matters because its content runs past 1000px and 45px is worth more
  to it than to a bar that says nothing about it. Spanning the window also charged
  the graph that height in `wide` for one toggle, which is the cost that made a
  window-wide bar look unaffordable there in the first place. At one column there is
  only one column to be under.

  The handle sits at the bar's leading edge, under where the list's column is in
  `wide` and where its drawer opens, so the handle and the thing it opens share an
  edge. It spans the bar in `narrow` and only there — the one arrangement where the
  bar is a phone wide and holds nothing but it and the toggle, so it is a sheet
  handle and reads as one. In `narrow-short` there is a switcher beside it, and in
  `medium` the bar is 440–719px, where a button that wide is not a handle but a
  mistake.

  **`Remove all` is not in it, and is no longer in a footer either.** It was, at the
  bottom-left of the series pane — which is exactly where the handle that opens that
  pane sits, so a double-tap on the handle landed its second tap on `Remove all` and
  threw away every plotted series. (Recoverable: `clearSeries` pushes a history
  entry. Not acceptable.) It is in the list's *header* now, beside the heading rather
  than beside `Add series…` or the close — same scope as the heading, and away from
  the two controls a hand reaches for quickly. As an icon, because at 280px the text
  wrapped the header to a second row and the header sits outside the scroller; a
  trash rather than the card's `×`, because the two are a few pixels apart and mean
  different scopes.
- **The selection gets a column at two columns and a row at one**, and either way it
  is on screen at the same time as the graph. A tap on a point has its effect where
  the finger already is.
- **`narrow-short` is what is left when there is no height even for the row** — a
  window dragged small in both axes, a phone with the keyboard up — and there the
  graph and the details pane go back to taking turns. It is the only arrangement that
  switches anything. The list is still a sheet: a window this size has *less* to
  spare for a pane read once a session, not more. The bar holds the button and the
  switcher side by side, which is why there is one bar element rather than two grid
  items; two items in one grid area stack on top of each other.
- **The row's share is a reserve, not a cap.** `min(45%, 100% − 382px)`,
  where 370 is the graph's collapsed-header floor plus the bar. A cap protects the
  graph on a *tall* window and does nothing on a short one, and here it is the short
  one that needs protecting: a 667px phone lands the graph exactly on its 325px floor
  and spends the remaining 285 on the pane, while a 932px one takes its 45% with room
  over. 45% is the one number in this section chosen by eye rather than derived — past
  about half the screen the plot stops having the vertical range to tell two levels
  apart, and every point in it is a tap target.
- **The graph's floor for that row is the collapsed-header one, 325 rather than
  430**, and that is a second floor rather than a correction of the first.
  `GRAPH_MIN_HEIGHT` is what the graph is worth drawing at with its controls *open*;
  325 is the same sum with the header collapsed to its one-line bar (graphs.md, "A
  pane too small for the bar collapses it to one line"). Using the smaller one here
  is not a concession, because it is a bargain the graph pane strikes for itself
  anyway: `collapsible` fires at exactly `GRAPH_MIN_HEIGHT`, so a stacked graph under
  430px has a one-line header whether the constant exists or not. What the constant
  does is stop the *threshold* from turning away a 667px phone that would have been
  fine.
- **`NARROW_STACK_MIN_HEIGHT` is a sum, not a division.** The reserve above has
  already guaranteed the graph its floor at every height, so the question left is
  whether what remains is a pane worth stacking: 325 + 45 + 200 = 570.
  `DETAILS_MIN_ROW` is therefore a term in the arithmetic. It used to be neither
  that nor anything else — the deleted `medium` sized its row as a bare percentage,
  so 200 was a number `layout.test.ts` confirmed the arithmetic had happened to
  clear.
- **With nothing plotted the details row goes and the graph takes the window.**
  Otherwise a phone shows two empty states stacked — "tap a point in the graph" in
  380px, under "Nothing plotted yet" in 400. This is the layout change that
  reserving space exists to prevent, and it is allowed because of *where the user is
  when it happens*: every path between nothing plotted and something plotted runs
  through the Add-series panel or the sheet, and at this width both cover the whole
  window, so the row appears and disappears behind something opaque. The bar stays
  either way, which keeps the one always-tappable piece of chrome from moving.
- **Wherever the details pane is a row, the row is reserved rather than grown
  into.** Sizing it to its content would move the graph under the pointer on the
  very click that fills it — the thing this app doesn't do (see "Layout stability").
  It is the same bargain `wide` strikes, where an empty pane holds 320px of width
  open all day, and the exception below is the one case where nothing can be
  clicked yet anyway.

  **A row is also why a details *column* is preferable wherever one fits**, which
  is the other half of why demoting the list was the right trade: the pane's content
  runs past 1000px, so a full-height 320px column shows most of it and a 380px row
  shows the first third. The graph keeps every pixel of height either way.
- **A tier switches rather than stacks only when there is no height to stack in**,
  and then two cramped panes are worse than one with the window. A click on the graph moves the switcher to Selection,
  because wherever the selection is switched that click's only visible effect is
  in a pane you would otherwise have to go and find — but only on a *change of
  point*, so zooming or toggling a switch leaves you where you are.

  **The reverse move belongs in the same place, and putting it in `resolvePane`
  instead was a switcher button that ate the tap.** A selection can go away
  without the user asking — removing the last series, a Back that drops the point
  — and leaving the switcher pressed on a pane that now only says "tap a point" is
  not what they were reading. But that is a reason to move *off* Selection at the
  moment the point goes, which is one `$effect` in App.svelte beside the one that
  moves onto it. Deciding it on every render could not tell a stale request from a
  deliberate tap, so tapping Selection with nothing selected showed the graph: a
  pressed button, an unpressed button, and on a touchscreen a leftover `:hover`
  the finger had no way to clear. The pane's empty state is worth reading — it is
  the instruction for how to fill it, and the only place the *gesture* is named.

  **The leftover `:hover` is not a bug in this app and was deliberately left
  alone.** A touchscreen browser matches `:hover` on the element you tapped and
  keeps matching it until you tap something else; that is how the platform
  behaves, and every idle hover in the app inherits it. Putting them all behind
  `@media (hover: hover)` was tried and reverted as too heavy-handed for what it
  buys — it is eighteen rules across six files, `pointer: coarse` cannot stand in
  for it (a touchscreen laptop is coarse *and* hover), and the `:active:hover`
  pressed rules have to stay outside the query or a finger loses its only press
  feedback. What made the switcher's leftover read as damage was the tap doing
  nothing underneath it, and that is what is fixed here.
  `resolvePane` is now the one fallback that is genuinely about the arrangement: a
  pane this tier doesn't switch can't be the active one.
- **A slot asks whether it is visible, not whether it is the active pane.**
  `isPaneVisible` is `!switched || active`, which is what keeps one CSS rule for
  hiding the rest across arrangements that hide *different* slots for different
  reasons. The list is never a switched pane, so a plain `pane === active` test
  hides it whenever the switcher is on something else — and the shell would then
  have no way to say "the sheet is open" through the same attribute, which is what
  the list slot's `data-active` actually means below `wide`. Resolving both into one
  attribute is what keeps one CSS rule for hiding.
- **The tier is decided in JS and published as `data-layout`, not written as
  media queries.** Two things that are not CSS have to agree with it: which
  panes the Add-series panel covers, and therefore which are `inert` while it's
  open — a DOM property no media query can set — and whether the switcher and the
  bar are rendered at all. A media query plus a matching `matchMedia` is the same
  two numbers written twice, and the failure is silent. The numbers live in
  [layout.ts](../src/lib/shared/layout.ts) with a unit test that asserts the
  property they exist for: whatever the window, the graph is at or above its
  minimum — its 430 where the header is open, its 325 where the tier has already
  collapsed it.
- **The panes don't draw their own borders; the slots do.** Which of a pane's
  sides faces another pane is a fact about the arrangement, and the arrangement
  changes: the details pane drew its own `border-left` until it moved under the
  graph, where that edge lands against the series list's `border-right` and the
  two render as one 2px rule. A pane can't know that. `main` draws exactly one
  rule per seam, per tier.
- **Each pane gets a slot `div` that is the grid item.** The panes are
  components with scoped styles, so the shell can't place them without reaching
  through `:global` for a class name three files away. The slot is also where
  `inert` goes, which is what lets the list be live beside the panel in `wide`
  and covered in the three tiers where it is a sheet — and, for the sheet itself,
  what lets it take the panes behind it out of the tab order only in the two where
  it covers them.

The one-column tiers are also the ones that found two long-standing bugs in the picker,
both of which bit at any window under ~1150px and are described in the next
section.

### The Add-series panel docks beside the series list

The panel used to be a full-screen modal over an `inert` `<main>`. It now
starts where the series list ends (`inset: 0 0 0 var(--sidebar-width)`),
so the list stays lit, live and clickable the whole time the panel is
open.

This is the other half of making Add mean something. A control that acts
immediately still needs somewhere for the user to *see* that it acted,
and the series list is the honest place: it's where the series will be
when the panel closes, it shows the color the row's swatch just took,
and its `×` is the removal control the user is going to use anyway. A
tray inside the panel would have been a second place to manage series
that exists only inside a dialog.

**Docking only means something where the list is a column, which is now `wide`
alone.** Below it the list is a sheet (previous section) and there is nothing to
dock beside, so the panel takes the window — and what carries the feedback there is
the panel's own rows, which mark what is already plotted and in which color
(`plottedColors`). That was already the case at one column and is now the case at
two; the live list beside the panel is the better answer where there is room for it,
not the only one. The panel asks `listIsSheet`, published as `data-full`, rather
than naming the tiers: whether it docks is the single question "is the list there",
and naming tiers here would be one more copy of that list to keep in step.

- **`--sidebar-width` lives in app.css**, because `main`'s grid and the
  panel's `inset` are in two scoped stylesheets with no other way to
  agree on the number. Drift would put the panel over the list.
- **The two panes the panel covers are inert; the list is not.** They're
  wrapped in a `display: contents` div carrying `inert` — `inert` is a
  DOM-tree property and grid placement is a layout one, so the panes stay
  direct grid children and the three-column layout is untouched. Without
  this, Tab wanders into invisible controls behind the panel.
- **No `aria-modal`, and no click-to-dismiss.** Neither is true any more:
  with the list live beside it this is a non-modal dialog, and a stray
  click near the panel's edge closing it would be a trap rather than an
  escape hatch. `Done`, the close button and Escape are the ways out.
- **The dim stays.** It's what says the graph behind is out of play while
  the list beside it isn't.
- **The list's own "Add series…" button is disabled while the panel is
  open**, and sheds `.btn-primary` for plain `.btn`. As a modal it was
  unreachable; docked, it sat there offering hover feedback for a click
  that did nothing. Disabled rather than a close toggle: this list is live
  next to the panel, so someone reaching for "Add series…" *here* has
  adding in mind, and a toggle would answer that by closing the panel.
  Disabled can't misfire, and there are three exits already. Dropping
  `.btn-primary` is both honest — the primary action is in the panel now —
  and required: only outline buttons may use `.btn`'s fading disabled
  state, since a translucent fill reads as a rendering glitch. Label and
  padding are unchanged, so the header doesn't re-flow.
- **Left-aligned, still capped at 1400px.** On a display wide enough for
  the cap to bite, the leftover is graph — dimmed, but visible, and
  better company than empty backdrop.
- **Below `wide` there is no beside, so the panel takes the window** and
  the list's slot goes `inert` with the other two. This is the case the
  original version of this section ruled out — "no breakpoint that hands the
  sidebar back, inert-ness would then have to depend on the viewport, which
  CSS can't drive". The objection was right about CSS and wrong about the
  conclusion: the viewport *is* what decides, so the deciding moved to JS. See
  the previous section.
- The panel is ~280px narrower than it was. The table's `min-width: 64em`
  and its wrapper's `overflow: auto` were supposed to handle that — at a 1152px
  window the table fits exactly, and below that it should scroll horizontally
  rather than the columns collapsing. **It didn't, and hadn't since the panel
  learned to dock.** Two separate faults, both of which left a control off the
  right-hand edge of the window with nothing to scroll to reach it:
  - `.picker` sets `margin: 0 auto` to centre itself under the 1400px cap. An
    auto margin on the *cross* axis turns off a flex item's stretch, so the box
    was sized to fit its content — and its content has a floor, that 64em
    table. Below a ~1150px window it stopped shrinking at 866px and simply hung
    off the edge, taking the close button with it; Escape was the only way out.
    The fix is `width: 100%` beside the margins, which restores the stretch and
    lands the shrink on `.table-wrap`, where the `overflow: auto` was waiting.
    (`min-width: 0` on `.overlay-panel` is *not* the fix and was tried: its
    `width: min(1400px, 100%)` already caps its own automatic minimum.)
  - `.status` was a nowrap flex row carrying 27ch of reserved count before its
    buttons even start, so `Done` went over the edge next. It wraps now, which
    costs nothing at widths where it fits.

  The lesson worth keeping: the `min-height: 0` chain this panel documents
  carefully has a horizontal twin, and a `min-width` deep inside a flex chain
  propagates *up* as an automatic minimum until something definite stops it.

### Rows already on the graph show their swatch

A direct consequence of the prefill: the list you land on contains the
series you already have. `AppState.plottedColors` (`Series.key` → the
color it's drawn in) reaches `PickerState.plotted`, and those rows render
the same colored swatch the series list uses, over a faint blue row tint.

- **A swatch, not a disabled checked checkbox.** It says "this is the
  purple line on your graph" rather than just "no". The shared vocabulary
  with the series list is the point.
- `addableRows` excludes plotted rows, so the bulk button doesn't count
  rows whose control is `Remove` (it would offer "Add all 7" and then add
  four no-ops). `removableRows` is the complement, and both are scoped to
  what the filter shows — `Remove all n` takes off the rows in front of
  you, not the whole graph.
- The lookup only works because `Series.key` (built in
  [series.ts::toSeries](../src/lib/picker/series.ts)) and
  [graphData.ts::seriesKey](../src/lib/graphs/graphData.ts) compose the same
  `${repo}|${signature id}` string from two different modules. Drift
  there would silently un-mark every row, so series.test.ts pins it.
- The prop is **synced, not seeded**, and now has to be: `Remove` changes
  the plotted set with the panel still open, so a seeded copy would leave
  the row claiming to be on a graph it had just left.

### Run activity is fetched for the visible window only

Two rows in the picker can differ only in ways the columns don't make
meaningful — three platform variants of one suite, a `-fis` and a `-nofis`
option set — and nothing on screen said which one is actually being
measured. The `runs (14 days)` column answers that: a count over the
selected time range, plus a density strip of when those runs happened, so
"ran heavily for three days then stopped" doesn't read as healthy the way a
bare count does.

Data comes from `/project/<repo>/performance/data/`, which takes many
`signature_id`s per request — about 3.5 KB gzipped each, so one screenful is
one request per repo rather than one per row. That's what makes the column
affordable enough to be always-on rather than reveal-on-hover, which would
defeat the point: the hard part is *scanning* a list, which you can't do one
row at a time.

Three quirks of that endpoint, all recorded in
[activityApi.ts](../src/lib/picker/activityApi.ts) and
[activity.ts](../src/lib/picker/activity.ts):

- **The response is keyed by `signature_hash`, not by id**, and the hash
  aliases within a repo (see "Row identity" above), so one bucket can hold
  datums for two requested series. `buildActivities` regroups on each
  datum's own `signature_id` and ignores the keys.
- **Signatures with no data are omitted**, not returned empty. Iterating the
  *requested* ids is what turns that silence into `total: 0` — otherwise an
  idle row stays pending forever, and "this never runs" is exactly the answer
  the column exists to give.
- **Requests cap out at ~195 ids**: treeherder's frontend rejects a longer
  request line (`Request Line is too large (6069 > 4094)`) before Django sees
  it. We batch at 150.

Bins are aligned to the **end** of the window. At 90 days the range isn't a
whole multiple of the 4-day bin, so one bin is partial; aligned to the start
it would be the rightmost bar — the one that answers "is this running *now*"
— covering half the time of its neighbours and reading as a decline that
isn't there.

**Bar heights share one scale across the visible window**, rather than each
strip normalising to its own tallest bin. Per-row scaling meant a job running
twice a day and a job running twice an hour both drew a full-height strip, so
the strip could only be read for *when* a series ran, never *how much* — and
comparing two rows, which is the entire reason they're in one flat list,
silently compared nothing. `maxBinCount` over the visible window (overscan
included) is the denominator, passed into `activityPath` as `scaleMax`; the
column header's tooltip says what a full-height bar currently means, since
otherwise the scale is invisible.

The scale is the *visible* window and not the whole filtered set on purpose:
we only have counts for what's on screen anyway (see above), and a pass over
~30 rows per scroll tick is free where a pass over ~25k wouldn't be. The
consequence is that scrolling and filtering rescale the strips — accepted,
because a scale that follows what you can actually see is what makes the
comparison mean anything. `activityPath` clamps bar height to the box for the
one frame where a late-arriving row can exceed a scale computed before it
landed.

**The column is deliberately not sortable.** Sorting would need counts for
every one of the ~25k filtered rows; we fetch only the ~29 on screen. If
sorting turns out to be what's wanted, the shape of the fix is to fetch
counts for the whole filtered set once it's under a couple of hundred rows
and enable the header then.

A failed activity fetch is recorded on the row as a muted `—`, not in the
error banner: the column is decoration on a list that works without it, and
it must not be the reason the picker looks broken.

One layout note, since it was measured rather than guessed: the existing
column percentages summed to exactly 100%, which over-specifies the table
once a px-width column joins them under `table-layout: fixed`, so they came
down. Raising the table's `min-width` to compensate was tried and reverted —
at 1100px and above the columns come out identical either way, and below that
its only effect is to push the panel further past the edge of a narrow window.

### Theming: one resolved attribute, one exception

Light and dark, defaulting to the OS. The three moving parts:

- **[src/app.css](../src/app.css) holds every color in the app**, as custom
  properties, with one `:root` block per theme. No component may hardcode a
  hex value — a literal is a color that exists in one theme, and it will be
  the one unreadable thing on screen in the other. The values are GitHub
  Primer's two scales, which is where the original hardcoded palette came
  from.
- **`<html data-theme>` carries a *resolved* theme** — `light` or `dark`,
  never `system`. The OS query is answered in JS
  ([theme.svelte.ts](../src/lib/shared/theme.svelte.ts)), not by a
  `prefers-color-scheme` media query in the stylesheet. That's the load-bearing
  decision: a media query would be a second, independent answer to "which theme
  is it", and forcing a theme would then have to out-specify it in every block.
  With one resolver there is one dark block in the CSS, and the canvas palette
  below can't disagree with it.
- **The preference is `system` | `light` | `dark`, and `system` is stored as
  `system`.** Rewriting it to whichever theme it currently resolves to would
  silently stop it following the OS.

**The control has three preferences but two states.** `system` is not a third
*appearance* — at any moment it looks exactly like light or exactly like dark, so
a three-segment control spends a third of itself distinguishing two things that
are on screen identical. [ThemeToggle.svelte](../src/lib/shared/ThemeToggle.svelte) is
one `role="switch"` button showing the **resolved** theme, and the preference is
inferred from the destination by `nextThemePreference`: an override is stored only
when it actually overrides, so light → dark → light lands back on `system` rather
than leaving a redundant `light` behind, and the round trip is pinned in
`theme.test.ts` (one click always flips what's on screen; two always restore it).
Reasoning follows [Lea Verou on dark mode
toggles](https://lea.verou.me/blog/2026/dark-mode-toggles/). The cost is that
"am I following the OS?" is no longer visible; it's in the `title`, because it
changes nothing about what the next click does.

**It lives in the shell's bottom bar**, not in the graph header and no longer in
the series pane's footer.

The graph header was the first candidate and is wrong: it is a row of *graph
viewport* controls (range presets, replicate drawing, zoom), a global appearance
preference in that run reads as a fourth one, and the header wraps — which would
make the toggle's position a function of window width.

So it went to the series list's footer, which was the only other always-on-screen
chrome. **That stopped being true when the list stopped being a pane**: below `wide`
the list is a sheet behind a button, so an app-level preference had become reachable
only by opening a *data* control, and one tap deeper than it had ever been. The bar
is the fix and it is also what the footer was standing in for — the app has chrome of
its own now, in the bottom-left corner at every width, and the toggle is the one
thing in it that is always there. In `wide` that is the same 45px in the same corner
the footer used to occupy, so nothing moved on screen; what changed is which element
owns the corner. See "The shell has four arrangements", the bar.

`color-scheme` is set alongside the tokens rather than left as `light dark`,
which is what gets form controls, scrollbars and default link colors to match.
It has to be pinned per theme for the same reason as above: on `light dark` the
UA would decide for itself and a forced theme would only half-apply.

**Two things can't be a custom property, and both are on the graphs.**

- *Canvas colors.* There's no element for a canvas's pixels to inherit from.
  [theme.ts](../src/lib/shared/theme.ts) exports `CHART_PALETTES` and the draw calls
  take a `palette` argument, which also keeps
  [chartDraw.ts](../src/lib/graphs/chartDraw.ts) and
  [distributionDraw.ts](../src/lib/graphs/distributionDraw.ts) functions of their
  arguments. The alternative — `getComputedStyle` inside the draw code — would
  make them depend on the DOM *and* on the attribute having already been
  applied. Those seven values are the only colors in the app that exist twice;
  each names the token it mirrors.
- *Series colors.* Half of treeherder's palette is unusable on a dark plot:
  blue-bell, purple and dark-puce all land under 2:1 against the canvas, which
  is a series you cannot find. `SERIES_COLORS_DARK` in
  [chart.ts](../src/lib/shared/chart.ts) is the same six hues in the same order,
  lightened past 4.5:1 (pinned in `theme.test.ts`), so **the theme picks the
  palette but never the position** — flipping it recolors each series in place
  instead of reshuffling the graph. Cerulean and orange were already light
  enough and carry over untouched. This is the one place we knowingly diverge
  from treeherder's colors, and only in dark mode.

`styleForIndex(i, theme)` defaults to `'light'`, so the parity assertions in
`chart.test.ts` and anything else that doesn't know about themes keeps getting
treeherder's six.

**The theme is a singleton, not a prop.** [theme.svelte.ts](../src/lib/shared/theme.svelte.ts)
exports one `ThemeController` instance, read by `AppState` (for series colors)
and by the two chart components (for the canvas palette). Those have no props
relationship, and threading it down would mean five components forwarding a
value they don't use and every `AppState` test constructing one. It applies the
attribute imperatively from the three places that can change the outcome, rather
than from an `$effect` — a module is neither a component nor an `$effect.root`,
and it means the attribute is already correct when a repaint in the same task
reads it.

**[index.html](../index.html) resolves the theme again, inline, before the first
paint.** A module import can't run early enough, so a dark-mode user would get a
white flash for the length of the module graph load. It duplicates the storage
key and the resolution rule in three lines; keep them in step.

`localStorage` throws rather than no-ops where storage is blocked by policy or
private mode. Both ends swallow it — the session just doesn't remember the
choice, which is not worth taking the app down for.

### One button, defined once

`.btn` in [app.css](../src/app.css) is the app's button chrome — border,
radius, canvas fill, hover, pressed, disabled — plus `.btn-compact` for the
toolbar size, two fills (`.btn-primary` accent, and `.btn-selected` for the
option in a group that is in effect), and `.btn-group`, the recessed track that
makes a one-of-several choice read as one control.

It exists because the same six-line recipe had been copied into five
components, and the copies had drifted: paddings of `4px 12px`, `4px 10px`,
`3px 8px`, `2px 8px` and `1px 6px`, and a disabled state that was
`opacity: 0.4` in the series list, `0.45` in the graph header and a full color
swap in the picker — with three of those panes on screen simultaneously. The
same rule as for colors applies, and for the same reason: a value that exists
in five places is five values.

Three things to know before changing it:

- **It's opt-in (`class="btn"`), not a bare `button` rule.** Most buttons in
  this app are *not* this shape — badges, swatches, sort headers, disclosure
  triangles, chip removers — and they outnumber the plain ones, so a default
  would mostly be something to undo. It was exactly such a default that made a
  series swatch lose its color on hover: SeriesList's component-wide
  `button:hover` outranked `.swatch`, which never declared a hover of its own,
  so pointing at a series greyed out the one thing identifying it.
- **Pressed is `:active:hover`, and every filled variant needs its own.** A
  pointer held down and dragged off a button keeps `:active` everywhere, and a
  control that still looks pressed with the cursor elsewhere is promising an
  activation that will not happen; pairing the two makes the state mean *let go
  here and this happens*. The cost is that a keyboard Space press flashes
  nothing, which is `:focus-visible`'s job anyway. The generic rule is one class
  and three pseudo-classes, so it outranks a variant's plain `:hover` — which is
  the same trap the `:hover` note in app.css records, one state further down.
- **A component rule that has to beat `.btn:hover` needs `.btn` in its own
  selector.** `.btn:hover:not(:disabled)` is (0,3,0); a plain
  `.replicates li.selected button` is (0,2,2) and loses. The selected
  replicate chip in [DetailsPane](../src/lib/graphs/DetailsPane.svelte) names
  `button.btn` for that reason. (Svelte's scoping class covers this for most
  component selectors — but not for one that was already only two classes
  deep.)

Sizes used in one place only stay in that component, composed on top of
`.btn` so the chrome is still defined once: the picker's square close button,
the series list's icon buttons, the details pane's inline `.unpin` /
`.cmp-prev`, and the replicate chips, whose width is a measured value (see the
comment above `.replicates`) rather than a size anyone else should reuse.

### Touch: a floor under the controls a thumb drives, and copy that names a gesture the reader has

Every control here was sized for a pointer you can put on a 24px target. `.btn`
comes out 26px tall, `.btn-compact` 24, the series list's icon buttons 20×18, a
chip's remove 21×18, a checkbox 13 square. Apple asks for 44px and Material for
48, and the survey that started this work found nineteen distinct targets under
30px on a phone.

**The floor is in one `@media (pointer: coarse)` block in app.css**, beside `.btn`
for the reason `.btn` is in one place. **It is one number — 32 — and that matters
more than which number it is.** The block started at 36 on `.btn`, and 36 is what
made everything else in it necessary:

| Rule the 36 needed | Why it went away at 32 |
| --- | --- |
| `.btn-compact { min-height: 32 }` | it carries `.btn`, so it inherits the floor |
| `.btn-group > .btn { padding-block: 2px }` | existed to claw back `.btn`'s matching `padding-block`, which a `min-height` never needed — a `<button>` centres its own content |
| `tbody .btn { min-height: 0 }` in the picker | a 32px button fits a 36px table row; a 36px one did not, and desynchronised the virtualizer |

So the whole thing is now `.btn` at 32, `<select>` at 32, the checkboxes at 18
square, and 16px on the fields that can be *typed into*. Components add to it only
where they own a size it can't express, and they all use the same 32: the series
list's icon buttons and drag handle 32 square, the theme toggle 72×32 (its width is
the point of the control, so it is a fixed size rather than a floor), the filter
box's chip removers 32, the series list header's two icon buttons 32 square — the
sheet's close, which is the same shape and mark as the panel's because it is the same
control, and `Remove all` — and the panel's three other shapes below. **There are
no exceptions left, and there was one.** The bottom bar's two controls — the pane
switcher and the series sheet's handle — took the guideline's 44 for a while, on
the grounds that they are the app's primary navigation and are driven by a thumb at
the far end of its reach. Both of those are true; neither was worth the second
number. They carry `.btn`, so 32 already reached them, and the 44 was making the
bar 57px tall — 12px off the graph *and* the details row, on every phone, to make
two comfortable targets 37% taller. It also cost more than its own height: the bar
is a term in the one-column threshold (`BOTTOM_BAR_HEIGHT`), so those 12px were
deciding, 12px earlier than they had to, that a phone could no longer keep the
graph and the selection on screen together. One number in the whole app.

**This app is not phone-first, and the floor should not pretend otherwise.** What
a phone gets here is a list of performance data to read; the four px between 36
and 32 were coming straight out of that list, and at 36 the panel's chrome cost
~20px of it on every phone and a whole card row at a 596px window. 32 is what a
fingertip hits reliably in practice. Adjacent-target spacing does as much work as
size anyway, and these blocks' gaps were already generous.

**A pill, a summary line and a direction button are not `.btn`, and the first pass
missed all three.** The panel's chrome had four targets under the floor because
none of them carries the class it is written against: the repository chips at
30px, the folded load row's summary line at 30, the time-range `<select>` at 29,
and the card list's sort `<select>` at 22 with a 25×32 direction button beside it.
Each is now one declaration in AddSeriesPicker's coarse block — **a `min-height`,
and nothing else.** All three centre their own content, so a floor needs no
matching padding, and the first version's paddings and gaps were either redundant
or paid for in width: 12px of chip padding cost a whole *line* of chips, because
`mozilla-beta` and `try` then came to 336px against 334px of card.

Two of them are worth knowing about beyond the number:

- **A floor on a checkbox does not float the pill it is in.** The chips' 4px of
  padding was sized around a 13px checkbox; once the global rule grew the box the
  pill had collapsed onto it — 30px tall, the checkbox touching both edges of a
  999px radius. What was wrong there was the collapse, not the height.
- **A `<select>` is not the iOS zoom case, and was treated as one.** app.css put
  16px on `input`, `select` and `textarea` alike; a select opens a native picker
  rather than taking a caret, so it is not the field that rule is about. 16px there
  was expensive in a way it is not on a text field — it is the widest thing in the
  picker's status row, whose width decides whether that row wraps, and a wrap is
  44px of list. It also read as oversized, being the one 16px string in a block of
  13–14px ones. **Height was what these needed, not size.** While they were at
  16px the row had to drop its `sort` word and tighten its gap to fit; both came
  back with the font.

`.control-toggle` gets **no** floor, and one was tried: the checkbox is sized by
the global rule and the label beside it is part of the target, so "Match inside
subtests" is already 167px wide and the graph header's two are wider. Giving the
label 32px cost 12px of the picker's list in every case measured and 12px of the
graph header on a phone — the worst ratio of list spent to mis-tap avoided here.
Height is not the axis a 167px-wide target is short in.

Beyond the chrome, the card list's disclosure caret goes to 28×32 on touch: a
20×20 target 6px from a button that puts a series on the graph is a mis-tap with a
visible consequence, the height is free because the card's head line is already as
tall as the `.btn` in it, and the width costs 8px of the suite name. The attribute
badges stay at 19px, which is the one thing here that is *not* a matter of adding a
floor: they are two lines inside `CARD_ROW_HEIGHT`, and every row in the flat list
has to be exactly that tall.

Where the panel lands, against never having done any of this
(`tools/visual/picker-rollback-costs.mjs` and `picker-compact-tier.mjs` are the
two that measure the trade):

| Viewport | Before | At a 36 floor | At 32 |
| --- | --- | --- | --- |
| 390×844 | 518px (6 rows) | 500 (6) | **524 (6)** |
| 390×844, load row open | 344 (4) | 308 (3) | **348 (4)** |
| 596×900 | 493 (6) | 457 (5) | **489 (6)** |
| 900×900 docked | 481 (5) | 507 (6) | **507 (6)** |

Every target ends up at or above 32 and the list ends up *larger* than it was
before the floor existed — the 900px gain is the `.control-aside` fix rather than
the floor, and the phone's is the 4px times the several controls stacked in that
block.

Four things about this that are not obvious:

- **`pointer: coarse`, not a width.** The question is what is driving the app: a
  touchscreen laptop at 1400px needs the floor and a 400px window on a desktop
  does not. Every other query in this file is a *container* query about layout,
  which is a different question with a different answer.
- **A media query adds no specificity, and neither does a container query.** A
  `@media (pointer: coarse)` block placed *above* the rule it means to override
  loses to it — the later declaration of the same property wins at equal
  specificity. This bit twice in one pass, and twice more in the next, that time
  in `@container` blocks: `.control-aside` went on stacking on a landscape phone
  and the picker's status row went on wrapping at 375px, both because the
  override was written where the *narrow* rules already lived rather than after
  the declaration it was fighting. Every symptom is the same — a rule that is
  obviously present and does nothing. **Both kinds of query go last.** Where that
  means splitting a narrow block in two, split it and say so at both halves;
  app.css's `.control-aside` and AddSeriesPicker's `.status` are the two doing it.
  It is also worth checking that a narrow override *can* fire at all: the panel
  had a `.bulk { min-width: 0 }` under 560px for a button only rendered above
  600.
- **A scoped `font: inherit` beats a global `input[type='text']`.** Svelte adds
  its own class to component selectors, so `.filter-text` is `(0,2,0)` against
  the global rule's `(0,1,1)`. The 16px override for the filter box therefore has
  to live in FilterInput. It matters because **iOS zooms the page when a field
  under 16px takes focus**, which scales the layout viewport up and pushes half
  the panel off screen; `maximum-scale=1` is the other fix and it takes
  pinch-zoom away from everybody. This is the *only* place in the app that needs
  the 16px — it is a real text-entry field, and the one the panel exists for. The
  two `<select>`s were in the same rule and are not the same case; see above.
- **The floor must fit inside a fixed-height row, or be taken back out of it.**
  The picker's table gives every row exactly `--row-height` = 36px and puts a
  `.btn` in it. At a 36 floor that overflowed its own slot and desynchronised the
  virtualizer, and AddSeriesPicker carried a `tbody .btn { min-height: 0 }`
  exemption for it; at 32 it fits and the exemption is gone. Whichever way it
  goes, `tools/visual/picker-card-pitch.mjs` and `picker-table-touch-pitch.mjs`
  are what check it — the second one is a *touchscreen wide enough for the table*,
  which is the only configuration where the floor and a fixed row height meet.

Three more platform facts, all cheap and all invisible where they don't apply:

- **`touch-action: manipulation` on the root**, which turns off double-tap-to-zoom
  and, with it, the ~300ms every tap waits to find out whether a second one is
  coming. They are one behaviour, not two: a tap can't be delivered until it is
  known not to be the first half of a zoom gesture, so the symptom is a button that
  feels broken and a caret that lands late. Nothing here wants a double-tap — the
  layout is laid out for the width it is on, and the app's one `dblclick` handler
  (reset the graph's zoom) sits on ScatterChart's `.chart` wrapper, which declares
  `touch-action: none` on that same element.
  **`manipulation` is the value that keeps pinch-zoom**, which is the whole reason
  to reach for it instead of `user-scalable=no` or `maximum-scale=1`: a reader who
  needs the text bigger can still get it. It goes on the root because
  `touch-action` is not inherited but *is* intersected up the ancestor chain — one
  declaration covers every target, and the two elements that want the stricter
  `none` still get it. It also takes no `(pointer: coarse)` guard, being inert for
  a mouse by definition; the coarse block is for the rules that cost list height,
  and this one costs nothing.
- **Safe-area insets on `main`**, so the plot doesn't run under a notch in
  landscape and the bottom bar's edge clears the home indicator. `env()`
  resolves to 0 where there is no inset, and `box-sizing: border-box` keeps the
  padding inside the `100dvh` instead of adding to it.
- **`overscroll-behavior: contain` on all three scrollers** (the picker's list,
  the series list, the details pane). A flick that reaches the end of a list
  should end there rather than handing the rest of the gesture to a document with
  nothing to scroll — or, on some browsers, to a pull-to-refresh that throws the
  panel away.

**And the copy has to name a gesture the reader's device has.** The details
pane's empty state said *"Click a point… Shift-click a second point to compare"*
and the comparison hint offered the `C` key — on a phone, three instructions
none of which can be followed, which reads as a broken feature rather than as a
feature for somebody else. `isCoarsePointer` (shared/pointer.ts, unit-tested
alongside `shouldAutofocus`) picks the wording, and the touch version names what
a finger *can* do: tap a point, tap a change bar, or use "Compare with the
previous push". Read once at component init — a mouse plugged in mid-session is
not worth a listener. It is a separate query from `shouldAutofocus`'s
`(pointer: fine)` and deliberately not its negation: a device can answer no to
both.

**A control that opens something carries `ChevronIcon`, not `▾`.** The text
triangles (`▾ ▴ ▲ ▼`) are the wrong size at every font size this app uses: at
13px they draw about 6px of ink beside a 13px label, and the obvious fix — shrink
the label's font so the glyph looks proportionate — makes a control whose *text*
is too small instead. A drawn chevron is sized in px, so it can be as big as the
line it sits on. One component for the three places that need one (the graph
header's Controls toggle, the panel's load-row summary, the card list's sort
direction), for the same reason `CrossIcon` is one component: they sit at
different sizes and have to read as the same mark. Its two directions are one
path with a rotation, so neither can be adjusted without the other.

**The theme toggle's sun and moon are drawn too, and there the font was choosing
the *shape*.** They were `☼` and `☾`. A text glyph's design is the font's to make
and there is no way to ask for a filled one, so on Android the moon arrived as a
hairline outline and the sun as a ring with a dot — against the thumb's accent
fill, at 24px, an outline mark on a saturated ground is the one thing that had to
not happen, and nothing in the app could have specified otherwise. The drawn pair
is a filled disc with stroked rays and a filled crescent (two arcs of one closed
subpath — a disc with a second disc masked out would need an `id`, and a
component has no promise of being rendered once). Unlike the three above they are
inline in [ThemeToggle.svelte](../src/lib/shared/ThemeToggle.svelte) rather than
components in `shared/`: those are each one component because they have three
call sites at three sizes to hold in step, and this pair has one call site and is
only legible as a pair. The sun is filled rather than a ring for the same reason
the moon is — beside a solid crescent, an outlined sun reads as the lesser of the
two states rather than its equal.

### Two loading cues, and which wait each one is for

`.spinner` and `.pulse` in [app.css](../src/app.css) are the app's only two
animated loading marks, and the choice between them is about **what the wait
is**, not how long it is:

- **`.spinner`** — a named request is out. It goes where that request's answer
  will appear, so it reads as *this number is coming* and says nothing about the
  rest of the row: the series card puts it in the point-count slot, beside
  "loading…". Motion is the whole point of it. The card had said "loading…" in
  that slot from the beginning, and text is the part that was already right —
  what a static label cannot distinguish is a slow fetch from a hung one, and a
  90-day two-series load takes long enough for that to be a real question.
- **`.pulse`** — a placeholder standing in for content that isn't there yet. The
  picker's skeleton rows, and the series card's `· alerts…`, which holds the
  alert count's place while that second fetch is out.

Both are opt-in classes, both stop under `prefers-reduced-motion`, and both live
in app.css for the reason `.btn` does: a 1.2s pulse next to a copy that drifted
to 1.4s looks like a bug, and a hand-rolled second spinner would be the fifth
copied recipe this file already has a section about.

Two things they are deliberately *not*:

- **Not the card as a whole.** A bar or a shimmer across the whole card would
  claim the whole card is unknown. Its identity line can be filled in
  independently of its data — today they land together, out of one
  `/performance/summary/` response, but that is this implementation and not the
  shape of the card, and a cue placed per-slot survives that changing.
- **Not a substitute for the text.** The spinner is `aria-hidden`; "loading…"
  beside it is what a screen reader gets, and it is also what remains under
  reduced motion. A cue that is only an animation says nothing to either.

**Whether a wait needs a cue at all is a question about honesty, not about
duration.** The alert count is the case that decided it: for several seconds
after the dots land, a card reading "1,592 points · 7 changes · +3.5% drift" is
a complete-looking summary that is one badge short, and the user cannot tell
that from the same card with no alerts. The graph header's "Loading N…" and the
plot's "Loading…" note, by contrast, name a wait the empty graph already makes
obvious, so they stay plain text.

### Tooltips: for what the canvas paints

**`title` is still the app's hover explanation.** Badges, icon buttons, `dt`
terms, clipped labels: all of them carry a `title`, and a new control should too.

There is exactly one exception, and it is the reason
[tooltip.ts](../src/lib/shared/tooltip.ts) exists: **an alert triangle and a
detected-change bar are pixels in a canvas.** There is no element to hang an
attribute on, so their explanation has to be drawn. Until it was, the only way to
find out what one of those marks meant was to click it and read the details pane —
where the answer is one card among several, and easy to miss.

So there is one box for the whole app
([Tooltip.svelte](../src/lib/shared/Tooltip.svelte), mounted once in App.svelte),
one reactive singleton saying what is currently in it, and one caller:
ScatterChart's hit test, which reports *that* a mark is under the pointer and asks
[graphTooltip.ts](../src/lib/graphs/graphTooltip.ts) for the words. There is
deliberately **no attachment or action for giving an element a tooltip** — that
would be a second mechanism competing with `title` for the same job, and the
canvas is what justified building anything at all.

What to know before touching it:

- **`TooltipContent` has four slots**, in reading order: a bold `title` (what the
  thing *is*), `lines` (the facts), `source` (which series, with its plot color as
  a swatch — only filled in when more than one is plotted), and a muted `hint`
  (usually what a click would do). The swatch is the part `title` could not have
  done at all.
- **Size first, place second, and the width cap comes from the viewport alone**
  (`tooltipMaxWidth`). Capping to the room left on the side the box lands on is
  the obvious refinement and it is a feedback loop: a narrower cap rewraps the
  text, which changes the height, which changes which side fits. With the cap
  fixed, the measured box is a fact and `placeTooltip` only chooses a corner —
  below-right of the cursor, flipping left and/or above independently per axis,
  clamped to the margin when neither side fits.
- **`width: max-content` on the box is load-bearing**, and cost a measurement to
  find. A `position: fixed` box with `width: auto` is shrink-to-fit against the
  gap between its `left` and the viewport's right edge, so placing it 1254px into
  a 1500px window made it 246px wide and three lines tall — and *that* is the
  size the measurement read. The flip was then decided from a size that only
  existed at the position it was flipping away from.
- **Measured once per content, not once per pointer move.** The controller keeps
  `key` (the words, joined) separate from `content` and `anchor` for exactly this:
  `getBoundingClientRect` forces layout, and a box that follows the cursor would
  otherwise pay for one on every move to re-learn a size that hasn't changed.
- **A rest delay of 350ms, with a 300ms warm window after one closes.** The marks
  sit in two narrow bands across the plot, so a pointer crossing a band passes
  several of them; opening instantly would flash a box per mark on the way past,
  and paying the delay again at every stop while scanning along the row reads as
  lag.
- **Ownership is by token**, and `hide(owner)` no-ops unless the caller is the one
  showing the box. That is what lets the chart call `hide` unconditionally
  whenever its hit test comes back empty, and keeps the overview graph from
  closing the detail graph's box.
- **A `pointerdown` or a scroll closes it**, the latter from a *capturing*
  listener on `document`: the series list and the details pane are their own
  scrollers, and scroll events from them never reach `window` on the bubble path.
- **`pointer-events: none`** — the box follows the cursor closely enough that a
  hittable one would land under the pointer, take it off the mark being described,
  and close itself.
- **Touch does nothing**, since the marks are hover targets; a box a tap can't
  dismiss, covering what was just tapped, is worse than none.
- **No `aria-describedby` and no id on the box.** A mark in a canvas cannot be
  focused, so there is nothing for a description to hang off; the keyboard path to
  an alert is the graph's own <kbd>A</kbd> / <kbd>shift-A</kbd> stepper, which
  moves the selection and answers in the details pane.

What deliberately has *no* tooltip: a hovered dot. The details pane already
describes the point under the pointer — in more depth than a box could, including
a comparison against the selection — and a box opening everywhere the pointer went
over a plot would be unusable. See graphs.md.

### Layout stability

Several places take care to not shift the list under the user's cursor:

- Repo chips: the count slot has `min-width: 4.5em` so toggling the
  checkbox — or seeing "loading…" become "7,680" — doesn't reflow the row.
- Status-row buttons stay mounted (disabled when they have nothing to act
  on) so the first click doesn't push the table down 30px.
- `plotted-count` has `min-width: 14ch` so "0 on the graph" → "12 on the
  graph" doesn't nudge anything, and the bulk button is right-aligned with
  a `min-width` so its count can grow without moving `Done`.
- The row's Add and Remove buttons share one fixed box, so a column of
  them has a straight edge that doesn't move as rows are clicked.

- The list itself fills with placeholder rows while it loads, one
  `--row-height` each (see below), rather than showing one line of centered
  text in an otherwise empty table.
- A series card's `.sub` row reserves both of its lines and clamps to them, so the
  alert count (a second fetch), the change count and the drift figure (both after
  detection) can appear without moving the cards under them. The alert count also
  holds its place with a pulsing `· alerts…` while its fetch is out, so within the
  row it resolves in place rather than pushing the badges after it — see "Two
  loading cues". Two lines rather than
  one because four badges do not fit on one — graphs.md, "The drift figure, for the
  series with no bars", has the measurement. The reserve is `calc(2 * 1.35em)`
  against a `line-height` of 1.35 rather than a pixel count, which is the next
  paragraph's point applied where stacking doesn't fit.

**When adding new UI, budget for the "loading" and "empty" states so they
occupy the same space as the "loaded" state.** This is the single biggest
polish issue in dashboards, and we've paid the tax already.

**Prefer stacking the states to measuring them.** Every reserve above is a
number somebody measured once, which makes it a fact about a screenshot: reword
the label, change a font, resize the pane, and it is quietly wrong, with nothing
failing to say so — an overflowing `min-height` just reflows again, which looks
exactly like the bug the reserve was added to prevent. Where the alternatives
are cheap to render, put them all in one grid cell instead and let the browser
take the maximum:

```css
.slot { display: grid; }
.slot > * { grid-area: 1 / 1; min-width: 0; }
.slot > [data-sizer] { visibility: hidden; }
```

The details pane's comparison block does this for both of its slots
(ComparisonSection, `.cmp-lede` and `.cmp-chart`), and carries no pixel value
for either. Three things to know before reaching for it:

- **Every sizer must be independent of the thing you are stabilising
  against.** A slot that must not move while the pointer moves can only stack
  states whose height the pointer cannot change. Where a state's content
  genuinely arrives with the interaction — a hovered comparison's labels — bound
  it instead, by making its height content-independent (`nowrap` plus a clipped
  label), and stack a placeholder for the bounded shape.
- **`min-width: 0` on the items is load-bearing.** An `auto` grid track is
  floored by its items' min-content width, so a single `nowrap` descendant sizes
  the track to its full unwrapped length — overflowing the pane sideways *and*
  re-wrapping every other stacked state against the wider track, which makes the
  stack measure the wrong thing. Same family as the `min-height: 0` flex chain
  below.
- **`visibility: hidden` is the right hiding.** It keeps the box in layout,
  which is the point, and still takes the element out of the tab order and the
  accessibility tree — verified with a real accessibility snapshot, since a
  hidden sizer duplicating a live button would otherwise be a nasty little
  regression.

### An empty list has four reasons, and says which

`PickerState.listStatus` names them, because three of them render as the
same empty table and mean different things:

- **`loading`** — placeholder rows. This deliberately includes the stretch
  before `metadataReady`: the fetch effect waits on the framework and
  option-collection maps, so no signature request is in flight yet and
  `anyLoading` is false. The list used to claim "No matching series" for
  the length of two requests it had not yet made. A *failed* metadata load
  is excluded, or the placeholders would pulse forever behind the error
  banner.
- **`no-repos`** — nothing is checked, so nothing was fetched. Pointing at
  the filter here sends the user hunting in the wrong control.
- **`no-matches`** — data arrived and the filter excluded all of it.
- **`rows`** — the normal case.

The placeholders are plain grey bars pulsing on `opacity` alone, sized in
percentages of their columns. They're `aria-hidden`, with `aria-busy` on the
scroller and the status row's "Loading…" carrying the same information for
assistive tech. Their count comes from the scroller height the virtualizer
already measures, so they fill the visible area exactly and track a resized
window for free.

### The Add-series dialog has exactly one scroller

`.overlay` (fixed, `inset: 0 0 0 var(--sidebar-width)`, 16px padding)
stretches `.overlay-panel` to
the available height; the panel, `.picker` and `.table-wrap` then form a
flex-column chain in which every element carries `min-height: 0` and the
table wrapper carries `flex: 1`. The series table absorbs all leftover
height and is the only thing that scrolls.

`min-height: 0` is the load-bearing part: flex items default to
`min-height: auto` (their content height), and the table's content height
is the whole 25k-row list — which is how the overlay itself used to
scroll, dragging the sticky table header off-screen with it.

So: **nothing between `.overlay` and `.table-wrap` may be sized by its
content**, and new chrome inside the picker (error banners, extra control
rows) is free to appear and disappear — it just takes height from the
table instead of growing the dialog. There is deliberately no fallback
scroller for extremely short viewports; below roughly 450px of height the
table shrinks toward zero rows rather than the dialog overflowing.

### A hovered cell pours its content out

The series table is `table-layout: fixed`, so a cell that doesn't fit is
simply cut off — most visibly in Options, where a row can carry six badges
in a column sized for four, and in Platform, where
`windows11-64-24h2-hw-ref-shippable` loses its tail. Hovering the cell's
content lifts the clip and the content spills over its neighbours.

Three decisions in that, all of them load-bearing:

**The hover target is an inline `.cell-flow` wrapper, not the cell.** In a
fixed-width column most rows leave the tail of the cell blank, and pouring
content out because the pointer crossed empty space is noise. The wrapper is
exactly as wide as the content and covers the gaps *between* badges, which
nothing else does — the badges are separate inline boxes with text nodes
between them, so without a wrapper the gaps are dead space in the middle of
the target. The clip lives on the cell but the intent is expressed by the
content, hence `td:has(.cell-flow:hover)`: an element cannot escape an
ancestor's `overflow: hidden` on its own.

**The backing is the row's own colour, and nothing else.** Badges are opaque
pills, but the 4px gaps between them are not, and through them the next
cell's text shows in the middle of the spill. So the wrapper paints a
background — and it gets the right one **by inheritance, not by lookup**:
`tbody td` is `background-color: inherit`, so a cell picks up whatever the
row is painted, and `.cell-flow` is `background-color: inherit`, so the
wrapper picks it up from the cell. Row states painted on the cell rather
than the row (`.plotted`, `.subtest-row`) override the cell's `inherit` and
are inherited from just the same.

The first attempt was a `--row-bg` custom property declared beside every
`background` in the file, which is worse in two ways worth remembering.
It's a second source of truth maintained by hand — add a row state, forget
the mirror, get the wrong colour. And **custom properties resolve by
proximity, not specificity**: the base `--row-bg` was declared on `tbody
td`, which, being nearer to the wrapper than `tbody tr:hover`, beat it
outright, so every plain hovered row backed its spill in canvas white
against a grey row. Inheriting the real property has no second value to
sync and no levels to get wrong.

What it deliberately does *not* have is a shadow or a border. That's what
lets the backing be unconditional: painting the row's colour over the row's
colour is invisible, so on the large majority of cells — the ones that fit
and have nothing to pour — hovering still changes nothing on screen. A
first cut had a small shadow, and the cost was exactly that: it fired on
every hovered cell and read as a popover opening over cells with nothing to
show. Suppressing it only for cells that overflow would mean measuring every
cell in JS on rows being virtualized past at speed. An invisible-when-unneeded
backing gets the same result for free.

The spill also needs `position: relative; z-index` — cell backgrounds all
paint before any cell's inline content, so an unpositioned spill would clear
the neighbour's background and still land under its badges.

**The table is an `overflow: clip` container.** Without it the spill counts
toward `.table-wrap`'s scrollable width and flashes a horizontal scrollbar —
which on a platform with classic scrollbars also takes ~15px of height off
the list and re-flows the virtualized rows, i.e. exactly the layout shift
the section above forbids. Measured: a long spill took the scroller from
1254px to 1926px, and `overflow: clip` on the table put it back. `clip`
rather than `hidden` because `clip` doesn't create a scroll container, so
the horizontal scrolling the table's `min-width: 64em` exists to provide
still works. Both Chrome and Firefox honour `clip` on a table box and keep
the sticky header sticking; the cost is that a spill wider than the
remaining table is cut off at the table's edge instead of the cell's, which
is still strictly more than was visible before.

### Whitespace between adjacent badges (Svelte gotcha)

Svelte's compiler strips whitespace between adjacent template elements. A
naive `{#each opts as o}<span class="badge">{o}</span> {/each}` produces
"optfission" when the user copy-pastes. **Always insert `{' '}` explicitly:**

```svelte
{#each opts as o}<span class="badge">{o}</span>{' '}{/each}
```

The current code uses `{@render badge(field, value, cls)}{' '}` for the same
reason.

### Virtual scrolling over a flat row list

Broad filters can match 25k parents; expanding one parent adds ~200
subtests. Rendering all of that into the DOM tanks scroll perf.

[AddSeriesPicker.svelte](../src/lib/picker/AddSeriesPicker.svelte) flattens
`filteredParents` (plus each expanded parent's children or its
loading/empty note) into a single `flatRows` array, then renders only the
window `[startIndex, endIndex)` — driven by the `.table-wrap` scroller's
`scrollTop` and `clientHeight`. Two spacer `<tr>` elements before and
after the visible window occupy the space the un-rendered rows would.

Row heights are **exact**, not estimated. There are two of them, because
there are two row layouts — `TABLE_ROW_HEIGHT` and `CARD_ROW_HEIGHT`, see
"A panel a phone wide lists cards, not columns" — and the derived
`rowHeight` is whichever is in effect. It is exported to CSS as
`--row-height` on the picker root, and both layouts use it as an explicit
height: `tbody td` sets `height: var(--row-height); box-sizing:
border-box; padding-block: 0; vertical-align: middle`, and `.card-row`
takes the same height. That means:

- The JS value and the CSS row height can't drift apart — they're the
  same value, propagated from JS via `style:--row-height`.
- Content is vertically centered inside a fixed-size box, so height
  doesn't depend on padding + text metrics coincidentally landing at the
  right value. Change the font, the badge padding, the border, whatever
  — the row is still exactly one `--row-height` tall.
- `scrollTop / rowHeight` is an accurate index and `startIndex *
  rowHeight` is where the first rendered row actually sits — no
  vertical drift as you scroll.

If you need to change a row height, update `TABLE_ROW_HEIGHT` or
`CARD_ROW_HEIGHT` in
[AddSeriesPicker.svelte](../src/lib/picker/AddSeriesPicker.svelte); the CSS
follows automatically. Whatever you add to a row has to fit the height its
layout declares — a card that grows a third line needs `CARD_ROW_HEIGHT`
raised with it, or the virtualizer's arithmetic stops matching the layout.

Column widths are also pinned. A `<colgroup>` above the `<thead>` gives
each column a percentage width, and `table { table-layout: fixed }`
means those percentages fully determine column widths — the content of
the currently rendered virtual window can't push columns around during
scrolling. `table { min-width: 64em }` is the floor; below it the
`.table-wrap` scrolls horizontally. **Any new column needs an entry in
the colgroup AND a matching `col.col-<name>-w { width: … }` rule**, or
the fixed layout will collapse it to zero width.

**Do not rename the picker instance back to `state`.** `const state = new
PickerState()` inside a `.svelte` file collides with the `$state` rune:
the compiler interprets `$state(...)` calls as store subscriptions on a
variable literally named `state` and fails at runtime with
`store_invalid_shape`. The convention in this file is `picker`.

### Validating API responses

Every response is checked against a [valibot](https://valibot.dev) schema in
[http.ts](../src/lib/shared/http.ts) before the app sees it, and **every API type is
inferred from its schema** (`v.InferOutput`) rather than written twice. That
inference is the main point: a hand-written type is an unverified assertion,
and ours were wrong — `RawDatum.job_id` claimed `number` while a third of
live rows are `null`, and the hand-written test fixtures asserting it were
written from the same wrong belief, so nothing contradicted it.

Rules that keep this honest:

- **Write schemas against treeherder's serializers, not against samples.**
  The producers are in `~/code/treeherder`:
  `webapp/api/performance_data.py` (`PerformanceSignatureViewSet.list`
  hand-builds the signature rows; `PerformanceSummary.list` the datums),
  `webapp/api/performance_serializers.py`, `webapp/api/serializers.py`
  (`PushSerializer`, `JobProjectSerializer`, `RepositorySerializer`) and
  `webapp/api/jobs.py` (`retrieve` adds `logs` and `task_id`). Sampling can
  only show you what happens to be in the sample: every job we sampled had
  finished, so no sample would ever reveal that `to_timestamp()` returns
  `None` and a *running* job has a null `end_timestamp`.
- **The checkout can lag production.** Production sends a `push.branch` that
  the checked-out `PushSerializer` doesn't list. Read both.
- **Unknown fields are not errors.** All schemas use `v.object`, which
  ignores keys we don't declare, so treeherder adding a field can't break us.
- **A mismatch is fatal, deliberately.** `SchemaError` rejects the whole
  response (short message for the UI, full issue list to `console.error`).
  The alternative — dropping bad rows — hides exactly the drift we want to
  hear about; the plan is that a loud failure gets reported and the schema
  gets fixed. Consequence to accept: one changed field can take out a repo's
  whole series list until we ship a fix.
- **Cost, measured, on the 22 MB / 54k-row signatures response:** `JSON.parse`
  25 ms, validation +52 ms, against a ~5 s download — about 1%. Peak heap
  +18 MB transiently, since valibot builds a validated copy; that copy is
  short-lived because `toSeries` immediately projects it into `Series` rows.
  Bundle +2.4 KB gzipped. None of that justified a sampling shortcut.
- **[schema.test.ts](../src/lib/schema.test.ts) runs recorded real payloads
  through the schemas**, with the refresh commands in its header comment.
  It also asserts the fixtures still *cover* the variants that matter (a null
  `job_id`, each optional field present and absent, hg and git repos) — a
  re-record that quietly drops those would otherwise stay green and useless.

## Testing

- **Pure logic** (`filter.ts`, `series.ts`): vitest, no DOM. Run with
  `npm test`. This is where new invariants should be pinned.
- **API shapes**: `schema.test.ts` (see above). Prefer adding a recorded
  payload over hand-writing a fixture whenever the question is "what does
  treeherder actually send?".
- **Reactive state** (`appState.svelte.ts`, `pickerState.svelte.ts` — so far
  only its seeding seam): also vitest, driving the real class inside an
  `$effect.root` with `fetch` stubbed. Two pieces of setup make that
  possible, both in [vite.config.ts](../vite.config.ts):
  - Runes only compile in files the Svelte plugin processes — that means a
    name ending in `.svelte.ts`. Vitest's default glob wants `.test.ts` at
    the end, so these files are named `<thing>.test.svelte.ts` and the
    `include` glob is widened to match.
  - The test environment is `happy-dom`, not node. This isn't about needing
    a DOM: under the node environment vite compiles Svelte modules for SSR,
    where the effect machinery is stubbed out and `$effect.root` **silently
    never runs its callback**. Every reactive test passes vacuously or fails
    with `undefined`. If you ever see that, check this first.
- **Components**: one committed test, `FilterInput.test.svelte.ts` (see "The
  one component that owns state"). `mount` + `flushSync` under happy-dom is
  cheap and needs no browser, so the bar for adding another is just "does
  this component own state that can disagree with its props" — for
  everything else, test the `PickerState` / `AppState` seam instead.
- **UI flows**: no committed browser tests — throwaway puppeteer scripts instead,
  which is the first half of "Measuring" below.
- Every commit runs `npm run check` and `npm run build` cleanly. Keep both
  green: [.github/workflows/ci.yml](../.github/workflows/ci.yml) runs those
  two plus `npm test` on every push and pull request, so a red CI is a
  local check that wasn't run.
  - `npm run check` is `svelte-check` over `tsconfig.app.json` *and* `tsc`
    over `tsconfig.node.json`. The second half is why `vite.config.ts`
    imports `defineConfig` from `vitest/config` rather than from `vite` —
    `vite`'s narrower type rejects the `test` block, and bare
    `npx svelte-check` never looks at the file to notice.

## Measuring

Most of the decisions in these documents cite a number, and most of those numbers
came from one of two throwaway setups. Neither leaves anything behind, and that's
deliberate — the scripts are shaped by the question, and a question rarely comes
back in the same shape.

**In a browser: `tools/visual/`.** Gitignored, with **its own** puppeteer install
(`npm i puppeteer --prefix tools/visual`, once — it survives, being ignored rather
than deleted). Write a script there, run it against `npm run dev` with
`node tools/visual/whatever.mjs`, delete it or don't. Do **not** install puppeteer
in the app's `package.json`: it pulls a ~200 MB Chromium, CI has no use for it, and
every install/uninstall cycle rewrites the root lockfile.

This is for anything about pixels or layout: a screenshot to look at, an element's
height across a sweep of hovers, or the canvas itself — `getImageData` over a
`<canvas>` answers questions no unit test can, and has repeatedly answered them
differently than expected. Two examples that both changed the code: an ink
histogram showed dots at a flat 50% opacity where the code intended them to
accumulate, and the x of the ring around a selected value showed it moving 13px on
every hover.

**Over real data: a throwaway vitest file.** `curl` a payload into `/tmp`, then run
the *real* modules over it from `src/lib/<thing>.explore.test.ts` (gitignored, and
named `.test.ts` so vitest's glob picks it up). `npx vitest run --reporter=verbose
<file>` — the default reporter swallows `console.log` from a passing test, which is
a confusing five minutes if you don't know it. Delete it when done; it reads a
local file, so it would fail CI.

This is what makes a tuning constant a measurement instead of a guess: sweeping
every push of a real series through `buildDistribution` is what produced the
headroom tables in [comparison.md](comparison.md), and what showed that a rule that
looked obviously right gave one chart 2% of its plot.

**Say where a number came from.** Timings in particular: headless Chrome
rasterizes in software, so the absolute figures are several times slower than the
browser anyone uses, and only the ratios between them transfer.

## Perfherder data model, cheat sheet

The Treeherder signatures endpoint returns a `{ id: signature }` object.
Each signature has:

- `signature_hash`, `framework_id`, `option_collection_hash`, `machine_platform`
- `suite`, `test` (subtest name; often unset for parents)
- `application` — browser variant: firefox / fenix / chrome / cstm-car-m /
  safari / etc. **Not** the framework.
- `extra_options` — kitchen-sink list: opt, fission, webrender, nova, e10s,
  stylo, …
- `tags` — a *subset* of extra_options that the perftest harness chose to
  promote. `fission` and `webrender` are always tags because they're
  globally appended in raptor/results.py; `nova` isn't a tag because it's
  added by a per-test support class. **We ignore this field entirely** —
  the picker treats every extra_option uniformly. Don't reintroduce a
  distinction: tag membership reflects when things were wired up, not
  what they are.
- `has_subtests`, `parent_signature` — parent/child link between rows.
  Fetched only when `subtests=1`.
- `measurement_unit`, `should_alert`, `lower_is_better`

### The `machine_platform` string is not just hardware

`machine_platform` values like `macosx1500-aarch64-shippable` or
`windows11-64-24h2-nightlyasrelease` include build-variant suffixes that
you might expect to be options. They're baked into the string because
Taskcluster treats "shippable" and "nightlyasrelease" as distinct build
identities (they produce different binaries), and `platform` is the key
used to look up the build. See mozilla-central
`taskcluster/test_configs/test-platforms.yml`. **Don't parse or reformat
these strings for display — you'll get bitten by edge cases.**

## Things I'd change next

### Features

- Column reordering + hide/show. Not worth it until someone asks.
- Auto-complete inside the FilterInput (suggest values for `repo:` etc).
- Actually plot the selected series on a graph — this is currently just
  the picker.

### Refactors

- **Component decomposition, cautiously.** A `PickerRow.svelte` that owns
  a single row's expand/select/badge interactions would shrink the main
  file, but Svelte 5 reactive tracking across component boundaries can
  make snappy interactions surprisingly re-render-heavy. Only pull this
  trigger if we hit perf issues, and profile before/after.
- **DetailsPane.svelte is part-way split, and the rest is optional.** It was
  ~1200 lines; the comparison card is now
  [ComparisonSection.svelte](../src/lib/graphs/ComparisonSection.svelte), which
  is ~780, and the pane ~1000. (It was ~740 at the split and has grown since,
  which is the honest answer to "was that enough of a split".)

  What unblocked it was giving the sections' shared text styles one home —
  [detailsPane.css](../src/lib/graphs/detailsPane.css) — because Svelte scopes
  styles per component and without that every extracted section restates the
  handful of rules it uses. **Do that first for any further split**, and keep
  the test for what belongs there as "does a second section read it".

  Two things the split had to be careful about, and any further one will too:

  - **A rule two sections both act on has to live in one of them.** The pane
    suppresses its own push distribution exactly when the comparison card
    draws one; that was `kind !== 'replicate'` written in a single place and
    would have become two. It is now
    [compare.ts::hasDistribution](../src/lib/graphs/compare.ts), read by both.
  - **Helpers shared by two sections move to the module that owns them**, not
    into both — `shortRevision` to shared/links.ts, `linkInfoFor` to
    `AppState.repoLinkFor`.

  The remaining sections (values-on-this-push, run, build) are smaller and
  more entangled with each other than the comparison was, and the pane is a
  readable length now. Not obviously worth doing; if it is done, the same two
  rules apply.

### Documentation upkeep

- **A decision is currently written down three or four times, and revising one
  means revising all of them.** The distribution's value-axis rule, to take the
  worst case, is stated in `distribution.ts`, again in `appState.svelte.ts`'s
  comment over `selectionChart`, again in comparison.md, and again in the commit
  message — including the measured figures, which is where it hurts: changing the
  rule meant rewriting four copies of "2% of the plot" and "63% of hovers".

  The fix isn't less prose, it's one home per *kind* of statement. Roughly:
  measurements next to the constant they justify, since that's what a reader
  about to change the number needs; mechanism in the module comment; the
  cross-cutting narrative in the doc, *linking* to the code rather than
  restating its numbers; and the commit message for why it changed now. Worth
  doing as a pass over graphs.md and comparison.md rather than a rule invented
  in advance.
- **Keeping the routing map honest.** "Which document" at the top of this file
  is now the entry point, and its second table only earns its place if the rows
  stay true. A row is worth adding when a change went wrong for a reason a
  section already explained; it should be deleted when the gotcha is designed
  out rather than documented around. Don't grow it into a table of contents —
  the first table routes, the second warns, and a warning nobody has been
  burned by is noise.

