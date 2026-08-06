// Recorded real payloads, run through the schemas that guard them.
//
// The point is drift detection. The schemas are written against treeherder's
// serializers (see the comments in api.ts / graphApi.ts), and hand-written
// fixtures elsewhere in the suite can only ever confirm our own assumptions —
// the `job_id: number` bug survived precisely because every fixture asserting
// it was written from the same wrong belief. These files are unedited API
// responses, trimmed to the interesting rows.
//
// To refresh them (from the repo root; `interval=1209600` is 14 days):
//
//   B=https://treeherder.mozilla.org/api
//   curl "$B/project/mozilla-central/performance/signatures/?interval=1209600&subtests=1"
//   curl "$B/performance/summary/?repository=autoland&signature=<id>&framework=<fw>\
//&all_data=true&replicates=true&startday=2025-07-28T00:00:00&endday=2026-07-28T00:00:00"
//   curl "$B/project/autoland/push/<pushId>/"
//   curl "$B/project/autoland/jobs/<jobId>/"
//   curl "$B/repository/" ; curl "$B/performance/framework/" ; curl "$B/optioncollectionhash/"
//
// Keep them small, and keep the variant coverage the second describe block
// asserts — a re-record that quietly drops the null `job_id` rows would leave
// the fixture green and useless.

import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { FrameworkSchema, OptionCollectionSchema, SignatureMapSchema } from './signaturesApi';
import { JobSchema, PushSchema, RawSummarySchema, RepositoryInfoSchema } from './graphApi';
import frameworks from './fixtures/frameworks.json';
import job from './fixtures/job.json';
import optionCollections from './fixtures/option-collections.json';
import push from './fixtures/push.json';
import repositories from './fixtures/repositories.json';
import signatures from './fixtures/signatures.json';
import summary from './fixtures/summary.json';

// valibot's error report is far more useful than "expected false to be true",
// so unwrap it into the assertion message.
function expectValid(schema: v.GenericSchema, data: unknown): unknown {
  const result = v.safeParse(schema, data);
  if (!result.success) {
    const detail = result.issues
      .slice(0, 5)
      .map((i) => `${i.path?.map((p) => String(p.key)).join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    expect.fail(`schema rejected the recorded payload:\n${detail}`);
  }
  return result.output;
}

describe('schemas accept recorded treeherder responses', () => {
  it('signatures', () => expectValid(SignatureMapSchema, signatures));
  it('summary', () => expectValid(v.array(RawSummarySchema), summary));
  it('push', () => expectValid(PushSchema, push));
  it('job', () => expectValid(JobSchema, job));
  it('repositories', () => expectValid(v.array(RepositoryInfoSchema), repositories));
  it('frameworks', () => expectValid(v.array(FrameworkSchema), frameworks));
  it('option collections', () => expectValid(v.array(OptionCollectionSchema), optionCollections));
});

describe('the fixtures still cover the variants that matter', () => {
  const rows = Object.values(signatures as Record<string, Record<string, unknown>>);

  it('has a signature row for every optional field, present and absent', () => {
    for (const key of [
      'test',
      'application',
      'extra_options',
      'measurement_unit',
      'has_subtests',
      'parent_signature',
      'lower_is_better',
      'tags',
    ]) {
      expect(rows.some((r) => key in r), `no row with ${key}`).toBe(true);
      expect(rows.some((r) => !(key in r)), `no row without ${key}`).toBe(true);
    }
  });

  it('has a null and a non-null should_alert', () => {
    expect(rows.some((r) => r.should_alert === null)).toBe(true);
    expect(rows.some((r) => typeof r.should_alert === 'boolean')).toBe(true);
  });

  it('has expired and live jobs among the recorded datums', () => {
    const data = (summary as { data: { job_id: number | null }[] }[])[0].data;
    // The regression this file exists for: treeherder nulls `job_id` once the
    // job is expired, which our types denied for months.
    expect(data.some((d) => d.job_id === null)).toBe(true);
    expect(data.some((d) => d.job_id !== null)).toBe(true);
  });

  it('has an hg and a git repository, which pick different link shapes', () => {
    const kinds = new Set((repositories as { dvcs_type: string }[]).map((r) => r.dvcs_type));
    expect(kinds).toContain('hg');
    expect(kinds).toContain('git');
  });
});

describe('schemas reject the shapes that actually bit us', () => {
  it('would have caught a job_id typed as number', () => {
    // i.e. the schema really does accept null there, not merely tolerate it.
    const strict = v.object({ ...RawSummarySchema.entries, data: v.array(v.object({ job_id: v.number() })) });
    expect(v.safeParse(strict, (summary as unknown[])[0]).success).toBe(false);
    expect(v.safeParse(RawSummarySchema, (summary as unknown[])[0]).success).toBe(true);
  });

  it('accepts a running job, whose end_timestamp is null', () => {
    // `to_timestamp()` returns None for an unset datetime; no completed-job
    // sample would ever show this.
    const running = { ...(job as Record<string, unknown>), state: 'running', end_timestamp: null };
    expectValid(JobSchema, running);
  });
});
