import { describe, expect, it } from 'vitest';
import {
  isProfileArtifact,
  isResourceUsageProfile,
  profileLabel,
  profileLinks,
  type ProfileJob,
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
