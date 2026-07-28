import { describe, expect, it } from 'vitest';
import { MEAN_REPLICATE } from './graphData';
import {
  EMPTY_PICKER_VIEW,
  EMPTY_VIEW_STATE,
  parseViewState,
  serializeViewState,
  type PickerViewState,
  type ViewState,
} from './urlState';

const T0 = 1750000000000;
const T1 = 1751000000000;

function state(overrides: Partial<ViewState> = {}): ViewState {
  return { ...EMPTY_VIEW_STATE, ...overrides };
}

// An open panel plus whichever of its fields the test cares about.
function open(picker: Partial<PickerViewState> = {}): ViewState {
  return state({ pickerOpen: true, picker: { ...EMPTY_PICKER_VIEW, ...picker } });
}

describe('parseViewState', () => {
  it('returns an empty state for an empty query', () => {
    expect(parseViewState('')).toEqual(EMPTY_VIEW_STATE);
  });

  it('parses repeated series params in order', () => {
    const s = parseViewState('?series=autoland,1,13&series=mozilla-central,2,1');
    expect(s.series).toEqual([
      { repository: 'autoland', signatureId: 1, frameworkId: 13, visible: true },
      { repository: 'mozilla-central', signatureId: 2, frameworkId: 1, visible: true },
    ]);
  });

  it('treats a three-field entry as visible', () => {
    expect(parseViewState('?series=autoland,1,13').series[0].visible).toBe(true);
  });

  it('reads an explicit visibility flag', () => {
    const s = parseViewState('?series=autoland,1,13,0&series=try,2,1,1');
    expect(s.series.map((e) => e.visible)).toEqual([false, true]);
  });

  it('drops malformed series entries but keeps the good ones', () => {
    const s = parseViewState('?series=autoland,notanumber,13&series=try,5,1');
    expect(s.series).toEqual([
      { repository: 'try', signatureId: 5, frameworkId: 1, visible: true },
    ]);
  });

  it('dedupes the same repo+signature appearing twice', () => {
    const s = parseViewState('?series=autoland,1,13&series=autoland,1,13');
    expect(s.series).toHaveLength(1);
  });

  it('parses the absolute range and zoom', () => {
    const s = parseViewState(`?range=${T0},${T1}&zoom=${T0 + 5},${T1 - 5}`);
    expect(s.range).toEqual({ start: T0, end: T1 });
    expect(s.zoom).toEqual({ start: T0 + 5, end: T1 - 5 });
  });

  it('rejects a reversed or degenerate span', () => {
    expect(parseViewState(`?range=${T1},${T0}`).range).toBeNull();
    expect(parseViewState(`?range=${T0},${T0}`).range).toBeNull();
  });

  it('drops a zoom that does not overlap the range', () => {
    expect(parseViewState(`?range=${T0},${T1}&zoom=${T1 + 1},${T1 + 2}`).zoom).toBeNull();
  });

  it('parses the selected point', () => {
    expect(parseViewState('?sel=autoland,42,999,3').selected).toEqual({
      repository: 'autoland',
      signatureId: 42,
      datumId: 999,
      replicateIndex: 3,
    });
  });

  // -1 is MEAN_REPLICATE — "the run's mean", which is what a click selects
  // while replicate drawing is off. Anything below it is nonsense.
  it('parses a mean selection', () => {
    expect(parseViewState('?sel=autoland,42,999,-1').selected?.replicateIndex).toBe(
      MEAN_REPLICATE,
    );
  });

  it('rejects a selection missing a component or with an index below the sentinel', () => {
    expect(parseViewState('?sel=autoland,42,999').selected).toBeNull();
    expect(parseViewState('?sel=autoland,42,999,-2').selected).toBeNull();
  });

  it('parses picker state and filter', () => {
    const s = parseViewState('?picker=1&pf=speedometer&pc=repo:autoland&pc=option:fission');
    expect(s.pickerOpen).toBe(true);
    expect(s.picker.filter.text).toBe('speedometer');
    expect(s.picker.filter.chips).toEqual([
      { field: 'repo', value: 'autoland' },
      { field: 'option', value: 'fission' },
    ]);
  });

  it('ignores unknown chip fields instead of failing the whole URL', () => {
    const s = parseViewState('?series=autoland,1,13&pc=bogus:x&pc=repo:try');
    expect(s.series).toHaveLength(1);
    expect(s.picker.filter.chips).toEqual([{ field: 'repo', value: 'try' }]);
  });

  it('dedupes identical chips', () => {
    expect(parseViewState('?pc=repo:try&pc=repo:try').picker.filter.chips).toHaveLength(1);
  });

  it('parses the picker repos, interval, subtest mode and sort', () => {
    const s = parseViewState('?picker=1&pr=try,mozilla-beta&pi=604800&psub=1&psort=platform:desc');
    expect(s.picker.repos).toEqual(['try', 'mozilla-beta']);
    expect(s.picker.intervalSeconds).toBe(604800);
    expect(s.picker.matchSubtests).toBe(true);
    expect(s.picker.sort).toEqual({ column: 'platform', direction: 'desc' });
  });

  it('tells an unspecified repo list apart from an empty one', () => {
    // Absent means "use the default set"; present-but-empty is every chip
    // unchecked, which the user can do and which must survive a reload.
    expect(parseViewState('?picker=1').picker.repos).toBeNull();
    expect(parseViewState('?picker=1&pr=').picker.repos).toEqual([]);
  });

  it('dedupes and trims repo names', () => {
    expect(parseViewState('?pr=try, try ,autoland').picker.repos).toEqual(['try', 'autoland']);
  });

  it('reads an explicit subtest mode of off', () => {
    // Distinct from absent: `psub=0` is the checkbox unchecked, and it has to
    // survive a `test:` chip that would otherwise turn subtest matching on.
    expect(parseViewState('?picker=1&psub=0').picker.matchSubtests).toBe(false);
    expect(parseViewState('?picker=1&psub=yes').picker.matchSubtests).toBeNull();
  });

  it('rejects an interval the picker dropdown does not offer', () => {
    // Anything else would fetch a range the <select> cannot display.
    expect(parseViewState('?pi=12345').picker.intervalSeconds).toBeNull();
    expect(parseViewState('?pi=notanumber').picker.intervalSeconds).toBeNull();
  });

  it('rejects an unknown sort column or direction', () => {
    expect(parseViewState('?psort=bogus:asc').picker.sort).toBeNull();
    expect(parseViewState('?psort=platform:sideways').picker.sort).toBeNull();
    expect(parseViewState('?psort=platform').picker.sort).toBeNull();
  });
});

describe('serializeViewState', () => {
  it('omits everything that is at its default', () => {
    expect(serializeViewState(EMPTY_VIEW_STATE)).toBe('');
  });

  it('leaves commas and colons unencoded for readability', () => {
    const s = serializeViewState(
      state({
        series: [{ repository: 'autoland', signatureId: 1, frameworkId: 13, visible: true }],
        pickerOpen: true,
        picker: {
          ...EMPTY_PICKER_VIEW,
          filter: { chips: [{ field: 'repo', value: 'autoland' }], text: '' },
          repos: ['autoland', 'try'],
          sort: { column: 'unit', direction: 'asc' },
        },
      }),
    );
    expect(s).toContain('series=autoland,1,13');
    expect(s).toContain('pc=repo:autoland');
    expect(s).toContain('pr=autoland,try');
    expect(s).toContain('psort=unit:asc');
  });

  it('omits the whole picker state when the panel is closed', () => {
    const s = serializeViewState(
      state({
        pickerOpen: false,
        picker: {
          filter: { chips: [{ field: 'repo', value: 'autoland' }], text: 'foo' },
          repos: ['try'],
          intervalSeconds: 604800,
          matchSubtests: true,
          sort: { column: 'suite', direction: 'desc' },
        },
      }),
    );
    expect(s).toBe('');
  });

  it('writes an unspecified picker field as nothing at all', () => {
    // Not as a default: "unspecified" is what lets the panel apply its own
    // defaults, and what lets a `test:` chip turn subtest matching on.
    expect(serializeViewState(open())).toBe('picker=1');
  });

  it('writes an empty repo list and a false subtest mode explicitly', () => {
    const s = serializeViewState(open({ repos: [], matchSubtests: false }));
    expect(s).toContain('pr=');
    expect(s).toContain('psub=0');
    expect(parseViewState(`?${s}`).picker).toEqual({
      ...EMPTY_PICKER_VIEW,
      repos: [],
      matchSubtests: false,
    });
  });

  it('round-trips a fully populated state', () => {
    const full = state({
      series: [
        { repository: 'autoland', signatureId: 1, frameworkId: 13, visible: true },
        { repository: 'try', signatureId: 2, frameworkId: 1, visible: false },
      ],
      range: { start: T0, end: T1 },
      zoom: { start: T0 + 1000, end: T1 - 1000 },
      selected: { repository: 'try', signatureId: 2, datumId: 77, replicateIndex: 4 },
      showReplicates: false,
      pickerOpen: true,
      picker: {
        filter: {
          chips: [
            { field: 'repo', value: 'autoland' },
            { field: 'platform', value: 'linux2404-64-shippable' },
          ],
          text: 'speedometer 3',
        },
        repos: ['autoland', 'mozilla-beta'],
        intervalSeconds: 7776000,
        matchSubtests: true,
        sort: { column: 'options', direction: 'desc' },
      },
    });
    expect(parseViewState(`?${serializeViewState(full)}`)).toEqual(full);
  });

  // On is the default, so only the off state is worth a param — see the
  // comment on ViewState.showReplicates.
  it('writes the replicate flag only when replicate drawing is off', () => {
    expect(serializeViewState(state({ showReplicates: true }))).toBe('');
    expect(serializeViewState(state({ showReplicates: false }))).toBe('reps=0');
    expect(parseViewState('').showReplicates).toBe(true);
    expect(parseViewState('?reps=0').showReplicates).toBe(false);
  });

  it('round-trips free text containing spaces', () => {
    const s = open({ filter: { chips: [], text: 'a b  c' } });
    expect(parseViewState(`?${serializeViewState(s)}`).picker.filter.text).toBe('a b  c');
  });
});
