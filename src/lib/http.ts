// Shared low-level HTTP access to the Treeherder API.
//
// Treeherder serves `access-control-allow-origin: *`, so the SPA talks to it
// directly with no backend of our own. See docs/design.md.

export const TREEHERDER_ORIGIN = 'https://treeherder.mozilla.org';
export const API_BASE = `${TREEHERDER_ORIGIN}/api`;

// Thrown for a non-2xx response. The message stays short enough to put in
// the UI; the full URL is kept as a property for debugging rather than
// pasted into a banner the user has to read past.
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    statusText: string,
  ) {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ''}`);
    this.name = 'HttpError';
  }
}

export async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new HttpError(res.status, url, res.statusText);
  return res.json() as Promise<T>;
}
