<script lang="ts">
  // The comparison panel: the card for the pair (ComparisonSection), and under
  // it the commits that landed between the two ends. The point panel beside it
  // (DetailsPane) describes one end at a time; this is the one place that is
  // about both. See docs/design.md, "The selection is two panels".
  //
  // The commit list used to be a collapsed disclosure inside the card, because
  // the card sat at the top of a single pane and an open 254-commit list pushed
  // the value, the job and the build 16,000px down. Here it is last in a panel
  // of its own, so it is open: nothing is under it to push.

  import './detailsPane.css';
  import type { AppState } from './appState.svelte';
  import ComparisonSection from './ComparisonSection.svelte';
  import CommitList from './CommitList.svelte';
  import { comparisonLinks } from './compare';
  import { pushlogCaveat, pushlogLabel } from './pushlog';

  // `scroll` false where the shell stacks both panels in one scroller of its
  // own; see `SelectionSplit` in layout.ts.
  type Props = { app: AppState; scroll?: boolean };
  let { app, scroll = true }: Props = $props();

  const cmp = $derived(app.comparison);

  // Both sides share a repository whenever there is a range at all (appState,
  // `pushlogRangeRef`), so the base's record is the right one for every row.
  const repoLink = $derived(cmp ? app.repoLinkFor(cmp.base.ref.repository) : null);
  const pushlogUrl = $derived(cmp ? comparisonLinks(cmp, repoLink).pushlog : null);
  const pushlogRange = $derived(app.pushlogRange);
</script>

<aside class="details" class:flow={!scroll}>
  <header><h2>Comparison</h2></header>

  {#if !app.selection}
    <p class="empty">Select a point first. This panel compares it with a second one.</p>
  {:else}
    <div class="scroll">
      <ComparisonSection {app} />

      <!-- What landed in the range: present exactly when the card's pushlog link
           is, since both read `pushlogRangeRef`. The heading carries the count
           in every state, loading included, so the list arriving moves nothing
           above it. -->
      {#if app.pushlogStatus !== 'absent'}
        <section class="commits">
          <h3>
            {#if pushlogRange}{pushlogLabel(pushlogRange)}{:else}Commits{/if}
          </h3>
          {#if app.pushlogStatus === 'loading'}
            <p class="muted">loading…</p>
          {:else if app.pushlogStatus === 'failed'}
            <p class="muted">
              Commit lookup failed.
              {#if pushlogUrl}
                <a href={pushlogUrl} target="_blank" rel="noopener">Pushlog</a>.
              {/if}
            </p>
          {:else if pushlogRange}
            {#if pushlogCaveat(pushlogRange)}
              <p class="muted caveat">
                {pushlogCaveat(pushlogRange)}
                {#if pushlogUrl}
                  <a href={pushlogUrl} target="_blank" rel="noopener">Full pushlog</a>.
                {/if}
              </p>
            {/if}
            <CommitList commits={pushlogRange.commits} {repoLink} />
          {/if}
        </section>
      {/if}
    </div>
  {/if}
</aside>

<style>
  .commits p {
    margin: 0;
    font-size: 11px;
  }
  .caveat {
    margin-bottom: 6px;
  }
</style>
