import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RANGE_SECONDS,
  flagNumber,
  flagString,
  parseArgv,
  parseDate,
  parseDuration,
  nearestField,
  parseFilterTerms,
  parseList,
  parseSeriesArg,
  parseSort,
  resolveRange,
  snapInterval,
  unknownFlags,
  UsageError,
} from './args';

const BOOLEANS = new Set(['json', 'subtests']);
const parse = (line: string) => parseArgv(line.split(' ').filter(Boolean), BOOLEANS);

describe('parseArgv', () => {
  it('takes the first token as the command', () => {
    expect(parse('search speedometer3').command).toBe('search');
    expect(parse('search speedometer3').positionals).toEqual(['speedometer3']);
  });

  it('leaves the command empty when argv starts with a flag, so --help still works', () => {
    expect(parse('--json').command).toBe('');
  });

  it('reads --name value and --name=value the same way', () => {
    expect(parse('search --repo autoland').flags.get('repo')).toBe('autoland');
    expect(parse('search --repo=autoland').flags.get('repo')).toBe('autoland');
  });

  it('does not swallow the next token after a declared boolean', () => {
    const parsed = parse('search --subtests speedometer3');
    expect(parsed.flags.get('subtests')).toBe(true);
    expect(parsed.positionals).toEqual(['speedometer3']);
  });

  it('records a valueless flag as true rather than failing', () => {
    // A misspelled flag has to survive parsing to reach `unknownFlags`, which is
    // the only layer that can say "this command has no such flag". Failing here
    // reports the wrong problem: `--replicates` used to come back as
    // "--replicates needs a value".
    expect(parse('changes autoland,1 --replicates').flags.get('replicates')).toBe(true);
    expect(parse('search foo --limit').flags.get('limit')).toBe(true);
  });

  it('stops parsing flags after --', () => {
    const parsed = parseArgv(['search', '--', '--repo'], BOOLEANS);
    expect(parsed.positionals).toEqual(['--repo']);
    expect(parsed.flags.size).toBe(0);
  });
});

describe('flag readers', () => {
  it('reports a declared flag that was given no value', () => {
    const parsed = parse('search --limit');
    expect(() => flagString(parsed.flags, 'limit')).toThrow(/--limit needs a value/);
  });

  it('returns the fallback for an absent number', () => {
    expect(flagNumber(parse('search').flags, 'limit', 30)).toBe(30);
    expect(flagNumber(parse('search --limit 5').flags, 'limit', 30)).toBe(5);
    expect(() => flagNumber(parse('search --limit x').flags, 'limit', 30)).toThrow(UsageError);
  });

  it('lists only the flags the command did not declare', () => {
    const parsed = parse('search --repo autoland --nope');
    expect(unknownFlags(parsed.flags, ['repo'])).toEqual(['nope']);
  });
});

describe('parseDuration', () => {
  it('reads the units it documents', () => {
    expect(parseDuration('36h')).toBe(36 * 3600);
    expect(parseDuration('14d')).toBe(14 * 86400);
    expect(parseDuration('2w')).toBe(14 * 86400);
    expect(parseDuration('6mo')).toBe(180 * 86400);
    expect(parseDuration('1y')).toBe(365 * 86400);
  });

  it('reads a bare number as days', () => {
    expect(parseDuration('90')).toBe(90 * 86400);
  });

  it('refuses "m", which means minutes to half of us and months to the other half', () => {
    expect(() => parseDuration('30m')).toThrow(UsageError);
  });
});

describe('parseDate', () => {
  it('reads a bare date as UTC midnight, not local', () => {
    // Local would make the same command mean a different window in every
    // timezone, against data that is UTC throughout.
    expect(parseDate('2026-06-23')).toBe(Date.parse('2026-06-23T00:00:00Z'));
  });

  it('reads a full ISO timestamp and epoch milliseconds', () => {
    expect(parseDate('2026-06-23T14:02:00Z')).toBe(Date.parse('2026-06-23T14:02:00Z'));
    expect(parseDate('1786299917166')).toBe(1786299917166);
  });
});

describe('resolveRange', () => {
  const now = Date.parse('2026-08-09T12:00:00Z');

  it('defaults to the documented window ending now', () => {
    expect(resolveRange({}, now)).toEqual({
      start: now - DEFAULT_RANGE_SECONDS * 1000,
      end: now,
    });
  });

  it('counts --range back from --to when both are given', () => {
    expect(resolveRange({ range: '30d', to: '2026-06-01' }, now)).toEqual({
      start: Date.parse('2026-05-02T00:00:00Z'),
      end: Date.parse('2026-06-01T00:00:00Z'),
    });
  });

  it('counts --range forward from --from', () => {
    expect(resolveRange({ range: '7d', from: '2026-06-01' }, now)).toEqual({
      start: Date.parse('2026-06-01T00:00:00Z'),
      end: Date.parse('2026-06-08T00:00:00Z'),
    });
  });

  it('runs --from to now when no duration is given', () => {
    expect(resolveRange({ from: '2026-06-01' }, now).end).toBe(now);
  });

  it('rejects an empty range rather than fetching nothing', () => {
    expect(() => resolveRange({ from: '2026-06-02', to: '2026-06-01' }, now)).toThrow(UsageError);
  });
});

describe('snapInterval', () => {
  it('rounds up to an interval the signatures endpoint is actually asked for', () => {
    // Up, never down: rounding down would silently hide signatures the caller
    // asked to see.
    expect(snapInterval(45 * 86400)).toBe(60 * 86400);
    expect(snapInterval(14 * 86400)).toBe(14 * 86400);
    expect(snapInterval(1 * 86400)).toBe(2 * 86400);
  });

  it('clamps past the widest interval on offer', () => {
    expect(snapInterval(365 * 86400)).toBe(90 * 86400);
  });
});

describe('parseSeriesArg', () => {
  it('reads the two- and three-field forms', () => {
    expect(parseSeriesArg('autoland,5350953')).toEqual({
      repository: 'autoland',
      signatureId: 5350953,
      frameworkId: null,
      at: null,
    });
    // The three-field form is what a `series=` parameter in the app's URL
    // contains, so a reference can be pasted out of a shared link.
    expect(parseSeriesArg('autoland,5350953,13').frameworkId).toBe(13);
  });

  it('reads the @ selector', () => {
    expect(parseSeriesArg('autoland,1@first').at).toEqual({ kind: 'first' });
    expect(parseSeriesArg('autoland,1@last').at).toEqual({ kind: 'last' });
    expect(parseSeriesArg('autoland,1@1954000').at).toEqual({ kind: 'push', pushId: 1954000 });
    expect(parseSeriesArg('autoland,1@4138203B7BE1').at).toEqual({
      kind: 'revision',
      revision: '4138203b7be1',
    });
  });

  it('rejects what it cannot read', () => {
    expect(() => parseSeriesArg('autoland')).toThrow(UsageError);
    expect(() => parseSeriesArg('autoland,notanumber')).toThrow(UsageError);
    expect(() => parseSeriesArg('autoland,1@zzz')).toThrow(UsageError);
    expect(() => parseSeriesArg('autoland,1@')).toThrow(UsageError);
  });
});

describe('parseFilterTerms', () => {
  it('turns a known field into a chip and leaves everything else as text', () => {
    const { filter } = parseFilterTerms(['speedometer3', 'platform:android', 'framework:13']);
    expect(filter.chips).toEqual([{ field: 'platform', value: 'android' }]);
    // An unknown field still falls back to free text — a test name may contain
    // a colon and the picker relies on that.
    expect(filter.text).toBe('speedometer3 framework:13');
  });

  it('de-duplicates identical chips', () => {
    expect(parseFilterTerms(['repo:autoland', 'repo:autoland']).filter.chips).toHaveLength(1);
  });

  it('reports a term shaped like a chip whose field is unknown', () => {
    // The failure this exists for: `app:firefox` searched as literal text,
    // matched nothing, and the no-match hint then talked about wrong *values*.
    const { suspectFields } = parseFilterTerms(['app:firefox', 'NewsSite-Next']);
    expect(suspectFields).toEqual([
      { term: 'app:firefox', field: 'app', suggestion: 'application' },
    ]);
  });

  it('does not mistake a colon inside a value for an attempted chip', () => {
    // Only a bare word before the colon looks like a chip; a test name or a URL
    // must not produce a warning telling the user their field is wrong.
    expect(parseFilterTerms(['https://example.com/x']).suspectFields).toEqual([]);
    expect(parseFilterTerms(['foo/bar:baz']).suspectFields).toEqual([]);
  });

  it('offers no suggestion for a word that resembles no field', () => {
    const { suspectFields } = parseFilterTerms(['banana:split']);
    expect(suspectFields[0].suggestion).toBeNull();
  });
});

describe('nearestField', () => {
  it('matches an abbreviation in either direction and nothing else', () => {
    expect(nearestField('app')).toBe('application');
    expect(nearestField('plat')).toBe('platform');
    expect(nearestField('applications')).toBe('application');
    expect(nearestField('banana')).toBeNull();
  });
});

describe('parseSort and parseList', () => {
  it('reads a column with an optional direction', () => {
    expect(parseSort('platform')).toEqual({ column: 'platform', direction: 'asc' });
    expect(parseSort('platform:desc')).toEqual({ column: 'platform', direction: 'desc' });
    expect(() => parseSort('nope')).toThrow(UsageError);
    expect(() => parseSort('platform:sideways')).toThrow(UsageError);
  });

  it('splits a comma list, trimming and de-duplicating', () => {
    expect(parseList('autoland, mozilla-central ,autoland')).toEqual([
      'autoland',
      'mozilla-central',
    ]);
  });
});
