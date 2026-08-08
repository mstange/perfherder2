// Which of a task run's artifacts are Firefox Profiler profiles, what to call
// them, and where their links go.
//
// The rule is treeherder's, from `ui/shared/JobArtifacts.jsx`: an artifact
// whose *file name* starts with `profile_` is a profile, and its primary link
// goes through profiler.firefox.com's `/from-url/` loader instead of to the
// file. Kept in step with treeherder deliberately — the same job opened from
// either app should land on the same profile with the same title.
//
// The same rule, run over two task runs at once, is what decides whether a
// pinned comparison can offer a *profile* comparison — see `benchmarkComparison`
// at the bottom of this file and docs/comparison.md, "Profile comparison".
//
// Pure: the artifact names come from artifactsApi.ts, the URL shapes from
// shared/links.ts. See docs/graphs.md, "Profiles".

import { benchmarkComparisonUrl, profilerFromUrl, taskArtifactUrl } from '../shared/links';

const PROFILE_PREFIX = 'profile_';

// Stripped in this order, because a compressed profile wears both: a
// `profile_foo.json.gz` is a gzipped JSON profile, not a file of type ".gz".
const COMPRESSION_SUFFIX = '.gz';
const CONTAINER_SUFFIXES = ['.json', '.zip'];

// The two names a *resource usage* profile goes by — CPU, memory and IO over
// the run, synthesised from mozharness' log rather than sampled by Gecko.
// Treeherder's `isResourceUsageProfile`, same list.
const RESOURCE_USAGE_NAMES = ['profile_build_resources.json', 'profile_resource-usage.json'];

// Everything a link needs about the job. Narrower than `Job` so this module can
// be tested without one, and so the two fields that make the URL — which are
// `v.optional` on the job, absent together for a job with no taskcluster
// metadata — are required by the time they get here.
export type ProfileJob = {
  job_type_name: string;
  task_id: string;
  retry_id: number;
};

export type ProfileLink = {
  // The full artifact name, e.g. "public/test_info/profile_resource-usage.json".
  // Unique within a run, so it doubles as the list key.
  artifact: string;
  // What the link says: the part of the name that varies. See `profileLabel`.
  label: string;
  // profiler.firefox.com, loading this artifact.
  url: string;
};

// "public/test_info/profile_resource-usage.json" -> "profile_resource-usage.json".
function fileName(artifact: string): string {
  return artifact.slice(artifact.lastIndexOf('/') + 1);
}

export function isProfileArtifact(artifact: string): boolean {
  return fileName(artifact).startsWith(PROFILE_PREFIX);
}

export function isResourceUsageProfile(artifact: string): boolean {
  return RESOURCE_USAGE_NAMES.includes(fileName(artifact));
}

// "public/test_info/profile_idb-open-many-seq.zip" -> "idb-open-many-seq".
//
// The prefix and the container format are the same on every one of these — the
// prefix is *why* it's in the list, and whether a profile arrives zipped or as
// JSON is the harness' business, not the reader's — so neither says which
// profile this is. What's left does, and it fits the pane's narrow column.
//
// Falls back to the file name if stripping would leave nothing, so a
// hypothetical `profile_.json` still renders as something clickable.
export function profileLabel(artifact: string): string {
  const name = fileName(artifact);
  let label = name.startsWith(PROFILE_PREFIX) ? name.slice(PROFILE_PREFIX.length) : name;
  if (label.endsWith(COMPRESSION_SUFFIX)) {
    label = label.slice(0, -COMPRESSION_SUFFIX.length);
  }
  for (const suffix of CONTAINER_SUFFIXES) {
    if (label.endsWith(suffix)) {
      label = label.slice(0, -suffix.length);
      break;
    }
  }
  return label || name;
}

// The profiles of one task run, in the order the pane lists them.
//
// Gecko profiles first, resource usage last. Nearly every perf job uploads a
// resource-usage profile and only a gecko-profiling one uploads the other, so
// sorting by name alone would bury the profile someone came looking for under
// the one they get for free.
export function profileLinks(artifactNames: string[], job: ProfileJob): ProfileLink[] {
  return artifactNames
    .filter(isProfileArtifact)
    .sort((a, b) => {
      const rank = Number(isResourceUsageProfile(a)) - Number(isResourceUsageProfile(b));
      return rank !== 0 ? rank : profileLabel(a).localeCompare(profileLabel(b));
    })
    .map((artifact) => ({
      artifact,
      label: profileLabel(artifact),
      url: profilerFromUrl(
        taskArtifactUrl(job.task_id, job.retry_id, artifact),
        // A resource usage profile carries no name of its own — nothing
        // recorded it, it was assembled from a log — so the profiler would
        // title the tab after the URL. Treeherder passes the job's name for
        // exactly these two; we pass the same string, so the tab reads the same
        // whichever app opened it.
        isResourceUsageProfile(artifact)
          ? `${job.job_type_name} (${job.task_id}.${job.retry_id})`
          : undefined,
      ),
    }));
}

// ---------------------------------------------------------------------------
// Benchmark profile comparison
// ---------------------------------------------------------------------------

// A raptor benchmark task post-processes its raw profile into three uploads, and
// this is the suffix of the one the profiler's comparison view is built for:
// label frames inserted, and each process' main thread merged into a single
// track. The other two — `_all_processes` and `_raw_all_processes` — are the run
// kept whole, which is what you want when *reading* one profile and not what
// lines up against a second run.
//
// Producer: `profile_configs` in `testing/raptor/raptor/raptor_profiling.py`,
// which names every upload `profile_<test name>_<suffix>.jslb.gz`.
const COMPACT_PROFILE_SUFFIX = '_compact.jslb.gz';

// "public/test_info/profile_speedometer3_compact.jslb.gz" -> "speedometer3".
// Null for every other artifact, so this doubles as the test for "is this the
// comparable profile".
//
// A suffix rule rather than a list of benchmarks: the name is composed from the
// raptor test's own name, so anything that turns profiling on gets one, and an
// allowlist here would silently withhold the feature from the next benchmark to
// do so. What the rule *does* pin down is that both sides carry the same
// benchmark's profile — see `benchmarkComparison`.
export function compactBenchmarkName(artifact: string): string | null {
  const name = fileName(artifact);
  if (!name.startsWith(PROFILE_PREFIX) || !name.endsWith(COMPACT_PROFILE_SUFFIX)) return null;
  const benchmark = name.slice(PROFILE_PREFIX.length, -COMPACT_PROFILE_SUFFIX.length);
  return benchmark || null;
}

// One side of a profile comparison: which task run it is, and what that run
// uploaded.
export type ProfileTaskRun = {
  taskId: string;
  runId: number;
  artifactNames: string[];
};

export type BenchmarkComparison = {
  // The artifact name, identical on both sides.
  artifact: string;
  // Its benchmark, for saying which profiles the link opens.
  benchmark: string;
  url: string;
};

// The profiler's benchmark comparison between two task runs, or null when there
// isn't one to offer.
//
// **Both sides have to carry the same artifact name.** That is the whole
// eligibility rule, and it is stricter than "each side has a compact profile" on
// purpose: the name carries the benchmark, and a speedometer3 profile compared
// against a jetstream3 one is two unrelated sample sets in a view whose entire
// output is the difference between them. It falls out of the same rule that two
// counterparts of one test on different platforms — the comparison this is
// mostly used for — match without anything having to say so.
//
// Null for two points in the *same* run as well: the two sides would be one
// profile compared against itself, which is a table of zeroes. A `replicate`
// comparison is exactly that case, and so is any pair of replicates of one job.
export function benchmarkComparison(
  base: ProfileTaskRun,
  next: ProfileTaskRun,
): BenchmarkComparison | null {
  if (base.taskId === next.taskId && base.runId === next.runId) return null;
  const shared = new Set(next.artifactNames);
  // Sorted so a task that somehow uploaded two comparable profiles picks the
  // same one on every render rather than following artifact-list order.
  const artifact = base.artifactNames
    .filter((name) => compactBenchmarkName(name) !== null && shared.has(name))
    .sort()[0];
  if (artifact === undefined) return null;
  return {
    artifact,
    // Non-null by construction: `artifact` passed the filter above.
    benchmark: compactBenchmarkName(artifact) as string,
    url: benchmarkComparisonUrl(
      profilerFromUrl(taskArtifactUrl(base.taskId, base.runId, artifact)),
      profilerFromUrl(taskArtifactUrl(next.taskId, next.runId, artifact)),
    ),
  };
}
