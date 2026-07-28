# Design notes

Read this before making non-trivial changes. It captures the *why* behind
choices that aren't obvious from the code, and warns about gotchas that have
already burned us once.

## What this is

A Svelte 5 SPA that reimplements Treeherder Perfherder's "Add series" dialog
with one big flat list instead of a harness → platform → suite drill-down.
The user types free text and clicks badges; the list narrows.

The whole app is client-side. Signatures are fetched directly from
`treeherder.mozilla.org` — its API has `access-control-allow-origin: *`, so
we don't need a backend proxy. **If Mozilla ever tightens CORS, this
architecture breaks.**

## Architecture

- [src/lib/http.ts](../src/lib/http.ts) — the only place that calls `fetch`.
  Validates every response against a valibot schema; see "Validating API
  responses" below. `HttpError` and `SchemaError` both keep their messages
  short enough for an error banner.
- [src/lib/api.ts](../src/lib/api.ts) — schemas + inferred types, network
  calls, `toSeries`
  (raw signature → enriched `Series`). Framework map + option-collection map
  are fetched once and passed in. `toSeries` bakes `Series.key`
  (`${repo}|${signatureHash}`) and `Series.parentKey` in at construction,
  so callers never recompose the compound identity — using
  `signatureHash` alone would collide across repos.
- [src/lib/reorder.ts](../src/lib/reorder.ts) — **pure logic**. Drag
  geometry for the series list: drop index, per-card offsets, auto-scroll
  ramp. Unit-tested.
- [src/lib/seriesSummary.ts](../src/lib/seriesSummary.ts) — **pure logic**.
  Splits a list of series into the attributes they all share and the ones
  that distinguish each; see "The series list shows differences, not
  descriptions" below. Unit-tested.
- [src/lib/filter.ts](../src/lib/filter.ts) — **pure logic**. Filter
  model (chips + free text), `matchesRow`, sort comparator, cache-key +
  fallback picker, child grouping. Unit-tested.
- [src/lib/pickerState.svelte.ts](../src/lib/pickerState.svelte.ts) — the
  reactive core of the picker: a `PickerState` class holding every
  `$state` cell, the `$derived` graph, the `$effect` that triggers
  fetches, and the mutation methods. No template code lives here, so
  every seam is exercisable without a DOM.
- [src/lib/FilterInput.svelte](../src/lib/FilterInput.svelte) — the chip +
  text input widget. Owns its in-progress text value; publishes committed
  chips + residual text upward via `onchange`.
- [src/lib/AddSeriesPicker.svelte](../src/lib/AddSeriesPicker.svelte) —
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
[filter.ts::pickCachedForRepo](../src/lib/filter.ts): **prefer the
subtests=1 cache if loaded; fall back to subtests=0.** This is safe because
a subtests=1 fetch is a strict superset of subtests=0 — the top-level rows
are identical in both. Do not break this invariant without also revisiting
the disclosure UX.

### Row identity: `Series.key`, composed at construction

`Series.key` = `${repository}|${id}`, populated in
[api.ts::toSeries](../src/lib/api.ts). It's used anywhere a row needs
stable per-row identity across the union of caches — expansion state,
parent-child grouping, master-checkbox scope, and the `#each` key in
[AddSeriesPicker.svelte](../src/lib/AddSeriesPicker.svelte)'s virtual
scroller. Subtest rows also carry `Series.parentKey` (their parent's
`key`), so [filter.ts::groupChildrenByParent](../src/lib/filter.ts) can
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
[toSeries](../src/lib/api.ts) pass builds a lookup from
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
[filter.ts::matchParentWithChildren](../src/lib/filter.ts)).

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
[AddSeriesPicker.svelte](../src/lib/AddSeriesPicker.svelte) passes
`fromSubtest: true` to `toggleFilterChip` when the click originated on
a subtest row, and `PickerState.toggleFilterChip` auto-enables
`matchSubtests` in that case. It's a one-way nudge — we only flip on
chip *addition*, not removal, and only if the checkbox was off — so the
user's explicit off-state is preserved for badge clicks on parent rows
and for chips typed into the FilterInput. Users can uncheck the box
after the fact to reset.

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

- Chips of the **same field OR** together (`repo:autoland repo:mozilla-central`
  is a whitelist).
- Chips of **different fields AND** together.
- Free-text tokens are all ANDed on top.
- Empty filter = wildcard.

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

So [SeriesList.svelte](../src/lib/SeriesList.svelte) hoists everything the
series have in common into one header ("All series share …") and leaves
each card with only its own attributes. The split is
[seriesSummary.ts::splitCommonAttrs](../src/lib/seriesSummary.ts).

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
[reorder.ts](../src/lib/reorder.ts) (all the arithmetic, unit-tested) and
[SeriesList.svelte](../src/lib/SeriesList.svelte) (measure, listen, apply):

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
- **Cards are not a uniform height** — a card's text wraps to one, two or
  three lines depending on how much distinguishes it — so nothing may
  assume a row pitch. `displacement` reads the gap back out of the
  measured boxes, and `dropIndex` counts frozen midpoints.
- **Midpoints come from the frozen layout, not from where cards have slid
  to.** A card sliding out from under the pointer would otherwise
  immediately satisfy the reverse test and oscillate.
- **`clampDy` keeps the lifted card in the list**, so it can't be dragged
  out over the graph or off the panel. The clamp is on the card's *centre*
  — between the first and last cards' centres — because that is exactly
  the range in which `dropIndex` still reaches the end slots. Clamping the
  card's box inside the content instead would make the end slots
  unreachable whenever the dragged card is taller than the card at that
  end. It follows that `dropIndex` has to be inclusive on the far side
  (`c <= centre` below the origin, `c < centre` above it): at the clamp the
  two centres coincide exactly, and both directions have to resolve
  outwards. The two comparisons still swap at the same place, so the
  interaction is symmetric.
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

The ↑/↓ buttons stay as the keyboard path: the handle is `aria-hidden`
and not focusable, so the drag is a pointer affordance only.

### Opening the picker prefills its filter from the plotted series

The same observation that shapes the series list — a graph is one test
sliced along one axis — says what you're most likely to add next: a
sibling of what's already plotted. So `AppState.setPickerOpen(true)`
seeds `pickerFilter` with `commonFilterChips(commonAttrs(...))`, and four
plotted speedometer3 series open the picker on the seven rows that share
their suite, platform and options instead of on all 25,000.

The rules that make this safe:

- **Never over the user's own filter.** We re-derive only when the
  filter is empty *or* still literally equal to the prefill we last
  handed over (`sameFilter`, plus the remembered `pickerFilterSeed`).
  So the prefill keeps following the series list — add a series, reopen,
  and it reflects the new set — but one edited chip pins it for good.
- **The repository is a repo selection, not a chip.** The picker's
  checkbox row already *is* a repo filter, and it's what decides what
  gets fetched; a `repo:` chip would be a second mechanism that can't
  fetch anything and silently matches nothing when its repo is
  unchecked. `AppState.pickerRepos` (the union of the plotted series'
  repositories, not just a shared one — beta+central series need *both*
  fetched) seeds `PickerState.selectedRepos` instead. A useful
  side-effect: a central-only graph no longer pulls autoland's 4 MB.
- **`PickerState.seed` must run during setup**, before the constructor's
  fetch effect first fires, or the picker fetches the default repos and
  then the seeded ones.
- **A `test:` chip in a seed turns on `matchSubtests`** — same dead end
  as the `fromSubtest` nudge above (parent rows have no `test` of their
  own, so the chip would match nothing), reached differently: any prefill
  derived from subtest series carries a `test:` chip, and so does any
  shared link whose picker filter had one. That's a pre-existing bug in
  the URL case, fixed by putting the nudge in `seed`.
- **Placeholder metadata is excluded** (`attrsForEntry` /
  `SeriesMeta.placeholder`). A signature with no data in the range gets a
  synthesized `suite: "signature 1234"`; prefilling on that would open
  the picker on an empty list.
- The intersection here is `commonAttrs`, not `splitCommonAttrs` — with
  one series plotted there's no header to render but that one series is
  exactly the context to search from.

The prefill goes through the normal `pickerFilter` state, so it lands in
the URL (`pc=` params) like any other filter and a shared link reopens
on the same rows.

### Rows already on the graph show their swatch, not a checkbox

A direct consequence of the prefill: the list you land on contains the
series you already have. `AppState.plottedColors` (`Series.key` → the
color it's drawn in) reaches `PickerState.plotted`, and those rows render
the same colored swatch the series list uses in place of their checkbox,
over a faint blue row tint.

- **A swatch, not a disabled checked checkbox.** It says "this is the
  purple line on your graph" rather than just "no". The shared vocabulary
  with the series list is the point.
- **The dialog stays one-directional: it adds.** Unchecking-to-remove
  would give one checkbox two opposite meanings, and turning the whole
  thing into an apply-a-set editor would make "Clear" mean "wipe the
  graph" and select-all mean "plot 25,000 series". Removal stays in the
  series list, where the × already is.
- `pickableRows` excludes plotted rows, so select-all doesn't count rows
  that have no checkbox (it would report "7 selected" and add four
  no-ops).
- The lookup only works because `Series.key` (built in
  [api.ts::toSeries](../src/lib/api.ts)) and
  [graphData.ts::seriesKey](../src/lib/graphData.ts) compose the same
  `${repo}|${signature id}` string from two different modules. Drift
  there would silently un-mark every row, so api.test.ts pins it.
- The prop is **synced, not seeded**: nothing can change the plotted set
  while the panel is open today (adding closes it), but stale marks would
  be a lie about the graph rather than a cosmetic issue.

### Layout stability

Several places take care to not shift the list under the user's cursor:

- Repo chips: the count slot has `min-width: 4.5em` so toggling the
  checkbox — or seeing "loading…" become "7,680" — doesn't reflow the row.
- Action buttons: Clear/Add stay mounted (disabled when nothing is picked)
  so the very first checkbox click doesn't push the table down 30px.
- `picked-count` has `min-width: 9ch` so "0 selected" → "12 selected"
  doesn't nudge the buttons horizontally.

**When adding new UI, budget for the "loading" and "empty" states so they
occupy the same space as the "loaded" state.** This is the single biggest
polish issue in dashboards, and we've paid the tax already.

### The Add-series dialog has exactly one scroller

`.overlay` (fixed, `inset: 0`, 24px padding) stretches `.overlay-panel` to
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

[AddSeriesPicker.svelte](../src/lib/AddSeriesPicker.svelte) flattens
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
[AddSeriesPicker.svelte](../src/lib/AddSeriesPicker.svelte); the CSS
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
[http.ts](../src/lib/http.ts) before the app sees it, and **every API type is
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

- **Pure logic** (`filter.ts`, parts of `api.ts`): vitest, no DOM. Run with
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
- **UI flows**: no committed component tests. During development, I've been
  running a throwaway puppeteer smoke script (`smoke.mjs`) that types into
  the filter, clicks badges, checks headers. It's not in the repo because
  puppeteer downloads a ~200 MB Chromium and CI doesn't need it. If you
  need to reproduce the pattern, `npm install --save-dev puppeteer`, write
  the script, run it against `npm run dev`, then remove.
- Every commit runs `npx svelte-check` cleanly and `npm run build` cleanly.
  Keep both green.

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

- Persist the picker's sort in the URL query too (`sort=platform:desc`);
  the filter is already there as `pc=` / `pf=`.
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
