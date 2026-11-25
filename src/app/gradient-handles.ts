/**
 * The background gradient's handles on the poster's artboard (PLAN.md §15 M14 "Backgrounds"):
 * where they sit and what a drag of one writes to the Colours form. Pure; poster px.
 *
 * - **Linear:** the gradient line runs through the centre (`gradientLine`). Its two ends are the
 *   first and last stops; the other stops sit between. Dragging an end turns the line about the
 *   centre (the angle) and moves that end's stop along it (the length), the stops between keeping
 *   their places relative to the ends. Dragging a stop moves it along the line.
 * - **Radial:** a centre handle and a radius handle (right of the centre).
 *
 * A handle outside the poster is shown on its edge (`shown`); a drag adds the pointer's travel
 * to the handle's true place (`x`, `y`), so it never jumps.
 */

import { gradientLine, type GradientStop } from '../render/background';
import type { ThemeTokens } from '../render/types';
import {
  RADIUS_MAX,
  RADIUS_MIN,
  gradientAngle,
  gradientShape,
  gradientStops,
  withAngle,
  type ColoursForm,
} from './export-colours';

export type GradientHandleKind = 'start' | 'end' | 'stop' | 'centre' | 'radius';

export interface GradientHandle {
  kind: GradientHandleKind;
  /** start / end / stop: the stop's index in the form's stops. */
  stop?: number;
  /** Where it really is. */
  x: number;
  y: number;
  /** Where it is drawn: on the poster's edge when it is outside. */
  shown: { x: number; y: number };
}

export interface GradientHandles {
  shape: 'linear' | 'radial';
  handles: GradientHandle[];
  /** Linear: the line between the ends; radial: the circle. */
  line?: { x0: number; y0: number; x1: number; y1: number };
  circle?: { cx: number; cy: number; r: number };
}

/** The closest the two ends' stops come to each other. */
const MIN_GAP = 0.01;

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The line at `angle` through the centre (an axis-aligned one too, unlike `gradientLine`). */
export function centredLine(angle: number, W: number, H: number) {
  const l = gradientLine(angle, W, H);
  if (l.x0 === l.x1) return { ...l, x0: W / 2, x1: W / 2 };
  if (l.y0 === l.y1) return { ...l, y0: H / 2, y1: H / 2 };
  return l;
}

type Line = ReturnType<typeof centredLine>;

const along = (l: Line, at: number) => ({
  x: l.x0 + at * (l.x1 - l.x0),
  y: l.y0 + at * (l.y1 - l.y0),
});

/** Where (x, y) projects on the line, as a position along it (0 = start, 1 = end). */
function project(l: Line, x: number, y: number): number {
  const dx = l.x1 - l.x0;
  const dy = l.y1 - l.y0;
  const len2 = dx * dx + dy * dy;
  return len2 > 0 ? ((x - l.x0) * dx + (y - l.y0) * dy) / len2 : 0;
}

/** (x, y) pulled towards (cx, cy) until it is inside the W × H frame. */
function inside(cx: number, cy: number, x: number, y: number, W: number, H: number) {
  let s = 1;
  if (x > W) s = Math.min(s, (W - cx) / (x - cx));
  if (x < 0) s = Math.min(s, -cx / (x - cx));
  if (y > H) s = Math.min(s, (H - cy) / (y - cy));
  if (y < 0) s = Math.min(s, -cy / (y - cy));
  s = Math.max(0, s);
  return { x: cx + s * (x - cx), y: cy + s * (y - cy) };
}

/** The first and last stops' indices (by position; the earlier index on a tie). */
function ends(stops: readonly GradientStop[]): { first: number; last: number } {
  let first = 0;
  let last = 0;
  stops.forEach((s, i) => {
    if (s.at < stops[first].at) first = i;
    if (s.at > stops[last].at) last = i;
  });
  if (first === last) last = stops.length > 1 ? (first === 0 ? 1 : 0) : first;
  return { first, last };
}

/** The handles of the form's gradient over a W × H poster (null: no gradient background). */
export function gradientHandles(
  c: ColoursForm,
  t: ThemeTokens,
  W: number,
  H: number,
): GradientHandles | null {
  if (c.background !== 'gradient') return null;
  const handle = (kind: GradientHandleKind, x: number, y: number, cx: number, cy: number) => ({
    kind,
    x,
    y,
    shown: inside(cx, cy, x, y, W, H),
  });
  if (gradientShape(c) === 'radial') {
    const cx = c.bgCx * W;
    const cy = c.bgCy * H;
    const r = (c.bgR * Math.hypot(W, H)) / 2;
    return {
      shape: 'radial',
      handles: [handle('centre', cx, cy, cx, cy), handle('radius', cx + r, cy, cx, cy)],
      circle: { cx, cy, r },
    };
  }
  const stops = gradientStops(c, t);
  const l = centredLine(gradientAngle(c), W, H);
  const { first, last } = ends(stops);
  const handles: GradientHandle[] = stops.map((s, i) => {
    const p = along(l, s.at);
    const kind = i === first ? 'start' : i === last ? 'end' : 'stop';
    return { ...handle(kind, p.x, p.y, W / 2, H / 2), stop: i };
  });
  // The ends last, so they sit over a stop at the same place.
  handles.sort((a, b) => Number(a.kind !== 'stop') - Number(b.kind !== 'stop'));
  const a = along(l, stops[first].at);
  const b = along(l, stops[last].at);
  return { shape: 'linear', handles, line: { x0: a.x, y0: a.y, x1: b.x, y1: b.y } };
}

/**
 * What dragging handle `h` of form `c` to (x, y) writes (poster px; the handle's true place plus
 * the pointer's travel), as a Colours patch over `c`.
 */
export function dragGradientHandle(
  c: ColoursForm,
  t: ThemeTokens,
  h: Pick<GradientHandle, 'kind' | 'stop'>,
  x: number,
  y: number,
  W: number,
  H: number,
): Partial<ColoursForm> {
  if (h.kind === 'centre') {
    return { bgCx: round3(clamp(x / W, 0, 1)), bgCy: round3(clamp(y / H, 0, 1)) };
  }
  if (h.kind === 'radius') {
    const d = Math.hypot(x - c.bgCx * W, y - c.bgCy * H);
    return { bgR: round3(clamp(d / (Math.hypot(W, H) / 2), RADIUS_MIN, RADIUS_MAX)) };
  }
  const stops = gradientStops(c, t);
  const i = h.stop ?? -1;
  if (!stops[i]) return {};
  if (h.kind === 'stop') {
    const at = project(centredLine(gradientAngle(c), W, H), x, y);
    stops[i] = { ...stops[i], at: round3(clamp(at, 0, 1)) };
    return { bgStops: stops };
  }
  // An end turns the line about the centre: its direction is from the centre towards an end
  // past the centre (towards the start for one before it). An end at the centre keeps it.
  const cx = x - W / 2;
  const cy = y - H / 2;
  const side = stops[i].at - 0.5;
  let turn: Partial<ColoursForm> = {};
  if (Math.abs(side) > 1e-6 && Math.hypot(cx, cy) > 1e-6) {
    const s = side > 0 ? 1 : -1;
    turn = withAngle((Math.atan2(s * cx, -s * cy) * 180) / Math.PI);
  }
  const at = project(centredLine(turn.bgAngle ?? gradientAngle(c), W, H), x, y);
  const { first, last } = ends(stops);
  const a0 = stops[first].at;
  const b0 = stops[last].at;
  const [a1, b1] =
    h.kind === 'end' ? [a0, clamp(at, a0 + MIN_GAP, 1)] : [clamp(at, 0, b0 - MIN_GAP), b0];
  const span = b0 - a0;
  const next = stops.map((s, k) => {
    if (k === first) return { ...s, at: round3(a1) };
    if (k === last) return { ...s, at: round3(b1) };
    const f = span > 0 ? (s.at - a0) / span : 0.5;
    return { ...s, at: round3(clamp(a1 + f * (b1 - a1), 0, 1)) };
  });
  return { ...turn, bgStops: next };
}
