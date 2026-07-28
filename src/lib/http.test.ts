import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchJson, HttpError } from './http';

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: Partial<Response>) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response as Response));
}

describe('fetchJson', () => {
  it('returns parsed JSON on success', async () => {
    stubFetch({ ok: true, json: () => Promise.resolve({ a: 1 }) });
    await expect(fetchJson('/x')).resolves.toEqual({ a: 1 });
  });

  it('throws an HttpError whose message is short enough for the UI', async () => {
    stubFetch({ ok: false, status: 400, statusText: '' });
    // The URL goes on the error object, not into the message — an error
    // banner should not make the user read past a 200-character URL.
    await expect(fetchJson('https://example.com/api/thing?a=1')).rejects.toMatchObject({
      name: 'HttpError',
      message: 'HTTP 400',
      status: 400,
      url: 'https://example.com/api/thing?a=1',
    });
  });

  it('includes statusText when the server sends one', async () => {
    stubFetch({ ok: false, status: 404, statusText: 'Not Found' });
    await expect(fetchJson('/x')).rejects.toThrow('HTTP 404 Not Found');
  });

  it('is an Error subclass, so generic handlers still work', async () => {
    stubFetch({ ok: false, status: 500, statusText: '' });
    await expect(fetchJson('/x')).rejects.toBeInstanceOf(HttpError);
    await expect(fetchJson('/x')).rejects.toBeInstanceOf(Error);
  });
});
