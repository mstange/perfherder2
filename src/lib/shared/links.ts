// Pure builders for the external links the details pane shows.
//
// Mirrors treeherder's `ui/helpers/url.js` and `ui/models/repository.js`, so
// the URLs we produce are the same ones Perfherder produces.

import { TREEHERDER_ORIGIN } from './http';

export type RepoLinkInfo = {
  name: string;
  // "hg" or "git"; decides the pushlog URL shape.
  dvcs_type: string;
  // Repository root, e.g. "https://hg.mozilla.org/integration/autoland".
  url: string;
};

// Treeherder's jobs view, scrolled to the given job. `jobId` is nullable
// because an expired job has none — the push's job list is still the right
// place to send someone, it just can't be pre-selected. (Passing the null
// through as `selectedJob=null` would be worse than omitting it.)
export function jobsUrl(repo: string, revision: string, jobId?: number | null): string {
  const params = new URLSearchParams({ repo, revision, group_state: 'expanded' });
  if (jobId !== undefined && jobId !== null) params.set('selectedJob', String(jobId));
  return `${TREEHERDER_ORIGIN}/jobs?${params}`;
}

// How a revision is written when it's shown rather than followed. Twelve
// characters is what treeherder, hg.mozilla.org and the pushlog all use, and
// it's what makes two revisions distinguishable at a glance without taking a
// line to itself.
export function shortRevision(revision: string): string {
  return revision.slice(0, 12);
}

// A single revision in the upstream repository browser.
export function revisionUrl(repo: RepoLinkInfo, revision: string): string {
  return repo.dvcs_type === 'git'
    ? `${repo.url}/commit/${revision}`
    : `${repo.url}/rev/${revision}`;
}

// Everything that landed between two pushes. Used to answer "what caused this
// step?" — the range is exclusive of `fromChange` on hg.
export function pushLogRangeUrl(
  repo: RepoLinkInfo,
  fromChange: string,
  toChange: string,
): string {
  if (repo.dvcs_type === 'git') {
    return `${repo.url}/compare/${fromChange}...${toChange}`;
  }
  const params = new URLSearchParams({ fromchange: fromChange, tochange: toChange });
  return `${repo.url}/pushloghtml?${params}`;
}

// Treeherder threads each repository's `tc_root_url` through to its task and
// artifact links, because two clusters are in play. We hardcode the Firefox CI
// one: the only repositories on the other (community-tc — servo-master,
// servo-auto, servo-try) have no performance signatures at all, checked against
// `/api/project/<repo>/performance/signatures/`, so no point this app can plot
// ever came out of a task there.
export const FIREFOX_CI_ROOT = 'https://firefox-ci-tc.services.mozilla.com';

// Taskcluster task inspector, when the job carries a task id.
export function taskUrl(taskId: string): string {
  return `${FIREFOX_CI_ROOT}/tasks/${taskId}`;
}

// The queue's artifact list for one *run* of a task. `runId` is the job's
// `retry_id`: a retried task keeps its task id and gets a new run, and the
// artifacts hang off the run, not the task — so a link built without it points
// at the wrong attempt's files.
export function taskArtifactsUrl(taskId: string, runId: number): string {
  return `${FIREFOX_CI_ROOT}/api/queue/v1/task/${taskId}/runs/${runId}/artifacts`;
}

// One artifact of that run. `name` is the full artifact name including its
// slashes ("public/test_info/profile_resource-usage.json"), which are path
// separators in the URL — so it is appended raw, exactly as treeherder does.
export function taskArtifactUrl(taskId: string, runId: number, name: string): string {
  return `${taskArtifactsUrl(taskId, runId)}/${name}`;
}

export const PROFILER_ORIGIN = 'https://profiler.firefox.com';

// profiler.firefox.com's URL loader: it fetches the profile itself (the
// artifact is CORS-open) and opens it, so this is a link the user follows
// rather than a file they download and re-upload.
//
// Mirrors treeherder's `getPerfAnalysisUrl` (`ui/helpers/url.js`), including
// `profileName` — see artifacts.ts for the one case that passes it.
export function profilerFromUrl(profileUrl: string, profileName?: string): string {
  const url = `${PROFILER_ORIGIN}/from-url/${encodeURIComponent(profileUrl)}`;
  return profileName === undefined
    ? url
    : `${url}?profileName=${encodeURIComponent(profileName)}`;
}

// Perfherder's alerts view, filtered to one summary. `?id=` is the whole
// query — checked against the live view, which keeps the URL as given and shows
// that summary alone, its own filter checkboxes notwithstanding.
export function alertSummaryUrl(summaryId: number): string {
  return `${TREEHERDER_ORIGIN}/perfherder/alerts?id=${summaryId}`;
}

// ---------------------------------------------------------------------------
// PerfCompare
// ---------------------------------------------------------------------------

// Where a comparison of two pushes goes to be looked at properly: PerfCompare
// runs the same test over every signature in the framework and shows the
// confidence intervals, retrigger buttons and subtest drill-down this pane
// doesn't. Parameter names verified against perfcompare's own route loaders
// (`src/components/CompareResults/loader.ts`, `subtestsLoader.ts`).
export const PERFCOMPARE_ORIGIN = 'https://perf.compare';

// `test_version` selects which statistic PerfCompare shows; its default is
// Student's t. We always ask for Mann-Whitney U, because that's what this pane
// computed — following the link should not silently change the test.
const MANN_WHITNEY_U = 'mann-whitney-u';

export type CompareRevisions = {
  baseRepo: string;
  baseRev: string;
  newRepo: string;
  newRev: string;
  frameworkId: number;
};

// The whole-framework comparison. Deliberately broader than the selected
// series — PerfCompare has no notion of "just this signature" at this level —
// which is worth the click anyway: the neighbouring tests are how you tell a
// real regression from a noisy one.
export function perfCompareUrl(c: CompareRevisions): string {
  const params = new URLSearchParams({
    baseRev: c.baseRev,
    baseRepo: c.baseRepo,
    newRev: c.newRev,
    newRepo: c.newRepo,
    framework: String(c.frameworkId),
    test_version: MANN_WHITNEY_U,
  });
  return `${PERFCOMPARE_ORIGIN}/compare-results?${params}`;
}

// The subtest table for one parent signature per side — the closest PerfCompare
// gets to "compare exactly these two series". Only available when we know a
// parent signature for both sides; see `SeriesMeta.parentSignatureId` for when
// that's null.
export function perfCompareSubtestsUrl(
  c: CompareRevisions & { baseParentSignature: number; newParentSignature: number },
): string {
  const params = new URLSearchParams({
    baseRev: c.baseRev,
    baseRepo: c.baseRepo,
    newRev: c.newRev,
    newRepo: c.newRepo,
    framework: String(c.frameworkId),
    baseParentSignature: String(c.baseParentSignature),
    newParentSignature: String(c.newParentSignature),
    test_version: MANN_WHITNEY_U,
  });
  return `${PERFCOMPARE_ORIGIN}/subtests-compare-results?${params}`;
}

// Bug numbers referenced from a commit message, e.g. "Bug 2056155 - …".
const BUG_RE = /\bbug\s+(\d{4,})/gi;

export function bugsInComment(comment: string): number[] {
  const out: number[] = [];
  for (const m of comment.matchAll(BUG_RE)) {
    const n = Number(m[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

export function bugUrl(bug: number): string {
  return `https://bugzilla.mozilla.org/show_bug.cgi?id=${bug}`;
}

// Commit messages are "summary\n\nbody"; the pane shows the summary and keeps
// the body for a details disclosure.
export function splitCommitMessage(comments: string): { summary: string; body: string } {
  const nl = comments.indexOf('\n');
  if (nl === -1) return { summary: comments.trim(), body: '' };
  return { summary: comments.slice(0, nl).trim(), body: comments.slice(nl + 1).trim() };
}
