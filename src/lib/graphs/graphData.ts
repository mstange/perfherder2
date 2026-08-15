// Pure transforms from the performance/summary payload to the shape the
// graphs view draws and the details pane reads.
//
// The API hands back a flat list of rows; with replicates on, one row per
// replicate value (see docs/graphs.md). We rebuild the three-level hierarchy
// the UI talks about:
//
//   push ("build")  →  run ("job")  →  replicate
//
// and precompute the flat arrays the renderer wants, so drawing never has to
// walk a tree.

import { JITTER_GAP_FRACTION, jitterAt } from '../shared/chart';
import { parseApiDate, type RawSummary } from './graphApi';
// The one type this module borrows across the feature line: the signatures
// endpoint's row, which `metaFromSignature` projects into the same `SeriesMeta`
// the summary response produces. See docs/design.md, "Architecture".
import type { RawSignature } from '../picker/signaturesApi';

// One job's worth of values for one signature: a single performance datum
// plus its replicates.
export type Run = {
  datumId: number;
  // Null when treeherder has already expired the job — see RawDatum.job_id.
  // Everything else about the point (value, push, revision) survives.
  jobId: number | null;
  pushId: number;
  // Push timestamp in ms — the x coordinate shared by every replicate of this
  // run. We plot against push time, not job submit time, like treeherder.
  x: number;
  revision: string;
  // This run's replicate values, **sorted ascending**, which is not the order
  // the API sent them in.
  //
  // The summary endpoint returns a datum's replicate rows in a different order
  // on every request — measured: four fetches of one datum gave four different
  // orders of the same ten values. It has no ORDER BY over
  // `performancedatumreplicate`, and **trial ordering isn't implemented**: the
  // replicates/trials table does now carry run numbers and machine identifiers,
  // but nothing surfaces them through this endpoint, so there is no trial index
  // to sort by or to store. Bug 1981623 is the meta bug tracking putting them to
  // use (https://bugzilla.mozilla.org/show_bug.cgi?id=1981623).
  //
  // Until then, a `replicateIndex` into response order names a different value
  // every time the page loads, which is exactly what a URL must not do. Sorting
  // makes the index a stable function of the values, so
  // `sel=…,<datumId>,<replicateIndex>` means one thing. The cost is that the
  // index is a *rank* rather than a trial number — the UI says so — and once the
  // API exposes real trial numbers, indexing by those would be strictly better:
  // stable *and* meaningful, and it would let the pane show a run's values in
  // the order they were measured.
  values: number[];
  mean: number;
};

// All runs that belong to the same push. More than one means retriggers.
export type PushGroup = {
  pushId: number;
  revision: string;
  x: number;
  runs: Run[];
  // This series' one value for this build, and what the connecting line joins.
  // The mean of the runs' means, *not* of all their replicates pooled: a
  // retrigger is an independent sample of machine and run-to-run noise, so
  // each job should count once regardless of how many replicates it recorded.
  // (The two coincide whenever the retriggers ran the same number of
  // replicates, which is the normal case.)
  mean: number;
  // How far this push's dots may be jittered sideways, in x units (ms), as a
  // half-width: `JITTER_GAP_FRACTION` of the distance to whichever neighbouring
  // push is nearer. `Infinity` for a series with a single push, which has nothing
  // to collide with — the pixel ceiling then decides on its own.
  //
  // A property of the push and not of the graph, because CI landings come in
  // bursts: two pushes four minutes apart have room for almost nothing, and the
  // isolated one after a weekend has hours. See chart.ts, "Jitter".
  xRoom: number;
};

// A single plotted dot: one replicate of one run, or — in the `means` point
// set — a whole run at its mean.
export type SeriesPoint = {
  x: number;
  y: number;
  datumId: number;
  // Index into the run's `values`, or MEAN_REPLICATE for the run's mean.
  replicateIndex: number;
  // Horizontal jitter, in [-1, 1] — a *unit* offset, scaled at draw time by the
  // room below and by the zoom (chart.ts::jitterOffsetPx).
  //
  // Stored rather than hashed on demand because three code paths have to agree
  // on it exactly — the dots, the hit test, and the selection ring — and because
  // the alternative is a hash per point per frame in the one loop that runs
  // 100k times. `pointJitter` is where the number comes from.
  jitter: number;
  // Its push's `xRoom`, copied so the draw loop doesn't have to chase a map.
  xRoom: number;
};

// Stands in for "not one replicate, but the run's mean" everywhere a replicate
// index is expected: in a SeriesPoint, in the selection state, and in the URL's
// `sel` triple. Negative, so it can never collide with a real index.
export const MEAN_REPLICATE = -1;

// One way of plotting a series: the dots, plus their precomputed y extent.
// The extent is worth carrying because the y domain wants it on every range
// change and rescanning 20k points per series per change is wasteful.
export type PlotPoints = {
  // Sorted by x, which every consumer relies on for its binary searches.
  points: SeriesPoint[];
  minY: number;
  maxY: number;
};

export type SeriesData = {
  pushes: PushGroup[];
  // Flattened, sorted by x. One entry per run; the detail graph's connecting
  // line goes through these.
  runs: Run[];
  // Two ways to plot the same runs. `replicates` is one dot per replicate —
  // what the graphs draw by default, and the whole reason to fetch with
  // `replicates=true`. `means` is one dot per run, at the same y the
  // connecting line passes through, for when the replicate cloud is more
  // noise than signal, or is not wanted at all (see AppState.pointMode, whose
  // third answer draws neither set). Both are materialized at
  // build time rather than derived on demand: drawing and hit-testing want a
  // plain x-sorted array on every frame of a drag.
  replicates: PlotPoints;
  means: PlotPoints;
  runByDatumId: Map<number, Run>;
  pushById: Map<number, PushGroup>;
};

// Identity of a series as far as the app is concerned. Everything else about
// it is metadata we can re-derive from a fetch.
export type SeriesRef = {
  repository: string;
  signatureId: number;
  frameworkId: number;
};

// How big a change has to be before perfherder alerts on this signature, in the
// units perfherder states it in: `percentage` means `value` is a percentage (2
// for 2%), `absolute` means it is a delta in the metric's own units (102400 for
// 100 KB of installer). Which of the two it is is not cosmetic — a size metric
// stated in percent and a timing metric stated in bytes are both nonsense, and
// the two kinds differ by five orders of magnitude for the same signature.
//
// This is `PerformanceSignature.alert_threshold` and `alert_change_type`, and
// `changes.ts` scales it down rather than using it as-is — see THRESHOLD_FRACTION
// there.
export type AlertThreshold = {
  kind: 'percentage' | 'absolute';
  value: number;
};

// `settings.PERFHERDER_REGRESSION_THRESHOLD`, which is what perfherder's own
// alert generation falls back to for a signature that declares nothing —
// `treeherder/perf/alerts.py`, `generate_new_alerts_in_series`.
export const DEFAULT_ALERT_THRESHOLD: AlertThreshold = { kind: 'percentage', value: 2 };

// Display metadata for one series, from whichever of two endpoints has answered
// so far — the summary response that carries the data, or the much cheaper
// signatures row that lands about a second earlier. One shape for both, so a
// series restored from a bare URL looks identical to one the user just added, and
// so a card doesn't have two ways to describe itself. `source` says which
// answered, and it matters for exactly two fields; see `MetaSource`.
export type SeriesMeta = {
  suite: string;
  test: string;
  platform: string;
  application: string;
  measurementUnit: string;
  lowerIsBetter: boolean;
  // Server-composed "<suite> <test> <option_name> <extra_options>" string.
  name: string;
  // The options half of `name`, split back out — two series can be identical
  // in suite, test and platform and differ only here, so the legend needs it.
  options: string;
  // The signature whose subtest table this series appears in, which is what
  // perf.compare's subtests view is keyed by: its parent's id when it's a
  // subtest, its *own* id when it is itself a parent with subtests, and null
  // when it's a standalone signature with neither. Note this is an id, not a
  // hash — the summary endpoint's `parent_signature` differs from the signatures
  // endpoint's field of the same name in exactly that way.
  parentSignatureId: number | null;
  // This signature's own alerting threshold, or null when it declares none.
  // **Null is not "the default"** — a subtest almost never declares one and its
  // parent usually does, so null means "go and ask", which is `resolveAlertThreshold`
  // and the parent lookup in appState. Collapsing it to the default here would
  // quietly hand every build-metrics subtest a 2% floor on a metric that moves by
  // hundredths of a percent.
  alertThreshold: AlertThreshold | null;
  // Which of the three things we know produced this, because two of the fields
  // above cannot be answered by all of them. One field rather than a pair of
  // booleans: the states are exclusive, and a `placeholder` flag beside a
  // `fromSignature` flag would have four combinations for three facts.
  source: MetaSource;
};

// - `summary` — the `/performance/summary/` response that carries the data. The
//   complete answer, and the only one with `alertThreshold` and
//   `parentSignatureId`; assume this wherever a series' *data* is in hand.
// - `signature` — the batched `/performance/signatures/?id=…` response, which
//   arrives ~1s before the data and is what lets a card name itself early (see
//   `metaFromSignature`). **Its `alertThreshold` and `parentSignatureId` are
//   null because that endpoint does not serialize them, which is not the same
//   claim as "this signature declares none"** — the fields' own comments spell
//   out why that difference matters. Nothing may read either field off one of
//   these; everything that does is reached only once the data has landed, and
//   `metaTest` in graphData.test.ts pins that.
// - `none` — the stand-in we synthesize when a signature has no data in the
//   range *and* no signature row came back: every field is empty or made up.
//   Code that *displays* the fields can ignore this; code that would act on them
//   (the shared-attribute header, the picker prefill) has to skip these or it
//   will filter on a fabricated suite name. `isPlaceholder` is the check.
export type MetaSource = 'summary' | 'signature' | 'none';

// Whether this metadata is the synthesized stand-in rather than something an
// endpoint said. Named for what callers care about, so the three-valued field
// doesn't turn into `=== 'none'` comparisons spread over the app.
export function isPlaceholder(meta: SeriesMeta): boolean {
  return meta.source === 'none';
}

export function seriesKey(ref: SeriesRef): string {
  return `${ref.repository}|${ref.signatureId}`;
}

export function metaFromSummary(summary: RawSummary): SeriesMeta {
  const suite = summary.suite ?? '';
  // The API repeats the suite in `test` for non-subtest signatures; that
  // would render as "ts_paint · ts_paint" everywhere.
  const test = summary.test && summary.test !== summary.suite ? summary.test : '';
  return {
    suite,
    test,
    platform: summary.platform ?? '',
    application: summary.application ?? '',
    measurementUnit: summary.measurement_unit ?? '',
    lowerIsBetter: summary.lower_is_better !== false,
    name: summary.name ?? '',
    options: optionsFromName(summary.name ?? '', suite, test),
    parentSignatureId:
      summary.parent_signature ?? (summary.has_subtests ? summary.signature_id : null),
    alertThreshold: alertThresholdFromSummary(summary),
    source: 'summary',
  };
}

// The same metadata from the *signatures* endpoint's row, which the graph fetches
// for every plotted series in one request per repository before their data
// arrives (`AppState.loadSignatureMetas`). One request, ~160 ms, against 1.3 s
// for a 90-day data response — so this is what a card's name, platform and
// options are drawn from while its dots are still downloading.
//
// **The two endpoints must agree field for field, or the card would rewrite
// itself when the data landed.** Everything here was checked against production:
// 12 signatures spanning subtests, `test === suite`, and duplicated options, and
// every displayed field plus the composed `name` matched exactly. graphData.test.ts
// pins the same equality against a recorded pair of responses.
//
// Two of them take care:
//
//   `name` is composed here, because only the summary serializer builds it —
//     and it is composed as *that serializer's own format string*, spaces and
//     all, so `options` can then be recovered with the same `optionsFromName`
//     the summary path uses instead of a second parallel rule. It is
//     deliberately not tidied: the server's `"{} {} {}".format(...)` leaves a
//     trailing space when a signature has no extra options
//     ("BenchSign_RSA2048 64_verify opt "), and it does not deduplicate, so 204
//     of autoland's 31,547 signatures legitimately read "installer size asan
//     asan opt". Both were checked against production. Matching the server byte
//     for byte is the point; the picker is free to be tidier (`toSeries` dedups)
//     because nothing swaps its rows out from under it.
//   `parentSignatureId` can only be filled for a *parent*, whose own id it is.
//     This endpoint reports a subtest's parent as a signature *hash*, and
//     resolving that to an id would be another request for a field nothing reads
//     until the data (which carries it) has arrived.
//
// One known divergence, and it is unreachable today: for an option collection
// holding more than one option this joins them ("debug memleak") while the
// summary endpoint emits just one of them, because the map it builds is keyed by
// collection id and a multi-option collection has one row per option, so the
// dict comprehension keeps the last. Production has exactly one such collection
// and **zero of the 76,025 signatures across autoland and mozilla-central use
// it**. If that ever changes, the symptom is a card whose options are rewritten
// when its data lands, not a wrong answer.
export function metaFromSignature(
  id: number,
  raw: RawSignature,
  optionMap: ReadonlyMap<string, string[]>,
): SeriesMeta {
  const suite = raw.suite ?? '';
  // Same rule as `metaFromSummary`, and the same reason: 58 of autoland's rows
  // repeat the suite in `test`, and "ts_paint · ts_paint" is not a label.
  const test = raw.test && raw.test !== suite ? raw.test : '';
  const testSuite = test ? `${suite} ${test}` : suite;
  const optionName = (optionMap.get(raw.option_collection_hash) ?? []).join(' ');
  const extraOptions = (raw.extra_options ?? []).join(' ');
  const name = `${testSuite} ${optionName} ${extraOptions}`;
  return {
    suite,
    test,
    platform: raw.machine_platform,
    application: raw.application ?? '',
    measurementUnit: raw.measurement_unit ?? '',
    // Emitted only when false — the producer treats true as the default.
    lowerIsBetter: raw.lower_is_better !== false,
    name,
    options: optionsFromName(name, suite, test),
    parentSignatureId: raw.parent_signature ? null : raw.has_subtests ? id : null,
    alertThreshold: null,
    source: 'signature',
  };
}

// The signature's alerting policy, or null if it has none of its own.
//
// **The threshold decides which kind is in force, not the change type.** A
// signature that names a change type without a threshold is declaring nothing —
// there is no number to compare against — while a threshold with a null change
// type is perfherder's ALERT_PCT default, which is why the type is read second
// and defaults to percentage. Getting that order the other way round would read
// `alert_change_type: 1` with no threshold as "absolute, 0 bytes" and pass
// everything.
export function alertThresholdFromSummary(summary: RawSummary): AlertThreshold | null {
  const value = summary.alert_threshold;
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  // 1 is `PerformanceSignature.ALERT_ABS`; 0 and null are ALERT_PCT.
  return { kind: summary.alert_change_type === 1 ? 'absolute' : 'percentage', value };
}

// Which threshold a series is actually held to: its own if it declares one, its
// parent's if it doesn't, and perfherder's global default if neither does.
//
// **Inheriting from the parent is this app's rule, not perfherder's.** Perfherder
// goes straight from a null signature threshold to the global 2%, but it never
// reaches that line for these signatures: a subtest whose `should_alert` is null
// under a suite that sets one is treated as false and never analysed at all
// (`check_and_update_should_alert` in performance_data.py), so there is no
// perfherder verdict here to match, only a gap to fill — which is the same gap
// the whole feature exists for. The parent's threshold is the best available
// statement of what counts as a real move in this metric: same suite, same units,
// and for the absolute case the same number, since 100 KB of growth in xul.dll is
// 100 KB of growth in the installer that contains it.
export function resolveAlertThreshold(
  own: AlertThreshold | null,
  inherited: AlertThreshold | null,
): AlertThreshold {
  return own ?? inherited ?? DEFAULT_ALERT_THRESHOLD;
}

// The signature to inherit a threshold from, or null when there is nobody to ask:
// a standalone signature, or a parent — `parentSignatureId` reports a parent's own
// id, and a signature is not its own parent.
export function thresholdParentRef(ref: SeriesRef, meta: SeriesMeta): SeriesRef | null {
  const parent = meta.parentSignatureId;
  if (parent === null || parent === ref.signatureId) return null;
  return { ...ref, signatureId: parent };
}

// What we know about a signature the summary endpoint said nothing about: its
// id, and that we don't know anything else.
export function placeholderMeta(ref: SeriesRef): SeriesMeta {
  return {
    suite: `signature ${ref.signatureId}`,
    test: '',
    platform: '',
    application: '',
    measurementUnit: '',
    lowerIsBetter: true,
    name: '',
    options: '',
    parentSignatureId: null,
    alertThreshold: null,
    source: 'none',
  };
}

// The serializer builds `name` as "<test_suite> <option_name> <extra_options>"
// where test_suite is the suite, or "<suite> <test>" when the test differs
// (see PerformanceSummarySerializer.get_name). There is no separate options
// field on the response, so we recover them by stripping the known prefix.
export function optionsFromName(name: string, suite: string, test: string): string {
  const prefix = test ? `${suite} ${test}` : suite;
  return name.startsWith(prefix) ? name.slice(prefix.length).trim() : '';
}

// Short label for the legend and the details pane.
export function seriesLabel(meta: SeriesMeta): string {
  return meta.test ? `${meta.suite} · ${meta.test}` : meta.suite;
}

// Shared by every series that has no data. Nothing may mutate it — the
// collections inside are handed out to callers as if they were that series'
// own. Everything that builds real data allocates fresh containers.
export const EMPTY_SERIES_DATA: SeriesData = {
  pushes: [],
  runs: [],
  replicates: { points: [], minY: 0, maxY: 0 },
  means: { points: [], minY: 0, maxY: 0 },
  runByDatumId: new Map(),
  pushById: new Map(),
};

// One dot's share of the horizontal jitter, in [-1, 1]. `dotsAtX` is how many
// dots of this series land on the same push in the point set being built.
//
// Zero when there's only one, and that exemption is the point of taking the
// count at all: a lone dot nudged off its push time would sit beside the
// connecting line's vertex for no gain, and — since x means *time* here, not a
// category — reads as measurement noise in a quantity that has none. So a series
// drawn as one mean per un-retriggered push keeps its dots exactly on the line,
// and only the clouds that genuinely overlap get spread.
export function pointJitter(dotsAtX: number, datumId: number, replicateIndex: number): number {
  return dotsAtX > 1 ? jitterAt(datumId, replicateIndex) : 0;
}

// The same number for callers that hold a push rather than a `SeriesPoint`: the
// graph's selection ring, which resolves a URL triple against `pushById` and
// never touches the point arrays. `buildSeriesData` computes it inline with the
// count hoisted out of its loops; graphData.test.ts pins that the two agree,
// because a disagreement would draw the ring beside the dot it names.
export function jitterForSelection(
  push: PushGroup,
  datumId: number,
  replicateIndex: number,
): number {
  let dots = 0;
  if (replicateIndex === MEAN_REPLICATE) dots = push.runs.length;
  else for (const run of push.runs) dots += run.values.length;
  return pointJitter(dots, datumId, replicateIndex);
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function buildSeriesData(summary: RawSummary | null): SeriesData {
  if (!summary || !summary.data || summary.data.length === 0) {
    return EMPTY_SERIES_DATA;
  }

  // Rows for one datum arrive contiguously (the backend orders by
  // push_timestamp, push_id, job_id), but we group through a map anyway so a
  // change in server-side ordering can't silently split a run in two.
  const runByDatumId = new Map<number, Run>();
  for (const row of summary.data) {
    if (row.value === null || row.value === undefined || !Number.isFinite(row.value)) {
      continue;
    }
    let run = runByDatumId.get(row.id);
    if (!run) {
      run = {
        datumId: row.id,
        jobId: row.job_id,
        pushId: row.push_id,
        x: parseApiDate(row.push_timestamp),
        revision: row.revision,
        values: [],
        mean: 0,
      };
      runByDatumId.set(row.id, run);
    }
    run.values.push(row.value);
  }

  const runs = [...runByDatumId.values()];
  for (const run of runs) {
    // Ascending, and this is load-bearing rather than cosmetic. See
    // `Run.values`: trial ordering isn't implemented on the API side (bug
    // 1981623), so the endpoint returns a datum's replicate rows in a
    // *different order on every request*, and a positional index into response
    // order names a different value each time the page is loaded. Sorting makes
    // the index a stable function of the values themselves, which is what a
    // `sel=` link in the URL needs it to be.
    run.values.sort((a, b) => a - b);
    // Order-independent either way, but it has to come after the sort to keep
    // this loop's reading order honest.
    run.mean = mean(run.values);
  }
  // `jobId` is only a tiebreaker for retriggers of one push; expired jobs sort
  // as 0, which keeps the comparator total instead of returning NaN.
  runs.sort((a, b) => a.x - b.x || a.pushId - b.pushId || (a.jobId ?? 0) - (b.jobId ?? 0));

  const pushById = new Map<number, PushGroup>();
  const pushes: PushGroup[] = [];
  for (const run of runs) {
    let push = pushById.get(run.pushId);
    if (!push) {
      push = {
        pushId: run.pushId,
        revision: run.revision,
        x: run.x,
        runs: [],
        mean: 0,
        xRoom: Infinity,
      };
      pushById.set(run.pushId, push);
      pushes.push(push);
    }
    push.runs.push(run);
  }
  for (let i = 0; i < pushes.length; i++) {
    const push = pushes[i];
    push.mean = mean(push.runs.map((r) => r.mean));
    // The nearer neighbour decides, so two clouds can never meet: each keeps to
    // `JITTER_GAP_FRACTION` of the distance between them. A push at either end of
    // the series has one neighbour and takes its distance from that one alone.
    const prev = i > 0 ? push.x - pushes[i - 1].x : Infinity;
    const next = i + 1 < pushes.length ? pushes[i + 1].x - push.x : Infinity;
    push.xRoom = Math.min(prev, next) * JITTER_GAP_FRACTION;
  }

  const points: SeriesPoint[] = [];
  const meanPoints: SeriesPoint[] = [];
  let minY = Infinity;
  let maxY = -Infinity;
  let meanMinY = Infinity;
  let meanMaxY = -Infinity;

  // Emitted push by push rather than run by run, because a dot's jitter depends
  // on how many *other* dots share its push — a fact that isn't known until the
  // push's runs are all in. Both arrays come out x-sorted regardless: every run
  // of a push shares that push's timestamp, and `pushes` was built in the run
  // order, which is already sorted by x.
  for (const push of pushes) {
    let replicateDots = 0;
    for (const run of push.runs) replicateDots += run.values.length;

    for (const run of push.runs) {
      for (let i = 0; i < run.values.length; i++) {
        const y = run.values[i];
        points.push({
          x: run.x,
          y,
          datumId: run.datumId,
          replicateIndex: i,
          jitter: pointJitter(replicateDots, run.datumId, i),
          xRoom: push.xRoom,
        });
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }

      meanPoints.push({
        x: run.x,
        y: run.mean,
        datumId: run.datumId,
        replicateIndex: MEAN_REPLICATE,
        // One mean dot per run, so the count that matters here is the number of
        // retriggers — an un-retriggered push gets no jitter in this point set
        // even when its replicates are spread out in the other one.
        jitter: pointJitter(push.runs.length, run.datumId, MEAN_REPLICATE),
        xRoom: push.xRoom,
      });
      if (run.mean < meanMinY) meanMinY = run.mean;
      if (run.mean > meanMaxY) meanMaxY = run.mean;
    }
  }

  if (points.length === 0) return EMPTY_SERIES_DATA;

  return {
    pushes,
    runs,
    replicates: { points, minY, maxY },
    means: { points: meanPoints, minY: meanMinY, maxY: meanMaxY },
    runByDatumId,
    pushById,
  };
}

// ---------------------------------------------------------------------------
// Value pools
// ---------------------------------------------------------------------------
//
// What the details pane's distribution chart describes. Kept here rather than in
// distribution.ts because the pooling rule is a fact about the push/run/
// replicate structure, and this module owns that structure; compare.ts decides
// *which* pool each side of a comparison gets.

// Every replicate value this series recorded on one push, in run order —
// retriggers pooled, since each is an independent sample of the same build.
//
// Deliberately not filtered by `pointMode`: that setting decides which dots
// get drawn (see docs/graphs.md), and collapsing to one mean per run would leave
// a four-value distribution where sixty measurements exist.
export function pushValues(push: PushGroup): number[] {
  const out: number[] = [];
  for (const run of push.runs) out.push(...run.values);
  return out;
}

// Where one (run, replicate) pair lands in `pushValues(push)`, so the strip can
// ring the dot the user actually clicked.
//
// Returns -1 for a MEAN_REPLICATE selection: a run's mean is not one of the
// pool's values, so there is no dot of it to ring. (The pane says which value it
// is describing regardless.)
export function indexInPushValues(
  push: PushGroup,
  datumId: number,
  replicateIndex: number,
): number {
  if (replicateIndex === MEAN_REPLICATE) return -1;
  let offset = 0;
  for (const run of push.runs) {
    if (run.datumId === datumId) {
      return replicateIndex >= 0 && replicateIndex < run.values.length
        ? offset + replicateIndex
        : -1;
    }
    offset += run.values.length;
  }
  return -1;
}

// Where one run's values sit in `pushValues(push)`, as a half-open range.
//
// A range rather than a set of indices because the pool is a concatenation in
// run order, so a run's contribution to it is always contiguous — which is what
// lets the strip shade "the run you clicked" with two numbers.
//
// Null for a datum that isn't in this push, and for a run that recorded nothing.
export function runRangeInPushValues(
  push: PushGroup,
  datumId: number,
): { start: number; end: number } | null {
  let offset = 0;
  for (const run of push.runs) {
    if (run.datumId === datumId) {
      return run.values.length > 0 ? { start: offset, end: offset + run.values.length } : null;
    }
    offset += run.values.length;
  }
  return null;
}

// Every value the push recorded, grouped by the job that produced it — what the
// details pane lists under the push distribution.
//
// Grouped rather than pooled, and over the whole push rather than the selected
// run, for the same reason `pushValues` pools the whole push: the interesting
// question about a retriggered build is whether its runs agree, and a flat list
// of fifteen numbers can't answer that. The pane used to list the selected run's
// values only, which made a push that recorded fifteen look like it recorded
// five and left the other runs' values reachable only by finding their dots.
export type ReplicateGroup = {
  run: Run;
  // 1-based position among the push's runs, which is the only name a run always
  // has: `jobId` is null for anything past treeherder's job retention window
  // (see `Run.jobId`), so "run 2 of 3" is what the label falls back to.
  ordinal: number;
  // Index into `run.values` of the selected replicate, or null when the
  // selection is elsewhere — another run of this push, or this run's mean.
  selectedIndex: number | null;
  // True for the run the selection belongs to, mean selections included. That's
  // a weaker statement than `selectedIndex !== null`, and the difference is
  // exactly the mean case.
  selectedRun: boolean;
};

export function replicateGroups(
  push: PushGroup,
  datumId: number,
  replicateIndex: number,
): ReplicateGroup[] {
  return push.runs.map((run, i) => {
    const selectedRun = run.datumId === datumId;
    return {
      run,
      ordinal: i + 1,
      selectedIndex:
        selectedRun && replicateIndex >= 0 && replicateIndex < run.values.length
          ? replicateIndex
          : null,
      selectedRun,
    };
  });
}

// Resolve a URL-level selection triple against loaded data. Returns null when
// the point isn't present — the range may have been narrowed since the link
// was made, and a phantom selection is worse than none.
export type ResolvedPoint = {
  run: Run;
  push: PushGroup;
  replicateIndex: number;
  value: number;
};

export function resolvePoint(
  data: SeriesData,
  datumId: number,
  replicateIndex: number,
): ResolvedPoint | null {
  const run = data.runByDatumId.get(datumId);
  if (!run) return null;
  const push = data.pushById.get(run.pushId);
  if (!push) return null;
  // A mean selection stays a mean selection even with replicates drawn, so
  // toggling them on doesn't silently reinterpret the link you followed.
  if (replicateIndex === MEAN_REPLICATE) {
    return { run, push, replicateIndex: MEAN_REPLICATE, value: run.mean };
  }
  const idx = replicateIndex >= 0 && replicateIndex < run.values.length ? replicateIndex : 0;
  return { run, push, replicateIndex: idx, value: run.values[idx] };
}
