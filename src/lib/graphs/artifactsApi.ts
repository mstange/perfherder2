// The one non-treeherder endpoint this app calls: a task run's artifact list.
//
//   GET <root>/api/queue/v1/task/<taskId>/runs/<runId>/artifacts
//
// Producer: taskcluster-queue's `listArtifacts`. Same CORS story as treeherder
// — `access-control-allow-origin: *`, verified against the live service — so
// there is still no backend of our own. Treeherder reaches the same endpoint
// from `ui/job-view/details/useJobDetails.js`.
//
// Only the names are declared, against this codebase's usual habit of
// transcribing the whole serializer: the rows also carry `contentType`,
// `expires` and `storageType`, none of which we show, and every declared field
// is one more way for a shape change to turn a decorative link list into a
// fatal SchemaError. The download URL isn't in the response at all — it's
// derived from the name by `taskArtifactUrl`.

import * as v from 'valibot';
import { fetchJson } from '../shared/http';
import { taskArtifactsUrl } from '../shared/links';

export const TaskArtifactSchema = v.object({ name: v.string() });
export type TaskArtifact = v.InferOutput<typeof TaskArtifactSchema>;

export const TaskArtifactsSchema = v.object({
  artifacts: v.array(TaskArtifactSchema),
  // Present only when the queue truncated the list; absent on the last page.
  continuationToken: v.optional(v.string()),
});

// A perf task has a dozen artifacts and fits in one page, but a run that
// crashed uploads three files per crash dump and can spill over. Capped rather
// than followed to the end: this is a link list in a details pane, not a
// crawler, and five pages is far past any real task.
const MAX_PAGES = 5;

export async function fetchTaskArtifactNames(
  taskId: string,
  runId: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const base = taskArtifactsUrl(taskId, runId);
  const names: string[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = token === undefined ? base : `${base}?continuationToken=${encodeURIComponent(token)}`;
    const res = await fetchJson(TaskArtifactsSchema, url, signal);
    for (const artifact of res.artifacts) names.push(artifact.name);
    if (res.continuationToken === undefined) break;
    token = res.continuationToken;
  }
  return names;
}
