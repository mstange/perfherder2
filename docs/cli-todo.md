# The CLI — implementation status

Living checklist. Update in the same commit as the work it describes.
Companion to [cli.md](cli.md), which carries the *why* for everything already
built; this file is what is next and what was deliberately left.

The list below came out of a fifth live trial (2026-08-10), a six-month
IndexedDB regression hunt across 21 signatures on three platforms. Unlike the
four sessions in cli.md, "What four fresh sessions found", this one was not
answering a documented worked example — the question was open-ended, and the
friction was concentrated in a place the earlier trials never reached: **many
series at once, over a long range, where the finding is a landing rather than a
series.**

## Done

- **A landing is the unit of the answer.** `changes --cluster` groups the events
  of every ref in the run by the push interval each brackets, so one change seen
  by nine signatures on three platforms is one row saying so. The window printed
  is the intersection of those brackets, which is narrower than any single series
  carries — on the nine cursor signatures it collapses to a single push, the one
  bug 1899194 landed on, which by hand took `locate` and then `commits`.
  `cluster.ts` (+ tests). See [cli.md](cli.md), "`--cluster` makes the row a
  landing instead of a series".

- **Both narrowings of a commit list are counted.** `--commit-limit` used to
  slice while `commitsLabel` went on counting the range, so eight rows sat under
  "36 commits". And `--commit-grep <pattern>` is the filter the trial ran by hand
  through `rg`, on `changes` and on `commits`, matching title, author or bug —
  with the excluded count reported, since a filter that hides the culprit must
  not look like a range that never held one.

- **The commit table's headers name the fields the JSON has**: `BUGS` and
  `TITLE`, for `bugs` and `title`. `BUG` and `SUMMARY` cost a session a column of
  `undefined` and a fallback to grepping text. All of a commit's bugs print, not
  just the first.

- **`changes --json` is always an array.** It used to be a bare report for one
  ref and an array for two, which made the shape of the output a function of the
  length of the input. The rule, now that it holds everywhere: *a report's shape
  must not depend on how many refs were asked for.*

- **`changes --brief`** prints the event table without the per-event paragraphs
  or the URLs, which is the readable form past about three refs. It keeps a
  commit list asked for with `--commits`, since suppressing that would make
  `--brief --commits` do the fetching and none of the reporting.

- **`url` writes its range in whole UTC days**, widened outward, instead of
  thirteen digits of millisecond precision in a string meant to be pasted into a
  bug. Only in `url`: `resolveRange` feeds the fetches, and snapping it there
  would change which pushes are in the window.

- **`series --drift`** prints the first window of the range against the last,
  which is the question segmentation cannot answer and which produced the trial's
  most-quoted table. 24 pushes a side, the same window `step` and `changes` use,
  so the figures are comparable; both windows' dates are printed, since "February
  against now" is a claim the reader has to be able to check.

- **A pool that came up short says so.** `compare --pool 24 <ref>@first last`
  produced a 1-vs-1 comparison and then "too few values for a density estimate",
  with nothing connecting the missing modes to a `--pool` that never landed. The
  behaviour is right — the windows reach outward from the push named, so the range's
  edges have nothing outside them — but silence about it made a degraded answer look
  like a complete one, which is the rule this tool breaks least often and cares about
  most. `CompareReport.poolShortfall` (+ tests) now carries the request beside what
  each side reached, and the note points at `series --drift` for the ends-of-range
  question. Found while using the band work's mode analysis, not by a trial.

## Next

- [ ] Nothing outstanding. The two items below were looked at and deliberately
      left.

## Open questions / deferred

- **A long-range `search` can miss a signature the range command will ask
  about, and it is not clear the CLI can know.** `search` defaults to 14 days
  and `--interval` already takes the same duration vocabulary (`parseDuration`,
  then `snapInterval`), so `--interval 6mo` was available and the header does
  disclose the window it used — "last 14 days · 29,606 signatures fetched". What
  it cannot disclose is the consequence: a signature that stopped reporting in
  March is absent from a six-month analysis assembled out of a 14-day search,
  and nothing connects the two commands. Accepting `--range`/`--from`/`--to` as
  synonyms on `search` would at least make one vocabulary serve both, but the
  coverage hole survives it, and warning about it would mean `changes` knowing
  where its refs came from. Left open deliberately: the trial's own answer has
  this hole in it.

- **Shell word-splitting, and whether a ref list should be one argument.** A
  batch loop building `refs="$refs autoland,$i"` and passing `$refs`
  unquoted fails under zsh, which does not word-split unquoted expansions.
  That is the shell's rule and not the tool's, and the positional form is
  otherwise the right one. A comma-separated single argument, or a
  `--refs-file`, would sidestep a class of scripting mistake — but it would be a
  second way to say the thing there is already a way to say, which is how a CLI
  grows two vocabularies.

## Not doing

- **A `guide` subcommand.** Rejected once already, in cli.md, and this trial
  supports the rejection from a new direction: none of the eight items it raised
  was a failure of explanation. Six were behaviour, one was a missing feature,
  and the one that *was* about words — the commit headers — got fixed by changing
  the words in the output rather than by adding more of them elsewhere.

- **A rolling `--range` in the links `url` emits.** The trial asked for one, and
  the app cannot express it on purpose: `urlState.ts` stores absolute bounds
  rather than "last N days" so that a shared link keeps showing the point it was
  shared for. `url --help` says so now, since the question will recur.
