/**
 * The §7.10 benchmark piece: 5 minutes, 24 voices, 200 moments, built deterministically.
 *
 * Dense on purpose: moments every 1.45 s with 3.5 s glides and staggers, so most moves interrupt
 * running glides (velocity carry, clamps) and every ordered moment runs its 64-point crossing
 * check over up to 24 voices.
 */
import { newPiece } from '../../../src/core/defaults';
import type { Moment, Piece } from '../../../src/core/types';

const SYMBOLS = ['Am9', 'Dm7', 'G7', 'Cmaj7', 'Fmaj7', 'Bm7b5', 'E7', 'Am7', 'ii7', 'V9'];

export function benchmarkPiece(): Piece {
  const p = newPiece({ seed: 2611, poolSize: 24, title: 'Benchmark' });
  p.voices.forEach((v) => (v.range = [33, 93]));
  p.start = [{ voice: 'v1', pitch: 57 }];
  const moments: Moment[] = [];
  let t = 2;
  let k = 0;
  const id = (): string => `b${(k++).toString(36).padStart(5, '0')}`;
  // Grow to 24 voices.
  for (const count of [3, 6, 10, 16, 24]) {
    moments.push({
      id: id(),
      type: 'split',
      at: t,
      count,
      voicing: 'even',
      notes: { kind: 'chord', symbol: SYMBOLS[k % SYMBOLS.length] },
    });
    t += 2;
  }
  let i = 0;
  while (moments.length < 200) {
    const sym = SYMBOLS[i % SYMBOLS.length];
    const r = i % 12;
    if (r === 0 || r === 4 || r === 8) {
      moments.push({
        id: id(),
        type: 'chord',
        at: t,
        notes: { kind: 'chord', symbol: sym },
        voicing: 'even',
        assign: 'ordered',
        register: [40, 88],
      });
    } else if (r === 1) {
      moments.push({ id: id(), type: 'shift', at: t, by: i % 2 ? 2 : -2, unit: 'scaleSteps' });
    } else if (r === 2) {
      moments.push({
        id: id(),
        type: 'spread',
        at: t,
        factor: 1.3,
        around: 'median',
        snap: 'scale',
      });
    } else if (r === 3) {
      moments.push({
        id: id(),
        type: 'walk',
        at: t,
        until: t + 5,
        grid: 0.5,
        density: 0.45,
        steps: [-2, -1, 1, 2],
        stepGlide: 0.3,
        bass: { leap: [5, 12] },
      });
    } else if (r === 5) {
      moments.push({
        id: id(),
        type: 'chord',
        at: t,
        target: { rank: [0, 11] },
        notes: { kind: 'degrees', degrees: [0, 2, 4, 6] },
        voicing: 'close',
        assign: 'ordered',
      });
    } else if (r === 6) {
      moments.push({ id: id(), type: 'merge', at: t, count: 14, which: 'inner', fade: 2 });
    } else if (r === 7) {
      moments.push({
        id: id(),
        type: 'split',
        at: t,
        count: 24,
        voicing: 'even',
        notes: { kind: 'chord', symbol: sym },
      });
    } else if (r === 9) {
      moments.push({ id: id(), type: 'unison', at: t, pitch: 'center', octaves: true });
    } else if (r === 10) {
      moments.push({
        id: id(),
        type: 'chord',
        at: t,
        notes: { kind: 'current' },
        voicing: 'nearest',
        assign: 'free',
      });
    } else {
      moments.push({ id: id(), type: 'level', at: t, gain: 0.7 + 0.1 * (i % 3), over: 2 });
    }
    t += 1.45;
    i++;
  }
  p.moments = moments;
  p.defaults.glide = {
    length: 3.5,
    jitter: 0.3,
    stagger: 1.2,
    order: 'random',
    ease: 'smootherstep',
  };
  return p;
}
