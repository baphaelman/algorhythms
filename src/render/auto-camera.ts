/**
 * The Auto camera (PLAN.md §15 M11.5): camera keys made from a compiled piece, for
 * `cameraPathAt`. Pure and deterministic; memoised per compiled score.
 *
 * Method:
 * 1. The lines drawn (opacity ≥ VISIBLE) are sampled every DT s.
 * 2. A target pose every GRID s: the pitch range covers what the frame shows (its whole time
 *    span), padded, its edges smoothed to move at most EDGE_SPEED ranges per s (so the frame opens
 *    before lines arrive, zooms slowly and never jitters); the window grows with that range (√),
 *    from TIGHT × the widest window to the widest, opening at most OPEN_RATE.
 * 3. Fixed keys: the opening (the target at the first note, the window tight; the start may be
 *    < 0, so the first notes appear at the playhead's place), two leaning in at each convergence (≥ 3 lines
 *    within a semitone that were ≥ CONVERGE_FROM apart shortly before), and the pull-back (the
 *    last key is the end card's whole view).
 * 4. Between fixed keys, the fewest grid keys whose eased path keeps every peak rate under the
 *    bounds below, the playhead's notes inside the frame, and stays near the target (dynamic
 *    programming over the grid).
 *
 * A key's window is seconds shown at 16:9 (camera-path.ts); `aspect` only sizes the last key, so
 * the pull-back ends on the whole piece in any frame.
 */

import { evalSegment } from '../core/segment';
import type { CameraKey, CompiledScore, Piece, Seconds } from '../core/types';
import { pitchExtent, pitchExtentIn } from './camera';
import { KEY_ASPECT } from './camera-path';
import { opacityAt } from './level';
import type { TimeSpan } from './section';

/** The widest window the Auto camera opens to (s at 16:9), as the gallery's cameras. */
export const AUTO_WINDOW: Seconds = 14;
/** Peak zoom rate between keys: |d ln window / dt| and |d ln range / dt|, per second. */
export const MAX_ZOOM_RATE = 0.3;
/** ...during the pull-back. */
export const MAX_PULL_RATE = 0.6;
/** Peak pan rate of the pitch centre, in frame heights (ranges) per second. */
export const MAX_PAN_RATE = 0.25;
/** Peak rate of the playhead's place across the frame, per second. */
export const MAX_PLACE_RATE = 0.1;
/** The thinnest pitch range (semitones), as a single note framed by the gallery's Crease. */
export const MIN_RANGE = 14;
/** The playhead's place, and while leaning in. */
export const AUTO_PLACE = 0.6;
export const LEAN_PLACE = 0.5;

/** Analysis step, target grid (where moves are checked), key grid, s. */
const DT = 0.1;
const GRID = 0.5;
const KEY_GRID = 1;
/** Opacity a line counts as drawn from. */
const VISIBLE = 0.1;
/** The opening window, as a share of the widest, and how fast it may open (ln per s: × 2 in 15 s). */
const TIGHT = 0.5;
const OPEN_RATE = Math.LN2 / 15;
/** The target window's ln changes at most this fast, per s. */
const WINDOW_SPEED = 0.1;
/** The target's edges move at most this fast: a share of its range per s. */
const EDGE_SPEED = 0.08;
/** Smootherstep's peak slope (30/16): a key-to-key move peaks at this × its average rate. */
const PEAK = 1.875;
/** Longest gap between keys, s. */
const MAX_GAP = 40;
/** Coverage margin inside the frame's edges, semitones. */
const MARGIN = 0.5;
/** How far the path may stray from the target: ln window, ln range, centre (ranges). */
const DEV_W = 0.22;
const DEV_R = 0.22;
const DEV_C = 0.12;
/**
 * Convergence: ≥ MEET_LINES lines, and at least half of those drawn, within MEET st, that were
 * ≥ CONVERGE_FROM st apart in the 3 s before; the strongest one within CONVERGE_GAP s.
 */
const MEET = 1;
const CONVERGE_FROM = 7;
const MEET_LINES = 3;
const CONVERGE_GAP: Seconds = 8;
/**
 * Leaning in: the window's and the range's share of the general frame, the window's floor; held
 * from LEAN_BEFORE before to LEAN_AFTER after.
 */
const LEAN_SHARE = 0.6;
const LEAN_RANGE = 0.6;
const LEAN_MIN: Seconds = 6;
const LEAN_BEFORE: Seconds = 1.5;
const LEAN_AFTER: Seconds = 1;

export interface AutoCameraOptions {
  /** The widest window, s at 16:9. @default AUTO_WINDOW */
  window?: Seconds;
  /** The span framed (a video's section); default the whole piece. */
  span?: TimeSpan;
  /** The frame's width / height: the last key shows the whole span there. @default 16/9 */
  aspect?: number;
}

/** What `autoCameraPlan` decided, for tests and the build log. */
export interface AutoCameraPlan {
  keys: CameraKey[];
  /** Convergence times leaned in at. */
  crossings: Seconds[];
  /** Where the camera leans in (notes may leave the frame there), and the pull-back. */
  leans: TimeSpan[];
  pullBack: TimeSpan;
}

interface Pose {
  t: Seconds;
  window: Seconds;
  place: number;
  pitch: number;
  range: number;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const smoother = (u: number) => u * u * u * (u * (u * 6 - 15) + 10);
const pad = (spread: number) => 1.5 + 0.05 * spread;

/** Drawn pitches every DT s: per cell its lowest and highest (NaN when none), and per voice. */
interface Cells {
  a: Seconds;
  n: number;
  voices: number;
  lo: Float64Array;
  hi: Float64Array;
  /** n × voices pitches, NaN where the voice isn't drawn. */
  p: Float64Array;
}

function sample(compiled: CompiledScore, a: Seconds, b: Seconds): Cells {
  const n = Math.max(1, Math.floor((b - a) / DT + 1e-9) + 1);
  const V = compiled.voices.length;
  const p = new Float64Array(n * V).fill(NaN);
  const lo = new Float64Array(n).fill(NaN);
  const hi = new Float64Array(n).fill(NaN);
  for (let v = 0; v < V; v++) {
    const voice = compiled.voices[v];
    const segs = voice.segments;
    let k = 0;
    for (let i = 0; i < n && k < segs.length; i++) {
      const t = a + i * DT;
      while (k < segs.length && segs[k].t1 < t) k++;
      if (k >= segs.length) break;
      const s = segs[k];
      if (t < s.t0) continue;
      if (opacityAt(voice, t) < VISIBLE) continue;
      const x = evalSegment(s, t);
      p[i * V + v] = x;
      if (!(lo[i] <= x)) lo[i] = x;
      if (!(hi[i] >= x)) hi[i] = x;
    }
  }
  return { a, n, voices: V, lo, hi, p };
}

const cellOf = (c: Cells, t: Seconds) => clamp(Math.round((t - c.a) / DT), 0, c.n - 1);

/** [lo, hi] drawn in [t0, t1] (NaN when nothing is). */
function envelope(c: Cells, t0: Seconds, t1: Seconds): [number, number] {
  let lo = NaN;
  let hi = NaN;
  for (let i = cellOf(c, t0), e = cellOf(c, t1); i <= e; i++) {
    const l = c.lo[i];
    if (l !== l) continue;
    if (!(lo <= l)) lo = l;
    if (!(hi >= c.hi[i])) hi = c.hi[i];
  }
  return [lo, hi];
}

/** A padded frame [centre, range] around [lo, hi], at least MIN_RANGE tall. */
function frameOf(lo: number, hi: number): [number, number] {
  const s = hi - lo;
  const range = Math.max(MIN_RANGE, s + 2 * pad(s));
  return [(lo + hi) / 2, range];
}

/** A convergence: when, the meeting pitch, the lines that meet. */
interface Meeting {
  t: Seconds;
  pitch: number;
  lines: number[];
  score: number;
}

/** Convergences in [from, to] (see CONVERGE_FROM), the strongest per CONVERGE_GAP, in order. */
function convergences(c: Cells, from: Seconds, to: Seconds): Meeting[] {
  const V = c.voices;
  const found: Meeting[] = [];
  const idx: number[] = [];
  const back = Math.round(3 / DT);
  const near = Math.round(1 / DT);
  for (let i = cellOf(c, from); i <= cellOf(c, to); i++) {
    const row = i * V;
    idx.length = 0;
    for (let v = 0; v < V; v++) if (c.p[row + v] === c.p[row + v]) idx.push(v);
    if (idx.length < MEET_LINES) continue;
    idx.sort((x, y) => c.p[row + x] - c.p[row + y]);
    // The largest group within MEET st (a sliding window over the sorted pitches).
    let best = 0;
    let bestAt = 0;
    for (let s = 0, e = 0; e < idx.length; e++) {
      while (c.p[row + idx[e]] - c.p[row + idx[s]] > MEET) s++;
      if (e - s + 1 > best) {
        best = e - s + 1;
        bestAt = s;
      }
    }
    if (best < MEET_LINES || 2 * best < idx.length) continue;
    const lines = idx.slice(bestAt, bestAt + best);
    // Were they apart shortly before?
    let apart = 0;
    for (let j = Math.max(0, i - back); j <= i - near; j++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of lines) {
        const x = c.p[j * V + v];
        if (x === x) {
          if (x < lo) lo = x;
          if (x > hi) hi = x;
        }
      }
      if (hi - lo > apart) apart = hi - lo;
    }
    if (apart < CONVERGE_FROM) continue;
    let sum = 0;
    for (const v of lines) sum += c.p[row + v];
    found.push({ t: c.a + i * DT, pitch: sum / lines.length, lines, score: best * apart });
  }
  // The strongest within CONVERGE_GAP of each other (ties: the earliest).
  const order = found.map((_, k) => k).sort((x, y) => found[y].score - found[x].score || x - y);
  const kept: Meeting[] = [];
  for (const k of order) {
    if (kept.every((m) => Math.abs(m.t - found[k].t) >= CONVERGE_GAP)) kept.push(found[k]);
  }
  return kept.sort((x, y) => x.t - y.t);
}

/**
 * Smooths a frame's edges in place (coverage kept: they only widen): each edge moves at most
 * `k` × the frame's range (at least MIN_RANGE) per step, forwards and backwards.
 */
function smoothEdges(lo: Float64Array, hi: Float64Array, k: number): void {
  const step = (i: number, j: number) => {
    const r = hi[j] - lo[j];
    if (!Number.isFinite(r)) return;
    const d = k * Math.max(MIN_RANGE, r);
    if (hi[j] - d > hi[i]) hi[i] = hi[j] - d;
    if (lo[j] + d < lo[i]) lo[i] = lo[j] + d;
  };
  for (let i = 1; i < lo.length; i++) step(i, i - 1);
  for (let i = lo.length - 2; i >= 0; i--) step(i, i + 1);
}

/** In-place Lipschitz upper (sign 1) or lower (−1) envelope with slope `k` per step. */
function lipschitz(x: Float64Array, k: number, sign: 1 | -1): void {
  const n = x.length;
  for (let i = 1; i < n; i++) {
    const y = x[i - 1] - sign * k;
    if (sign > 0 ? y > x[i] : y < x[i]) x[i] = y;
  }
  for (let i = n - 2; i >= 0; i--) {
    const y = x[i + 1] - sign * k;
    if (sign > 0 ? y > x[i] : y < x[i]) x[i] = y;
  }
}

/** Fills non-finite entries from the nearest finite one before (else after); false if none. */
function fillGaps(x: Float64Array): boolean {
  let first = -1;
  for (let i = 0; i < x.length; i++) {
    if (Number.isFinite(x[i])) {
      if (first < 0) first = i;
    } else if (first >= 0) x[i] = x[i - 1];
  }
  if (first < 0) return false;
  for (let i = 0; i < first; i++) x[i] = x[first];
  return true;
}

/** The peak rates of the eased move from a to b are within the bounds (zoom bound `zoom`). */
function ratesOk(a: Pose, b: Pose, zoom: number): boolean {
  const k = PEAK / (b.t - a.t);
  return (
    Math.abs(Math.log(b.window / a.window)) * k <= zoom &&
    Math.abs(Math.log(b.range / a.range)) * k <= zoom &&
    Math.abs(b.pitch - a.pitch) * k <= MAX_PAN_RATE * Math.min(a.range, b.range) &&
    Math.abs(b.place - a.place) * k <= MAX_PLACE_RATE
  );
}

/**
 * The Auto camera's plan for a compiled piece (see the module comment). Keys are sorted, at ≥ 0,
 * windows and ranges > 0, places in 0..1, rounded as the piece stores them.
 */
export function autoCameraPlan(
  compiled: CompiledScore,
  opts: AutoCameraOptions = {},
): AutoCameraPlan {
  const D = Math.max(0, compiled.duration);
  const a = clamp(opts.span?.start ?? 0, 0, D);
  const b = clamp(opts.span?.end ?? D, a, D);
  const wide = opts.window !== undefined && opts.window > 0 ? opts.window : AUTO_WINDOW;
  const factor =
    (opts.aspect !== undefined && opts.aspect > 0 ? opts.aspect : KEY_ASPECT) / KEY_ASPECT;
  const whole = a <= 0 && b >= D - 1e-9;
  const [eLo, eHi] = whole ? pitchExtent(compiled) : pitchExtentIn(compiled, a, b);
  const len = Math.max(b - a, 1e-6);
  // The last key: the end card's camera (videoCamera 'whole'), the playhead at its right edge.
  const last: Pose = {
    t: b,
    window: Math.max(2, len) / factor,
    place: 1,
    pitch: (eLo + eHi) / 2,
    range: eHi - eLo,
  };
  const c = sample(compiled, a, b);
  let firstCell = -1;
  for (let i = 0; i < c.n; i++)
    if (c.lo[i] === c.lo[i]) {
      firstCell = i;
      break;
    }
  const done = (poses: Pose[], crossings: Seconds[], leans: TimeSpan[], pullBack: TimeSpan) => ({
    keys: poses.map(keyOf),
    crossings,
    leans,
    pullBack,
  });
  if (firstCell < 0 || len < 4) return done([{ ...last }], [], [], { start: b, end: b });

  const t0 = a + firstCell * DT;
  const w0 = wide * TIGHT;

  // Target poses on the grid.
  const m = Math.max(1, Math.floor(len / GRID));
  const T = (j: number) => a + j * GRID;
  const W = new Float64Array(m + 1).fill(wide * 0.75);
  const tc = new Float64Array(m + 1);
  const tr = new Float64Array(m + 1);
  const lo = new Float64Array(m + 1);
  const hi = new Float64Array(m + 1);
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 0; j <= m; j++) {
      const [l, h] = envelope(c, T(j) - AUTO_PLACE * W[j], T(j) + (1 - AUTO_PLACE) * W[j]);
      const p = h === h ? pad(h - l) : 0;
      lo[j] = l === l ? l - p : Infinity;
      hi[j] = h === h ? h + p : -Infinity;
    }
    smoothEdges(lo, hi, EDGE_SPEED * GRID);
    fillGaps(hi);
    fillGaps(lo);
    let rMax = MIN_RANGE;
    for (let j = 0; j <= m; j++) {
      tc[j] = (lo[j] + hi[j]) / 2;
      tr[j] = Math.max(MIN_RANGE, hi[j] - lo[j]);
      if (tr[j] > rMax) rMax = tr[j];
    }
    for (let j = 0; j <= m; j++) W[j] = Math.log(wide * clamp(Math.sqrt(tr[j] / rMax), TIGHT, 1));
    lipschitz(W, WINDOW_SPEED * GRID, 1);
    for (let j = 0; j <= m; j++) {
      W[j] = Math.exp(Math.min(W[j], Math.log(w0) + OPEN_RATE * Math.max(0, T(j) - t0)));
    }
  }
  const target = (t: Seconds): Pose => {
    const j = clamp(Math.round((t - a) / GRID), 0, m);
    return { t, window: W[j], place: AUTO_PLACE, pitch: tc[j], range: tr[j] };
  };

  // The opening: the target at the first note, the window tight.
  const open: Pose = { ...target(t0), window: w0 };

  // The pull-back: long enough to stay under MAX_PULL_RATE, at most 30 % of the span.
  const before = target(b - 4);
  const zoom = Math.max(
    Math.abs(Math.log(last.window / before.window)),
    Math.abs(Math.log(last.range / before.range)),
  );
  const pull = clamp((PEAK * zoom) / MAX_PULL_RATE + 0.5, 4, Math.max(4, 0.3 * len));
  const tp = Math.max(t0 + GRID, b - pull);
  const pullFrom = target(tp);

  // Leaning in at convergences (not in the opening's first 3 s or the pull-back's approach).
  /** Two keys per lean, in order. */
  const fixed: Pose[] = [];
  const leans: TimeSpan[] = [];
  const crossings: Seconds[] = [];
  for (const x of convergences(c, t0 + 3, tp - 4)) {
    const g = target(x.t);
    const lw = Math.min(g.window, Math.max(LEAN_MIN, LEAN_SHARE * g.window));
    let l = x.pitch;
    let h = x.pitch;
    for (let i = cellOf(c, x.t - 0.35 * lw); i <= cellOf(c, x.t + 0.35 * lw); i++) {
      for (const v of x.lines) {
        const y = c.p[i * c.voices + v];
        if (y < l) l = y;
        if (y > h) h = y;
      }
    }
    // Centred on the meeting, inside the general frame, covering the meeting lines.
    const lr = Math.min(g.range, Math.max(frameOf(l, h)[1], LEAN_RANGE * g.range));
    const half = (g.range - lr) / 2;
    const lp = clamp(x.pitch, g.pitch - half, g.pitch + half);
    const lean = { window: lw, place: LEAN_PLACE, pitch: lp, range: lr };
    const ta = x.t - LEAN_BEFORE;
    const tb = x.t + LEAN_AFTER;
    const prev = fixed.length ? fixed[fixed.length - 1].t : t0;
    if (ta - prev < 3) continue;
    const move = Math.max(
      Math.abs(Math.log(g.window / lw)),
      Math.abs(Math.log(g.range / lr)),
      (Math.abs(g.pitch - lp) * MAX_ZOOM_RATE) / (MAX_PAN_RATE * lr),
    );
    const reach = (PEAK * move) / MAX_ZOOM_RATE + 1;
    fixed.push({ t: ta, ...lean }, { t: tb, ...lean });
    leans.push({ start: ta - reach, end: tb + reach });
    crossings.push(x.t);
  }

  // Candidates: the opening, grid times, the fixed keys, the pull-back's start.
  const cand: { pose: Pose; fixed: boolean }[] = [{ pose: open, fixed: true }];
  let fi = 0;
  for (let j = 0; j <= m; j += KEY_GRID / GRID) {
    const t = T(j);
    while (fi < fixed.length && fixed[fi].t <= t) cand.push({ pose: fixed[fi++], fixed: true });
    if (t <= t0 + 0.25 || t >= tp - 0.25) continue;
    if (fixed.some((f) => Math.abs(f.t - t) < 0.25)) continue;
    // No grid keys inside a lean (between its two keys).
    if (fi % 2 === 1) continue;
    cand.push({ pose: target(t), fixed: false });
  }
  while (fi < fixed.length) cand.push({ pose: fixed[fi++], fixed: true });
  cand.push({ pose: pullFrom, fixed: true });
  cand.sort((x, y) => x.pose.t - y.pose.t);

  // Per grid time: the playhead's drawn notes (±GRID/2), and whether it is leaned in.
  const covLo = new Float64Array(m + 1);
  const covHi = new Float64Array(m + 1);
  const free = new Uint8Array(m + 1);
  const lnW = new Float64Array(m + 1);
  for (let j = 0; j <= m; j++) {
    const [l, h] = envelope(c, T(j) - GRID / 2, T(j) + GRID / 2);
    covLo[j] = l === l ? l - MARGIN : Infinity;
    covHi[j] = h === h ? h + MARGIN : -Infinity;
    free[j] = leans.some((x) => T(j) > x.start && T(j) < x.end) ? 1 : 0;
    lnW[j] = Math.log(W[j]);
  }
  const RW = Math.exp(DEV_R);
  /**
   * Cost of an eased move from a to b, checked at the grid times between: 1 plus a little for
   * straying from the target; Infinity past a rate bound, a note out of frame or too far astray.
   */
  const moveCost = (pa: Pose, pb: Pose): number => {
    if (!ratesOk(pa, pb, MAX_ZOOM_RATE)) return Infinity;
    const span = pb.t - pa.t;
    const wa = Math.log(pa.window);
    const dW = Math.log(pb.window) - wa;
    let dev = 0;
    let k = 0;
    for (let j = Math.floor((pa.t - a) / GRID + 1e-6) + 1; j <= m && T(j) < pb.t - 1e-6; j++) {
      if (free[j]) continue;
      const e = smoother((T(j) - pa.t) / span);
      const pitch = pa.pitch + (pb.pitch - pa.pitch) * e;
      const range = pa.range + (pb.range - pa.range) * e;
      const half = range / 2;
      if (covLo[j] < pitch - half || covHi[j] > pitch + half) return Infinity;
      const dw = Math.abs(wa + dW * e - lnW[j]) / DEV_W;
      const rr = range / tr[j];
      if (rr > RW || rr * RW < 1) return Infinity;
      const dr = Math.abs(rr - 1) / (RW - 1);
      const dc = Math.abs(pitch - tc[j]) / (DEV_C * tr[j]);
      const d = dw > dr ? (dw > dc ? dw : dc) : dr > dc ? dr : dc;
      if (d > 1) return Infinity;
      dev += d * d;
      k++;
    }
    return 1 + (k ? (0.5 * dev) / k : 0);
  };

  const n = cand.length;
  const cost = new Float64Array(n).fill(Infinity);
  const from = new Int32Array(n).fill(-1);
  cost[0] = 0;
  for (let j = 1; j < n; j++) {
    const pj = cand[j].pose;
    for (let i = j - 1; i >= 0; i--) {
      const pi = cand[i].pose;
      if (pj.t - pi.t > MAX_GAP) break;
      if (pj.t - pi.t < 1e-6) continue;
      if (cost[i] === Infinity) continue;
      const x = cost[i] + moveCost(pi, pj);
      if (x < cost[j]) {
        cost[j] = x;
        from[j] = i;
      }
      if (cand[i].fixed) break;
    }
    if (from[j] < 0) {
      // Nothing fits: the nearest candidate within the rate bounds, else the one before.
      let i = j - 1;
      for (let k = j - 1; k >= 0; k--) {
        if (pj.t - cand[k].pose.t > MAX_GAP) break;
        if (ratesOk(cand[k].pose, pj, MAX_ZOOM_RATE)) {
          i = k;
          break;
        }
        if (cand[k].fixed) break;
      }
      cost[j] = cost[i] + 10;
      from[j] = i;
    }
  }
  const poses: Pose[] = [];
  for (let j = n - 1; j >= 0; j = from[j]) {
    poses.push(cand[j].pose);
    if (j === 0) break;
  }
  poses.reverse();
  poses.push(last);
  return done(poses, crossings, leans, { start: tp, end: b });
}

function keyOf(p: Pose): CameraKey {
  return {
    at: r3(Math.max(0, p.t)),
    window: r3(p.window),
    place: r3(clamp(p.place, 0, 1)),
    pitch: Math.round(p.pitch * 1e6) / 1e6,
    range: Math.round(Math.max(1, p.range) * 1e6) / 1e6,
  };
}

const memo = new WeakMap<CompiledScore, Map<string, readonly CameraKey[]>>();

/** The Auto camera's keys for a compiled piece (see `autoCameraPlan`); memoised per score. */
export function autoCameraKeys(
  compiled: CompiledScore,
  opts: AutoCameraOptions = {},
): readonly CameraKey[] {
  const id = `${opts.window ?? ''}|${opts.span?.start ?? ''}|${opts.span?.end ?? ''}|${opts.aspect ?? ''}`;
  let m = memo.get(compiled);
  if (!m) memo.set(compiled, (m = new Map()));
  let keys = m.get(id);
  if (!keys) m.set(id, (keys = autoCameraPlan(compiled, opts).keys));
  return keys;
}

/**
 * The keys a piece's camera path uses: its stored keys in mode `keys`, the Auto camera's in mode
 * `auto`; null for Follow (no camera, mode `follow`, or `keys` without keys).
 */
export function pieceCameraPath(
  piece: Pick<Piece, 'camera'>,
  compiled: CompiledScore,
  opts?: AutoCameraOptions,
): readonly CameraKey[] | null {
  const cam = piece.camera;
  if (cam?.mode === 'auto') return autoCameraKeys(compiled, opts);
  if (cam?.mode === 'keys' && cam.keys && cam.keys.length > 0) return cam.keys;
  return null;
}
