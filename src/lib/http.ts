// Shared low-level HTTP access to the Treeherder API.
//
// Treeherder serves `access-control-allow-origin: *`, so the SPA talks to it
// directly with no backend of our own. See docs/design.md.
//
// Every response is validated against a valibot schema before it reaches the
// rest of the app, and every API type in this codebase is inferred from one of
// those schemas — so a type can't quietly disagree with what we actually
// check. See docs/design.md ("Validating API responses") for why the schemas
// are written against treeherder's serializers rather than against samples,
// and why a mismatch is fatal rather than tolerated.

import * as v from 'valibot';

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

// Thrown when a 200 response doesn't match its schema — i.e. treeherder
// changed shape under us, or we transcribed a field wrong. Same message
// discipline as HttpError: one short line for the UI, detail on the object.
export class SchemaError extends Error {
  constructor(
    readonly url: string,
    readonly issues: [v.BaseIssue<unknown>, ...v.BaseIssue<unknown>[]],
  ) {
    super(`Unexpected response shape at ${issuePath(issues[0])}`);
    this.name = 'SchemaError';
  }

  // Every issue, one per line, for the console. Capped: a changed field in a
  // 54k-row list produces one issue per row and nobody needs 54k lines.
  get details(): string {
    const lines = this.issues
      .slice(0, 10)
      .map((i) => `  ${issuePath(i)}: ${i.message} (received ${i.received})`);
    if (this.issues.length > lines.length) {
      lines.push(`  …and ${this.issues.length - lines.length} more`);
    }
    return lines.join('\n');
  }
}

// "data.0.job_id" — dotted path to the offending value, or "(root)" when the
// whole response is the wrong shape.
function issuePath(issue: v.BaseIssue<unknown>): string {
  const path = issue.path?.map((p) => String(p.key)).join('.');
  return path && path.length > 0 ? path : '(root)';
}

export async function fetchJson<TSchema extends v.GenericSchema>(
  schema: TSchema,
  url: string,
  signal?: AbortSignal,
): Promise<v.InferOutput<TSchema>> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new HttpError(res.status, url, res.statusText);
  const result = v.safeParse(schema, await res.json());
  if (!result.success) {
    const error = new SchemaError(url, result.issues);
    // The UI only gets the one-line message, and a shape change is something
    // we want to see the moment it happens — so log the detail here.
    console.error(`${error.message}\n${url}\n${error.details}`);
    throw error;
  }
  return result.output;
}
