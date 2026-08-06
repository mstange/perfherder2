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
  that distinguish each, and names the page from the shared half; see "The
  series list shows differences, not descriptions" below. Unit-tested.
- [src/lib/theme.ts](../src/lib/theme.ts) — **pure logic**. The theme
  vocabulary, the preference→theme resolution rule, and the canvas palette
  that can't live in CSS; see "Theming" below.
  [theme.svelte.ts](../src/lib/theme.svelte.ts) is the reactive singleton
  around it.
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
  chips + residual text upward via `onchange`. **That local copy is the
  only piece of filter state not rendered straight from the prop, and it
  has bitten us twice** — see "The one component that owns state" below.
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

Hence [FilterInput.test.svelte.ts](../src/lib/FilterInput.test.svelte.ts):
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

So [SeriesList.svelte](../src/lib/SeriesList.svelte) hoists everything the
series have in common into one header ("All series share …") and leaves
each card with only its own attributes. The split is
[seriesSummary.ts::splitCommonAttrs](../src/lib/seriesSummary.ts).

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
  worth the line. [DetailsPane](../src/lib/DetailsPane.svelte) states it only
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
([`documentTitle`](../src/lib/seriesSummary.ts), rendered by a
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
[activityApi.ts](../src/lib/activityApi.ts) and
[activity.ts](../src/lib/activity.ts):

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
  ([theme.svelte.ts](../src/lib/theme.svelte.ts)), not by a
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
are on screen identical. [ThemeToggle.svelte](../src/lib/ThemeToggle.svelte) is
one `role="switch"` button showing the **resolved** theme, and the preference is
inferred from the destination by `nextThemePreference`: an override is stored only
when it actually overrides, so light → dark → light lands back on `system` rather
than leaving a redundant `light` behind, and the round trip is pinned in
`theme.test.ts` (one click always flips what's on screen; two always restore it).
Reasoning follows [Lea Verou on dark mode
toggles](https://lea.verou.me/blog/2026/dark-mode-toggles/). The cost is that
"am I following the OS?" is no longer visible; it's in the `title`, because it
changes nothing about what the next click does.

`color-scheme` is set alongside the tokens rather than left as `light dark`,
which is what gets form controls, scrollbars and default link colors to match.
It has to be pinned per theme for the same reason as above: on `light dark` the
UA would decide for itself and a forced theme would only half-apply.

**Two things can't be a custom property, and both are on the graphs.**

- *Canvas colors.* There's no element for a canvas's pixels to inherit from.
  [theme.ts](../src/lib/theme.ts) exports `CHART_PALETTES` and the draw calls
  take a `palette` argument, which also keeps
  [chartDraw.ts](../src/lib/chartDraw.ts) and
  [distributionDraw.ts](../src/lib/distributionDraw.ts) functions of their
  arguments. The alternative — `getComputedStyle` inside the draw code — would
  make them depend on the DOM *and* on the attribute having already been
  applied. Those seven values are the only colors in the app that exist twice;
  each names the token it mirrors.
- *Series colors.* Half of treeherder's palette is unusable on a dark plot:
  blue-bell, purple and dark-puce all land under 2:1 against the canvas, which
  is a series you cannot find. `SERIES_COLORS_DARK` in
  [chart.ts](../src/lib/chart.ts) is the same six hues in the same order,
  lightened past 4.5:1 (pinned in `theme.test.ts`), so **the theme picks the
  palette but never the position** — flipping it recolors each series in place
  instead of reshuffling the graph. Cerulean and orange were already light
  enough and carry over untouched. This is the one place we knowingly diverge
  from treeherder's colors, and only in dark mode.

`styleForIndex(i, theme)` defaults to `'light'`, so the parity assertions in
`chart.test.ts` and anything else that doesn't know about themes keeps getting
treeherder's six.

**The theme is a singleton, not a prop.** [theme.svelte.ts](../src/lib/theme.svelte.ts)
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

### Layout stability

Several places take care to not shift the list under the user's cursor:

- Repo chips: the count slot has `min-width: 4.5em` so toggling the
  checkbox — or seeing "loading…" become "7,680" — doesn't reflow the row.
- Action buttons: Clear/Add stay mounted (disabled when nothing is picked)
  so the very first checkbox click doesn't push the table down 30px.
- `picked-count` has `min-width: 9ch` so "0 selected" → "12 selected"
  doesn't nudge the buttons horizontally.

- The list itself fills with placeholder rows while it loads, one
  `--row-height` each (see below), rather than showing one line of centered
  text in an otherwise empty table.

**When adding new UI, budget for the "loading" and "empty" states so they
occupy the same space as the "loaded" state.** This is the single biggest
polish issue in dashboards, and we've paid the tax already.

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
- **No routing table for the docs.** design.md is ~1000 lines and graphs.md ~500,
  and a session that only needs one section has no way to know which. A short
  map at the top of design.md — picker here, graphs in graphs.md, the details
  pane's distributions in comparison.md, status in graphs-todo.md, plus "if you
  touch X, check section Y" — would cost a dozen lines and save reading both
  files end to end.

### Naming

- **`.replicates` means two different things.** It's the class on GraphPane's
  "Replicates" checkbox label *and* on DetailsPane's chip list. Svelte scopes
  both, so the app is fine; anything that queries the DOM globally is not, and
  a `document.querySelectorAll('.replicates')` in a throwaway measurement script
  silently measured the checkbox. Rename one — `.draw-replicates` on the
  control, probably, since the chip list is the one the docs talk about.
