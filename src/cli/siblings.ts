// "The same row, on every platform" — the horizontal slice. Pure.
//
// `search --parent` gives the vertical one: a signature's own subtests. There
// was no inverse, and assembling "this subtest on four platforms" meant
// `search --json` piped through a hand-written pivot, which in one live trial
// took more commands than the analysis did and produced three mechanical
// errors — one of which quietly mixed three benchmark suites into one table.
//
// The reason it cannot be a chip is the reason `--parent` cannot be one, seen
// from the other side. `suite:speedometer3 test:score` gathers every variant of
// that row on every platform *and* every application, option set and framework
// that also ran it, and there is no chip and no negation that says "everything
// this row is, except its platform". That relation is what this module is: hold
// every identifying attribute of one named row fixed, let exactly one of them
// vary, and return what is left.
//
// **What it holds fixed is deliberately strict**, and the strictness is where
// the errors it prevents live. Loosening to suite-and-test would sweep the
// nova/no-nova/samply-profile variants of a suite into one table beside each
// other, which is the mistake the trial made by hand. So a row is a sibling
// only if it agrees on repository, framework, suite, test, application,
// platform and option set — all but the one field named. Everything that shares
// the suite and test and was excluded anyway is counted and reported, because a
// slice that silently drops half its rows is the failure mode this codebase
// keeps meeting (see the `getCommonAlerts` note in graphs-todo.md).

import type { Series } from '../lib/picker/series';

// The attributes worth varying. Not every filter field: `suite` and `test` are
// what makes a row *the same measurement*, so varying them asks a different
// question — which is `--parent`'s, and it already has an answer.
//
// More than one at a time is allowed, and the browser comparison is why: Chrome
// does not run on the same platform as Fenix, nor with the same option set, so
// `--across application` alone answers "just this row" for the exact question
// the tool's first worked example asks. `--across platform,application` is that
// question.
export const ACROSS_FIELDS = ['platform', 'application', 'repo', 'option'] as const;

export type AcrossField = (typeof ACROSS_FIELDS)[number];

export function isAcrossField(value: string): value is AcrossField {
  return (ACROSS_FIELDS as readonly string[]).includes(value);
}

// A row is a sibling if it agrees on everything not being varied.
export type SiblingSet = {
  // The row the reference named, or null when it isn't in the fetched set — a
  // mistyped id, the wrong repository, or a signature quiet enough to fall
  // outside the interval the signature list was asked for. That is not the same
  // answer as "it has no siblings" and the caller says which.
  anchor: Series | null;
  fields: AcrossField[];
  // The anchor and its siblings, ordered by the values of the varying fields.
  rows: Series[];
  // Rows sharing the anchor's framework, suite and test that were nonetheless
  // excluded, grouped by what they differ in — "application", "option", or
  // "application + option". The count a reader needs to decide whether the
  // slice they asked for is the slice they wanted.
  omitted: { differs: string; rows: number }[];
};

type FieldName = 'repo' | 'framework' | 'suite' | 'test' | 'application' | 'platform' | 'option';

// Everything a sibling must agree on, in the order a difference is reported.
const HELD: readonly FieldName[] = [
  'repo',
  'framework',
  'suite',
  'test',
  'application',
  'platform',
  'option',
];

function valueOf(row: Series, field: FieldName): string {
  switch (field) {
    case 'repo':
      return row.repository;
    case 'framework':
      return String(row.frameworkId);
    case 'suite':
      return row.suite;
    case 'test':
      return row.test;
    case 'application':
      return row.application;
    case 'platform':
      return row.platform;
    case 'option':
      // A set, not a sequence: `toSeries` composes the option collection and
      // the extra options in the order the API listed them, and two rows that
      // ran the same configuration should not be told apart by that order.
      return [...row.options].map((o) => o.toLowerCase()).sort().join(' ');
  }
}

// The siblings of one row across one field.
export function siblingsAcross(
  rows: readonly Series[],
  ref: { repository: string; signatureId: number },
  fields: readonly AcrossField[],
): SiblingSet {
  const varying = [...fields];
  const anchor =
    rows.find((row) => row.repository === ref.repository && row.id === ref.signatureId) ?? null;
  if (!anchor) return { anchor: null, fields: varying, rows: [], omitted: [] };

  const held = HELD.filter((name) => !varying.includes(name as AcrossField));
  const siblings: Series[] = [];
  const omitted = new Map<string, number>();

  for (const row of rows) {
    const differs = held.filter((name) => valueOf(row, name) !== valueOf(anchor, name));
    if (differs.length === 0) {
      siblings.push(row);
      continue;
    }
    // Only rows that are recognisably the same measurement are worth counting:
    // everything else in the corpus differs from this row too, and saying so
    // would be saying nothing.
    if (row.frameworkId !== anchor.frameworkId) continue;
    if (row.suite !== anchor.suite || row.test !== anchor.test) continue;
    const key = differs.join(' + ');
    omitted.set(key, (omitted.get(key) ?? 0) + 1);
  }

  const sortKey = (row: Series): string => varying.map((name) => valueOf(row, name)).join('|');
  siblings.sort(
    (a, b) =>
      sortKey(a).localeCompare(sortKey(b)) ||
      a.repository.localeCompare(b.repository) ||
      a.id - b.id,
  );

  return {
    anchor,
    fields: varying,
    rows: siblings,
    omitted: [...omitted]
      .map(([differs, count]) => ({ differs, rows: count }))
      .sort((a, b) => b.rows - a.rows || a.differs.localeCompare(b.differs)),
  };
}

// Several anchors expanded into one list, in the order they were named, with a
// row appearing once however many anchors reach it. Two subtests of one suite
// across four platforms is eight rows, not eight plus four duplicates.
export type Expansion = {
  fields: AcrossField[];
  rows: Series[];
  // Anchors that weren't in the fetched set, as `<repo>,<id>`.
  missing: string[];
  omitted: { differs: string; rows: number }[];
};

export function expandAcross(
  rows: readonly Series[],
  refs: readonly { repository: string; signatureId: number }[],
  fields: readonly AcrossField[],
): Expansion {
  const out: Series[] = [];
  const seen = new Set<string>();
  const missing: string[] = [];
  const omitted = new Map<string, number>();

  for (const ref of refs) {
    const set = siblingsAcross(rows, ref, fields);
    if (!set.anchor) {
      missing.push(`${ref.repository},${ref.signatureId}`);
      continue;
    }
    for (const row of set.rows) {
      if (seen.has(row.key)) continue;
      seen.add(row.key);
      out.push(row);
    }
    for (const entry of set.omitted) {
      omitted.set(entry.differs, (omitted.get(entry.differs) ?? 0) + entry.rows);
    }
  }

  return {
    fields: [...fields],
    rows: out,
    missing,
    omitted: [...omitted]
      .map(([differs, count]) => ({ differs, rows: count }))
      .sort((a, b) => b.rows - a.rows || a.differs.localeCompare(b.differs)),
  };
}
