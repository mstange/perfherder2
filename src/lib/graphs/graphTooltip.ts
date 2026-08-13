// What the marks in the margins of the detail plot say when you point at them.
//
// **Pure**, and separate from the components for the usual reason: the wording is
// the part worth pinning, and every number in it has a convention behind it that
// the details pane states the same way. A tooltip that said "+12%" where the pane
// said "-12%" for the same alert would be worse than no tooltip.
//
// Two rules both of these follow, from docs/graphs.md, "The three change cards
// say it the same way":
//
// - **The sign is the measurement's, never the verdict's.** `amountPct` on an
//   alert is a magnitude; `isRegression` carries the direction. So the percentage
//   goes through `signedAmountFraction`, and the word beside it is separate.
// - **Say which window a number is over.** The alert's figures are perfherder's
//   window averages, a detected change's are means over up to 24 pushes a side,
//   and the comparison card a click leads to quotes the two builds alone. All
//   three are different numbers about the same event, and each has to say which
//   it is or a reader takes two of them for a contradiction.

import { formatPValue, formatSignedPercent, formatSignedValue, formatValue } from '../shared/chart';
import type { TooltipContent } from '../shared/tooltip';
import { alertDelta, alertStatusLabel, signedAmountFraction, summaryStatusLabel } from './alerts';
import type { SeriesAlert } from './alerts';
import type { DetectedChange } from './changes';

// Everything about the series a mark belongs to that its tooltip needs.
export type MarkContext = {
  // The measurement unit, or '' when the metadata hasn't landed.
  unit: string;
  // How to name the series — null when only one is plotted, where "which series
  // is this?" cannot arise and the line would be a third of the box.
  label: string | null;
  // The series' plot color, for the swatch beside that label.
  color: string;
};

function withUnit(text: string, unit: string): string {
  return unit ? `${text} ${unit}` : text;
}

function source(ctx: MarkContext): TooltipContent['source'] {
  return ctx.label ? { label: ctx.label, color: ctx.color } : undefined;
}

function verdict(isRegression: boolean): string {
  return isRegression ? 'regression' : 'improvement';
}

// `formatPValue` reports a floor as "<0.001", which needs no "=" in front of it.
function pClause(p: number): string {
  const text = formatPValue(p);
  return text.startsWith('<') ? `p ${text}` : `p = ${text}`;
}

// A movement from one level to another, as both ends and the difference between
// them: "283.5 → 318.7 ms (+35.2)". The delta is redundant with the two values
// and worth its characters anyway — the percentage in the title is the headline,
// and this is the only place the absolute size of the move is stated.
function transition(before: number, after: number, unit: string): string {
  return `${withUnit(`${formatValue(before)} → ${formatValue(after)}`, unit)} (${formatSignedValue(
    after - before,
  )})`;
}

// A perfherder alert triangle.
//
// The status line is the pane's Alert card in one row, and it is the reason this
// tooltip is worth having at all: a triangle says "something was flagged here"
// and nothing else, where the *interesting* part is often that a sheriff has
// already looked and called it invalid, or filed the bug that is open in the next
// tab.
export function alertTooltip(alert: SeriesAlert, ctx: MarkContext): TooltipContent {
  const status = [
    `Alert #${alert.summaryId}`,
    alertStatusLabel(alert.alertStatus),
    `summary ${summaryStatusLabel(alert.summaryStatus)}`,
  ];
  if (alert.bugNumber !== null) status.push(`bug ${alert.bugNumber}`);
  return {
    title: `Perfherder alert · ${verdict(alert.isRegression)} ${formatSignedPercent(
      signedAmountFraction(alert),
    )}`,
    lines: [
      transition(alert.prevValue, alert.newValue, ctx.unit),
      // Spelled out because it is not what it looks like: these are
      // `historical_stats["avg"]` and `forward_stats["avg"]`, means over a window
      // of pushes, not the two builds either side. See the Alert card.
      'Window averages: 12–24 pushes before against 12 after',
      status.join(' · '),
    ],
    source: source(ctx),
    hint: 'Click to compare this push with the one before it.',
  };
}

// A detected-change bar.
//
// The load-bearing line is the last one. The bars are a five-pixel strip along
// the floor of the plot that look like part of the chrome, and the first thing
// anyone needs to know about them is that they are *this page's* reading and not
// perfherder's verdict — which is what tells a reader why there is a bar where no
// triangle is, and why no bug number will ever be attached to one.
export function changeTooltip(change: DetectedChange, ctx: MarkContext): TooltipContent {
  return {
    title: `Detected change · ${verdict(change.isRegression)} ${formatSignedPercent(
      change.relativeChange,
    )}`,
    lines: [
      transition(change.beforeValue, change.afterValue, ctx.unit),
      `Means over ${change.beforeCount} pushes before against ${change.afterCount} after` +
        ` · ${pClause(change.pValue)}, ${change.effectSize} effect`,
      'Found in the data by this page, not a perfherder alert.',
    ],
    source: source(ctx),
    hint: 'Click to compare the two pushes either side of the step.',
  };
}
