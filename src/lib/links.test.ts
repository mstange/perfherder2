import { describe, expect, it } from 'vitest';
import {
  bugsInComment,
  jobsUrl,
  pushLogRangeUrl,
  revisionUrl,
  splitCommitMessage,
  type RepoLinkInfo,
} from './links';

const hg: RepoLinkInfo = {
  name: 'autoland',
  dvcs_type: 'hg',
  url: 'https://hg.mozilla.org/integration/autoland',
};
const git: RepoLinkInfo = {
  name: 'firefox',
  dvcs_type: 'git',
  url: 'https://github.com/mozilla-firefox/firefox',
};

describe('jobsUrl', () => {
  it('points at treeherder with the job preselected', () => {
    const url = new URL(jobsUrl('autoland', 'abc123', 42));
    expect(url.origin + url.pathname).toBe('https://treeherder.mozilla.org/jobs');
    expect(url.searchParams.get('repo')).toBe('autoland');
    expect(url.searchParams.get('revision')).toBe('abc123');
    expect(url.searchParams.get('selectedJob')).toBe('42');
  });

  it('omits selectedJob when there is no job', () => {
    expect(new URL(jobsUrl('autoland', 'abc123')).searchParams.has('selectedJob')).toBe(false);
  });
});

describe('revisionUrl', () => {
  it('uses /rev/ for hg and /commit/ for git', () => {
    expect(revisionUrl(hg, 'abc')).toBe('https://hg.mozilla.org/integration/autoland/rev/abc');
    expect(revisionUrl(git, 'abc')).toBe('https://github.com/mozilla-firefox/firefox/commit/abc');
  });
});

describe('pushLogRangeUrl', () => {
  it('uses pushloghtml for hg', () => {
    expect(pushLogRangeUrl(hg, 'aaa', 'bbb')).toBe(
      'https://hg.mozilla.org/integration/autoland/pushloghtml?fromchange=aaa&tochange=bbb',
    );
  });

  it('uses compare for git', () => {
    expect(pushLogRangeUrl(git, 'aaa', 'bbb')).toBe(
      'https://github.com/mozilla-firefox/firefox/compare/aaa...bbb',
    );
  });
});

describe('bugsInComment', () => {
  it('finds bug numbers regardless of case', () => {
    expect(bugsInComment('Bug 2056155 - fix it; see bug 12345')).toEqual([2056155, 12345]);
  });

  it('dedupes and ignores short numbers', () => {
    expect(bugsInComment('Bug 999 and Bug 123456 and bug 123456')).toEqual([123456]);
  });

  it('returns nothing for a message with no bug reference', () => {
    expect(bugsInComment('No bugs here')).toEqual([]);
  });
});

describe('splitCommitMessage', () => {
  it('splits summary from body', () => {
    expect(splitCommitMessage('Summary line\n\nBody text\nmore')).toEqual({
      summary: 'Summary line',
      body: 'Body text\nmore',
    });
  });

  it('handles a one-line message', () => {
    expect(splitCommitMessage('Just a summary')).toEqual({
      summary: 'Just a summary',
      body: '',
    });
  });
});
