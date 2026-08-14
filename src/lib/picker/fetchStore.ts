// Fetched data that outlives the component that asked for it.
//
// The Add-series panel is mounted inside `{#if app.pickerOpen}` (App.svelte),
// so `PickerState` — and every cache declared as a field on it — is built when
// the panel opens and thrown away when it closes. Closing and reopening
// therefore refetched the whole signature list: ~4 MB gzipped per repo and
// several seconds, for data that had not changed. The browser's HTTP cache
// can't cover it either — the endpoint sends no `cache-control`, no `etag` and
// no `last-modified` (checked against production), so there is nothing to
// revalidate against and nothing to compute heuristic freshness from.
//
// So the picker's caches live at module scope in one of these (see
// pickerState.svelte.ts, which owns the instances). Three behaviours, and the
// panel needs all three:
//
//   - **A TTL.** `interval=1209600` is a duration, not a window: the server
//     resolves it against its own clock, so the same URL means something
//     slightly different every time it is asked. A cached answer is never
//     wrong, only increasingly behind, which is exactly what a TTL is for.
//   - **A bound.** One subtests=1 entry is tens of thousands of `Series`
//     objects, and the key space — repo × subtests × interval — is nearly
//     fifty. Same eviction discipline as the activity cache: insertion order,
//     least recently *fetched*.
//   - **In-flight dedupe.** The panel can be closed and reopened while the
//     first fetch is still running, and without this the second `PickerState`
//     starts the same multi-megabyte download over again — the very case the
//     cache exists to prevent, and the one where it hurts most.

export class FetchStore<T> {
  // Insertion-ordered, which is what makes eviction a `keys().next()`.
  private readonly entries = new Map<string, { value: T; fetchedAt: number }>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    // Pass `Infinity` for data with no meaningful expiry.
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  // The cached value, if there is a live one. Synchronous, because the whole
  // point on reopen is to have the rows in hand for the first render rather
  // than a microtask later, which is a frame of skeleton.
  //
  // A miss and a cached `undefined` are indistinguishable. Callers store
  // something, so this has never mattered; it would if one didn't.
  peek(key: string, now: number): T | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    if (now - hit.fetchedAt >= this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  // A live cached value, the answer to an identical fetch already running, or
  // a new fetch. `fetcher` is called at most once per key per TTL window.
  //
  // A rejection is not cached: the caller decides whether a failure is worth
  // retrying (`PickerState.failedFetches` says no until the repo is
  // re-checked), and a store that remembered failures would take that choice
  // away from it.
  load(key: string, now: number, fetcher: () => Promise<T>): Promise<T> {
    const cached = this.peek(key, now);
    if (cached !== undefined) return Promise.resolve(cached);
    const running = this.inflight.get(key);
    if (running !== undefined) return running;

    let started: Promise<T>;
    try {
      started = fetcher();
    } catch (e) {
      return Promise.reject(e);
    }
    // `now` — when the fetch *started*, not when it landed. The conservative
    // end of a window the response is behind by anyway, and it costs no
    // second reading of a clock the caller would have to be given.
    const p = started.then(
      (value) => {
        this.inflight.delete(key);
        this.put(key, value, now);
        return value;
      },
      (e: unknown) => {
        this.inflight.delete(key);
        throw e;
      },
    );
    this.inflight.set(key, p);
    return p;
  }

  private put(key: string, value: T, fetchedAt: number): void {
    // Delete first: re-setting an existing key would otherwise keep its
    // original position, and the oldest-first eviction below would then evict
    // by first fetch rather than by most recent one.
    this.entries.delete(key);
    this.entries.set(key, { value, fetchedAt });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  // Test seam. Module-scope caches are shared by every test in a file, which
  // is the flip side of being shared by every panel opening.
  reset(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
