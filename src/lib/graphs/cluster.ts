// Change events from several series, grouped into the landings that caused them.
// **Pure.**
//
// Under `src/lib` rather than `src/cli`, though the CLI is where it was written:
// dependencies run `src/cli` → `src/lib` and never back, and both callers now
// want it. The app clusters the bars of the series it has plotted (`appState`'s
// `landings`, the pane's Landing block), the CLI clusters the events of one
// `changes --cluster` run, and the grouping rule below has to be the same one or
// the two would disagree about what a landing is.
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
//
// `Payload` is whatever the caller wants handed back inside the landing. The
// CLI has nothing to add — the fields below are its whole row — while the app
// clusters live state and wants the series entry and the `DetectedChange` back,
// so that the pane can list the other series a landing was seen in and a click
// on one can select its bar. Grouping never reads it.
export type LandingEvent<Payload = undefined> = {
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
  payload: Payload;
};

export type Landing<Payload = undefined> = {
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
  events: LandingEvent<Payload>[];
  regressions: number;
  improvements: number;
  // Distinct bugs any member's alert was filed as, in first-seen order. The
  // answer to "is this one already known".
  bugs: number[];
};

// An event with no `prevAtMs` brackets nothing, so it can only join a landing by
// being *inside* one. Treating it as a zero-width interval at `atMs` does
// exactly that, and keeps one code path.
function bracket(event: LandingEvent<unknown>): { start: number; end: number } {
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
export function clusterLandings<Payload>(
  events: readonly LandingEvent<Payload>[],
): Landing<Payload>[] {
  const byRepo = new Map<string, LandingEvent<Payload>[]>();
  for (const event of events) {
    const list = byRepo.get(event.repository);
    if (list) list.push(event);
    else byRepo.set(event.repository, [event]);
  }

  const landings: Landing<Payload>[] = [];
  for (const [repository, group] of byRepo) {
    // Sorted by where each bracket opens, so one sweep finds the components: an
    // event joins the group being built when it opens no later than the latest
    // close seen in it.
    const sorted = [...group].sort((a, b) => bracket(a).start - bracket(b).start);
    let current: LandingEvent<Payload>[] = [];
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

function describeLanding<Payload>(
  repository: string,
  events: readonly LandingEvent<Payload>[],
): Landing<Payload> {
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
export function peakChange(landing: Landing<unknown>): number | null {
  const changes = landing.events
    .map((e) => e.relativeChange)
    .filter((c): c is number => c !== null);
  if (changes.length === 0) return null;
  return changes.reduce((best, c) => (Math.abs(c) > Math.abs(best) ? c : best), changes[0]);
}

/**
 * How many distinct series saw the landing — its *reach*, which is the number
 * both views lead with.
 *
 * Not `events.length`. Two consecutive bars in one series bracket intervals
 * that meet at the push between them, and `clusterLandings` joins brackets that
 * meet, so one series can contribute two events to one landing. Counting rows
 * would then report "3 series" over two lines.
 */
export function landingSeriesCount(landing: Landing<unknown>): number {
  return new Set(landing.events.map((e) => e.ref)).size;
}

const HOUR_MS = 3_600_000;

export function windowHours(landing: Landing<unknown>): number {
  return (landing.endMs - landing.startMs) / HOUR_MS;
}

/**
 * How wide a landing's window is, in hours, as text.
 *
 * Exactly zero is a landing pinned to one push, which is the strongest thing
 * either view says; a window of four minutes is not the same claim and must not
 * round into looking like it.
 */
export function formatWindowHours(landing: Landing<unknown>): string {
  const hours = windowHours(landing);
  if (hours === 0) return '0';
  if (hours < 0.1) return '<0.1';
  return hours < 10 ? hours.toFixed(1) : String(Math.round(hours));
}

/**
 * The claim a landing makes about *where* it is, in one phrase.
 *
 * Three of them, and the difference between them is the whole value of the
 * grouping: a landing pinned to a single push names a revision, a window says
 * "somewhere in these six hours", and a union says the members never agreed on
 * an instant at all and so is a weaker statement than either. Shared by the
 * CLI's `changes --cluster` and the pane's Landing block, because two views of
 * one grouping wording it differently is how a reader ends up thinking they are
 * two groupings.
 */
export function landingWindowLabel(landing: Landing<unknown>): string {
  const hours = windowHours(landing);
  if (!landing.intersects) return `${hours.toFixed(1)} h union — the members do not share an instant`;
  if (hours === 0) return 'pinned to one push';
  return `${formatWindowHours(landing)} h window`;
}

// ---------------------------------------------------------------------------
// The app's bars, as events
// ---------------------------------------------------------------------------

/**
 * What clustering needs to know about one plotted series. Structural rather
 * than the app's `SeriesEntry`, because `appState` imports this module and the
 * dependency cannot run both ways — and because the fields below are genuinely
 * all of it.
 */
export type BarSource<Payload, Change extends BarChange = BarChange> = {
  // Whatever identifies the series to the caller; only compared, never parsed.
  key: string;
  repository: string;
  // How the series should be named in a list of the landing's members.
  label: string;
  changes: readonly Change[];
  pushById: ReadonlyMap<number, { x: number; revision: string }>;
  // Handed back on every event this series contributes, so a member of a
  // landing can be got back to whatever the caller clusters — for the app, the
  // series entry a click has to select in.
  payload: Payload;
};

// The fields of `changes.ts`'s `DetectedChange` this reads. Named separately so
// the structural type above stays readable, and so a caller with its own step
// finding can use this without pretending to be the detector.
export type BarChange = {
  beforePushId: number;
  afterPushId: number;
  changeX: number;
  relativeChange: number;
  isRegression: boolean;
};

/**
 * Every series' detected changes as landing events, ready for
 * `clusterLandings`.
 *
 * **The bracket comes from the two pushes the bar sits between, not from the
 * bar's own extent.** A bar spans `x0`…`x1`, the window the test compared,
 * which is two dozen pushes wide and would join everything to everything. What
 * the bar actually establishes is that the step is in `(beforePush, afterPush]`
 * — see the module header — and that is the interval two platforms can honestly
 * be intersected on.
 *
 * A change whose "before" push is outside the loaded data leaves `prevAtMs`
 * null, which `bracket` reads as a zero-width interval: it can still join a
 * landing by being inside one, and cannot widen it.
 */
export function barEvents<Payload, Change extends BarChange>(
  series: readonly BarSource<Payload, Change>[],
): LandingEvent<{ series: Payload; change: Change }>[] {
  const events: LandingEvent<{ series: Payload; change: Change }>[] = [];
  for (const entry of series) {
    for (const change of entry.changes) {
      const after = entry.pushById.get(change.afterPushId);
      const before = entry.pushById.get(change.beforePushId);
      events.push({
        ref: entry.key,
        label: entry.label,
        repository: entry.repository,
        atMs: after?.x ?? change.changeX,
        prevAtMs: before?.x ?? null,
        revision: after?.revision ?? '',
        prevRevision: before?.revision ?? null,
        isRegression: change.isRegression,
        relativeChange: change.relativeChange,
        // Bars only. Perfherder's alerts are drawn as their own markers and are
        // not merged in here: deciding that an alert and a bar are one finding
        // is `reports.ts`'s `mergeFindings`, which the app has no equivalent of,
        // and a landing listing the same move twice would misreport its reach.
        source: 'detected',
        alertSummaryId: null,
        bugNumber: null,
        payload: { series: entry.payload, change },
      });
    }
  }
  return events;
}
