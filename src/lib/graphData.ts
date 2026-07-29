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

import { parseApiDate, type RawSummary } from './graphApi';

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
  // orders of the same ten values. (It has no ORDER BY over
  // `performancedatumreplicate`, and gives us no replicate id or iteration
  // number to recover the real order from.) A `replicateIndex` into response
  // order therefore names a different value every time the page loads, which is
  // exactly what a URL must not do.
  //
  // Sorting is what makes the index a stable function of the values, so
  // `sel=…,<datumId>,<replicateIndex>` means one thing. The cost is that the
  // index is a *rank*, not an iteration number — the UI says so — and iteration
  // order is not recoverable anyway.
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
};

// A single plotted dot: one replicate of one run, or — in the `means` point
// set — a whole run at its mean.
export type SeriesPoint = {
  x: number;
  y: number;
  datumId: number;
  // Index into the run's `values`, or MEAN_REPLICATE for the run's mean.
  replicateIndex: number;
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
  // noise than signal (see AppState.showReplicates). Both are materialized at
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

// Display metadata, taken from the summary response rather than the picker's
// signature row, so a series restored from a bare URL looks identical to one
// the user just added.
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
  // True for the stand-in we synthesize when a signature has no data in the
  // range: the endpoint returns nothing at all in that case, so there is no
  // metadata and every field above is either empty or made up. Code that
  // *displays* the fields can ignore this; code that would act on them (the
  // series list's shared-attribute header, the picker prefill) has to skip
  // these entries or it will filter on a fabricated suite name.
  placeholder: boolean;
};

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
    placeholder: false,
  };
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
    placeholder: true,
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
    // `Run.values`: the endpoint returns a datum's replicate rows in a
    // *different order on every request*, so a positional index into response
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
  const points: SeriesPoint[] = [];
  const meanPoints: SeriesPoint[] = [];
  let minY = Infinity;
  let maxY = -Infinity;
  let meanMinY = Infinity;
  let meanMaxY = -Infinity;

  for (const run of runs) {
    let push = pushById.get(run.pushId);
    if (!push) {
      push = { pushId: run.pushId, revision: run.revision, x: run.x, runs: [], mean: 0 };
      pushById.set(run.pushId, push);
      pushes.push(push);
    }
    push.runs.push(run);

    for (let i = 0; i < run.values.length; i++) {
      const y = run.values[i];
      points.push({ x: run.x, y, datumId: run.datumId, replicateIndex: i });
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    meanPoints.push({
      x: run.x,
      y: run.mean,
      datumId: run.datumId,
      replicateIndex: MEAN_REPLICATE,
    });
    if (run.mean < meanMinY) meanMinY = run.mean;
    if (run.mean > meanMaxY) meanMaxY = run.mean;
  }

  if (points.length === 0) return EMPTY_SERIES_DATA;

  for (const push of pushes) push.mean = mean(push.runs.map((r) => r.mean));

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
// Deliberately not filtered by `showReplicates`: that flag decides which dots
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
