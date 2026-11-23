/**
 * A fitted melody over I–vi–IV–V, rendered offline (melody line alone, sine, no FX) and analysed:
 * each note's pitch by autocorrelation is in C major, and every strong-beat note is a chord tone.
 */
import { describe, expect, it } from 'vitest';
import { exportFrameCount, renderOffline } from '../../../src/audio/offline';
import { fitTune } from '../../../src/app/editor/melody-fit';
import { tuneNoteStarts } from '../../../src/app/editor/tune';
import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import type { ChordMoment, Piece, TuneMoment } from '../../../src/core/types';

const SR = 48000;
const BEAT = 0.75;
const BAR = 4 * BEAT;
const CHORDS = [
  [0, 4, 7],
  [9, 0, 4],
  [5, 9, 0],
  [7, 11, 2],
];

const chord = (id: string, at: number, symbol: string): ChordMoment => ({
  id,
  type: 'chord',
  at,
  notes: { kind: 'chord', symbol },
  voicing: 'even',
  assign: 'ordered',
  count: 4,
  register: [48, 67],
  glide: { land: true, length: 0.4 },
});

function piece(seed: number): Piece {
  const p = newPiece({ seed: 7, poolSize: 6 });
  for (const v of p.voices) {
    v.range = [36, 96];
    v.timbre = 'sine';
  }
  p.key = { tonic: 'C', scale: 'major' };
  p.view = { ...p.view, gridBpm: 80, meter: 4 };
  p.moments = [
    chord('c1', 0, 'I'),
    chord('c2', BAR, 'vi'),
    chord('c3', 2 * BAR, 'IV'),
    chord('c4', 3 * BAR, 'V'),
    { id: 'tune01', type: 'tune', at: 0, line: 'high', notes: [{ pitch: 72, len: 4 * BAR }] },
  ];
  return fitTune(p, 'tune01', seed);
}

/** Pitch (MIDI) around sample `c`: the first autocorrelation peak within 85 % of the largest. */
function pitchNear(x: Float32Array, c: number): number {
  const W = 2400;
  const lo = Math.floor(SR / 1500);
  const hi = Math.ceil(SR / 80);
  const ac = (lag: number): number => {
    let s = 0;
    for (let i = c - W; i < c + W; i++) s += x[i] * x[i + lag];
    return s;
  };
  const r: number[] = [];
  for (let lag = lo; lag < hi; lag++) r.push(ac(lag));
  const max = Math.max(...r);
  let j = 1;
  while (j < r.length - 1 && !(r[j] >= 0.85 * max && r[j] >= r[j - 1] && r[j] >= r[j + 1])) j++;
  const [a, b, d] = [r[j - 1], r[j], r[j + 1]];
  const lag = lo + j + (a - d) / (2 * (a - 2 * b + d));
  return 69 + 12 * Math.log2(SR / lag / 440);
}

describe('fitted melody, rendered', () => {
  it('sounds in key with chord tones on strong beats', () => {
    for (const seed of [2024, 7]) {
      const p = piece(seed);
      const m = p.moments.find((x) => x.id === 'tune01') as TuneMoment;
      const score = compile(p);
      const line = score.voices.findIndex((v) => v.segments.some((s) => s.momentId === m.id));
      const solo = {
        ...score,
        voices: score.voices.map((v, i) => (i === line ? v : { ...v, lives: [], segments: [] })),
      };
      const mix = {
        ...p.mix,
        reverb: { ...p.mix.reverb, returnLevel: 0 },
        delay: { ...p.mix.delay, returnLevel: 0 },
      };
      const { left } = renderOffline(
        { score: solo, mix, sampleRate: SR },
        exportFrameCount(solo, mix, SR),
      );
      const starts = tuneNoteStarts(m);
      let strong = 0;
      m.notes.forEach((n, k) => {
        const midi = pitchNear(left, Math.round((starts[k] + 0.6 * n.len) * SR));
        const p12 = Math.round(midi);
        expect(Math.abs(midi - p12), `note ${k}`).toBeLessThan(0.1);
        expect(p12).toBe(n.pitch);
        const pc = ((p12 % 12) + 12) % 12;
        expect([0, 2, 4, 5, 7, 9, 11]).toContain(pc);
        const b = starts[k] / BEAT;
        if (Math.abs(b - Math.round(b)) < 1e-6 && Math.round(b) % 2 === 0) {
          strong++;
          expect(CHORDS[Math.min(3, Math.floor(starts[k] / BAR + 1e-6))]).toContain(pc);
        }
      });
      expect(strong).toBeGreaterThanOrEqual(7);
    }
  }, 30_000);
});
