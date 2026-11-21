/**
 * Line artifacts a listener sees on the score (M4.5-17; PLAN.md §15 M4.5 "changing a chord's
 * Notes: n never makes lines cross or start or stop in mid-air"):
 * - `cross`: two sounding voices pass through each other (their order flips without resting
 *   together for at least REST seconds);
 * - `birth`: a voice is born off every other sounding voice's pitch (it appears from nowhere);
 * - `death`: a dying voice's glide ends off every other sounding voice's pitch (it stops in
 *   mid-air), or the voice it merged into leaves while it is still fading.
 */
import { pitchAt } from '../../../src/core/query';
import type { CompiledScore, CompiledVoice } from '../../../src/core/types';

export interface Artifact {
  kind: 'cross' | 'birth' | 'death';
  voice: string;
  other?: string;
  t: number;
  detail: string;
}

const EPS = 1e-6;
/** Pitches closer than this (semitones) touch: no visible order (below the 64-sample check). */
const TOUCH = 0.1;
/** A touch at least this long is a rest together (unison), after which order may change. */
const REST = 0.05;

/** Sounding pitch of every other voice at t. */
function others(score: CompiledScore, v: CompiledVoice, t: number): number[] {
  const out: number[] = [];
  for (const u of score.voices) {
    if (u === v) continue;
    const p = pitchAt(u, t);
    if (p !== null) out.push(p);
  }
  return out;
}

const near = (ps: number[], p: number): boolean => ps.some((q) => Math.abs(q - p) < EPS);

export function lineArtifacts(
  score: CompiledScore,
  opts: {
    /** Only report artifacts at or after this time. */
    from?: number;
    to?: number;
    /** Sampling step for the crossing scan (s). */
    dt?: number;
    /** Voices whose crossings are exempt (pins, free chords): skip the crossing scan. */
    noCross?: boolean;
  } = {},
): Artifact[] {
  const from = opts.from ?? 0;
  const to = opts.to ?? score.duration;
  const dt = opts.dt ?? 0.005;
  const out: Artifact[] = [];
  const end = score.duration;

  for (const v of score.voices) {
    for (const life of v.lives) {
      // Births (not the voices sounding from t = 0).
      if (life.born > 0 && life.born >= from && life.born <= to) {
        const seg = v.segments.find((g) => g.t0 === life.born);
        const p0 = seg ? seg.p0 : NaN;
        if (!near(others(score, v, life.born), p0)) {
          out.push({ kind: 'birth', voice: v.id, t: life.born, detail: `born on ${p0}` });
        }
      }
      // Deaths (not the closing fade of the piece).
      if (life.died === undefined || life.died >= end - 1e-9) continue;
      const tg = life.died - (life.fadeOut ?? 0);
      if (tg < from || tg > to) continue;
      const p = pitchAt(v, tg);
      if (p === null) continue;
      const ps = others(score, v, tg);
      if (ps.length === 0) continue; // nothing left to merge into
      if (!near(ps, p)) {
        out.push({ kind: 'death', voice: v.id, t: tg, detail: `glide ends on ${p} off [${ps}]` });
        continue;
      }
      // While it fades, something keeps sounding its pitch.
      for (let t = tg; t < life.died; t += 0.02) {
        const q = pitchAt(v, t);
        if (q === null) break;
        const qs = others(score, v, t);
        if (qs.length > 0 && !qs.some((x) => Math.abs(x - q) < 0.01)) {
          out.push({ kind: 'death', voice: v.id, t, detail: `stranded on ${q} while fading` });
          break;
        }
      }
    }
  }

  if (opts.noCross) return out;
  const vs = score.voices.filter((v) => v.lives.length > 0);
  const n = vs.length;
  const sign = new Int8Array(n * n);
  const touch = new Float64Array(n * n);
  const reported = new Set<number>();
  const p = new Float64Array(n);
  for (let t = from; t <= to; t += dt) {
    for (let i = 0; i < n; i++) p[i] = pitchAt(vs[i], t) ?? NaN;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const k = i * n + j;
        const a = p[i];
        const b = p[j];
        if (a !== a || b !== b) {
          sign[k] = 0;
          touch[k] = 0;
          continue;
        }
        const d = a - b;
        if (Math.abs(d) <= TOUCH) {
          touch[k] += dt;
          continue;
        }
        const s = d > 0 ? 1 : -1;
        if (sign[k] !== 0 && s !== sign[k] && touch[k] < REST && !reported.has(k)) {
          reported.add(k);
          out.push({
            kind: 'cross',
            voice: vs[i].id,
            other: vs[j].id,
            t,
            detail: `${a.toFixed(2)} vs ${b.toFixed(2)}`,
          });
        }
        sign[k] = s;
        touch[k] = 0;
      }
    }
  }
  return out;
}
