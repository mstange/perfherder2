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

- [src/lib/api.ts](../src/lib/api.ts) — types, network calls, `toSeries`
  (raw signature → enriched `Series`). Framework map + option-collection map
  are fetched once and passed in.
- [src/lib/filter.ts](../src/lib/filter.ts) — **all pure logic**. Filter
  model (chips + free text), `matchesRow`, sort comparator, cache-key +
  fallback picker, child grouping. Unit-tested.
- [src/lib/FilterInput.svelte](../src/lib/FilterInput.svelte) — the chip +
  text input widget. Owns its in-progress text value; publishes committed
  chips + residual text upward via `onchange`.
- [src/lib/AddSeriesPicker.svelte](../src/lib/AddSeriesPicker.svelte) — the
  whole picker. Owns filter state, sort state, cache, selection.
- [src/App.svelte](../src/App.svelte) — thin host.

**State ownership rule.** All shared UI state (filter, sort, cache,
selection, expansion) lives in `AddSeriesPicker.svelte` as `$state`.
`FilterInput.svelte` is dumb — the only local state it has is the
in-progress `textValue`, so mid-typing parses don't round-trip through
the parent on every keystroke.

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
visibleParents = filteredParents.slice(0, RENDER_CAP)
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

### "Match inside subtests" is the filter semantic, not just a fetch flag

The `matchSubtests` state (checkbox on the filter row) controls **two**
things that used to be tangled:

- **Fetch:** when on, we fetch the subtests=1 payload (via `cacheKey`),
  so subtest rows exist in memory. Manually expanding any parent also
  flips this on for the same reason.
- **Filter semantic:** when on AND the filter is active, a parent qualifies
  if it OR any of its children match. Parents that only match via a child
  are auto-expanded, and under any expanded parent only the matched
  children are rendered (see `childrenForParent` /
  [filter.ts::matchParentWithChildren](../src/lib/filter.ts)).

Why: with the old "include subtests" toggle, clicking a subtest badge
added a `test:<name>` chip that no parent could satisfy (parent rows
have an empty `test` field), so the list went empty. Descending the
filter into subtests fixes that, and auto-expansion makes the *reason*
a parent survived visible. Do not conflate `matchSubtests=false` with
"hide subtests" — subtests are still visible under manually expanded
parents in that mode; the flag only means "the filter does not descend."

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
`application`, `repo`, `platform`, `option`, `tag`) become chips. Everything
else stays as free text (typos are visible, not silently swallowed).

### Every badge in the table is a filter toggle

A badge's click adds the corresponding chip; if the chip already exists,
click removes it. Visual affordance: hover shows a `+` cue; active shows a
`×` cue and a blue outline. Badge is a `<button>`, not a `<span>` — full
keyboard support falls out of that. `title` attributes describe the action
for screen readers and hover-hint.

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

### Whitespace between adjacent badges (Svelte gotcha)

Svelte's compiler strips whitespace between adjacent template elements. A
naive `{#each opts as o}<span class="badge">{o}</span> {/each}` produces
"optfission" when the user copy-pastes. **Always insert `{' '}` explicitly:**

```svelte
{#each opts as o}<span class="badge">{o}</span>{' '}{/each}
```

The current code uses `{@render badge(field, value, cls)}{' '}` for the same
reason.

### Rendering cap of 500 rows

`RENDER_CAP = 500` in the picker. Broad filters can match 25k rows; the DOM
handles that badly. We cap and show an overflow hint. Because we `sort()`
**before** `slice()`, the first 500 are always the sorted-first 500, not a
random subset.

## Testing

- **Pure logic** (`filter.ts`, parts of `api.ts`): vitest, no DOM. Run with
  `npm test`. This is where new invariants should be pinned.
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
  added by a per-test support class. **Don't rely on tag membership for
  business logic — it reflects when things were wired up, not what they
  are.**
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

- Add virtual scrolling. 500 rows is already fine but if we ever want to
  drop the cap, `svelte-virtual-scroll-list` or a hand-rolled row-window
  fits in ~50 lines.
- Persist the filter and sort in the URL query so the picker is
  shareable. `filter=...&sort=platform:desc` etc.
- Column reordering + hide/show. Not worth it until someone asks.
- Auto-complete inside the FilterInput (suggest values for `repo:` etc).
- Actually plot the selected series on a graph — this is currently just
  the picker.
