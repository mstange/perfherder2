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
| The graphs view: panes, fetch, the run/replicate hierarchy, canvas drawing, alerts, detected changes | [graphs.md](graphs.md) |
| What the details pane does with a selection: distributions, comparison mode, statistics | [comparison.md](comparison.md) |
| What's built, what's next, what was deliberately deferred and why | [graphs-todo.md](graphs-todo.md) |
| Which module owns a thing | "Architecture" below, graphs.md "Code map", comparison.md "Code map" |

**If you touch X, read Y first.** Each of these is a place where the obvious
change is wrong for a reason the code doesn't show:

| Changing | Read |
| --- | --- |
| A URL parameter | three sections that have to agree: "Architecture" below (`urlState.ts` owns the whole schema), graphs.md "URL state", comparison.md "URL state" |
| `FilterInput.svelte`, or anything holding filter state | "The one component that owns state" — this has bitten us twice |
| Markup with two adjacent badges | "Whitespace between adjacent badges (Svelte gotcha)" |
| A color, anywhere | "Theming: one resolved attribute, one exception" — there are exactly two, and neither is new |
| A button | "One button, defined once" |
| Anything that renders before its data arrives | "Layout stability" |
| A fetch, or a new endpoint | "Validating API responses"; plus "Cache key" if the result is cached |
| A treeherder *list* endpoint | its default page is 10 rows and truncation is silent — a partial answer is shaped exactly like a complete one. comparison.md, "The inline pushlog", and the `getCommonAlerts` note in graphs-todo.md |
| How a row is identified | "Row identity: `Series.key`, composed at construction" |
| A loading or empty state for subtests | "`has_subtests` is a claim, not a promise" — `has_subtests` does not mean a subtests=1 fetch will return any |
| Canvas drawing | graphs.md "Rendering" and "Dots are translucent, and jittered sideways" |
| The change detector's constants | graphs.md "Detected changes", and the reasoning and measurements recorded beside each constant in `changes.ts` |
| A statistic | comparison.md "Statistics" and "Deviations from PerfCompare" |

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
  shared/   http, links, chart, stats, theme(+.svelte, ThemeToggle), timeRange
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
  back.** The only two edges into the picker are `appState` and
  `seriesSummary` reaching for `filter.ts`, which is the panel prefill (see
  "Opening the picker prefills its filter"). There is exactly one edge the
  wrong way: `shared/chart.ts` imports the `SeriesPoint` *type* from
  `graphs/graphData.ts`, because some of its helpers plot graph points while
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
selectedRepos     ─┐          seriesCache: Map<key, Series[]>
timeRangeSeconds  ─┼→ $effect ─→ loadRepo() per missing key
includeSubtests   ─┘             key = "repo|subtests|interval"

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

- **Never over the user's own filter.** We re-derive only when the
  filter is empty *or* still literally equal to the prefill we last
  handed over (`sameFilter`, plus the remembered `pickerFilterSeed`).
  So the prefill keeps following the series list — add a series, reopen,
  and it reflects the new set — but one edited chip pins it for good.
  The filter is the only field the test looks at, and the prefill
  replaces the *whole* view when it fires: reopening an untouched panel
  therefore also returns its interval, subtest mode and sort to their
  defaults, which is what a panel mounted fresh on every open did before
  any of this reached the URL. "Untouched" means one thing, not five.
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
  `SeriesMeta.placeholder`). A signature with no data in the range gets a
  synthesized `suite: "signature 1234"`; prefilling on that would open
  the picker on an empty list.
- The intersection here is `commonAttrs`, not `splitCommonAttrs` — with
  one series plotted there's no header to render but that one series is
  exactly the context to search from.

The prefill goes through the normal `pickerView` state, so it lands in the
URL (`pc=` / `pr=` params) like anything else the panel shows and a shared
link reopens on the same rows.

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
- The panel is ~280px narrower than it was. The table's `min-width: 64em`
  and its wrapper's `overflow: auto` already handle that: at a 1152px
  window the table fits exactly, and below that it scrolls horizontally
  rather than the columns collapsing. No breakpoint that hands the
  sidebar back — inert-ness would then have to depend on the viewport,
  which CSS can't drive.

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

**It lives in the series pane's footer**, not in the graph header. The app has no
toolbar of its own, and the graph header was the only always-on-screen chrome —
but it is a row of *graph viewport* controls (range presets, replicate drawing,
zoom), and a global appearance preference in that run reads as a fourth one. The
header also wraps, so the toggle's position was a function of window width. The
footer is unconditional for this reason: it renders with no series and therefore
nothing to remove, so the toggle keeps one fixed corner at every width.

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
radius, canvas fill, hover, disabled — plus `.btn-compact` for the toolbar
size and two fills, `.btn-primary` (accent) and `.btn-confirm` (success).

It exists because the same six-line recipe had been copied into five
components, and the copies had drifted: paddings of `4px 12px`, `4px 10px`,
`3px 8px`, `2px 8px` and `1px 6px`, and a disabled state that was
`opacity: 0.4` in the series list, `0.45` in the graph header and a full color
swap in the picker — with three of those panes on screen simultaneously. The
same rule as for colors applies, and for the same reason: a value that exists
in five places is five values.

Two things to know before changing it:

- **It's opt-in (`class="btn"`), not a bare `button` rule.** Most buttons in
  this app are *not* this shape — badges, swatches, sort headers, disclosure
  triangles, chip removers — and they outnumber the plain ones, so a default
  would mostly be something to undo. It was exactly such a default that made a
  series swatch lose its color on hover: SeriesList's component-wide
  `button:hover` outranked `.swatch`, which never declared a hover of its own,
  so pointing at a series greyed out the one thing identifying it.
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

Row heights are **exact**, not estimated. The JS-side `ROW_HEIGHT`
constant is exported to CSS as `--row-height` on the picker root, and
every `tbody td` sets `height: var(--row-height); box-sizing: border-box;
padding-block: 0; vertical-align: middle`. That means:

- The JS constant and the CSS row height can't drift apart — they're the
  same value, propagated from JS via `style:--row-height`.
- Content is vertically centered inside a fixed-size box, so height
  doesn't depend on padding + text metrics coincidentally landing at the
  right value. Change the font, the badge padding, the border, whatever
  — the row is still exactly one `--row-height` tall.
- `scrollTop / ROW_HEIGHT` is an accurate index and `startIndex *
  ROW_HEIGHT` is where the first rendered row actually sits — no
  vertical drift as you scroll.

If you need to change the row height, update the `ROW_HEIGHT` constant in
[AddSeriesPicker.svelte](../src/lib/picker/AddSeriesPicker.svelte); the CSS
follows automatically.

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
  [ComparisonSection.svelte](../src/lib/graphs/ComparisonSection.svelte) and
  the pane is ~740.

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

