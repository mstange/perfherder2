// The whole view is a function of the URL query string: which series are
// shown and in what order, the full and zoomed time ranges, the selected data
// point, and whether the Add-series panel is open (and in what state).
//
// Pure parse/serialize so it can be unit tested; the reactive plumbing that
// pushes to `history` lives in appState.svelte.ts.
//
// Time ranges are stored as absolute epoch-millisecond bounds, never as a
// relative "last N days". See docs/graphs.md — a relative range lets the
// linked-to data point drift out of view as time passes.

import { TIME_RANGES } from './api';
import {
  parseChip,
  SORT_COLUMNS,
  type Filter,
  type FilterChip,
  type SortColumn,
  type SortState,
} from './filter';
import type { SeriesRef } from './graphData';

export type SelectedPoint = {
  repository: string;
  signatureId: number;
  datumId: number;
  replicateIndex: number;
};

// A series in the URL: its identity plus whether it's currently plotted.
// Hiding keeps it in the list (and in the link) without drawing it — the same
// thing treeherder's legend cards do.
export type SeriesEntryState = SeriesRef & { visible: boolean };

// Everything the Add-series panel remembers: the filter, which repositories
// are checked, the interval its signatures are fetched over, whether the
// filter descends into subtests, and the column sort. All of it is only
// meaningful while the panel is open, and only written to the URL then.
//
// `repos`, `intervalSeconds` and `matchSubtests` are three-valued: null means
// *unspecified*, and the panel supplies its own default. That matters in two
// directions. A prefill computed by the app (AppState.derivePickerView) knows
// a filter and a repo set but has no opinion on the rest, so it leaves them
// null; and a hand-written link that says `pc=test:fcp` without `psub` still
// gets the subtest nudge in PickerState.seed. Once the panel has been open it
// reports concrete values back, so a generated link never relies on either.
export type PickerViewState = {
  filter: Filter;
  repos: string[] | null;
  intervalSeconds: number | null;
  matchSubtests: boolean | null;
  // Null is a real value here, not an absence: "no column sort" is the
  // default, and it is also what the third click on a header returns to.
  sort: SortState | null;
};

export const EMPTY_PICKER_VIEW: PickerViewState = {
  filter: { chips: [], text: '' },
  repos: null,
  intervalSeconds: null,
  matchSubtests: null,
  sort: null,
};

export type ViewState = {
  series: SeriesEntryState[];
  // Full range shown by the overview graph.
  range: { start: number; end: number } | null;
  // Sub-range shown by the detail graph. Null means "same as range".
  zoom: { start: number; end: number } | null;
  selected: SelectedPoint | null;
  pickerOpen: boolean;
  picker: PickerViewState;
};

export const EMPTY_VIEW_STATE: ViewState = {
  series: [],
  range: null,
  zoom: null,
  selected: null,
  pickerOpen: false,
  picker: EMPTY_PICKER_VIEW,
};

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseInteger(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) && Number.isInteger(n) ? n : null;
}

// "<startMs>,<endMs>", rejected unless both parse and start < end.
function parseSpan(s: string | null): { start: number; end: number } | null {
  if (!s) return null;
  const [a, b] = s.split(',');
  const start = parseInteger(a);
  const end = parseInteger(b);
  if (start === null || end === null || start >= end) return null;
  return { start, end };
}

// "<repo>,<signatureId>,<frameworkId>[,<visible>]". Treeherder's equivalent
// is "<repo>,<signature>,<visible>,<framework>"; we keep the visibility flag
// but put it last so it can be omitted, and we dropped the legacy
// 40-char-hash form of the signature.
function parseSeriesEntry(entry: string): SeriesEntryState | null {
  const parts = entry.split(',');
  if (parts.length < 3) return null;
  const repository = parts[0].trim();
  const signatureId = parseInteger(parts[1]);
  const frameworkId = parseInteger(parts[2]);
  if (!repository || signatureId === null || frameworkId === null) return null;
  // Anything other than an explicit "0" means visible, so a hand-written
  // three-field entry behaves the way you'd expect.
  const visible = parts.length < 4 || parts[3].trim() !== '0';
  return { repository, signatureId, frameworkId, visible };
}

function parseSelected(s: string | null): SelectedPoint | null {
  if (!s) return null;
  const parts = s.split(',');
  if (parts.length < 4) return null;
  const repository = parts[0].trim();
  const signatureId = parseInteger(parts[1]);
  const datumId = parseInteger(parts[2]);
  const replicateIndex = parseInteger(parts[3]);
  if (!repository || signatureId === null || datumId === null || replicateIndex === null) {
    return null;
  }
  if (replicateIndex < 0) return null;
  return { repository, signatureId, datumId, replicateIndex };
}

function parseChips(values: string[]): FilterChip[] {
  const out: FilterChip[] = [];
  for (const v of values) {
    const chip = parseChip(v);
    // Drop unparseable chips rather than failing the whole URL: a stale link
    // with a since-removed field should still show its graphs.
    if (chip && !out.some((c) => c.field === chip.field && c.value === chip.value)) {
      out.push(chip);
    }
  }
  return out;
}

// "autoland,mozilla-central". An absent param and a present-but-empty one are
// different states: absent means "unspecified, use the default set", empty
// means "none" — which the user can reach by unchecking every repo chip, and
// which has to survive a reload like any other deliberate choice.
function parseRepos(raw: string | null): string[] | null {
  if (raw === null) return null;
  const out: string[] = [];
  for (const name of raw.split(',')) {
    const trimmed = name.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

// The picker's interval has to be one of the values its dropdown offers.
// An arbitrary number would fetch a range the <select> cannot display, leaving
// the control blank and the row counts unexplainable.
function parseInterval(s: string | null): number | null {
  const n = parseInteger(s);
  return n !== null && TIME_RANGES.some((r) => r.value === n) ? n : null;
}

// "1" / "0"; anything else (including absent) is unspecified.
function parseFlag(s: string | null): boolean | null {
  if (s === '1') return true;
  if (s === '0') return false;
  return null;
}

// "platform:desc". Unknown columns are dropped rather than failing the URL,
// the same way an unknown chip field is — a link written against a column that
// has since been renamed should still show its graphs.
function parseSort(s: string | null): SortState | null {
  if (!s) return null;
  const [column, direction] = s.split(':');
  if (!(SORT_COLUMNS as readonly string[]).includes(column)) return null;
  if (direction !== 'asc' && direction !== 'desc') return null;
  return { column: column as SortColumn, direction };
}

export function parseViewState(search: string): ViewState {
  const p = new URLSearchParams(search);

  // One entry per `series` param, repeated. (An earlier version also packed
  // several entries into one param; that became ambiguous once entries could
  // be three or four fields long.)
  const series: SeriesEntryState[] = [];
  for (const raw of p.getAll('series')) {
    const ref = parseSeriesEntry(raw);
    if (
      ref &&
      !series.some((s) => s.repository === ref.repository && s.signatureId === ref.signatureId)
    ) {
      series.push(ref);
    }
  }

  const range = parseSpan(p.get('range'));
  let zoom = parseSpan(p.get('zoom'));
  // A zoom outside the full range is meaningless; clamp it away rather than
  // rendering an empty detail graph.
  if (zoom && range && (zoom.start >= range.end || zoom.end <= range.start)) zoom = null;

  return {
    series,
    range,
    zoom,
    selected: parseSelected(p.get('sel')),
    pickerOpen: p.get('picker') === '1',
    picker: {
      filter: {
        chips: parseChips(p.getAll('pc')),
        text: p.get('pf') ?? '',
      },
      repos: parseRepos(p.get('pr')),
      intervalSeconds: parseInterval(p.get('pi')),
      matchSubtests: parseFlag(p.get('psub')),
      sort: parseSort(p.get('psort')),
    },
  };
}

// ---------------------------------------------------------------------------
// Serializing
// ---------------------------------------------------------------------------

export function serializeViewState(state: ViewState): string {
  const p = new URLSearchParams();

  for (const s of state.series) {
    // The visibility flag is omitted in the common case, keeping links short.
    const base = `${s.repository},${s.signatureId},${s.frameworkId}`;
    p.append('series', s.visible ? base : `${base},0`);
  }
  if (state.range) p.set('range', `${state.range.start},${state.range.end}`);
  if (state.zoom) p.set('zoom', `${state.zoom.start},${state.zoom.end}`);
  if (state.selected) {
    const { repository, signatureId, datumId, replicateIndex } = state.selected;
    p.set('sel', `${repository},${signatureId},${datumId},${replicateIndex}`);
  }
  // The panel's state only means anything while it's open — carrying it in the
  // URL of a closed panel would be noise in every shared graph link.
  if (state.pickerOpen) {
    p.set('picker', '1');
    const { filter, repos, intervalSeconds, matchSubtests, sort } = state.picker;
    if (filter.text) p.set('pf', filter.text);
    for (const chip of filter.chips) {
      p.append('pc', `${chip.field}:${chip.value}`);
    }
    // Written even when the list is empty, and `psub` written even when false:
    // for these three, omitting means "unspecified" rather than "off", so a
    // link that dropped them would come back with the defaults instead of
    // what the panel was actually showing.
    if (repos) p.set('pr', repos.join(','));
    if (intervalSeconds !== null) p.set('pi', String(intervalSeconds));
    if (matchSubtests !== null) p.set('psub', matchSubtests ? '1' : '0');
    if (sort) p.set('psort', `${sort.column}:${sort.direction}`);
  }

  // URLSearchParams percent-encodes commas and colons, which makes these URLs
  // horrible to read and to hand-edit. Both are legal unencoded in a query
  // string, so put them back.
  return p.toString().replace(/%2C/g, ',').replace(/%3A/g, ':');
}
