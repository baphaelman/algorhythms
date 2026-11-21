/**
 * `drawScore`: the pure score painter shared by the player, the editor and export (PLAN.md §10).
 * No globals, no React: everything arrives as arguments. Layers, back to front:
 *
 *   1. background          2. octave grid (A lines labelled in Hz), bar grid (editor)
 *   3. moment/section markers
 *   4. lines (past solid, future ghost)   5. heads (dots, motion rings, Hz labels)
 *   6. playhead            7. HUD (chord, key, voices, time)
 *
 * The editor overlay (§11) is drawn by the app on top of this.
 */

import {
  activeAt,
  chordAt,
  lifeAt,
  keyAt,
  motionAt,
  pitchAt,
  sample,
  segmentIndexAt,
} from '../core/query';
import { hzOf } from '../core/tuning';
import type {
  CompiledScore,
  CompiledVoice,
  Key,
  Life,
  MomentId,
  MomentSpan,
  Seconds,
} from '../core/types';
import { barGrid } from './bars';
import { cameraAt, cameraScore, pitchToY, timeToX } from './camera';
import { drawGhost, ghostOf } from './ghost';
import { OPACITY_EPS, breaksIn, opacityIn } from './level';
import { outlineFrame, outlinePath } from './outline';
import { lineColor, pitchStops } from './palettes';
import {
  drawnLives,
  geometryAt,
  hasStrands,
  strandEvents,
  strandFrame,
  varyingRanges,
  widthUnits,
  type StrandFrame,
} from './strands';
import type { CameraState, MomentTimes, ScoreStyle, View } from './types';

/** A 2D context drawScore can paint on (a canvas, an offscreen canvas, or a test double). */
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Default monospace stack, as in the prototype. */
export const DEFAULT_MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** Pixel spacing of glide samples. */
export const GLIDE_STEP_PX = 2;
/** Pitches of the labelled grid lines: the A of each octave (A0 .. A7). */
const A_PITCHES = [21, 33, 45, 57, 69, 81, 93, 105];
/** Head dot and motion ring radii, px. */
const DOT_R = 2.6;
/** Opacity factor of unselected lines while a selection is highlighted. */
export const DIM_ALPHA = 0.3;
/** Line width of weight-1 lines, px. */
export const LINE_WIDTH = 1.5;
/** Line width of highlighted weight-1 segments, px. */
export const HIGHLIGHT_WIDTH = 2.75;
/** The dotted trace is checked for silence in steps of about this many px (at most 16). */
const TRACE_STEP_PX = 24;
const TRACE_STEPS_MAX = 16;
const RING_R = 6.5;

/** `mm:ss.s` */
export function formatTime(t: Seconds): string {
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  return String(m).padStart(2, '0') + ':' + (s - m * 60).toFixed(1).padStart(4, '0');
}

/** Display name of a key, e.g. "D dorian". */
export function keyName(key: Key): string {
  const scale = typeof key.scale === 'string' ? key.scale : (key.scale.name ?? 'custom');
  return `${key.tonic} ${scale.replace(/-/g, ' ')}`;
}

interface Marker {
  id: MomentId;
  t: Seconds;
}

/** Markers in ascending time order, cached per `momentSpans` array and `markerTimes` object. */
const sortedMarkers = new WeakMap<readonly MomentSpan[], { times?: MomentTimes; out: Marker[] }>();
function markersByTime(spans: readonly MomentSpan[], times?: MomentTimes): Marker[] {
  const hit = sortedMarkers.get(spans);
  if (hit && hit.times === times) return hit.out;
  const out = spans
    .map((s) => ({ id: s.id, t: times?.[s.id] ?? s.start }))
    .sort((a, b) => a.t - b.t);
  sortedMarkers.set(spans, { times, out });
  return out;
}

/**
 * Paints one frame.
 *
 * @param ctx2d  context of a canvas whose pixel size is `size · dpr`
 * @param compiled the score (read through core/query only)
 * @param camera the user-controlled view (start, window); see `cameraAt` for the maths
 * @param style  theme tokens, colouring, ghost opacity, labels
 * @param t      playhead time in seconds
 * @param size   canvas size in CSS pixels
 * @param dpr    device pixel ratio; the context is set to scale by it
 * @returns the resolved view (for hit-testing the same frame)
 */
export function drawScore(
  ctx2d: Ctx2D,
  compiled: CompiledScore,
  camera: CameraState,
  style: ScoreStyle,
  t: Seconds,
  size: { width: number; height: number },
  dpr: number,
): View {
  const g = ctx2d as CanvasRenderingContext2D;
  const { width: W, height: H } = size;
  const C = style.tokens;
  const MONO = style.fontMono ?? DEFAULT_MONO;
  const view = cameraAt(cameraScore(compiled), camera, t, size, style.hud);
  const { padT, padB, padL, padR } = view;

  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.globalAlpha = 1;

  // 1. background
  g.fillStyle = C.paper;
  g.fillRect(0, 0, W, H);

  // 2. octave grid
  g.lineWidth = 1;
  g.font = `10px ${MONO}`;
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  for (const n of A_PITCHES) {
    if (n < view.pLo || n > view.pHi) continue;
    const y = Math.round(pitchToY(view, n)) + 0.5;
    g.strokeStyle = C.rule;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
    g.fillStyle = C.ink2;
    g.globalAlpha = 0.75;
    g.fillText(
      `A${Math.floor(n / 12) - 1} ${hzOf(n, compiled.referenceHz).toFixed(0)} Hz`,
      6 + (style.axisInset ?? 0),
      y - 4,
    );
    g.globalAlpha = 1;
  }

  if (style.bars) drawBars(g, style.bars, view, C);

  // 3. moment and section markers
  drawMarkers(g, compiled, style, view, MONO);

  // 4. lines (up to the composer's pen while Compose for me builds)
  const clip = style.reveal !== undefined && Number.isFinite(style.reveal);
  if (clip) {
    g.save();
    g.beginPath();
    g.rect(0, 0, Math.max(0, timeToX(view, style.reveal ?? 0)), H);
    g.clip();
  }
  const sf = strandFrame(compiled, view.pps);
  drawLines(g, compiled, style, view, sf, dpr);
  if (clip) g.restore();
  if (style.preview) drawPreview(g, style.preview.score, style.preview.from, style, view);

  // 5. heads
  const headA = style.heads === false ? 0 : 1;
  const xH = view.xHead;
  if (headA > 0.02 && xH > -RING_R && xH < W + RING_R) {
    drawHeads(g, compiled, style, view, headA, MONO, sf);
  }

  // 6. playhead (the editor layout draws a DOM one instead)
  if (style.playhead !== false) {
    g.strokeStyle = C.rule;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(Math.round(xH) + 0.5, padT - 6);
    g.lineTo(Math.round(xH) + 0.5, H - padB + 6);
    g.stroke();
  }

  // 7. HUD
  if (style.hud) drawHud(g, compiled, style, view, MONO, padL, padR);
  return view;
}

/** Beat lines (faint) and bar lines (stronger) across the plot area; no allocation. */
function drawBars(
  g: CanvasRenderingContext2D,
  bars: { bpm?: number; meter?: number },
  view: View,
  C: ScoreStyle['tokens'],
): void {
  const { beat, bar } = barGrid(bars.bpm, bars.meter, view.pps);
  const { tL, tR, padT, padB, height: H } = view;
  const y0 = padT - 6;
  const y1 = H - padB + 6;
  g.lineWidth = 1;
  for (let pass = 0; pass < 2; pass++) {
    const step = pass === 0 ? beat : bar;
    if (!(step > 0)) continue;
    // Beats: the faint rule; bars: the secondary ink, light.
    g.strokeStyle = pass === 0 ? C.rule : C.ink2;
    g.globalAlpha = pass === 0 ? 0.6 : 0.3;
    g.beginPath();
    for (let k = Math.ceil(tL / step - 1e-9); k * step <= tR + 1e-9; k++) {
      const t = k * step;
      // Beats under a bar line are left to the bar pass.
      if (pass === 0 && Math.abs(t / bar - Math.round(t / bar)) < 1e-6) continue;
      const x = Math.round(timeToX(view, t)) + 0.5;
      g.moveTo(x, y0);
      g.lineTo(x, y1);
    }
    g.stroke();
  }
  g.globalAlpha = 1;
}

function drawMarkers(
  g: CanvasRenderingContext2D,
  compiled: CompiledScore,
  style: ScoreStyle,
  view: View,
  MONO: string,
): void {
  const spans = compiled.momentSpans;
  if (spans.length === 0) return;
  const C = style.tokens;
  const { padT, padB, width: W, height: H } = view;
  const labels = style.labels;
  const labelY = padT * 0.45;
  g.font = `500 9.5px ${MONO}`;
  const ls = g as CanvasRenderingContext2D & { letterSpacing?: string };
  if ('letterSpacing' in g) ls.letterSpacing = '1px';
  g.lineWidth = 1;
  g.strokeStyle = C.rule;
  g.fillStyle = C.ink2;
  let lastEnd = -1e9;
  for (const s of markersByTime(spans, style.markerTimes)) {
    const x = Math.round(timeToX(view, s.t)) + 0.5;
    if (x > W + 1) break;
    if (x < -1) continue;
    const label = labels?.[s.id];
    g.beginPath();
    if (label) {
      g.moveTo(x, labelY - 8);
      g.lineTo(x, H - padB + 6);
    } else {
      g.moveTo(x, padT - 8);
      g.lineTo(x, padT + 4);
    }
    g.stroke();
    if (label) {
      const text = label.toUpperCase();
      const w = g.measureText(text).width;
      if (x >= lastEnd + 8 && x + 4 + w < W) {
        g.fillText(text, x + 4, labelY);
        lastEnd = x + 4 + w;
      }
    }
  }
  if ('letterSpacing' in g) ls.letterSpacing = '0px';
}

/**
 * Stroke width of a line of weight `w` (revision 8, "Distinct notes": weight drawn as thickness):
 * `base`·√w, so area tracks loudness power; weight 1 is `base`, 8 about 2.8×. Clamped to
 * [WEIGHT_MIN, WEIGHT_MAX].
 */
export function weightWidth(w: number, base: number): number {
  return w === 1 ? base : base * widthUnits(w);
}

/** Opacity steps narrower than this count as a constant run. */
const OPACITY_FLAT = 1e-3;
/** An opacity ramp is filled in slices whose alpha differs by at most this. */
const ALPHA_STEP = 0.025;
const NO_RANGES: number[] = [];

// Scratch arrays of the outline path, grown as needed and reused across frames.
let SN = 0;
let ST = new Float64Array(0);
let SP = new Float64Array(0);
let SA = new Float64Array(0);
let SR = new Uint8Array(0);
let SX = new Float64Array(0);
let SY = new Float64Array(0);
let SU = new Float64Array(0);
let SNX = new Float64Array(0);
let SNY = new Float64Array(0);
let SH = new Float64Array(0);
function grow(n: number): void {
  if (n <= ST.length) return;
  const m = Math.max(n, ST.length * 2, 256);
  const g2 = (a: Float64Array): Float64Array<ArrayBuffer> => {
    const b = new Float64Array(m);
    b.set(a);
    return b;
  };
  const r = new Uint8Array(m);
  r.set(SR);
  SR = r;
  ST = g2(ST);
  SP = g2(SP);
  SA = g2(SA);
  SX = new Float64Array(m);
  SY = new Float64Array(m);
  SU = new Float64Array(m);
  SNX = new Float64Array(m);
  SNY = new Float64Array(m);
  SH = new Float64Array(m);
}
/**
 * Appends a centre-line point (time, pitch) and the alpha of the interval ending at it, which is
 * part of an opacity ramp or not.
 */
function push(t: number, p: number, a: number, ramp: boolean): void {
  grow(SN + 1);
  ST[SN] = t;
  SP[SN] = p;
  SA[SN] = a;
  SR[SN] = ramp ? 1 : 0;
  SN++;
}

/**
 * Draws voice `v` over [a, b] at `base` width scaled by its weight and at `alpha` times its
 * audible level (revision 9, "Silent lines vanish"), with merges and splits drawn as strands and
 * ropes (strands.ts; owner 2026-11-21, "Thickness transitions"). A line whose width, place and
 * opacity never change is one stroke; any other is filled as a variable-width outline: one shape
 * per run of equal opacity, thin slices through an opacity ramp, straight ends where pieces meet
 * and round ends only at a line's true start and end (and at a and b).
 */
function traceWeighted(
  g: CanvasRenderingContext2D,
  view: View,
  v: CompiledVoice,
  a: Seconds,
  b: Seconds,
  base: number,
  alpha: number,
  maxStep: number,
  tolerance: number,
  sf: StrandFrame,
): void {
  const weighted = v.weight !== undefined && v.weight.length > 0;
  const strands = hasStrands(sf, v);
  const lives = drawnLives(sf, v);
  const O = breaksIn(v, lives);
  if (!weighted && !strands && !O) {
    g.globalAlpha = alpha;
    g.lineWidth = base;
    trace(g, view, sample(v, a, b, maxStep, tolerance));
    return;
  }
  g.fillStyle = g.strokeStyle;
  const events = strandEvents(sf, v);
  const vary = weighted || strands ? varyingRanges(sf, v, a, b) : NO_RANGES;
  for (const l of lives) {
    const lo = l.born > a ? l.born : a;
    const hi = l.died !== undefined && l.died < b ? l.died : b;
    if (!(hi > lo)) continue;
    let p0 = lo;
    for (const e of events) {
      if (e <= lo + EVENT_EPS || e >= hi - EVENT_EPS) continue;
      tracePiece(g, view, v, lives, O, vary, p0, e, events, base, alpha, maxStep, tolerance, sf);
      p0 = e;
    }
    tracePiece(g, view, v, lives, O, vary, p0, hi, events, base, alpha, maxStep, tolerance, sf);
  }
}
const EVENT_EPS = 1e-6;

function isEvent(events: readonly number[], t: Seconds): boolean {
  for (const e of events) if (Math.abs(e - t) <= EVENT_EPS) return true;
  return false;
}

function inRanges(r: readonly number[], t: Seconds): boolean {
  for (let i = 0; i + 1 < r.length; i += 2) if (r[i] <= t && r[i + 1] >= t) return true;
  return false;
}

function overlaps(r: readonly number[], t0: Seconds, t1: Seconds): boolean {
  for (let i = 0; i + 1 < r.length; i += 2) if (r[i] < t1 && r[i + 1] > t0) return true;
  return false;
}

/** One piece of one life with continuous geometry, [p0, p1]: sampled, then filled in slices. */
function tracePiece(
  g: CanvasRenderingContext2D,
  view: View,
  v: CompiledVoice,
  lives: readonly Life[],
  O: Float64Array | null,
  vary: readonly number[],
  p0: Seconds,
  p1: Seconds,
  events: readonly number[],
  base: number,
  alpha: number,
  maxStep: number,
  tolerance: number,
  sf: StrandFrame,
): void {
  SN = 0;
  // Sub-intervals between opacity breaks: constant opacity, or a ramp sampled densely.
  let c0 = p0;
  let i = O ? lowerBound(O, p0) : 0;
  for (;;) {
    let c1 = p1;
    while (O && i < O.length && O[i] <= c0) i++;
    if (O && i < O.length && O[i] < p1) c1 = O[i];
    let ramp = false;
    let o = alpha;
    if (O) {
      const e = (c1 - c0) * 1e-3;
      const o0 = opacityIn(v, lives, c0 + e);
      ramp =
        Math.abs(opacityIn(v, lives, c1 - e) - o0) > OPACITY_FLAT ||
        Math.abs(opacityIn(v, lives, (c0 + c1) / 2) - o0) > OPACITY_FLAT;
      o = alpha * (ramp ? o0 : opacityIn(v, lives, (c0 + c1) / 2));
    }
    const dense = ramp || overlaps(vary, c0, c1);
    const pts = sample(v, c0, c1, maxStep, tolerance);
    let lastO = o;
    for (let k = 0; k < pts.length; k++) {
      const t = pts[k][0];
      const p = pts[k][1];
      if (p !== p) continue;
      if (SN > 0 && t <= ST[SN - 1]) continue; // the shared end of the previous sub-interval
      if (SN > 0 && dense) {
        const ta = ST[SN - 1];
        const pa = SP[SN - 1];
        const n = Math.ceil((t - ta) / maxStep);
        for (let j = 1; j < n; j++) {
          const tj = ta + ((t - ta) * j) / n;
          const oj = ramp ? alpha * opacityIn(v, lives, tj) : o;
          push(tj, pa + ((p - pa) * j) / n, ramp ? (lastO + oj) / 2 : o, ramp);
          lastO = oj;
        }
      }
      const ok = ramp ? alpha * opacityIn(v, lives, t < c1 ? t : c1 - (c1 - c0) * 1e-3) : o;
      push(t, p, ramp ? (lastO + ok) / 2 : o, ramp);
      lastO = ok;
    }
    if (c1 >= p1) break;
    c0 = c1;
  }
  const n = SN;
  if (n < 2) return;
  const shaped = v.weight !== undefined || hasStrands(sf, v);
  // Between varying ranges the geometry is constant (weights step only at piece ends): it is
  // evaluated once per such stretch.
  let cu = NaN;
  let coff = 0;
  for (let k = 0; k < n; k++) {
    const t = ST[k];
    let u = 1;
    let off = 0;
    if (shaped) {
      const side = k === 0 ? 1 : k === n - 1 ? -1 : 0;
      if (side !== 0 || inRanges(vary, t)) {
        const q = geometryAt(sf, v, t, side);
        u = q.u;
        off = q.off;
        cu = NaN; // a constant stretch after a varying one may differ from the one before
      } else {
        if (cu !== cu) {
          const q = geometryAt(sf, v, t);
          cu = q.u;
          coff = q.off;
        }
        u = cu;
        off = coff;
      }
    }
    SX[k] = timeToX(view, t);
    SY[k] = pitchToY(view, SP[k]) + off * base;
    SU[k] = u * base;
  }
  outlineFrame(SX, SY, SU, n, SNX, SNY, SH);
  const capStart = !isEvent(events, p0);
  const capEnd = !isEvent(events, p1);
  const minA = OPACITY_EPS * alpha;
  // Slices of near-equal alpha; SA[k] is the alpha of the interval ending at point k.
  let j0 = 0;
  let sum = 0;
  let cnt = 0;
  for (let j = 1; j < n; j++) {
    sum += SA[j];
    cnt++;
    const last = j === n - 1;
    if (!last && SR[j + 1] === SR[j0 + 1]) {
      const d = Math.abs(SA[j + 1] - SA[j0 + 1]);
      if (SR[j + 1] ? d <= ALPHA_STEP : d === 0) continue;
    }
    const al = sum / cnt;
    if (al >= minA) {
      g.globalAlpha = al;
      g.beginPath();
      outlinePath(g, SX, SY, SNX, SNY, SH, j0, j, capStart && j0 === 0, capEnd && last);
      g.fill();
    }
    j0 = j;
    sum = 0;
    cnt = 0;
  }
}

/** First index i with xs[i] >= t. */
function lowerBound(xs: Float64Array, t: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Opacity factor under which a selected or hovered line gets its dotted trace (editor). */
export const TRACE_BELOW = 0.25;
/** Opacity, width and dash of the dotted trace. */
export const TRACE_ALPHA = 0.55;
const TRACE_WIDTH = 1.25;
const TRACE_DASH = [1, 4];

/**
 * The editor's dotted trace (revision 9): where voice `v` is (nearly) silent over [a, b], a faint
 * dotted line, so a vanished line can still be found and selected.
 */
function traceSilent(
  g: CanvasRenderingContext2D,
  view: View,
  v: CompiledVoice,
  a: Seconds,
  b: Seconds,
  alpha: number,
  maxStep: number,
  tolerance: number,
  sf: StrandFrame,
): void {
  const lives = drawnLives(sf, v);
  const O = breaksIn(v, lives);
  if (!O || !(b > a)) return;
  const cuts = [a];
  for (let i = lowerBound(O, a); i < O.length && O[i] < b; i++) if (O[i] > a) cuts.push(O[i]);
  cuts.push(b);
  g.globalAlpha = alpha;
  g.lineWidth = TRACE_WIDTH;
  g.setLineDash(TRACE_DASH);
  for (let i = 0; i + 1 < cuts.length; i++) {
    const t0 = cuts[i];
    const t1 = cuts[i + 1];
    if (!(t1 > t0)) continue;
    // A ramp is split where it crosses TRACE_BELOW, in steps.
    const n = Math.min(
      TRACE_STEPS_MAX,
      Math.max(1, Math.ceil(((t1 - t0) * view.pps) / TRACE_STEP_PX)),
    );
    let runA = NaN;
    for (let k = 0; k <= n; k++) {
      const u0 = t0 + ((t1 - t0) * k) / n;
      const u1 = t0 + ((t1 - t0) * (k + 1)) / n;
      const silent = k < n && lifeSilent(v, lives, (u0 + u1) / 2);
      if (silent && runA !== runA) runA = u0;
      if (!silent && runA === runA) {
        trace(g, view, sample(v, runA, u0, maxStep, tolerance), sf, v);
        runA = NaN;
      }
    }
  }
  g.setLineDash(NO_DASH);
}
const NO_DASH: number[] = [];

/** True when v is alive at t but drawn below TRACE_BELOW. */
function lifeSilent(v: CompiledVoice, lives: readonly Life[], t: Seconds): boolean {
  if (!lifeAt(v, t)) return false;
  if (lives !== v.lives && !lives.some((l) => t >= l.born && (l.died === undefined || t < l.died)))
    return false;
  return opacityIn(v, lives, t) < TRACE_BELOW;
}

/**
 * Level changes of a selected level moment (it adds no segments): `v`'s first change that matches
 * a selected moment's span (start t, end t + over), or NaN. Level changes carry no moment id.
 */
function selectedLevelFrom(
  v: CompiledVoice,
  spans: readonly MomentSpan[],
  ids: ReadonlySet<MomentId>,
): Seconds {
  if (v.level.length === 0) return NaN;
  for (const s of spans) {
    if (!ids.has(s.id)) continue;
    for (const c of v.level) {
      if (Math.abs(c.t - s.start) < 1e-9 && Math.abs(c.t + c.over - s.end) < 1e-9) return c.t;
    }
  }
  return NaN;
}

/** The pitch colouring's vertical gradient on `g`, or null for the other colourings. */
function pitchGradient(g: Ctx2D, style: ScoreStyle, view: View): CanvasGradient | null {
  if (style.colors !== 'pitch') return null;
  const gradient = g.createLinearGradient(0, pitchToY(view, view.pLo), 0, pitchToY(view, view.pHi));
  for (const s of pitchStops(style.dark, style.oklch)) gradient.addColorStop(s.at, s.color);
  return gradient;
}

function drawLines(
  g: CanvasRenderingContext2D,
  compiled: CompiledScore,
  style: ScoreStyle,
  view: View,
  sf: StrandFrame,
  dpr: number,
): void {
  const { t, tL, tR, pps } = view;
  const pxPerSemitone = (view.height - view.padT - view.padB) / (view.pHi - view.pLo);
  const maxStep = GLIDE_STEP_PX / pps;
  const tolerance = 0.35 / pxPerSemitone; // under a third of a pixel of chord error
  const ghost = style.futureOpacity > 0.01;
  g.lineWidth = LINE_WIDTH;
  g.lineJoin = 'round';
  g.lineCap = 'round';

  const gradient = pitchGradient(g, style, view);

  const past = t > tL;
  const future = ghost && t < tR;
  const hl = style.highlight && style.highlight.size > 0 ? style.highlight : null;
  const dim = hl ? DIM_ALPHA : 1;
  const voices = compiled.voices;
  // A translucent future where strands overlap goes through the ghost layer.
  const gh =
    t < tR && style.futureOpacity < 1
      ? ghostOf(g, voices, view, sf, hl ? HIGHLIGHT_WIDTH : LINE_WIDTH, dpr)
      : null;
  const ghGradient = gh ? pitchGradient(gh.layer.g, style, view) : null;
  const futureA = style.futureOpacity * dim;
  for (const v of voices) {
    if (v.segments.length === 0) continue;
    g.strokeStyle = gradient ?? lineColor(style, v.index) ?? style.tokens.ink;
    if (past)
      traceWeighted(g, view, v, tL, Math.min(t, tR), LINE_WIDTH, dim, maxStep, tolerance, sf);
    if (future && !gh) {
      const a = Math.max(t, tL);
      traceWeighted(g, view, v, a, tR, LINE_WIDTH, futureA, maxStep, tolerance, sf);
    }
  }
  if (future && gh) {
    const a0 = Math.max(t, tL);
    drawGhost(
      g,
      gh,
      voices,
      style,
      view,
      dpr,
      gradient,
      ghGradient,
      futureA,
      (ctx, v, al, lo, hi) => {
        const a = Math.max(a0, lo);
        const b = Math.min(tR, hi);
        if (b > a) traceWeighted(ctx, view, v, a, b, LINE_WIDTH, al, maxStep, tolerance, sf);
      },
    );
  }
  if (hl) {
    // Selected segments on top, thicker; the future part stays visible even with no ghost.
    const hlA = Math.max(style.futureOpacity, 0.6);
    const hg = hlA < 1 ? gh : null;
    for (const v of voices) {
      if (v.segments.length === 0) continue;
      g.strokeStyle = gradient ?? lineColor(style, v.index) ?? style.tokens.ink;
      forHighlighted(v, hl, tL, tR, (a, b) => {
        if (a < t) {
          traceWeighted(g, view, v, a, Math.min(t, b), HIGHLIGHT_WIDTH, 1, maxStep, tolerance, sf);
        }
        if (b > t && !hg) {
          traceWeighted(
            g,
            view,
            v,
            Math.max(t, a),
            b,
            HIGHLIGHT_WIDTH,
            hlA,
            maxStep,
            tolerance,
            sf,
          );
        }
      });
    }
    if (hg) {
      drawGhost(g, hg, voices, style, view, dpr, gradient, ghGradient, hlA, (ctx, v, al, lo, hi) =>
        forHighlighted(v, hl, tL, tR, (a, b) => {
          const a1 = Math.max(t, a, lo);
          const b1 = Math.min(b, hi);
          if (b1 > a1)
            traceWeighted(ctx, view, v, a1, b1, HIGHLIGHT_WIDTH, al, maxStep, tolerance, sf);
        }),
      );
    }
  }
  // Dotted traces of silent lines (editor): the selection's and the hovered voice's.
  const hv = style.traceVoice;
  if (style.traces && (hl || hv !== undefined)) {
    for (const v of compiled.voices) {
      if (v.segments.length === 0 || !breaksIn(v, drawnLives(sf, v))) continue;
      g.strokeStyle = gradient ?? lineColor(style, v.index) ?? style.tokens.ink;
      if (v.index === hv) {
        traceSilent(g, view, v, tL, tR, TRACE_ALPHA, maxStep, tolerance, sf);
        continue;
      }
      if (!hl) continue;
      const from = selectedLevelFrom(v, compiled.momentSpans, hl);
      if (from === from)
        traceSilent(g, view, v, Math.max(from, tL), tR, TRACE_ALPHA, maxStep, tolerance, sf);
      forHighlighted(v, hl, tL, tR, (a, b) => {
        if (!(from <= a)) traceSilent(g, view, v, a, b, TRACE_ALPHA, maxStep, tolerance, sf);
      });
    }
  }
  g.globalAlpha = 1;
}

/** Opacity of the preview's dashed lines. */
export const PREVIEW_ALPHA = 0.9;
/** Dash pattern of the preview's lines, px. */
const PREVIEW_DASH = [5, 4];

/** The preview score's lines from `from` to the right edge: dashed, in each voice's colour. */
function drawPreview(
  g: CanvasRenderingContext2D,
  score: CompiledScore,
  from: Seconds,
  style: ScoreStyle,
  view: View,
): void {
  const a = Math.max(from, view.tL);
  if (!(a < view.tR)) return;
  const pxPerSemitone = (view.height - view.padT - view.padB) / (view.pHi - view.pLo);
  const maxStep = GLIDE_STEP_PX / view.pps;
  const tolerance = 0.35 / pxPerSemitone;
  const gradient = pitchGradient(g, style, view);
  g.save();
  g.setLineDash(PREVIEW_DASH);
  g.lineWidth = 2;
  g.globalAlpha = PREVIEW_ALPHA;
  for (const v of score.voices) {
    if (v.segments.length === 0) continue;
    g.strokeStyle = gradient ?? lineColor(style, v.index) ?? style.tokens.ink;
    trace(g, view, sample(v, a, view.tR, maxStep, tolerance));
  }
  g.restore();
}

/** Calls `fn(a, b)` for each run of contiguous segments in `ids`, clipped to [tL, tR]. */
function forHighlighted(
  v: CompiledVoice,
  ids: ReadonlySet<MomentId>,
  tL: Seconds,
  tR: Seconds,
  fn: (a: Seconds, b: Seconds) => void,
): void {
  const segs = v.segments;
  let a = NaN;
  let b = NaN;
  for (let i = Math.max(0, segmentIndexAt(v, tL)); i < segs.length; i++) {
    const s = segs[i];
    if (s.t0 >= tR) break;
    if (s.t1 <= tL || s.momentId === undefined || !ids.has(s.momentId)) continue;
    if (a === a && s.t0 === b) {
      b = s.t1;
      continue;
    }
    if (a === a) fn(Math.max(a, tL), Math.min(b, tR));
    a = s.t0;
    b = s.t1;
  }
  if (a === a) fn(Math.max(a, tL), Math.min(b, tR));
}

/**
 * Strokes sampled points as one path; a NaN pitch lifts the pen (gap between lives). With `sf` and
 * `v`, the points follow v's strand offsets (at the base line width).
 */
function trace(
  g: CanvasRenderingContext2D,
  view: View,
  pts: [number, number][],
  sf?: StrandFrame,
  v?: CompiledVoice,
): void {
  if (pts.length === 0) return;
  const shift = sf !== undefined && v !== undefined && hasStrands(sf, v);
  g.beginPath();
  let pen = false;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i][1];
    if (p !== p) {
      pen = false;
      continue;
    }
    const x = timeToX(view, pts[i][0]);
    let y = pitchToY(view, p);
    if (shift) y += geometryAt(sf, v, pts[i][0]).off * LINE_WIDTH;
    if (pen) g.lineTo(x, y);
    else g.moveTo(x, y);
    pen = true;
  }
  g.stroke();
}

function drawHeads(
  g: CanvasRenderingContext2D,
  compiled: CompiledScore,
  style: ScoreStyle,
  view: View,
  headA: number,
  MONO: string,
  sf: StrandFrame,
): void {
  const { t, xHead: x } = view;
  const stops = style.colors === 'pitch' ? pitchStops(style.dark, style.oklch) : null;
  const groups = new Map<number, { p: number; y: number }>();
  for (const i of activeAt(compiled, t)) {
    const v = compiled.voices[i];
    const p = pitchAt(v, t);
    if (p === null) continue;
    const lives = drawnLives(sf, v);
    const op = breaksIn(v, lives) ? opacityIn(v, lives, t) : 1;
    if (op < OPACITY_EPS) continue;
    let y = pitchToY(view, p);
    if (hasStrands(sf, v)) y += geometryAt(sf, v, t).off * LINE_WIDTH;
    const mv = motionAt(v, t);
    let color = lineColor(style, i);
    if (color === null && stops) {
      const f = Math.min(1, Math.max(0, (p - view.pLo) / (view.pHi - view.pLo)));
      color = stops[Math.round(f * (stops.length - 1))].color;
    }
    color ??= style.tokens.ink;
    if (mv > 0.03) {
      g.globalAlpha = headA * mv * op;
      g.strokeStyle = style.colors === 'ink' ? style.tokens.accent : color;
      g.lineWidth = 1.2;
      g.beginPath();
      g.arc(x, y, RING_R, 0, Math.PI * 2);
      g.stroke();
    }
    g.globalAlpha = headA * op;
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, DOT_R, 0, Math.PI * 2);
    g.fill();
    const key = Math.round(p * 20);
    if (!groups.has(key)) groups.set(key, { p, y });
  }
  g.font = `10px ${MONO}`;
  g.fillStyle = style.tokens.ink2;
  g.globalAlpha = headA;
  g.textAlign = 'left';
  let lastY = -99;
  for (const gr of [...groups.values()].sort((a, b) => a.y - b.y)) {
    if (gr.y - lastY < 11) continue;
    const hz = hzOf(gr.p, compiled.referenceHz).toFixed(2);
    g.fillText(`${hz} Hz`, x + 11, gr.y + 3.5);
    lastY = gr.y;
  }
  g.globalAlpha = 1;
}

/** Width of the last chord label drawn, re-measured only when the label or font changes. */
let measured = { label: '', font: '', width: 0 };
function chordWidth(g: CanvasRenderingContext2D, label: string, font: string): number {
  if (label !== measured.label || font !== measured.font) {
    measured = { label, font, width: g.measureText(label).width };
  }
  return measured.width;
}

function drawHud(
  g: CanvasRenderingContext2D,
  compiled: CompiledScore,
  style: ScoreStyle,
  view: View,
  MONO: string,
  padL: number,
  padR: number,
): void {
  const C = style.tokens;
  const { t, width: W, height: H, padB } = view;
  const hy = H - padB + 22;
  const active = activeAt(compiled, t);
  const pool = compiled.voices.length;
  g.globalAlpha = 1;

  // The chord (top right): label precomputed at compile time, width measured once per label.
  const chord = chordAt(compiled, t);
  let chordW = 0;
  if (chord) {
    g.font = `500 12px ${MONO}`;
    chordW = chordWidth(g, chord.label, MONO);
  }

  g.font = `10.5px ${MONO}`;
  g.fillStyle = C.ink2;
  g.textAlign = 'left';
  const formula = `f(n) = ${Math.round(compiled.referenceHz * 100) / 100}·2^((n−69)/12)`;
  // On narrow screens a long chord takes the formula's place.
  if (!chord || padL + formula.length * 6.4 + 16 + chordW < W - padR) {
    g.fillText(formula, padL, hy);
  }
  g.fillText(`notes   ${String(active.length).padStart(2, ' ')} / ${pool}`, padL, hy + 14);
  g.fillText(`t       ${formatTime(t)} / ${formatTime(view.duration)}`, padL, hy + 28);

  g.textAlign = 'right';
  if (chord) {
    g.fillStyle = C.ink;
    g.font = `500 12px ${MONO}`;
    g.fillText(chord.label, W - padR, hy);
  }
  g.fillStyle = C.ink2;
  g.font = `10.5px ${MONO}`;
  const mode = view.window >= view.duration ? 'whole piece' : 'following';
  g.fillText(`${keyName(keyAt(compiled, t)).toLowerCase()} · ${mode}`, W - padR, hy + 14);
  let lo = Infinity;
  let hi = -Infinity;
  for (const i of active) {
    const p = pitchAt(compiled.voices[i], t);
    if (p === null) continue;
    if (p < lo) lo = p;
    if (p > hi) hi = p;
  }
  if (hi >= lo) {
    const f = (p: number): string => hzOf(p, compiled.referenceHz).toFixed(1);
    g.fillText(`${f(lo)}–${f(hi)} Hz`, W - padR, hy + 28);
  }
  g.textAlign = 'left';
}
