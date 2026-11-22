/**
 * Live voice leading (PLAN.md §9, core/live.ts): H → targets for every setting, release modes,
 * bend, sustain, CC1, and a chord pressed key by key re-targeting with carried velocity.
 */

import { describe, expect, it } from 'vitest';
import { evalSegment, evalSegmentVelocity } from '../../../src/core/segment';
import {
  bendFromMidi,
  clampBend,
  DEFAULT_LIVE_SETTINGS,
  glideFromModWheel,
  LIVE_ATTACK,
  LiveKeys,
  liveMoves,
  liveTargets,
  liveUpdate,
  mergeLiveSettings,
  MOD_GLIDE_MAX,
  MOD_GLIDE_MIN,
  type LiveMove,
  type LiveSettings,
  type LiveVoiceView,
  type LiveView,
} from '../../../src/core/live';
import type { Pitch, Segment } from '../../../src/core/types';

const S = (patch: Partial<LiveSettings> = {}): LiveSettings =>
  mergeLiveSettings(DEFAULT_LIVE_SETTINGS, patch);

/** Holding voices at `pitches`, range [36, 84]. */
function holding(pitches: Pitch[], range: [Pitch, Pitch] = [36, 84]): LiveVoiceView[] {
  return pitches.map((p, i) => ({
    index: i,
    id: `v${i + 1}`,
    range,
    pitch: p,
    velocity: 0,
    gliding: false,
    dest: p,
  }));
}

const view = (voices: LiveVoiceView[], level = 1, levelTarget = level): LiveView => ({
  voices,
  level,
  levelTarget,
});

const sorted = (xs: (number | null)[] | null): number[] =>
  (xs ?? []).map((x) => x as number).sort((a, b) => a - b);

describe('defaults and settings', () => {
  it('match the integrator defaults', () => {
    const s = DEFAULT_LIVE_SETTINGS;
    expect(s.single).toBe('unison');
    expect(s.chord).toBe('exact');
    expect(s.release).toBe('hold');
    expect(s.glide).toBe(0.25);
    expect(s.stagger).toBe(0);
    expect(s.order).toBe('random'); // the chord (piece glide) default
    expect(s.bendRange).toBe(2);
  });

  it('merge ignores unusable fields and clamps', () => {
    const s = mergeLiveSettings(DEFAULT_LIVE_SETTINGS, {
      glide: -1,
      stagger: Number.NaN,
      single: 'nope' as never,
      release: 'fade',
      register: [72, 48],
    });
    expect(s.glide).toBe(0.01);
    expect(s.stagger).toBe(0);
    expect(s.single).toBe('unison');
    expect(s.release).toBe('fade');
    expect(s.register).toEqual([48, 72]);
    expect(mergeLiveSettings(s, { register: undefined }).register).toBeUndefined();
  });
});

describe('targets for H', () => {
  const voices = holding([48, 55, 60, 64, 67, 72]);

  it('|H| = 1, unison: every voice on the note', () => {
    expect(liveTargets(voices, [62], S())).toEqual([62, 62, 62, 62, 62, 62]);
  });

  it('|H| = 1, octaves: each voice on its nearest octave of the note', () => {
    expect(liveTargets(voices, [62], S({ single: 'octaves' }))).toEqual([50, 50, 62, 62, 62, 74]);
  });

  it('|H| > 1, exact: the notes themselves, doubled surjectively and in order', () => {
    const t = liveTargets(voices, [60, 67], S());
    expect(t).toEqual([60, 60, 60, 67, 67, 67]);
    // More notes than voices: k evenly spaced notes.
    expect(sorted(liveTargets(holding([50, 70]), [60, 62, 64, 65, 67], S()))).toEqual([60, 67]);
    // As many: identity, in order.
    expect(liveTargets(holding([40, 50, 80]), [62, 66, 69], S())).toEqual([62, 66, 69]);
  });

  it('|H| > 1, range: the pitch classes spread evenly over the register', () => {
    const t = liveTargets(voices, [60, 64, 67], S({ chord: 'range', register: [48, 72] }));
    expect(t).not.toBeNull();
    for (const p of t!) expect([0, 4, 7]).toContain(((p % 12) + 12) % 12);
    expect(Math.min(...t!)).toBe(48);
    expect(Math.max(...t!)).toBe(72);
    expect(new Set(t).size).toBe(6); // distinct: more candidates than voices
    // In order: lines never cross (ordered assignment).
    expect([...t!].sort((a, b) => a - b)).toEqual(t);
  });

  it('targets fold into each voice range', () => {
    const vs = holding([40, 70]);
    vs[0].range = [36, 50];
    vs[1].range = [60, 80];
    expect(liveTargets(vs, [55], S())).toEqual([43, 67]);
  });
});

describe('moves', () => {
  it('glide, stagger and order come from the settings; every move ends together', () => {
    const vs = holding([48, 52, 55, 60]);
    const s = S({ glide: 0.5, stagger: 0.2, order: 'low-first' });
    const moves = liveMoves(vs, [60, 64, 67, 72], s, 1);
    expect(moves).toHaveLength(4);
    const byVoice = new Map(moves.map((m) => [m.voice, m]));
    const starts = [0, 1, 2, 3].map((i) => byVoice.get(i)!.delay);
    for (let i = 1; i < 4; i++) expect(starts[i]).toBeGreaterThan(starts[i - 1]); // low first
    for (const m of moves) expect(m.delay + m.dur).toBeCloseTo(starts[3] + 0.5, 12);
    expect(starts[3]).toBeLessThan(0.2);
    const high = liveMoves(vs, [60, 64, 67, 72], { ...s, order: 'high-first' }, 1);
    const hs = new Map(high.map((m) => [m.voice, m.delay]));
    expect(hs.get(3)!).toBeLessThan(hs.get(0)!);
  });

  it('voices already at (or heading to) their target do not move', () => {
    const vs = holding([60, 64]);
    vs[1].gliding = true;
    vs[1].velocity = 4;
    vs[1].pitch = 62;
    const moves = liveMoves(vs, [60, 64], S(), 1);
    expect(moves).toEqual([]);
  });

  it('under ordered, a staggered fan-out that would cross adopts one timing', () => {
    // Low voice starts first and would overtake the high one, still holding at 62.
    const vs = holding([60, 62]);
    const s = S({ glide: 1, stagger: 0.6, order: 'low-first' });
    const moves = liveMoves(vs, [70, 72], s, 5);
    const [a, b] = [moves.find((m) => m.voice === 0)!, moves.find((m) => m.voice === 1)!];
    expect(a.delay).toBe(b.delay);
    expect(a.dur).toBe(b.dur);
    const free = liveMoves(vs, [70, 72], { ...s, assign: 'free' }, 5);
    expect(free.find((m) => m.voice === 0)!.delay).toBeLessThan(
      free.find((m) => m.voice === 1)!.delay,
    );
  });
});

describe('liveUpdate: silence and release', () => {
  const vs = holding([60, 60, 60]);

  it('from silence, every voice steps to its target and the level ramps up', () => {
    const u = liveUpdate(view(vs, 0, 0), [64], S(), 1);
    expect(u.level).toEqual({ gain: 1, over: LIVE_ATTACK });
    expect(u.moves.map((m) => [m.dur, m.p1, m.delay])).toEqual([
      [0, 64, 0],
      [0, 64, 0],
      [0, 64, 0],
    ]);
  });

  it('while sounding, the voices glide; a fading level ramps back up', () => {
    const u = liveUpdate(view(vs), [64], S(), 1);
    expect(u.level).toBeNull();
    expect(u.moves.every((m) => m.dur === 0.25 && m.p1 === 64)).toBe(true);
    const fading = liveUpdate(view(vs, 0.4, 0), [64], S(), 1);
    expect(fading.level).toEqual({ gain: 1, over: LIVE_ATTACK });
    expect(fading.moves.every((m) => m.dur === 0.25)).toBe(true);
  });

  it('release hold keeps everything', () => {
    expect(liveUpdate(view(vs), [], S(), 1)).toMatchObject({ moves: [], level: null });
  });

  it('release fade ramps the level to 0', () => {
    const s = S({ release: 'fade', releaseFade: 0.8 });
    expect(liveUpdate(view(vs), [], s, 1)).toMatchObject({
      moves: [],
      level: { gain: 0, over: 0.8 },
    });
    expect(liveUpdate(view(vs, 0, 0), [], s, 1)).toMatchObject({ moves: [], level: null });
  });

  it('release tonic glides to the tonic nearest the voices', () => {
    const s = S({ release: 'tonic', key: { tonic: 'D', scale: 'major' } });
    const u = liveUpdate(view(holding([57, 60, 64])), [], s, 1);
    expect(u.level).toBeNull();
    expect(u.moves.map((m) => m.p1)).toEqual([62, 62, 62]);
    const oct = liveUpdate(view(holding([45, 64, 76])), [], { ...s, single: 'octaves' }, 1);
    expect(oct.moves.map((m) => m.p1).sort((a, b) => a - b)).toEqual([50, 62, 74]);
  });
});

describe('a chord pressed key by key re-targets smoothly', () => {
  /** Applies one update's moves at time t to per-voice segment chains. */
  function apply(chains: Segment[][], moves: LiveMove[], vs: LiveVoiceView[], t: number): void {
    for (const m of moves) {
      const v = vs.find((x) => x.index === m.voice)!;
      const m0 = v.gliding ? m.scale * (v.velocity * m.dur) : 0; // smootherstep: e′(0) = 0
      const seg: Segment = { t0: t, t1: t + m.dur, p0: v.pitch, p1: m.p1, ease: m.ease };
      if (m0 !== 0) seg.m0 = m0;
      chains[m.voice].push(seg);
    }
  }
  const at = (chain: Segment[], t: number): Segment =>
    [...chain].reverse().find((s) => s.t0 <= t) ?? chain[0];

  // Re-targets 5 ms apart outside a press (decideLive merges real presses): the compiler's rules,
  // so the overshoot clamp may drop carried velocity (limit 0 between lines from one note), but
  // every join is continuous in pitch and the chord ends in order.
  it('re-targets 5 ms apart: continuous, ending on the chord in order', () => {
    const n = 6;
    const chains: Segment[][] = Array.from({ length: n }, () => [
      { t0: 0, t1: Infinity, p0: 55, p1: 55, ease: 'smootherstep' },
    ]);
    const s = S({ glide: 0.3 });
    const held: number[] = [];
    let joins = 0;
    for (const [k, key] of [60, 64, 67].entries()) {
      const t = 1 + 0.005 * k;
      held.push(key);
      const vs: LiveVoiceView[] = chains.map((c, i) => {
        const seg = at(c, t);
        const gliding = t < seg.t1 && seg.p0 !== seg.p1;
        return {
          index: i,
          id: `v${i + 1}`,
          range: [36, 84],
          pitch: evalSegment(seg, t),
          velocity: gliding ? evalSegmentVelocity(seg, t) : 0,
          gliding,
          dest: c[c.length - 1].p1,
          seg: { ...seg, t0: seg.t0 - t, t1: seg.t1 - t },
        };
      });
      const u = liveUpdate(view(vs), held, s, 1);
      apply(chains, u.moves, vs, t);
      for (const m of u.moves) {
        const v = vs[m.voice];
        if (!v.gliding) continue;
        joins++;
        const next = chains[m.voice][chains[m.voice].length - 1];
        expect(evalSegment(next, t)).toBe(v.pitch);
      }
    }
    expect(joins).toBeGreaterThan(0);
    // Everyone ends on the chord, and no two paths cross after the last key.
    const ends = chains.map((c) => c[c.length - 1].p1);
    expect(new Set(ends)).toEqual(new Set([60, 64, 67]));
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let sign = 0;
        for (let t = 1.01; t < 1.5; t += 0.002) {
          const d = evalSegment(at(chains[i], t), t) - evalSegment(at(chains[j], t), t);
          const sg = d > 1e-6 ? 1 : d < -1e-6 ? -1 : 0;
          if (sg !== 0 && sign !== 0) expect(sg).toBe(sign);
          if (sg !== 0) sign = sg;
        }
      }
    }
  });
});

describe('held set: sustain, all off', () => {
  it('keys and the pedal', () => {
    const k = new LiveKeys();
    expect(k.noteOn(60)).toBe(true);
    expect(k.noteOn(60)).toBe(false);
    expect(k.noteOn(64)).toBe(true);
    expect(k.held).toEqual([60, 64]);
    expect(k.setSustain(true)).toBe(false);
    expect(k.noteOff(60)).toBe(false); // held by the pedal
    expect(k.held).toEqual([60, 64]);
    expect(k.noteOn(60)).toBe(false); // re-pressed while sustained: still held
    expect(k.noteOff(60)).toBe(false);
    expect(k.setSustain(false)).toBe(true);
    expect(k.held).toEqual([64]);
    expect(k.noteOff(64)).toBe(true);
    expect(k.held).toEqual([]);
    k.noteOn(70);
    k.setSustain(true);
    expect(k.allOff()).toBe(true);
    expect(k.sustain).toBe(false);
    expect(k.held).toEqual([]);
  });
});

describe('bend and mod wheel', () => {
  it('bend is ±range semitones, clamped', () => {
    expect(bendFromMidi(8192)).toBe(0);
    expect(bendFromMidi(16383)).toBe(2);
    expect(bendFromMidi(0)).toBe(-2);
    expect(bendFromMidi(12288)).toBeCloseTo(1, 3);
    expect(bendFromMidi(16383, 12)).toBe(12);
    expect(clampBend(5, 2)).toBe(2);
    expect(clampBend(-5, 2)).toBe(-2);
    expect(clampBend(Number.NaN, 2)).toBe(0);
  });

  it('CC1 sets the glide length exponentially', () => {
    expect(glideFromModWheel(0)).toBeCloseTo(MOD_GLIDE_MIN, 12);
    expect(glideFromModWheel(127)).toBeCloseTo(MOD_GLIDE_MAX, 12);
    const mid = glideFromModWheel(63.5);
    expect(mid).toBeCloseTo(Math.sqrt(MOD_GLIDE_MIN * MOD_GLIDE_MAX), 9);
    for (let c = 1; c <= 127; c++)
      expect(glideFromModWheel(c)).toBeGreaterThan(glideFromModWheel(c - 1));
  });
});
