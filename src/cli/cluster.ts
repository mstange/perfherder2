// Change events from several series, grouped into the landings that caused them.
// **Pure.**
//
// The gap this fills was found by using the tool. Asking "has IndexedDB
// regressed in six months" is asking about 21 signatures, and every command
// answers about one: the trial ran `changes --json` over four batches of refs and
// then wrote a script to flatten 99 events, sort them, and group them by push.
// That grouping was the finding — nine events across three platforms on
// 2026-07-15 are one landing, bug 1899194 — and it is the part the tool made the
// reader build. `--across` exists because assembling the *input* list by hand
// cost more commands than the analysis; this is the same complaint about the
// output.
//
// **Events are grouped by the interval they bracket, not by the push they were
// placed on.** A bar's position is an estimate — `locate` exists because it is —
// and two series on different platforms do not run the same pushes, so one
// landing is placed on a different revision by each of them. What is *not* an
// estimate is `(prevAtMs, atMs]`: whatever moved the graph landed in there.
// Overlapping brackets are therefore the honest join, and their intersection is a
// tighter window on the landing than any single series carries — three platforms
// each saying "somewhere in these six hours", of six different hours, agree about
// a narrower one.
//
// Direction is deliberately not part of the key. A regression on one metric and
// an improvement on another, at one instant, is a trade-off rather than a
// coincidence, and splitting on it would file the two halves of perfherder alert
// #51136 — idb-open-many-seq +10.8%, delete_duration -35%, one push, one bug — as
// unrelated events.

// One series' opinion that something happened, ready to be grouped.
export type LandingEvent = {
  // Which series, and what distinguishes it from the others in the run. Both
  // supplied by the caller: `reports.ts` already factors a ref list into shared
  // and distinguishing attributes, and repeating that here would be a second
  // idea of what a series is called.
  ref: string;
  label: string;
  repository: string;
  atMs: number;
  // Null when the push on the far side of the change is outside the fetched
  // range, which leaves the event a point rather than an interval.
  prevAtMs: number | null;
  revision: string;
  prevRevision: string | null;
  isRegression: boolean;
  // Null for an alert-only row, which carries a percentage but not this one.
  relativeChange: number | null;
  source: 'detected' | 'alert' | 'both';
  alertSummaryId: number | null;
  bugNumber: number | null;
};

export type Landing = {
  // The window the members agree the landing is in — the intersection of their
  // brackets when they have one, and the union when they do not (see
  // `intersects`).
  startMs: number;
  endMs: number;
  // False when the members chained into one group without sharing a common
  // instant: A overlaps B and B overlaps C, but A and C do not. Then the window
  // above is the union and is a weaker claim, so the report says which it is
  // rather than presenting the two the same way.
  intersects: boolean;
  repository: string;
  events: LandingEvent[];
  regressions: number;
  improvements: number;
  // Distinct bugs any member's alert was filed as, in first-seen order. The
  // answer to "is this one already known".
  bugs: number[];
};

// An event with no `prevAtMs` brackets nothing, so it can only join a landing by
// being *inside* one. Treating it as a zero-width interval at `atMs` does
// exactly that, and keeps one code path.
function bracket(event: LandingEvent): { start: number; end: number } {
  return { start: event.prevAtMs ?? event.atMs, end: event.atMs };
}

/**
 * Group events into landings, one repository at a time.
 *
 * Per repository because a push id and the moment a merge reached another branch
 * are different clocks: two events at one instant on autoland and
 * mozilla-central are the same change *landing twice*, and reporting them as one
 * row would claim a single event with two revisions. "Did the other branch see
 * it" is `step`'s question.
 *
 * Returned oldest first, which is the order a six-month sweep is read in.
 */
export function clusterLandings(events: readonly LandingEvent[]): Landing[] {
  const byRepo = new Map<string, LandingEvent[]>();
  for (const event of events) {
    const list = byRepo.get(event.repository);
    if (list) list.push(event);
    else byRepo.set(event.repository, [event]);
  }

  const landings: Landing[] = [];
  for (const [repository, group] of byRepo) {
    // Sorted by where each bracket opens, so one sweep finds the components: an
    // event joins the group being built when it opens no later than the latest
    // close seen in it.
    const sorted = [...group].sort((a, b) => bracket(a).start - bracket(b).start);
    let current: LandingEvent[] = [];
    let reach = -Infinity;

    const flush = () => {
      if (current.length > 0) landings.push(describeLanding(repository, current));
      current = [];
      reach = -Infinity;
    };

    for (const event of sorted) {
      const { start, end } = bracket(event);
      // `<=` rather than `<`: two brackets that meet exactly at a push share that
      // push, and a landing on it satisfies both.
      if (current.length > 0 && start <= reach) {
        current.push(event);
        reach = Math.max(reach, end);
      } else {
        flush();
        current = [event];
        reach = end;
      }
    }
    flush();
  }

  return landings.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

function describeLanding(repository: string, events: readonly LandingEvent[]): Landing {
  const brackets = events.map(bracket);
  const latestStart = Math.max(...brackets.map((b) => b.start));
  const earliestEnd = Math.min(...brackets.map((b) => b.end));
  const intersects = latestStart <= earliestEnd;

  const bugs: number[] = [];
  for (const event of events) {
    if (event.bugNumber !== null && !bugs.includes(event.bugNumber)) bugs.push(event.bugNumber);
  }

  return {
    startMs: intersects ? latestStart : Math.min(...brackets.map((b) => b.start)),
    endMs: intersects ? earliestEnd : Math.max(...brackets.map((b) => b.end)),
    intersects,
    repository,
    // Oldest first within the landing, so a reader comparing two rows is
    // comparing them in one order.
    events: [...events].sort((a, b) => a.atMs - b.atMs),
    regressions: events.filter((e) => e.isRegression).length,
    improvements: events.filter((e) => !e.isRegression).length,
    bugs,
  };
}

/**
 * The largest relative change among a landing's events, by magnitude.
 *
 * For ranking landings by "how big was this", which is the column a reader scans
 * first. The *largest* rather than the mean, because a landing that moved one
 * platform 500% and two others 8% is a 500% event with a partial reach, and
 * averaging it to 172% describes nothing that happened.
 */
export function peakChange(landing: Landing): number | null {
  const changes = landing.events
    .map((e) => e.relativeChange)
    .filter((c): c is number => c !== null);
  if (changes.length === 0) return null;
  return changes.reduce((best, c) => (Math.abs(c) > Math.abs(best) ? c : best), changes[0]);
}
