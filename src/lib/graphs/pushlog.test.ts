import { describe, expect, it } from "vitest";
import type { Push } from "./graphApi";
import {
  authorName,
  commitsInRange,
  commitsOfPush,
  commitTitle,
  pushlogCaveat,
  pushlogLabel,
  type PushlogRange,
} from "./pushlog";

// A push with `count` revisions, of which `named` are actually serialized —
// which is how treeherder answers for a merge: `revision_count` is the truth
// and `revisions` is capped at 20.
function push(
  id: number,
  revision: string,
  opts: { count?: number; named?: string[]; timestamp?: number } = {},
): Push {
  const named = opts.named ?? [revision];
  return {
    id,
    revision,
    author: "pusher@example.com",
    push_timestamp: opts.timestamp ?? 1_700_000_000,
    revision_count: opts.count ?? named.length,
    revisions: named.map((rev, i) => ({
      revision: rev,
      author: `Dev ${i} <dev${i}@example.com>`,
      comments: `Bug ${1000 + i} - commit ${rev}\n\nBody of ${rev}`,
    })),
  };
}

describe("authorName", () => {
  it('takes the display name out of "Name <email>"', () => {
    expect(authorName("Francesco Lodolo <flod@lodolo.net>")).toBe(
      "Francesco Lodolo",
    );
  });

  it("keeps a bare address as-is", () => {
    expect(authorName("flod@lodolo.net")).toBe("flod@lodolo.net");
  });

  it("falls back to the address when the display name is empty", () => {
    // "<a@b>" with the name stripped would render as an empty cell.
    expect(authorName("<flod@lodolo.net>")).toBe("flod@lodolo.net");
  });
});

describe("commitsInRange", () => {
  // The correction that keeps the inline list agreeing with the hg pushlog
  // link beside it: treeherder includes the `fromchange` push, hg excludes it.
  it("drops the base push", () => {
    const range = commitsInRange(
      [push(3, "ccc"), push(2, "bbb"), push(1, "aaa")],
      "aaa",
      false,
    );
    expect(range.commits.map((c) => c.revision)).toEqual(["ccc", "bbb"]);
    expect(range.pushCount).toBe(2);
  });

  it("keeps everything when the base push is not in the response", () => {
    const range = commitsInRange(
      [push(3, "ccc"), push(2, "bbb")],
      "zzz",
      false,
    );
    expect(range.commits).toHaveLength(2);
  });

  it("is empty when the range is just the base push", () => {
    const range = commitsInRange([push(1, "aaa")], "aaa", false);
    expect(range.commits).toEqual([]);
    expect(range.pushCount).toBe(0);
  });

  it("flattens a multi-commit push newest first, preserving order", () => {
    const range = commitsInRange(
      [push(2, "tip", { named: ["tip", "mid", "old"] })],
      "x",
      false,
    );
    expect(range.commits.map((c) => c.revision)).toEqual(["tip", "mid", "old"]);
    // All three came from the one push.
    expect(range.pushCount).toBe(1);
    expect(range.commits.every((c) => c.pushId === 2)).toBe(true);
  });

  it("counts the commits a capped merge push did not name", () => {
    const merge = push(2, "tip", { named: ["tip", "second"], count: 164 });
    const range = commitsInRange([merge], "x", false);
    expect(range.commits).toHaveLength(2);
    expect(range.hiddenRevisions).toBe(162);
  });

  it("does not count hidden revisions of the dropped base push", () => {
    const base = push(1, "aaa", { named: ["aaa"], count: 50 });
    const range = commitsInRange([push(2, "bbb"), base], "aaa", false);
    expect(range.hiddenRevisions).toBe(0);
  });

  it("splits the message and links the bug from the summary only", () => {
    const p: Push = {
      ...push(2, "abc"),
      revisions: [
        {
          revision: "abc",
          author: "A Dev <a@example.com>",
          comments:
            "Bug 2058227 - Integrate the thing r=reviewer\n\nDepends on bug 999999",
        },
      ],
    };
    const [commit] = commitsInRange([p], "x", false).commits;
    expect(commit.summary).toBe("Bug 2058227 - Integrate the thing r=reviewer");
    expect(commit.body).toBe("Depends on bug 999999");
    // The body's "depends on" bug is not what this commit is.
    expect(commit.bugs).toEqual([2058227]);
    expect(commit.author).toBe("A Dev");
  });

  it("carries truncation through", () => {
    expect(commitsInRange([push(2, "bbb")], "x", true).truncated).toBe(true);
  });
});

describe("commitsOfPush", () => {
  it("projects one push the same way a range of one does", () => {
    const p = push(2, "tip", { named: ["tip", "second"] });
    expect(commitsOfPush(p).commits).toEqual(
      commitsInRange([p], "x", false).commits,
    );
  });

  // The Build section used to guard on `revisions.length > 20`, which the
  // serializer's own cap makes unreachable: a 164-commit merge showed twenty
  // under a heading saying 164, with nothing to say the rest existed.
  it("counts what a capped merge did not name", () => {
    const merge = push(2, "tip", {
      named: Array.from({ length: 20 }, (_, i) => `r${i}`),
      count: 164,
    });
    const { commits, hiddenRevisions } = commitsOfPush(merge);
    expect(commits).toHaveLength(20);
    expect(hiddenRevisions).toBe(144);
    // The check the old code made, and why it could never fire.
    expect(merge.revisions.length > 20).toBe(false);
  });

  it("hides nothing for an ordinary single-commit push", () => {
    expect(commitsOfPush(push(2, "abc")).hiddenRevisions).toBe(0);
  });
});

describe("commitTitle", () => {
  const commit = (summary: string, bugs: number[]) => ({
    revision: "r",
    author: "A",
    summary,
    body: "",
    bugs,
    pushId: 1,
    pushTimestamp: 0,
  });

  it("strips the leading bug when it is the one being linked", () => {
    expect(
      commitTitle(commit("Bug 2058227 - Integrate the thing", [2058227])),
    ).toBe("Integrate the thing");
  });

  it("accepts a colon separator", () => {
    expect(commitTitle(commit("Bug 123456: do it", [123456]))).toBe("do it");
  });

  // Both of these came out of one real 254-commit range.
  it("accepts a full stop separator", () => {
    expect(
      commitTitle(commit("Bug 2055222. Add qcms_profile_create", [2055222])),
    ).toBe("Add qcms_profile_create");
  });

  it("accepts a run-on message when the next word starts a sentence", () => {
    expect(
      commitTitle(commit("Bug 2057712 Update android nightly", [2057712])),
    ).toBe("Update android nightly");
  });

  // Same shape as the run-on case, and stripping it would leave "and bug …".
  it("keeps a run-on message that continues into another bug", () => {
    expect(
      commitTitle(commit("Bug 12345 and bug 6789 - fix both", [12345, 6789])),
    ).toBe("Bug 12345 and bug 6789 - fix both");
  });

  // Otherwise the row would read as being about a bug it isn't linking.
  it("keeps the text when the leading bug is not the linked one", () => {
    expect(commitTitle(commit("Bug 111111 - part two", [222222]))).toBe(
      "Bug 111111 - part two",
    );
  });

  it("keeps a summary that does not start with a bug", () => {
    expect(commitTitle(commit("Backed out changeset abc", []))).toBe(
      "Backed out changeset abc",
    );
  });

  it("keeps a summary whose bug is mentioned mid-sentence", () => {
    expect(
      commitTitle(commit("Follow-up to bug 2058227 - tweak", [2058227])),
    ).toBe("Follow-up to bug 2058227 - tweak");
  });
});

describe("pushlogLabel", () => {
  const range = (over: Partial<PushlogRange>): PushlogRange => ({
    commits: [],
    pushCount: 0,
    hiddenRevisions: 0,
    truncated: false,
    ...over,
  });
  const commits = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      revision: `r${i}`,
      author: "A",
      summary: "s",
      body: "",
      bugs: [],
      pushId: 1,
      pushTimestamp: 0,
    }));

  it("counts an exact list", () => {
    expect(pushlogLabel(range({ commits: commits(12) }))).toBe("12 commits");
  });

  it("says no commits for an empty range", () => {
    expect(pushlogLabel(range({}))).toBe("no commits");
  });

  it("singularizes one", () => {
    expect(pushlogLabel(range({ commits: commits(1) }))).toBe("1 commit");
  });

  it("shows shown-of-total when a merge hid some", () => {
    expect(
      pushlogLabel(range({ commits: commits(20), hiddenRevisions: 144 })),
    ).toBe("20 of 164 commits");
  });

  // The total is itself a floor once the range was cut, so it must not print
  // as a precise number.
  it("marks the total as a floor when the range was truncated", () => {
    expect(
      pushlogLabel(
        range({ commits: commits(20), hiddenRevisions: 144, truncated: true }),
      ),
    ).toBe("20 of 164+ commits");
  });

  it("marks a floor even when nothing was hidden within a push", () => {
    expect(
      pushlogLabel(range({ commits: commits(200), truncated: true })),
    ).toBe("200 of 200+ commits");
  });
});

describe("pushlogCaveat", () => {
  const base: PushlogRange = {
    commits: [],
    pushCount: 0,
    hiddenRevisions: 0,
    truncated: false,
  };

  it("is null when the list is complete", () => {
    expect(pushlogCaveat(base)).toBeNull();
  });

  it("explains a capped merge", () => {
    expect(pushlogCaveat({ ...base, hiddenRevisions: 144 })).toMatch(
      /144 further commits/,
    );
  });

  it("singularizes one hidden commit", () => {
    expect(pushlogCaveat({ ...base, hiddenRevisions: 1 })).toMatch(
      /1 further commit is/,
    );
  });

  // Truncation wins: when both are true the range cap is the bigger lie.
  it("reports truncation ahead of hidden revisions", () => {
    expect(
      pushlogCaveat({ ...base, hiddenRevisions: 5, truncated: true }),
    ).toMatch(/newest 200 pushes/);
  });
});
