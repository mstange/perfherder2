// Text rendering primitives: tables, sparklines, and the little ASCII density
// plot the `compare` command draws. Pure — every function takes data and
// returns strings.
//
// Numbers go through `chart.ts`'s formatters wherever the app has one, so a
// figure printed here and the same figure read off the graph agree to the
// digit. That is not tidiness: the whole point of this tool is to answer a
// question well enough that nobody re-checks it in the UI, and two spellings of
// one number is exactly what makes someone re-check.

export type Align = 'left' | 'right';

// Two spaces between columns. Not `|`, not box drawing: a table read by an
// agent is one more thing to tokenize, and a fixed-width gap is already
// unambiguous.
const COLUMN_GAP = '  ';

// A cell whose value is missing, as opposed to zero or empty.
export const NONE = '—';

export function table(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
  aligns: readonly Align[] = [],
): string[] {
  const widths = headers.map((h, i) =>
    rows.reduce((max, row) => Math.max(max, (row[i] ?? '').length), h.length),
  );
  const pad = (cell: string, i: number): string =>
    (aligns[i] ?? 'left') === 'right' ? cell.padStart(widths[i]) : cell.padEnd(widths[i]);
  // Trailing whitespace on a left-aligned last column is invisible and costs a
  // token per line, so every row is trimmed at the end.
  const line = (cells: readonly string[]): string =>
    cells.map((c, i) => pad(c ?? '', i)).join(COLUMN_GAP).trimEnd();
  return [line(headers), ...rows.map(line)];
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

export function indent(lines: readonly string[], by = '  '): string[] {
  return lines.map((l) => (l ? `${by}${l}` : l));
}

// Greedy word wrap. A word longer than the width gets its own line rather than
// being broken — a split revision hash or URL is worse than a long line.
export function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

// UTC, always, and marked as such.
//
// `chart.ts::formatTimestamp` is local time because the app's reader is
// reasoning about their own day. A CLI's output is pasted into bugs, diffed
// against a previous run and read by a session in an unknown timezone, so the
// same instant has to print the same string everywhere — and every timestamp
// treeherder serves is UTC to begin with.
export function formatUtc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

export function formatUtcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function formatSpan(start: number, end: number): string {
  return `${formatUtcDate(start)} → ${formatUtcDate(end)}`;
}

// "6.2 days", "3.1 hours" — for saying how long a window or a job was.
export function formatDurationMs(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.round(ms / 60_000)} min`;
  if (hours < 48) return `${hours.toFixed(1)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}

// ---------------------------------------------------------------------------
// Sparklines
// ---------------------------------------------------------------------------

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

// A sparkline and the two values its lowest and highest blocks stand for.
//
// The pair is not decoration. `▁` is the *drawn* minimum, which is a bucket
// mean and so is not the series minimum, and nothing in eight block characters
// says what either of them is: a live trial read a ~10% dip as a large
// improvement because the row spanned the whole plot and the only numbers
// nearby were a `range` widened by outliers. So the caller is handed the
// endpoints of the scale it actually drew, and prints them.
export type Sparkline = {
  text: string;
  // What `▁` and `█` mean. Equal for a flat row, NaN for an empty one.
  low: number;
  high: number;
};

// `values` resampled into `width` columns and scaled to the eight block
// characters. A bucket of several values becomes their mean, which is what a
// time series wants — a bucket is "what the level was that day".
//
// It used to take a `reduce: 'mean' | 'max'` for the density curve's sake, where
// a bucket containing a peak has to show the peak rather than average it away
// with the tail beside it. `densityRow` below does that instead, on the shared
// scale a comparison needs, so no caller ever passed anything but the default.
export function sparkline(values: readonly number[], width: number): Sparkline {
  if (values.length === 0 || width < 1) return { text: '', low: NaN, high: NaN };
  const cols = Math.min(width, Math.max(1, values.length));
  const bucketed: number[] = [];
  for (let i = 0; i < cols; i++) {
    const lo = Math.floor((i * values.length) / cols);
    const hi = Math.max(lo + 1, Math.floor(((i + 1) * values.length) / cols));
    let acc = 0;
    for (let j = lo; j < hi; j++) acc += values[j];
    bucketed.push(acc / (hi - lo));
  }
  // The extremes of the *bucketed* series, not of the input: those are the two
  // the blocks are scaled between, and a caller printing the input's extremes
  // beside a row that never reached them would be relabelling the picture.
  const { min, max } = extremes(bucketed);
  return { text: scaleToBlocks(bucketed), low: min, high: max };
}

// A density curve is already sampled on a grid the caller shares between both
// sides of a comparison, so it is resampled to columns against the *shared*
// `scaleMax` and never renormalized per row: two rows on their own scales would
// say the sides have equal peaks when one is eight times the other.
//
// **The scale is a square root, which the app's canvas version is not**, and the
// reason is that eight block characters is not sixty-eight pixels. Both curves
// integrate to 1, so a tight pool peaks many times higher than a broad one — a
// 4-value push against a 7-value push measured 8× on the first series this was
// run against, and 16–20× is on record (docs/graphs-todo.md, "A compressed
// density scale"). At 8 levels a linear scale renders anything past 8× as an
// empty row, which does not read as "shorter", it reads as "no data" — a
// straightforwardly false statement about the side whose distribution is the
// question. √ keeps the ordering, bounds the squash, and costs the plain
// reading that height is spread in proportion; at this resolution that reading
// was not available anyway. The pool summaries above the plot carry the spread.
//
// A column whose density rounds below the first level is a space rather than
// `▁`, so the curve's extent is visible. The ruler underneath carries the axis.
export function densityRow(
  density: readonly number[],
  width: number,
  scaleMax: number,
): string {
  if (density.length === 0 || width < 1) return '';
  const cols = Math.min(width, Math.max(1, density.length));
  const out: string[] = [];
  for (let i = 0; i < cols; i++) {
    const lo = Math.floor((i * density.length) / cols);
    const hi = Math.max(lo + 1, Math.floor(((i + 1) * density.length) / cols));
    let peak = 0;
    for (let j = lo; j < hi; j++) peak = Math.max(peak, density[j]);
    const fraction = scaleMax > 0 ? Math.sqrt(Math.max(0, peak) / scaleMax) : 0;
    const level = Math.round(fraction * BLOCKS.length);
    out.push(level <= 0 ? ' ' : BLOCKS[Math.min(BLOCKS.length - 1, level - 1)]);
  }
  return out.join('').trimEnd();
}

function extremes(values: readonly number[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return Number.isFinite(min) ? { min, max } : { min: NaN, max: NaN };
}

function scaleToBlocks(values: readonly number[]): string {
  const { min, max } = extremes(values);
  if (!Number.isFinite(min)) return ' '.repeat(values.length);
  // A flat series has no shape to show, and stretching its rounding noise to
  // full height would invent one. Half height says "flat" honestly.
  if (max === min) return BLOCKS[3].repeat(values.length);
  return values.map((v) => blockFor((v - min) / (max - min))).join('');
}

function blockFor(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return BLOCKS[0];
  const i = Math.min(BLOCKS.length - 1, Math.floor(fraction * BLOCKS.length));
  return BLOCKS[Math.max(0, i)];
}

// Column a value lands in, for lining a marker up under a sparkline drawn over
// the same domain.
export function columnFor(value: number, min: number, max: number, width: number): number {
  if (!(max > min) || width < 1) return 0;
  const col = Math.round(((value - min) / (max - min)) * (width - 1));
  return Math.min(width - 1, Math.max(0, col));
}

// Single-character markers placed at given columns — the mode letters under a
// density row. Collisions keep the first, which is the lower-valued mode, so
// the row never claims a mode is somewhere it isn't.
export function markerRow(
  marks: readonly { column: number; label: string }[],
  width: number,
): string {
  const cells = new Array<string>(width).fill(' ');
  for (const mark of marks) {
    const col = Math.min(width - 1, Math.max(0, mark.column));
    if (cells[col] === ' ') cells[col] = mark.label.slice(0, 1);
  }
  return cells.join('').trimEnd();
}

// The ruler and its three labels, under a plot `width` columns wide. Three
// ticks rather than a computed set: it always fits, and the numbers either side
// of a mode are what the reader is after, not a well-spaced axis.
export function axisLines(min: number, max: number, width: number, unit: string): string[] {
  if (width < 5) return [];
  const mid = Math.floor((width - 1) / 2);
  const ruler = Array.from({ length: width }, (_, i) =>
    i === 0 || i === width - 1 ? '┼' : i === mid ? '┼' : '─',
  ).join('');

  const lo = formatAxisValue(min);
  const hi = formatAxisValue(max);
  const centre = formatAxisValue((min + max) / 2);
  const cells = new Array<string>(width).fill(' ');
  place(cells, 0, lo);
  place(cells, mid - Math.floor(centre.length / 2), centre);
  place(cells, width - hi.length, hi);
  const labels = `${cells.join('').trimEnd()}${unit ? ` ${unit}` : ''}`;
  return [ruler, labels];
}

function place(cells: string[], at: number, text: string): void {
  const start = Math.min(cells.length - text.length, Math.max(0, at));
  for (let i = 0; i < text.length; i++) {
    if (start + i < cells.length) cells[start + i] = text[i];
  }
}

// Axis labels want enough significant figures to tell two nearby modes apart,
// which `formatValue`'s two decimals does not do for a metric measured in
// bytes and over-does for one measured in seconds.
function formatAxisValue(v: number): string {
  if (!Number.isFinite(v)) return '?';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toPrecision(4)}G`;
  if (abs >= 1e6) return `${(v / 1e6).toPrecision(4)}M`;
  if (abs >= 1e4) return String(Math.round(v));
  return String(Number(v.toPrecision(4)));
}
