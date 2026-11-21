/**
 * Unit tests per moment type (PLAN.md §6.2) and the compiler's overall semantics (§7).
 */
import { describe, expect, it } from 'vitest';
import { compile, compileWithTrace } from '../../../src/core/compiler/compile';
import { motionAt, pitchAt, sample } from '../../../src/core/query';
import { scalePcs } from '../../../src/core/scales';
import { evalSegmentVelocity } from '../../../src/core/segment';
import type { CompiledScore, CompiledVoice, Moment, Piece } from '../../../src/core/types';
import { piece, stackedChordAt, type MomentInput } from './compiler-fixtures';

/** A piece with no stagger or jitter, so timings are exact. */
const tight = (opts: Parameters<typeof piece>[0]): Piece =>
  piece({
    ...opts,
    glide: { length: 2, jitter: 0, stagger: 0, ease: 'smootherstep', ...opts.glide },
  });

const voice = (s: CompiledScore, id: string): CompiledVoice => s.voices.find((v) => v.id === id)!;
const codes = (s: CompiledScore): string[] => s.diagnostics.map((d) => d.code);
/** Just before the end, when every voice holds its final pitch. */
const last = (s: CompiledScore): number => s.duration - 1e-6;
/** Sorted pitches of the voices sounding at the end. */
/** Revision 8: merged lines count once per voice they stand for (their weight). */
const finalChord = (s: CompiledScore): number[] => stackedChordAt(s, last(s));
const errors = (s: CompiledScore) => s.diagnostics.filter((d) => d.level === 'error');

describe('chord', () => {
  it('voices a chord symbol evenly over the register and keeps lines ordered', () => {
    const s = compile(
      tight({
        start: [50, 55, 60, 65],
        moments: [
          {
            type: 'chord',
            at: 1,
            notes: { kind: 'chord', symbol: 'Am7' },
            voicing: 'even',
            assign: 'ordered',
            register: [45, 72],
          },
        ],
      }),
    );
    expect(errors(s)).toEqual([]);
    const final = finalChord(s);
    // A C E G candidates in [45, 72]: 45 48 52 55 57 60 64 67 69 72; even picks 0, 3, 6, 9.
    expect(final).toEqual([45, 55, 64, 72]);
    // Order-preserving: the voice order is unchanged.
    const order = s.voices.slice(0, 4).map((v) => pitchAt(v, last(s)));
    expect(order).toEqual([...order].sort((a, b) => a! - b!));
  });

  it('close and nearest voicings', () => {
    const close = compile(
      tight({
        start: [50, 55, 60],
        moments: [
          {
            type: 'chord',
            at: 1,
            notes: { kind: 'chord', symbol: 'C' },
            voicing: 'close',
            assign: 'ordered',
            register: [48, 72],
          },
        ],
      }),
    );
    expect(finalChord(close)).toEqual([55, 60, 64]); // three consecutive tones centred on 60
    const nearest = compile(
      tight({
        start: [50, 56, 61],
        moments: [
          {
            type: 'chord',
            at: 1,
            notes: { kind: 'chord', symbol: 'C' },
            voicing: 'nearest',
            assign: 'ordered',
          },
        ],
      }),
    );
    expect(finalChord(nearest)).toEqual([48, 55, 60]);
  });

  it('slash chords put the bass in the lowest voice; Roman numerals read the key', () => {
    const s = compile(
      tight({
        start: [50, 55, 60, 65],
        key: { tonic: 'C', scale: 'major' },
        moments: [
          {
            type: 'chord',
            at: 1,
            notes: { kind: 'chord', symbol: 'C/E' },
            voicing: 'even',
            assign: 'ordered',
            register: [48, 72],
          },
        ],
      }),
    );
    expect(finalChord(s)[0] % 12).toBe(4);
    const r = compile(
      tight({
        start: [50, 55, 60],
        key: { tonic: 'C', scale: 'major' },
        moments: [
          {
            type: 'chord',
            at: 1,
            notes: { kind: 'chord', symbol: 'ii' },
            voicing: 'even',
            assign: 'ordered',
            register: [48, 72],
          },
        ],
      }),
    );
    // D F A; even spacing over the candidates need not use every chord tone.
    for (const p of finalChord(r)) expect([2, 5, 9]).toContain(p % 12);
  });

  it('fewer notes than voices double via the surjective assignment', () => {
    const s = compile(
      tight({
        start: [50, 52, 60, 62],
        moments: [
          {
            type: 'chord',
            at: 1,
            notes: { kind: 'pitches', pitches: [51, 61] },
            voicing: 'even',
            assign: 'ordered',
          },
        ],
      }),
    );
    expect(finalChord(s)).toEqual([51, 51, 61, 61]);
  });

  it('an invalid chord symbol is an error diagnostic and moves nothing', () => {
    const s = compile(
      tight({
        start: [50, 60],
        moments: [
          {
            type: 'chord',
            at: 1,
            notes: { kind: 'chord', symbol: 'H#q' },
            voicing: 'even',
            assign: 'ordered',
          },
        ],
      }),
    );
    expect(errors(s).map((d) => d.code)).toEqual(['chord-parse']);
    expect(finalChord(s)).toEqual([50, 60]);
  });

  it('free assignment may cross; ordered never crosses mid-glide', () => {
    const base = {
      start: [60, 62],
      glide: { length: 3, jitter: 0.9, stagger: 2, order: 'low-first' as const },
    };
    const free = compile(
      piece({
        ...base,
        moments: [
          {
            type: 'chord',
            at: 1,
            notes: { kind: 'pitches', pitches: [70, 61] },
            voicing: 'even',
            assign: 'free',
          },
        ],
      }),
    );
    expect(errors(free)).toEqual([]);
    const ordered = compileWithTrace(
      piece({
        ...base,
        moments: [
          {
            type: 'chord',
            at: 1,
            notes: { kind: 'pitches', pitches: [72, 74] },
            voicing: 'even',
            assign: 'ordered',
          },
        ],
      }),
    );
    const [lo, hi] = ordered.score.voices;
    for (let t = 1; t < 8; t += 0.01)
      expect(pitchAt(lo, t)!).toBeLessThanOrEqual(pitchAt(hi, t)! + 1e-9);
  });
});

describe('unison', () => {
  it('sends every voice to one pitch, to the nearest octave, to the centre or the tonic', () => {
    const one = compile(
      tight({
        start: [50, 60, 70],
        moments: [{ type: 'unison', at: 1, pitch: 62, octaves: false }],
      }),
    );
    expect(finalChord(one)).toEqual([62, 62, 62]);
    const oct = compile(
      tight({
        start: [50, 60, 70],
        moments: [{ type: 'unison', at: 1, pitch: 62, octaves: true }],
      }),
    );
    expect(finalChord(oct)).toEqual([50, 62, 74]);
    const centre = compile(
      tight({
        start: [50, 70],
        key: { tonic: 'C', scale: 'major' },
        moments: [{ type: 'unison', at: 1, pitch: 'center', octaves: false }],
      }),
    );
    expect(finalChord(centre)).toEqual([60, 60]);
    const tonic = compile(
      tight({
        start: [50, 70],
        key: { tonic: 'D', scale: 'dorian' },
        moments: [{ type: 'unison', at: 1, pitch: 'tonic', octaves: false }],
      }),
    );
    expect(finalChord(tonic)).toEqual([62, 62]);
  });
});

describe('split (§7.4)', () => {
  it('births dormant voices that fork from their parent at its departure', () => {
    const p = tight({
      start: [57],
      glide: { length: 3, stagger: 0 },
      moments: [
        {
          type: 'split',
          at: 2,
          count: 3,
          notes: { kind: 'pitches', pitches: [50, 57, 64] },
          voicing: 'even',
        },
      ],
    });
    const s = compile(p);
    expect(errors(s)).toEqual([]);
    const born = s.voices.filter((v) => v.lives.length > 0);
    expect(born.map((v) => v.id)).toEqual(['v1', 'v2', 'v3']);
    for (const v of born.slice(1)) {
      const life = v.lives[0];
      expect(life.born).toBe(2); // the parent leaves at 2 (no stagger)
      expect(v.segments[0].t0).toBe(life.born);
      expect(v.segments[0].p0).toBe(57); // on the parent's pitch
      expect(life.fadeIn).toBe(1.5); // max(0.5, 3 / 2)
    }
    expect(finalChord(s)).toEqual([50, 57, 64]);
  });

  it('truncates when the pool is exhausted', () => {
    const s = compile(
      tight({
        pool: 3,
        start: [57],
        moments: [{ type: 'split', at: 1, count: 5, voicing: 'even' }],
      }),
    );
    expect(codes(s)).toContain('pool-exhausted');
    expect(s.voices.every((v) => v.lives.length === 1)).toBe(true);
  });

  it('a chord from silence brings its voices in on their notes; a later moment retargets them', () => {
    const p = tight({
      start: [],
      moments: [
        {
          type: 'chord',
          at: 1,
          count: 2,
          notes: { kind: 'pitches', pitches: [55, 62] },
          voicing: 'even',
          assign: 'ordered',
        },
        {
          type: 'chord',
          at: 1.5,
          notes: { kind: 'pitches', pitches: [53, 60] },
          voicing: 'even',
          assign: 'ordered',
        },
      ],
    });
    const s = compile(p);
    expect(s.voices[0].segments[0].p0).toBe(55);
    expect(finalChord(s)).toEqual([53, 60]);
  });

  it('a newborn whose move is cancelled is still born, on its parent, and moves later (§7.1)', () => {
    const p = piece({
      start: [57],
      glide: { length: 2, jitter: 0, stagger: 3 },
      moments: [
        // The parent stays on 57; high-first (revision 9: newborns take ranked stagger offsets)
        // births v3 (→ 69) first and v2 (→ 64) at least half the stagger later.
        {
          type: 'split',
          at: 1,
          count: 3,
          notes: { kind: 'pitches', pitches: [57, 64, 69] },
          voicing: 'even',
          glide: { order: 'high-first' },
        },
        // Cancels the newborn's pending move before it is born (births are never cancelled).
        { type: 'pin', at: 1.01, voice: 'v2', pitch: 70, glide: { stagger: 0 } },
      ],
    });
    const s = compile(p);
    const v2 = voice(s, 'v2');
    expect(v2.lives[0].born).toBeGreaterThan(1.01);
    expect(v2.segments[0].p0).toBe(57);
    expect(v2.segments.some((g) => g.momentId === 'm0')).toBe(false);
    expect(pitchAt(v2, last(s))).toBe(70);
  });
});

describe('merge (§7.4)', () => {
  it('dying voices glide into their nearest survivor, fade, and can be reborn', () => {
    const p = tight({
      start: [50, 55, 60, 65],
      moments: [
        { type: 'merge', at: 1, count: 2, which: 'top', fade: 1.5 },
        {
          type: 'split',
          at: 10,
          count: 4,
          voicing: 'even',
          notes: { kind: 'pitches', pitches: [48, 52, 58, 62] },
        },
      ],
    });
    const s = compile(p);
    expect(errors(s)).toEqual([]);
    const v3 = voice(s, 'v3');
    const v4 = voice(s, 'v4');
    // v3 (60) and v4 (65) die into v2 (55): glide 2 s, then fade 1.5 s.
    expect(v3.lives[0].died).toBe(1 + 2 + 1.5);
    expect(v3.lives[0].fadeOut).toBe(1.5);
    expect(pitchAt(v3, 3)).toBe(55);
    expect(pitchAt(v4, 3)).toBe(55);
    expect(pitchAt(v3, 6)).toBeNull();
    expect(v3.lives.length).toBe(2); // reborn by the split
    expect(finalChord(s)).toEqual([48, 52, 58, 62]);
  });

  it('which: bottom, inner, outer and random pick different voices', () => {
    const run = (which: 'bottom' | 'inner' | 'outer' | 'random'): string[] => {
      const s = compile(
        tight({
          start: [50, 55, 60, 65, 70],
          moments: [{ type: 'merge', at: 1, count: 3, which, fade: 1 }],
        }),
      );
      return s.voices.filter((v) => v.lives[0]?.fadeOut === 1).map((v) => v.id);
    };
    expect(run('bottom')).toEqual(['v1', 'v2']);
    expect(run('inner')).toEqual(['v2', 'v3']);
    expect(run('outer')).toEqual(['v1', 'v5']);
    expect(run('random')).toHaveLength(2);
  });
});

describe('shift and spread', () => {
  it('shift moves by semitones or scale steps (snapping first)', () => {
    const semis = compile(
      tight({ start: [50, 60], moments: [{ type: 'shift', at: 1, by: 3, unit: 'semitones' }] }),
    );
    expect(finalChord(semis)).toEqual([53, 63]);
    const steps = compile(
      tight({
        start: [60, 61],
        key: { tonic: 'C', scale: 'major' },
        moments: [{ type: 'shift', at: 1, by: 2, unit: 'scaleSteps' }],
      }),
    );
    // 60 (C) → E 64; 61 snaps down to C (ties down) → E 64.
    expect(finalChord(steps)).toEqual([64, 64]);
  });

  it('spread scales around the mean or median, then snaps', () => {
    const s = compile(
      tight({
        start: [57, 60, 64],
        key: { tonic: 'C', scale: 'major' },
        moments: [{ type: 'spread', at: 1, factor: 2, around: 'median', snap: 'scale' }],
      }),
    );
    expect(finalChord(s)).toEqual([53, 60, 67]); // 54 snaps down to F (53); 68 → 67 (G)
    const none = compile(
      tight({
        start: [50, 70],
        moments: [{ type: 'spread', at: 1, factor: 0.5, around: 'mean', snap: 'none' }],
      }),
    );
    expect(finalChord(none)).toEqual([55, 65]);
  });
});

describe('walk (§6.2, §7.1)', () => {
  const walk = (extra: Partial<MomentInput> = {}): MomentInput =>
    ({
      type: 'walk',
      at: 0,
      until: 20,
      grid: 0.5,
      density: 0.6,
      steps: [-2, -1, 1, 2],
      stepGlide: 0.3,
      ...extra,
    }) as MomentInput;

  it('steps on scale tones, strictly between neighbours, never crossing or touching', () => {
    const s = compile(
      tight({ start: [50, 57, 62, 69], key: { tonic: 'A', scale: 'dorian' }, moments: [walk()] }),
    );
    const pcs = new Set(scalePcs({ tonic: 'A', scale: 'dorian' }));
    let steps = 0;
    for (const v of s.voices.slice(0, 4)) {
      for (const g of v.segments) {
        if (g.momentId !== 'm0') continue;
        steps++;
        expect(pcs.has(((g.p1 % 12) + 12) % 12)).toBe(true);
      }
    }
    expect(steps).toBeGreaterThan(30);
    for (let t = 0; t < 22; t += 0.01) {
      const ps = s.voices.slice(0, 4).map((v) => pitchAt(v, t)!);
      for (let i = 1; i < 4; i++) expect(ps[i]).toBeGreaterThan(ps[i - 1]);
    }
  });

  it('the bass leaps within [min, max] semitones; density 0 never steps', () => {
    const s = compile(
      tight({
        start: [40, 57, 62],
        moments: [walk({ bass: { leap: [5, 12] } } as Partial<MomentInput>)],
      }),
    );
    const leaps = s.voices[0].segments.filter((g) => g.momentId === 'm0');
    expect(leaps.length).toBeGreaterThan(3);
    for (const g of leaps) {
      expect(Math.abs(g.p1 - g.p0)).toBeGreaterThanOrEqual(5);
      expect(Math.abs(g.p1 - g.p0)).toBeLessThanOrEqual(12);
    }
    const quiet = compile(
      tight({ start: [50, 60], moments: [walk({ density: 0 } as Partial<MomentInput>)] }),
    );
    expect(quiet.voices.flatMap((v) => v.segments).filter((g) => g.momentId === 'm0')).toEqual([]);
  });

  it('a chord inside the region wins; walking resumes after its glide (§7.1)', () => {
    const p = tight({
      start: [50, 57, 62],
      glide: { length: 3 },
      moments: [
        walk({ density: 1 } as Partial<MomentInput>),
        {
          type: 'chord',
          at: 5.2,
          notes: { kind: 'pitches', pitches: [48, 60, 72] },
          voicing: 'even',
          assign: 'ordered',
        },
      ],
    });
    const s = compile(p);
    for (const v of s.voices.slice(0, 3)) {
      const chord = v.segments.find((g) => g.momentId === 'm1')!;
      expect(chord.curve).toBeUndefined(); // never cut by a step
      const next = v.segments.find((g) => g.momentId === 'm0' && g.t0 > chord.t0)!;
      expect(next.t0).toBeGreaterThanOrEqual(chord.t1);
    }
  });

  it('two walks on the same voice: the later one drives it', () => {
    const s = compile(
      tight({
        start: [50, 60],
        moments: [
          walk({ density: 1 } as Partial<MomentInput>),
          walk({
            at: 5,
            until: 10,
            density: 1,
            target: { voices: ['v2'] },
          } as Partial<MomentInput>),
        ],
      }),
    );
    const v2 = voice(s, 'v2');
    expect(v2.segments.some((g) => g.momentId === 'm1')).toBe(true);
    expect(v2.segments.some((g) => g.momentId === 'm0' && g.t0 >= 5 && g.t0 < 10)).toBe(false);
  });

  it('walks read the key in effect at each tick', () => {
    const s = compile(
      tight({
        start: [50, 60, 70],
        key: { tonic: 'C', scale: 'major' },
        moments: [
          { type: 'key', at: 0, key: { tonic: 'F#', scale: 'whole-tone' } },
          walk({ density: 1, steps: [1] } as Partial<MomentInput>),
        ],
      }),
    );
    const pcs = new Set(scalePcs({ tonic: 'F#', scale: 'whole-tone' }));
    for (const v of s.voices.slice(0, 3)) {
      for (const g of v.segments) if (g.momentId === 'm1') expect(pcs.has(g.p1 % 12)).toBe(true);
    }
    expect(s.keys).toEqual([
      { t: 0, key: { tonic: 'C', scale: 'major' } },
      { t: 0, key: { tonic: 'F#', scale: 'whole-tone' } },
    ]);
  });
});

describe('pin, level and key', () => {
  it('pin moves one voice exactly, and may cross; an inactive voice is an error', () => {
    const s = compile(
      tight({ start: [50, 60], moments: [{ type: 'pin', at: 1, voice: 'v1', pitch: 65 }] }),
    );
    expect(pitchAt(s.voices[0], last(s))).toBe(65);
    expect(pitchAt(s.voices[1], last(s))).toBe(60);
    const bad = compile(
      tight({ start: [50], moments: [{ type: 'pin', at: 1, voice: 'v5', pitch: 65 }] }),
    );
    expect(errors(bad).map((d) => d.code)).toEqual(['pin-inactive']);
  });

  it('level writes a level timeline for the targeted voices only', () => {
    const s = compile(
      tight({
        start: [50, 60],
        moments: [{ type: 'level', at: 2, gain: 0.25, over: 3, target: { voices: ['v2'] } }],
      }),
    );
    expect(s.voices[0].level).toEqual([]);
    expect(s.voices[1].level).toEqual([{ t: 2, gain: 0.25, over: 3 }]);
  });
});

describe('interruption (§7.5)', () => {
  it('a moment arriving mid-glide cuts the glide and carries its velocity (C¹)', () => {
    const s = compile(
      tight({
        start: [50],
        glide: { length: 4 },
        moments: [
          { type: 'pin', at: 1, voice: 'v1', pitch: 70 },
          { type: 'pin', at: 2.5, voice: 'v1', pitch: 55 },
        ],
      }),
    );
    const segs = s.voices[0].segments;
    const cut = segs.find((g) => g.curve)!;
    expect(cut.curve).toEqual({ t1: 5, p1: 70 });
    expect(cut.t1).toBe(2.5);
    const next = segs[segs.indexOf(cut) + 1];
    expect(next.p0).toBe(cut.p1);
    if (!next.clamped) {
      expect(evalSegmentVelocity(next, 2.5)).toBeCloseTo(evalSegmentVelocity(cut, 2.5), 9);
    }
    expect(pitchAt(s.voices[0], last(s))).toBe(55);
  });
});

describe('the end, spans and robustness', () => {
  it('ends 4 s after the last activity by default, with the end fade', () => {
    const s = compile(
      tight({ start: [50], moments: [{ type: 'pin', at: 1, voice: 'v1', pitch: 60 }] }),
    );
    expect(s.duration).toBe(1 + 2 + 4);
    const life = s.voices[0].lives[0];
    expect(life.died).toBe(7);
    expect(life.fadeOut).toBe(6); // newPiece's end.fade
  });

  it('an explicit end cuts everything after it', () => {
    const s = compile(
      tight({
        start: [50],
        end: { at: 2, fade: 1 },
        moments: [
          { type: 'pin', at: 1, voice: 'v1', pitch: 60 },
          { type: 'pin', at: 3, voice: 'v1', pitch: 40 },
        ],
      }),
    );
    expect(s.duration).toBe(2);
    expect(s.voices[0].segments.at(-1)!.t1).toBe(2);
    expect(s.voices[0].segments.at(-1)!.curve).toBeDefined();
    expect(codes(s)).toContain('after-end');
  });

  it('moment spans cover each moment’s moves', () => {
    const s = compile(
      tight({
        start: [50, 60],
        moments: [
          { type: 'shift', at: 1, by: 2, unit: 'semitones' },
          { type: 'key', at: 4, key: { tonic: 'C', scale: 'major' } },
        ],
      }),
    );
    expect(s.momentSpans).toEqual([
      { id: 'start0', start: 0, end: 0 },
      { id: 'm0', start: 1, end: 3 },
      { id: 'm1', start: 4, end: 4 },
    ]);
  });

  it('skips unknown moment types from newer files with an info diagnostic, never throwing', () => {
    const p = tight({ start: [50], moments: [{ type: 'pin', at: 1, voice: 'v1', pitch: 60 }] });
    (p as { version: number }).version = 3;
    p.moments.push({ id: 'zz9', type: 'mirror', at: 2, axis: 60 } as unknown as Moment);
    p.moments.push({ id: 'zz8', type: 'timbre', at: 3, preset: 'glass' } as unknown as Moment);
    const s = compile(p);
    const unknown = s.diagnostics.filter((d) => d.code === 'unknown-moment-type');
    expect(unknown.map((d) => [d.level, d.momentId])).toEqual([
      ['info', 'zz9'],
      ['info', 'zz8'],
    ]);
    expect(pitchAt(s.voices[0], last(s))).toBe(60);
  });

  it('muted moments are skipped', () => {
    const s = compile(
      tight({
        start: [50],
        moments: [{ type: 'pin', at: 1, voice: 'v1', pitch: 60, muted: true }],
      }),
    );
    expect(pitchAt(s.voices[0], 3)).toBe(50);
    expect(s.momentSpans).toEqual([{ id: 'start0', start: 0, end: 0 }]);
  });

  it('lists the whole pool in order, with static voice params', () => {
    const p = tight({ pool: 5, start: [50] });
    p.voices[2].gain = 0.5;
    p.voices[2].pan = -0.5;
    p.voices[2].mute = true;
    p.voices[2].sends = { reverb: 0.1 };
    const s = compile(p);
    expect(s.voices.map((v) => v.index)).toEqual([0, 1, 2, 3, 4]);
    expect(s.voices[2]).toMatchObject({
      gain: 0.5,
      pan: -0.5,
      mute: true,
      solo: false,
      sends: { reverb: 0.1 },
      lives: [],
    });
    expect(s.voices[0].timbre).toEqual([{ t: 0, preset: p.voices[0].timbre, fade: 0 }]);
  });
});

describe('query API (§7.9)', () => {
  const s = compile(
    tight({
      start: [50],
      moments: [
        { type: 'pin', at: 1, voice: 'v1', pitch: 62 },
        { type: 'merge', at: 5, count: 0, which: 'top', fade: 1 },
        // Silence, then a chord brings the voice back (M4.5-27).
        {
          type: 'chord',
          at: 9,
          voicing: 'even',
          assign: 'ordered',
          notes: { kind: 'pitches', pitches: [55] },
        },
      ],
    }),
  );
  const v1 = s.voices[0];

  it('pitchAt evaluates and is null while dormant', () => {
    expect(pitchAt(v1, 0.5)).toBe(50);
    expect(pitchAt(v1, 2)).toBeCloseTo(56, 9);
    expect(pitchAt(v1, 8.5)).toBeNull();
    expect(pitchAt(v1, -1)).toBeNull();
  });

  it('motionAt is sin(πx) while gliding and 0 while holding', () => {
    expect(motionAt(v1, 2)).toBeCloseTo(1, 9);
    expect(motionAt(v1, 4)).toBe(0);
    expect(motionAt(v1, 8.5)).toBe(0);
  });

  it('sample: holds give two points, glides are subdivided, lives are separated', () => {
    const pts = sample(v1, 0, 20, 0.25);
    expect(pts[0]).toEqual([0, 50]);
    expect(pts[1]).toEqual([1, 50]);
    const glide = pts.filter(([t]) => t > 1 && t < 3);
    expect(glide.length).toBeGreaterThanOrEqual(7);
    for (let i = 1; i < pts.length; i++) expect(pts[i][0]).toBeGreaterThanOrEqual(pts[i - 1][0]);
    expect(pts.some(([, p]) => Number.isNaN(p))).toBe(true);
  });
});
