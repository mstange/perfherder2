import { describe, expect, it } from 'vitest';
import {
  benchmarkComparisonUrl,
  bugsInComment,
  jobsUrl,
  perfCompareSubtestsUrl,
  perfCompareUrl,
  profilerFromUrl,
  pushLogRangeUrl,
  revisionUrl,
  shortRevision,
  splitCommitMessage,
  taskArtifactUrl,
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

  // An expired job arrives as an explicit null, not as a missing argument.
  it('omits selectedJob for an expired job rather than passing null through', () => {
    const url = new URL(jobsUrl('autoland', 'abc123', null));
    expect(url.searchParams.has('selectedJob')).toBe(false);
    expect(url.searchParams.get('revision')).toBe('abc123');
  });
});

describe('revisionUrl', () => {
  it('uses /rev/ for hg and /commit/ for git', () => {
    expect(revisionUrl(hg, 'abc')).toBe('https://hg.mozilla.org/integration/autoland/rev/abc');
    expect(revisionUrl(git, 'abc')).toBe('https://github.com/mozilla-firefox/firefox/commit/abc');
  });
});

describe('shortRevision', () => {
  it('takes the first twelve characters', () => {
    expect(shortRevision('a6c7c8e7c433f0e1d2b3a4958677')).toBe('a6c7c8e7c433');
  });

  it('leaves a revision already that short alone', () => {
    expect(shortRevision('abc123')).toBe('abc123');
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

describe('taskArtifactUrl', () => {
  it('hangs the artifact off the run, with its slashes intact', () => {
    expect(taskArtifactUrl('fUUrXaqGTdySnnMCzFHhFw', 1, 'public/test_info/profile_x.zip')).toBe(
      'https://firefox-ci-tc.services.mozilla.com/api/queue/v1/task/fUUrXaqGTdySnnMCzFHhFw' +
        '/runs/1/artifacts/public/test_info/profile_x.zip',
    );
  });
});

describe('profilerFromUrl', () => {
  // The whole artifact URL is one path segment of the profiler URL, so its own
  // slashes and colon have to be escaped or the profiler reads a truncated one.
  it('encodes the profile url into a single path segment', () => {
    expect(profilerFromUrl('https://example.com/a/profile_x.json')).toBe(
      'https://profiler.firefox.com/from-url/https%3A%2F%2Fexample.com%2Fa%2Fprofile_x.json',
    );
  });

  it('adds profileName only when given one', () => {
    expect(profilerFromUrl('https://example.com/p.json', 'talos (ABC.0)')).toBe(
      'https://profiler.firefox.com/from-url/https%3A%2F%2Fexample.com%2Fp.json' +
        '?profileName=talos%20(ABC.0)',
    );
  });
});

describe('benchmarkComparisonUrl', () => {
  // The profiler reads this parameter with `queryString` in bracket-array mode,
  // so the name has to be `profiles[]` on both entries and the order has to be
  // base first — the view subtracts in that direction.
  it('passes both profiles as profiles[], base first', () => {
    const url = new URL(
      benchmarkComparisonUrl('https://profiler.firefox.com/from-url/a', 'https://p/b'),
    );
    expect(url.pathname).toBe('/compare-benchmark/');
    expect(url.searchParams.getAll('profiles[]')).toEqual([
      'https://profiler.firefox.com/from-url/a',
      'https://p/b',
    ]);
  });

  // Each entry is itself a `/from-url/` URL wrapping a percent-encoded artifact
  // URL, so the query encoding here is the *second* layer. Getting this wrong
  // gives a link that parses and then fetches a truncated artifact URL.
  it('survives a nested from-url profile url intact', () => {
    const inner = profilerFromUrl(
      taskArtifactUrl('eSFQ0OC9R665QYfdgtWgKA', 0, 'public/test_info/p.jslb.gz'),
    );
    const url = new URL(benchmarkComparisonUrl(inner, inner));
    expect(url.searchParams.getAll('profiles[]')).toEqual([inner, inner]);
    // Doubly encoded in the raw query string: `%253A` is a colon inside a
    // `from-url` segment inside a query parameter.
    expect(url.search).toContain('profiles%5B%5D=https%3A%2F%2Fprofiler.firefox.com%2Ffrom-url%2F');
    expect(url.search).toContain('%253A%252F%252Ffirefox-ci-tc.services.mozilla.com');
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

describe('perfCompareUrl', () => {
  const revs = {
    baseRepo: 'mozilla-central',
    baseRev: '020c1f7a2159eb83f4fcb7dc1ddfcd9f1d0f46b7',
    newRepo: 'autoland',
    newRev: 'cd8b93a107ef4aee5c88e83cc5ed3311340b8438',
    frameworkId: 13,
  };

  it('carries both sides and the framework', () => {
    const u = new URL(perfCompareUrl(revs));
    expect(u.origin + u.pathname).toBe('https://perf.compare/compare-results');
    expect(u.searchParams.get('baseRev')).toBe(revs.baseRev);
    expect(u.searchParams.get('baseRepo')).toBe('mozilla-central');
    expect(u.searchParams.get('newRev')).toBe(revs.newRev);
    expect(u.searchParams.get('newRepo')).toBe('autoland');
    expect(u.searchParams.get('framework')).toBe('13');
  });

  it('asks for the same test this app computes', () => {
    // PerfCompare defaults to Student's t; following the link must not
    // silently change the statistic the pane just reported.
    expect(new URL(perfCompareUrl(revs)).searchParams.get('test_version')).toBe(
      'mann-whitney-u',
    );
  });

  it('adds both parent signatures for the subtests view', () => {
    const u = new URL(
      perfCompareSubtestsUrl({ ...revs, baseParentSignature: 5152393, newParentSignature: 91 }),
    );
    expect(u.origin + u.pathname).toBe('https://perf.compare/subtests-compare-results');
    expect(u.searchParams.get('baseParentSignature')).toBe('5152393');
    expect(u.searchParams.get('newParentSignature')).toBe('91');
    expect(u.searchParams.get('test_version')).toBe('mann-whitney-u');
  });
});
