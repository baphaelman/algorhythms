/**
 * Tune rests and re-strikes in sound (PLAN rev 10, §6.2 `tune`). A rest fades its line out over
 * REST_FADE and the next note comes in over REST_ATTACK, striking: both edges must look like
 * ordinary signal to the click detector (≤ 2× a steady stretch of the same render). The line is
 * silent inside the rest. A repeated note re-strikes a plucked timbre (a pulse hit at 1).
 * Measured on offline renders, never by ear.
 */

import { describe, expect, it, vi } from 'vitest';
import { DRY_MIX } from '../../src/audio/fixtures/scores';
import { renderOffline } from '../../src/audio/offline';
import { compile } from '../../src/core/compiler/compile';
import { REST_FADE } from '../../src/core/compiler/rests';
import type { CompiledScore, Piece, TuneNote } from '../../src/core/types';
import { BLOCK_FRAMES, LIMITER_LOOKAHEAD } from '../../src/dsp/constants';
import { piece, type MomentInput } from '../unit/core/compiler-fixtures';
import { clickScore, RATE } from './helpers';

vi.setConfig({ testTimeout: 60_000 });

const LAG = Math.round(LIMITER_LOOKAHEAD * RATE);
const SECONDS = 7;

const NOTES: TuneNote[] = [
  { pitch: 69, len: 0.6 },
  { rest: true, len: 0.5 },
  { pitch: 72, len: 0.6 },
  { rest: true, len: 0.25 },
  { pitch: 67, len: 0.5 },
  { pitch: 67, len: 0.5 },
  { pitch: 71, len: 1 },
  { rest: true, len: 1 },
];

function tunePiece(timbre: string, fields: Record<string, unknown> = {}): Piece {
  const p = piece({
    pool: 3,
    start: [57],
    glide: { length: 1, stagger: 0, jitter: 0, ease: 'smootherstep' },
    moments: [{ type: 'tune', at: 1, notes: NOTES, ...fields } as MomentInput],
    end: { at: SECONDS, fade: 0.5 },
  });
  for (const v of p.voices) v.timbre = timbre;
  return p;
}

function mono(score: CompiledScore): Float32Array {
  const frames = Math.ceil(((SECONDS + 0.5) * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;
  const out = renderOffline({ score, mix: DRY_MIX, sampleRate: RATE }, frames);
  const x = new Float32Array(frames);
  for (let i = 0; i < frames; i++) x[i] = out.left[i] + out.right[i];
  return x;
}

const frame = (t: number): number => Math.floor(t * RATE) + LAG;

function peak(x: Float32Array, a: number, b: number): number {
  let m = 0;
  for (let t = frame(a); t < frame(b); t++) m = Math.max(m, Math.abs(x[t]));
  return m;
}

describe.each(['sine', 'glass', 'pluck'])('tune rests stay click-free, %s', (timbre) => {
  const score = compile(tunePiece(timbre));
  const x = mono(score);
  const v = score.voices[0];
  const rests = v.lives.filter((l) => l.fadeOut === REST_FADE).map((l) => l.died! - REST_FADE);
  const comebacks = v.lives.slice(1).map((l) => l.born);
  const edges = [...rests, ...comebacks];
  const changes = [
    ...edges,
    ...v.segments.filter((s) => s.p0 !== s.p1).flatMap((s) => [s.t0, s.t1]),
    ...(v.pulse ?? []).map((r) => r.t),
  ];
  const score1 = (a: number, b: number) => clickScore(x, frame(a), frame(b)).ratio;
  let steady = 0;
  for (let t = 1.05; t < 5.5; t += 0.02) {
    if (changes.some((c) => c > t - 0.1 && c < t + 0.12)) continue;
    if (peak(x, t, t + 0.02) < 1e-3) continue;
    steady = Math.max(steady, score1(t, t + 0.02));
  }

  it('the rests are where the tune puts them', () => {
    expect(rests.map((t) => +t.toFixed(9))).toEqual([1.6, 2.7, 4.95]);
    expect(comebacks.map((t) => +t.toFixed(9))).toEqual([2.1, 2.95]);
  });

  it('every rest edge stays within 2× the steady signal', () => {
    let worst = 0;
    for (const t of edges) worst = Math.max(worst, score1(t - 0.02, t + 0.06));
    console.info(`${timbre} rest edges: steady ${steady.toFixed(3)}, worst ${worst.toFixed(3)}`);
    expect(steady).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(2 * steady);
  });

  it('is silent inside each rest (after the fade, before the next note)', () => {
    const tail = 0.05; // reverb-free dry mix; the limiter's lookahead is removed by `frame`
    expect(peak(x, 1.6 + REST_FADE + tail, 2.1)).toBeLessThan(1e-4);
    expect(peak(x, 4.95 + REST_FADE + tail, SECONDS)).toBeLessThan(1e-4);
  });
});

describe('tune re-strikes in sound', () => {
  it('a repeated note strikes a pluck again; strike: false does not', () => {
    const on = mono(compile(tunePiece('pluck')));
    const off = mono(compile(tunePiece('pluck', { strike: false })));
    // The repeat at 3.45: the peak just after it against the ringing note before it.
    const rise = (x: Float32Array) => peak(x, 3.45, 3.6) / peak(x, 3.3, 3.45);
    console.info(`pluck repeat: strike ${rise(on).toFixed(2)}, held ${rise(off).toFixed(2)}`);
    expect(rise(on)).toBeGreaterThan(1.5);
    expect(rise(off)).toBeLessThan(1.05);
  });
});
