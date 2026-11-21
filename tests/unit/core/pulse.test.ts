/**
 * R9-3a (PLAN §6.2 `pulse`, revision 9): per-voice pulse records, the reference envelope, modes,
 * targets, births and deaths mid-pulse, incremental = full, and the flat layout.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { momentEffectAt } from '../../../src/core/effect';
import { flatten, unflatten, PULSE_STRIDE } from '../../../src/core/flat';
import { pulseBreaks, pulseGainAt, nextPulseIndex } from '../../../src/core/pulse';
import { lifeAt, pitchAt } from '../../../src/core/query';
import { parsePiece } from '../../../src/core/schema';
import { pulseEnvelope } from '../../../src/core/segment';
import type { CompiledScore, Piece, PulseMoment, PulseRecord } from '../../../src/core/types';
import { piece, type MomentInput } from './compiler-fixtures';

const GLIDE = { length: 1, jitter: 0, stagger: 0, ease: 'smootherstep' as const };
const START = [48, 55, 60, 64];

type PulseInput = Omit<PulseMoment, 'id' | 'type' | 'at' | 'until'> & {
  at?: number;
  until?: number;
};

function pulse(fields: Partial<PulseInput> = {}): MomentInput {
  return {
    type: 'pulse',
    at: 2,
    until: 6,
    step: 0.5,
    pattern: [1],
    decay: 0.3,
    floor: 0.2,
    mode: 'together',
    ...fields,
  } as MomentInput;
}

function make(moments: MomentInput[], start: number[] = START, pool = 8): Piece {
  return piece({ pool, start, glide: GLIDE, end: { at: 12, fade: 1 }, moments });
}

const hits = (s: CompiledScore, v: number): PulseRecord[] =>
  (s.voices[v].pulse ?? []).filter((r) => r.hit);

/** For each step time that hits one voice, that voice (pool index). */
function hitVoices(s: CompiledScore): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = [];
  s.voices.forEach((cv, v) => {
    for (const r of cv.pulse ?? []) if (r.hit) out.push({ t: r.t, v });
  });
  return out.sort((a, b) => a.t - b.t);
}

describe('pulse envelope', () => {
  it('jumps to the accent and falls cubically to floor × accent', () => {
    expect(pulseEnvelope(0.8, 0.25, 0.4, 0)).toBe(0.8);
    expect(pulseEnvelope(0.8, 0.25, 0.4, 0.2)).toBeCloseTo(0.8 * (0.25 + 0.75 * 0.125), 15);
    expect(pulseEnvelope(0.8, 0.25, 0.4, 0.4)).toBe(0.2);
    expect(pulseEnvelope(0.8, 0.25, 0.4, 9)).toBe(0.2);
    expect(pulseEnvelope(0.8, 0.25, 0, 0)).toBe(0.2);
    expect(pulseEnvelope(0.8, 0.25, 0.4, -1)).toBe(0.8);
  });

  it('nextPulseIndex walks up, down and up-down', () => {
    const seq = (mode: 'up' | 'down' | 'updown', n: number, k: number): number[] => {
      let w = { index: -1, dir: 1 };
      const out: number[] = [];
      for (let i = 0; i < k; i++) out.push((w = nextPulseIndex(mode, n, w)).index);
      return out;
    };
    expect(seq('up', 3, 7)).toEqual([0, 1, 2, 0, 1, 2, 0]);
    expect(seq('down', 3, 7)).toEqual([2, 1, 0, 2, 1, 0, 2]);
    expect(seq('updown', 4, 9)).toEqual([0, 1, 2, 3, 2, 1, 0, 1, 2]);
    expect(seq('updown', 1, 3)).toEqual([0, 0, 0]);
  });
});

describe('pulse: together', () => {
  const s = compile(make([pulse()]));

  it('hits every sounding targeted voice on each step and sits at the floor', () => {
    for (let v = 0; v < 4; v++) {
      expect(hits(s, v).map((r) => r.t)).toEqual([2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5]);
      const r = s.voices[v].pulse!;
      // Boundary at the floor, eight hits, boundary back to 1.
      expect(r[0]).toEqual({ t: 2, accent: 1, decay: 0, floor: 0.2, strike: false });
      expect(r[r.length - 1]).toEqual({ t: 6, accent: 1, decay: 0, floor: 1, strike: false });
    }
    for (let v = 4; v < 8; v++) expect(s.voices[v].pulse).toBeUndefined();
    const v0 = s.voices[0];
    expect(pulseGainAt(v0, 1.9)).toBe(1);
    expect(pulseGainAt(v0, 2)).toBe(1);
    expect(pulseGainAt(v0, 2.15)).toBeCloseTo(0.2 + 0.8 * 0.125, 12);
    expect(pulseGainAt(v0, 2.4)).toBeCloseTo(0.2, 15);
    expect(pulseGainAt(v0, 5.99)).toBeCloseTo(0.2, 15);
    expect(pulseGainAt(v0, 6)).toBe(1);
  });

  it('strikes by default; strike: false does not', () => {
    expect(hits(s, 0).every((r) => r.strike)).toBe(true);
    const q = compile(make([pulse({ strike: false })]));
    expect(hits(q, 0).length).toBe(8);
    expect(hits(q, 0).some((r) => r.strike)).toBe(false);
  });

  it('carries floor and decay, and cycles the pattern (0 is a rest)', () => {
    const q = compile(make([pulse({ pattern: [1, 0.5, 0], floor: 0.1, decay: 0.2 })]));
    const h = hits(q, 2);
    expect(h.map((r) => [r.t, r.accent])).toEqual([
      [2, 1],
      [2.5, 0.5],
      [3.5, 1],
      [4, 0.5],
      [5, 1],
      [5.5, 0.5],
    ]);
    expect(h.every((r) => r.floor === 0.1 && r.decay === 0.2)).toBe(true);
    // The rest at 3: still decayed to floor × 0.5 from the hit at 2.5.
    expect(pulseGainAt(q.voices[2], 3.2)).toBeCloseTo(0.05, 15);
  });

  it('adds pulse breaks at records and uncut decay ends', () => {
    const b = pulseBreaks(s.voices[0]);
    expect(b.slice(0, 4)).toEqual([2, 2, 2.3, 2.5]);
    expect(b[b.length - 1]).toBe(6);
  });

  it('changes no pitch and leaves the level timeline alone', () => {
    const plain = compile(make([]));
    const lv = compile(make([pulse(), { type: 'level', at: 3, gain: 0.5, over: 1 }]));
    for (let v = 0; v < 8; v++) {
      expect(s.voices[v].segments).toEqual(plain.voices[v].segments);
      expect(lv.voices[v].level).toEqual(v < 4 ? [{ t: 3, gain: 0.5, over: 1 }] : []);
    }
    expect(lv.voices[0].pulse).toEqual(s.voices[0].pulse);
  });
});

describe('pulse: one voice per step', () => {
  it('up, down and updown walk the pitch order', () => {
    const order = (mode: PulseMoment['mode']): number[] =>
      hitVoices(compile(make([pulse({ mode, until: 6 })]))).map((h) => h.v);
    expect(order('up')).toEqual([0, 1, 2, 3, 0, 1, 2, 3]);
    expect(order('down')).toEqual([3, 2, 1, 0, 3, 2, 1, 0]);
    expect(order('updown')).toEqual([0, 1, 2, 3, 2, 1, 0, 1]);
  });

  it('random is seeded: deterministic, one sounding voice per step, varies with the seed', () => {
    const a = hitVoices(compile(make([pulse({ mode: 'random', until: 10 })])));
    const b = hitVoices(compile(make([pulse({ mode: 'random', until: 10 })])));
    expect(a).toEqual(b);
    expect(a.length).toBe(16);
    expect(new Set(a.map((h) => h.t)).size).toBe(16);
    expect(a.every((h) => h.v < 4)).toBe(true);
    expect(new Set(a.map((h) => h.v)).size).toBeGreaterThan(1);
    const c = hitVoices(compile(make([pulse({ mode: 'random', until: 10, seed: 99 })])));
    expect(c.map((h) => h.v)).not.toEqual(a.map((h) => h.v));
  });

  it('follows the pitch order at each step over a gliding, crossing chord', () => {
    // v1 (48) pins up through the others to 70 between 3 and 5.
    const p = make([
      pulse({ mode: 'up', until: 8, step: 0.25 }),
      { type: 'pin', at: 3, voice: 'v1', pitch: 70, glide: { length: 2 } },
    ]);
    const s = compile(p);
    const hv = hitVoices(s);
    expect(hv.length).toBe(24);
    hv.forEach((h, j) => {
      const sounding = [0, 1, 2, 3].sort(
        (a, b) => pitchAt(s.voices[a], h.t)! - pitchAt(s.voices[b], h.t)! || a - b,
      );
      expect(sounding.indexOf(h.v), `step at ${h.t}`).toBe(j % 4);
    });
    // After the pin v1 is the top line, so it is hit fourth.
    expect(
      hv
        .filter((h) => h.t >= 5)
        .map((h) => h.v)
        .slice(0, 4),
    ).toEqual([1, 2, 3, 0]);
  });
});

describe('pulse: births and deaths mid-pulse', () => {
  it('a newborn sits at the floor from its birth and joins the walk', () => {
    const p = make([
      pulse({ mode: 'up', until: 9 }),
      { type: 'split', at: 3.2, count: 6, voicing: 'even' },
    ]);
    const s = compile(p);
    const born = [4, 5].map((v) => s.voices[v]);
    for (const v of born) {
      const b = v.lives[0].born;
      expect(v.pulse![0]).toEqual({ t: b, accent: 1, decay: 0, floor: 0.2, strike: false });
      expect(pulseGainAt(v, b)).toBe(0.2);
    }
    // Later steps walk six voices.
    const late = hitVoices(s).filter((h) => h.t >= 5);
    expect(new Set(late.map((h) => h.v)).size).toBe(6);
    const together = compile(make([pulse({ until: 9 }), p.moments[2]]));
    expect(hits(together, 4).length).toBeGreaterThan(0);
  });

  it('a dying voice leaves the walk and keeps its last envelope', () => {
    const s = compile(
      make([pulse({ until: 9 }), { type: 'merge', at: 3.1, count: 2, which: 'top', fade: 1 }]),
    );
    const dead = [2, 3];
    for (const v of dead) {
      expect(hits(s, v).every((r) => r.t <= 3)).toBe(true);
      expect(s.voices[v].lives[0].died).toBeDefined();
    }
    for (const v of [0, 1]) expect(hits(s, v).length).toBe(14);
  });
});

describe('pulse: targets, overlaps and diagnostics', () => {
  it('a { part } target pulses that part only', () => {
    const p = make([pulse({ target: { part: 'Top' } })]);
    p.voices[3].part = 'Top';
    p.voices[2].part = 'Top';
    const s = compile(p);
    expect([0, 1, 2, 3].map((v) => hits(s, v).length)).toEqual([0, 0, 8, 8]);
  });

  it('the later pulse drives a voice; the earlier one takes it back when it ends', () => {
    const s = compile(
      make([
        pulse({ until: 8, floor: 0.2 }),
        pulse({ at: 3, until: 4, floor: 0.5, decay: 0.1, target: { voices: ['v1'] }, step: 0.25 }),
      ]),
    );
    const v0 = s.voices[0];
    expect(pulseGainAt(v0, 3.2)).toBeCloseTo(0.5, 15);
    expect(
      hits(s, 0)
        .filter((r) => r.t >= 3 && r.t < 4)
        .map((r) => r.t),
    ).toEqual([3, 3.25, 3.5, 3.75]);
    // Handed back at 4 (floor 0.2), hit again at 4.5.
    expect(pulseGainAt(v0, 4.2)).toBeCloseTo(0.2, 15);
    expect(pulseGainAt(v0, 4.5)).toBe(1);
    expect(pulseGainAt(v0, 4.85)).toBeCloseTo(0.2, 15);
    expect(pulseGainAt(s.voices[1], 3.4)).toBeCloseTo(0.2, 15);
  });

  it('reports invalid pulses and no-effect', () => {
    const codes = (m: MomentInput): string[] =>
      compile(make([m]))
        .diagnostics.filter((d) => d.momentId === 'm0')
        .map((d) => d.code);
    expect(codes(pulse({ until: 2 }))).toEqual(['pulse-invalid']);
    expect(codes(pulse({ step: 0 }))).toEqual(['pulse-invalid']);
    expect(codes(pulse({ pattern: [] }))).toEqual(['pulse-invalid']);
    expect(codes(pulse({ target: { voices: ['v8'] } }))).toEqual(['no-effect']);
    expect(codes(pulse())).toEqual([]);
    const silent = piece({
      pool: 4,
      start: [],
      glide: GLIDE,
      end: { at: 12, fade: 1 },
      moments: [pulse()],
    });
    const d = compile(silent).diagnostics.find((x) => x.momentId === 'm0');
    expect(d?.code).toBe('no-effect');
  });

  it('the schema fills defaults and rejects an empty pattern, step ≤ 0 or accents > 1', () => {
    const base = make([]);
    const raw = (m: object): unknown => ({
      ...base,
      moments: [...base.moments, { id: 'p1', type: 'pulse', at: 1, until: 3, ...m }],
    });
    const ok = parsePiece(raw({}));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.piece.moments[1]).toMatchObject({
        step: 0.5,
        pattern: [1],
        decay: 0.3,
        floor: 0,
        mode: 'together',
      });
      expect('strike' in ok.piece.moments[1]).toBe(false);
    }
    expect(parsePiece(raw({ pattern: [] })).ok).toBe(false);
    expect(parsePiece(raw({ step: 0 })).ok).toBe(false);
    expect(parsePiece(raw({ pattern: [1.5] })).ok).toBe(false);
    expect(parsePiece(raw({ mode: 'sideways' })).ok).toBe(false);
  });

  it('the palette sees a pulse as having an effect over sounding notes', () => {
    const p = make([]);
    const s = compile(p);
    expect(momentEffectAt(p, s, { id: 'x', ...pulse() } as PulseMoment).effect).toBe(true);
    expect(
      momentEffectAt(p, s, { id: 'x', ...pulse({ target: { voices: ['v8'] } }) } as PulseMoment)
        .effect,
    ).toBe(false);
  });
});

describe('pulse: incremental compile and flat layout', () => {
  it('incremental equals full across edits inside the pulse region', () => {
    const p = make([
      {
        type: 'chord',
        at: 1,
        notes: { kind: 'pitches', pitches: [50, 57, 62, 65] },
        voicing: 'even',
        assign: 'ordered',
      },
      pulse({ mode: 'updown', until: 10, step: 0.25 }),
      { type: 'shift', at: 3, by: 2, unit: 'semitones' },
      { type: 'split', at: 5, count: 6, voicing: 'even' },
      { type: 'merge', at: 7, count: 3, which: 'top', fade: 0.5 },
      pulse({ at: 8, until: 9, mode: 'random', target: { rank: [0, 1] } }),
    ]);
    const inc = createIncrementalCompiler();
    expect(inc.compile(p)).toEqual(compile(p));
    const edits: ((q: Piece) => void)[] = [
      (q) => (q.moments[3].at = 4),
      (q) => ((q.moments[2] as PulseMoment).pattern = [1, 0.3]),
      (q) => ((q.moments[6] as PulseMoment).until = 9.5),
      (q) => (q.moments[4].at = 6.1),
      (q) => ((q.moments[2] as PulseMoment).mode = 'down'),
    ];
    let q = p;
    for (const e of edits) {
      q = structuredClone(q);
      e(q);
      expect(inc.compile(q)).toEqual(compile(q));
    }
    expect(inc.stats.mode).toBe('resume');
  });

  it('round-trips pulse records through the flat layout', () => {
    const s = compile(make([pulse({ mode: 'up', strike: false }), pulse({ at: 7, until: 8 })]));
    const f = flatten(s);
    expect(f.voices[0].pulses.length).toBe(s.voices[0].pulse!.length * PULSE_STRIDE);
    expect(f.voices[7].pulses.length).toBe(0);
    const u = unflatten(f);
    s.voices.forEach((v, i) => expect(u.voices[i].pulse).toEqual(v.pulse));
  });

  it('hits only sounding voices', () => {
    const s = compile(make([pulse()]));
    for (const cv of s.voices)
      for (const r of cv.pulse ?? []) if (r.hit) expect(lifeAt(cv, r.t)).not.toBeNull();
  });
});
