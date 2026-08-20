// perfherder-cli — a command-line front end to the same code the app runs on.
//
// Built from src/lib, not beside it: every projection, statistic and API quirk
// this prints is the app's own, so an answer given here and the same answer read
// off the graph cannot disagree. The commands mirror what the UI can do —
// `search` is the picker, `series` is the series list's summary, `changes` is
// the alert markers and the detected-change bars, `compare` is the details
// pane's comparison card — and every one of them prints a URL that opens the
// same view in the app, because a text answer that can't be checked against the
// picture is a text answer nobody should act on.
//
// Structure: this file does argument dispatch, fetching (via load.ts) and
// printing. Everything that decides what an answer *is* lives in the pure
// modules beside it — args, format, modes, reports, render — which is where the
// tests are.

import { HttpError, SchemaError } from '../lib/shared/http';
import { shortRevision } from '../lib/shared/links';
import { DEFAULT_REPOS, PINNED_REPOS } from '../lib/picker/pickerOptions';
import { FILTER_FIELDS } from '../lib/picker/filter';
import type { PushGroup } from '../lib/graphs/graphData';
import { CHANGE_ALPHA, WINDOW_PUSHES } from '../lib/graphs/changes';
import {
  DEFAULT_RANGE_SECONDS,
  flagBoolean,
  flagNumber,
  flagString,
  parseArgv,
  parseDate,
  parseDuration,
  parseFilterTerms,
  parseList,
  parseSeriesArg,
  parseSort,
  resolveRange,
  roundSpanToDays,
  signatureInterval,
  snapInterval,
  unknownFlags,
  UsageError,
  type PointSelector,
  type SeriesArg,
  type Span,
} from './args';
import { installFetchCache } from './cache';
import { formatUtcDate } from './format';
import {
  loadActivity,
  loadAlerts,
  loadPushlog,
  loadRepository,
  loadRevisionTime,
  loadSeries,
  loadSeriesOrError,
  loadSignatures,
  loadThreshold,
} from './load';
import {
  ACROSS_FIELDS,
  expandAcross,
  isAcrossField,
  repoScope,
  type AcrossField,
  type Expansion,
} from './siblings';
import {
  attachCommits,
  buildChangesReport,
  buildClusterReport,
  buildCommitsReport,
  buildCompareReport,
  buildLocateReport,
  buildSearchReport,
  buildSeriesReport,
  buildStepReport,
  graphUrl,
  poolPushes,
  type AcrossDescriptor,
  type ChangesReport,
  type LoadedSeries,
} from './reports';
import {
  renderChanges,
  renderCluster,
  renderCommits,
  renderCompare,
  renderLocate,
  renderSearch,
  renderSeries,
  renderStep,
} from './render';

// The deployed app, because every command prints a link into it and a link is
// the reader's only way to check a text answer against the picture (see the
// module header). The dev server used to be the default, which was right for the
// one person running `npm run dev` and dead for everybody else — including this
// tool's own future installs. A checkout that wants the local app sets
// PERFHERDER2_BASE_URL=http://localhost:5173/ once, or passes --base.
const DEFAULT_APP_BASE = 'https://perfherder2.netlify.app/';

// Replaced at build time from perfherder-cli/package.json (see
// vite.cli.config.ts). Guarded rather than assumed, so that running this module
// unbundled — a test, a loader — prints something honest instead of throwing on
// an identifier nothing defined.
declare const __VERSION__: string | undefined;
const VERSION = typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev';

type Context = {
  json: boolean;
  verbose: boolean;
  appBase: string;
  now: number;
};

type Result = {
  report: unknown;
  lines: string[];
  // Non-zero only when the command produced no answer at all. A run where
  // *some* series failed did produce one — that is the whole point of reporting
  // a failure as a row — and exiting non-zero would invite a script to throw
  // away twenty-seven good rows to punish the twenty-eighth.
  exitCode?: number;
};

type Command = {
  summary: string;
  usage: string[];
  // Flags that take no value. Declared rather than inferred; see `parseArgv`.
  booleans: readonly string[];
  valued: readonly string[];
  details?: string[];
  run(parsed: ReturnType<typeof parseArgv>, ctx: Context): Promise<Result>;
};

// Accepted everywhere, so every command declares them without repeating itself.
const GLOBAL_BOOLEANS = ['json', 'no-cache', 'verbose', 'help'] as const;
const GLOBAL_VALUED = ['base', 'cache-dir'] as const;
const RANGE_VALUED = ['range', 'from', 'to'] as const;

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

const search: Command = {
  summary: 'find signatures — the Add-series picker, as a query',
  usage: [
    'perfherder-cli search <term...> [--repo <list>] [--interval <dur>] [--subtests]',
    '                            [--parent <ref>] [--like <ref>] [--across <field>]',
    '                            [--limit <n>] [--sort <col[:desc]>] [--activity]',
  ],
  booleans: ['subtests', 'activity'],
  valued: ['repo', 'interval', 'limit', 'sort', 'parent', 'like', 'across'],
  details: [
    'Terms are the picker\'s: free text is a case-insensitive substring match against the',
    'whole row, and <field>:<value> is an exact match on one field. The fields are suite,',
    'test, application, repo, platform and option. Every term narrows — two chips of the',
    'same field AND, which is not the faceted-search convention and is deliberate; see',
    'docs/design.md, "Structured filter model".',
    '',
    'A leading - excludes: `speedometer3 -application:firefox` is every browser but. It',
    'reaches the tool as a positional (only --flags are flags here), so it needs no quoting.',
    'Exclusions AND like everything else, which makes the same field twice useful in the one',
    'direction the positive form is not: -application:firefox -application:chrome.',
    '',
    'Framework is searchable as free text ("browsertime", "talos") but has no chip, since',
    'it is a producer\'s concern rather than a property of the test.',
    '',
    '--parent <ref> restricts the result to one signature\'s subtests, and implies --subtests.',
    'It is not something a chip can do: five variants of a suite on one platform (nova,',
    'no-nova, samply-profile, …) match the same chips, and only the parent id separates one',
    'set of children from the others.',
    '',
    '--like <ref> is its inverse: one row\'s counterparts elsewhere. Everything that signature',
    'is stays fixed — framework, suite, test, application, option set — and one attribute is',
    'let vary, named by --across (platform, application, repo or option; platform by default).',
    'That is the "same subtest on four platforms" list, and no chip expresses it either.',
    '',
    'The first column is the reference every other command takes.',
  ],
  async run(parsed, ctx) {
    const { filter, suspectFields } = parseFilterTerms(parsed.positionals);
    for (const suspect of suspectFields) {
      warn(
        `"${suspect.term}" is being searched as plain text — "${suspect.field}" is not a filter ` +
          `field.${suspect.suggestion ? ` Did you mean ${suspect.suggestion}:?` : ''} ` +
          `The fields are ${FILTER_FIELDS.join(', ')}.`,
      );
    }
    const parentFlag = flagString(parsed.flags, 'parent');
    const parentArg = parentFlag ? parseSeriesArg(parentFlag) : null;
    const parent = parentArg
      ? { repository: parentArg.repository, signatureId: parentArg.signatureId }
      : null;
    const likeFlag = flagString(parsed.flags, 'like');
    const likeArg = likeFlag ? parseSeriesArg(likeFlag) : null;
    if (parent && likeArg) {
      throw new UsageError(
        '--parent and --like ask opposite questions of one signature (its children, and its ' +
          'counterparts elsewhere); give one or the other',
      );
    }
    const across = acrossFields(flagString(parsed.flags, 'across'));
    if (across && !likeArg) throw new UsageError('--across needs a --like <ref> to vary from');

    const reposFlag = flagString(parsed.flags, 'repo');
    // A parent or an anchor names its own repository, so asking for the default
    // pair would download a second repo's signature list to filter every row
    // out of it. Varying *across* the repository is the exception: that is the
    // one slice whose answer is in the other repo.
    const anchor = parent ?? (likeArg ? { repository: likeArg.repository, signatureId: likeArg.signatureId } : null);
    const repos = reposFlag
      ? parseList(reposFlag)
      : anchor && !across?.includes('repo')
        ? [anchor.repository]
        : DEFAULT_REPOS;
    const intervalFlag = flagString(parsed.flags, 'interval');
    const intervalSeconds = snapInterval(
      intervalFlag ? parseDuration(intervalFlag) : 14 * 86400,
    );
    // Children only exist in the subtests=1 payload, so `--parent` without it
    // would answer "no subtests" for a signature that has 26 of them. Implied
    // rather than an error: there is exactly one thing the user can have meant.
    // `--like` needs them for the same reason from the other end: the row being
    // matched is usually itself a subtest.
    const includeSubtests =
      flagBoolean(parsed.flags, 'subtests') || parent !== null || likeArg !== null;
    const limit = flagNumber(parsed.flags, 'limit', 30);
    const sortFlag = flagString(parsed.flags, 'sort');

    for (const repo of repos) {
      if (!PINNED_REPOS.includes(repo)) {
        warn(
          `"${repo}" is not one of the repositories the app offers (${PINNED_REPOS.join(', ')}); ` +
            'asking for it anyway.',
        );
      }
    }

    const signatures = await loadSignatures(repos, intervalSeconds, includeSubtests);
    // `--like` narrows the rows the filter ever sees, the way `--parent` does,
    // so everything downstream — the count, the limit, the no-match diagnosis —
    // is about the slice rather than about the corpus.
    const expansion = likeArg
      ? expandAcross(signatures.rows, [anchor!], across ?? ['platform'])
      : null;
    const rows = expansion ? expansion.rows : signatures.rows;
    const describedAcross = expansion ? describeExpansion(expansion, [anchor!]) : null;

    const inputs = {
      fetched: signatures.fetched,
      filter,
      repos,
      intervalSeconds,
      includeSubtests,
      parent,
      across: describedAcross,
      sort: sortFlag ? parseSort(sortFlag) : null,
      limit,
    };
    let report = buildSearchReport({ ...inputs, rows, activity: undefined });

    // Activity is fetched for the rows that survived the limit, exactly as the
    // app fetches it for the rows in the viewport: the counts are one batched
    // request per repository, and the whole matched set could be 25,000 rows.
    if (flagBoolean(parsed.flags, 'activity') && report.rows.length > 0) {
      const shown = new Set(report.rows.map((r) => `${r.repository}|${r.signatureId}`));
      const activity = await loadActivity(
        rows.filter((row) => shown.has(row.key)),
        intervalSeconds,
        ctx.now,
      );
      report = buildSearchReport({ ...inputs, rows, activity });
    }

    return { report, lines: renderSearch(report) };
  },
};

// ---------------------------------------------------------------------------
// series
// ---------------------------------------------------------------------------

const series: Command = {
  summary: 'summarize one or more series over a range, and compare their levels',
  usage: [
    'perfherder-cli series <ref...> [--range <dur>] [--from <date>] [--to <date>] [--pushes]',
    '                           [--drift]',
  ],
  booleans: ['pushes', 'drift'],
  valued: [...RANGE_VALUED, 'limit'],
  details: [
    'A ref is <repo>,<signatureId>[,<frameworkId>] — the framework is optional, since the',
    'summary endpoint does not need it and the response carries it back.',
    '',
    'With more than one ref, every series after the first is compared against the first over',
    'their push means. That is the right shape for "how does Firefox compare with Chrome": it',
    'says which side is better over the window, and nothing about why, because nothing pairs a',
    'push on one side with a push on the other.',
    '',
    '--pushes lists the most recent pushes per series (--limit, default 20).',
    '',
    '--drift compares the first pushes of the range with the last, which is the question the',
    'change detector cannot answer: segmentation looks for steps, and a series that slides 8% over',
    `three months has no step in it. The window is ${WINDOW_PUSHES} pushes a side, the same one \`step\` and`,
    '`changes` use, so the figures are on one scale. It says the ends are at different levels, not',
    'that anything stepped between them.',
  ],
  async run(parsed, ctx) {
    const refs = requireRefs(parsed.positionals, 'series');
    const span = resolveRange(rangeOptions(parsed), ctx.now);
    const loaded = await Promise.all(refs.map((ref) => loadSeriesOrError(ref, span)));
    const pushLimit = flagBoolean(parsed.flags, 'pushes')
      ? flagNumber(parsed.flags, 'limit', 20)
      : null;
    const report = buildSeriesReport(
      loaded,
      span,
      ctx.appBase,
      pushLimit,
      flagBoolean(parsed.flags, 'drift'),
    );
    return { report, lines: renderSeries(report), exitCode: exitCodeFor(loaded) };
  },
};


// ---------------------------------------------------------------------------
// changes
// ---------------------------------------------------------------------------

const changes: Command = {
  summary: "steps this app detects and alerts perfherder raised, on one timeline",
  usage: [
    'perfherder-cli changes <ref...> [--range <dur>] [--commits] [--commit-limit <n>]',
    '                            [--commit-grep <pattern>] [--brief] [--cluster]',
  ],
  booleans: ['commits', 'brief', 'cluster'],
  valued: [...RANGE_VALUED, 'commit-limit', 'commit-grep'],
  details: [
    'Two independent analyses of the same series, merged into one row per event:',
    '',
    '  detected  this app\'s own change detection (src/lib/graphs/changes.ts) — binary',
    `            segmentation, a Mann-Whitney gate at α = ${CHANGE_ALPHA}, and a rank relocation of the`,
    '            index, held to a quarter of the signature\'s own alerting threshold. It finds',
    '            sub-threshold steps perfherder never alerts on. It also marks outlier pushes',
    '            sometimes; see docs/graphs-todo.md, "A push is summarised by its mean".',
    '  alert     perfherder\'s verdict, with its triage status and bug. Invalid alerts are',
    '            dropped, because a sheriff has already said they mean nothing.',
    '',
    'A detected step and an alert within three pushes of each other, agreeing about direction,',
    'are reported as one finding ("both"). Their percentages will still differ, and both are',
    'right — they average different windows.',
    '',
    '--commits lists what landed between the two pushes of each change, which is the answer to',
    '"what caused this". Over a busy merge that list is twenty commits with one candidate in it,',
    'so --commit-grep <pattern> keeps the ones whose title, author or bug number match — a',
    'case-insensitive regular expression. What it excluded is counted in the heading, since a',
    'filter that hides the culprit must not look like a range that never held one.',
    '',
    '--brief prints the event table and nothing else: no statistics paragraph, no pushlog or',
    'graph URL. That is the readable form past about three refs, and the URLs are all still in',
    '--json. A commit list asked for with --commits is kept, since that is the answer the extra',
    'fetch was for.',
    '',
    '--cluster makes the row a landing rather than a series: events from all the refs are grouped',
    'by the push interval each brackets, so one change seen by four platforms on four different',
    'revisions is one row saying so. The window printed is where the members agree, which is',
    'narrower than any single series carries. This is the form to ask "what happened to this',
    'suite over six months" in.',
  ],
  async run(parsed, ctx) {
    const refs = requireRefs(parsed.positionals, 'changes');
    const span = resolveRange(rangeOptions(parsed), ctx.now);
    const withCommits = flagBoolean(parsed.flags, 'commits');
    const brief = flagBoolean(parsed.flags, 'brief');
    const cluster = flagBoolean(parsed.flags, 'cluster');
    const commitOptions = {
      limit: flagNumber(parsed.flags, 'commit-limit', 15),
      grep: compileGrep(flagString(parsed.flags, 'commit-grep'), 'commit-grep'),
    };

    const lines: string[] = [];
    const reports: ChangesReport[] = [];
    const all: LoadedSeries[] = [];

    for (const [i, ref] of refs.entries()) {
      if (i > 0) lines.push('', '─'.repeat(60), '');
      const loaded = await loadSeriesOrError(ref, span);
      all.push(loaded);
      const [threshold, alerts, repoLink] = await Promise.all([
        loadThreshold(loaded),
        // A failed alerts fetch is null, not empty: "we could not ask" and
        // "there are none" are different answers and the report says which.
        loadAlerts(loaded, span).catch(() => null),
        loadRepository(loaded.ref.repository),
      ]);

      let report = buildChangesReport({
        loaded,
        span,
        threshold,
        alerts,
        base: ctx.appBase,
        repoLink,
      });

      if (withCommits) {
        const entries = await Promise.all(
          report.entries.map(async (entry) => {
            if (!entry.prevRevision || !entry.revision) return entry;
            try {
              const range = await loadPushlog(
                loaded.ref.repository,
                entry.prevRevision,
                entry.revision,
              );
              return attachCommits(entry, range, commitOptions);
            } catch {
              // One dead pushlog costs one change its commit list, not the run.
              return entry;
            }
          }),
        );
        report = { ...report, entries };
      }

      reports.push(report);
      // A clustered run renders once, at the end, from all of the reports: the
      // per-series text is what it exists to replace.
      if (!cluster) lines.push(...renderChanges(report, i === 0, brief));
    }

    if (cluster) {
      const clustered = buildClusterReport(reports, all, span, ctx.appBase);
      return { report: clustered, lines: renderCluster(clustered), exitCode: exitCodeFor(all) };
    }

    return {
      // Always the array, even for one ref. It used to be the bare report when
      // there was exactly one, which made the shape of the output a function of
      // the length of the input: a script written against either form breaks on
      // the other, and does it silently, because both are valid JSON carrying
      // the right field names one level off. `series` and `step` have never
      // done this. No envelope around the array, unlike theirs, because a
      // ChangesReport already carries its own span and url and an envelope
      // would only repeat them.
      report: reports,
      lines,
      exitCode: exitCodeFor(all),
    };
  },
};

// ---------------------------------------------------------------------------
// step
// ---------------------------------------------------------------------------

const step: Command = {
  summary: 'measure the change at one point, across several series at once',
  usage: [
    'perfherder-cli step <ref...> --at <revision|date> [--window <n>] [--range <dur>]',
    '                         [--across <field>] [--repo <list>]',
  ],
  booleans: [],
  valued: [...RANGE_VALUED, 'at', 'window', 'across', 'repo'],
  details: [
    'The question `changes` cannot answer: it reports the steps it *found*, and the case worth',
    'investigating is usually a series where it found none. A platform that runs the benchmark',
    'once a push, next to one that runs it twelve times, has several times the per-push noise —',
    'so a real 0.8% step is certified on one graph and invisible on the other. Reading that',
    'silence as "it did not happen here" is the mistake this command exists to prevent.',
    '',
    'So: name a point, get the level either side of it on every series given, with a',
    'Mann-Whitney U over the push means — and, where the move is real but unmarked, which of',
    `the detector's two bars it failed: α = ${CHANGE_ALPHA}, or the signature's own size floor.`,
    '',
    '--at takes a revision — looked up in the repositories of the refs given and then in the',
    'rest of the pinned set, so a revision that landed on autoland works for a series on',
    'mozilla-central, and a series with no data on that push works too, which is exactly the',
    'cross-platform case. A date works as well, and is the fallback when a revision cannot be',
    'found.',
    '--window is pushes a side, defaulting to the 24 the detector uses, so the numbers here',
    'and the numbers in a `changes` row are on one scale.',
    '',
    'Several refs at once is the point: one invocation over a suite\'s subtests, or over one',
    'subtest on four platforms.',
    '',
    '--across <field> writes that second list for you. Give one ref and every attribute of it',
    'is held fixed — framework, suite, test, application, option set — while the named field',
    '(platform, application, repo or option) is let vary, so `--across platform` is "did the',
    'other platforms see it?" in one command. Rows that share the suite and test but were held',
    'out are counted in the header rather than dropped in silence. --repo says where to look;',
    'it defaults to the refs\' own repositories, or to the app\'s pair for --across repo.',
  ],
  async run(parsed, ctx) {
    let refs = requireRefs(parsed.positionals, 'step');
    const span = resolveRange(rangeOptions(parsed), ctx.now);
    const across = acrossFields(flagString(parsed.flags, 'across'));
    const expanded = across
      ? await expandRefs(refs, across, flagString(parsed.flags, 'repo'), span, ctx.now)
      : null;
    if (expanded) refs = expanded.refs;
    const at = flagString(parsed.flags, 'at');
    if (!at) throw new UsageError('step needs --at <revision|date>');
    const windowPushes = flagNumber(parsed.flags, 'window', WINDOW_PUSHES);
    if (!Number.isInteger(windowPushes) || windowPushes < 1) {
      throw new UsageError('--window must be a positive whole number of pushes');
    }

    const loaded = await Promise.all(refs.map((ref) => loadSeriesOrError(ref, span)));
    const { atMs, revision, revisionRepository } = await resolveSplit(at, refs);
    if (atMs < span.start || atMs > span.end) {
      throw new UsageError(
        `the split point ${formatUtcDate(atMs)} is outside the range ` +
          `${formatUtcDate(span.start)} → ${formatUtcDate(span.end)} — widen it with --range`,
      );
    }

    // One request per distinct signature, cached, and worth it: without the
    // threshold this command can say a step is significant but not whether the
    // detector would have drawn it, which is half of what it is for.
    const thresholds = await Promise.all(loaded.map((one) => loadThreshold(one)));

    const report = buildStepReport({
      loaded,
      thresholds,
      atMs,
      revision,
      revisionRepository,
      windowPushes,
      span,
      base: ctx.appBase,
      across: expanded?.described ?? null,
    });
    return { report, lines: renderStep(report), exitCode: exitCodeFor(loaded) };
  },
};

// ---------------------------------------------------------------------------
// locate
// ---------------------------------------------------------------------------

const locate: Command = {
  summary: 'rank the pushes a step could be on, by the detector\'s own criterion',
  usage: [
    'perfherder-cli locate <ref> --at <revision|date> [--window <n>] [--top <k>] [--range <dur>]',
  ],
  booleans: [],
  valued: [...RANGE_VALUED, 'at', 'window', 'top'],
  details: [
    'A detected change and a perfherder alert routinely name pushes a few hours apart, and',
    'neither carries an interval, so there is no way to tell whether the two are arguing or',
    'agreeing within the noise. On one real series the detector picked a push five hours before',
    'the one a sheriff\'s alert landed on, and nothing in the output said how close the runner-up',
    'had been.',
    '',
    'So: every split in the window, scored the way the detector scores them when it decides',
    'where to put a bar — |Cliff\'s δ| less one standard error of it (changes.ts,',
    '`relocateBoundary`) — and ranked. Row 1 is where a bar would land; the rest are what it was',
    'chosen over, and the spread of the top few is the interval the bar never had. Where a',
    'perfherder alert sits inside the window, its row is marked, which answers "did we disagree,',
    'or is this the same finding?" directly.',
    '',
    'The ranking is deliberately not a statistic of this tool\'s own: a second opinion about',
    'where the app puts its own bars would be worse than no opinion.',
  ],
  async run(parsed, ctx) {
    const refs = requireRefs(parsed.positionals, 'locate');
    if (refs.length !== 1) {
      throw new UsageError(
        'locate takes one series — it ranks the pushes *within* one graph, so a second series ' +
          'would be a second table with nothing to compare',
      );
    }
    const span = resolveRange(rangeOptions(parsed), ctx.now);
    const at = flagString(parsed.flags, 'at');
    if (!at) throw new UsageError('locate needs --at <revision|date>');
    const windowPushes = flagNumber(parsed.flags, 'window', WINDOW_PUSHES);
    if (!Number.isInteger(windowPushes) || windowPushes < 1) {
      throw new UsageError('--window must be a positive whole number of pushes');
    }
    const top = flagNumber(parsed.flags, 'top', 8);
    if (!Number.isInteger(top) || top < 1) {
      throw new UsageError('--top must be a positive whole number');
    }

    const loaded = await loadSeriesOrError(refs[0], span);
    const { atMs, revision, revisionRepository } = await resolveSplit(at, refs);
    // Guarded on `found`, where `step` runs the same check unguarded, and the
    // difference is the shape of the two commands. `locate` is one series: if it
    // does not exist, its "no such signature" row is the whole answer, and
    // aborting over the range instead would answer a question the reader did not
    // ask. `step` takes many, so one missing series is not a reason to withhold
    // the others' rows, and the range is wrong for all of them at once.
    if (loaded.found && (atMs < span.start || atMs > span.end)) {
      throw new UsageError(
        `the point ${formatUtcDate(atMs)} is outside the range ` +
          `${formatUtcDate(span.start)} → ${formatUtcDate(span.end)} — widen it with --range`,
      );
    }
    const [threshold, alerts] = await Promise.all([
      loadThreshold(loaded),
      // As in `changes`: a failed fetch is null, not empty, so the column can say
      // "not asked" rather than "no alert here".
      loadAlerts(loaded, span).catch(() => null),
    ]);

    const report = buildLocateReport({
      loaded,
      threshold,
      alerts,
      atMs,
      revision,
      revisionRepository,
      windowPushes,
      top,
      span,
      base: ctx.appBase,
    });
    return { report, lines: renderLocate(report), exitCode: exitCodeFor([loaded]) };
  },
};

// `--at` is a revision or a date, and the two are told apart the same way a
// series reference's `@` selector tells them apart.
async function resolveSplit(
  at: string,
  refs: readonly SeriesArg[],
): Promise<{ atMs: number; revision: string | null; revisionRepository: string | null }> {
  if (!/^[0-9a-f]{6,40}$/i.test(at) || /^\d+$/.test(at)) {
    return { atMs: parseDate(at), revision: null, revisionRepository: null };
  }
  // The refs' own repositories first, then the rest of the pinned set. A
  // revision lives on exactly one repository, and it is routinely not one of
  // the repositories being asked about — the whole point of the command is
  // "this landed on autoland; did mozilla-central's Chrome series see it?".
  // Restricting the lookup to the refs' repos made the help's promise false,
  // which a live trial caught.
  const owned = [...new Set(refs.map((ref) => ref.repository))];
  const repositories = [...owned, ...PINNED_REPOS.filter((repo) => !owned.includes(repo))];
  const found = await loadRevisionTime(repositories, at.toLowerCase());
  if (!found) {
    throw new UsageError(
      `no push ${at} in ${repositories.join(', ')} — check the revision, or pass a date instead`,
    );
  }
  return { atMs: found.atMs, revision: at.toLowerCase(), revisionRepository: found.repository };
}

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

const compare: Command = {
  summary: 'compare two pushes: statistics, distributions, and whether the modes moved',
  usage: [
    'perfherder-cli compare <ref@where> <ref@where|where> [--range <dur>] [--pool <n>]',
    '',
    '  <where> is a revision, a push id, or first / last.',
    '  The second argument may be a bare <where>, meaning the same series.',
  ],
  booleans: [],
  valued: [...RANGE_VALUED, 'pool'],
  details: [
    'The comparison card from the details pane: pool summaries, a two-sided Mann-Whitney U',
    'with Cliff\'s delta and CLES, both replicate distributions drawn on one axis, and the',
    'mode analysis.',
    '',
    'The mode analysis answers a question the numbers alone cannot: when a benchmark',
    'regresses, did the same work get slower (the peaks moved) or did a slow path start being',
    'taken more often (the peaks stayed and their shares changed)? A peak shift smaller than',
    'the KDE\'s own bandwidth is reported as "in place", because that is the smallest shift',
    'the estimate can resolve.',
    '',
    '--pool <n> widens each side from one push to n of them: the earlier side reaches back from',
    'the push named, the later side forward, the same windows `step` measures. One push\'s 25-75',
    'replicates is a thin basis for a mode analysis — on a real series the mode *count* flipped',
    'between two legitimate choices of push pair — and pooling is how that stops being luck.',
    'The distributions, the modes and the spread then describe the pooled cloud; the',
    'significance test switches to the pushes\' means, because replicates of a run are repeated',
    'measurements of one number and a rank test over 700 of them reports a p-value it has not',
    'earned. --pool needs two different pushes: for two series over a window, use `series`.',
  ],
  async run(parsed, ctx) {
    if (parsed.positionals.length !== 2) {
      throw new UsageError('compare takes exactly two points');
    }
    const first = parseSeriesArg(parsed.positionals[0]);
    // A bare selector means "the same series, this other push", which is the
    // overwhelmingly common case and unbearable to type in full twice.
    const secondText = parsed.positionals[1];
    const second = secondText.includes(',')
      ? parseSeriesArg(secondText)
      : parseSeriesArg(
          `${first.repository},${first.signatureId}${first.frameworkId === null ? '' : `,${first.frameworkId}`}@${secondText.replace(/^@/, '')}`,
        );

    const span = resolveRange(rangeOptions(parsed), ctx.now);
    const [baseLoaded, nextLoaded] = await Promise.all([
      loadSeries(first, span),
      sameSignature(first, second)
        ? loadSeries(first, span)
        : loadSeries(second, span),
    ]);

    const basePush = resolvePush(baseLoaded, first, parsed.positionals[0]);
    const nextPush = resolvePush(nextLoaded, second, secondText);
    const repoLink = await loadRepository(baseLoaded.ref.repository);

    const pool = flagNumber(parsed.flags, 'pool', 1);
    if (!Number.isInteger(pool) || pool < 1) {
      throw new UsageError('--pool must be a whole number of pushes, at least 1');
    }
    if (pool > 1 && basePush.pushId === nextPush.pushId) {
      throw new UsageError(
        'the two points are on one push, so there is no window to pool either side of — ' +
          '`perfherder-cli series` compares two series over a whole range',
      );
    }
    // Which side reaches back and which reaches forward is decided by time, not
    // by argument order: the windows have to meet at the step rather than
    // overlap across it, and `buildComparison` puts the sides in time order
    // anyway.
    const baseIsEarlier = basePush.x <= nextPush.x;
    const basePooled = poolPushes(
      baseLoaded.data.pushes,
      basePush,
      pool,
      baseIsEarlier ? 'backward' : 'forward',
    );
    const nextPooled = poolPushes(
      nextLoaded.data.pushes,
      nextPush,
      pool,
      baseIsEarlier ? 'forward' : 'backward',
    );

    const report = buildCompareReport({
      base: { loaded: baseLoaded, push: basePooled.push, pooled: basePooled.pooled },
      next: { loaded: nextLoaded, push: nextPooled.push, pooled: nextPooled.pooled },
      span,
      appBase: ctx.appBase,
      repoLink,
      // What was asked for, not what the windows reached: the report compares the
      // two and says when they differ (`CompareReport.poolShortfall`).
      poolRequested: pool,
    });
    if (!report) {
      throw new UsageError('those two arguments name the same point — there is nothing to compare');
    }
    return { report, lines: renderCompare(report) };
  },
};

function sameSignature(a: SeriesArg, b: SeriesArg): boolean {
  return a.repository === b.repository && a.signatureId === b.signatureId;
}

// A selector against loaded data. Every failure here names what the range did
// contain, because "not found" on its own leaves the caller guessing whether
// they mistyped a revision or asked outside the window.
function resolvePush(loaded: LoadedSeries, arg: SeriesArg, text: string): PushGroup {
  const pushes = loaded.data.pushes;
  if (pushes.length === 0) {
    throw new UsageError(
      `${arg.repository},${arg.signatureId} has no data in the range — widen it with --range, or check the signature id`,
    );
  }
  const at: PointSelector = arg.at ?? { kind: 'last' };
  if (!arg.at) {
    warn(`"${text}" names no push; using the last one in the range (${shortRevision(pushes[pushes.length - 1].revision)}).`);
  }

  switch (at.kind) {
    case 'first':
      return pushes[0];
    case 'last':
      return pushes[pushes.length - 1];
    case 'push': {
      const push = loaded.data.pushById.get(at.pushId);
      if (!push) throw new UsageError(rangeHint(`push ${at.pushId}`, pushes));
      return push;
    }
    case 'revision': {
      const matches = pushes.filter((p) => p.revision.startsWith(at.revision));
      if (matches.length === 0) throw new UsageError(rangeHint(at.revision, pushes));
      if (matches.length > 1) {
        throw new UsageError(
          `"${at.revision}" matches ${matches.length} pushes in this range — give more characters`,
        );
      }
      return matches[0];
    }
  }
}

function rangeHint(what: string, pushes: readonly PushGroup[]): string {
  return (
    `${what} is not among the ${pushes.length} pushes this series has between ` +
    `${formatUtcDate(pushes[0].x)} and ${formatUtcDate(pushes[pushes.length - 1].x)} — ` +
    'widen the range with --range, or check the revision'
  );
}

// ---------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------

const commits: Command = {
  summary: 'what landed between two revisions',
  usage: [
    'perfherder-cli commits <repo> <fromRevision> <toRevision> [--commit-grep <pattern>]',
  ],
  booleans: [],
  valued: ['commit-grep'],
  details: [
    'The base revision\'s own push is excluded, matching hg\'s pushloghtml — so this is the set',
    'of candidates for a change measured between the two, and not a list that blames the',
    'reference build for it.',
    '',
    'Treeherder names at most 20 revisions per push, so a merge is reported as "20 of 164',
    'commits" rather than silently as 20.',
    '',
    '--commit-grep <pattern> keeps the commits whose title, author or bug number match a',
    'case-insensitive regular expression, and counts the ones it excluded. Over a busy merge',
    'that is the difference between reading twenty commits and reading the two that touch the',
    'subsystem the graph moved on.',
  ],
  async run(parsed) {
    if (parsed.positionals.length !== 3) {
      throw new UsageError('commits takes a repository and two revisions');
    }
    const [repository, from, to] = parsed.positionals;
    const [range, repoLink] = await Promise.all([
      loadPushlog(repository, from, to),
      loadRepository(repository),
    ]);
    const report = buildCommitsReport(
      repository,
      from,
      to,
      range,
      repoLink,
      compileGrep(flagString(parsed.flags, 'commit-grep'), 'commit-grep'),
    );
    return { report, lines: renderCommits(report) };
  },
};

// ---------------------------------------------------------------------------
// url
// ---------------------------------------------------------------------------

const url: Command = {
  summary: 'the app URL that shows these series over this range',
  usage: ['perfherder-cli url <ref...> [--range <dur>] [--from <date>] [--to <date>] [--base <url>]'],
  booleans: [],
  valued: [...RANGE_VALUED],
  details: [
    'Nothing is fetched. The refs must carry their framework id (the third field), since the',
    'app needs one to fetch with and this command has not asked the API for anything.',
    '',
    `--base defaults to ${DEFAULT_APP_BASE}, or $PERFHERDER2_BASE_URL when that is set.`,
    '',
    'The range is widened to whole UTC days, since the link is the whole output and a window',
    'whose ends are days should not be written with thirteen digits of precision. It is still',
    'absolute: the app has no relative range on purpose, because a link that says "last 6mo"',
    'lets the data point it was shared for drift out of view (src/lib/urlState.ts).',
  ],
  async run(parsed, ctx) {
    const refs = requireRefs(parsed.positionals, 'url');
    const span = roundSpanToDays(resolveRange(rangeOptions(parsed), ctx.now));
    const missing = refs.filter((ref) => ref.frameworkId === null);
    if (missing.length > 0) {
      throw new UsageError(
        `these refs need a framework id: ${missing.map((r) => `${r.repository},${r.signatureId}`).join(' ')} — ` +
          'run `perfherder-cli search` to get the three-field form, or use `perfherder-cli series`, which looks it up',
      );
    }
    const link = graphUrl(
      ctx.appBase,
      refs.map((ref) => ({
        repository: ref.repository,
        signatureId: ref.signatureId,
        frameworkId: ref.frameworkId!,
      })),
      span,
    );
    return { report: { url: link, span }, lines: [link] };
  },
};

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const COMMANDS: Record<string, Command> = {
  search,
  series,
  changes,
  step,
  locate,
  compare,
  commits,
  url,
};

function rangeOptions(parsed: ReturnType<typeof parseArgv>) {
  return {
    range: flagString(parsed.flags, 'range'),
    from: flagString(parsed.flags, 'from'),
    to: flagString(parsed.flags, 'to'),
  };
}

// ---------------------------------------------------------------------------
// --across: the horizontal slice
// ---------------------------------------------------------------------------

// One field, or a comma list of them. Several at once because Chrome runs on
// neither the same platform nor the same option set as Fenix, so
// `--across application` alone cannot express "Firefox against Chrome" —
// `--across platform,application` can.
function acrossFields(value: string | null): AcrossField[] | null {
  if (value === null) return null;
  const names = parseList(value);
  for (const name of names) {
    if (!isAcrossField(name)) {
      throw new UsageError(
        `"${name}" is not something to vary across — try ${ACROSS_FIELDS.join(', ')}, ` +
          'or a comma list of them',
      );
    }
  }
  if (names.length === 0) throw new UsageError('--across needs at least one field');
  return names as AcrossField[];
}

function describeExpansion(
  expansion: Expansion,
  anchors: readonly { repository: string; signatureId: number }[],
): AcrossDescriptor {
  return {
    fields: expansion.fields,
    anchors: anchors.map((a) => `${a.repository},${a.signatureId}`),
    missing: expansion.missing,
    omitted: expansion.omitted,
    matched: expansion.rows.length,
  };
}

// One ref list in, its counterparts out — the whole point being that the caller
// never assembles this by hand, which in a live trial took more commands than
// the analysis did and mixed three suites into one table.
async function expandRefs(
  refs: readonly SeriesArg[],
  fields: readonly AcrossField[],
  reposFlag: string | null,
  span: Span,
  nowMs: number,
): Promise<{ refs: SeriesArg[]; described: AcrossDescriptor }> {
  const anchors = refs.map((ref) => ({
    repository: ref.repository,
    signatureId: ref.signatureId,
  }));
  const repos = repoScope(reposFlag ? parseList(reposFlag) : null, anchors, fields, DEFAULT_REPOS);
  const signatures = await loadSignatures(
    repos,
    signatureInterval(span, nowMs),
    // The anchor is usually a subtest, and children only exist in this payload —
    // the same reason `--parent` implies it.
    true,
  );
  const expansion = expandAcross(signatures.rows, anchors, fields);
  if (expansion.rows.length === 0) {
    throw new UsageError(
      expansion.missing.length > 0
        ? `${expansion.missing.join(', ')} ${
            expansion.missing.length === 1 ? 'is' : 'are'
          } not in the signature list for ${repos.join(', ')} — ` +
            'check the id and the repository, and widen --range, since the list only carries ' +
            'signatures that have run recently'
        : `no counterparts across ${fields.join(', ')}`,
    );
  }
  return {
    refs: expansion.rows.map((row) => ({
      repository: row.repository,
      signatureId: row.id,
      frameworkId: row.frameworkId,
      at: null,
    })),
    described: describeExpansion(expansion, anchors),
  };
}

// Nothing came back for any of them, so there is no report to have produced.
function exitCodeFor(loaded: readonly LoadedSeries[]): number | undefined {
  return loaded.length > 0 && loaded.every((one) => one.error !== null) ? 1 : undefined;
}

function requireRefs(positionals: readonly string[], command: string): SeriesArg[] {
  if (positionals.length === 0) {
    throw new UsageError(`${command} needs at least one series reference`);
  }
  return positionals.map(parseSeriesArg);
}

function warn(message: string): void {
  process.stderr.write(`warning: ${message}\n`);
}

// A pattern flag, compiled where the caller can be told which flag was wrong.
// Case-insensitive: every other free-text match in this tool is (`search`'s
// terms, `filter.ts`), and a case-sensitive one here would be a second rule for
// the same gesture. An invalid expression is a usage error rather than a silent
// literal match — the mistake it guards against is an unescaped bracket quietly
// matching nothing at all.
function compileGrep(pattern: string | null, flag: string): RegExp | null {
  if (pattern === null) return null;
  try {
    return new RegExp(pattern, 'i');
  } catch (error) {
    throw new UsageError(
      `--${flag} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function topLevelHelp(): string[] {
  const width = Math.max(...Object.keys(COMMANDS).map((n) => n.length));
  return [
    `perfherder-cli ${VERSION} — query treeherder performance data.`,
    '',
    'Usage: perfherder-cli <command> [args] [--json] [--no-cache] [--verbose]',
    '',
    'Commands:',
    ...Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`),
    '',
    'Global options:',
    '  --version       print the version and exit',
    '  --json          print the full report object instead of text',
    '  --no-cache      bypass the on-disk response cache',
    '  --verbose       print timing and cache statistics to stderr',
    '  --base <url>    the app to build links against ' +
      `(default ${DEFAULT_APP_BASE}, or $PERFHERDER2_BASE_URL)`,
    '  --cache-dir <d> where to cache responses',
    '                  (default $PERFHERDER2_CACHE_DIR, else $XDG_CACHE_HOME/perfherder-cli)',
    '',
    'Ranges are given as --range 90d / 6mo / 1y / 36h, or as --from and --to with',
    `YYYY-MM-DD dates. The default is ${DEFAULT_RANGE_SECONDS / 86400} days, and every command prints the range it`,
    'resolved. All times are UTC.',
    '',
    'Worked examples:',
    '',
    '  # Firefox against Chrome on Android, over a month.',
    '  perfherder-cli search speedometer3 android --activity',
    '  perfherder-cli series autoland,1234567 autoland,7654321 --range 30d',
    '',
    '  # A regression: when did it happen, and did the modes move or just their weights?',
    '  perfherder-cli changes autoland,1234567 --range 60d',
    '  perfherder-cli compare autoland,1234567@<before> <after> --pool 24',
    '',
    '  # Which push is the step really on, and does perfherder agree?',
    '  perfherder-cli locate autoland,1234567 --at <revision> --range 60d',
    '',
    '  # Six months of a metric, and what caused each step.',
    '  perfherder-cli changes autoland,1234567 --range 6mo --commits',
    '',
    '  # Which subtests drove a suite-level move, and did other platforms see it?',
    '  perfherder-cli search --parent autoland,1234567 --limit 100',
    '  perfherder-cli step <subtest refs…> --at <revision> --range 60d',
    '  perfherder-cli step autoland,1234567 --across platform --at <revision> --range 60d',
    '',
    '  # The same row somewhere else: every platform, or Firefox against Chrome.',
    '  perfherder-cli search --like autoland,1234567 --across platform',
    '  perfherder-cli search --like autoland,1234567 --across platform,application',
    '',
    'Run `perfherder-cli <command> --help` for a command\'s own options.',
  ];
}

function commandHelp(name: string, command: Command): string[] {
  return [
    `perfherder-cli ${name} — ${command.summary}`,
    '',
    ...command.usage,
    '',
    ...(command.details ?? []),
  ];
}

export async function run(argv: readonly string[]): Promise<number> {
  // The command name is read straight off argv rather than by parsing it,
  // because parsing needs the command's boolean-flag set and the command is
  // what we are trying to find. Parsing twice was the first version of this and
  // it made `changes --commits --commit-limit 6` fail before dispatch: the
  // probe pass didn't know `--commits` takes no value.
  const name = argv.length > 0 && !argv[0].startsWith('-') ? argv[0] : '';

  // Before the command lookup, because `--version` is not a command and a
  // reader who types it has usually just been asked which version they are on.
  if (name === 'version' || argv.includes('--version') || argv.includes('-v')) {
    print([`perfherder-cli ${VERSION}`]);
    return 0;
  }

  if (!name || name === 'help') {
    const target = name === 'help' ? argv[1] : undefined;
    const command = target ? COMMANDS[target] : undefined;
    if (target && !command) {
      process.stderr.write(`perfherder-cli: no such command "${target}"\n`);
      print(topLevelHelp());
      return 2;
    }
    print(command ? commandHelp(target!, command) : topLevelHelp());
    return 0;
  }

  const command = COMMANDS[name];
  if (!command) {
    process.stderr.write(
      `perfherder-cli: unknown command "${name}". Try one of: ${Object.keys(COMMANDS).join(', ')}\n`,
    );
    return 2;
  }

  // Answered before the flags are parsed, so `--help` works on a command line
  // that is otherwise wrong — which is when it is most wanted.
  if (argv.includes('--help')) {
    print(commandHelp(name, command));
    return 0;
  }

  const booleans = new Set([...GLOBAL_BOOLEANS, ...command.booleans]);
  const parsed = parseArgv(argv, booleans);

  const stray = unknownFlags(parsed.flags, [
    ...GLOBAL_BOOLEANS,
    ...GLOBAL_VALUED,
    ...command.booleans,
    ...command.valued,
  ]);
  if (stray.length > 0) {
    throw new UsageError(
      `${name} does not take ${stray.map((f) => `--${f}`).join(', ')}. ` +
        'Run `perfherder-cli ' + name + ' --help`.',
    );
  }

  const ctx: Context = {
    json: flagBoolean(parsed.flags, 'json'),
    verbose: flagBoolean(parsed.flags, 'verbose'),
    appBase: flagString(parsed.flags, 'base') ?? process.env.PERFHERDER2_BASE_URL ?? DEFAULT_APP_BASE,
    now: Date.now(),
  };

  const cache = await installFetchCache({
    enabled: !flagBoolean(parsed.flags, 'no-cache'),
    dir: flagString(parsed.flags, 'cache-dir') ?? undefined,
  });

  const started = Date.now();
  const result = await command.run(parsed, ctx);
  if (ctx.json) {
    print([JSON.stringify(result.report, null, 2)]);
  } else {
    print(result.lines);
  }
  if (ctx.verbose) {
    const megabytes = (cache.stats.bytesFetched / 1e6).toFixed(1);
    process.stderr.write(
      `${Date.now() - started} ms · ${cache.stats.hits} cached, ${cache.stats.misses} fetched ` +
        `(${megabytes} MB)${cache.dir ? ` · ${cache.dir}` : ' · cache off'}\n`,
    );
  }
  return result.exitCode ?? 0;
}

function print(lines: readonly string[]): void {
  process.stdout.write(`${lines.join('\n')}\n`);
}

// Errors carry one line for the terminal and their detail on the object, the
// same discipline http.ts uses for the app's error banner. A stack trace is
// almost never the useful part here — a 404 means a bad signature id and a
// SchemaError means treeherder changed shape, and both are said plainly.
function describeError(error: unknown): { message: string; code: number } {
  if (error instanceof UsageError) return { message: error.message, code: 2 };
  if (error instanceof HttpError) {
    const hint =
      error.status === 404
        ? ' — check the repository name and signature id'
        : error.status >= 500
          ? ' — treeherder is unhappy; try again'
          : '';
    return { message: `${error.message}${hint}\n  ${error.url}`, code: 1 };
  }
  if (error instanceof SchemaError) {
    return {
      message:
        `treeherder sent something this tool does not recognise: ${error.message}\n` +
        `  ${error.url}\n${error.details}`,
      code: 1,
    };
  }
  if (error instanceof Error) return { message: error.message, code: 1 };
  return { message: String(error), code: 1 };
}

// `import.meta.url` guard omitted deliberately: this module is only ever the
// bundle's entry point, and a guard that is always true is a guard nobody
// maintains.
run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const { message, code } = describeError(error);
    process.stderr.write(`perfherder-cli: ${message}\n`);
    process.exitCode = code;
  });
