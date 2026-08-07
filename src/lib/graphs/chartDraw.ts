// Canvas drawing for the graphs. Imperative by nature, but kept out of the
// Svelte component so the component is only sizing + events, and so the
// drawing order is readable in one place.
//
// Everything here takes a PlotGeometry from chart.ts; nothing computes its own
// coordinates.

import {
  formatTickValue,
  jitterOffsetPx,
  lowerBound,
  pixelSpan,
  timeTicks,
  valueTicks,
  type JitterScale,
  type PlotGeometry,
  type Range,
  type SeriesShape,
  type SeriesSymbol,
} from '../shared/chart';
import {
  ALERT_MARKER_TOP,
  ALERT_TRIANGLE_HALF,
  ALERT_TRIANGLE_HEIGHT,
  alertRowTop,
  CHANGE_BAR_HEIGHT,
  changeBarTop,
  type AlertSlot,
  type ChangeSlot,
} from './annotations';
import type { PushGroup, SeriesPoint } from './graphData';
import type { ChartPalette } from '../shared/theme';

export type DrawSeries = {
  color: string;
  symbol: SeriesSymbol;
  // The dots to draw — every replicate, or one per run at its mean. The caller
  // picks (see AppState.showReplicates); drawing doesn't care which it got.
  points: SeriesPoint[];
  // The connecting line goes through the per-push means whichever point set is
  // being drawn, so it needs the pushes regardless.
  pushes: PushGroup[];
};

export type DrawOptions = {
  geom: PlotGeometry;
  xDomain: Range;
  yDomain: Range;
  series: DrawSeries[];
  // Alert triangles and detected-change bars, already projected into pixels and
  // packed into rows by annotations.ts. Passed in rather than derived here
  // because the hit test has to read the very same array — see that module.
  alertSlots?: readonly AlertSlot[];
  changeSlots?: readonly ChangeSlot[];
  dotRadius: number;
  // The detail graph joins the per-push means; the overview deliberately
  // doesn't (task requirement) — at overview density the lines are just noise.
  showLines: boolean;
  showAxes: boolean;
  // The theme's chart colors. Passed in rather than read off the DOM so the
  // drawing stays a function of its arguments — see theme.ts.
  palette: ChartPalette;
  // Turns each dot's stored room into a pixel offset. The caller must hand the
  // same scale to `hitTestAll`, or the cursor and the dots disagree about where
  // the dots are.
  jitter: JitterScale;
};

// Why a point is highlighted. Four states that have to be told apart at a
// glance on a plot with thousands of dots on it:
//
//   selected  — the point the details pane is describing. Filled, solid ring.
//   compared  — the pinned other end of a comparison. Filled, dashed ring: same
//               standing as the selection, but it's the second thing.
//   hovered   — the point a *shift*-click would pin as the comparison. Hollow
//               and dashed — provisional, and not committed to anything.
//   hoverable — the point a *plain* click would select. Hollow and solid.
//
// The last two are one channel answering one question — "what does a click do
// right now" — and which of them is drawn depends on the shift key, not on the
// state of the selection. See `hoverRingKind`.
export type HighlightKind = 'selected' | 'compared' | 'hovered' | 'hoverable';

// The ring on the dot under the pointer.
//
// Null *only* when there is no dot under the pointer. That's the invariant
// worth stating, because the rule this replaces was written per state and left
// one of them out: with a comparison pinned, the hovered dot got no ring at
// all — in the one state where a click has two possible outcomes and so needs
// the feedback most.
//
// The shift key is the whole rule. What a click does depends on it and on
// nothing else, in every state: shift pins the dot as the comparison, no shift
// selects it. Tying the ring to `comparisonSource` instead made it answer a
// different question in each state, and no question at all in one.
//
// This leaves the pane to explain the hover *preview* on its own — it already
// does, with a dashed border and a "shift-click to pin" hint. The two channels
// now have one job each: the ring is what a click will do, the pane is what
// you would get.
export function hoverRingKind(hasHover: boolean, shiftHeld: boolean): HighlightKind | null {
  if (!hasHover) return null;
  return shiftHeld ? 'hovered' : 'hoverable';
}

// A highlighted point, in data coordinates.
//
// `jitter` and `xRoom` are what put the ring on the dot rather than beside it: the
// dot was drawn some way off its push time, and the caller has no point object to
// read that offset from — it resolves a URL triple against the push structure, not
// against the point arrays. So it passes the same two numbers a `SeriesPoint`
// carries and lets the chart scale them (see graphData.ts::jitterForSelection).
export type Highlight = {
  x: number;
  y: number;
  jitter: number;
  xRoom: number;
  color: string;
  kind: HighlightKind;
};

const FONT = '11px system-ui, sans-serif';

export function drawChart(ctx: CanvasRenderingContext2D, o: DrawOptions): void {
  const { geom } = o;
  ctx.clearRect(0, 0, geom.width, geom.height);

  const vTicks = valueTicks(o.yDomain, Math.max(2, Math.round(geom.plotHeight / 45)));
  const tTicks = timeTicks(o.xDomain, Math.max(2, Math.round(geom.plotWidth / 110)));

  drawGrid(ctx, o, vTicks, tTicks);
  // Clip the data to the plot area: a series can legitimately have points a
  // hair outside the padded y domain, and the overview must not paint over
  // its own axis labels.
  ctx.save();
  ctx.beginPath();
  ctx.rect(geom.x0, geom.y0, geom.plotWidth, geom.plotHeight);
  ctx.clip();
  if (o.showLines) {
    for (const s of o.series) drawPushLine(ctx, o, s);
  }
  for (const s of o.series) drawDots(ctx, o, s);
  // Over the dots: a mark is about a build, so it has to be findable without
  // first finding the build's cloud.
  drawChangeBars(ctx, o);
  drawAlerts(ctx, o);
  ctx.restore();
  if (o.showAxes) drawAxisLabels(ctx, o, vTicks, tTicks);
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  o: DrawOptions,
  vTicks: number[],
  tTicks: { value: number }[],
): void {
  const { geom } = o;
  ctx.strokeStyle = o.palette.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const v of vTicks) {
    // Half-pixel offset keeps a 1px line crisp instead of a 2px blur.
    const y = Math.round(geom.yScale.toPixel(v)) + 0.5;
    ctx.moveTo(geom.x0, y);
    ctx.lineTo(geom.x1, y);
  }
  if (o.showAxes) {
    for (const t of tTicks) {
      const x = Math.round(geom.xScale.toPixel(t.value)) + 0.5;
      ctx.moveTo(x, geom.y0);
      ctx.lineTo(x, geom.y1);
    }
  }
  ctx.stroke();

  ctx.strokeStyle = o.palette.axis;
  ctx.beginPath();
  ctx.rect(geom.x0 + 0.5, geom.y0 + 0.5, geom.plotWidth - 1, geom.plotHeight - 1);
  ctx.stroke();
}

function drawAxisLabels(
  ctx: CanvasRenderingContext2D,
  o: DrawOptions,
  vTicks: number[],
  tTicks: { value: number; label: string }[],
): void {
  const { geom } = o;
  ctx.fillStyle = o.palette.text;
  ctx.font = FONT;

  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of vTicks) {
    ctx.fillText(formatTickValue(v), geom.x0 - 6, geom.yScale.toPixel(v));
  }

  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of tTicks) {
    ctx.fillText(t.label, geom.xScale.toPixel(t.value), geom.y1 + 5);
  }
}

// One polyline through the per-push means. Pushes outside the x domain are
// skipped except for the one on each side, so the line still enters and
// leaves the plot area instead of stopping at the edge.
//
// Per *push*, not per run: retriggers of one push share a push timestamp, so
// walking runs put two or more vertices at the same x and drew a vertical
// zigzag there instead of a trend through one value per build.
function drawPushLine(ctx: CanvasRenderingContext2D, o: DrawOptions, s: DrawSeries): void {
  const pushes = s.pushes;
  if (pushes.length < 2) return;
  const lo = Math.max(0, lowerBound(pushes, o.xDomain.min) - 1);
  ctx.strokeStyle = s.color;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 1;
  ctx.beginPath();
  let started = false;
  for (let i = lo; i < pushes.length; i++) {
    const p = pushes[i];
    const x = o.geom.xScale.toPixel(p.x);
    const y = o.geom.yScale.toPixel(p.mean);
    if (started) ctx.lineTo(x, y);
    else {
      ctx.moveTo(x, y);
      started = true;
    }
    if (p.x > o.xDomain.max) break;
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// Alert markers: a triangle hanging from the top of the plot, with a faint
// guide down to the floor.
//
// Treeherder marks an alerted point differently — `GraphsContainer.jsx` gives
// the dot itself a 12px translucent halo in the series color, behind a
// "highlight alerts" toggle. That works there because its graph draws one dot
// per push. Ours draws every replicate, so the alerted "point" is a cloud of
// twenty or a hundred, and a halo would have to go around one arbitrary member
// of it. Hence a marker that belongs to the column rather than to a dot — and
// one light enough not to need a toggle.
//
// At the top rather than on the dots, because an alert belongs to the *build*
// and its dots are a cloud that may be anywhere vertically — a mark inside the
// cloud is one more dot to disentangle, and one at a fixed height is a row of
// marks you can read across. The guide is what ties it to a pixel column; a
// triangle alone at the top of a 700px plot doesn't say which push it means.
//
// Pointing down for a regression and up for an improvement: not "the value went
// up or down" (which lower-is-better makes ambiguous) but the same up-is-good
// convention the verdict badges use.
//
// The dimensions, and which row each marker is on, are annotations.ts's,
// because the hit test needs the same numbers.
const ALERT_GUIDE_ALPHA = 0.22;

function drawAlerts(ctx: CanvasRenderingContext2D, o: DrawOptions): void {
  const slots = o.alertSlots;
  if (!slots?.length) return;
  const { geom } = o;
  for (const slot of slots) {
    const color = slot.isRegression ? o.palette.alertRegression : o.palette.alertImprovement;

    ctx.strokeStyle = color;
    ctx.globalAlpha = ALERT_GUIDE_ALPHA;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(slot.x, geom.y0);
    ctx.lineTo(slot.x, geom.y1);
    ctx.stroke();
    ctx.globalAlpha = 1;

    alertTrianglePath(ctx, geom, slot, 1);
    ctx.fillStyle = color;
    ctx.fill();
    // The series' own color, so a graph with two alerting series says which is
    // which without a legend.
    ctx.strokeStyle = o.series[slot.seriesIndex]?.color ?? color;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// `scale` grows the triangle about its row's top edge, so a scaled one covers
// the unscaled one exactly — which is what lets the hover highlight be painted
// on the overlay layer without erasing the marker underneath it.
function alertTrianglePath(
  ctx: CanvasRenderingContext2D,
  geom: PlotGeometry,
  slot: AlertSlot,
  scale: number,
): void {
  const top = alertRowTop(geom, slot.row);
  const half = ALERT_TRIANGLE_HALF * scale;
  const height = ALERT_TRIANGLE_HEIGHT * scale;
  ctx.beginPath();
  if (slot.isRegression) {
    ctx.moveTo(slot.x, top + height);
    ctx.lineTo(slot.x - half, top);
    ctx.lineTo(slot.x + half, top);
  } else {
    ctx.moveTo(slot.x, top);
    ctx.lineTo(slot.x - half, top + height);
    ctx.lineTo(slot.x + half, top + height);
  }
  ctx.closePath();
}

// Detected-change bars: a step this app found itself, drawn along the plot's
// floor over the pushes the test compared. See changes.ts for what one is and
// annotations.ts for why they live inside the plot rather than under it.
//
// Same color vocabulary as the alert triangles — red for a regression, green
// for an improvement — because they are the same *kind* of statement about the
// same graph, and one of them being somebody else's verdict doesn't change how
// a reader should decode the colors. What tells them apart is the shape: a
// triangle marks a build, a bar covers a range of them.
//
// The bar is translucent, so a cluster of dots on the plot floor stays visible
// through it, and the step's own column is a solid notch rising clear of the
// bar. Without the notch a wide bar says "somewhere in here", which is a worse
// answer than the data supports.
//
// **The notch carries the series color; the bar does not.** The first version
// outlined the bar in it, the way the alert triangles are outlined, and on a
// 5px-tall bar that put two of its five rows of pixels — plus both ends — in a
// color that answers the *less* important question. Screenshotted over two real
// series, every bar read as "the cyan one" or "the dark blue one" and not one
// of them read as red or green. So the two facts swapped places: direction gets
// the area, identity gets the notch, which is 2px of saturated color in the one
// spot the eye is aimed at anyway.
const CHANGE_BAR_ALPHA = 0.55;
const CHANGE_NOTCH_RISE = 4;
const CHANGE_NOTCH_WIDTH = 2;

function drawChangeBars(ctx: CanvasRenderingContext2D, o: DrawOptions): void {
  const slots = o.changeSlots;
  if (!slots?.length) return;
  const { geom } = o;
  for (const slot of slots) {
    const color = slot.isRegression ? o.palette.alertRegression : o.palette.alertImprovement;
    const top = changeBarTop(geom, slot.row);

    ctx.fillStyle = color;
    ctx.globalAlpha = CHANGE_BAR_ALPHA;
    ctx.fillRect(slot.x0, top, slot.x1 - slot.x0, CHANGE_BAR_HEIGHT);
    ctx.globalAlpha = 1;

    ctx.fillStyle = o.series[slot.seriesIndex]?.color ?? color;
    ctx.fillRect(
      Math.round(slot.changeX) - CHANGE_NOTCH_WIDTH / 2,
      top - CHANGE_NOTCH_RISE,
      CHANGE_NOTCH_WIDTH,
      CHANGE_BAR_HEIGHT + CHANGE_NOTCH_RISE,
    );
  }
}

// The marker under the pointer, or the one whose alert the pane is describing,
// repainted on the *overlay*.
//
// Not a flag on DrawSeries: the markers ride the data layer, which holds 100k+
// dots and is only repainted when the data or the domains change. Redrawing it
// on every mousemove that crosses a triangle would undo the whole point of the
// two-layer split (see ScatterChart).
//
// Two changes at once, because either alone is ambiguous. The triangle grows —
// a marker that only brightened could be mistaken for the *other* direction's
// color, which is the one confusion a graph of regressions must not invite —
// and the guide goes from a hint to a line you can actually follow down to the
// column it marks. The alpha composites over the guide already on the data
// layer rather than replacing it.
//
// A *selected* marker gets the same growth, so that clicking one leaves it
// looking the way it did under the pointer instead of springing back to its
// resting size — the click has to look like it stuck. On top of that it wears
// `palette.ring`, the same outline a selected dot wears, which is what tells it
// apart from a marker that is merely hovered: with two markers enlarged at once
// only one of them is what the pane is describing.
const ALERT_HIGHLIGHT_SCALE = 1.4;
const ALERT_HIGHLIGHT_GUIDE_ALPHA = 0.4;
// Stroked *before* the fill, so only its outer half survives and the triangle
// keeps its own colors. Round joins because a mitred 3px stroke grows spikes
// off the triangle's corners.
const ALERT_RING_WIDTH = 3;

export function drawAlertHighlight(
  ctx: CanvasRenderingContext2D,
  geom: PlotGeometry,
  slot: AlertSlot,
  seriesColor: string,
  palette: ChartPalette,
  kind: 'hovered' | 'selected',
): void {
  const color = slot.isRegression ? palette.alertRegression : palette.alertImprovement;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = ALERT_HIGHLIGHT_GUIDE_ALPHA;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(slot.x, geom.y0);
  ctx.lineTo(slot.x, geom.y1);
  ctx.stroke();
  ctx.globalAlpha = 1;

  alertTrianglePath(ctx, geom, slot, ALERT_HIGHLIGHT_SCALE);
  if (kind === 'selected') {
    ctx.strokeStyle = palette.ring;
    ctx.lineWidth = ALERT_RING_WIDTH;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = seriesColor;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();
}

// The same two states for a change bar, and the same two channels carrying
// them: it grows, and its guide becomes a line you can follow.
//
// The guide is the whole reason the resting bar can be as quiet as it is. A bar
// hugging the floor of the plot is a long way from the dots it is about, and
// running a full-height line up the step's column on hover is what connects the
// two — the same trick the alert markers use, and for the same reason.
const CHANGE_HIGHLIGHT_GROW = 2;
const CHANGE_HIGHLIGHT_ALPHA = 0.85;
const CHANGE_HIGHLIGHT_GUIDE_ALPHA = 0.4;

export function drawChangeHighlight(
  ctx: CanvasRenderingContext2D,
  geom: PlotGeometry,
  slot: ChangeSlot,
  seriesColor: string,
  palette: ChartPalette,
  kind: 'hovered' | 'selected',
): void {
  const color = slot.isRegression ? palette.alertRegression : palette.alertImprovement;
  // Grown downward as well as up, so the enlarged bar covers the resting one
  // that is still painted on the data layer underneath it.
  const top = changeBarTop(geom, slot.row) - CHANGE_HIGHLIGHT_GROW;
  const height = CHANGE_BAR_HEIGHT + CHANGE_HIGHLIGHT_GROW * 2;
  const width = slot.x1 - slot.x0;
  const notchX = Math.round(slot.changeX);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = CHANGE_HIGHLIGHT_GUIDE_ALPHA;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(notchX + 0.5, geom.y0);
  ctx.lineTo(notchX + 0.5, geom.y1);
  ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.globalAlpha = CHANGE_HIGHLIGHT_ALPHA;
  ctx.fillStyle = color;
  ctx.fillRect(slot.x0, top, width, height);
  ctx.globalAlpha = 1;

  // The notch survives the highlight, in the series color, so an enlarged bar
  // still says which line it belongs to and where the step is.
  ctx.fillStyle = seriesColor;
  ctx.fillRect(
    notchX - CHANGE_NOTCH_WIDTH / 2,
    top - CHANGE_NOTCH_RISE,
    CHANGE_NOTCH_WIDTH,
    height + CHANGE_NOTCH_RISE,
  );

  // A ring only for the selected bar, the same one a selected marker and a
  // selected dot wear — with two bars enlarged at once, only one of them is
  // what the pane is describing.
  if (kind === 'selected') {
    ctx.strokeStyle = palette.ring;
    ctx.lineWidth = 2;
    ctx.strokeRect(
      Math.round(slot.x0) + 1,
      Math.round(top) + 1,
      Math.max(1, Math.round(width) - 2),
      height - 2,
    );
  }
  ctx.restore();
}

// Shape scaling, so the three symbols carry about the same amount of ink at a
// given `dotRadius`: a square of side 2r covers 4r² against a circle's πr², a
// diamond with half-diagonal r only 2r². Without this the squares read as the
// biggest series on the graph and the diamonds as the smallest.
const SQUARE_HALF_SIDE = 0.886; // √(π)/2
const DIAMOND_HALF_DIAGONAL = 1.253; // √(π/2)

// Trace one symbol as its own subpath. Each ends closed, so a batched path can
// be filled or stroked in one go.
function traceSymbol(
  ctx: CanvasRenderingContext2D,
  shape: SeriesShape,
  x: number,
  y: number,
  r: number,
): void {
  if (shape === 'square') {
    const h = r * SQUARE_HALF_SIDE;
    ctx.rect(x - h, y - h, h * 2, h * 2);
    return;
  }
  if (shape === 'diamond') {
    const d = r * DIAMOND_HALF_DIAGONAL;
    ctx.moveTo(x, y - d);
    ctx.lineTo(x + d, y);
    ctx.lineTo(x, y + d);
    ctx.lineTo(x - d, y);
    ctx.closePath();
    return;
  }
  // `moveTo` first, or the arc is joined to the previous subpath by a line.
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

// How opaque one dot is. One dot covers half the background, two 75%, four 94%,
// so the bulk of a cloud is where the color saturates and a lone outlier is
// visibly lighter than the crowd. It was 0.75, which is past the useful range:
// two dots already reached 94% and every cluster from two upwards looked the
// same.
//
// Not lower, because the palette's light end has to survive it too: orange
// (#FFB851, the fifth series) at 0.5 on the light theme's canvas is still a
// visible dot, and below about 0.4 it stops being one.
//
// Filled and outline symbols share the value: the stroke width scales with the
// radius (see below), which happens to leave the two carrying about the same
// area of ink, so one alpha gives them the same weight.
const DOT_ALPHA = 0.5;

// How many paths a series' dots are split across, which is what makes the
// accumulated numbers above true — see `drawDots`. It also caps the accumulation,
// at 1 − (1 − DOT_ALPHA)^DOT_PATHS ≈ 99.6% for eight; that's past the point where
// another path changes a pixel.
const DOT_PATHS = 8;

// All dots of one series, split across DOT_PATHS paths — point i goes into path
// i % DOT_PATHS — each filled (or stroked) once.
//
// **The split is what makes the dots' translucency mean anything, and the reason
// is that canvas composites per draw call, not per shape.** `fill()` rasterizes
// the whole path into a coverage mask first — under the nonzero winding rule a
// pixel inside two overlapping circles has coverage 1, exactly like a pixel inside
// one — and then composites the paint through that mask a single time. So one path
// per series, which is the obvious batching and is what this did at first, gave
// sixty overlapping replicates the same flat 50% as a lone outlier: a series-wide
// opacity rather than density. Note that this has nothing to do with *how* the
// translucency is expressed; a `rgba(…, 0.5)` fill style behaves identically,
// because it's still one composite. The overlapping dots have to be in different
// draw calls, and that's all this is.
//
// Split **by index** rather than by anything semantic, because overlapping dots
// are the ones adjacent in the array: the points are x-sorted, so a run's
// replicates are consecutive, and any DOT_PATHS consecutive dots are guaranteed to
// land in that many distinct paths. Dots further apart in the array (neighbouring
// pushes at a wide zoom) accumulate too, just probabilistically — they collide in
// the same path 1 time in 8.
//
// **Worth simplifying to one `fill()` per dot, once someone measures it
// properly.** That would drop the interleaving and the `DOT_PATHS` constant
// entirely and make the accumulation exact instead of approximate, and the
// expectation is that it performs fine. What's measured so far is only headless
// Chrome under software rasterization, over 111k dots — ratios, not absolutes: a
// full repaint takes 63ms with one path per series, 59ms with four, 66ms with
// eight, 63ms with sixteen, and 69ms with a fill per dot. All inside each other's
// noise, because rasterizing the dots dominates whatever the call count is. The
// open question is a GPU-backed canvas, where the per-draw-call overhead that a
// software rasterizer can't see is what the batching was here for in the first
// place — measure a repaint on real hardware at 100k+ dots before deciding. Until
// then eight paths are the conservative version of the same effect.
//
// Outline symbols are deliberately *not* filled white the way treeherder fills
// them: an opaque fill would turn a dense cluster into a flat blob, and a
// translucent white one into a milky smear over the series behind.
//
// Each dot is nudged sideways by its own share of the room around its push.
// Without that, every replicate of a run lands on that run's push timestamp and a
// 25-replicate run draws as one vertical line, in which the only legible feature
// is its extremes. See chart.ts, "Jitter".
function drawDots(ctx: CanvasRenderingContext2D, o: DrawOptions, s: DrawSeries): void {
  const points = s.points;
  if (points.length === 0) return;
  const { geom } = o;
  const r = o.dotRadius;
  // The widest a symbol reaches from its centre, for the cull below.
  const reach = r * DIAMOND_HALF_DIAGONAL + 1;
  // Widened by the jitter's ceiling, so the dots the loop covers are the same
  // ones the hit test considers. Both ends: a dot can be nudged either way.
  const slack = pixelSpan(geom.xScale, o.jitter.maxPx);
  const start = lowerBound(points, o.xDomain.min - slack);
  ctx.globalAlpha = DOT_ALPHA;
  // Set once for all the paths below; neither fill() nor stroke() disturbs it.
  if (s.symbol.filled) {
    ctx.fillStyle = s.color;
  } else {
    ctx.strokeStyle = s.color;
    // Thin enough that the hole in the middle survives at the overview's dot
    // size, where a 1.5px stroke would close a 1px-radius ring into a blob.
    ctx.lineWidth = Math.min(1.5, Math.max(0.75, r * 0.5));
  }
  for (let path = 0; path < DOT_PATHS; path++) {
    ctx.beginPath();
    // Each path walks its own x-sorted subsequence, so the break is still sound.
    for (let i = start + path; i < points.length; i += DOT_PATHS) {
      const p = points[i];
      if (p.x > o.xDomain.max + slack) break;
      const x = geom.xScale.toPixel(p.x) + jitterOffsetPx(p, o.jitter);
      const y = geom.yScale.toPixel(p.y);
      // Cheap vertical cull: points can sit outside a zoomed y domain.
      if (y < geom.y0 - reach || y > geom.y1 + reach) continue;
      traceSymbol(ctx, s.symbol.shape, x, y, r);
    }
    if (s.symbol.filled) ctx.fill();
    else ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// Drawn on the overlay layer, not with the data: highlights move far more often
// than 100k dots want to be repainted — and the hovered one moves on every
// mousemove.
//
// Painted in increasing order of standing, so the selection ends up on top when
// two of them land on the same dot.
const HIGHLIGHT_ORDER: HighlightKind[] = ['hoverable', 'hovered', 'compared', 'selected'];

export function drawHighlights(
  ctx: CanvasRenderingContext2D,
  geom: PlotGeometry,
  highlights: Highlight[],
  dotRadius: number,
  palette: ChartPalette,
  // The same scale the dots were drawn with.
  jitter: JitterScale,
): void {
  for (const kind of HIGHLIGHT_ORDER) {
    for (const h of highlights) {
      if (h.kind === kind) drawHighlight(ctx, geom, h, dotRadius, palette, jitter);
    }
  }
}

function drawHighlight(
  ctx: CanvasRenderingContext2D,
  geom: PlotGeometry,
  h: Highlight,
  dotRadius: number,
  palette: ChartPalette,
  jitter: JitterScale,
): void {
  const x = geom.xScale.toPixel(h.x) + jitterOffsetPx(h, jitter);
  const y = geom.yScale.toPixel(h.y);
  // Off-plot highlights (a point outside the zoomed window) must not paint
  // over the axes.
  if (x < geom.x0 || x > geom.x1 || y < geom.y0 || y > geom.y1) return;
  const hover = h.kind === 'hovered' || h.kind === 'hoverable';
  const r = dotRadius + (hover ? 4 : 3);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  // Hollow for a hover: it marks a point the user hasn't committed to, and a
  // filled disc following the pointer around reads as a selection that keeps
  // moving.
  if (!hover) {
    ctx.fillStyle = h.color;
    ctx.fill();
  }
  ctx.lineWidth = 2;
  ctx.strokeStyle = palette.ring;
  // Dashes mean "provisional second end of a comparison", which is why the
  // plain hover ring is solid: nothing is selected, so it is previewing a
  // selection rather than a comparison.
  ctx.setLineDash(h.kind === 'compared' || h.kind === 'hovered' ? [3, 2] : []);
  ctx.stroke();
  ctx.setLineDash([]);
}

// The overview graph dims everything outside the zoomed window and draws a
// handle on each edge.
export function drawBrush(
  ctx: CanvasRenderingContext2D,
  geom: PlotGeometry,
  fromPx: number,
  toPx: number,
  palette: ChartPalette,
): void {
  const lo = Math.max(geom.x0, Math.min(fromPx, toPx));
  const hi = Math.min(geom.x1, Math.max(fromPx, toPx));
  ctx.save();
  ctx.fillStyle = palette.brushDim;
  if (lo > geom.x0) ctx.fillRect(geom.x0, geom.y0, lo - geom.x0, geom.plotHeight);
  if (hi < geom.x1) ctx.fillRect(hi, geom.y0, geom.x1 - hi, geom.plotHeight);

  ctx.strokeStyle = palette.brushLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(lo) + 0.5, geom.y0);
  ctx.lineTo(Math.round(lo) + 0.5, geom.y1);
  ctx.moveTo(Math.round(hi) + 0.5, geom.y0);
  ctx.lineTo(Math.round(hi) + 0.5, geom.y1);
  ctx.stroke();

  ctx.fillStyle = palette.brushLine;
  const handleH = Math.min(18, geom.plotHeight);
  const handleY = geom.y0 + (geom.plotHeight - handleH) / 2;
  ctx.fillRect(Math.round(lo) - 1.5, handleY, 3, handleH);
  ctx.fillRect(Math.round(hi) - 1.5, handleY, 3, handleH);
  ctx.restore();
}
