// Fetch orchestration: the sequences of requests each command needs, and
// nothing else. Every projection these hand back is the app's own — `toSeries`,
// `buildSeriesData`, `alertsForSeries`, `commitsInRange` — so a number here and
// the same number on the graph come from one implementation.
//
// The rules about *when* to ask, and what a failure means, are copied from
// `appState.svelte.ts` rather than reinvented, and where they differ the reason
// is written down beside them.

import {
  alertsForSeries,
  reassignmentTargetIds,
  type SeriesAlert,
} from '../lib/graphs/alerts';
import { fetchAlertSummaries, fetchAlertSummary } from '../lib/graphs/alertsApi';
import {
  fetchPushByRevision,
  fetchPushRange,
  fetchRepositories,
  fetchSignatureMeta,
  fetchSummary,
  type RepositoryInfo,
} from '../lib/graphs/graphApi';
import {
  alertThresholdFromSummary,
  buildSeriesData,
  EMPTY_SERIES_DATA,
  metaFromSummary,
  placeholderMeta,
  resolveAlertThreshold,
  thresholdParentRef,
  type AlertThreshold,
  type SeriesRef,
} from '../lib/graphs/graphData';
import { commitsInRange, type PushlogRange } from '../lib/graphs/pushlog';
import { buildActivities, chunkIds, MAX_IDS_PER_REQUEST, type Activity } from '../lib/picker/activity';
import { fetchActivityData } from '../lib/picker/activityApi';
import { toSeries, type Series } from '../lib/picker/series';
import {
  buildOptionMap,
  fetchFrameworks,
  fetchOptionCollections,
  fetchSignatures,
} from '../lib/picker/signaturesApi';
import type { SeriesArg, Span } from './args';
import type { LoadedSeries } from './reports';

// `LoadedSeries.ref.frameworkId` is resolved here: taken from the response when
// the caller's reference didn't carry one. `found` is false when the summary
// endpoint answered with nothing — no such signature, or none of its data falls
// in the range — and `meta` is then a placeholder whose every field is made up.
export async function loadSeries(arg: SeriesArg, span: Span): Promise<LoadedSeries> {
  const summary = await fetchSummary(
    arg.repository,
    arg.signatureId,
    arg.frameworkId,
    span.start,
    span.end,
  );
  if (!summary) {
    const ref: SeriesRef = {
      repository: arg.repository,
      signatureId: arg.signatureId,
      // Nothing came back to read one off, and 0 is not a framework — but every
      // caller checks `found` before using it, and the alternative is making
      // `SeriesRef.frameworkId` nullable app-wide for a case only this hits.
      frameworkId: arg.frameworkId ?? 0,
    };
    return { ref, meta: placeholderMeta(ref), data: EMPTY_SERIES_DATA, found: false };
  }
  const ref: SeriesRef = {
    repository: arg.repository,
    signatureId: arg.signatureId,
    frameworkId: summary.framework_id,
  };
  return { ref, meta: metaFromSummary(summary), data: buildSeriesData(summary), found: true };
}

// The floor change detection holds this series to: its own threshold, its
// parent's when it declares none, perfherder's global default when neither
// does. See graphs.md, "The floor comes from the signature".
//
// The parent lookup is a metadata-only request over a zero-width window, and
// `nowMs` is rounded down to the hour so the URL is stable enough to cache — the
// answer does not depend on the instant, only on the filter that a zero-width
// window skips.
export async function loadThreshold(loaded: LoadedSeries): Promise<AlertThreshold> {
  if (loaded.meta.alertThreshold) return resolveAlertThreshold(loaded.meta.alertThreshold, null);
  const parent = thresholdParentRef(loaded.ref, loaded.meta);
  if (!parent) return resolveAlertThreshold(null, null);
  try {
    const hour = Math.floor(Date.now() / 3_600_000) * 3_600_000;
    const summary = await fetchSignatureMeta(
      parent.repository,
      parent.signatureId,
      parent.frameworkId,
      undefined,
      hour,
    );
    return resolveAlertThreshold(null, summary ? alertThresholdFromSummary(summary) : null);
  } catch {
    // As in the app: a failed lookup falls back to the default rather than
    // leaving the series unanalysed, which would be a worse answer than a
    // slightly wrong floor.
    return resolveAlertThreshold(null, null);
  }
}

const DAY_SECONDS = 86400;

// Perfherder's own alerts on this series, placed on the pushes we loaded.
//
// The `timerange` filter is server-side and counts back from now, so this asks
// for a superset and `alertsForSeries` drops what isn't on a plotted push —
// exactly what the app does, and for the same reason.
export async function loadAlerts(loaded: LoadedSeries, span: Span): Promise<SeriesAlert[]> {
  if (!loaded.found) return [];
  const seconds = Math.max(DAY_SECONDS, (Date.now() - span.start) / 1000);
  const summaries = await fetchAlertSummaries(
    loaded.ref.signatureId,
    loaded.ref.frameworkId,
    seconds,
  );
  const ids = reassignmentTargetIds(summaries, loaded.ref.signatureId);
  let targets: Map<number, Awaited<ReturnType<typeof fetchAlertSummary>>> | undefined;
  if (ids.length > 0) {
    targets = new Map();
    // Per-id failures cost one marker its move, not every marker its position.
    await Promise.all(
      ids.map(async (id) => {
        try {
          targets!.set(id, await fetchAlertSummary(id));
        } catch {
          /* keep the alert on the push the analysis flagged */
        }
      }),
    );
  }
  return alertsForSeries(summaries, loaded.ref.signatureId, loaded.data, targets);
}

// When a revision landed, as an instant — the split point `step` needs.
//
// Asked of each repository in turn rather than of one, because a caller
// comparing autoland against mozilla-central names a revision that exists on
// only one of them, and which one is not something they should have to say.
// Null when no repository has it.
export async function loadRevisionTime(
  repositories: readonly string[],
  revision: string,
): Promise<{ atMs: number; repository: string } | null> {
  for (const repository of repositories) {
    try {
      const push = await fetchPushByRevision(repository, revision);
      // Seconds here, unlike the summary endpoint's naive ISO string for the
      // same column — see PushSchema.
      if (push) return { atMs: push.push_timestamp * 1000, repository };
    } catch {
      // A repository that answers badly is not a reason to stop asking the
      // others; a revision only lives on one of them anyway.
    }
  }
  return null;
}

// Everything that landed between two revisions, base end excluded. See
// pushlog.ts for the two corrections applied to the raw response.
export async function loadPushlog(
  repository: string,
  fromRevision: string,
  toRevision: string,
): Promise<PushlogRange> {
  const range = await fetchPushRange(repository, fromRevision, toRevision);
  return commitsInRange(range.pushes, fromRevision, range.truncated);
}

// ---------------------------------------------------------------------------
// The picker's data
// ---------------------------------------------------------------------------

export type SignatureSet = {
  rows: Series[];
  // Per repository, how many raw signature rows came back — the denominator
  // for "N of M", which a search has to print or its answer is unfalsifiable.
  fetched: Map<string, number>;
};

export async function loadSignatures(
  repos: readonly string[],
  intervalSeconds: number,
  includeSubtests: boolean,
): Promise<SignatureSet> {
  // Both are tiny, cached for a day, and needed to turn a raw row into
  // something with a framework name and resolved options.
  const [frameworks, optionCollections] = await Promise.all([
    fetchFrameworks(),
    fetchOptionCollections(),
  ]);
  const frameworkMap = new Map(frameworks.map((f) => [f.id, f.name]));
  const optionMap = buildOptionMap(optionCollections);

  const rows: Series[] = [];
  const fetched = new Map<string, number>();
  const perRepo = await Promise.all(
    repos.map(async (repo) => {
      const raw = await fetchSignatures(repo, intervalSeconds, includeSubtests);
      return { repo, raw };
    }),
  );
  for (const { repo, raw } of perRepo) {
    fetched.set(repo, Object.keys(raw).length);
    rows.push(...toSeries(raw, repo, frameworkMap, optionMap));
  }
  return { rows, fetched };
}

// Run counts for a set of rows, one batched request per repository.
//
// The app fetches these for the visible window only, because it has ~25k rows
// and a viewport. Here the "visible window" is whatever `--limit` left, which
// is the same bound arrived at differently — and `MAX_IDS_PER_REQUEST` is the
// hard cap either way (treeherder's frontend rejects a longer request line).
export async function loadActivity(
  rows: readonly Series[],
  intervalSeconds: number,
  nowMs: number,
): Promise<Map<string, Activity>> {
  const byRepo = new Map<string, number[]>();
  for (const row of rows) {
    const list = byRepo.get(row.repository);
    if (list) list.push(row.id);
    else byRepo.set(row.repository, [row.id]);
  }

  const out = new Map<string, Activity>();
  await Promise.all(
    [...byRepo].map(async ([repo, ids]) => {
      for (const batch of chunkIds(ids, MAX_IDS_PER_REQUEST)) {
        try {
          const response = await fetchActivityData(repo, batch, intervalSeconds);
          for (const [id, activity] of buildActivities(batch, response, nowMs, intervalSeconds)) {
            out.set(`${repo}|${id}`, activity);
          }
        } catch {
          // The app renders a muted dash for these rather than an error banner:
          // the column is decoration on a list that works without it.
        }
      }
    }),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

// `dvcs_type` and `url` decide the pushlog link shape. Null when the lookup
// failed, which costs a link and nothing else.
export async function loadRepository(name: string): Promise<RepositoryInfo | null> {
  try {
    const repos = await fetchRepositories();
    return repos.find((r) => r.name === name) ?? null;
  } catch {
    return null;
  }
}
