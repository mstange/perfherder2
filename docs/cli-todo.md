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

A sixth trial (2026-09-03) was an open-ended **noise** investigation: "what are
the sources of noise on `newssite-applink-startup` on the A55 pool"
(`autoland,5310509,15`, 187 pushes, 725 runs, 7,250 values, August 2026). It is
the first trial whose question was not about a *change* — no step, no alert, no
before-and-after — and it is the first that could not be answered with the tool
at all. The answer it produced:

| source | sd | share of one job's variance |
|---|---|---|
| device identity (out-of-sample) | 42.3 ms · 2.65% | 67% |
| replicate sampling, 10 replicates | 26.2 ms · 1.64% | 26% |
| unexplained, per job | 13.9 ms · 0.87% | 7% |
| **one job, total** | **51.7 ms · 3.24%** | **100%** |

and, above it, a 4-run push mean whose observed scatter (23.9 ms, 1.50% — the
`cv` `series` prints) is *entirely* accounted for by job noise over four runs
(51.7/2 = 25.8 ms): the build-to-build term is negative when solved for, i.e.
indistinguishable from zero. Nothing about that table is reachable from any
command. Every figure in it was computed by hand from a `machines` `--json`
dump plus the CLI's own on-disk cache files, read directly, because no command
exposes a job.

The device row is a **floor**, not an estimate: it is the variance that a
leave-one-push-out correction actually removed — each run corrected by its
machine's offset computed from every *other* push — so it is out-of-sample and
cannot be an artefact of fitting 53 offsets to 725 runs. The same correction
takes a push mean's scatter from 1.50% to 0.96% and the job-to-job figure from
3.24% to 1.86%. The true device term is larger still, because a run is compared
with a push mean it is one quarter of, which shrinks every offset by (1 − 1/n).

The pool structure was the other half. `machines` ranks 53 workers by level and
the rows span −5.1% to +4.6%, which reads as a scatter of individually
under-powered estimates. Sorted by *name* instead, it is two populations: all 11
`R5CX23R*` devices run fast (−2.6% mean residual against their own pushes), 15
of 17 `R5CXC1A*` run slow (+1.7%), and the two families differ by 67.9 ms —
4.3%, t = 19.7. Pooling the four A55 startup signatures widens it to ~10% across
the pool, and a machine's offset correlates 0.95–0.97 across three independent
startup metrics and 0.91 between the first and second half of the month. So the
device term is not estimation noise and not a bad worker: it is a stable,
reproducible property of which handset a job landed on, and it is the largest
single source of noise on this test.

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

The six items below are what the noise trial asked for, in the order it needed
them. The first is a command that does not exist; the next four are `machines`
and `compare` being asked a question they hold the data for; the last is the
reason all of it had to be done by hand.

- [ ] **A `noise` command: what is the scatter made of.** Every figure the tool
      prints about spread is the *push mean's* — `series` reports `sd`/`cv` over
      push means, `compare` reports each pool's `cv`. On this series that number
      is 1.50%, and it is the least informative of the three: one job carries
      3.24%, one replicate 5.19%, and the push mean's own scatter is what is left
      after four runs average out — no build-to-build term survives being solved
      for. A reader told "cv 1.5%" concludes the test is quiet; the truth is that
      it is noisy and the averaging is doing the work, which is a different
      finding with different remedies. The decomposition needs nothing new from
      the network: `buildSeriesData` already has push → run → replicate, so the
      three levels are a walk over what `series` has in hand. What to print, on
      the evidence of what got quoted here: the sd of a replicate, of a run mean,
      and of a push mean, each in the unit and as a percentage; the between-run
      pooled sd *within* a push, which is the honest job-to-job figure; the
      device share of it (below); and the two resolution figures — 4.5% for two
      single pushes on this series, 0.93% for the detector's 24-push window
      against a 2% alerting threshold. The last pair is the sentence a developer
      actually wants: *a single try push cannot see anything smaller than 4.5%
      here*.

- [ ] **`machines` should use the within-push contrast where it exists.**
      cli.md, "`machines` ranks the pool against its own neighbourhood", rests on
      "there is no within-push comparison to fall back on: workers do not run
      concurrently, so a push is measured by one of them and its own value *is*
      the push's level". That is not how these pools run. On this signature 186
      of 187 pushes have two or more runs and 164 have every run on a *different*
      machine; `linux2404-64-shippable` speedometer3 runs **12** jobs a push from
      a 100-machine pool, 149 of 166 pushes with two or more. Where a push has
      several machines, comparing a run with its own push's mean is exactly
      contemporaneous — same build, same hour, same everything but the handset —
      so it cannot be confounded by a step, by drift, or by which weeks a machine
      was in rotation, and the shrinkage is a known factor (a machine carries
      1/n of the mean it is measured against, so the observed offset is
      (1 − 1/n) of the true one, correctable rather than a caveat). It is also
      what makes the variance decomposition above fall out for free. Keep the
      rolling-median baseline as the fallback for the single-run pushes, and say
      per row which baseline was used.

- [ ] **`machines` should report spread, not only level.** The command's own help
      offers it for "a bad power supply, a thermal problem, a different silicon
      stepping" — but only the first and third of those move a *level*. A
      thermally throttling device is erratic at an ordinary average, and the
      table cannot show it: measured here, per-machine residual sd runs 20 → 52
      ms and per-machine median replicate sd runs 44 → 97 ms, neither of them
      related to the level column, and the two most erratic devices sit at +11
      and +14 ms of level — mid-table, unfindable. Two more columns (SPREAD, and
      the machine's own median replicate sd) turn the command into the one it
      says it is.

- [ ] **REL LEVEL needs an uncertainty, and the pool needs an ordering other
      than level.** A 9-run machine and a 21-run machine print the same kind of
      number and `SHARE` is a proxy for the difference; an explicit ± (the sd of
      the machine's residuals over √n) is the thing being proxied, and it is the
      difference between "this worker is 4% slow" and "this worker has run nine
      times". Then: 53 rows sorted by |level| actively hid this trial's main
      finding. Sorting the same table by *name* put the two device families in
      contiguous blocks and the split was visible immediately — 11 fast
      `R5CX23R*` against 17 mostly-slow `R5CXC1A*`, 4.3% apart with t = 19.7. So
      `--sort name|level|runs|spread`, and worth considering a
      `--group <prefix-length>` that aggregates the rows and prints per-group
      medians with counts. **The grouping is the offer; the interpretation is
      not.** A shared serial prefix is evidence of a common batch, not proof of
      one, and the tool should show contiguous families and let the reader decide
      whether that is a hardware revision, a rack, or a coincidence.

- [ ] **`compare` should name the machines behind each side, and test over jobs
      rather than replicates.** Both halves showed up on one pair. Asked to
      compare the two extreme pushes of this window (chosen *as* the extremes, so
      the pair proves nothing on its own — the failure mode is what is being
      shown), `compare` reported −6.4%, "p <0.001", "Cliff's δ 0.795 (large)",
      "CLES 90%", verdict "improvement", and the mode analysis called it "the
      level shifting". It never mentioned that the slow side ran on four devices
      averaging +24 ms and the fast side on three averaging −33 ms: 43% of the
      delta it called a large improvement is the machine draw, and the machine
      names were on the datums it had already fetched. And the p-value is over 40
      vs 30 *replicates* from 4 and 3 jobs — the `--pool` documentation states
      the objection precisely ("replicates of a run are repeated measurements of
      one number and a rank test over 700 of them reports a p-value it has not
      earned") and then the single-push default does it anyway. Over job means
      the same pair is t = 3.75 on 4 vs 3, p ≈ 0.013, and machine-corrected it is
      75 ms rather than 133. Minimum change: a MACHINES line per side. Right
      change: test over job means whenever both sides have three or more runs,
      keep the replicate pools for the distributions and the modes where they
      belong, and print the resolution floor beside the verdict.

- [ ] **Job-level data has no exit from the tool.** `series --pushes` aggregates
      to the push (`runCount`, `valueCount`, mean, median); `compare --json`
      carries `runCount` but no runs; `machines --json` carries tallies and a
      `relativeLevel`. So there is no way to get the one table every question in
      this trial needed — one row per job, with its machine, its mean, its
      replicate sd, its push. The investigation was done by reading
      `~/.cache/perfherder-cli/*.json` directly, which is a raw treeherder
      payload with none of the app's projections applied: exactly the "do not
      hand-roll it" path the tool exists to prevent. `series --runs` in text and
      a `runs[]` array under each push in `--json` is a small addition to a
      report that already walks that structure.

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

- **Time of day, and why the noise trial could not answer it.** A diurnal or
  weekday term is a plausible source of lab noise and the natural thing to look
  for next, but the within-push contrast cannot see it: every run of a push is
  submitted within 0.1 h of the others here, so anything shared by a push is
  removed along with the push. Measured against the machine-corrected residual,
  the eight three-hour bins sit within 5 ms of zero (se 2.3–3.6) and the weekday
  spread is Sunday −8.4 ms to Friday +4.0 ms — consistent with nothing, but the
  design is what makes that weak rather than the data. Answering it properly
  means the rolling-level baseline (which carries the whole push, time included)
  and a note that any drift in the series masquerades as a day-of-week effect. A
  `noise` command should decline the question rather than print that table.

## Not doing

- **A robust replicate statistic (`--median`, `--trim`).** The obvious remedy
  for the slow-replicate tail, and measured on this series it buys almost
  nothing. The slowest of a run's 10 replicates sits a median 113 ms above the
  mean of the other nine, and 53% of runs have one more than 2 sd out, so the
  tail is real — but the run mean over 10 already dilutes it, and the push-mean
  scatter only moves from 1.50% (mean) to 1.47% (median), 1.43% (drop the max) or
  1.40% (drop max and min). Against 0.96% for machine calibration, a `--trim`
  flag would be a control that looks like it addresses the noise and addresses
  4% of it, while inviting a second definition of "the value" into a tool whose
  numbers are supposed to be the app's. Recorded here so the measurement does
  not have to be redone the next time it is suggested.

- **A `guide` subcommand.** Rejected once already, in cli.md, and this trial
  supports the rejection from a new direction: none of the eight items it raised
  was a failure of explanation. Six were behaviour, one was a missing feature,
  and the one that *was* about words — the commit headers — got fixed by changing
  the words in the output rather than by adding more of them elsewhere.

- **A rolling `--range` in the links `url` emits.** The trial asked for one, and
  the app cannot express it on purpose: `urlState.ts` stores absolute bounds
  rather than "last N days" so that a shared link keeps showing the point it was
  shared for. `url --help` says so now, since the question will recur.
