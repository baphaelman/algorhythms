/**
 * `drawScore`: the pure score painter shared by the player, the editor and export (PLAN.md §10).
 * No globals, no React: everything arrives as arguments. Layers, back to front:
 *
 *   1. background          2. octave grid (A lines labelled in Hz)   3. moment/section markers
 *   4. lines (past solid, future ghost)   5. heads (dots, motion rings, Hz labels ×N)
 *   6. playhead            7. HUD (chord, key, voices, time)
 *
 * The editor overlay (§11) is drawn by the app on top of this.
 */

import { activeAt, chordAt, keyAt, motionAt, pitchAt, sample, segmentIndexAt } from '../core/query';
import { hzOf } from '../core/tuning';
import type {
  CompiledScore,
  CompiledVoice,
  Key,
  MomentId,
  MomentSpan,
  Seconds,
} from '../core/types';
import { cameraAt, cameraScore, pitchToY, timeToX } from './camera';
import { lineColor, pitchStops } from './palettes';
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
/** Line width of highlighted segments, px (normal lines are 1.5). */
export const HIGHLIGHT_WIDTH = 2.75;
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
      6,
      y - 4,
    );
    g.globalAlpha = 1;
  }

  // 3. moment and section markers
  drawMarkers(g, compiled, style, view, MONO);

  // 4. lines
  drawLines(g, compiled, style, view);

  // 5. heads
  const headA = style.heads === false ? 0 : 1;
  const xH = view.xHead;
  if (headA > 0.02 && xH > -RING_R && xH < W + RING_R) {
    drawHeads(g, compiled, style, view, headA, MONO);
  }

  // 6. playhead
  g.strokeStyle = C.rule;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(Math.round(xH) + 0.5, padT - 6);
  g.lineTo(Math.round(xH) + 0.5, H - padB + 6);
  g.stroke();

  // 7. HUD
  if (style.hud) drawHud(g, compiled, style, view, MONO, padL, padR);
  return view;
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

function drawLines(
  g: CanvasRenderingContext2D,
  compiled: CompiledScore,
  style: ScoreStyle,
  view: View,
): void {
  const { t, tL, tR, pps } = view;
  const pxPerSemitone = (view.height - view.padT - view.padB) / (view.pHi - view.pLo);
  const maxStep = GLIDE_STEP_PX / pps;
  const tolerance = 0.35 / pxPerSemitone; // under a third of a pixel of chord error
  const ghost = style.futureOpacity > 0.01;
  g.lineWidth = 1.5;
  g.lineJoin = 'round';
  g.lineCap = 'round';

  let gradient: CanvasGradient | null = null;
  if (style.colors === 'pitch') {
    gradient = g.createLinearGradient(0, pitchToY(view, view.pLo), 0, pitchToY(view, view.pHi));
    for (const s of pitchStops(style.dark, style.oklch)) gradient.addColorStop(s.at, s.color);
  }

  const past = t > tL;
  const future = ghost && t < tR;
  const hl = style.highlight && style.highlight.size > 0 ? style.highlight : null;
  const dim = hl ? DIM_ALPHA : 1;
  for (const v of compiled.voices) {
    if (v.segments.length === 0) continue;
    g.strokeStyle = gradient ?? lineColor(style, v.index) ?? style.tokens.ink;
    if (past) {
      g.globalAlpha = dim;
      trace(g, view, sample(v, tL, Math.min(t, tR), maxStep, tolerance));
    }
    if (future) {
      g.globalAlpha = style.futureOpacity * dim;
      trace(g, view, sample(v, Math.max(t, tL), tR, maxStep, tolerance));
    }
  }
  if (hl) {
    // Selected segments on top, thicker; the future part stays visible even with no ghost.
    g.lineWidth = HIGHLIGHT_WIDTH;
    const futureA = Math.max(style.futureOpacity, 0.6);
    for (const v of compiled.voices) {
      if (v.segments.length === 0) continue;
      g.strokeStyle = gradient ?? lineColor(style, v.index) ?? style.tokens.ink;
      forHighlighted(v, hl, tL, tR, (a, b) => {
        if (a < t) {
          g.globalAlpha = 1;
          trace(g, view, sample(v, a, Math.min(t, b), maxStep, tolerance));
        }
        if (b > t) {
          g.globalAlpha = futureA;
          trace(g, view, sample(v, Math.max(t, a), b, maxStep, tolerance));
        }
      });
    }
  }
  g.globalAlpha = 1;
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

/** Strokes sampled points as one path; a NaN pitch lifts the pen (gap between lives). */
function trace(g: CanvasRenderingContext2D, view: View, pts: [number, number][]): void {
  if (pts.length === 0) return;
  g.beginPath();
  let pen = false;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i][1];
    if (p !== p) {
      pen = false;
      continue;
    }
    const x = timeToX(view, pts[i][0]);
    const y = pitchToY(view, p);
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
): void {
  const { t, xHead: x } = view;
  const stops = style.colors === 'pitch' ? pitchStops(style.dark, style.oklch) : null;
  const groups = new Map<number, { p: number; y: number; count: number }>();
  for (const i of activeAt(compiled, t)) {
    const v = compiled.voices[i];
    const p = pitchAt(v, t);
    if (p === null) continue;
    const y = pitchToY(view, p);
    const mv = motionAt(v, t);
    let color = lineColor(style, i);
    if (color === null && stops) {
      const f = Math.min(1, Math.max(0, (p - view.pLo) / (view.pHi - view.pLo)));
      color = stops[Math.round(f * (stops.length - 1))].color;
    }
    color ??= style.tokens.ink;
    if (mv > 0.03) {
      g.globalAlpha = headA * mv;
      g.strokeStyle = style.colors === 'ink' ? style.tokens.accent : color;
      g.lineWidth = 1.2;
      g.beginPath();
      g.arc(x, y, RING_R, 0, Math.PI * 2);
      g.stroke();
    }
    g.globalAlpha = headA;
    g.fillStyle = color;
    g.beginPath();
    g.arc(x, y, DOT_R, 0, Math.PI * 2);
    g.fill();
    const key = Math.round(p * 20);
    const gr = groups.get(key);
    if (gr) gr.count++;
    else groups.set(key, { p, y, count: 1 });
  }
  g.font = `10px ${MONO}`;
  g.fillStyle = style.tokens.ink2;
  g.globalAlpha = headA;
  g.textAlign = 'left';
  let lastY = -99;
  for (const gr of [...groups.values()].sort((a, b) => a.y - b.y)) {
    if (gr.y - lastY < 11) continue;
    const hz = hzOf(gr.p, compiled.referenceHz).toFixed(2);
    g.fillText(`${hz} Hz${gr.count > 1 ? ' ×' + gr.count : ''}`, x + 11, gr.y + 3.5);
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
  g.fillText(`voices  ${String(active.length).padStart(2, ' ')} / ${pool}`, padL, hy + 14);
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
