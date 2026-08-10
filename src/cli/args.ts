// Argument parsing for the CLI — pure, so every shape of input is testable
// without a process.
//
// Two things here are deliberately shared with the app rather than reinvented:
// a filter term uses `filter.ts::parseChip`, so `platform:android` means in the
// CLI exactly what it means in the picker's search box; and a picker interval is
// snapped to `pickerOptions.ts::TIME_RANGES`, because those are the only
// intervals the signatures endpoint is asked for anywhere else.

import {
  FILTER_FIELDS,
  isFilterField,
  parseChip,
  SORT_COLUMNS,
  type Filter,
  type SortColumn,
  type SortState,
} from '../lib/picker/filter';
import { TIME_RANGES } from '../lib/picker/pickerOptions';

// Anything the user could have typed differently. Carries no stack worth
// printing — main.ts prints the message and the command's usage line.
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

export type ParsedArgv = {
  // '' when argv started with a flag, which is how `perfherder-cli --help` reaches
  // the top-level help instead of erroring on a missing command.
  command: string;
  positionals: string[];
  flags: Map<string, string | true>;
};

// `--name value`, `--name=value`, `--flag`, and `--` to stop parsing.
//
// A value-taking flag has to be told from a boolean one *before* parsing, not
// after: `--json changes` is `{json: true}` plus a positional under one reading
// and `{json: 'changes'}` under the other, and nothing in the tokens
// distinguishes them. Hence `booleans`.
export function parseArgv(argv: readonly string[], booleans: ReadonlySet<string>): ParsedArgv {
  let command = '';
  let i = 0;
  if (argv.length > 0 && !argv[0].startsWith('-')) {
    command = argv[0];
    i = 1;
  }

  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  let literal = false;

  for (; i < argv.length; i++) {
    const token = argv[i];
    if (literal || !token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    if (token === '--') {
      literal = true;
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      const name = body.slice(0, eq);
      flags.set(name, body.slice(eq + 1));
      continue;
    }
    const value = argv[i + 1];
    if (booleans.has(body) || value === undefined || value.startsWith('--')) {
      // No value available. Recorded as `true` rather than rejected here, so
      // that a *misspelled* flag reaches `unknownFlags` and gets told it is not
      // a flag this command has — which is the useful message. A declared flag
      // that needs a value still gets "--x needs a value", from `flagString`.
      flags.set(body, true);
      continue;
    }
    flags.set(body, value);
    i++;
  }

  return { command, positionals, flags };
}

export function flagString(flags: ReadonlyMap<string, string | true>, name: string): string | null {
  const value = flags.get(name);
  if (value === undefined) return null;
  if (value === true) throw new UsageError(`--${name} needs a value`);
  return value;
}

export function flagBoolean(flags: ReadonlyMap<string, string | true>, name: string): boolean {
  return flags.get(name) !== undefined;
}

export function flagNumber(
  flags: ReadonlyMap<string, string | true>,
  name: string,
  fallback: number,
): number {
  const raw = flagString(flags, name);
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new UsageError(`--${name} must be a number, got "${raw}"`);
  return n;
}

// Every flag the command didn't declare. Reported rather than ignored: a typo
// in `--replicates` is otherwise a silently different query, and the whole
// point of this tool is that its answers can be trusted without a second look.
export function unknownFlags(
  flags: ReadonlyMap<string, string | true>,
  known: readonly string[],
): string[] {
  const set = new Set(known);
  return [...flags.keys()].filter((name) => !set.has(name));
}

// ---------------------------------------------------------------------------
// Durations and ranges
// ---------------------------------------------------------------------------

const DAY_SECONDS = 86400;

const DURATION_UNITS: Record<string, number> = {
  h: 3600,
  d: DAY_SECONDS,
  w: 7 * DAY_SECONDS,
  mo: 30 * DAY_SECONDS,
  y: 365 * DAY_SECONDS,
};

// "90d", "6mo", "1y", "36h". A bare number is days, which is the unit anyone
// typing one means. `m` is deliberately not accepted: it reads as minutes to
// half of us and months to the other half, and a range that is out by a factor
// of 43,200 is not a mistake worth leaving reachable.
export function parseDuration(text: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(h|d|w|mo|y)?$/i.exec(text.trim());
  if (!match) {
    throw new UsageError(
      `"${text}" is not a duration — use e.g. 14d, 6mo, 1y, 36h (m is not accepted, it is ambiguous)`,
    );
  }
  const unit = (match[2] ?? 'd').toLowerCase();
  return Number(match[1]) * DURATION_UNITS[unit];
}

// "2026-06-23" (UTC midnight), a full ISO timestamp, or epoch milliseconds.
//
// A bare date is read as UTC rather than local because every timestamp
// treeherder serves is UTC, and a range whose bounds silently move with the
// caller's timezone answers a slightly different question in every session.
export function parseDate(text: string): number {
  const trimmed = text.trim();
  if (/^\d{10,}$/.test(trimmed)) return Number(trimmed);
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return Date.parse(`${trimmed}T00:00:00Z`);
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    throw new UsageError(`"${text}" is not a date — use YYYY-MM-DD, an ISO timestamp, or epoch ms`);
  }
  return ms;
}

export type Span = { start: number; end: number };

// The CLI's default window. Wider than the app's 14 days because the commands
// that cost most to re-run — change detection and its pushlog attribution —
// need enough pushes on both sides of a step to say anything, and narrower than
// 90 so a first look is not a 20 MB download. Every command prints the range it
// resolved, so this default is never something the reader has to remember.
export const DEFAULT_RANGE_SECONDS = 30 * DAY_SECONDS;

export type RangeOptions = { range?: string | null; from?: string | null; to?: string | null };

// `--range` is relative to `--to` if given and to now otherwise, so
// `--to 2026-06-01 --range 30d` is the month before a date and needs no
// arithmetic from the caller.
export function resolveRange(opts: RangeOptions, nowMs: number): Span {
  const seconds = opts.range ? parseDuration(opts.range) : DEFAULT_RANGE_SECONDS;
  const from = opts.from ? parseDate(opts.from) : null;
  const to = opts.to ? parseDate(opts.to) : null;

  let span: Span;
  if (from !== null && to !== null) span = { start: from, end: to };
  else if (from !== null) span = { start: from, end: opts.range ? from + seconds * 1000 : nowMs };
  else if (to !== null) span = { start: to - seconds * 1000, end: to };
  else span = { start: nowMs - seconds * 1000, end: nowMs };

  if (!(span.start < span.end)) {
    throw new UsageError('the range is empty — its start is not before its end');
  }
  return span;
}

const DAY_MS = DAY_SECONDS * 1000;

// Widen a span to whole UTC days. For `url` alone, whose entire output is a
// link: `--range 6mo` resolved against the clock produced
// `range=1770824167527,1786376167527` — thirteen digits of precision on a window
// whose ends are days, in a string a person pastes into a bug and reads back.
//
// Outward, never inward, so a rounded link cannot show less than the range asked
// for. And only here: `resolveRange` feeds the fetches, so snapping it there
// would change which pushes are in the window rather than how the window is
// written down.
export function roundSpanToDays(span: Span): Span {
  return {
    start: Math.floor(span.start / DAY_MS) * DAY_MS,
    end: Math.ceil(span.end / DAY_MS) * DAY_MS,
  };
}

// The signatures endpoint is only ever asked for one of the picker's intervals
// (see pickerOptions.ts), so an arbitrary `--interval 45d` is rounded *up* to
// the next one it offers rather than passed through. Up, because rounding down
// would silently hide signatures the caller asked to see.
export function snapInterval(seconds: number): number {
  for (const range of TIME_RANGES) {
    if (range.value >= seconds) return range.value;
  }
  return TIME_RANGES[TIME_RANGES.length - 1].value;
}

// ---------------------------------------------------------------------------
// Series references
// ---------------------------------------------------------------------------

// Which push of a series a command means. `first` and `last` exist so a
// comparison can be written without looking a revision up first.
export type PointSelector =
  | { kind: 'revision'; revision: string }
  | { kind: 'push'; pushId: number }
  | { kind: 'first' }
  | { kind: 'last' };

// A series on the command line: `<repo>,<signatureId>[,<frameworkId>][@<where>]`.
//
// The three-field form is exactly what a `series=` parameter in the app's URL
// contains, so a reference can be pasted straight out of a shared graph link.
// The framework is optional because `/performance/summary/` doesn't need it —
// checked against production — and the response carries it back, so anything
// downstream that does need it (the alerts endpoint) gets it for free.
export type SeriesArg = {
  repository: string;
  signatureId: number;
  frameworkId: number | null;
  at: PointSelector | null;
};

export function parseSeriesArg(text: string): SeriesArg {
  const atIndex = text.indexOf('@');
  const head = atIndex === -1 ? text : text.slice(0, atIndex);
  const tail = atIndex === -1 ? null : text.slice(atIndex + 1);

  const parts = head.split(',').map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3) {
    throw new UsageError(
      `"${text}" is not a series reference — use <repo>,<signatureId>[,<frameworkId>][@<revision|pushId|first|last>]`,
    );
  }
  const repository = parts[0];
  if (!repository) throw new UsageError(`"${text}" has no repository`);
  const signatureId = Number(parts[1]);
  if (!Number.isInteger(signatureId) || signatureId <= 0) {
    throw new UsageError(`"${parts[1]}" is not a signature id`);
  }
  let frameworkId: number | null = null;
  if (parts.length === 3 && parts[2] !== '') {
    frameworkId = Number(parts[2]);
    if (!Number.isInteger(frameworkId)) throw new UsageError(`"${parts[2]}" is not a framework id`);
  }

  return { repository, signatureId, frameworkId, at: parsePointSelector(tail, text) };
}

function parsePointSelector(tail: string | null, whole: string): PointSelector | null {
  if (tail === null) return null;
  const value = tail.trim();
  if (value === '') throw new UsageError(`"${whole}" has an empty @ selector`);
  if (value === 'first') return { kind: 'first' };
  if (value === 'last') return { kind: 'last' };
  // All-digits is a push id. A revision is hex and could in principle be all
  // digits too, but a 12-character one has odds of about 1 in 3 × 10^6 and the
  // escape hatch is to paste one more character of it.
  if (/^\d+$/.test(value)) return { kind: 'push', pushId: Number(value) };
  if (!/^[0-9a-f]{6,40}$/i.test(value)) {
    throw new UsageError(
      `"${value}" is not a revision, a push id, or first/last — revisions are 6 to 40 hex characters`,
    );
  }
  return { kind: 'revision', revision: value.toLowerCase() };
}

// ---------------------------------------------------------------------------
// Search terms
// ---------------------------------------------------------------------------

// Free text and `field:value` chips, with exactly the picker's grammar — a term
// that names a known field becomes a chip and everything else stays free text.
//
// **A term shaped like a chip whose field is unknown is reported, not silently
// demoted.** Falling back to free text is right — a test name may contain a
// colon, and the picker relies on that — but in a text box the residue stays
// under the user's eye, and here it does not. `app:firefox` became a substring
// search for the literal string "app:firefox", matched nothing, and the
// no-match hint then explained that a chip is an exact match on its *value*,
// which sent the reader hunting for a wrong value when the field was wrong.
// Eight commands, in a live trial. The tool's own output had taught the wrong
// name: the results table's column header said APP.
//
// So the fallback stays and the *silence* goes. `suspectFields` is what
// `main.ts` warns about; the search still runs, because a genuine colon in a
// test name must not be a fatal error.
export type ParsedTerms = {
  filter: Filter;
  // Terms of the form `word:value` whose `word` is not a filter field, paired
  // with the closest field name if one is obviously meant.
  suspectFields: { term: string; field: string; suggestion: string | null }[];
};

export function parseFilterTerms(terms: readonly string[]): ParsedTerms {
  const chips: Filter['chips'] = [];
  const text: string[] = [];
  const suspectFields: ParsedTerms['suspectFields'] = [];

  for (const term of terms) {
    const chip = parseChip(term);
    if (chip) {
      if (!chips.some((c) => c.field === chip.field && c.value === chip.value)) chips.push(chip);
      continue;
    }
    const trimmed = term.trim();
    if (!trimmed) continue;
    // Only a bare word before the colon looks like an attempted chip. A test
    // name carrying one (`foo/bar:baz`) fails on the slash in the field part,
    // and a URL is excluded by the `//` — "https" is otherwise a perfectly
    // good bare word and would be reported as a mistyped field.
    const match = /^([a-z][a-z_-]*):(?!\/\/)(.+)$/i.exec(trimmed);
    if (match && !isFilterField(match[1].toLowerCase())) {
      suspectFields.push({
        term: trimmed,
        field: match[1],
        suggestion: nearestField(match[1].toLowerCase()),
      });
    }
    text.push(trimmed);
  }

  return { filter: { chips, text: text.join(' ') }, suspectFields };
}

// The field a mistyped one obviously meant, or null. Deliberately dumb: an
// abbreviation of a real field, or a real field abbreviated to it. That covers
// `app`/`application` and `plat`/`platform`, which is the whole observed
// failure mode, and it never guesses at something unrelated.
export function nearestField(word: string): string | null {
  for (const field of FILTER_FIELDS) {
    if (field.startsWith(word) || word.startsWith(field)) return field;
  }
  return null;
}

// "platform" or "platform:desc".
export function parseSort(text: string): SortState {
  const [column, direction = 'asc'] = text.split(':');
  if (!(SORT_COLUMNS as readonly string[]).includes(column)) {
    throw new UsageError(`"${column}" is not a sortable column — try ${SORT_COLUMNS.join(', ')}`);
  }
  if (direction !== 'asc' && direction !== 'desc') {
    throw new UsageError(`"${direction}" is not a sort direction — use asc or desc`);
  }
  return { column: column as SortColumn, direction };
}

export function parseList(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(',')) {
    const trimmed = part.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}
