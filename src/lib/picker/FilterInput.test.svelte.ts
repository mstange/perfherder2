// The one component with committed tests, because it's the one component with
// state of its own: the in-progress `textValue` behind the <input>. Everything
// else the picker renders comes straight out of `PickerState`, so a unit test
// of the class covers it — but a local copy of a prop can silently disagree
// with the prop, and that has shipped twice (see the seeding test below).
//
// This mounts the real component under happy-dom. It needs no browser, so it
// isn't the puppeteer situation docs/design.md rules out; `mount` + `flushSync`
// is the same machinery the reactive-state tests already use.

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import FilterInput from './FilterInput.svelte';
import type { Filter } from './filter';

let mounted: Record<string, unknown> | null = null;

afterEach(() => {
  if (mounted) unmount(mounted);
  mounted = null;
  document.body.innerHTML = '';
});

function render(filter: Filter, textDebounceMs = 0) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const changes: Filter[] = [];
  mounted = mount(FilterInput, {
    target,
    props: { filter, onchange: (next: Filter) => changes.push(next), textDebounceMs },
  });
  flushSync();
  return {
    changes,
    input: () => target.querySelector('input.filter-text') as HTMLInputElement,
    // The remove button contributes no text of its own — its cross is an
    // `<svg>` — so a pill's `textContent` is exactly its field and value.
    chips: () =>
      [...target.querySelectorAll('.chip-pill')].map((el) =>
        el.textContent!.replace(/\s+/g, ' ').trim(),
      ),
  };
}

// Fire an input event the way a keystroke does.
function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

describe('FilterInput', () => {
  it('renders the chips it is given', () => {
    const ui = render({
      chips: [
        { field: 'suite', value: 'speedometer3' },
        { field: 'option', value: 'opt' },
      ],
      text: '',
    });
    expect(ui.chips()).toEqual(['suite speedometer3', 'option opt']);
  });

  // The regression. The picker filters by `filter.text`, but only this
  // component renders it, and it used to start its local copy at ''. So a
  // filter that arrived with text in it — a shared link carrying `pf=`, or
  // reopening the Add-series panel on a filter the user left text in — drew an
  // empty-looking box over a list that was still filtered by an invisible
  // term.
  it('shows text the filter arrived with', () => {
    const ui = render({ chips: [{ field: 'suite', value: 'speedometer3' }], text: 'safari' });
    expect(ui.input().value).toBe('safari');
    expect(ui.chips()).toEqual(['suite speedometer3']);
  });

  it('reports free text upward without touching the chips', () => {
    const ui = render({ chips: [{ field: 'repo', value: 'autoland' }], text: '' });
    type(ui.input(), 'speedo');
    expect(ui.changes.at(-1)).toEqual({
      chips: [{ field: 'repo', value: 'autoland' }],
      text: 'speedo',
    });
  });

  // One input event carrying a whole token, which is what a paste is. Typing it
  // character by character gets there too, but only because the signal passes
  // through the partial token on the way — this is the path that used to leave
  // the raw text sitting in the box next to the chip it had become.
  it('turns a completed field:value token into a chip and takes it out of the text', () => {
    const ui = render({ chips: [], text: '' });
    type(ui.input(), 'application:chrome ');
    expect(ui.changes.at(-1)).toEqual({
      chips: [{ field: 'application', value: 'chrome' }],
      text: '',
    });
    expect(ui.input().value).toBe('');
  });

  it('leaves an unknown field as plain text', () => {
    // Typos stay visible rather than being silently swallowed.
    const ui = render({ chips: [], text: '' });
    type(ui.input(), 'framework:talos ');
    expect(ui.changes.at(-1)).toEqual({ chips: [], text: 'framework:talos ' });
    expect(ui.input().value).toBe('framework:talos ');
  });

  it('adopts text the parent replaces from outside', () => {
    // The counterpart to the seeding case: an external change after mount has
    // to reach the input too. The parent replaces the whole filter object (the
    // picker assigns `picker.filter = next`), which is what the adopt-effect
    // watches for.
    let current = $state<Filter>({ chips: [], text: 'safari' });
    const target = document.createElement('div');
    document.body.appendChild(target);
    mounted = mount(FilterInput, {
      target,
      props: {
        get filter() {
          return current;
        },
        onchange: () => {},
        textDebounceMs: 0,
      },
    });
    flushSync();
    const input = target.querySelector('input.filter-text') as HTMLInputElement;
    expect(input.value).toBe('safari');
    current = { chips: [], text: 'chrome' };
    flushSync();
    expect(input.value).toBe('chrome');
  });
});
