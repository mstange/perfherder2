// Same discipline as signaturesApi.test.ts: stub `fetch`, assert the URL we
// build and that the schema is actually enforced. The point of the schema
// tests is that a shape change in treeherder must be loud, not silently
// absorbed — see docs/design.md "Validating API responses".

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SchemaError } from '../shared/http';
import { activityDataUrl, fetchActivityData } from './activityApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

const datum = {
  id: 2631843010,
  signature_id: 227074,
  job_id: 581048117,
  push_id: 1983527,
  revision: '086a31370d2dbe0fa73c71dab68821be0401c2b0',
  push_timestamp: 1785155040,
  value: 763.9,
};

describe('activityDataUrl', () => {
  it('repeats signature_id once per id and passes the relative interval', () => {
    const url = activityDataUrl('autoland', [1, 2, 3], 1209600);
    expect(url).toBe(
      'https://treeherder.mozilla.org/api/project/autoland/performance/data/' +
        '?interval=1209600&signature_id=1&signature_id=2&signature_id=3',
    );
  });

  it('escapes the repository name', () => {
    expect(activityDataUrl('mozilla-central', [1], 172800)).toContain(
      '/project/mozilla-central/performance/data/',
    );
  });
});

describe('fetchActivityData', () => {
  it('returns the hash-keyed record as sent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ abc123: [datum] })));
    const out = await fetchActivityData('autoland', [227074], 1209600);
    expect(out).toEqual({ abc123: [datum] });
  });

  it('accepts an empty record, which is what an idle signature looks like', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({})));
    await expect(fetchActivityData('autoland', [1], 1209600)).resolves.toEqual({});
  });

  it('accepts a null job_id, which is what an expired job looks like', async () => {
    // Treeherder keeps perf data far longer than jobs and nulls the FK on the
    // way out (`job = ForeignKey(null=True, on_delete=SET_NULL)`).
    vi.stubGlobal('fetch', vi.fn(async () => json({ abc: [{ ...datum, job_id: null }] })));
    await expect(fetchActivityData('autoland', [1], 1209600)).resolves.toBeTruthy();
  });

  it('rejects a response whose shape changed under us', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ abc: [{ ...datum, value: 'fast' }] })));
    await expect(fetchActivityData('autoland', [1], 1209600)).rejects.toBeInstanceOf(
      SchemaError,
    );
  });
});
