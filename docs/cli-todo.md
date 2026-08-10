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

## Next

- [ ] **A landing is the unit of the answer, and no command reports one.**
      The trial's real question — "has IndexedDB regressed" — is 21 signatures,
      and every command is per-series. Answering it took `changes --json` over
      four ref batches, then a hand-written script to flatten 99 events, sort
      them by date, and group them by push. That grouping *is* the finding: nine
      events across three platforms on 2026-07-15 are one landing (bug 1899194),
      and the report that says so is the report the user wanted. `--across`
      exists because assembling a ref list by hand took more commands than the
      analysis did; this is the same complaint one level up, about the results
      rather than the inputs.
      Wants a pure module that merges the entries of several `ChangesReport`s by
      push proximity — the `MERGE_PUSH_DISTANCE` reasoning already in reports.ts,
      applied across series instead of across the two analyses — and one row per
      landing listing the series it hit.

- [ ] **`--commit-limit` truncates silently, and truncation is the one thing
      this tool does not do silently.** `attachCommits` slices to the limit but
      `commitsLabel` is `pushlogLabel(range)`, computed from the *unsliced*
      range: `--commit-limit 8` over a 36-commit range prints "36 commits:" above
      eight rows with nothing to say the other 28 exist. cli.md already states
      the rule this breaks ("a truncated answer must never be shaped like a
      complete one") and credits `pushlogLabel` with keeping it.

- [ ] **Attribution has no filter, which is what makes a busy push unanswerable.**
      "What caused this step" over a 20-commit merge means reading 20 unrelated
      commits, and the trial's actual move was
      `perfherder-cli commits … | rg -i 'quota|indexeddb|idb|storage'` — which is
      how both the cursor improvement and the quota-manager regression were
      found. A `--commit-grep <pattern>` (matching title, author and bug) with the
      non-matching count reported, so the filter cannot hide the same way the
      limit does.

- [ ] **`changes --json` changes shape with the number of refs.**
      `report: reports.length === 1 ? reports[0] : reports` (main.ts) — one ref
      gives a bare `ChangesReport`, two give an array of them. A script written
      against either breaks on the other, silently, because both are valid JSON
      with the right field names one level off. Every other multi-ref command
      already has the answer: `series` and `step` return one envelope with
      `entries[]` whatever the ref count. The rule worth writing down is that
      **a report's shape must not depend on how many refs were asked for.**

- [ ] **The commit table's headers name fields the JSON does not have.**
      `BUG` / `SUMMARY` in the text; `bugs: number[]` / `title` in the object.
      Guessing `x.bug` and `x.summary` from the headers produced a column of
      `undefined` and cost a fallback to grepping text output — the same class of
      trap as the `APP` header for `application` that cli.md records, and the
      same fix: make the header say what the field is called. `BUG` also prints
      `bugs[0]` alone, so a two-bug commit drops one without saying so.

- [ ] **Multi-ref text output is unreadable past about three refs, so the
      reader leaves for `--json` and does the rendering by hand.** Twelve refs
      over six months emitted a paragraph per event — pushlog URL and graph URL
      repeated for every one of 99. Piping to `tail` was the natural move and
      loses the top, which is the defect cli.md already recorded for `series`
      labelling its rows `fenix → fenix`. A `--brief` that prints the event table
      across all series and holds the per-event blocks for `--json`. Note this
      cuts with the grain of the loudest complaint from the earlier four trials,
      that there is already too much prose.

- [ ] **Net drift over a window takes two invocations and arithmetic in another
      language.** "Where was this in February against now" was
      `series --from/--to` twice plus a median diff in node, for the table that
      turned out to be the most quoted part of the answer (every idb-open series
      slower than February, +5.6% to +42%). A `--drift` that prints the first and
      last window's level and the delta.

- [ ] **`url --range 6mo` bakes absolute millisecond timestamps.** Pinning is
      right for a link pasted into a bug and the trial said so in its report, but
      there is no rolling form and the precision is noise —
      `range=1770824167527,1786376167527` for a window whose ends are days.
      Round to the day; consider a `--rolling` that emits the duration if the app
      will take one.

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
  supports the rejection from a new direction: none of the eight items above is
  a failure of explanation. Six are behaviour, one is a missing feature, and the
  one that *is* about words (the commit headers) is fixed by changing the words
  in the output, not by adding more of them elsewhere.
