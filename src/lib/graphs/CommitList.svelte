<script lang="ts">
  // One commit list, used in both places the pane shows commits: the range
  // behind a pinned comparison (ComparisonSection) and the selected push's own
  // (DetailsPane's Build section).
  //
  // It exists because those were two implementations of the same rows — each
  // with its own message splitting, its own bug links, its own revision markup
  // and its own truncation rule, and only one of them had the truncation rule
  // right. Two rows that answer the same question should not be able to drift.
  //
  // Rows are two lines: the bug links and title, then the revision and author.
  // The title wraps rather than truncating — a commit summary cut off at the
  // pane's width loses the half that says what changed.
  //
  // *Every* bug the summary names is linked, not just the first. `pushlog.ts`
  // already restricts `bugs` to the summary line and says why, so a second
  // entry means the summary really did name two bugs — dropping it would hide
  // half of what the commit says it is, and the CLI's commit table prints them
  // all, which would leave two views of one field disagreeing.

  import { bugUrl, revisionUrl, shortRevision } from '../shared/links';
  import type { RepoLinkInfo } from '../shared/links';
  import { commitTitle, type Commit } from './pushlog';

  type Props = { commits: Commit[]; repoLink: RepoLinkInfo | null };
  let { commits, repoLink }: Props = $props();
</script>

<ul class="commits">
  {#each commits as commit (commit.revision)}
    <li>
      <div class="commit-summary">
        {#each commit.bugs as bug, i (bug)}{#if i > 0}{', '}{/if}<a
            class="commit-bug"
            href={bugUrl(bug)}
            target="_blank"
            rel="noopener">Bug {bug}</a
          >{/each}{#if commit.bugs.length > 0}{' '}{/if}<span
          title={commit.body || undefined}>{commitTitle(commit)}</span
        >
      </div>
      <div class="commit-meta muted">
        {#if repoLink}<a
            class="mono"
            href={revisionUrl(repoLink, commit.revision)}
            target="_blank"
            rel="noopener">{shortRevision(commit.revision)}</a
          >{:else}<span class="mono">{shortRevision(commit.revision)}</span>{/if}
        · {commit.author}
      </div>
    </li>
  {/each}
</ul>

<style>
  .commits {
    margin: 6px 0 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .commit-summary {
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  /* The space after the badge is a real `{' '}` text node in the markup, not a
     margin and not generated content: both of those render a gap that vanishes
     on copy-paste, giving "Bug 2056944Skip the login advisory". See design.md,
     "Whitespace between adjacent badges". */
  .commit-bug {
    white-space: nowrap;
  }

  .commit-meta {
    line-height: 1.35;
  }
</style>
