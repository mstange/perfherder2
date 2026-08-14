// The cache that lets the Add-series panel be closed and reopened without
// refetching. Three behaviours to pin — expiry, eviction and in-flight
// dedupe — plus the one thing that must *not* be cached, a failure.

import { describe, expect, it, vi } from 'vitest';
import { FetchStore } from './fetchStore';

// A deferred promise, so a test can hold a fetch open and start a second one
// while the first is still running.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('FetchStore', () => {
  it('fetches once and serves the cached value after that', async () => {
    const store = new FetchStore<string>(1000, 4);
    const fetcher = vi.fn(async () => 'rows');

    expect(await store.load('a', 0, fetcher)).toBe('rows');
    expect(await store.load('a', 500, fetcher)).toBe('rows');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('peeks without fetching, and misses before anything is stored', async () => {
    const store = new FetchStore<string>(1000, 4);
    expect(store.peek('a', 0)).toBeUndefined();
    await store.load('a', 0, async () => 'rows');
    expect(store.peek('a', 0)).toBe('rows');
  });

  it('refetches once the entry is older than the TTL', async () => {
    const store = new FetchStore<string>(1000, 4);
    const fetcher = vi.fn(async () => 'rows');

    await store.load('a', 0, fetcher);
    // Exactly at the TTL counts as expired — the window is half-open.
    expect(store.peek('a', 1000)).toBeUndefined();
    await store.load('a', 1000, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('dates an entry from when its fetch started, not when it landed', async () => {
    const store = new FetchStore<string>(1000, 4);
    const d = deferred<string>();

    const p = store.load('a', 0, () => d.promise);
    d.resolve('rows');
    await p;

    // The fetch was requested at t=0, so it expires at t=1000 however long it
    // actually took. The conservative end of a window the answer is behind by.
    expect(store.peek('a', 999)).toBe('rows');
    expect(store.peek('a', 1000)).toBeUndefined();
  });

  it('never treats `Infinity` as expiring', async () => {
    const store = new FetchStore<string>(Infinity, 4);
    await store.load('a', 0, async () => 'meta');
    expect(store.peek('a', Number.MAX_SAFE_INTEGER)).toBe('meta');
  });

  it('joins a fetch already in flight instead of starting a second', async () => {
    const store = new FetchStore<string>(1000, 4);
    const d = deferred<string>();
    const fetcher = vi.fn(() => d.promise);

    // The panel closed and reopened while the first request was still running.
    const first = store.load('a', 0, fetcher);
    const second = store.load('a', 10, fetcher);

    d.resolve('rows');
    expect(await first).toBe('rows');
    expect(await second).toBe('rows');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('does not cache a rejection, and lets the next caller retry', async () => {
    const store = new FetchStore<string>(1000, 4);
    const fetcher = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('rows');

    await expect(store.load('a', 0, fetcher)).rejects.toThrow('boom');
    expect(store.peek('a', 0)).toBeUndefined();
    expect(await store.load('a', 0, fetcher)).toBe('rows');
  });

  it('rejects rather than throwing when the fetcher throws synchronously', async () => {
    const store = new FetchStore<string>(1000, 4);
    await expect(
      store.load('a', 0, () => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
    expect(store.peek('a', 0)).toBeUndefined();
  });

  it('evicts the oldest entry past the bound', async () => {
    const store = new FetchStore<string>(1000, 2);
    await store.load('a', 0, async () => 'A');
    await store.load('b', 1, async () => 'B');
    await store.load('c', 2, async () => 'C');

    expect(store.size).toBe(2);
    expect(store.peek('a', 3)).toBeUndefined();
    expect(store.peek('b', 3)).toBe('B');
    expect(store.peek('c', 3)).toBe('C');
  });

  it('counts a refetched key as the newest, not the oldest', async () => {
    const store = new FetchStore<string>(100, 2);
    await store.load('a', 0, async () => 'A');
    await store.load('b', 1, async () => 'B');
    // `a` expires and is fetched again, which should move it to the back of
    // the eviction queue. Without the delete-before-set in `put` it would keep
    // its original position and be evicted by the next arrival.
    await store.load('a', 200, async () => 'A2');
    await store.load('c', 201, async () => 'C');

    expect(store.peek('a', 202)).toBe('A2');
    expect(store.peek('c', 202)).toBe('C');
    expect(store.peek('b', 202)).toBeUndefined();
  });

  it('forgets everything on reset', async () => {
    const store = new FetchStore<string>(1000, 4);
    await store.load('a', 0, async () => 'rows');
    store.reset();
    expect(store.peek('a', 0)).toBeUndefined();
    expect(store.size).toBe(0);
  });
});
