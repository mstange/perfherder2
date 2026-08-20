# What we assume about treeherder's API

Every entry here is a place where this app depends on behaviour treeherder has
not promised: an undocumented query parameter, a field composed by a serializer
we reimplement, a default page size, a shape inferred from sampling. None of it
is a bug. All of it is a thing that can change under us **without anything
failing**, which is what makes it worth a list of its own.

The other docs answer *why the code is the way it is*. This one answers a
different question: **if treeherder changed, what would we see, and how would we
check?** Reach for it when a display goes subtly wrong for no reason the diff
explains, when you are about to depend on a new endpoint, or when you are
deciding whether a "checked against production" comment is still true.

Format for each entry: what we assume, how it was verified and when, what it
looks like when it breaks, and the cheapest way to re-check. **The verification
dates matter** — an assumption verified once in 2026 is not a fact, it is a
measurement with an age.

Nothing here is a substitute for the schemas. `src/lib/shared/http.ts` validates
every response, and `src/lib/schema.test.ts` runs the schemas against recorded
payloads so a *shape* change fails loudly in CI. This file is about the
assumptions a schema cannot express.

## The load-bearing one

### CORS stays open

`treeherder.mozilla.org` answers with `access-control-allow-origin: *`, which is
the only reason a static SPA can exist at all.

- **Symptom:** every request fails in the browser; the CLI keeps working.
- **If it breaks:** no local fix. The app needs a proxy, which is an
  architecture change, not a patch. See design.md, "What this is".

## Metadata: two endpoints describing one signature

The graphs view draws a card from whichever of two responses arrives first — the
batched signatures row (~160 ms) or the summary response that carries the data
(~1.3 s for 90 days). `SeriesMeta.source` says which. That is what makes the
group below load-bearing: **if the two ever disagree, a card visibly rewrites
itself a second after it appears.**

### `?id=` on the signatures endpoint takes many ids

`GET /project/<repo>/performance/signatures/?id=1&id=2&…` filters `id__in`
(`PerformanceSignatureViewSet.list` uses `query_params.getlist("id")`), so one
request answers for every plotted signature in a repository.

- **Verified:** 2026-08-15, against production — 866 bytes and 163 ms for two
  ids, both rows present.
- **Symptom if it becomes single-valued:** Django would keep the last `id` only,
  so every card but one keeps its placeholder until its data lands. Quiet: no
  error, just the old behaviour back.
- **Symptom if the endpoint ever paginates:** worse, because a partial map is
  shaped exactly like a complete one — missing ids are indistinguishable from
  signatures we asked about and got nothing for. It returns a bare dict with no
  `{meta, results}` envelope today, so there is no `count` to check against.
  This is the same trap as "list endpoints truncate silently" below.
- **Re-verify:** `./bin/perfherder-cli` has no command for this; the direct
  check is
  `curl "$B/project/autoland/performance/signatures/?id=5257392&id=5825019" | python3 -c "import json,sys; print(sorted(json.load(sys.stdin)))"`
  and expect both ids back.

### No `interval` on that request, deliberately

The interval filter is on `last_updated`, so passing one would answer nothing
for a signature that has stopped reporting — exactly the signature somebody is
most likely to have an old URL for. The `id` filter alone is what we send.

- **Symptom if a filter becomes mandatory:** stale-URL cards stop being named.
- **Related:** the same reasoning is why `fetchSignatureMeta` asks the *summary*
  endpoint for a zero-width window instead of an interval.

### We reproduce `PerformanceSummarySerializer.get_name` by hand

The signatures endpoint does not compose a `name`, so `metaFromSignature` builds
it with the serializer's own format string — `"{} {} {}".format(test_suite,
option_name, extra_options)` — and then recovers `options` from it with the same
`optionsFromName` the summary path uses. Two consequences that look like bugs
and are not:

- the trailing space when a signature has no extra options
  (`"BenchSign_RSA2048 64_verify opt "`), and
- no deduplication: 204 of autoland's 31,547 signatures have an option
  collection that overlaps their extra options, and the server really does emit
  `"installer size asan asan opt"`.

- **Verified:** 2026-08-15, against production — 12 signatures spanning
  subtests, `test == suite`, empty extra options and duplicated options; every
  displayed field and the composed name matched exactly. Pinned in CI by
  `metaFromSignature > agrees field for field with the summary response` in
  graphData.test.ts, against a recorded pair of responses for
  mozilla-central 5310381.
- **Symptom if the serializer changes:** a card's text changes ~1 s after it
  appears, and the "All series share" header re-splits with it. The test above
  fails only if the recorded fixtures are re-recorded, so **this is the entry
  most likely to rot.**
- **Re-verify:** re-record `src/lib/fixtures/signatures-by-id.json` and
  `summary.json` for the same signature (the header of schema.test.ts has the
  curl lines) and run graphData.test.ts.

### A multi-option collection would disagree, and none exists

For an option collection holding more than one option, `metaFromSignature` joins
the names ("debug memleak") while the summary endpoint emits only one, because
the map it builds (`performance_data.py`, `option_collection_map`) is keyed by
collection id and a multi-option collection has one row per option — so the dict
comprehension keeps the last.

- **Verified:** 2026-08-15 — production has exactly one such collection
  (`531e7f97…`, debug+memleak) and **zero of the 76,025 signatures across
  autoland and mozilla-central use it**.
- **Symptom:** a card's options are rewritten when its data lands. Cosmetic, not
  a wrong answer.
- **Re-verify:** scan a repo's signature listing for
  `option_collection_hash` values whose collection has more than one option.

### Two null fields mean different things depending on `source`

The signatures endpoint serializes neither field. On a `source: 'signature'`
meta they are null meaning **"unknown"**; on a `source: 'summary'` meta null
means **"this signature declares none"**, which is what sends
`resolveAlertThreshold` to the parent and then to perfherder's 2% default.

- **The invariant:** nothing may read either field off a `'signature'` meta.
  Today that holds structurally — both readers (`AppState.thresholdFor` and
  `driftFor`) are reached only via `loaded.meta`, and `compare.ts` only from a
  selection, which needs data. **It is not enforced by a type.**
- **Symptom if a future caller breaks it:** a drift badge or a detected-change
  bar computed against the global 2% floor for a signature whose real floor is
  0.1%, on a build-metrics subtest that moves by hundredths of a percent. It
  would look like a plausible answer.
- **If you need those fields earlier:** the honest fix is to make them
  unrepresentable — `alertThreshold: AlertThreshold | null | 'unknown'`, or a
  separate `SeriesIdentity` type — not to fill them in from a guess.

## Timestamps and windows

### `startday`/`endday` are naive UTC, with no zone marker

The summary endpoint parses them as naive datetimes, so `toApiDate` sends
`toISOString().slice(0, 19)` and must not append a `Z`. Datum
`push_timestamp` comes back the same way, which is why `parseApiDate` adds the
`Z` the string lacks.

- **Symptom:** everything shifts by the local UTC offset — a whole graph off by
  hours, which reads as a data problem rather than a parsing one.

### A zero-width window returns the signature row and no data

`startday === endday` skips the `last_updated` filter entirely and answers with
the row "even if there isn't performance data" (`PerformanceSummary.list`). This
is how `fetchSignatureMeta` asks about a signature nobody is plotting.

- **Verified:** in use for the parent-threshold lookup; ~896 ms per signature,
  measured 2026-08-15 — which is why the batched signatures endpoint is what the
  card path uses instead.
- **Symptom if it stops:** parent thresholds resolve to null, so subtests fall
  back to the 2% default and their bars change.

## Alerts: `?id=` instead of the detail route

Two routes on one endpoint, and they are not equally fast:

| | URL | viewset action |
| --- | --- | --- |
| collection ("list") | `/performance/alertsummary/?…` | `list()` |
| detail | `/performance/alertsummary/<n>/` | `retrieve()` |

Neither carries measurements — that is `/performance/summary/`, a different
endpoint whose similar name is a standing hazard when reading either one.

`fetchAlertSummary` asks the *collection* route with `?id=<n>` for a reassignment
target and pulls the single row out of the page, even though the detail route
exists and is the obvious way to fetch one summary. The reason is speed — the
batched queries live only in `list()`, so the detail route does several
sequential queries per alert — and it means we depend on three things the detail
route wouldn't have needed.

### `id` is a real filter on the collection route

`PerformanceAlertSummaryFilter.id` is a `NumberFilter`, so `?id=50829` answers
with a page of exactly one.

- **Verified:** 2026-08-15 — `?id=50829` returns `count: 1`, and a nonexistent id
  returns `count: 0`. An *ignored* filter would have returned the whole
  framework's summaries in both cases, so those two results together are the
  proof, not just the first.
- **Symptom if the filter were dropped:** a 200 with an unfiltered page. Taking
  `results[0]` would then move an alert marker onto an unrelated push and print
  that summary's bug number beside it — a wrong answer that looks like a real
  verdict. **This is why the code matches by id instead of taking the first
  result**, which turns that case into the "no such summary" failure both callers
  already handle by leaving the marker where the analysis put it.
- **Re-verify:**
  `curl -s "$B/performance/alertsummary/?id=50829" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['count'], [r['id'] for r in d['results']])"`
  → `1 [50829]`.

### A missing summary is `200` with an empty page, not `404`

- **Verified:** 2026-08-15 — detail route: `404` and
  `{"detail": "No PerformanceAlertSummary matches the given query."}`; list
  route: `200` and `{"count": 0, …, "results": []}`.
- **Consequence:** `fetchJson`'s `HttpError` no longer covers "no such summary",
  so `fetchAlertSummary` raises its own. Without that throw, `results[0]` is
  `undefined` typed as an `AlertSummary` and the failure surfaces far from here.

### The two routes agree on every field we read

- **Verified:** 2026-08-15, on summary 50829 — identical values across all 27 own
  alerts and all 609 related alerts, for every field `AlertSummarySchema` and
  `AlertSchema` declare. `list()` returns slightly *more* (it fills in
  `profile_url` / `prev_profile_url`, which the detail route leaves null:
  701,885 bytes against 699,701). We read neither.
- **Known disagreements, in fields we don't read:** `taskcluster_metadata` on 9
  of 636 alerts and `prev_taskcluster_metadata` on 17. Both routes name a real
  task for the right (signature, push); they pick different retriggers because
  neither orders the query. Worth knowing before someone diffs the routes and
  concludes this change lost something.
- **Symptom if they diverge in a field we do read:** whatever that field drives —
  a marker's bug number, its status word — quietly differs from what perfherder's
  own alerts view shows for the same summary.

### The per-alert cost is treeherder's, and the fix is theirs

~30 ms per alert serialised, intercept roughly zero, so the detail route's
latency is set by how many alerts a sheriff happened to reassign onto one push:
2.7 s at 94 alerts, 18.9 s at 636.

- **If treeherder fixes it** (written up in the treeherder checkout as
  `proposal-alertsummary-detail-perf.md`), nothing here needs to change and the
  `?id=` route stays the right choice — `list()` is where the batching lives and
  where future batching will be added.

### `timerange` on the alerts endpoint counts back from *now*

Our range is absolute and may end in the past, so the request asks for a
superset and `alertsForSeries` drops summaries whose `push_id` isn't one we
plotted. See graphs.md, "Alerts".

## Response shapes we inferred rather than read

### List endpoints default to 10 rows, and truncate silently

A 300-push range asked without an explicit `count` returns 10 rows and a
`meta.count` of 10 — indistinguishable from a complete answer. `fetchPushRange`
asks for `MAX_RANGE_PUSHES + 1` and reports the overflow. This already made
treeherder's own `getCommonAlerts` quietly wrong over long ranges.

- **Rule:** any new *list* endpoint gets an explicit count and an overflow flag,
  not a trusting `results.length`.

### The signatures endpoint omits falsy fields to save bandwidth

`lower_is_better` appears only when false, `test`/`application`/`has_subtests`/
`parent_signature`/`extra_options`/`measurement_unit` only when truthy. So they
are optional-but-never-null, and a default of `true` for `lower_is_better` is
not a guess — it is the producer's meaning.

- **Verified:** 162,584 live rows across four repos; no other field was ever
  null or absent. `schema.test.ts` asserts the fixture still covers each field
  both present and absent.

### `replicates=true` emits one row per replicate value

All sharing a datum id, job id, push id and timestamp. The three-level hierarchy
in graphData.ts is rebuilt from that, and replicate *order* in the response is
not the sorted order we plot. See graphs.md, "Replicates".

### `job_id` is null once treeherder expires the job row

Perf data outlives jobs by design (~4 months). 153,301 of 412,451 sampled rows
over a year were null. A fixture written from the belief that it is a `number`
is how this got missed once already.

### `machine_name` is non-null exactly when `job_id` is

The datum carries the machine its job ran on, which is what the graph's machine
focus and `perfherder-cli machines` are built on. It is joined off the job row,
so it expires with it: **the two fields are null together, always.**

- **Verified 2026-08-20:** one signature over a year, 13,604 rows. All 6,825
  rows with a job had a machine; all 6,779 without one had neither. Probing a
  day at a time across the boundary put it between 2026-04-15 (neither) and
  2026-04-25 (both) — about four months back, matching the job retention window.
  `schema.test.ts` asserts the pairing row by row on the recorded fixture, not
  merely that both values occur.
- **Symptom if this stops holding:** a machine list that is missing workers, or
  an unattributed count that doesn't add up to the graph. Neither throws, and
  neither looks wrong on its own.
- The same deploy started populating `submit_time`, which had been null in every
  row previously sampled, from the same join.

**A machine focus therefore reaches back about four months however long the
range is.** That is not a bug to route around; `machines.ts` counts the
unattributed runs and the panel and the CLI both say so, because a census that
silently omitted them would read as complete.

### `tags` is a list on one endpoint and a space-separated string on the other

Same database column, two serializers. This is the standing argument for one
schema per *endpoint* rather than per table.

### Request lines over 4094 bytes are rejected before Django sees them

"Request Line is too large (6069 > 4094)". `MAX_IDS_PER_REQUEST = 150` in
activity.ts is derived from that ceiling, and both batched fetches — run
activity and signature identity — chunk on it.

## Perfherder semantics we mirror, and one we don't

### The alert status maps come from master, not a local checkout

`summaryStatusMap` / `alertStatusMap` in alerts.ts were taken from treeherder
master and cross-checked by loading one summary per status in the live alerts
view. A three-month-old checkout was already missing both "infra" statuses.
Unknown codes render as `status N` rather than being dropped.

- **Symptom:** a marker labelled `status 9` where a word belongs.

### Threshold inheritance from the parent is *our* rule

Perfherder goes straight from a null signature threshold to the global 2%; it
never reaches that line for these signatures, because a subtest whose
`should_alert` is null under a suite that sets one is never analysed at all
(`check_and_update_should_alert`). So there is no perfherder verdict to match
here — see graphs.md and comparison.md before changing it.

### Drawing a reassigned alert on its target push is a deliberate deviation

Treeherder's graph marks the detected push because `createGraphData` can't see
the target summary. We fetch it. See graphs.md, "Alerts".

## Debt this app is knowingly carrying

Not API assumptions, but the same category of thing: true today, quietly wrong
later.

- **`fetchOptionMap`'s memo never expires.** An option collection added
  mid-session is invisible until a reload. The picker's metadata cache has
  always behaved this way; the graphs view now shares it.
- **`AppState.signatureMetas` is never pruned.** Bounded by how many distinct
  signatures one session plots, at a dozen short strings each — the same call
  `parentThresholds` makes. A session that plotted thousands would notice.
- **A failed identity fetch is never retried.** The data response carries the
  same fields, so the cost is one card's head start. Changing the range does not
  retry it either, unlike a failed *data* fetch, which has an explicit Retry.
- **`AppState.alertTargets` is never pruned.** Reassignment target summaries are
  a few hundred kB each in the worst case observed, and the whole reason to keep
  them is that they are shared and wanted again after a range change. A session
  that visited many distinct broad regressions would accumulate them.
- **The per-signature alerts request is still 1.0–2.0 s each**, and it carries
  every *other* signature's alerts inside each summary: 590 kB to report one alert
  on 5825019, 0.18% of the payload. Now the floor on how fast a marker can appear,
  and not fixable on this side — every existing parameter selects which summaries
  come back rather than what is in one. It is a treeherder ask, written up in that
  checkout as `proposal-alertsummary-signature-payload.md` and tracked in
  graphs-todo.md.
- **The picker's `toSeries` and the graph's `metaFromSignature` project the same
  row differently on purpose** — the picker dedups options, the graph matches
  the server. Two projections of one endpoint's row is a real fork; the reason
  it is tolerable is that only one of them ever has to agree with a second
  endpoint.
