// Shared low-level HTTP access to the Treeherder API.
//
// Treeherder serves `access-control-allow-origin: *`, so the SPA talks to it
// directly with no backend of our own. See docs/design.md.

export const TREEHERDER_ORIGIN = 'https://treeherder.mozilla.org';
export const API_BASE = `${TREEHERDER_ORIGIN}/api`;

export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json() as Promise<T>;
}
