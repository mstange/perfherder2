import { afterEach, describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { fetchJson, HttpError, SchemaError } from './http';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(response: Partial<Response>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response as Response));
}

// fetchJson logs schema detail on the way out; keep it out of the test output.
function silenceConsole() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

const Thing = v.object({ a: v.number() });

describe('fetchJson', () => {
  it('returns validated JSON on success', async () => {
    stubFetch({ ok: true, json: () => Promise.resolve({ a: 1 }) });
    await expect(fetchJson(Thing, '/x')).resolves.toEqual({ a: 1 });
  });

  it('drops fields the schema does not declare, and keeps going', async () => {
    // Treeherder adds fields without notice; that must never be an error.
    stubFetch({ ok: true, json: () => Promise.resolve({ a: 1, brand_new_field: 'x' }) });
    await expect(fetchJson(Thing, '/x')).resolves.toEqual({ a: 1 });
  });

  it('throws an HttpError whose message is short enough for the UI', async () => {
    stubFetch({ ok: false, status: 400, statusText: '' });
    // The URL goes on the error object, not into the message — an error
    // banner should not make the user read past a 200-character URL.
    await expect(fetchJson(Thing, 'https://example.com/api/thing?a=1')).rejects.toMatchObject({
      name: 'HttpError',
      message: 'HTTP 400',
      status: 400,
      url: 'https://example.com/api/thing?a=1',
    });
  });

  it('includes statusText when the server sends one', async () => {
    stubFetch({ ok: false, status: 404, statusText: 'Not Found' });
    await expect(fetchJson(Thing, '/x')).rejects.toThrow('HTTP 404 Not Found');
  });

  it('is an Error subclass, so generic handlers still work', async () => {
    stubFetch({ ok: false, status: 500, statusText: '' });
    await expect(fetchJson(Thing, '/x')).rejects.toBeInstanceOf(HttpError);
    await expect(fetchJson(Thing, '/x')).rejects.toBeInstanceOf(Error);
  });
});

describe('fetchJson schema failures', () => {
  it('rejects a wrongly-typed field, naming its path in the message', async () => {
    silenceConsole();
    stubFetch({ ok: true, json: () => Promise.resolve({ a: 'not a number' }) });
    await expect(fetchJson(Thing, '/x')).rejects.toMatchObject({
      name: 'SchemaError',
      message: 'Unexpected response shape at a',
      url: '/x',
    });
  });

  it('names the root when the whole response is the wrong shape', async () => {
    silenceConsole();
    // A list endpoint answering with an error object, say.
    stubFetch({ ok: true, json: () => Promise.resolve({ message: 'nope' }) });
    await expect(fetchJson(v.array(Thing), '/x')).rejects.toThrow(
      'Unexpected response shape at (root)',
    );
  });

  it('points at the offending element inside a list', async () => {
    silenceConsole();
    stubFetch({ ok: true, json: () => Promise.resolve([{ a: 1 }, { a: null }]) });
    await expect(fetchJson(v.array(Thing), '/x')).rejects.toThrow(
      'Unexpected response shape at 1.a',
    );
  });

  it('logs the detail once, so a shape change is visible while testing', async () => {
    const spy = silenceConsole();
    stubFetch({ ok: true, json: () => Promise.resolve({ a: 'nope' }) });
    await expect(fetchJson(Thing, '/x')).rejects.toBeInstanceOf(SchemaError);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('a: Invalid type');
  });

  it('caps the detail, so one bad field in a 54k-row list is still readable', async () => {
    silenceConsole();
    const rows = Array.from({ length: 500 }, () => ({ a: 'nope' }));
    stubFetch({ ok: true, json: () => Promise.resolve(rows) });
    const err = await fetchJson(v.array(Thing), '/x').catch((e: SchemaError) => e);
    expect(err).toBeInstanceOf(SchemaError);
    const details = (err as SchemaError).details;
    expect(details.split('\n')).toHaveLength(11);
    expect(details).toContain('…and 490 more');
  });
});
