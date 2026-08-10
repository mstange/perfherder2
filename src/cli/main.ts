// perfherder — a command-line front end to the same code the app runs on.
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
import { DEFAULT_REPOS, PINNED_REPOS } from '../lib/picker/pickerOptions';
import { FILTER_FIELDS } from '../lib/picker/filter';
import type { PushGroup } from '../lib/graphs/graphData';
import { WINDOW_PUSHES } from '../lib/graphs/changes';
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
  snapInterval,
  unknownFlags,
  UsageError,
  type PointSelector,
  type SeriesArg,
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
  attachCommits,
  buildChangesReport,
  buildCommitsReport,
  buildCompareReport,
  buildSearchReport,
  buildSeriesReport,
  buildStepReport,
  graphUrl,
  type LoadedSeries,
} from './reports';
import {
  renderChanges,
  renderCommits,
  renderCompare,
  renderSearch,
  renderSeries,
  renderStep,
} from './render';

const DEFAULT_APP_BASE = 'http://localhost:5173/';

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
    'perfherder search <term...> [--repo <list>] [--interval <dur>] [--subtests]',
    '                            [--parent <ref>] [--limit <n>] [--sort <col[:desc]>]',
    '                            [--activity]',
  ],
  booleans: ['subtests', 'activity'],
  valued: ['repo', 'interval', 'limit', 'sort', 'parent'],
  details: [
    'Terms are the picker\'s: free text is a case-insensitive substring match against the',
    'whole row, and <field>:<value> is an exact match on one field. The fields are suite,',
    'test, application, repo, platform and option. Every term narrows — two chips of the',
    'same field AND, which is not the faceted-search convention and is deliberate; see',
    'docs/design.md, "Structured filter model".',
    '',
    'Framework is searchable as free text ("browsertime", "talos") but has no chip, since',
    'it is a producer\'s concern rather than a property of the test.',
    '',
    '--parent <ref> restricts the result to one signature\'s subtests, and implies --subtests.',
    'It is not something a chip can do: five variants of a suite on one platform (nova,',
    'no-nova, samply-profile, …) match the same chips, and only the parent id separates one',
    'set of children from the others.',
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
    const reposFlag = flagString(parsed.flags, 'repo');
    // A parent names its own repository, so asking for the default pair would
    // download a second repo's signature list to filter every row out of it.
    const repos = reposFlag ? parseList(reposFlag) : parent ? [parent.repository] : DEFAULT_REPOS;
    const intervalFlag = flagString(parsed.flags, 'interval');
    const intervalSeconds = snapInterval(
      intervalFlag ? parseDuration(intervalFlag) : 14 * 86400,
    );
    // Children only exist in the subtests=1 payload, so `--parent` without it
    // would answer "no subtests" for a signature that has 26 of them. Implied
    // rather than an error: there is exactly one thing the user can have meant.
    const includeSubtests = flagBoolean(parsed.flags, 'subtests') || parent !== null;
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
    let report = buildSearchReport({
      rows: signatures.rows,
      fetched: signatures.fetched,
      filter,
      repos,
      intervalSeconds,
      includeSubtests,
      parent,
      sort: sortFlag ? parseSort(sortFlag) : null,
      limit,
      activity: undefined,
    });

    // Activity is fetched for the rows that survived the limit, exactly as the
    // app fetches it for the rows in the viewport: the counts are one batched
    // request per repository, and the whole matched set could be 25,000 rows.
    if (flagBoolean(parsed.flags, 'activity') && report.rows.length > 0) {
      const shown = new Set(report.rows.map((r) => `${r.repository}|${r.signatureId}`));
      const activity = await loadActivity(
        signatures.rows.filter((row) => shown.has(row.key)),
        intervalSeconds,
        ctx.now,
      );
      report = buildSearchReport({
        rows: signatures.rows,
        fetched: signatures.fetched,
        filter,
        repos,
        intervalSeconds,
        includeSubtests,
        parent,
        sort: sortFlag ? parseSort(sortFlag) : null,
        limit,
        activity,
      });
    }

    return { report, lines: renderSearch(report) };
  },
};

// ---------------------------------------------------------------------------
// series
// ---------------------------------------------------------------------------

const series: Command = {
  summary: 'summarize one or more series over a range, and compare their levels',
  usage: ['perfherder series <ref...> [--range <dur>] [--from <date>] [--to <date>] [--pushes]'],
  booleans: ['pushes'],
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
  ],
  async run(parsed, ctx) {
    const refs = requireRefs(parsed.positionals, 'series');
    const span = resolveRange(rangeOptions(parsed), ctx.now);
    const loaded = await Promise.all(refs.map((ref) => loadSeriesOrError(ref, span)));
    const pushLimit = flagBoolean(parsed.flags, 'pushes')
      ? flagNumber(parsed.flags, 'limit', 20)
      : null;
    const report = buildSeriesReport(loaded, span, ctx.appBase, pushLimit);
    return { report, lines: renderSeries(report), exitCode: exitCodeFor(loaded) };
  },
};


// ---------------------------------------------------------------------------
// changes
// ---------------------------------------------------------------------------

const changes: Command = {
  summary: "steps this app detects and alerts perfherder raised, on one timeline",
  usage: [
    'perfherder changes <ref...> [--range <dur>] [--commits] [--commit-limit <n>]',
  ],
  booleans: ['commits'],
  valued: [...RANGE_VALUED, 'commit-limit'],
  details: [
    'Two independent analyses of the same series, merged into one row per event:',
    '',
    '  detected  this app\'s own change detection (src/lib/graphs/changes.ts) — binary',
    '            segmentation, a Mann-Whitney gate at α = 0.01, and a rank relocation of the',
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
    '"what caused this".',
  ],
  async run(parsed, ctx) {
    const refs = requireRefs(parsed.positionals, 'changes');
    const span = resolveRange(rangeOptions(parsed), ctx.now);
    const withCommits = flagBoolean(parsed.flags, 'commits');
    const commitLimit = flagNumber(parsed.flags, 'commit-limit', 15);

    const lines: string[] = [];
    const reports: unknown[] = [];
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
              return attachCommits(entry, range, commitLimit);
            } catch {
              // One dead pushlog costs one change its commit list, not the run.
              return entry;
            }
          }),
        );
        report = { ...report, entries };
      }

      reports.push(report);
      lines.push(...renderChanges(report, i === 0));
    }

    return {
      report: reports.length === 1 ? reports[0] : reports,
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
    'perfherder step <ref...> --at <revision|date> [--window <n>] [--range <dur>]',
  ],
  booleans: [],
  valued: [...RANGE_VALUED, 'at', 'window'],
  details: [
    'The question `changes` cannot answer: it reports the steps it *found*, and the case worth',
    'investigating is usually a series where it found none. A platform that runs the benchmark',
    'once a push, next to one that runs it twelve times, has several times the per-push noise —',
    'so a real 0.8% step is certified on one graph and invisible on the other. Reading that',
    'silence as "it did not happen here" is the mistake this command exists to prevent.',
    '',
    'So: name a point, get the level either side of it on every series given, with a',
    'Mann-Whitney U over the push means — and, where the move is real but unmarked, which of',
    'the detector\'s two bars it failed: α = 0.01, or the signature\'s own size floor.',
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
  ],
  async run(parsed, ctx) {
    const refs = requireRefs(parsed.positionals, 'step');
    const span = resolveRange(rangeOptions(parsed), ctx.now);
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
    });
    return { report, lines: renderStep(report), exitCode: exitCodeFor(loaded) };
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
    'perfherder compare <ref@where> <ref@where|where> [--range <dur>]',
    '',
    '  <where> is a revision, a push id, or first / last.',
    '  The second argument may be a bare <where>, meaning the same series.',
  ],
  booleans: [],
  valued: [...RANGE_VALUED],
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

    const report = buildCompareReport({
      base: { loaded: baseLoaded, push: basePush },
      next: { loaded: nextLoaded, push: nextPush },
      span,
      appBase: ctx.appBase,
      repoLink,
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
    warn(`"${text}" names no push; using the last one in the range (${pushes[pushes.length - 1].revision.slice(0, 12)}).`);
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
  usage: ['perfherder commits <repo> <fromRevision> <toRevision>'],
  booleans: [],
  valued: [],
  details: [
    'The base revision\'s own push is excluded, matching hg\'s pushloghtml — so this is the set',
    'of candidates for a change measured between the two, and not a list that blames the',
    'reference build for it.',
    '',
    'Treeherder names at most 20 revisions per push, so a merge is reported as "20 of 164',
    'commits" rather than silently as 20.',
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
    const report = buildCommitsReport(repository, from, to, range, repoLink);
    return { report, lines: renderCommits(report) };
  },
};

// ---------------------------------------------------------------------------
// url
// ---------------------------------------------------------------------------

const url: Command = {
  summary: 'the app URL that shows these series over this range',
  usage: ['perfherder url <ref...> [--range <dur>] [--from <date>] [--to <date>] [--base <url>]'],
  booleans: [],
  valued: [...RANGE_VALUED],
  details: [
    'Nothing is fetched. The refs must carry their framework id (the third field), since the',
    'app needs one to fetch with and this command has not asked the API for anything.',
    '',
    `--base defaults to ${DEFAULT_APP_BASE}, or $PERFHERDER2_BASE_URL when that is set.`,
  ],
  async run(parsed, ctx) {
    const refs = requireRefs(parsed.positionals, 'url');
    const span = resolveRange(rangeOptions(parsed), ctx.now);
    const missing = refs.filter((ref) => ref.frameworkId === null);
    if (missing.length > 0) {
      throw new UsageError(
        `these refs need a framework id: ${missing.map((r) => `${r.repository},${r.signatureId}`).join(' ')} — ` +
          'run `perfherder search` to get the three-field form, or use `perfherder series`, which looks it up',
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

function topLevelHelp(): string[] {
  const width = Math.max(...Object.keys(COMMANDS).map((n) => n.length));
  return [
    'perfherder — query treeherder performance data.',
    '',
    'Usage: perfherder <command> [args] [--json] [--no-cache] [--verbose]',
    '',
    'Commands:',
    ...Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`),
    '',
    'Global options:',
    '  --json          print the full report object instead of text',
    '  --no-cache      bypass the on-disk response cache',
    '  --verbose       print timing and cache statistics to stderr',
    '  --base <url>    the app to build links against ' +
      `(default ${DEFAULT_APP_BASE}, or $PERFHERDER2_BASE_URL)`,
    '  --cache-dir <d> where to cache responses (default $XDG_CACHE_HOME/perfherder2-cli)',
    '',
    'Ranges are given as --range 90d / 6mo / 1y / 36h, or as --from and --to with',
    `YYYY-MM-DD dates. The default is ${DEFAULT_RANGE_SECONDS / 86400} days, and every command prints the range it`,
    'resolved. All times are UTC.',
    '',
    'Worked examples:',
    '',
    '  # Firefox against Chrome on Android, over a month.',
    '  perfherder search speedometer3 android --activity',
    '  perfherder series autoland,1234567 autoland,7654321 --range 30d',
    '',
    '  # A regression: when did it happen, and did the modes move or just their weights?',
    '  perfherder changes autoland,1234567 --range 60d',
    '  perfherder compare autoland,1234567@<before> <after>',
    '',
    '  # Six months of a metric, and what caused each step.',
    '  perfherder changes autoland,1234567 --range 6mo --commits',
    '',
    '  # Which subtests drove a suite-level move, and did other platforms see it?',
    '  perfherder search --parent autoland,1234567 --limit 100',
    '  perfherder step <subtest refs…> --at <revision> --range 60d',
    '  perfherder step <one subtest, four platforms> --at <revision> --range 60d',
    '',
    'Run `perfherder <command> --help` for a command\'s own options.',
  ];
}

function commandHelp(name: string, command: Command): string[] {
  return [
    `perfherder ${name} — ${command.summary}`,
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

  if (!name || name === 'help') {
    const target = name === 'help' ? argv[1] : undefined;
    const command = target ? COMMANDS[target] : undefined;
    if (target && !command) {
      process.stderr.write(`perfherder: no such command "${target}"\n`);
      print(topLevelHelp());
      return 2;
    }
    print(command ? commandHelp(target!, command) : topLevelHelp());
    return 0;
  }

  const command = COMMANDS[name];
  if (!command) {
    process.stderr.write(
      `perfherder: unknown command "${name}". Try one of: ${Object.keys(COMMANDS).join(', ')}\n`,
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
        'Run `perfherder ' + name + ' --help`.',
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
    process.stderr.write(`perfherder: ${message}\n`);
    process.exitCode = code;
  });
