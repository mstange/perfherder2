<script lang="ts">
  // The one line at the top of a card that says how much something moved.
  //
  // It exists because there were three of them — the comparison card, the alert
  // card and the detected-change card — and with all three on screen at once
  // (perfherder alerts on the push this app also detected a step on, and a
  // click on either pins the comparison) they said the same kind of thing three
  // different ways: "+306.1 ms (+4.9%)", "10.95%", "+8.9% (+535.71 ms)". Two of
  // them signed the measurement and one printed a magnitude, so on a
  // higher-is-better metric one regression read "−2 ms" and the next "2%".
  //
  // The rule, now in one place:
  //
  //   - **The percentage leads.** It is the number that compares across series
  //     and the one people quote at each other.
  //   - **The absolute follows, in parentheses, in the metric's own unit.** The
  //     percentage is not always the number that means anything: a signature
  //     whose alerting threshold is absolute (installer size sets 100 KB) has a
  //     real 340 KB regression showing here as −0.19%.
  //   - **Both are signed arithmetically** — the sign says which way the
  //     measurement went, never whether that was good. A card whose figures come
  //     as a magnitude has to supply the sign from its own before/after pair.
  //   - **The badge carries the verdict**, from the metric's direction, because
  //     the sign cannot: −2 ms is an improvement on a duration and a regression
  //     on a score.
  //
  // Falls back to the absolute as the lead when there is no percentage, which
  // happens when the baseline is zero and a ratio would be meaningless.

  import { formatSignedPercent, formatSignedValue } from '../shared/chart';

  type Props = {
    // A fraction, not a percentage: 0.089 prints as +8.9%.
    percent: number | null;
    delta: number | null;
    unit: string;
    // Null where the app deliberately declines to call it either — two
    // different series, or two retriggers of one build (see compare.ts).
    verdict: 'regression' | 'improvement' | null;
  };
  let { percent, delta, unit, verdict }: Props = $props();

  const hasPercent = $derived(percent !== null);
  const absolute = $derived(delta === null ? null : formatSignedValue(delta));
</script>

<p class="value">
  {#if hasPercent}
    {formatSignedPercent(percent as number)}
    {#if absolute !== null}
      <span class="muted">({absolute}{unit ? ` ${unit}` : ''})</span>
    {/if}
  {:else}
    {absolute ?? '0'}
    {#if unit}<span class="unit">{unit}</span>{/if}
  {/if}
  {#if verdict}
    <span class="verdict {verdict}">{verdict}</span>
  {/if}
</p>
