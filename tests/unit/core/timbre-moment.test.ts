/**
 * The `timbre` moment (PLAN.md §6.3, §7.9 timbre timeline, §15 M6): it writes the targeted
 * voices' timbre timelines, silent voices included, and changes nothing else.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile, compileWithTrace } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { cloneJson } from '../../../src/core/defaults';
import { momentEffectAt } from '../../../src/core/effect';
import { flatten, unflatten } from '../../../src/core/flat';
import { chordAt } from '../../../src/core/query';
import { parsePiece, serializePiece, stripDefaults } from '../../../src/core/schema';
import { TIMBRE_PRESET, TIMBRE_STRIDE } from '../../../src/core/segment';
import { BUILTIN_TIMBRES } from '../../../src/core/timbres';
import type {
  CompiledScore,
  Moment,
  Piece,
  TimbreChange,
  TimbreMoment,
} from '../../../src/core/types';
import { piece, type MomentInput } from './compiler-fixtures';

const EXAMPLES = join(import.meta.dirname, '../../../examples');

function examples(): Piece[] {
  return readdirSync(EXAMPLES)
    .filter((f) => f.endsWith('.algorhythms.json'))
    .sort()
    .map((f) => {
      const r = parsePiece(JSON.parse(readFileSync(join(EXAMPLES, f), 'utf8')));
      if (!r.ok) throw new Error(f);
      return r.piece;
    });
}

const timbre = (at: number, preset: string, extra: Partial<TimbreMoment> = {}): MomentInput => ({
  type: 'timbre',
  at,
  preset,
  fade: 2,
  ...extra,
});

/** A 4-voice pool, two sounding (v1, v2) from 0. */
const four = (moments: MomentInput[]): Piece =>
  piece({ pool: 4, start: [50, 60], moments, end: { at: 20, fade: 2 } });

const diagsOf = (s: CompiledScore, id: string) =>
  s.diagnostics.filter((d) => d.momentId === id).map((d) => [d.level, d.code]);

const initial = (preset = 'glass'): TimbreChange => ({ t: 0, preset, fade: 0 });

/** `p` with `extra` appended (the other moments keep their indices, so their event order). */
const withMoments = (p: Piece, extra: Moment[]): Piece => ({
  ...p,
  moments: [...p.moments, ...extra],
});

/** Everything a score holds except timbre: pitch paths, lives, levels, harmony, keys, … */
function withoutTimbre(s: CompiledScore, ids: ReadonlySet<string>) {
  return {
    ...s,
    voices: s.voices.map((v) => ({ ...v, timbre: undefined })),
    momentSpans: s.momentSpans.filter((x) => !ids.has(x.id)),
    diagnostics: s.diagnostics.filter((d) => d.momentId === undefined || !ids.has(d.momentId)),
  };
}

describe('timbre moment: compile', () => {
  it('appends { t, preset, fade } to every voice, silent ones included', () => {
    const s = compile(four([timbre(5, 'bell')]));
    for (const v of s.voices)
      expect(v.timbre).toEqual([initial(), { t: 5, preset: 'bell', fade: 2 }]);
    expect(s.voices[3].lives).toEqual([]);
    expect(s.momentSpans).toContainEqual({ id: 'm0', start: 5, end: 7 });
    expect(diagsOf(s, 'm0')).toEqual([]);
  });

  it('a voice born after the change starts on the new timbre', () => {
    const s = compile(
      four([timbre(2, 'reed', { fade: 0 }), { type: 'split', at: 6, count: 4, voicing: 'even' }]),
    );
    const born = s.voices.filter((v) => v.lives.length > 0 && v.lives[0].born >= 6);
    expect(born.length).toBeGreaterThan(0);
    for (const v of born) expect(v.timbre).toEqual([initial(), { t: 2, preset: 'reed', fade: 0 }]);
  });

  it('targets voices, parts and ranks', () => {
    const p = four([
      timbre(3, 'bell', { id: 'tv', target: { voices: ['v2', 'v4'] } }),
      timbre(4, 'reed', { id: 'tp', target: { part: 'Bass' } }),
      timbre(5, 'sine', { id: 'tr', target: { rank: [1, 1] } }),
    ]);
    p.voices[0].part = 'Bass';
    p.voices[2].part = 'Bass';
    const s = compile(p);
    const presets = s.voices.map((v) => v.timbre.map((c) => `${c.t}:${c.preset}`));
    expect(presets).toEqual([
      ['0:glass', '4:reed'],
      ['0:glass', '3:bell', '5:sine'], // v2 is the higher of the two sounding voices
      ['0:glass', '4:reed'], // silent, in part Bass
      ['0:glass', '3:bell'], // silent, named
    ]);
    for (const id of ['tv', 'tp', 'tr']) expect(diagsOf(s, id)).toEqual([]);
  });

  it('warns about unknown voices and parts', () => {
    const s = compile(
      four([
        timbre(3, 'bell', { id: 'tv', target: { voices: ['v2', 'nope'] } }),
        timbre(4, 'bell', { id: 'tp', target: { part: 'Nope' } }),
      ]),
    );
    expect(diagsOf(s, 'tv')).toEqual([['warn', 'unknown-voice']]);
    expect(diagsOf(s, 'tp')).toEqual([
      ['warn', 'unknown-part'],
      ['info', 'no-targets'],
    ]);
    expect(s.voices[1].timbre).toEqual([initial(), { t: 3, preset: 'bell', fade: 2 }]);
  });

  it('skips an unknown preset with a warning; a piece timbre is known', () => {
    const p = four([timbre(3, 'nope', { id: 'tu' }), timbre(4, 'mine', { id: 'tm' })]);
    p.timbres.mine = cloneJson(BUILTIN_TIMBRES.organ);
    const s = compile(p);
    expect(diagsOf(s, 'tu')).toEqual([['warn', 'unknown-timbre']]);
    expect(s.momentSpans.map((x) => x.id)).not.toContain('tu');
    expect(diagsOf(s, 'tm')).toEqual([]);
    for (const v of s.voices)
      expect(v.timbre).toEqual([initial(), { t: 4, preset: 'mine', fade: 2 }]);
    // Object.prototype names are not timbres.
    expect(diagsOf(compile(four([timbre(3, 'toString', { id: 'tx' })])), 'tx')).toEqual([
      ['warn', 'unknown-timbre'],
    ]);
  });

  it('refuses a missing preset', () => {
    const bad = { type: 'timbre', at: 3, fade: 1 } as unknown as MomentInput;
    const s = compile(four([{ ...bad, id: 'tb' }]));
    expect(diagsOf(s, 'tb')).toEqual([['error', 'invalid-moment']]);
    for (const v of s.voices) expect(v.timbre).toEqual([initial()]);
  });

  it('clamps the fade at 0', () => {
    for (const fade of [-1, NaN, Infinity]) {
      const s = compile(four([timbre(3, 'bell', { fade })]));
      expect(s.voices[0].timbre[1]).toEqual({ t: 3, preset: 'bell', fade: 0 });
      expect(s.momentSpans).toContainEqual({ id: 'm0', start: 3, end: 3 });
    }
  });

  it('a change to the timbre in effect is a no-effect and adds no entry', () => {
    const s = compile(
      four([
        timbre(2, 'glass', { id: 'same' }),
        timbre(4, 'bell', { id: 'b1' }),
        timbre(6, 'bell', { id: 'b2', target: { voices: ['v1'] } }),
        timbre(8, 'glass', { id: 'back', target: { voices: ['v1'] } }),
      ]),
    );
    expect(diagsOf(s, 'same')).toEqual([['info', 'no-effect']]);
    expect(s.diagnostics.find((d) => d.momentId === 'same')?.message).toBe(
      'No effect: the notes already have this timbre.',
    );
    expect(diagsOf(s, 'b1')).toEqual([]);
    expect(diagsOf(s, 'b2')).toEqual([['info', 'no-effect']]);
    expect(diagsOf(s, 'back')).toEqual([]);
    expect(s.voices[0].timbre).toEqual([
      initial(),
      { t: 4, preset: 'bell', fade: 2 },
      { t: 8, preset: 'glass', fade: 2 },
    ]);
    expect(s.voices[1].timbre).toEqual([initial(), { t: 4, preset: 'bell', fade: 2 }]);
  });

  it('of two changes at one time the later wins; the initial entry stays', () => {
    const s = compile(
      four([
        timbre(0, 'bell', { id: 'a', fade: 1 }),
        timbre(0, 'reed', { id: 'b', fade: 3 }),
        timbre(5, 'sine', { id: 'c' }),
        timbre(5, 'glass', { id: 'd', target: { voices: ['v1'] } }),
      ]),
    );
    expect(s.voices[0].timbre).toEqual([
      initial(),
      { t: 0, preset: 'reed', fade: 3 },
      { t: 5, preset: 'glass', fade: 2 },
    ]);
    expect(s.voices[1].timbre).toEqual([
      initial(),
      { t: 0, preset: 'reed', fade: 3 },
      { t: 5, preset: 'sine', fade: 2 },
    ]);
    // Back to the preset before both: no entry at that time.
    const back = compile(four([timbre(3, 'bell'), timbre(3, 'glass')]));
    expect(back.voices[0].timbre).toEqual([initial()]);
  });

  it('reads the VoiceDef timbre for the first entry and the no-effect check', () => {
    const p = four([timbre(3, 'reed', { id: 'r' })]);
    p.voices[1].timbre = 'reed';
    const s = compile(p);
    expect(s.voices[1].timbre).toEqual([initial('reed')]);
    expect(s.voices[0].timbre).toEqual([initial(), { t: 3, preset: 'reed', fade: 2 }]);
    expect(diagsOf(s, 'r')).toEqual([]);
    p.voices.forEach((v) => (v.timbre = 'reed'));
    expect(diagsOf(compile(p), 'r')).toEqual([['info', 'no-effect']]);
  });

  it('ignores land: it acts at its time', () => {
    const p = four([timbre(5, 'bell', { glide: { land: true, length: 2 } })]);
    p.defaults.glide.land = true;
    const s = compile(p);
    expect(s.voices[0].timbre[1].t).toBe(5);
  });

  it('acts only before the end', () => {
    const s = compile(four([timbre(20, 'bell', { id: 'late' })]));
    expect(diagsOf(s, 'late')).toEqual([['info', 'after-end']]);
    expect(s.voices[0].timbre).toEqual([initial()]);
  });

  it('traces its targets', () => {
    const { trace } = compileWithTrace(four([timbre(3, 'bell', { target: { voices: ['v3'] } })]));
    const t = trace.moments.find((m) => m.id === 'm0');
    expect(t).toMatchObject({ type: 'timbre', t: 3, targeted: [2], subset: true, plan: null });
  });
});

describe('timbre moment: no pitch effect', () => {
  it('leaves every example’s pitch, levels, lives, harmony and keys as they were', () => {
    for (const p of examples()) {
      const before = compile(p);
      const d = before.duration;
      const extra: Moment[] = [
        { id: 'tm0001', type: 'timbre', at: 0, preset: 'bell', fade: 0 },
        { id: 'tm0002', type: 'timbre', at: d * 0.3, preset: 'reed', fade: 3 },
        {
          id: 'tm0003',
          type: 'timbre',
          at: d * 0.5,
          preset: 'pluck',
          fade: 1,
          target: { rank: [0, 1] },
        },
        { id: 'tm0004', type: 'timbre', at: d * 0.6, preset: 'sine', fade: 2 },
      ];
      const ids = new Set(extra.map((m) => m.id));
      const after = compile(withMoments(p, extra));
      expect(withoutTimbre(after, ids), p.meta.title).toStrictEqual(withoutTimbre(before, ids));
      for (let t = 0; t < d; t += d / 97) {
        expect(chordAt(after, t)).toStrictEqual(chordAt(before, t));
      }
      expect(after.voices.some((v) => v.timbre.length > 1)).toBe(true);
    }
  });

  it('with parts, merges and splits around it', () => {
    const p = piece({
      pool: 6,
      start: [48, 55, 60],
      moments: [
        { type: 'merge', at: 2, count: 2, which: 'top', fade: 1 },
        timbre(2, 'bell', { id: 'x1' }),
        { type: 'split', at: 5, count: 5, voicing: 'even' },
        timbre(5.5, 'reed', { id: 'x2', target: { part: 'A' } }),
        {
          type: 'chord',
          at: 9,
          notes: { kind: 'chord', symbol: 'Am7' },
          voicing: 'even',
          assign: 'ordered',
        },
        timbre(9, 'organ', { id: 'x3', target: { rank: [0, 0] } }),
      ],
    });
    p.voices.forEach((v, i) => (v.part = i % 2 === 0 ? 'A' : 'B'));
    const ids = new Set(['x1', 'x2', 'x3']);
    const without = { ...p, moments: p.moments.filter((m) => !ids.has(m.id)) };
    expect(withoutTimbre(compile(p), ids)).toStrictEqual(withoutTimbre(compile(without), ids));
  });
});

describe('timbre moment: flat layout', () => {
  it('round-trips through flatten, with moment presets in timbreNames', () => {
    const p = four([timbre(3, 'bell'), timbre(6, 'mine', { target: { voices: ['v2'] } })]);
    p.timbres.mine = cloneJson(BUILTIN_TIMBRES.reed);
    const s = compile(p);
    const flat = flatten(s);
    expect(flat.timbreNames).toEqual(['glass', 'bell', 'mine']);
    const v2 = flat.voices[1].timbres;
    expect(v2.length).toBe(3 * TIMBRE_STRIDE);
    expect([0, 1, 2].map((k) => v2[k * TIMBRE_STRIDE + TIMBRE_PRESET])).toEqual([0, 1, 2]);
    expect(unflatten(flat).voices.map((v) => v.timbre)).toEqual(s.voices.map((v) => v.timbre));
  });
});

describe('timbre moment: incremental compile', () => {
  it('equals a full compile through timbre edits, voice timbre and piece timbre changes', () => {
    const base = examples()[0];
    const d = compile(base).duration;
    const inc = createIncrementalCompiler();
    let p = base;
    const check = (): void => {
      expect(structuredClone(inc.compile(p))).toStrictEqual(structuredClone(compile(p)));
    };
    check();
    const tm = (id: string, at: number, preset: string): Moment =>
      ({ id, type: 'timbre', at, preset, fade: 2 }) as Moment;
    p = withMoments(p, [tm('tm0001', d * 0.2, 'bell'), tm('tm0002', d * 0.7, 'mine')]);
    check();
    // The custom timbre appears: tm0002 becomes valid, from a checkpoint after it too.
    p = { ...p, timbres: { ...p.timbres, mine: cloneJson(BUILTIN_TIMBRES.organ) } };
    check();
    expect(inc.stats.mode).toBe('full');
    p = withMoments(p, [tm('tm0003', d * 0.9, 'sine')]);
    check();
    expect(inc.stats.mode).toBe('resume');
    // Preset and time edits.
    p = {
      ...p,
      moments: p.moments.map((m) =>
        m.id === 'tm0001' ? ({ ...m, preset: 'reed', at: m.at + 1 } as Moment) : m,
      ),
    };
    check();
    // A voice's own timbre (read fresh): tm0001 becomes a no-effect on every voice.
    p = { ...p, voices: p.voices.map((v) => ({ ...v, timbre: 'reed' })) };
    check();
    expect(inc.stats.mode).toBe('resume');
    expect(inc.compile(p).diagnostics).toContainEqual(
      expect.objectContaining({ momentId: 'tm0001', code: 'no-effect' }),
    );
    // Editing a timbre's sound keeps the names: resumes.
    p = { ...p, timbres: { ...p.timbres, mine: cloneJson(BUILTIN_TIMBRES.pluck) } };
    check();
    expect(inc.stats.mode).toBe('resume');
    // The custom timbre goes: tm0002 is skipped again.
    const rest = { ...p.timbres };
    delete rest.mine;
    p = { ...p, timbres: rest };
    check();
    expect(inc.stats.mode).toBe('full');
    expect(inc.compile(p).diagnostics).toContainEqual(
      expect.objectContaining({ momentId: 'tm0002', code: 'unknown-timbre' }),
    );
  });
});

describe('timbre moment: file format', () => {
  const HEAD = { format: 'algorhythms', version: 2 } as const;

  it('fills the fade, round-trips, and strips the default', () => {
    const r = parsePiece({
      ...HEAD,
      moments: [{ id: 't1', type: 'timbre', at: 3, preset: 'bell' }],
    });
    if (!r.ok) throw new Error(r.errors.join('\n'));
    expect(r.piece.moments[0]).toEqual({
      id: 't1',
      type: 'timbre',
      at: 3,
      preset: 'bell',
      fade: 2,
    });
    const again = parsePiece(serializePiece(r.piece));
    expect(again.ok && again.piece).toEqual(r.piece);
    expect(stripDefaults(r.piece).moments).toEqual([
      { type: 'timbre', id: 't1', at: 3, preset: 'bell' },
    ]);
  });

  it('keeps an unknown preset name (the compiler reports it) and rounds the fade to 1 ms', () => {
    const r = parsePiece({
      ...HEAD,
      moments: [{ id: 't1', type: 'timbre', at: 3, preset: 'nope', fade: 1.23456 }],
    });
    expect(r.ok && r.piece.moments[0]).toMatchObject({ preset: 'nope', fade: 1.235 });
  });

  it('refuses a missing or empty preset and a negative fade', () => {
    for (const m of [
      { id: 't1', type: 'timbre', at: 3 },
      { id: 't1', type: 'timbre', at: 3, preset: '' },
      { id: 't1', type: 'timbre', at: 3, preset: 'bell', fade: -1 },
    ]) {
      expect(parsePiece({ ...HEAD, moments: [m] }).ok, JSON.stringify(m)).toBe(false);
    }
  });
});

describe('timbre moment: palette effect', () => {
  it('has an effect where some targeted voice has another timbre, silent or not', () => {
    const p = four([timbre(4, 'bell', { target: { voices: ['v4'] } })]);
    const s = compile(p);
    const at = (t: number, preset: string, target?: TimbreMoment['target']): Moment =>
      ({
        id: 'new',
        type: 'timbre',
        at: t,
        preset,
        fade: 2,
        ...(target ? { target } : {}),
      }) as Moment;
    expect(momentEffectAt(p, s, at(1, 'bell'))).toEqual({ effect: true });
    expect(momentEffectAt(p, s, at(1, 'glass'))).toEqual({
      effect: false,
      reason: 'the notes already have this timbre',
    });
    expect(momentEffectAt(p, s, at(5, 'bell', { voices: ['v4'] })).effect).toBe(false);
    expect(momentEffectAt(p, s, at(3, 'bell', { voices: ['v4'] })).effect).toBe(true);
    expect(momentEffectAt(p, s, at(5, 'bell', { part: 'Nope' }))).toEqual({
      effect: false,
      reason: 'it targets no note',
    });
  });
});
