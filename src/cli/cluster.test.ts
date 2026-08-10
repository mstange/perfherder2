import { describe, expect, it } from 'vitest';
import { clusterLandings, peakChange, type LandingEvent } from './cluster';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 6, 15, 6, 0, 0);

function event(overrides: Partial<LandingEvent> = {}): LandingEvent {
  return {
    ref: 'autoland,1,13',
    label: 'win',
    repository: 'autoland',
    atMs: T0,
    prevAtMs: T0 - 6 * HOUR,
    revision: 'after0000000',
    prevRevision: 'before000000',
    isRegression: true,
    relativeChange: 0.1,
    source: 'detected',
    alertSummaryId: null,
    bugNumber: null,
    ...overrides,
  };
}

describe('clusterLandings', () => {
  it('joins events whose brackets overlap, though each names a different revision', () => {
    // The case from the trial: one landing, placed by three platforms on three
    // pushes hours apart, because no two of them run the same pushes.
    const landings = clusterLandings([
      event({ label: 'win', atMs: T0 + 6 * HOUR, prevAtMs: T0, revision: 'r67861311e98' }),
      event({ label: 'mac', atMs: T0 + 3 * HOUR, prevAtMs: T0 - 2 * HOUR, revision: 'r4d11378e3f0' }),
      event({ label: 'linux', atMs: T0 + 4 * HOUR, prevAtMs: T0 + HOUR, revision: 'r00e66d72095' }),
    ]);
    expect(landings).toHaveLength(1);
    expect(landings[0].events.map((e) => e.label)).toEqual(['mac', 'linux', 'win']);
  });

  it('narrows the window to what the members agree on', () => {
    // Three brackets of six, five and three hours intersect in one: latest open
    // against earliest close. That is tighter than any member on its own, which
    // is the whole reason to group on intervals rather than on push ids.
    const landings = clusterLandings([
      event({ label: 'a', prevAtMs: T0, atMs: T0 + 6 * HOUR }),
      event({ label: 'b', prevAtMs: T0 + 2 * HOUR, atMs: T0 + 7 * HOUR }),
      event({ label: 'c', prevAtMs: T0 + HOUR, atMs: T0 + 3 * HOUR }),
    ]);
    expect(landings).toHaveLength(1);
    expect(landings[0].intersects).toBe(true);
    expect(landings[0].startMs).toBe(T0 + 2 * HOUR);
    expect(landings[0].endMs).toBe(T0 + 3 * HOUR);
  });

  it('keeps events on separate days apart', () => {
    // The trial had steps on the 14th, 15th, 16th, 18th, 20th and 22nd of one
    // month. Six-hour brackets a day apart must not chain into one landing.
    const landings = clusterLandings([
      event({ label: 'd14', prevAtMs: T0 - DAY - 6 * HOUR, atMs: T0 - DAY }),
      event({ label: 'd15', prevAtMs: T0 - 6 * HOUR, atMs: T0 }),
      event({ label: 'd16', prevAtMs: T0 + DAY - 6 * HOUR, atMs: T0 + DAY }),
    ]);
    expect(landings.map((l) => l.events.map((e) => e.label))).toEqual([['d14'], ['d15'], ['d16']]);
  });

  it('joins brackets that meet exactly on one push', () => {
    // Adjacent rather than overlapping: a landing on the shared push satisfies
    // both, so `<=` is the right comparison.
    const landings = clusterLandings([
      event({ label: 'earlier', prevAtMs: T0 - 6 * HOUR, atMs: T0 }),
      event({ label: 'later', prevAtMs: T0, atMs: T0 + 6 * HOUR }),
    ]);
    expect(landings).toHaveLength(1);
    expect(landings[0].startMs).toBe(T0);
    expect(landings[0].endMs).toBe(T0);
  });

  it('says so when members chained without sharing an instant', () => {
    // A overlaps B, B overlaps C, A and C do not. One group, but the window is a
    // union and a weaker claim than an intersection, so it is flagged rather
    // than printed as though the members agreed on it.
    const landings = clusterLandings([
      event({ label: 'a', prevAtMs: T0, atMs: T0 + 2 * HOUR }),
      event({ label: 'b', prevAtMs: T0 + HOUR, atMs: T0 + 4 * HOUR }),
      event({ label: 'c', prevAtMs: T0 + 3 * HOUR, atMs: T0 + 5 * HOUR }),
    ]);
    expect(landings).toHaveLength(1);
    expect(landings[0].intersects).toBe(false);
    expect(landings[0].startMs).toBe(T0);
    expect(landings[0].endMs).toBe(T0 + 5 * HOUR);
  });

  it('groups a regression and an improvement at one instant, and counts both', () => {
    // Alert #51136: idb-open-many-seq up 10.8%, delete_duration down 35%, one
    // push, one bug. Splitting on direction would file the trade-off as two
    // unrelated events.
    const landings = clusterLandings([
      event({ label: 'time_duration', isRegression: true, relativeChange: 0.108, bugNumber: 2052152 }),
      event({ label: 'delete_duration', isRegression: false, relativeChange: -0.35, bugNumber: 2052152 }),
    ]);
    expect(landings).toHaveLength(1);
    expect(landings[0].regressions).toBe(1);
    expect(landings[0].improvements).toBe(1);
    expect(landings[0].bugs).toEqual([2052152]);
  });

  it('never merges across repositories', () => {
    // One change landing twice is two events with two revisions, not one event.
    const landings = clusterLandings([
      event({ repository: 'autoland', label: 'a' }),
      event({ repository: 'mozilla-central', label: 'b' }),
    ]);
    expect(landings).toHaveLength(2);
    expect(landings.map((l) => l.repository).sort()).toEqual(['autoland', 'mozilla-central']);
  });

  it('places an event with no previous push inside a landing rather than beside it', () => {
    // No `prevAtMs` brackets nothing, so it can only join by being contained.
    const inside = clusterLandings([
      event({ label: 'bracketed', prevAtMs: T0, atMs: T0 + 6 * HOUR }),
      event({ label: 'point', prevAtMs: null, atMs: T0 + 3 * HOUR }),
    ]);
    expect(inside).toHaveLength(1);

    const outside = clusterLandings([
      event({ label: 'bracketed', prevAtMs: T0, atMs: T0 + 6 * HOUR }),
      event({ label: 'point', prevAtMs: null, atMs: T0 + DAY }),
    ]);
    expect(outside).toHaveLength(2);
  });

  it('collects the distinct bugs, in first-seen order', () => {
    const landings = clusterLandings([
      event({ label: 'a', bugNumber: 2056884 }),
      event({ label: 'b', bugNumber: null }),
      event({ label: 'c', bugNumber: 2056884 }),
      event({ label: 'd', bugNumber: 2052152 }),
    ]);
    expect(landings[0].bugs).toEqual([2056884, 2052152]);
  });

  it('returns landings oldest first', () => {
    const landings = clusterLandings([
      event({ label: 'late', prevAtMs: T0 + DAY, atMs: T0 + DAY + HOUR }),
      event({ label: 'early', prevAtMs: T0, atMs: T0 + HOUR }),
    ]);
    expect(landings.map((l) => l.events[0].label)).toEqual(['early', 'late']);
  });

  it('has nothing to say about no events', () => {
    expect(clusterLandings([])).toEqual([]);
  });
});

describe('peakChange', () => {
  it('takes the largest move by magnitude, not the average of the reach', () => {
    // 500% on one platform and 8% on two others is a 500% event that did not
    // reach everywhere. Averaging it to 172% describes nothing that happened.
    const [landing] = clusterLandings([
      event({ label: 'linux', relativeChange: 5.44 }),
      event({ label: 'win', relativeChange: 0.08 }),
      event({ label: 'mac', relativeChange: 0.08 }),
    ]);
    expect(peakChange(landing)).toBe(5.44);
  });

  it('keeps the sign of the move it picked', () => {
    const [landing] = clusterLandings([
      event({ label: 'a', relativeChange: -0.67, isRegression: false }),
      event({ label: 'b', relativeChange: 0.09 }),
    ]);
    expect(peakChange(landing)).toBe(-0.67);
  });

  it('is null when every member is an alert with no detected step', () => {
    const [landing] = clusterLandings([event({ relativeChange: null, source: 'alert' })]);
    expect(peakChange(landing)).toBeNull();
  });
});
