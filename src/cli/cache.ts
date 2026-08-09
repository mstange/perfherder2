// A disk cache for treeherder GETs, installed by wrapping `globalThis.fetch`.
//
// **Why a wrapper and not a layer inside http.ts.** `fetchJson` is the app's
// only door to the network and it is deliberately thin; a cache belongs to the
// process that wants one, and the browser already has a perfectly good one.
// Wrapping the global keeps every module under src/lib exactly as the app runs
// it — the CLI's answers come from the same code paths the UI's do, which is
// the entire reason for building the CLI out of this repo rather than beside
// it.
//
// **Why it is not optional in practice.** One repo's signature list is 4–22 MB
// (docs/design.md has the table), and `search` needs it before it can filter
// anything. Without a cache, narrowing a search from twelve hundred rows to
// four is a second full download, which makes the iterative use this tool is
// for cost a minute of waiting per guess.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const MINUTE = 60;
const HOUR = 3600;

// How long each kind of response stays good for. The split is by how fast the
// thing behind it actually changes, not by size:
//
//  - Frameworks, option collections and the repository list are configuration.
//    They change a few times a year.
//  - A signature list changes when a new test lands. An hour late on that
//    shows up as one missing row in a search, and the fix is `--no-cache`.
//  - Performance data, alerts and pushes are the numbers being reasoned about.
//    Ten minutes is short enough that a session watching a landing sees it, and
//    long enough that the four commands it takes to investigate one regression
//    each pay for the fetch once.
export function ttlForUrl(url: string): number {
  if (
    url.includes('/performance/framework/') ||
    url.includes('/optioncollectionhash/') ||
    url.includes('/api/repository/')
  ) {
    return 24 * HOUR;
  }
  if (url.includes('/performance/signatures/')) return HOUR;
  return 10 * MINUTE;
}

// Entries older than this are deleted on startup. A signature list is tens of
// megabytes and a week of them is a gigabyte nobody asked for.
const MAX_AGE_MS = 24 * 3600 * 1000;

export function defaultCacheDir(): string {
  const explicit = process.env.PERFHERDER_CLI_CACHE_DIR;
  if (explicit) return explicit;
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return join(xdg, 'perfherder2-cli');
  const home = homedir();
  return home ? join(home, '.cache', 'perfherder2-cli') : join(tmpdir(), 'perfherder2-cli');
}

function entryPath(dir: string, url: string): string {
  return join(dir, `${createHash('sha256').update(url).digest('hex').slice(0, 32)}.json`);
}

export type CacheStats = { hits: number; misses: number; bytesFetched: number };

export type InstalledCache = {
  stats: CacheStats;
  dir: string | null;
};

// Wrap the global fetch. Returns the counters, which `--verbose` prints — a
// command that took twelve seconds and one that took one differ only in whether
// they hit, and the reader should be able to tell which they got.
export async function installFetchCache(options: {
  enabled: boolean;
  dir?: string;
}): Promise<InstalledCache> {
  const stats: CacheStats = { hits: 0, misses: 0, bytesFetched: 0 };
  const original = globalThis.fetch.bind(globalThis);

  if (!options.enabled) {
    globalThis.fetch = async (input, init) => {
      const res = await original(input, init);
      stats.misses++;
      return res;
    };
    return { stats, dir: null };
  }

  const dir = options.dir ?? defaultCacheDir();
  await mkdir(dir, { recursive: true }).catch(() => {});
  await prune(dir);

  globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);
    // Only GETs, and only ours. Anything else goes straight through rather than
    // being cached under a key that doesn't include the body.
    if (url === null || (init?.method ?? 'GET') !== 'GET') return original(input, init);

    const file = entryPath(dir, url);
    const ttl = ttlForUrl(url) * 1000;
    try {
      const info = await stat(file);
      if (Date.now() - info.mtimeMs < ttl) {
        stats.hits++;
        return jsonResponse(await readFile(file, 'utf8'));
      }
    } catch {
      // No entry, or an unreadable one. Either way, fetch it.
    }

    const res = await original(input, init);
    stats.misses++;
    if (!res.ok) return res;
    const body = await res.text();
    stats.bytesFetched += body.length;
    // A failed write costs a cache entry, never an answer.
    await writeAtomic(file, body).catch(() => {});
    return jsonResponse(body, res.status, res.statusText);
  };

  return { stats, dir };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string | null {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (typeof input === 'object' && input !== null && 'url' in input) return String(input.url);
  return null;
}

// `fetchJson` reads `ok`, `status`, `statusText` and `json()`, so this is a
// complete stand-in for what it was given.
function jsonResponse(body: string, status = 200, statusText = 'OK'): Response {
  return new Response(body, {
    status,
    statusText,
    headers: { 'content-type': 'application/json' },
  });
}

// Write-then-rename, so a second process reading the same key can never see a
// half-written 22 MB signature list and fail its schema check.
async function writeAtomic(file: string, body: string): Promise<void> {
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, body);
  await rename(temp, file);
}

async function prune(dir: string): Promise<void> {
  try {
    const now = Date.now();
    const names = await readdir(dir);
    await Promise.all(
      names.map(async (name) => {
        const file = join(dir, name);
        try {
          const info = await stat(file);
          if (now - info.mtimeMs > MAX_AGE_MS) await rm(file, { force: true });
        } catch {
          // Raced with another process, or not ours. Leave it.
        }
      }),
    );
  } catch {
    // An unreadable cache directory is not a reason to refuse to answer.
  }
}
