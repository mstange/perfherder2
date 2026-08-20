# The CLI — design and usage

`bin/perfherder-cli` is a command-line front end to this app, built from the same
`src/lib` modules the browser runs. Companion to [design.md](design.md); read
its "Which document" map if you're not sure which file answers your question.

## What it's for

Answering a performance question without opening a browser — and, specifically,
letting an agent answer one. The three questions it was shaped around, each of
which used to mean reading this codebase to work out what URL the UI would
build:

1. *How does Firefox's speedometer3 compare with Chrome's on Android?*
   → `search`, then `series` with both signatures.
2. *Was that regression the modes moving, or the same modes with a different
   share of the samples?* → `changes` to find the step, `compare` across it.
3. *How has IndexedDB open performance changed in six months, and what caused
   each move?* → `changes --commits`, and `--cluster` when the answer spans more
   series than a reader can hold at once.

## Usage

```sh
./bin/perfherder-cli --help              # commands and worked examples
./bin/perfherder-cli <command> --help    # one command's options
```

The wrapper rebuilds `perfherder-cli/dist/perfherder-cli.mjs` when it is missing
or older than `src/`, so there is no build step to remember. `npm run build:cli`
does it explicitly.

Outside a checkout it is on npm as
[`@mstange/perfherder-cli`](https://www.npmjs.com/package/@mstange/perfherder-cli),
installing one binary of the same name — see "The published package" below.

| Command | The UI feature it is |
| --- | --- |
| `search <term...>` | the Add-series picker |
| `series <ref...>` | the series list's summary, plus a level comparison |
| `series <ref...> --drift` | the drift badge on a series-list card, from the same module — and the unfiltered form of it, see "`series --drift` answers the question the detector cannot" |
| `changes <ref...>` | the alert triangles and the detected-change bars |
| `changes <ref...> --cluster` | the details pane's Landing block, which groups the same way from the same module — see "`--cluster` makes the row a landing instead of a series" |
| `step <ref...> --at` | no UI equivalent — see "Measuring a step the detector didn't mark" |
| `locate <ref> --at` | no UI equivalent — see "Ranking the pushes a step could be on" |
| `compare <a> <b>` | the details pane's comparison card |
| `commits <repo> <from> <to>` | the comparison card's inline pushlog |
| `url <ref...>` | a shareable link, without fetching anything |

A **series reference** is `<repo>,<signatureId>[,<frameworkId>]` — the
three-field form is exactly what a `series=` parameter in the app's URL
contains, so one can be pasted out of a shared link. The framework is optional;
see "Two-field references" below. `compare` takes a `@<revision|pushId|first|last>`
suffix, and its second argument may be a bare selector meaning "the same series".

A **search term** is the picker's: free text, `field:value`, or `-field:value`
to exclude — one grammar across the box, the URL and the command line, parsed
by the same `filter.ts::parseChip`. The exclusion needs no quoting here because
only `--` tokens are flags to `parseArgv`, so `-application:firefox` arrives as
a positional.

## Decisions worth knowing

### It is built from src/lib, and adds no analysis of its own

Every number printed comes from the module the app reads it from: `stats.ts` for
the tests, `changes.ts` for the steps, `alerts.ts` for perfherder's verdicts,
`kde.ts` and `distribution.ts` for the densities, `pushlog.ts` for the commits,
`filter.ts` and `series.ts` for the search. The CLI's own modules decide what a
command *reports* and how it *reads*, never what a number *is*.

That is the whole reason it lives in this repo rather than beside it. A separate
tool would drift: it would grow its own idea of what a push mean is, of which
alerts to hide, of how a subtest inherits an alerting threshold — and then two
answers to one question, from two tools written by the same people, would
disagree with nothing to say which was right.

The one piece of genuinely new logic is [modes.ts](../src/cli/modes.ts), and it
exists because the app answers its question with a picture (see "The mode
analysis" below).

**Every command prints a link into the app.** graphs.md's rule for the change
detector — *open the graph first* — applies at least as much to a reader who
only has text, and `changes` links each finding with both ends of its comparison
already pinned.

Those links point at <https://perfherder2.netlify.app/> by default. They used to
point at the dev server, which was right for the one person running `npm run
dev` and dead for everyone else — and would have been dead for every install of
the published package, which turns the tool's own rule into a broken promise.
`--base <url>`, or `PERFHERDER2_BASE_URL` in the environment, overrides it; a
checkout that wants the local app sets that once.

### Text by default, `--json` when you want the object

Text is three to five times cheaper to read than the equivalent JSON, and this
tool's whole value is being cheap enough to run four times while narrowing a
question. `--json` prints the same report object the text was rendered from —
the *same object*, from [reports.ts](../src/cli/reports.ts), so the two can't
describe different things. That is the failure mode of every tool that formats
twice.

### A failed fetch is one row's problem

`series`, `changes` and `step` all say that several refs at once is the point,
and a 502 on one of twenty-eight used to throw the process out and lose the
twenty-seven that worked. A failure is a property of one row, so
`loadSeriesOrError` puts it on that row: `LoadedSeries.error` and
`SeriesHeader.error`, printed by every command in the same words, and present in
`--json`.

This is the missing-versus-empty rule one level up. "This series could not be
fetched" and "this series has no data in the range" are different answers, and
the second is the more dangerous mistake — a network failure would otherwise
read as a quiet graph, which is precisely the misreading `step` exists to
prevent. A series that never arrived also has no metadata, so its unit,
direction and alerting floor are `placeholderMeta`'s defaults and are printed
as absent rather than as facts.

**The exit code is zero when some refs succeeded and one when none did.** A run
that answered partially did answer, and a non-zero code invites a script to
discard twenty-seven good rows to punish the twenty-eighth. `compare` is
unchanged and still fails hard: it has exactly two sides, neither optional.

### A missing thing and an empty thing print differently

"No alerts in this range" is a finding. "The alerts request failed" is not, and
`changes` says which — `ChangesReport.alertsLoaded` is a boolean beside the
list, not an empty list standing in for both. Same for a search that matched
nothing versus a repository whose fetch failed, and for a series with no data in
the range versus one that does not exist.

The related rule: **a truncated answer must never be shaped like a complete
one.** `search` prints "showing 30 of 412", `changes --commits` carries
`pushlogLabel`'s "20 of 164 commits" through unchanged, and a range cut short by
the fetch cap says so with a `+`. This codebase has been caught by the opposite
before — treeherder's own `getCommonAlerts` silently answers a long range from
one page of ten (graphs-todo.md).

### Responses are cached on disk

In `--cache-dir`, else `$PERFHERDER2_CACHE_DIR`, else
`$XDG_CACHE_HOME/perfherder-cli`. Keyed by request URL, pruned at 24
hours. TTLs by how fast the thing behind them changes: a day for frameworks,
option collections and the repository list; an hour for signature lists; ten
minutes for performance data, alerts and pushes. `--no-cache` bypasses it.

This is not an optimisation, it is what makes the tool usable. One repo's
signature list is 4–22 MB (design.md has the table) and `search` needs it before
it can filter anything, so without a cache, narrowing a search from twelve
hundred rows to four costs a second full download. Measured: a cold
`search idb-open-many-seq` over autoland is 5.6 MB and 0.6 s; the next search is
0.05 s.

**It is installed by wrapping `globalThis.fetch`**, not by a layer inside
`http.ts`. The app has the browser's cache and does not want ours, and wrapping
the global means every module under `src/lib` runs exactly as the app runs it.

### Two-field references

`/performance/summary/` does not need `framework` — `signature` already
identifies the row, and the two requests answer identically in production. So a
reference may be `autoland,5350953`, and the response's `framework_id` supplies
the number anything downstream needs (the alerts endpoint does need one).

This is the CLI's only change to app code: `summaryUrl`, `fetchSummary` and
`fetchSignatureMeta` take `frameworkId: number | null` and omit the parameter
when it is null. The app still passes one, matching treeherder's own request.
The alternative was downloading a repo's whole signature list to learn a number
the response was about to hand back.

`url` is the exception and requires the three-field form: it fetches nothing, so
it has nothing to read the framework off, and the app needs one to fetch with.

### `--parent` is a separate axis from the filter

`search --parent <ref>` restricts the result to one signature's subtests, and
implies `--subtests` (children only exist in that payload, so without it the
answer would be a confident "none" for a signature with 26 of them).

It cannot be a chip, and that is the whole reason it exists. A subtest's row
carries its parent's *id* in `parentKey` and nothing else about it, so
`suite:speedometer3 platform:macosx1500-aarch64-shippable` gathers all five
variants of that suite on that platform — nova, no-nova, samply-profile and two
more — and there is no chip, and no negation, that separates one parent's 26
children from the other four parents' 104. `parentKey` is exactly that
separation and it is already composed for us (design.md, "Row identity").

Three empty results, three different messages: a parent that isn't in the
fetched set (mistyped id, wrong repository, or a signature that has gone quiet
and so is outside `--interval`), a parent with no children matching the rest of
the search, and an ordinary no-match. The first is not a finding and the output
says so.

`--parent` also narrows the default repository set to the parent's own, since
fetching a second repo's signature list only to filter every row out of it is
several megabytes for nothing.

### `--across` is `--parent` turned sideways

`--parent` is the vertical slice, a signature's own subtests. The horizontal one
— the same row on every platform — had no expression at all, and assembling it
meant `search --json` through a hand-written pivot: in one live trial that took
more commands than the analysis did and produced three mechanical errors, one of
which quietly mixed three benchmark suites into one table.

[siblings.ts](../src/cli/siblings.ts) is the relation instead. Hold every
identifying attribute of one named row fixed — repository, framework, suite,
test, application, platform, option set — let the named one vary, and return
what is left. `search --like <ref> --across platform` prints the list;
`step <ref> --across platform` skips the round trip and measures them all.

It cannot be a chip for the same reason `--parent` cannot: `suite:speedometer3
test:score` gathers every variant of that row on every platform *and* every
application and option set that also ran it, and no chip says "everything this
row is, except its platform".

**Strict, and what it excludes is counted.** Loosening to suite-and-test would
sweep the nova / no-nova / samply-profile variants of a suite into one table
beside each other, which is the error the trial made by hand. So the header
carries what was held out and why — `not included: 39 differing in option` — and
that line is usually the interesting one, since a platform running the test with
a different configuration shows up there rather than nowhere.

**Several fields at once**, because Chrome runs on neither the same platform nor
the same option set as Fenix: `--across application` alone answers "just this
row" for the very question the first worked example asks, and
`--across platform,application` is that question.

### Ranking the pushes a step could be on

A bar is a point estimate with no interval, and so is a perfherder alert. When
the two name pushes five hours apart — which happened on autoland signature
5352791 around 2026-05-26 — nothing in either output says whether they are
arguing or agreeing within the noise.

`locate <ref> --at <revision|date>` answers it. Every split in the window is
scored by `boundaryCandidates`, **exported from changes.ts for this and not
reimplemented**: it is the scoring `relocateBoundary` uses to decide where a bar
goes, so row 1 is the push a bar would land on and the rest are what it was
chosen over. A ranking on any other statistic would be this tool holding a second
opinion about the app's own answer, which is the one thing it must not do.

What the ranking buys, on that series: the detector's choice scores 0.352, the
runner-up 0.296 two pushes earlier, and the push perfherder alerted on is row 13
of 43 at 0.116 — so those two really are different claims, and the output says so
in those terms rather than leaving the reader to compare two commands' output.
The spread of the top rows is the interval the bar never had; where an alert sits
a row or two down with a comparable score, it is the same finding seen twice.

Each row also says whether the detector *could* have marked that split — α and
the signature's floor, the same two bars `step` reports — because a candidate that
fails one is not somewhere a bar could ever go.

### Measuring a step the detector didn't mark

`step <ref...> --at <revision|date>` is the one command with no UI counterpart,
and the gap it fills was found by using the tool: after `changes` located a
speedometer3 improvement on aarch64 macOS, the natural next question — "did the
other platforms see it?" — could not be asked. `changes` reports the steps it
*found*, and the interesting case is a series where it found none.

That case is common and it is not a bug. A platform running the benchmark once
per push, beside one running it twelve times, has several times the per-push
noise: measured on the July 2026 case, aarch64 macOS had 2,636 runs over 296
pushes at cv 0.7% while Intel macOS had 181 runs over 181 pushes at cv 1.9%. A
real 0.8% step clears α = 0.01 on the first and not on the second. **Reading
that silence as "it didn't happen here" is the mistake this command prevents.**

- **The unit is the push mean and the window is 24 a side**, both taken from
  `changes.ts` (`WINDOW_PUSHES` is exported for this) so a `step` number and a
  `changes` number are on one scale. The alternative — inventing a window — puts
  two figures for one event in front of the reader with no way to reconcile
  them.
- **It reports which of the detector's two bars a move failed**: α = 0.01, or
  the signature's own size floor. Those are different answers to "why is there
  no bar on this graph" and the reader needs to know which they got, so
  `clearsFloor` and `CHANGE_ALPHA` are exported from `changes.ts` rather than
  restated here. A tool whose whole claim is that it agrees with the app cannot
  afford a second opinion about the app's own α.
- **`--at` takes a revision**, resolved through `fetchPushByRevision` against
  whichever of the given repositories has it. It has to be a lookup rather than
  a search of the data already fetched, because the series being asked about
  routinely has no data on that push — which is precisely the case that prompts
  the question.
- **Several refs at once is the point.** One invocation over a suite's subtests,
  or over one subtest on four platforms. Rows are labelled by
  `seriesSummary.ts::splitCommonAttrs` — what the series share goes in the
  header and each row keeps only what distinguishes it, the same factoring the
  app's series list uses, which is what makes a four-platform table read as one
  line per platform.

### A search that matched nothing is diagnosed against the rows it searched

"No signatures match" is true and useless. Two of one trial session's first five
commands went on `indexeddb`, which matches nothing because the tests are called
`idb-*` — a vocabulary problem in the *data*, which no amount of documentation
reaches, because the reader does not know the word they are missing and the only
thing that does is the signature list already in memory.

So [suggest.ts](../src/cli/suggest.ts) answers two questions off that list.
**Which term is responsible**: every term is counted twice, on its own and with
everything but itself, because a term that matches nothing alone is a wrong word
while a term that matches plenty alone and nothing in company is an
over-constrained search, and those have different remedies. And **what the
corpus calls it**: the closest words actually present, each with the number of
rows it leaves *given the search's other terms* — a suggestion that also matches
nothing is not a suggestion.

Two matching rules, and the second is the one that earns the module. A
misspelling shares a start (`speedomter3` → `speedometer3`). An abbreviation is
a subsequence sharing a first letter — which is how `idb` is found in
`indexeddb`, where the edit distance is 6 on a 9-letter word and no substring
relates the two at all. They are ranked in separate tiers because an
abbreviation always scores badly by length, so mixing them would bury `idb`
under every word sharing four letters.

A chip fails differently: it is exact, so the common failure is a fragment of a
real value, and the suggestions are the whole values containing it, ordered by
how many rows each covers. **The paragraph explaining that chips are exact is
now printed only for a search that used one.** It used to be printed at every
empty result, including the ones from free text, which sent a reader hunting for
a wrong value when the word itself was wrong.

**An exclusion gets no suggestions**, only its counts. `chipSuggestions` answers
"which value did you mean", and the answer to a `-platform:andriod` that
excluded nothing is that it excluded nothing — offering other platforms to
exclude instead would be inventing an intent. The counts still locate it: for a
negated chip, `alone` is the rows it *left*, so an exclusion that was the one
thing emptying the list still shows up as the term with the large `without`.

### `search` flattens subtests instead of grouping them

The picker groups a matched child under its parent, auto-expanding it, because a
table of 25,000 rows needs the hierarchy to stay navigable (design.md, "Match
inside subtests"). Here the answer is a list of signature references and a
subtest's reference is as good as a parent's, so `--subtests` widens *the set of
rows the filter sees* and nothing else. Rows carry `isSubtest` in `--json`.

### `series` compares levels, not builds, and says so

With more than one reference, every series after the first is tested against the
first over their **push means** — one value per push, the same unit of analysis
`changes.ts` argues for at length. Pooling replicates would report a sample size
the data has not earned.

This is deliberately *not* `compare.ts`. That module answers "these two clicked
points", and its `series` kind is two series on **one** push, where both sides
share a build. Here the sides are two different sets of builds over the same
weeks, which is the right question for "how does Firefox compare with Chrome"
and the wrong one for anything causal: nothing pairs a Firefox push with a
Chrome push, so the output says which side is better over the window and never
why. The `BETTER` column is blank unless the test is significant *and* both
sides agree about which direction is better — never the sign of the delta alone.

### `changes` merges two analyses into one timeline

Perfherder's alerts and this app's detected changes are independent opinions
about the same series, and graphs.md explains why both are worth having: the
detector finds sub-threshold steps perfherder never alerts on, and perfherder
carries a sheriff's triage and a bug number.

A detected step and an alert **within three pushes of each other and agreeing
about direction** are reported as one row, marked `both`, with the push distance
printed when it isn't zero. Three pushes because on autoland that is minutes to
a couple of hours, and the two analyses locate a step differently by
construction — a rank relocation over a ±24-push window against perfherder's
sliding windows — so exact agreement is not the common case even when both are
right. Beyond three they are claims about different pushes and merging them
would invent an agreement.

Their percentages still differ, and both are right; the output says why
(perfherder averages a 12–24 push window, the detector averages either side of
the step it located). Invalid alerts are dropped, because a sheriff has already
said they mean nothing — the same single exclusion `alerts.ts` makes.

### `series --drift` answers the question the detector cannot

Segmentation looks for steps, and a series that slides 8% over three months has
no step in it — graphs-todo.md has carried that as a known limitation for as long
as the detector has existed ("Gradual drift is invisible by construction"). The
trial's most-quoted table was exactly this shape: every idb-open series slower
than February, +5.6% to +42%, with no single landing accounting for most of it.
Producing it meant running `series --from/--to` twice and diffing the medians in
another language.

`--drift` prints the first window of the range against the last. The figure lives
in [drift.ts](../src/lib/graphs/drift.ts) under `src/lib` rather than beside the
reports, because **the app shows the same one** on its series-list cards — see
graphs.md, "The drift figure, for the series with no bars". This command is the
unfiltered view of it: the card holds the figure to the detector's floor and α
before it will mention it uninvited, while `--drift` was asked for by name and so
prints whatever it computed, p-value and all. A p of 0.4 beside +8% is itself the
answer to "is this series drifting", and only the CLI will tell you that.

**The window is `WINDOW_PUSHES` a side**, imported from changes.ts rather than
chosen here, so a drift figure and a `step` or `changes` figure are on one scale
— and medians
rather than means, matching the level line's headline and for the reason
changes.ts keeps raising, that one bad push drags a mean.

Two things it is careful to say. Both windows' own dates are printed, because
"February against now" is a claim a reader has to be able to check — 24 pushes on
autoland is three days, not a month. And the p-value is labelled as what it is:
the ends are at different levels, which is not the same claim as a step having
happened between them. Below twelve pushes there is no figure at all rather than
a ratio of three against three; six a side is the detector's own minimum.

### `--cluster` makes the row a landing instead of a series

`changes` answers about one series, and the question that prompted this tool's
third worked example — *how has IndexedDB open performance changed in six
months* — is about 21 of them. A trial ran it over four batches of refs and then
wrote a script to flatten 99 events, sort them, and group them by push. That
grouping was the finding: nine events across three platforms on 2026-07-15 are
one landing, bug 1899194. The tool made the reader build the answer.

`--cluster` is that grouping, and `--across` is the precedent — assembling the
*input* list by hand cost more commands than the analysis did, and this was the
same complaint about the output.

**Events group by the interval they bracket, not by the push they were placed
on.** A bar's position is an estimate, which is why `locate` exists, and two
platforms do not run the same pushes — so one landing is placed on a different
revision by each series that saw it. `(prevAtMs, atMs]` is the part that is not
an estimate: whatever moved the graph landed in there. Overlapping brackets are
therefore the honest join, and **their intersection is a narrower window than any
single series carries.** On the nine cursor signatures it collapses to nothing at
all: eight of them bracket `00e66d720953..4d11378e3f07` and the ninth brackets
`4d11378e3f07..67861311e985`, the two meet on one push, and the report says
"pinned to one push" — which is the push bug 1899194 landed on. Reaching that by
hand took `locate` and then `commits`.

Three things the shape is careful about:

- **Direction is not part of the key.** A regression on one metric and an
  improvement on another at one instant is a trade-off, not a coincidence, and
  splitting on it would file the two halves of alert #51136 —
  idb-open-many-seq +10.8%, `delete_duration` −35%, one push, one bug — as
  unrelated. Both counts are on the row instead.
- **A group whose members chained without sharing an instant is marked `~`.** A
  overlaps B and B overlaps C while A and C do not: still one group, but its
  window is a union and a weaker claim than an intersection, and printing the two
  the same way would be the "truncated answer shaped like a complete one" rule
  broken at a subtler level. In practice the flag earns its keep — over twelve
  idb-open signatures, steps on six consecutive days stayed six landings and only
  2026-07-16 chained.
- **PEAK is the largest move by magnitude, not the mean.** One platform at +500%
  and two at +8% is a +500% event with partial reach; averaging it to +172%
  describes nothing that happened.

Grouping is per repository, because a push id and the moment a merge reached
another branch are different clocks: two events at one instant on autoland and
mozilla-central are one change *landing twice*, and one row with two revisions
would be a claim about a single event. "Did the other branch see it" is `step`'s
question.

**The app now groups its bars with the same module**, which is why `cluster.ts`
lives under `src/lib/graphs` rather than beside this file — see graphs.md, "One
landing, not nine bars". Two consequences worth knowing here: the phrase
describing a landing's window ("pinned to one push", "4.5 h window", the union
warning) is `landingWindowLabel` and is shared, so the two views cannot word one
grouping two ways; and the SERIES column counts *distinct series* rather than
events, since two consecutive bars in one series bracket intervals that meet at
the push between them and so join one landing.

### `--pool` widens a comparison from a push to a window

`compare`'s mode analysis rested on one push's 25–75 replicates, and on a real
series the mode *count* flipped between two legitimate choices of push pair —
which makes the finding a property of the pair rather than of the data. `step`
pools 24 pushes a side and has no modes at all, because it works in push means.
The capability sat in the gap between two commands with half of it each.

`--pool <n>` closes it. Each side becomes `n` pushes: the earlier one reaches
back from the push named, the later one forward, so the windows meet at the step
instead of straddling it — the same shape `step` measures, which is what lets the
two commands' numbers be read against each other. The merged group keeps the
named push's id, revision and timestamp, since it is still a comparison *of that
build* and the links must not start pointing somewhere else.

**Pooling changes what the test is over, and this is the one number the CLI
overrides.** 24 pushes × 30 replicates is 720 values and nothing like 720
independent draws: replicates of a run are repeated measurements of one number
and every run of a push shares its binary and its moment (changes.ts makes the
argument at length). A rank test told otherwise returns p < 1e-100 for any two
windows at all, which is worse than no number. So the pooled cloud keeps the
distributions, the modes and the spread — the shape is the whole reason to pool —
and the test switches to one value per push, using the same `mannWhitneyU` and
the same unit of analysis `step` and `changes` use. `CompareReport.testBasis`
says which, and the text does too.

Two figures for one event are reconciled rather than left to disagree: the pooled
medians weight a push by how many times it ran, so the report also prints the
equally-weighted push-mean level, which is exactly what `step` prints for the
same window.

`--pool` needs the two points to be on different pushes. For two series over a
window, `series` is the command — its whole subject is levels over a range.

**A pool that could not reach `n` says so, in the line under the header.** Because
the windows reach *outward* from the push named, a push within `n` of that end of
the range has nothing to reach — and `@first` / `@last` have nothing at all, so
`compare --pool 24 <ref>@first last` pools one push a side. That is the design
working, not a bug, but for a while it was silent: the run produced a 1-vs-1
comparison and then "too few values for a density estimate", with nothing anywhere
connecting the missing modes to the request that never landed. It is the
"a truncated answer must never be shaped like a complete one" rule, one command
late. `CompareReport.poolShortfall` carries it, both sides' counts are printed
because "24 and 1" is the diagnosis and "1" alone is not, and the note points at
`series --drift`, which is the command whose actual subject is the two ends of a
range.

`step` had this right all along — "up to 24 pushes a side" in its header, and the
counts it really got on each row — which is where the wording came from.

### The mode analysis

[modes.ts](../src/cli/modes.ts) is the one place the CLI computes something the
app does not, and only because the app answers the question with a picture: it
draws both KDE curves on one axis and lets the reader see whether the peaks
moved. There is no reader here, so the finding has to be a sentence.

Given both sides' `ModeInfo` — whatever `kde.ts` found, with PerfCompare's
thresholds untouched — it pairs the modes and returns one of five verdicts:
`unchanged`, `shifted`, `reweighted`, `shifted-and-reweighted`, `restructured`.

- **"Moved" means further than one bandwidth.** A Gaussian KDE smooths at the
  scale of its bandwidth, so a smaller displacement is the kernel talking, not
  the data. This is the load-bearing threshold: calling such a shift a movement
  would hide the interesting answer ("the modes are where they were; the weight
  moved") behind a false one, and that answer is the entire reason the analysis
  exists. The resolution is the *wider* of the two bandwidths, and the output
  prints it.
- **"Reweighted" means ten percentage points of the density changed hands.**
  Below that a share moves with which replicates happened to land near a
  boundary. The exact figures are in the table regardless.
- **Equal mode counts pair by rank; unequal counts pair nearest-first** within
  four bandwidths, and whatever is left over is reported as gone or new. A mode
  appearing or disappearing is a change in what the test *does*, and the output
  says so rather than letting it read as a slowdown.

### The ASCII density plot uses a square-root scale

Both sides are drawn on one shared axis and one shared density scale, because
two curves on separate scales can be compared by neither eye nor sentence. But
eight block characters is not sixty-eight pixels: both curves integrate to 1, so
a tight pool peaks many times higher than a broad one, and at eight levels a
linear scale renders anything past 8× as an *empty row*. That does not read as
"shorter", it reads as "no data" — a false statement about the side whose
distribution is the question. It happened on the first real series this was run
against, a 4-value push against a 7-value one.

So the block level is `√(density / sharedPeak)`, which keeps the ordering, bounds
the squash, and costs the plain reading that height is spread in proportion — a
reading that was not available at this resolution anyway. The pool summaries
above the plot carry the spread. graphs-todo.md has the same trade-off open for
the canvas version, where it is a closer call because 68 pixels can show a 20×
ratio and eight characters cannot. A column below the first level is a space, so
the curve's extent is visible; the ruler underneath carries the axis.

### The published package

`perfherder-cli/` is a package of its own: its own `package.json`, its own
version, and the built bundle. The arrangement is
[profiler-cli](https://github.com/firefox-devtools/profiler/tree/main/profiler-cli)'s,
and it exists so that publishing the tool is not publishing the app, and so the
tool's version is not the app's — the root package stays `private`, at 0.0.0,
where it belongs.

The tarball is four files and 58 kB: the bundle, `package.json`, the README and
the licence. Not the sourcemap, which is four times the size of the thing it
describes and buys nothing here — the bundle is unminified on purpose, so its
stack traces are already readable (see the `minify: false` note in
`vite.cli.config.ts`). Not `src/` either: the published artifact is one file that
`node` runs, and the source is a `git clone` away.

**The version is compiled into the bundle**, from the package's own
`package.json`, and that is load-bearing rather than decorative.
`perfherder-cli/dist/` is gitignored and the only thing that ever rebuilds it is
the wrapper, when somebody happens to run it — so the standing risk is bumping
the version, publishing, and shipping last week's code under this week's number,
which is worse than shipping nothing because the version is what a bug report
quotes. [verify-cli-build.mjs](../scripts/verify-cli-build.mjs) searches the
bundle for the version string, and is wired to `prepublishOnly` so it runs
whichever way `npm publish` is reached. It checks the shebang and the executable
bit for the same reason: npm sets the bit when it installs a `bin`, and a tarball
unpacked by hand does not get that favour.

#### Releasing

1. **Bump `version` in [perfherder-cli/package.json](../perfherder-cli/package.json)**
   and commit it. Nothing does this for you: the version is a claim about what
   changed, and the two mistakes it guards against are both caught anyway (npm
   refuses a version it already has; `prepublishOnly` refuses a bundle that
   doesn't carry the one on the tin).
2. **`npm run publish:cli`.** It runs `check`, `test`, `build` and `build:cli` —
   the same four gates CI runs — then `npm publish perfherder-cli/`. Extra
   arguments are forwarded, so `npm run publish:cli -- --dry-run` rehearses it.
3. That machine needs `npm login`. The scope is personal, so there is no
   organisation to be a member of.

A prerelease version (`0.2.0-rc.1`) goes to the `next` dist-tag rather than
`latest`, so nobody installing by name lands on one. `--access public` is passed
for you: a scoped package is restricted unless told otherwise, and "published,
but only I can see it" is a failure that looks exactly like success.

**After a first publish the registry can 404 for a minute or two.** The
npmjs.com page appears before `registry.npmjs.org/@mstange%2fperfherder-cli`
does, and `npm view` 404s in the gap. Wait, don't debug. Two things that look
like evidence in that window and are not: npmjs.com answers plain `curl` with
403 whatever the package's state, because of bot protection; and `npm view` 404s
for an unauthenticated shell in the same words it uses for a package that does
not exist.

### Times are UTC

`chart.ts::formatTimestamp` is local, because the app's reader is reasoning
about their own day. CLI output is pasted into bugs, diffed against a previous
run, and read by a session in an unknown timezone, so the same instant has to
print the same string everywhere — and every timestamp treeherder serves is UTC
to begin with. Timestamps carry a trailing `Z`; `--from`/`--to` read a bare
`YYYY-MM-DD` as UTC midnight.

### A misspelled flag is an error, not a silent difference

`parseArgv` records a flag with no available value as `true` rather than
rejecting it, so that a typo reaches `unknownFlags` and gets told *this command
has no such flag*. Rejecting at parse time reported the wrong problem:
`changes --replicates` used to come back as "--replicates needs a value". A
declared flag that was given no value still gets "--x needs a value", from
`flagString`.

## What four fresh sessions found

The tool was trialled by handing four questions to four agents with no context
beyond the repository, and asking each for a blunt account of the friction. All
four drove it from `--help` alone; three never opened the source, and the fourth
read thirty lines of `filter.ts` only because of the chip-field trap below. That
is the good news, and it comes with a caveat two of them raised unprompted: the
worked examples in `--help` and in this file describe the very questions they
were asked, one of them quoting the July 2026 investigation with its real
figures. As one put it — *"I did not solve this problem; I followed a documented
recipe for this exact problem. Assume my time-to-answer is not representative."*

**A `guide` subcommand was considered and rejected.** Not one of the failures
below is a failure of explanation, and every one of them would have survived a
guide:

- the field was accepted in silence (a behaviour bug),
- the feature is called `idb` and the reader typed `indexeddb` (a vocabulary
  problem in the data, not the docs),
- the labels in a summary table did not distinguish its rows (a rendering bug),
- assembling a ref list across platforms took more commands than the analysis
  did (a missing feature).

Meanwhile the loudest complaint, from all four, was that there is *already too
much prose*: the column legends reprinted once per series rather than once per
invocation. Adding a command whose output is more prose, to a tool whose help is
already carrying the load, would treat the symptom of nothing. The worked
examples are the guide, and they are in the right place — extend those.

### The defects it found, and what they were

- **`commits` did not exclude the base push given a short revision.** The filter
  was an exact string compare; the API returns 40-character revisions and 12 is
  how a revision is written everywhere a person can type one. So the range
  blamed the reference build for the change it is the reference for, while the
  header went on asserting the base push had been excluded. Fixed in
  `pushlog.ts::sameRevision`, which prefix-matches in either direction. The
  worst of the four, because the output was confidently wrong rather than merely
  unhelpful.
- **An unknown chip field was silently demoted to free text.** `app:firefox` —
  the field is `application` — became a substring search for the literal string,
  matched nothing, and the no-match hint then explained that a chip is an exact
  match on its *value*, sending the reader hunting for a wrong value. Eight
  commands. The trap was self-inflicted twice over: the results table's column
  header said `APP`, and this file boasts that a misspelled *flag* is an error
  rather than a silent difference while applying none of that reasoning to
  fields. The fallback stays — a test name may contain a colon — but the silence
  is gone, and the header now says `APPLICATION`.
- **`series` labelled its comparison rows `fenix → fenix`.** Two Fenix configs
  differing only by `fission`, in the table whose entire job is to be the
  summary, with the one distinguishing attribute omitted. It cost a wrong
  reading and a duplicate query, because piping a long report to `tail` is the
  natural move and the table could not be read on its own. Now labelled by
  `splitCommonAttrs`, the same split `step` uses.
- **A mode pair was labelled `reweighted` when its share only moved because
  another mode vanished.** With one side down a mode, the survivors' shares must
  add back to 100% without it, so 87% → 100% is arithmetic. A reader took it for
  the finding; the finding was the lost mode on the line above. The flag is now
  gated on both sides having the same mode count, and the sentence says so.
- **The KDE bandwidth was never printed**, though "moved" and "in place" are
  defined by it. A `563.01 → 563.01, +0.00%, in place` row read as snapped
  rather than measured, and there was no way to check. Both bandwidths and the
  resolution are now printed under the mode summary.
- **`step --at <revision>` looked the revision up only in the repositories of
  the refs given**, while the help promised otherwise — and the promise is the
  useful behaviour, since "this landed on autoland, did mozilla-central see it?"
  is the question. It now falls back to the rest of the pinned set.
- **Column legends printed once per series.** Six times in one `changes` run.
  Once per invocation now.
- **`step` printed only percentages, and only one direction.** Two defects with
  one fix, both in the table a suite's subtests are read from. "Which subtests
  *drove* this move" is the milliseconds question and ranking by percentage
  answers a different one, so there is now a Δ column beside CHANGE. And a run
  that mixes a score with three timings printed `+0.53% improvement` above
  `-1.5% improvement` — both right — because direction was only ever stated in
  the header, which by construction carries what the series *share*. It is now a
  per-row METRIC column, collapsing to one header line when every series agrees.
- **A sparkline carried no scale.** `▁` is the row's own minimum and eight block
  characters have no axis, so a ~10% dip read as a large improvement: the only
  numbers beside it were a `range` widened by outliers, which the row does not
  span. `series` now prints the two values the lowest and highest blocks stand
  for. They are the *drawn* extremes — bucket means over the resampled columns —
  rather than the series', because those are what the blocks are, and the level
  line above already carries the raw spread. Where the two disagree, that
  disagreement is the outliers, and is worth seeing.

### All eight are now closed

The three output defects are in the list above. The rest needed new capability or
new structure, and each has its own section: `--across` for the horizontal slice,
`--pool` for a mode analysis with more than one push behind it, `locate` for
which push a step is on, `suggest.ts` for a search that matched nothing, and
`loadSeriesOrError` for a fetch failure that used to end the run.

## Code map

Dependencies run impure → pure, so everything that decides what an answer *is*
is testable without a network.

- [args.ts](../src/cli/args.ts) — **pure**. argv, durations, ranges, series
  references, search terms, and which interval to ask the signature list for
  (`signatureInterval` — it decides what gets fetched, so it is here and tested
  rather than in main.ts, where it was). Reuses `filter.ts::parseChip` and
  `pickerOptions.ts::TIME_RANGES`, so a chip means the same thing here as in the
  picker's search box and an interval is one the endpoint is actually asked for.
- [format.ts](../src/cli/format.ts) — **pure**. Tables, sparklines, the density
  row, the ruler, word wrap.
- [modes.ts](../src/cli/modes.ts) — **pure**. The mode comparison and its
  sentence. See above.
- [cluster.ts](../src/lib/graphs/cluster.ts) — **pure**, and **under `src/lib`**,
  though it was written for `--cluster`: the app now groups the bars of its
  plotted series with it too (graphs.md, "One landing, not nine bars"), and
  dependencies run `src/cli` → `src/lib` and never back. Change events from
  several series, grouped into the landings that caused them. See above.
- [siblings.ts](../src/cli/siblings.ts) — **pure**. One row's counterparts
  across one attribute — `--like` and `--across` — and `repoScope`, which is
  that slice's rule about which repositories to fetch. See above.
- [suggest.ts](../src/cli/suggest.ts) — **pure**. Why a search matched nothing,
  and what to type instead. See above.
- [reports.ts](../src/cli/reports.ts) — **pure**. The report object per command,
  which is both what `--json` prints and what `render.ts` reads.
- [render.ts](../src/cli/render.ts) — **pure**. Report → lines.
- [cache.ts](../src/cli/cache.ts) — the `fetch` wrapper and its TTL rules.
- [load.ts](../src/cli/load.ts) — fetch orchestration. The rules about when to
  ask, and what a failure means, are copied from `appState.svelte.ts`; where
  they differ the reason is written beside them.
- [main.ts](../src/cli/main.ts) — dispatch, the commands, help, errors. (A count
  used to stand here and was wrong twice; `COMMANDS` is the list.)

Built by [vite.cli.config.ts](../vite.cli.config.ts) into one dependency-free
ES module, and type-checked by [tsconfig.cli.json](../tsconfig.cli.json) — which
exists so that `src/cli` is the only code under `src/` that can see node's
globals. Folding `"node"` into the app's `types` would have checked the CLI at
the cost of letting a Svelte component `import 'node:fs'` and pass
`npm run check`.
