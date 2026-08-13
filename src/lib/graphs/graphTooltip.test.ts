import { describe, expect, it } from 'vitest';
import { alertTooltip, changeTooltip, type MarkContext } from './graphTooltip';
import type { SeriesAlert } from './alerts';
import type { DetectedChange } from './changes';

const CTX: MarkContext = { unit: 'ms', label: null, color: '#0ac' };

function alert(over: Partial<SeriesAlert> = {}): SeriesAlert {
  return {
    summaryId: 51605,
    alertId: 900,
    pushId: 7,
    prevPushId: 6,
    x: 1_700_000_000_000,
    revision: 'abc123def456',
    prevRevision: 'def456abc123',
    isRegression: true,
    amountPct: 12.4,
    prevValue: 283.5,
    newValue: 318.7,
    tValue: 8.2,
    alertStatus: 0,
    summaryStatus: 0,
    bugNumber: null,
    reassignment: null,
    ...over,
  };
}

function change(over: Partial<DetectedChange> = {}): DetectedChange {
  return {
    index: 30,
    windowStart: 10,
    windowEnd: 50,
    beforeCount: 24,
    afterCount: 24,
    x0: 1_700_000_000_000,
    x1: 1_700_100_000_000,
    changeX: 1_700_050_000_000,
    beforeValue: 1240.5,
    afterValue: 1344.7,
    relativeChange: 0.084,
    isRegression: true,
    pValue: 0.002,
    effectSize: 'large',
    beforePushId: 6,
    afterPushId: 7,
    ...over,
  };
}

describe('alertTooltip', () => {
  it('leads with what the mark is, then the direction and the size', () => {
    expect(alertTooltip(alert(), CTX).title).toBe('Perfherder alert · regression +12%');
  });

  // `amountPct` is a magnitude and `isRegression` carries the direction, so an
  // improvement on a lower-is-better metric has to come out negative. Getting
  // this from the verdict instead is the mistake docs/graphs.md warns about.
  it('takes the sign from the measurement, not from the verdict', () => {
    const improved = alert({ isRegression: false, prevValue: 318.7, newValue: 283.5 });
    expect(alertTooltip(improved, CTX).title).toBe('Perfherder alert · improvement -12%');
  });

  // A regression can also be a *fall* — on a higher-is-better metric — and then
  // the sign and the word disagree, which is correct and is the case that proves
  // they are separate facts.
  it('says regression with a negative sign on a higher-is-better metric', () => {
    const fell = alert({ isRegression: true, prevValue: 318.7, newValue: 283.5 });
    expect(alertTooltip(fell, CTX).title).toBe('Perfherder alert · regression -12%');
  });

  it('states the transition with its unit and the absolute move', () => {
    expect(alertTooltip(alert(), CTX).lines?.[0]).toBe('283.5 → 318.7 ms (+35.2)');
  });

  it('leaves the unit out when the metadata has not landed', () => {
    expect(alertTooltip(alert(), { ...CTX, unit: '' }).lines?.[0]).toBe('283.5 → 318.7 (+35.2)');
  });

  // The reason a triangle is worth pointing at: the triage state is often the
  // whole answer, and the bug number is what the reader is really after.
  it('says which window the two values are over, since it is not the two builds', () => {
    expect(alertTooltip(alert(), CTX).lines?.[1]).toBe(
      'Window averages: 12–24 pushes before against 12 after',
    );
  });

  it('names the summary, both triage states and the bug', () => {
    const triaged = alert({ alertStatus: 4, summaryStatus: 8, bugNumber: 1899194 });
    expect(alertTooltip(triaged, CTX).lines?.[2]).toBe(
      'Alert #51605 · acknowledged · summary backedout · bug 1899194',
    );
  });

  it('leaves the bug out when there is none', () => {
    expect(alertTooltip(alert(), CTX).lines?.[2]).toBe(
      'Alert #51605 · untriaged · summary untriaged',
    );
  });

  it('names the series only when asked to', () => {
    expect(alertTooltip(alert(), CTX).source).toBeUndefined();
    expect(alertTooltip(alert(), { ...CTX, label: 'chrome' }).source).toEqual({
      label: 'chrome',
      color: '#0ac',
    });
  });
});

describe('changeTooltip', () => {
  it('says which windows the figures are over', () => {
    const tip = changeTooltip(change(), CTX);
    expect(tip.title).toBe('Detected change · regression +8.4%');
    expect(tip.lines?.[0]).toBe('1240.5 → 1344.7 ms (+104.2)');
    expect(tip.lines?.[1]).toBe(
      'Means over 24 pushes before against 24 after · p = 0.002, large effect',
    );
  });

  it('reports a floored p-value without an equals sign', () => {
    expect(changeTooltip(change({ pValue: 0.0000001 }), CTX).lines?.[1]).toContain('p <0.001');
  });

  // The one line that has to be there: a bar is not perfherder's verdict, which
  // is why one can sit where no triangle does.
  it("says the finding is this page's own", () => {
    expect(changeTooltip(change(), CTX).lines?.[2]).toBe(
      'Found in the data by this page, not a perfherder alert.',
    );
  });

  it('says what a click does', () => {
    expect(changeTooltip(change(), CTX).hint).toBe(
      'Click to compare the two pushes either side of the step.',
    );
  });
});
