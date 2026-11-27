/**
 * M13 walks: "Glide to next tick" (`glideToTick`: a step glides until the next tick, lines that
 * step on every tick draw curves, and lines still never cross mid-glide) and "Step past a
 * neighbour" (`stepPast`: a step may land past a holding neighbour by at least that spacing, and
 * only that pair crosses; the bass is never passed). Both off by default.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { freezeWalk, walkStepGlide, walkTick, type WalkEnv } from '../../../src/core/moments/walk';
import { pitchAt } from '../../../src/core/query';
import type { CompiledScore, EaseRef, Key, WalkMoment } from '../../../src/core/types';
import { piece, type MomentInput } from './compiler-fixtures';

const C_MAJOR: Key = { tonic: 'C', scale: 'major' };

function walk(fields: Partial<WalkMoment> = {}): MomentInput {
  return {
    type: 'walk',
    at: 0.5,
    until: 16,
    grid: 0.5,
    density: 0.7,
    steps: [-2, -1, 1, 2],
    stepGlide: 0.1,
    ...fields,
  } as MomentInput;
}

const make = (
  w: MomentInput,
  start = [48, 55, 60, 64],
  seed = 2611,
  ease: EaseRef = 'smootherstep',
) =>
  piece({
    seed,
    pool: 6,
    start,
    glide: { length: 0.5, jitter: 0, stagger: 0, ease },
    end: { at: 18, fade: 1 },
    key: C_MAJOR,
    moments: [w],
  });

const moves = (s: CompiledScore) => s.walkSteps.filter((x) => x.from !== x.to);

/**
 * Pitch-order flips between adjacent samples (every 10 ms) of each pair of sounding voices, as
 * [time, a, b] (voice indices).
 */
function flips(s: CompiledScore, t0: number, t1: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  const vs = s.voices;
  let prev: (number | null)[] | null = null;
  for (let t = t0; t <= t1; t += 0.01) {
    const ps = vs.map((v) => pitchAt(v, t));
    if (prev) {
      for (let a = 0; a < vs.length; a++)
        for (let b = a + 1; b < vs.length; b++) {
          const [pa, pb, qa, qb] = [prev[a], prev[b], ps[a], ps[b]];
          if (pa === null || pb === null || qa === null || qb === null) continue;
          if (Math.sign(pa - pb) * Math.sign(qa - qb) < 0) out.push([t, a, b]);
        }
    }
    prev = ps;
  }
  return out;
}

describe('glide to next tick', () => {
  it('off by default: the same score as without the field', () => {
    expect(compile(make(walk({ glideToTick: false })))).toEqual(compile(make(walk())));
  });

  it('each step glides until the next tick, ending exactly there or a float step before', () => {
    const w = walk({ glideToTick: true }) as WalkMoment;
    const s = compile(make(w));
    const ms = moves(s);
    expect(ms.length).toBeGreaterThan(20);
    for (const st of ms) {
      const v = s.voices.find((x) => x.id === st.voice)!;
      const seg = v.segments.find((g) => g.momentId === 'm0' && g.t0 === st.t)!;
      const next = w.at + (st.tick + 1) * w.grid;
      expect(seg.t1).toBeLessThanOrEqual(next);
      expect(next - seg.t1).toBeLessThan(1e-9);
    }
  });

  it('a line steps on consecutive ticks, so its glides join into a curve', () => {
    const s = compile(make(walk({ glideToTick: true, density: 0.9 })));
    const ms = moves(s);
    const consecutive = ms.some((a) =>
      ms.some((b) => b.voice === a.voice && b.tick === a.tick + 1),
    );
    expect(consecutive).toBe(true);
  });

  it('walkStepGlide: the grid, or to the next whole tick for a fractional (frozen) tick', () => {
    const w = { at: 0.1, grid: 0.3, stepGlide: 0.2, glideToTick: true };
    for (let k = 0; k < 200; k++) {
      const d = walkStepGlide(w, k);
      expect(w.at + k * w.grid + d).toBeLessThanOrEqual(w.at + (k + 1) * w.grid);
      expect(d).toBeCloseTo(0.3, 9);
    }
    expect(walkStepGlide(w, 2.5)).toBeCloseTo(0.15, 9);
    expect(walkStepGlide({ ...w, glideToTick: undefined }, 3)).toBe(0.2);
  });

  it('lines never cross mid-glide (seeds, eases, grids)', () => {
    const eases: EaseRef[] = ['smootherstep', 'linear', 'cosine', 'expo'];
    let checked = 0;
    for (let seed = 1; seed <= 24; seed++) {
      const grid = [0.25, 0.5, 0.8][seed % 3];
      const s = compile(
        make(
          walk({ glideToTick: true, density: 0.8, grid, steps: [-2, -1, 1, 2] }),
          [48, 52, 55, 57, 60, 62],
          seed,
          eases[seed % eases.length],
        ),
      );
      checked += moves(s).length;
      expect(flips(s, 0.5, 17)).toEqual([]);
    }
    expect(checked).toBeGreaterThan(300);
  });
});

/** A walkTick env over voices 0..n−1 in pitch order, all in the walk and eligible. */
function env(dests: number[], fields: Partial<WalkEnv> = {}): WalkEnv {
  return {
    t: 0,
    tick: 0,
    key: C_MAJOR,
    chord: null,
    seed: 1,
    order: dests.map((_, i) => i),
    dest: (v) => dests[v],
    inTarget: () => true,
    eligible: () => true,
    range: () => [36, 96],
    hash: (v) => 1000 + v,
    ...fields,
  };
}

const W = (fields: Partial<WalkMoment>): WalkMoment =>
  ({ ...(walk({ density: 1, ...fields }) as object), id: 'w' }) as WalkMoment;

describe('step past a neighbour (walkTick)', () => {
  it('today a step past a neighbour holds; with stepPast it lands past and the neighbour holds', () => {
    // C4 and D4, steps +2: C4 → E4 passes D4 (by 2 semitones).
    expect(walkTick(W({ steps: [2] }), env([60, 62]))).toEqual([{ voice: 1, from: 62, to: 65 }]);
    expect(walkTick(W({ steps: [2], stepPast: 1 }), env([60, 62]))).toEqual([
      { voice: 0, from: 60, to: 64 },
    ]);
    // Not far enough past it: holds as today.
    expect(walkTick(W({ steps: [2], stepPast: 3 }), env([60, 62]))).toEqual([
      { voice: 1, from: 62, to: 65 },
    ]);
  });

  it('downward past a neighbour that did not step', () => {
    // Voice 0 can't go down (its range), so it holds; D4 −2 → B3 passes C4 by 1.
    const e = env([60, 62], { range: (v) => (v === 0 ? [60, 96] : [36, 96]) });
    expect(walkTick(W({ steps: [-2] }), e)).toEqual([]);
    expect(walkTick(W({ steps: [-2], stepPast: 1 }), e)).toEqual([{ voice: 1, from: 62, to: 59 }]);
  });

  it('never past a line that is not idle in this walk, nor past two lines', () => {
    const busy = env([60, 62], { eligible: (v) => v === 0 });
    expect(walkTick(W({ steps: [2], stepPast: 1 }), busy)).toEqual([]);
    // C4 D4 E4, +2: C4 → E4 would pass D4 onto E4, so it holds; D4 → F4 passes E4, which holds.
    expect(walkTick(W({ steps: [2], stepPast: 1 }), env([60, 62, 64]))).toEqual([
      { voice: 1, from: 62, to: 65 },
    ]);
  });

  it('the bass is never passed', () => {
    const e = env([60, 62], { range: (v) => (v === 0 ? [60, 96] : [36, 96]) });
    expect(walkTick(W({ steps: [-2], stepPast: 1, bass: { leap: [3, 7] } }), e)).toEqual([]);
  });
});

describe('step past a neighbour (compiled)', () => {
  it('close lines that stood still now move, swapping order; no other pair crosses', () => {
    const close = [55, 57, 59, 60];
    const still = compile(make(walk({ steps: [-2, 2], density: 0.6 }), close));
    const past = compile(make(walk({ steps: [-2, 2], density: 0.6, stepPast: 1 }), close));
    expect(moves(past).length).toBeGreaterThan(moves(still).length);
    expect(flips(still, 0.5, 17)).toEqual([]);
    const fs = flips(past, 0.5, 17);
    expect(fs.length).toBeGreaterThan(0);
    // Every crossing is a step's glide past the other line, which holds there.
    const ids = past.voices.map((v) => v.id);
    for (const [t, a, b] of fs) {
      const ok = moves(past).some((st) => {
        const v = ids.indexOf(st.voice);
        if (v !== a && v !== b) return false;
        if (!(st.t <= t && t - 0.01 <= st.t + 0.1)) return false;
        const other = past.voices[v === a ? b : a];
        const p = pitchAt(other, st.t)!;
        return (st.from - p) * (st.to - p) < 0 && Math.abs(st.to - p) >= 1;
      });
      expect(ok, `crossing at ${t.toFixed(2)} of ${ids[a]}/${ids[b]}`).toBe(true);
    }
  });
});

describe('Freeze keeps the sound', () => {
  const sound = (s: CompiledScore): unknown => s.voices.map((v) => v.segments);
  const cases: [string, Partial<WalkMoment>][] = [
    ['glide to next tick', { glideToTick: true, density: 0.8 }],
    ['step past a neighbour', { steps: [-2, 2], density: 0.6, stepPast: 1 }],
    ['both', { steps: [-2, -1, 1, 2], density: 0.7, stepPast: 1, glideToTick: true }],
  ];
  for (const [name, fields] of cases) {
    it(name, () => {
      const p = make(walk(fields), [55, 57, 59, 60]);
      const live = compile(p);
      const frozen = structuredClone(p);
      const w = frozen.moments.find((m) => m.type === 'walk') as WalkMoment;
      w.fixed = freezeWalk(live, w.id);
      expect(sound(compile(frozen))).toEqual(sound(live));
    });
  }
});
