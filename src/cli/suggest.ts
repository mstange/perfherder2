// Why a search matched nothing, and what to type instead. Pure.
//
// "No signatures match" is a true statement and a useless one. Two of one live
// trial's first five commands went on `indexeddb`, which matches nothing
// because the tests are called `idb-*`; the tool knew every name in the corpus
// and said none of them. That is a vocabulary problem in the *data*, and no
// amount of documentation reaches it — the reader does not know the word they
// are missing, and the only thing that does is the fetched signature list.
//
// So a failed search is diagnosed against that list, in two steps that answer
// two different questions:
//
//   1. **Which term is responsible.** Every term is scored twice: how many rows
//      it matches on its own, and how many match everything *except* it. A term
//      matching nothing alone is a wrong word; a term matching plenty alone but
//      leaving nothing in combination is an over-constrained search, and the
//      remedy for the two is not the same.
//   2. **What the corpus does call it.** For a wrong word, the closest things
//      actually present, each with the number of rows it would leave.
//
// A chip and a free-text term fail differently and get different suggestions —
// see `chipSuggestions` and `textSuggestions`.

import {
  chipMatchesRow,
  chipToString,
  fieldValues,
  matchesRow,
  tokenizeFilter,
  type Filter,
  type FilterChip,
  type FilterField,
} from '../lib/picker/filter';
import type { Series } from '../lib/picker/series';

// Fields a suggestion may be drawn from. Not `FILTER_FIELDS`: `repo` is a
// closed set of six the caller chose explicitly with `--repo`, so proposing one
// as a spelling correction would be answering a question nobody asked.
const VOCABULARY_FIELDS: readonly FilterField[] = [
  'suite',
  'test',
  'application',
  'platform',
  'option',
];

// Shorter than this is not a word, it is a coincidence: at two characters the
// subsequence rule below matches most of the alphabet.
const MIN_TOKEN = 3;

// How many characters two words must agree on before a shared start means
// anything. Four keeps `speedometer` away from `sp3`.
const MIN_PREFIX = 4;

export type Suggestion = {
  // Exactly what to put on the command line: a bare word, or `field:value`.
  term: string;
  field: FilterField;
  // How many rows this term leaves, keeping the search's other terms. Zero is
  // never returned — a suggestion that also matches nothing is not a
  // suggestion.
  rows: number;
};

export type TermDiagnosis = {
  // As the user typed it.
  term: string;
  // Set when the term was parsed as a chip, which is what makes it exact.
  field: FilterField | null;
  // Rows this term matches with nothing else asked of them.
  alone: number;
  // Rows every *other* term matches. The number the reader gets back by
  // deleting this one.
  without: number;
  suggestions: Suggestion[];
};

export type NoMatchDiagnosis = {
  terms: TermDiagnosis[];
  // Rows the terms were tested against — the denominator for everything above,
  // and after `--parent` scoping, since that is the set the search ran on.
  scanned: number;
};

// Diagnose a filter that matched nothing against the rows it was run over.
//
// Called only for an empty result: on a search that matched, the answer is the
// answer, and none of this is worth a scan of thirty thousand rows.
export function diagnoseNoMatch(
  rows: readonly Series[],
  filter: Filter,
  limit = 5,
): NoMatchDiagnosis {
  const terms: TermDiagnosis[] = [];
  for (const chip of filter.chips) {
    const others: Filter = { ...filter, chips: filter.chips.filter((c) => c !== chip) };
    const alone = rows.filter((row) => chipMatchesRow(row, chip)).length;
    terms.push({
      term: chipToString(chip),
      field: chip.field,
      alone,
      without: countMatching(rows, others),
      // No suggestions for an exclusion. `chipSuggestions` answers "which value
      // did you mean", and the answer to a `-platform:andriod` that excluded
      // nothing is that it excluded nothing — offering other platforms to
      // exclude instead would be inventing an intent. `alone` still reports it:
      // for a negated chip that count is the rows it *left*, so an exclusion
      // that was the one thing emptying the list still shows up as the term
      // whose `without` is large.
      suggestions:
        alone === 0 && !chip.negated ? chipSuggestions(rows, others, chip, limit) : [],
    });
  }

  const tokens = tokenizeFilter(filter.text);
  for (const token of tokens) {
    const others: Filter = { ...filter, text: tokens.filter((t) => t !== token).join(' ') };
    const alone = rows.filter((row) => row.searchText.includes(token)).length;
    terms.push({
      term: token,
      field: null,
      alone,
      without: countMatching(rows, others),
      suggestions: alone === 0 ? textSuggestions(rows, others, token, limit) : [],
    });
  }

  return { terms, scanned: rows.length };
}

function countMatching(rows: readonly Series[], filter: Filter): number {
  let n = 0;
  for (const row of rows) if (matchesRow(row, filter)) n++;
  return n;
}

// A chip is an exact match on a whole field value, so the overwhelmingly common
// failure is a value that is a *part* of the real one — `platform:android`
// against `android-hw-a51-11-0-aarch64-shippable`. Substring first, therefore,
// and the same fuzzy rules as free text after it for an actual misspelling.
//
// The suggestion is the whole value, because that is what a chip has to be
// given; suggesting the fragment would suggest the thing that just failed.
function chipSuggestions(
  rows: readonly Series[],
  others: Filter,
  chip: FilterChip,
  limit: number,
): Suggestion[] {
  const vocabulary = new Map<string, number>();
  for (const row of rows) {
    if (!matchesRow(row, others)) continue;
    for (const value of fieldValues(row, chip.field)) {
      const key = value.toLowerCase();
      if (!key) continue;
      vocabulary.set(key, (vocabulary.get(key) ?? 0) + 1);
    }
  }

  const scored: { value: string; match: FuzzyMatch; rows: number }[] = [];
  for (const [value, count] of vocabulary) {
    // A value containing what was typed is not a near miss, it is *the* answer
    // to a chip that was given a fragment — every one of them equally, so they
    // are scored alike and ordered by how many rows each covers.
    const match: FuzzyMatch | null = value.includes(chip.value)
      ? { tier: 0, similarity: 1 }
      : fuzzyMatch(chip.value, value);
    if (match === null) continue;
    scored.push({ value, match, rows: count });
  }
  return take(scored, limit)
    .map(({ value }) => {
      const replacement: FilterChip = { field: chip.field, value };
      return {
        term: chipToString(replacement),
        field: chip.field,
        rows: countMatching(rows, { ...others, chips: [...others.chips, replacement] }),
      };
    })
    .filter((suggestion) => suggestion.rows > 0);
}

// Free text is already a substring match against the whole row, so a term that
// matched nothing is not a fragment of anything present — which rules out the
// cheap answer and leaves the interesting one: the corpus's own word for the
// thing. `indexeddb` → `idb`, by the subsequence rule in `fuzzyRank`.
//
// The vocabulary is values *and* their tokens, and a token is what gets
// suggested when a token is what matched: the useful advice for `indexeddb` is
// `idb`, which finds all nine rows, rather than one suite name that finds one
// row's worth of them.
function textSuggestions(
  rows: readonly Series[],
  others: Filter,
  token: string,
  limit: number,
): Suggestion[] {
  const vocabulary = new Map<string, { field: FilterField; rows: number }>();
  for (const row of rows) {
    if (!matchesRow(row, others)) continue;
    // Per row, so a value that is one token ("firefox") isn't counted twice.
    const words = new Map<string, FilterField>();
    for (const field of VOCABULARY_FIELDS) {
      for (const value of fieldValues(row, field)) {
        const lower = value.toLowerCase();
        for (const word of [lower, ...lower.split(/[^a-z0-9]+/)]) {
          if (word.length >= MIN_TOKEN && !words.has(word)) words.set(word, field);
        }
      }
    }
    for (const [word, field] of words) {
      const seen = vocabulary.get(word);
      if (seen) seen.rows++;
      else vocabulary.set(word, { field, rows: 1 });
    }
  }

  const scored: { value: string; match: FuzzyMatch; rows: number; field: FilterField }[] = [];
  for (const [word, { field, rows: count }] of vocabulary) {
    const match = fuzzyMatch(token, word);
    if (match === null) continue;
    scored.push({ value: word, match, rows: count, field });
  }
  // Recounted against the whole filter rather than reported from the
  // vocabulary's tally: what the reader wants is how many rows the amended
  // command returns, and the amended command still carries the other terms.
  return take(scored, limit)
    .map(({ value, field }) => ({
      term: value,
      field,
      rows: countMatching(rows, { ...others, text: `${others.text} ${value}`.trim() }),
    }))
    .filter((suggestion) => suggestion.rows > 0);
}

// How close a corpus word is to what was typed, or null for "not close at all".
// Two rules, deliberately few and deliberately explicable — a suggestion whose
// sense the reader cannot see is worse than none, because it sends them off to
// check it.
//
//   - **Tier 0, a misspelling.** The words share a start of at least MIN_PREFIX
//     characters, or the typed word contains the corpus word outright.
//   - **Tier 1, an abbreviation.** The corpus word is a subsequence of the typed
//     one and starts with the same letter. This is the `indexeddb` → `idb` rule,
//     and it is the one that earns this module: nothing built on substrings or
//     edit distance finds `idb` in `indexeddb` (distance 6 on a 9-letter word),
//     because the relation between them is an abbreviation and not a mistake.
//     The shared first letter is what keeps it from matching half the alphabet.
//
// Two tiers rather than one score because an abbreviation is *always* a poor
// score — three characters of nine — so ranking the two kinds together would
// bury `idb` under every word that happens to share four letters. Within a tier
// the score is the fraction of the longer word that matched, which is what puts
// `speedometer3` above `speed` for a typed `speedomter3`.
export type FuzzyMatch = { tier: number; similarity: number };

export function fuzzyMatch(typed: string, word: string): FuzzyMatch | null {
  if (word === typed) return { tier: 0, similarity: 1 };
  const longest = Math.max(typed.length, word.length);
  let matched = 0;
  if (word.length >= MIN_PREFIX && typed.includes(word)) matched = word.length;
  matched = Math.max(matched, commonPrefix(typed, word));
  if (matched >= MIN_PREFIX) return { tier: 0, similarity: matched / longest };
  if (word.length >= MIN_TOKEN && word[0] === typed[0] && isSubsequence(word, typed)) {
    return { tier: 1, similarity: word.length / typed.length };
  }
  return null;
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (const ch of haystack) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}

// Closest first, then whichever covers more rows, then the shorter word — which
// is the one more likely to be the name of the thing rather than one instance
// of it.
function take<T extends { value: string; match: FuzzyMatch; rows: number }>(
  scored: readonly T[],
  limit: number,
): T[] {
  return [...scored]
    .sort(
      (a, b) =>
        a.match.tier - b.match.tier ||
        b.match.similarity - a.match.similarity ||
        b.rows - a.rows ||
        a.value.length - b.value.length ||
        a.value.localeCompare(b.value),
    )
    .slice(0, Math.max(0, limit));
}
