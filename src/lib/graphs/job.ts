// Two small projections of a treeherder job row, for the details pane's Run
// section. **Pure**, and here rather than in the component because the first of
// them is a rule about what a reader already knows, which is the kind of thing
// that should be testable.

// How long the job took, as "3m 42s". Empty when either end is missing —
// treeherder expires job rows long before the performance data that points at
// them, so a null timestamp is normal rather than exceptional.
export function jobDuration(startS: number | null, endS: number | null): string {
  if (!startS || !endS || endS < startS) return '';
  const total = endS - startS;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * The job's type with the part the pane has already said stripped off the
 * front.
 *
 * `test-windows11-64-24h2-shippable/opt-browsertime-indexeddb-firefox-idb-open-many-seq`
 * is four wrapped lines of monospace in a 300px pane, and its first two thirds
 * are the platform and the build config — both spelled out at the top of the
 * pane, in the block that exists to say exactly which series this is. What is
 * left is the part that is only in this string: which harness ran, and which
 * test.
 *
 * **Only an exact `test-<platform>/` prefix is stripped**, because that is the
 * only part this can be sure of: the platform comes from the same job row, so
 * matching it is a comparison rather than a guess at treeherder's naming. The
 * build config that usually follows it (`opt-`, `debug-`) is deliberately left
 * alone — the set of them is open, and a rule that trimmed an unrecognised
 * leading token would eat the beginning of the harness name on the day
 * treeherder invents one.
 *
 * The full string stays in the row's `title`, since this is a lossy label and
 * the whole of it is what someone pastes into a `./mach try` invocation.
 */
export function shortJobType(typeName: string, platform: string): string {
  const prefix = `test-${platform}/`;
  return typeName.startsWith(prefix) ? typeName.slice(prefix.length) : typeName;
}
