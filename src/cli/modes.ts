// Did the modes move, or did the same modes just get a different share of the
// samples?
//
// The app draws both sides' KDE curves on one axis and leaves that question to
// the reader's eye. A CLI has no eye to lend, so this answers it in words —
// pure, over the `ModeInfo` that `kde.ts::computeModeInfo` already produces for
// each side of a comparison. Nothing here re-runs the estimation or re-tunes
// its thresholds: the modes are whatever PerfCompare's rules found, and this
// only relates one side's to the other's.
//
// **The bandwidth is what "moved" means.** A Gaussian KDE smooths at the scale
// of its bandwidth, so a peak displacement smaller than that is not something
// the estimate resolves — it is the grid and the kernel talking. Calling such a
// shift a movement would be the single most misleading thing this command could
// do, because it is precisely the case where the honest answer ("the modes are
// where they were; the weight moved") is the interesting one.

import type { ModeInfo } from '../lib/graphs/kde';

// How far a peak has to move to count. One bandwidth, taken as the wider of the
// two sides' — the coarser estimate is the one that limits what the pair can
// resolve.
export function modeResolution(baseBandwidth: number, nextBandwidth: number): number {
  return Math.max(baseBandwidth, nextBandwidth);
}

// How much of the total density has to change hands before a mode counts as
// reweighted. Ten percentage points: below that, a share is moved by which
// replicates happened to land near a boundary as much as by anything real, and
// the pairs print their exact figures anyway.
export const SHARE_DELTA_THRESHOLD = 0.1;

// Past this many bandwidths apart, two peaks are different modes rather than
// one mode displaced. Only used when the two sides have *different* numbers of
// modes and there is a genuine matching problem; with equal counts the modes
// are paired by rank, since that is what "the same mode" means when both sides
// have the same structure.
const MATCH_WINDOW_BANDWIDTHS = 4;

export type ModeSide = {
  label: string;
  modes: ModeInfo;
  bandwidth: number;
  // Below `MIN_CURVE_VALUES` a pool gets no curve, and therefore no modes worth
  // relating to anything.
  hasCurve: boolean;
};

export type ModePair = {
  baseLetter: string;
  nextLetter: string;
  baseLoc: number;
  nextLoc: number;
  // next − base.
  shift: number;
  // As a fraction of the base location; null when that is zero.
  shiftFraction: number | null;
  baseShare: number;
  nextShare: number;
  shareDelta: number;
  moved: boolean;
  reweighted: boolean;
};

export type UnmatchedMode = {
  side: 'base' | 'next';
  letter: string;
  loc: number;
  share: number;
};

export type ModeVerdict =
  // One side had too few values for a density.
  | 'insufficient'
  | 'unchanged'
  // Peaks moved; shares held.
  | 'shifted'
  // Peaks held; shares moved. The interesting one, and the reason this exists.
  | 'reweighted'
  | 'shifted-and-reweighted'
  // The sides don't have the same number of modes, so nothing above applies.
  | 'restructured';

export type ModeComparison = {
  verdict: ModeVerdict;
  resolution: number;
  baseCount: number;
  nextCount: number;
  pairs: ModePair[];
  unmatched: UnmatchedMode[];
};

export function compareModes(base: ModeSide, next: ModeSide): ModeComparison {
  const resolution = modeResolution(base.bandwidth, next.bandwidth);
  const baseCount = base.hasCurve ? base.modes.peakLocs.length : 0;
  const nextCount = next.hasCurve ? next.modes.peakLocs.length : 0;

  if (!base.hasCurve || !next.hasCurve || baseCount === 0 || nextCount === 0) {
    return {
      verdict: 'insufficient',
      resolution,
      baseCount,
      nextCount,
      pairs: [],
      unmatched: [],
    };
  }

  const sameStructure = baseCount === nextCount;
  const matches = sameStructure
    ? Array.from({ length: baseCount }, (_, i) => [i, i] as [number, number])
    : nearestMatches(base.modes.peakLocs, next.modes.peakLocs, resolution * MATCH_WINDOW_BANDWIDTHS);

  const pairs: ModePair[] = matches.map(([bi, ni]) => {
    const baseLoc = base.modes.peakLocs[bi];
    const nextLoc = next.modes.peakLocs[ni];
    const shift = nextLoc - baseLoc;
    const baseShare = base.modes.fracs[bi] ?? 0;
    const nextShare = next.modes.fracs[ni] ?? 0;
    const shareDelta = nextShare - baseShare;
    return {
      baseLetter: base.modes.letters[bi] ?? '?',
      nextLetter: next.modes.letters[ni] ?? '?',
      baseLoc,
      nextLoc,
      shift,
      shiftFraction: baseLoc === 0 ? null : shift / baseLoc,
      baseShare,
      nextShare,
      shareDelta,
      moved: Math.abs(shift) > resolution,
      // **Only meaningful when both sides have the same modes.** When one side
      // has a mode the other doesn't, the survivors' shares must add back up to
      // 1 without it, so a pair goes 87% → 100% by arithmetic and not by
      // anything moving between modes. Flagging that as "reweighted" read as
      // the finding — a live trial reported exactly that misreading, on a case
      // where the real finding was the *lost* mode sitting a line above.
      reweighted: sameStructure && Math.abs(shareDelta) >= SHARE_DELTA_THRESHOLD,
    };
  });

  const matchedBase = new Set(matches.map(([bi]) => bi));
  const matchedNext = new Set(matches.map(([, ni]) => ni));
  const unmatched: UnmatchedMode[] = [];
  for (let i = 0; i < baseCount; i++) {
    if (matchedBase.has(i)) continue;
    unmatched.push({
      side: 'base',
      letter: base.modes.letters[i] ?? '?',
      loc: base.modes.peakLocs[i],
      share: base.modes.fracs[i] ?? 0,
    });
  }
  for (let i = 0; i < nextCount; i++) {
    if (matchedNext.has(i)) continue;
    unmatched.push({
      side: 'next',
      letter: next.modes.letters[i] ?? '?',
      loc: next.modes.peakLocs[i],
      share: next.modes.fracs[i] ?? 0,
    });
  }

  return {
    verdict: verdictFor(baseCount, nextCount, pairs),
    resolution,
    baseCount,
    nextCount,
    pairs,
    unmatched,
  };
}

function verdictFor(baseCount: number, nextCount: number, pairs: readonly ModePair[]): ModeVerdict {
  if (baseCount !== nextCount) return 'restructured';
  const moved = pairs.some((p) => p.moved);
  const reweighted = pairs.some((p) => p.reweighted);
  if (moved && reweighted) return 'shifted-and-reweighted';
  if (moved) return 'shifted';
  if (reweighted) return 'reweighted';
  return 'unchanged';
}

// Pair peaks nearest-first, each used once, refusing pairs further apart than
// `window`. Greedy rather than optimal: with the two to four modes a real pool
// produces, the nearest-first order and the assignment that minimizes total
// distance agree, and the greedy one is inspectable.
function nearestMatches(
  baseLocs: readonly number[],
  nextLocs: readonly number[],
  window: number,
): [number, number][] {
  const candidates: { bi: number; ni: number; distance: number }[] = [];
  for (let bi = 0; bi < baseLocs.length; bi++) {
    for (let ni = 0; ni < nextLocs.length; ni++) {
      const distance = Math.abs(nextLocs[ni] - baseLocs[bi]);
      if (distance <= window) candidates.push({ bi, ni, distance });
    }
  }
  candidates.sort((a, b) => a.distance - b.distance || a.bi - b.bi || a.ni - b.ni);

  const usedBase = new Set<number>();
  const usedNext = new Set<number>();
  const out: [number, number][] = [];
  for (const { bi, ni } of candidates) {
    if (usedBase.has(bi) || usedNext.has(ni)) continue;
    usedBase.add(bi);
    usedNext.add(ni);
    out.push([bi, ni]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

// ---------------------------------------------------------------------------
// Saying it
// ---------------------------------------------------------------------------

export type ModeFormat = {
  // Value formatter, so the sentence prints the metric the way every other
  // number in the report does.
  value: (v: number) => string;
  unit: string;
  baseLabel: string;
  nextLabel: string;
};

const pct = (fraction: number): string => `${Math.round(fraction * 100)}%`;

// The finding, as a sentence. This is the command's actual answer to "did the
// modes move or did the split between them change", so it names the evidence it
// used — the resolution below which it refuses to call a shift a movement —
// rather than asserting a verdict the reader has to take on trust.
export function describeModeComparison(cmp: ModeComparison, fmt: ModeFormat): string {
  const unit = fmt.unit ? ` ${fmt.unit}` : '';
  const at = (v: number): string => `${fmt.value(v)}${unit}`;
  const res = `the KDE resolves shifts down to ${at(cmp.resolution)}`;

  switch (cmp.verdict) {
    case 'insufficient':
      return 'At least one side has too few values for a density estimate, so there are no modes to compare.';

    case 'unchanged':
      if (cmp.pairs.length === 1) {
        return `Both sides are unimodal at ${at(cmp.pairs[0].baseLoc)} and the peak did not move (${res}).`;
      }
      return `Both sides have the same ${cmp.pairs.length} modes, in the same places and in the same proportions (${res}).`;

    case 'shifted': {
      const moved = cmp.pairs.filter((p) => p.moved);
      const detail = moved
        .map((p) => `${p.baseLetter} ${at(p.baseLoc)} → ${at(p.nextLoc)}`)
        .join(', ');
      const whole = moved.length === cmp.pairs.length ? 'every mode' : `${moved.length} of ${cmp.pairs.length} modes`;
      return (
        `The modes moved and their shares did not: ${detail}. ` +
        `With ${whole} displaced and the split between them intact, this is the level shifting, ` +
        `not samples changing which mode they land in.`
      );
    }

    case 'reweighted': {
      const changed = cmp.pairs.filter((p) => p.reweighted);
      const detail = changed
        .map((p) => `${p.baseLetter} at ${at(p.baseLoc)} holds ${pct(p.baseShare)} → ${pct(p.nextShare)}`)
        .join('; ');
      return (
        `The modes stayed where they were — no peak moved by more than ${at(cmp.resolution)}, and ${res}. ` +
        `What changed is how the samples divide between them: ${detail}. ` +
        `So this is a change in how often each path is taken, not a change in how fast either path is.`
      );
    }

    case 'shifted-and-reweighted': {
      const moved = cmp.pairs
        .filter((p) => p.moved)
        .map((p) => `${p.baseLetter} ${at(p.baseLoc)} → ${at(p.nextLoc)}`)
        .join(', ');
      const changed = cmp.pairs
        .filter((p) => p.reweighted)
        .map((p) => `${p.baseLetter} ${pct(p.baseShare)} → ${pct(p.nextShare)}`)
        .join(', ');
      return (
        `Both things happened. Peaks moved: ${moved}. Shares moved: ${changed}. ` +
        `The two are separable here only by their sizes, so read the pairs below before attributing the delta to either.`
      );
    }

    case 'restructured': {
      const gone = cmp.unmatched.filter((m) => m.side === 'base');
      const gained = cmp.unmatched.filter((m) => m.side === 'next');
      const parts: string[] = [
        `${fmt.baseLabel} has ${cmp.baseCount} ${cmp.baseCount === 1 ? 'mode' : 'modes'}, ` +
          `${fmt.nextLabel} has ${cmp.nextCount}.`,
      ];
      if (gone.length > 0) {
        parts.push(
          `Gone: ${gone.map((m) => `${m.letter} at ${at(m.loc)} (${pct(m.share)})`).join(', ')}.`,
        );
      }
      if (gained.length > 0) {
        parts.push(
          `New: ${gained.map((m) => `${m.letter} at ${at(m.loc)} (${pct(m.share)})`).join(', ')}.`,
        );
      }
      parts.push(
        `A mode appearing or disappearing is a change in what the test does, not in how fast it does it — ` +
          `check the replicate counts below before reading the delta as a slowdown. The surviving ` +
          `modes' shares necessarily add back up to 100% without the lost one, so a share moving here ` +
          `is arithmetic rather than a second finding. (${res}.)`,
      );
      return parts.join(' ');
    }
  }
}
