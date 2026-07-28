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
  jobId: number;
  pushId: number;
  // Push timestamp in ms — the x coordinate shared by every replicate of this
  // run. We plot against push time, not job submit time, like treeherder.
  x: number;
  revision: string;
  values: number[];
  mean: number;
};

// All runs that belong to the same push. More than one means retriggers.
export type PushGroup = {
  pushId: number;
  revision: string;
  x: number;
  runs: Run[];
};

// A single plotted dot: one replicate of one run.
export type SeriesPoint = {
  x: number;
  y: number;
  datumId: number;
  replicateIndex: number;
};

export type SeriesData = {
  pushes: PushGroup[];
  // Flattened, sorted by x. One entry per run; the detail graph's connecting
  // line goes through these.
  runs: Run[];
  // Flattened, sorted by x. One entry per replicate; these are the dots.
  points: SeriesPoint[];
  minY: number;
  maxY: number;
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
  points: [],
  minY: 0,
  maxY: 0,
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
  for (const run of runs) run.mean = mean(run.values);
  runs.sort((a, b) => a.x - b.x || a.pushId - b.pushId || a.jobId - b.jobId);

  const pushById = new Map<number, PushGroup>();
  const pushes: PushGroup[] = [];
  const points: SeriesPoint[] = [];
  let minY = Infinity;
  let maxY = -Infinity;

  for (const run of runs) {
    let push = pushById.get(run.pushId);
    if (!push) {
      push = { pushId: run.pushId, revision: run.revision, x: run.x, runs: [] };
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
  }

  if (points.length === 0) return EMPTY_SERIES_DATA;

  return { pushes, runs, points, minY, maxY, runByDatumId, pushById };
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
  const idx = replicateIndex >= 0 && replicateIndex < run.values.length ? replicateIndex : 0;
  return { run, push, replicateIndex: idx, value: run.values[idx] };
}
