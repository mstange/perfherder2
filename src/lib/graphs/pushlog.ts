// What landed between two pushes, as a list the comparison card can draw
// inline. Answering "what caused this step" was previously a click out to
// hg.mozilla.org and a read of somebody else's page.
//
// Transport is `fetchPushRange` in graphApi.ts; this is the projection, and it
// exists as its own module because the raw response is misleading in two
// specific ways that are worth stating once and testing. See
// docs/comparison.md, "The inline pushlog".

import { bugsInComment, splitCommitMessage } from '../shared/links';
import { MAX_RANGE_PUSHES, type Push } from './graphApi';

export type Commit = {
  revision: string;
  // Display name only — see `authorName`.
  author: string;
  // First line of the commit message, and the rest.
  summary: string;
  body: string;
  // Bugs named in the summary line, for the bugzilla links.
  bugs: number[];
  // Which push carried it. Two commits can share one.
  pushId: number;
  // Seconds since epoch, from the push — a commit's own date isn't exposed.
  pushTimestamp: number;
};

export type PushlogRange = {
  // Newest first, matching hg's pushlog and the graph's left-to-right time.
  commits: Commit[];
  // Pushes contributing to the list, after the base end is dropped.
  pushCount: number;
  // Commits the serializer wouldn't name. Not an error and not rare — see
  // `commitsInRange`.
  hiddenRevisions: number;
  // The range was longer than the fetch cap, so even `hiddenRevisions` is a
  // floor on what's missing.
  truncated: boolean;
};

// "Francesco Lodolo <flod@lodolo.net>" → "Francesco Lodolo".
//
// Falls back to the address when there is no display name, because
// "<flod@lodolo.net>" with the name empty is a row that looks broken, and a
// bare address is a perfectly good way to identify someone.
export function authorName(author: string): string {
  const lt = author.indexOf('<');
  if (lt === -1) return author.trim();
  const name = author.slice(0, lt).trim();
  if (name) return name;
  return author.slice(lt + 1).replace('>', '').trim();
}

// Flatten a fetched range into commits.
//
// Two corrections to what the endpoint hands back, both load-bearing:
//
//   - **The base push is dropped.** Treeherder resolves `fromchange` to a
//     timestamp bound and *includes* the push it names, while hg's
//     `pushloghtml` excludes it — and that link sits inches away in the same
//     card, so the two would disagree by one. The disagreement would also be
//     wrong on its own terms rather than merely inconsistent: the base push is
//     the "before" side of the comparison, so listing its commit among the
//     candidates blames it for a change it is the reference for.
//   - **`revisions` is capped at 20 per push by the serializer**, while
//     `revision_count` carries the real total. On autoland almost every push is
//     one commit and this never fires; on mozilla-central it fires constantly —
//     14 of 30 sampled pushes were merges, the largest naming 20 of its 164
//     commits. Counting the gap is what lets the card say "20 of 164" instead
//     of quietly presenting a fifth of a merge as all of it.
//
// **The base revision is matched by prefix**, and that is not a nicety. It was
// an exact comparison, which is correct for every caller inside the app —
// their revisions come out of the data, full length, on both sides. The CLI
// made the short form reachable: 12 characters is how `shortRevision` writes a
// revision, how this file's own output prints one, and what the push endpoint
// itself accepts. Given one, the exact test never matched, the base push
// survived the filter, and the range was reported with the header still saying
// the base push had been excluded — so the output blamed the reference build
// for the change it is the reference for *while asserting that it hadn't*.
// Either side may be the shorter, since nothing here guarantees which.
export function sameRevision(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a.length <= b.length ? b.startsWith(a) : a.startsWith(b);
}

export function commitsInRange(
  pushes: readonly Push[],
  baseRevision: string,
  truncated: boolean,
): PushlogRange {
  const inRange = pushes.filter((p) => !sameRevision(p.revision, baseRevision));
  const commits: Commit[] = [];
  let hiddenRevisions = 0;
  for (const push of inRange) {
    const one = commitsOfPush(push);
    commits.push(...one.commits);
    hiddenRevisions += one.hiddenRevisions;
  }
  return { commits, pushCount: inRange.length, hiddenRevisions, truncated };
}

// One push's commits, and how many it didn't name. The details pane's Build
// section shows exactly this for the selected push — the same projection as a
// range of one, so the two lists in the pane can't drift apart.
export function commitsOfPush(push: Push): { commits: Commit[]; hiddenRevisions: number } {
  const commits = push.revisions.map((rev) => {
    const { summary, body } = splitCommitMessage(rev.comments);
    return {
      revision: rev.revision,
      author: authorName(rev.author),
      summary,
      body,
      // From the summary, not the whole message: the body routinely mentions
      // other bugs ("depends on bug N"), and the card is naming what this
      // commit is, not everything it references.
      bugs: bugsInComment(summary),
      pushId: push.id,
      pushTimestamp: push.push_timestamp,
    };
  });
  // `revision_count` is the truth and `revisions` is capped at 20 by the
  // serializer, so this gap is the only way to know a merge was abbreviated —
  // `revisions.length` alone can never exceed the cap and so can never report
  // one. See graphApi.ts, `PushSchema`.
  return { commits, hiddenRevisions: Math.max(0, push.revision_count - push.revisions.length) };
}

// Almost every Firefox commit message starts by naming its bug, which the card
// already draws as a link — so printing the summary verbatim beside that link
// says "Bug 2058227" twice in the same 40 characters.
//
// Three separators are in use and all three turned up in one 254-commit range:
// "Bug N - text" dominates, "Bug N: text" and "Bug N. text" are both common,
// and a fair number of messages just run on — "Bug 2057712 Update android
// nightly …". Accepting the run-on case is what makes this worth having, and
// also what makes it need a guard, because "Bug 12345 and bug 6789 - …" has the
// same shape and stripping it would leave a sentence starting "and".
//
// So: an explicit separator strips, and without one the next word has to look
// like the start of a sentence rather than a continuation of this one. The
// prefix is also only stripped when it names the bug actually being linked — a
// message opening with some *other* bug keeps its text rather than being
// silently reworded.
const LEADING_BUG_RE = /^bug\s+(\d{4,})(\s*[-:—.]\s*|\s+)/i;

export function commitTitle(commit: Commit): string {
  const match = LEADING_BUG_RE.exec(commit.summary);
  if (!match || Number(match[1]) !== commit.bugs[0]) return commit.summary;
  const rest = commit.summary.slice(match[0].length);
  const hasSeparator = /[-:—.]/.test(match[2]);
  if (!hasSeparator && !/^[A-Z0-9]/.test(rest)) return commit.summary;
  return rest;
}

// What the collapsed row says, which is the whole point of the row: it has to
// carry the count without being opened, and it has to be honest when the count
// it carries is a floor.
//
// Three shapes — "12 commits", "20 of 164 commits" when a merge hid some, and
// "20 of 164+ commits" when the range itself was cut short, since then the
// total is a floor too. The "+" is doing real work: without it a truncated
// range prints a precise-looking total that is simply wrong.
export function pushlogLabel(range: PushlogRange): string {
  const shown = range.commits.length;
  const total = shown + range.hiddenRevisions;
  if (total === 0) return 'no commits';
  const noun = total === 1 ? 'commit' : 'commits';
  if (shown === total && !range.truncated) return `${total} ${noun}`;
  return `${shown} of ${total}${range.truncated ? '+' : ''} ${noun}`;
}

// The sentence the expanded list carries when it isn't the whole story, or null
// when it is. Kept separate from the label so the header stays a count: the
// explanation is longer than a header should be, and it is only worth reading
// once the list is open and its shortness is visible.
export function pushlogCaveat(range: PushlogRange): string | null {
  if (range.truncated) {
    return `Only the newest ${MAX_RANGE_PUSHES} pushes of this range were fetched.`;
  }
  if (range.hiddenRevisions > 0) {
    const n = range.hiddenRevisions;
    return `${n} further ${n === 1 ? 'commit is' : 'commits are'} in these pushes; treeherder names at most 20 per push.`;
  }
  return null;
}
