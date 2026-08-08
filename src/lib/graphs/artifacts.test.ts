import { describe, expect, it } from 'vitest';
import {
  benchmarkComparison,
  compactBenchmarkName,
  isProfileArtifact,
  isResourceUsageProfile,
  profileLabel,
  profileLinks,
  type ProfileJob,
  type ProfileTaskRun,
} from './artifacts';
import { PROFILER_ORIGIN } from '../shared/links';

// The task behind the browsertime example in docs/graphs.md: two profiles among
// a dozen artifacts, one gecko and one resource usage.
const ARTIFACTS = [
  'perftest/mitmproxy.log',
  'public/build/perfherder-data-mozharness-actions.json',
  'public/logs/live_backing.log',
  'public/test_info/browsertime-profiler.tgz',
  'public/test_info/perfherder-data.json',
  'public/test_info/profile_idb-open-many-seq.zip',
  'public/test_info/profile_resource-usage.json',
];

const job: ProfileJob = {
  job_type_name: 'test-macosx1470-64-shippable/opt-browsertime-indexeddb-firefox-idb-open-many-seq',
  task_id: 'fUUrXaqGTdySnnMCzFHhFw',
  retry_id: 0,
};

describe('isProfileArtifact', () => {
  it('matches on the file name, not the path', () => {
    expect(isProfileArtifact('public/test_info/profile_resource-usage.json')).toBe(true);
    // The prefix has to be on the file, or every artifact under a directory
    // that happens to be called `profile_…` would come along.
    expect(isProfileArtifact('profile_dir/browsertime.log')).toBe(false);
  });

  // `browsertime-profiler.tgz` is right next to the real profiles in every
  // browsertime task and is not one — treeherder's rule is a prefix, not a
  // substring, and this is the artifact that makes the difference visible.
  it('does not match an artifact that merely mentions profiling', () => {
    expect(isProfileArtifact('public/test_info/browsertime-profiler.tgz')).toBe(false);
  });
});

describe('isResourceUsageProfile', () => {
  it('knows the two synthesised profiles', () => {
    expect(isResourceUsageProfile('public/test_info/profile_resource-usage.json')).toBe(true);
    expect(isResourceUsageProfile('public/build/profile_build_resources.json')).toBe(true);
  });

  it('treats anything else as a real profile', () => {
    expect(isResourceUsageProfile('public/test_info/profile_idb-open-many-seq.zip')).toBe(false);
  });
});

describe('profileLabel', () => {
  it('drops the path, the prefix and the container format', () => {
    expect(profileLabel('public/test_info/profile_idb-open-many-seq.zip')).toBe(
      'idb-open-many-seq',
    );
    expect(profileLabel('public/test_info/profile_resource-usage.json')).toBe('resource-usage');
  });

  it('drops the compression suffix and the format under it', () => {
    expect(profileLabel('profile_editor-tiptap-16.json.gz')).toBe('editor-tiptap-16');
  });

  it('keeps dots that are part of the name', () => {
    expect(profileLabel('profile_speedometer-3.1.zip')).toBe('speedometer-3.1');
  });

  it('falls back to the file name rather than rendering nothing', () => {
    expect(profileLabel('public/test_info/profile_.json')).toBe('profile_.json');
  });
});

describe('profileLinks', () => {
  it('keeps only the profiles', () => {
    expect(profileLinks(ARTIFACTS, job).map((p) => p.label)).toEqual([
      'idb-open-many-seq',
      'resource-usage',
    ]);
  });

  // The one someone came looking for goes first; the free one every perf job
  // uploads goes last, whatever the alphabet says.
  it('sorts resource usage last', () => {
    const labels = profileLinks(
      ['public/test_info/profile_resource-usage.json', 'public/test_info/profile_a11y.zip'],
      job,
    ).map((p) => p.label);
    expect(labels).toEqual(['a11y', 'resource-usage']);
  });

  it('points the profiler at the run artifact, url-encoded', () => {
    const [gecko] = profileLinks(ARTIFACTS, job);
    expect(gecko.url).toBe(
      `${PROFILER_ORIGIN}/from-url/` +
        encodeURIComponent(
          'https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/' +
            'fUUrXaqGTdySnnMCzFHhFw/runs/0/artifacts/' +
            'public/test_info/profile_idb-open-many-seq.zip',
        ),
    );
  });

  // Retried tasks keep the task id, so the run number is the only thing
  // separating attempt 0's artifacts from attempt 1's.
  it('uses the retry id as the run', () => {
    const [gecko] = profileLinks(ARTIFACTS, { ...job, retry_id: 2 });
    expect(decodeURIComponent(gecko.url)).toContain('/runs/2/artifacts/');
  });

  it('names only the resource usage profile, as treeherder does', () => {
    const [gecko, resource] = profileLinks(ARTIFACTS, job);
    expect(new URL(gecko.url).searchParams.has('profileName')).toBe(false);
    expect(new URL(resource.url).searchParams.get('profileName')).toBe(
      `${job.job_type_name} (fUUrXaqGTdySnnMCzFHhFw.0)`,
    );
  });

  it('has nothing to say about a task with no profiles', () => {
    expect(profileLinks(['public/logs/live_backing.log'], job)).toEqual([]);
  });
});

// The three profiles a profiling speedometer3 task uploads, from the run behind
// docs/comparison.md's "Profile comparison" example.
const COMPACT = 'public/test_info/profile_speedometer3_compact.jslb.gz';
const BENCHMARK_ARTIFACTS = [
  'public/logs/live.log',
  'public/test_info/profile_resource-usage.json',
  'public/test_info/profile_speedometer3_all_processes.jslb.gz',
  COMPACT,
  'public/test_info/profile_speedometer3_raw_all_processes.jslb.gz',
];

function taskRun(taskId: string, artifactNames: string[], runId = 0): ProfileTaskRun {
  return { taskId, runId, artifactNames };
}

describe('compactBenchmarkName', () => {
  it('names the benchmark the profile is of', () => {
    expect(compactBenchmarkName(COMPACT)).toBe('speedometer3');
  });

  // The two siblings are the same run kept whole. They are perfectly good
  // profiles to read — `profileLinks` lists all three — and the comparison view
  // is built for the merged one.
  it('rejects the whole-process variants', () => {
    expect(
      compactBenchmarkName('public/test_info/profile_speedometer3_all_processes.jslb.gz'),
    ).toBeNull();
    expect(
      compactBenchmarkName('public/test_info/profile_speedometer3_raw_all_processes.jslb.gz'),
    ).toBeNull();
  });

  it('rejects a profile that is not a benchmark profile at all', () => {
    expect(compactBenchmarkName('public/test_info/profile_resource-usage.json')).toBeNull();
    expect(compactBenchmarkName('public/logs/live.log')).toBeNull();
  });

  // As with `isProfileArtifact`, the prefix is on the file rather than anywhere
  // in the path, and there has to be a benchmark name between the two halves.
  it('needs a name between the prefix and the suffix', () => {
    expect(compactBenchmarkName('profile__compact.jslb.gz')).toBeNull();
    expect(compactBenchmarkName('profile_x/y_compact.jslb.gz')).toBeNull();
  });
});

describe('benchmarkComparison', () => {
  it('links the profile both runs uploaded, base first', () => {
    const link = benchmarkComparison(
      taskRun('BASETASK', BENCHMARK_ARTIFACTS),
      taskRun('NEXTTASK', BENCHMARK_ARTIFACTS),
    );
    expect(link?.artifact).toBe(COMPACT);
    expect(link?.benchmark).toBe('speedometer3');
    const profiles = new URL(link!.url).searchParams.getAll('profiles[]');
    expect(profiles).toHaveLength(2);
    // Each entry is a profiler `/from-url/` URL, so unwrap one layer to get at
    // the artifact it points the profiler at.
    const artifactUrls = profiles.map((p) =>
      decodeURIComponent(p.slice(`${PROFILER_ORIGIN}/from-url/`.length)),
    );
    const queue = 'https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task';
    expect(artifactUrls).toEqual([
      `${queue}/BASETASK/runs/0/artifacts/${COMPACT}`,
      `${queue}/NEXTTASK/runs/0/artifacts/${COMPACT}`,
    ]);
  });

  it('follows each side to its own run', () => {
    const link = benchmarkComparison(
      taskRun('TASK', BENCHMARK_ARTIFACTS, 0),
      taskRun('TASK', BENCHMARK_ARTIFACTS, 2),
    );
    const profiles = new URL(link!.url).searchParams.getAll('profiles[]');
    expect(decodeURIComponent(profiles[0])).toContain('/runs/0/artifacts/');
    expect(decodeURIComponent(profiles[1])).toContain('/runs/2/artifacts/');
  });

  it('offers nothing when only one side has a comparable profile', () => {
    expect(
      benchmarkComparison(
        taskRun('BASETASK', BENCHMARK_ARTIFACTS),
        taskRun('NEXTTASK', ['public/test_info/profile_resource-usage.json']),
      ),
    ).toBeNull();
  });

  // The name carries the benchmark, so requiring the *same* name is what keeps
  // the view from subtracting two unrelated sample sets.
  it('offers nothing when the two sides profiled different benchmarks', () => {
    expect(
      benchmarkComparison(
        taskRun('BASETASK', [COMPACT]),
        taskRun('NEXTTASK', ['public/test_info/profile_jetstream3_compact.jslb.gz']),
      ),
    ).toBeNull();
  });

  // Two replicates of one job are one profile against itself: a table of zeroes.
  it('offers nothing for two points in the same run', () => {
    expect(
      benchmarkComparison(
        taskRun('TASK', BENCHMARK_ARTIFACTS),
        taskRun('TASK', BENCHMARK_ARTIFACTS),
      ),
    ).toBeNull();
  });

  // Artifact lists arrive in the queue's order, which is not ours to rely on.
  it('picks the same profile whichever order the artifacts arrive in', () => {
    const both = [COMPACT, 'public/test_info/profile_a11y_compact.jslb.gz'];
    const forwards = benchmarkComparison(taskRun('A', both), taskRun('B', both));
    const backwards = benchmarkComparison(
      taskRun('A', [...both].reverse()),
      taskRun('B', [...both].reverse()),
    );
    expect(forwards?.artifact).toBe(backwards?.artifact);
    expect(forwards?.benchmark).toBe('a11y');
  });
});
