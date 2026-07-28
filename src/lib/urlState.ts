// The whole view is a function of the URL query string: which series are
// shown and in what order, the full and zoomed time ranges, the selected data
// point, and whether the Add-series panel is open (and with what filter).
//
// Pure parse/serialize so it can be unit tested; the reactive plumbing that
// pushes to `history` lives in appState.svelte.ts.
//
// Time ranges are stored as absolute epoch-millisecond bounds, never as a
// relative "last N days". See docs/graphs.md — a relative range lets the
// linked-to data point drift out of view as time passes.

import { parseChip, type Filter, type FilterChip } from './filter';
import type { SeriesRef } from './graphData';

export type SelectedPoint = {
  repository: string;
  signatureId: number;
  datumId: number;
  replicateIndex: number;
};

export type ViewState = {
  series: SeriesRef[];
  // Full range shown by the overview graph.
  range: { start: number; end: number } | null;
  // Sub-range shown by the detail graph. Null means "same as range".
  zoom: { start: number; end: number } | null;
  selected: SelectedPoint | null;
  pickerOpen: boolean;
  pickerFilter: Filter;
};

export const EMPTY_VIEW_STATE: ViewState = {
  series: [],
  range: null,
  zoom: null,
  selected: null,
  pickerOpen: false,
  pickerFilter: { chips: [], text: '' },
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

function parseSeriesEntry(entry: string): SeriesRef | null {
  // "<repo>,<signatureId>,<frameworkId>". Treeherder's equivalent is
  // "<repo>,<signature>,<visible>,<framework>"; we dropped the visibility
  // flag (no per-series hide yet) and the legacy 40-char-hash signature form.
  const parts = entry.split(',');
  if (parts.length < 3) return null;
  const repository = parts[0].trim();
  const signatureId = parseInteger(parts[1]);
  const frameworkId = parseInteger(parts[2]);
  if (!repository || signatureId === null || frameworkId === null) return null;
  return { repository, signatureId, frameworkId };
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

export function parseViewState(search: string): ViewState {
  const p = new URLSearchParams(search);

  // `series` may repeat, and each occurrence may itself hold several
  // comma-joined triples — allow either so hand-edited URLs work.
  const series: SeriesRef[] = [];
  for (const raw of p.getAll('series')) {
    const parts = raw.split(',');
    for (let i = 0; i + 2 < parts.length; i += 3) {
      const ref = parseSeriesEntry(parts.slice(i, i + 3).join(','));
      if (ref && !series.some((s) => s.repository === ref.repository && s.signatureId === ref.signatureId)) {
        series.push(ref);
      }
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
    pickerFilter: {
      chips: parseChips(p.getAll('pc')),
      text: p.get('pf') ?? '',
    },
  };
}

// ---------------------------------------------------------------------------
// Serializing
// ---------------------------------------------------------------------------

export function serializeViewState(state: ViewState): string {
  const p = new URLSearchParams();

  for (const s of state.series) {
    p.append('series', `${s.repository},${s.signatureId},${s.frameworkId}`);
  }
  if (state.range) p.set('range', `${state.range.start},${state.range.end}`);
  if (state.zoom) p.set('zoom', `${state.zoom.start},${state.zoom.end}`);
  if (state.selected) {
    const { repository, signatureId, datumId, replicateIndex } = state.selected;
    p.set('sel', `${repository},${signatureId},${datumId},${replicateIndex}`);
  }
  if (state.pickerOpen) p.set('picker', '1');
  if (state.pickerFilter.text) p.set('pf', state.pickerFilter.text);
  for (const chip of state.pickerFilter.chips) {
    p.append('pc', `${chip.field}:${chip.value}`);
  }

  // URLSearchParams percent-encodes commas and colons, which makes these URLs
  // horrible to read and to hand-edit. Both are legal unencoded in a query
  // string, so put them back.
  return p.toString().replace(/%2C/g, ',').replace(/%3A/g, ':');
}
