// The controller's two subtle rules: who is allowed to close a tooltip, and when
// opening one costs a delay. Both are reachable by ordinary pointer paths across
// the marks in the plot's margins, and neither is visible in the placement
// arithmetic.
//
// `.test.svelte.ts` because the class holds `$state` — see docs/design.md,
// "Testing".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipController } from './tooltipState.svelte';
import type { Anchor, TooltipContent } from './tooltip';

const AT = (x: number): Anchor => ({ x, y: 100 });
const ALERT: TooltipContent = { title: 'Perfherder alert', lines: ['+12%'] };
const CHANGE: TooltipContent = { title: 'Detected change', lines: ['+9%'] };

let tip: TooltipController;
// Two owners, which in the app are two ScatterChart instances.
const chartA = {};
const chartB = {};

beforeEach(() => {
  vi.useFakeTimers();
  tip = new TooltipController(350, 300);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('opening', () => {
  it('waits for the delay before the first tooltip', () => {
    tip.show(chartA, ALERT, AT(10));
    expect(tip.visible).toBe(false);
    vi.advanceTimersByTime(349);
    expect(tip.visible).toBe(false);
    vi.advanceTimersByTime(1);
    expect(tip.content).toBe(ALERT);
  });

  it('takes the latest anchor and content when the delay expires', () => {
    tip.show(chartA, ALERT, AT(10));
    tip.show(chartA, ALERT, AT(40));
    vi.advanceTimersByTime(350);
    expect(tip.anchor).toEqual(AT(40));
  });

  it('swaps instantly while one is already open', () => {
    tip.show(chartA, ALERT, AT(10));
    vi.advanceTimersByTime(350);
    tip.show(chartB, CHANGE, AT(60));
    expect(tip.content).toBe(CHANGE);
  });

  // Scanning along a row of bars leaves and re-enters the band between them;
  // paying the delay at every stop reads as lag.
  it('reopens instantly inside the warm window after a close', () => {
    tip.show(chartA, ALERT, AT(10));
    vi.advanceTimersByTime(350);
    tip.hide(chartA);
    vi.advanceTimersByTime(299);
    tip.show(chartB, CHANGE, AT(60));
    expect(tip.visible).toBe(true);
  });

  it('pays the delay again once the warm window has passed', () => {
    tip.show(chartA, ALERT, AT(10));
    vi.advanceTimersByTime(350);
    tip.hide(chartA);
    vi.advanceTimersByTime(300);
    tip.show(chartB, CHANGE, AT(60));
    expect(tip.visible).toBe(false);
    vi.advanceTimersByTime(350);
    expect(tip.visible).toBe(true);
  });

  // A pointer that crosses a mark on its way somewhere else must not leave a
  // tooltip queued behind it.
  it('cancels a pending tooltip on leave', () => {
    tip.show(chartA, ALERT, AT(10));
    tip.hide(chartA);
    vi.advanceTimersByTime(1000);
    expect(tip.visible).toBe(false);
  });
});

describe('ownership', () => {
  it('ignores a close from something that is not showing', () => {
    tip.show(chartA, ALERT, AT(10));
    vi.advanceTimersByTime(350);
    tip.hide(chartB);
    expect(tip.visible).toBe(true);
  });

  // Which is what lets a caller call `hide` unconditionally whenever its hit test
  // comes back empty.
  it('survives an open and a stale close arriving out of order', () => {
    tip.show(chartA, ALERT, AT(10));
    vi.advanceTimersByTime(350);
    tip.show(chartB, CHANGE, AT(60));
    tip.hide(chartA);
    expect(tip.content).toBe(CHANGE);
  });

  it('closes for anyone on hideAll, with no warm window after it', () => {
    tip.show(chartA, ALERT, AT(10));
    vi.advanceTimersByTime(350);
    tip.hideAll();
    expect(tip.visible).toBe(false);
    tip.show(chartB, CHANGE, AT(60));
    expect(tip.visible).toBe(false);
  });
});

describe('measurement key', () => {
  it('holds still while the pointer moves inside one mark', () => {
    tip.show(chartA, { ...ALERT }, AT(10));
    vi.advanceTimersByTime(350);
    const key = tip.key;
    const content = tip.content;
    tip.show(chartA, { ...ALERT }, AT(11));
    expect(tip.key).toBe(key);
    // The same object, not an equal one: Tooltip.svelte measures when this
    // changes, and the caller builds a fresh content object on every move.
    expect(tip.content).toBe(content);
    expect(tip.anchor).toEqual(AT(11));
  });

  it('changes when the words do', () => {
    tip.show(chartA, ALERT, AT(10));
    vi.advanceTimersByTime(350);
    const key = tip.key;
    tip.show(chartA, CHANGE, AT(10));
    expect(tip.key).not.toBe(key);
  });
});
