// Pure module, so a plain `.test.ts` — no runes, no DOM, no `$effect.root`.
// See docs/design.md "Testing" for when a test needs the `.test.svelte.ts`
// treatment instead.

import { describe, expect, it } from 'vitest';
import { TIME_RANGES } from './api';
import {
  MAX_BINS,
  MAX_IDS_PER_REQUEST,
  activityCacheKey,
  activityPath,
  activityTitle,
  binCounts,
  binDuration,
  buildActivities,
  chunkIds,
} from './activity';

const HOUR = 3600;
const DAY = 86400;

describe('activityCacheKey', () => {
  it('extends the series key with the interval, so a range change misses', () => {
    expect(activityCacheKey('autoland|227074', 1209600)).toBe('autoland|227074|1209600');
    expect(activityCacheKey('autoland|227074', 604800)).not.toBe(
      activityCacheKey('autoland|227074', 1209600),
    );
  });
});

describe('chunkIds', () => {
  it('splits into chunks of at most `size`', () => {
    expect(chunkIds([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns nothing for an empty list', () => {
    expect(chunkIds([], 150)).toEqual([]);
  });

  it('keeps a full chunk under treeherder’s request-line limit', () => {
    // The real constraint: 300 ids produced
    // "Request Line is too large (6069 > 4094)" from treeherder's frontend,
    // before Django ever saw the request. Each id costs
    // "&signature_id=NNNNNN" ≈ 21 bytes.
    const worstCase = MAX_IDS_PER_REQUEST * '&signature_id=2268310'.length;
    expect(worstCase).toBeLessThan(3600);
  });
});

describe('binDuration', () => {
  // The strip is ~72px wide, so more than MAX_BINS bars would be sub-pixel.
  // Within that cap we want the finest granularity available, hence
  // "smallest duration that fits" rather than "largest".
  it('picks the finest duration that stays within MAX_BINS', () => {
    expect(binDuration(172800)).toBe(3 * HOUR);
    expect(binDuration(604800)).toBe(12 * HOUR);
    expect(binDuration(1209600)).toBe(DAY);
    expect(binDuration(2592000)).toBe(2 * DAY);
    expect(binDuration(5184000)).toBe(4 * DAY);
    expect(binDuration(7776000)).toBe(4 * DAY);
  });

  it('stays within MAX_BINS for every range the dropdown offers', () => {
    for (const { value } of TIME_RANGES) {
      expect(Math.ceil(value / binDuration(value))).toBeLessThanOrEqual(MAX_BINS);
    }
  });

  it('falls back to the coarsest duration for an absurd range', () => {
    // Not reachable through the UI (`pi` must be one of the dropdown's
    // choices) but the function must still return something usable.
    expect(binDuration(400 * DAY)).toBe(7 * DAY);
  });
});

describe('binCounts', () => {
  const now = Date.UTC(2026, 7, 4, 12, 0, 0);

  it('returns all zeros for no timestamps', () => {
    expect(binCounts([], now, 1209600)).toEqual(new Array(14).fill(0));
  });

  it('counts a run into the bin containing it', () => {
    // 14 days, 1-day bins, end-aligned: the last bin is the 24h up to `now`.
    const counts = binCounts([now - 1000], now, 1209600);
    expect(counts).toHaveLength(14);
    expect(counts[13]).toBe(1);
    expect(counts.slice(0, 13)).toEqual(new Array(13).fill(0));
  });

  it('puts an older run in an earlier bin', () => {
    const counts = binCounts([now - 3 * DAY * 1000], now, 1209600);
    expect(counts[10]).toBe(1);
    expect(counts[13]).toBe(0);
  });

  it('accumulates several runs in one bin', () => {
    const counts = binCounts([now - 1000, now - 2000, now - 3000], now, 1209600);
    expect(counts[13]).toBe(3);
  });

  it('aligns bins to the end of the window, so the newest bar is full width', () => {
    // 90 days at 4-day bins is 22.5 bins. The half-width bin must be the
    // oldest one, at the far left: if it were the newest, the bar the eye
    // goes to would cover half the time of its neighbours and read as a
    // decline that isn't there.
    const counts = binCounts([], now, 7776000);
    expect(counts).toHaveLength(23);
    // One run in each of the last two bins' worth of time, 4 days apart.
    const withRuns = binCounts([now - 1000, now - 4 * DAY * 1000], now, 7776000);
    expect(withRuns[22]).toBe(1);
    expect(withRuns[21]).toBe(1);
  });

  it('clamps a timestamp past `now` into the last bin', () => {
    // The window bound is the server's clock; ours can be behind it.
    const counts = binCounts([now + 60_000], now, 1209600);
    expect(counts[13]).toBe(1);
  });

  it('clamps a timestamp older than the window into the first bin', () => {
    const counts = binCounts([now - 30 * DAY * 1000], now, 1209600);
    expect(counts[0]).toBe(1);
  });
});

describe('buildActivities', () => {
  const now = Date.UTC(2026, 7, 4, 12, 0, 0);
  const nowSec = Math.floor(now / 1000);

  it('regroups by signature_id, ignoring the hash keys', () => {
    // The response is keyed by signature_hash, which aliases within a repo:
    // two rows differing only by `application` share one. So two requested
    // series can arrive in a single bucket, and the keys are useless.
    const response = {
      sharedhash: [
        { signature_id: 1, push_timestamp: nowSec - 60 },
        { signature_id: 2, push_timestamp: nowSec - 120 },
        { signature_id: 1, push_timestamp: nowSec - 180 },
      ],
    };
    const out = buildActivities([1, 2], response, now, 1209600);
    expect(out.get(1)).toMatchObject({ total: 2 });
    expect(out.get(2)).toMatchObject({ total: 1 });
  });

  it('records 0 for a requested id the response omits entirely', () => {
    // Idle signatures are left out of the response, not returned empty. If
    // this returned nothing, the row would stay "loading" forever instead of
    // saying what is actually true: it has not run.
    const out = buildActivities([7], {}, now, 1209600);
    expect(out.get(7)).toEqual({
      counts: new Array(14).fill(0),
      total: 0,
      lastRunMs: null,
    });
  });

  it('ignores datums for ids that were not requested', () => {
    const response = { h: [{ signature_id: 99, push_timestamp: nowSec }] };
    const out = buildActivities([1], response, now, 1209600);
    expect(out.size).toBe(1);
    expect(out.get(1)).toMatchObject({ total: 0 });
  });

  it('converts push_timestamp from unix seconds to ms for lastRunMs', () => {
    // This endpoint sends an integer of seconds where /performance/summary/
    // sends a naive ISO string for the same column.
    const response = { h: [{ signature_id: 1, push_timestamp: nowSec - 3600 }] };
    const out = buildActivities([1], response, now, 1209600);
    expect(out.get(1)).toMatchObject({ lastRunMs: (nowSec - 3600) * 1000 });
  });

  it('reports the newest run regardless of response order', () => {
    // The endpoint orders by job_id, so the newest datum is not reliably
    // last — taking the max rather than the tail is load-bearing.
    const response = {
      h: [
        { signature_id: 1, push_timestamp: nowSec - 3600 },
        { signature_id: 1, push_timestamp: nowSec - 86400 },
        { signature_id: 1, push_timestamp: nowSec - 60 },
      ],
    };
    expect(buildActivities([1], response, now, 1209600).get(1)).toMatchObject({
      lastRunMs: (nowSec - 60) * 1000,
      total: 3,
    });
  });
});

describe('activityPath', () => {
  it('is empty when nothing ran, so the cell renders no bars at all', () => {
    expect(activityPath([0, 0, 0], 6, 4)).toBe('');
  });

  it('emits one subpath per non-zero bin, scaled to the tallest', () => {
    // width 6 / 3 bins => 2px per bin, 1px bar + 1px gap. The tallest bin
    // gets the full height; bin 0 is skipped because it is zero.
    expect(activityPath([0, 1, 2], 6, 4)).toBe('M2 2h1v2h-1z M4 0h1v4h-1z');
  });

  it('gives a bin with any runs at least one pixel', () => {
    // 1 run against a 500-run neighbour rounds to 0px, which would say
    // "never ran" — the opposite of the truth.
    expect(activityPath([1, 500], 4, 10)).toBe('M0 9h1v1h-1z M2 0h1v10h-1z');
  });

  it('returns empty for no bins rather than dividing by zero', () => {
    expect(activityPath([], 6, 4)).toBe('');
  });
});

describe('activityTitle', () => {
  const now = Date.UTC(2026, 7, 4, 12, 0, 0);

  it('says how many runs, over what window, and how long ago the last was', () => {
    expect(
      activityTitle(
        { counts: [1], total: 6, lastRunMs: now - 4 * 3600 * 1000 },
        '14 days',
        now,
      ),
    ).toBe('6 runs in 14 days · last run 4 hours ago');
  });

  it('does not pluralise a single run', () => {
    expect(
      activityTitle({ counts: [1], total: 1, lastRunMs: now - 61_000 }, '2 days', now),
    ).toBe('1 run in 2 days · last run 1 minute ago');
  });

  it('says so plainly when nothing ran, with no dangling last-run clause', () => {
    expect(
      activityTitle({ counts: [0], total: 0, lastRunMs: null }, '14 days', now),
    ).toBe('No runs in 14 days');
  });

  it('describes a very recent run without a bare "0 minutes ago"', () => {
    expect(
      activityTitle({ counts: [1], total: 1, lastRunMs: now - 5_000 }, '2 days', now),
    ).toBe('1 run in 2 days · last run just now');
  });

  it('switches to days past 48 hours', () => {
    expect(
      activityTitle(
        { counts: [1], total: 2, lastRunMs: now - 3 * DAY * 1000 },
        '14 days',
        now,
      ),
    ).toBe('2 runs in 14 days · last run 3 days ago');
  });
});
