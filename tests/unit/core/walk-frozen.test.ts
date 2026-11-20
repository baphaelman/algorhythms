/**
 * Frozen walks (PLAN.md §6.2 revision 5) and `walkSteps` (§7.9).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { patchMoment } from '../../../src/app/editor/ops';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { freezeWalk } from '../../../src/core/moments/walk';
import { pitchAt } from '../../../src/core/query';
import { parsePiece, serializePiece } from '../../../src/core/schema';
import { stepByScale } from '../../../src/core/scales';
import type { CompiledScore, Piece, WalkMoment, WalkNote } from '../../../src/core/types';
import { piece, type MomentInput } from './compiler-fixtures';

const EXAMPLES = join(import.meta.dirname, '../../../examples');

const walk = (extra: Partial<WalkMoment> = {}): MomentInput =>
  ({
    id: 'w',
    type: 'walk',
    at: 1,
    until: 15,
    grid: 0.5,
    density: 0.7,
    steps: [-2, -1, 1, 2],
    stepGlide: 0.3,
    ...extra,
  }) as MomentInput;

const base = (moments: MomentInput[] = [walk()]): Piece =>
  piece({
    start: [50, 57, 62, 69],
    glide: { length: 2, jitter: 0, stagger: 0 },
    moments,
  });

/** Sets walk `id`'s `fixed`. */
const withFixed = (p: Piece, id: string, fixed: WalkNote[] | undefined): Piece => ({
  ...p,
  moments: p.moments.map((m) => (m.id === id ? ({ ...m, fixed } as WalkMoment) : m)),
});

const freezeAll = (p: Piece, s: CompiledScore): Piece => {
  let out = p;
  for (const m of p.moments) if (m.type === 'walk') out = withFixed(out, m.id, freezeWalk(s, m.id));
  return out;
};

const codes = (s: CompiledScore) => s.diagnostics.map((d) => `${d.level}:${d.code}`);

describe('walkSteps', () => {
  it('lists every step a generated walk takes, sorted by t, matching its segments', () => {
    const s = compile(base());
    const steps = s.walkSteps.filter((w) => w.momentId === 'w');
    expect(steps.length).toBeGreaterThan(20);
    for (let i = 1; i < s.walkSteps.length; i++)
      expect(s.walkSteps[i].t).toBeGreaterThanOrEqual(s.walkSteps[i - 1].t);
    for (const st of steps) {
      expect(st.fixed).toBe(false);
      expect(st.to).not.toBe(st.from);
      expect(st.t).toBeCloseTo(1 + st.tick * 0.5, 12);
      const v = s.voices.find((x) => x.id === st.voice)!;
      const seg = v.segments.find((g) => g.t0 === st.t && g.momentId === 'w');
      expect(seg?.p1).toBe(st.to);
    }
    const segs = s.voices.flatMap((v) => v.segments).filter((g) => g.momentId === 'w');
    expect(segs.length).toBe(steps.length);
  });
});

describe('frozen walks', () => {
  it('a frozen snapshot sounds exactly like the generated walk', () => {
    const p = base([
      walk(),
      {
        type: 'chord',
        at: 6,
        notes: { kind: 'chord', symbol: 'Dm7' },
        voicing: 'nearest',
        assign: 'ordered',
      } as MomentInput,
      walk({ id: 'w2', at: 9, until: 13, density: 1, target: { rank: [0, 1] } }),
    ]);
    const s = compile(p);
    const f = compile(freezeAll(p, s));
    expect(f.voices).toStrictEqual(s.voices);
    expect(f.momentSpans).toStrictEqual(s.momentSpans);
    expect(f.diagnostics).toStrictEqual(s.diagnostics);
    expect(f.walkSteps.map((x) => ({ ...x, fixed: false }))).toStrictEqual(s.walkSteps);
    expect(f.walkSteps.every((x) => x.fixed)).toBe(true);
  });

  it('freezing every walk of every example keeps its sound', () => {
    let walks = 0;
    for (const f of readdirSync(EXAMPLES).filter((x) => x.endsWith('.algorhythms.json'))) {
      const r = parsePiece(readFileSync(join(EXAMPLES, f), 'utf8'));
      if (!r.ok) throw new Error(f);
      const s = compile(r.piece);
      walks += r.piece.moments.filter((m) => m.type === 'walk').length;
      expect(compile(freezeAll(r.piece, s)).voices, f).toStrictEqual(s.voices);
    }
    expect(walks).toBeGreaterThan(0);
  });

  it('draws nothing: seed, density and steps are ignored', () => {
    const p = base();
    const fixed = freezeWalk(compile(p), 'w');
    const a = compile(withFixed(p, 'w', fixed));
    const q = withFixed({ ...p, seed: p.seed + 1 }, 'w', fixed);
    (q.moments[0] as WalkMoment).density = 0.1;
    (q.moments[0] as WalkMoment).steps = [5];
    expect(compile(q).voices).toStrictEqual(a.voices);
  });

  it('moving one fixed note changes only that note', () => {
    const p = base();
    const fixed = freezeWalk(compile(p), 'w');
    const s0 = compile(withFixed(p, 'w', fixed));
    // A middle note of the top voice (no neighbour above), one scale step up.
    const j = fixed.findIndex((n, i) => i > fixed.length / 2 && n.voice === p.voices[3].id);
    const moved = fixed.map((n, i) =>
      i === j ? { ...n, pitch: stepByScale(n.pitch, 1, p.key) } : n,
    );
    const s1 = compile(withFixed(p, 'w', moved));
    expect(codes(s1)).toEqual(codes(s0));
    const diff = s1.walkSteps.filter(
      (x, i) => x.to !== s0.walkSteps[i].to || x.from !== s0.walkSteps[i].from,
    );
    // The moved note, and the next note of that voice, whose start pitch changed.
    expect(diff.map((x) => x.voice)).toEqual(diff.map(() => fixed[j].voice));
    expect(diff[0].tick).toBe(fixed[j].tick);
    expect(diff[0].to).toBe(moved[j].pitch);
    expect(diff.length).toBeLessThanOrEqual(2);
    // Every other voice sounds the same.
    for (let v = 0; v < 3; v++) expect(s1.voices[v]).toStrictEqual(s0.voices[v]);
    // Later notes of the moved voice keep their pitch.
    const later = s1.walkSteps.filter((x) => x.voice === fixed[j].voice && x.tick > fixed[j].tick);
    for (const x of later) {
      const n = fixed.find((y) => y.voice === x.voice && y.tick === x.tick)!;
      expect(x.to).toBe(n.pitch);
    }
  });

  it('earlier edits do not reshape a frozen walk; voices glide to its notes', () => {
    const p = base();
    const fixed = freezeWalk(compile(p), 'w');
    const frozen = withFixed(p, 'w', fixed);
    // A short shift before the walk moves every voice; the walk's notes stay put.
    const edited: Piece = {
      ...frozen,
      moments: [
        { id: 's', type: 'shift', at: 0, by: 2, unit: 'semitones', glide: { length: 0.4 } },
        ...frozen.moments,
      ],
    };
    const s = compile(edited);
    expect(s.diagnostics.filter((d) => d.level !== 'info')).toEqual([]);
    // Each voice's pitch right after its last fixed note equals that note.
    for (const v of edited.voices.slice(0, 4)) {
      const notes = fixed.filter((n) => n.voice === v.id);
      const n = notes[notes.length - 1];
      const voice = s.voices.find((x) => x.id === v.id)!;
      expect(pitchAt(voice, 1 + n.tick * 0.5 + 0.31)).toBeCloseTo(n.pitch, 9);
    }
    // Every fixed note is applied as written.
    const byKey = new Map(s.walkSteps.map((x) => [`${x.tick}/${x.voice}`, x.to]));
    for (const n of fixed) expect(byKey.get(`${n.tick}/${n.voice}`)).toBe(n.pitch);
  });

  it('a blocked note holds with a warn; out-of-range too', () => {
    const p = base();
    // Tick 2: the second voice (57) tries to land on the third's pitch (62); the first leaves range.
    const fixed: WalkNote[] = [
      { tick: 2, voice: p.voices[1].id, pitch: 62 },
      { tick: 2, voice: p.voices[0].id, pitch: 20 },
      { tick: 2, voice: p.voices[3].id, pitch: 71 },
      { tick: 3, voice: p.voices[1].id, pitch: 59 },
    ];
    const s = compile(withFixed(p, 'w', fixed));
    expect(codes(s)).toEqual(['warn:walk-note-blocked']);
    expect(s.diagnostics[0].momentId).toBe('w');
    const at = (tick: number, i: number) =>
      s.walkSteps.find((x) => x.tick === tick && x.voice === p.voices[i].id)!;
    expect(at(2, 1)).toMatchObject({ from: 57, to: 57, fixed: true });
    expect(at(2, 0)).toMatchObject({ from: 50, to: 50 });
    expect(at(2, 3)).toMatchObject({ from: 69, to: 71 });
    expect(at(3, 1)).toMatchObject({ from: 57, to: 59 });
    expect(s.walkSteps.length).toBe(4);
    // Unlisted voices hold.
    expect(s.voices[2].segments.filter((g) => g.momentId === 'w')).toEqual([]);
  });

  it('a swap of two neighbours is blocked; a hold is listed with from === to', () => {
    const p = base();
    const s = compile(
      withFixed(p, 'w', [
        { tick: 0, voice: p.voices[1].id, pitch: 64 },
        { tick: 0, voice: p.voices[2].id, pitch: 55 },
        { tick: 1, voice: p.voices[0].id, pitch: 50 },
      ]),
    );
    expect(codes(s)).toEqual(['warn:walk-note-blocked']);
    expect(s.walkSteps.map((x) => [x.tick, x.from, x.to])).toEqual([
      [0, 57, 57],
      [0, 62, 62],
      [1, 50, 50],
    ]);
  });

  it('notes on inactive voices or past `until` are ignored with info', () => {
    const p = base();
    const s = compile(
      withFixed(p, 'w', [
        { tick: 1, voice: p.voices[6].id, pitch: 60 }, // dormant voice
        { tick: 28, voice: p.voices[0].id, pitch: 52 }, // at = 1 + 14 = 15 = until
        { tick: 1, voice: p.voices[0].id, pitch: 52 },
      ]),
    );
    expect(codes(s).sort()).toEqual(['info:walk-note-ignored', 'info:walk-note-ignored']);
    expect(s.diagnostics.every((d) => d.momentId === 'w')).toBe(true);
    expect(s.walkSteps.map((x) => [x.tick, x.voice, x.to])).toEqual([[1, p.voices[0].id, 52]]);
    expect(s.voices[6].lives).toEqual([]);
  });

  it('an empty `fixed` freezes the walk into holding', () => {
    const s = compile(withFixed(base(), 'w', []));
    expect(s.walkSteps).toEqual([]);
    expect(s.voices.flatMap((v) => v.segments).filter((g) => g.momentId === 'w')).toEqual([]);
  });

  it('incremental compile gives the same walkSteps as a full compile', () => {
    const p = base([
      {
        type: 'chord',
        at: 0.5,
        notes: { kind: 'chord', symbol: 'C' },
        voicing: 'nearest',
        assign: 'ordered',
      } as MomentInput,
      walk(),
      { type: 'shift', at: 4, by: 1, unit: 'scaleSteps', glide: { length: 0.4 } } as MomentInput,
      walk({ id: 'w2', at: 16, until: 24 }),
      { type: 'shift', at: 20, by: -1, unit: 'scaleSteps' } as MomentInput,
    ]);
    const inc = createIncrementalCompiler();
    expect(inc.compile(p)).toStrictEqual(compile(p));
    const s = compile(p);
    const edits: Piece[] = [
      withFixed(p, 'w2', freezeWalk(s, 'w2')),
      patchMoment(withFixed(p, 'w2', freezeWalk(s, 'w2')), 'm4', { by: -2 } as never),
      withFixed(p, 'w', freezeWalk(s, 'w')),
      patchMoment(withFixed(p, 'w', freezeWalk(s, 'w')), 'm2', { by: 2 } as never),
      withFixed(p, 'w2', undefined),
      p,
    ];
    let resumed = 0;
    for (const q of edits) {
      expect(inc.compile(q)).toStrictEqual(compile(q));
      if (inc.stats.mode === 'resume') resumed++;
    }
    expect(resumed).toBeGreaterThan(0);
  });
});

describe('frozen walks in the file format', () => {
  it('round-trips `fixed` through save and load, sorted by tick', () => {
    const p = base();
    const fixed = freezeWalk(compile(p), 'w').reverse();
    const r = parsePiece(serializePiece(withFixed(p, 'w', fixed)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const got = (r.piece.moments[0] as WalkMoment).fixed!;
    expect(got.map((n) => n.tick)).toEqual([...got.map((n) => n.tick)].sort((a, b) => a - b));
    expect(new Set(got.map((n) => JSON.stringify(n)))).toEqual(
      new Set(fixed.map((n) => JSON.stringify(n))),
    );
    const again = parsePiece(serializePiece(r.piece));
    expect(again.ok && again.piece).toStrictEqual(r.piece);
    expect(compile(r.piece).voices).toStrictEqual(compile(p).voices);
  });

  it('honours a fractional tick (a step added between ticks)', () => {
    const p0 = base();
    const s0 = compile(p0);
    const fixed = freezeWalk(s0, 'w');
    const v = p0.voices[1].id;
    // A tick where voice 1 holds, a quarter grid past an integer tick.
    const holds = (k: number) =>
      !s0.walkSteps.some((x) => x.voice === v && Math.abs(x.tick - k) < 1.6);
    let k = 2.25;
    while (!holds(k)) k += 1;
    const t = 1 + k * 0.5;
    const from = pitchAt(s0.voices[1], t)!;
    const target = stepByScale(from, 1, p0.key);
    const s = compile(withFixed(p0, 'w', [...fixed, { tick: k, voice: v, pitch: target }]));
    const rec = s.walkSteps.find((x) => x.tick === k && x.voice === v);
    expect(rec).toMatchObject({ t, from, to: target, fixed: true });
    expect(pitchAt(s.voices[1], t + 0.31)).toBeCloseTo(target, 9);
    expect(s.walkSteps.length).toBe(s0.walkSteps.length + 1);
  });

  it('rejects bad ticks, unknown voices and duplicate (tick, voice) notes', () => {
    const p = base();
    const v = p.voices[0].id;
    const bad = (fixed: unknown[]) => parsePiece(withFixed(p, 'w', fixed as WalkNote[])).ok;
    expect(bad([{ tick: 1, voice: v, pitch: 60 }])).toBe(true);
    expect(bad([{ tick: -1, voice: v, pitch: 60 }])).toBe(false);
    expect(bad([{ tick: 1.5, voice: v, pitch: 60 }])).toBe(true); // between ticks (M4.5-20)
    expect(bad([{ tick: 1, voice: 'nobody', pitch: 60 }])).toBe(false);
    expect(
      bad([
        { tick: 1, voice: v, pitch: 60 },
        { tick: 1, voice: v, pitch: 61 },
      ]),
    ).toBe(false);
  });
});
