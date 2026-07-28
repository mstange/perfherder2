import { describe, expect, it } from 'vitest';
import {
  EMPTY_VIEW_STATE,
  parseViewState,
  serializeViewState,
  type ViewState,
} from './urlState';

const T0 = 1750000000000;
const T1 = 1751000000000;

function state(overrides: Partial<ViewState> = {}): ViewState {
  return { ...EMPTY_VIEW_STATE, ...overrides };
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

  it('rejects a selection missing a component or with a negative index', () => {
    expect(parseViewState('?sel=autoland,42,999').selected).toBeNull();
    expect(parseViewState('?sel=autoland,42,999,-1').selected).toBeNull();
  });

  it('parses picker state and filter', () => {
    const s = parseViewState('?picker=1&pf=speedometer&pc=repo:autoland&pc=option:fission');
    expect(s.pickerOpen).toBe(true);
    expect(s.pickerFilter.text).toBe('speedometer');
    expect(s.pickerFilter.chips).toEqual([
      { field: 'repo', value: 'autoland' },
      { field: 'option', value: 'fission' },
    ]);
  });

  it('ignores unknown chip fields instead of failing the whole URL', () => {
    const s = parseViewState('?series=autoland,1,13&pc=bogus:x&pc=repo:try');
    expect(s.series).toHaveLength(1);
    expect(s.pickerFilter.chips).toEqual([{ field: 'repo', value: 'try' }]);
  });

  it('dedupes identical chips', () => {
    expect(parseViewState('?pc=repo:try&pc=repo:try').pickerFilter.chips).toHaveLength(1);
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
        pickerFilter: { chips: [{ field: 'repo', value: 'autoland' }], text: '' },
      }),
    );
    expect(s).toContain('series=autoland,1,13');
    expect(s).toContain('pc=repo:autoland');
  });

  it('omits the picker filter when the panel is closed', () => {
    const s = serializeViewState(
      state({
        pickerOpen: false,
        pickerFilter: { chips: [{ field: 'repo', value: 'autoland' }], text: 'foo' },
      }),
    );
    expect(s).toBe('');
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
      pickerOpen: true,
      pickerFilter: {
        chips: [
          { field: 'repo', value: 'autoland' },
          { field: 'platform', value: 'linux2404-64-shippable' },
        ],
        text: 'speedometer 3',
      },
    });
    expect(parseViewState(`?${serializeViewState(full)}`)).toEqual(full);
  });

  it('round-trips free text containing spaces', () => {
    const s = state({ pickerOpen: true, pickerFilter: { chips: [], text: 'a b  c' } });
    expect(parseViewState(`?${serializeViewState(s)}`).pickerFilter.text).toBe('a b  c');
  });
});
