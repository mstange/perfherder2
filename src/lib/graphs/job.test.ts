import { describe, expect, it } from 'vitest';
import { jobDuration, shortJobType } from './job';

describe('jobDuration', () => {
  it('writes minutes and seconds', () => {
    expect(jobDuration(1000, 1222)).toBe('3m 42s');
  });

  it('drops the minutes when there are none', () => {
    expect(jobDuration(1000, 1042)).toBe('42s');
  });

  it('is empty when either end is missing or the pair is backwards', () => {
    // Normal, not exceptional: treeherder expires job rows long before the
    // performance data that points at them.
    expect(jobDuration(null, 1222)).toBe('');
    expect(jobDuration(1000, null)).toBe('');
    expect(jobDuration(1222, 1000)).toBe('');
  });
});

describe('shortJobType', () => {
  it('strips the platform prefix the pane has already spelled out', () => {
    expect(
      shortJobType(
        'test-windows11-64-24h2-shippable/opt-browsertime-indexeddb-firefox-idb-open-many-seq',
        'windows11-64-24h2-shippable',
      ),
    ).toBe('opt-browsertime-indexeddb-firefox-idb-open-many-seq');
  });

  it('leaves the build config alone', () => {
    // The set of them is open, and a rule that trimmed an unrecognised leading
    // token would eat the start of the harness name the day treeherder invents
    // one. "opt-" survives on purpose.
    expect(shortJobType('test-linux2404-64/opt-talos-g1', 'linux2404-64')).toMatch(/^opt-/);
  });

  it('leaves a name that does not carry the prefix untouched', () => {
    expect(shortJobType('build-linux64/opt', 'linux2404-64-shippable')).toBe('build-linux64/opt');
    expect(shortJobType('talos-g1', '')).toBe('talos-g1');
  });

  it('does not strip a platform that is merely a prefix of the job’s own', () => {
    // `test-linux2404-64-shippable/...` under a job whose platform is
    // `linux2404-64` is a different platform, and a `startsWith` on the bare
    // platform would have cut it at the wrong place.
    expect(
      shortJobType('test-linux2404-64-shippable/opt-talos-g1', 'linux2404-64'),
    ).toBe('test-linux2404-64-shippable/opt-talos-g1');
  });
});
