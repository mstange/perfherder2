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

// Treeherder's jobs view, scrolled to the given job.
export function jobsUrl(repo: string, revision: string, jobId?: number): string {
  const params = new URLSearchParams({ repo, revision, group_state: 'expanded' });
  if (jobId !== undefined) params.set('selectedJob', String(jobId));
  return `${TREEHERDER_ORIGIN}/jobs?${params}`;
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

// Taskcluster task inspector, when the job carries a task id.
export function taskUrl(taskId: string): string {
  return `https://firefox-ci-tc.services.mozilla.com/tasks/${taskId}`;
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
