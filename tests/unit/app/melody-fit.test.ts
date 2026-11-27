/** Melodies that fit the chords and re-fit when they change (M10b-5; app/editor/melody-fit.ts). */
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  g.document = { title: '', querySelector: () => null };
  g.location = { hash: '', pathname: '/', search: '' };
  g.history = { replaceState: () => undefined };
  g.requestAnimationFrame = (cb: (t: number) => void) => {
    cb(0);
    return 0;
  };
});
vi.mock('../../../src/app/audio', () => {
  const ok = () => Promise.resolve({});
  return {
    configureAudio: () => undefined,
    getEngine: () => null,
    loadAudio: ok,
    mixAudio: ok,
    primeAudio: ok,
    resumeAudio: () => undefined,
    swapAudio: ok,
    whenReady: ok,
  };
});

import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import { mod } from '../../../src/core/math';
import { pitchAt } from '../../../src/core/query';
import { parsePiece, serializePiece } from '../../../src/core/schema';
import type {
  ChordMoment,
  CompiledScore,
  Moment,
  Piece,
  TuneMoment,
  TuneNote,
} from '../../../src/core/types';
import { edit, undo, useEditor } from '../../../src/app/editor/history';
import { fitTune, refitTunes } from '../../../src/app/editor/melody-fit';
import { defaultMoment } from '../../../src/app/editor/new-moment';
import { patchMoment } from '../../../src/app/editor/ops';
import { tuneNoteStarts } from '../../../src/app/editor/tune';
import { likeTheVideo } from '../../../src/app/editor/video-template';
import { loadPiece, usePlayer } from '../../../src/app/store';

const BEAT = 0.75; // 80 bpm
const BAR = 4 * BEAT;
const C_MAJOR = [0, 2, 4, 5, 7, 9, 11];

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

/** I–vi–IV–V in C at 80 bpm, a bar each, and an empty tune over all four bars. */
function base(): Piece {
  const p = newPiece({ seed: 7, poolSize: 6 });
  for (const v of p.voices) v.range = [36, 96];
  p.key = { tonic: 'C', scale: 'major' };
  p.view = { ...p.view, gridBpm: 80, meter: 4 };
  p.moments = [
    chord('c1', 0, 'I'),
    chord('c2', BAR, 'vi'),
    chord('c3', 2 * BAR, 'IV'),
    chord('c4', 3 * BAR, 'V'),
    { id: 'tune01', type: 'tune', at: 0, line: 'high', notes: [{ pitch: 72, len: 4 * BAR }] },
  ];
  return p;
}

const fitted = (): Piece => fitTune(base(), 'tune01', 12345);
const tuneOf = (p: Piece): TuneMoment => p.moments.find((m) => m.id === 'tune01') as TuneMoment;
const withChord = (p: Piece, id: string, symbol: string): Piece =>
  patchMoment(p, id, { notes: { kind: 'chord', symbol } } as Partial<Moment>);

/** The melody line's pitch shortly after each note's start, from the compiled score. */
function sounding(score: CompiledScore, m: TuneMoment): { t: number; pitch: number }[] {
  const v = score.voices.find((x) => x.segments.some((s) => s.momentId === m.id))!;
  return tuneNoteStarts(m)
    .slice(0, -1)
    .map((t, k) => ({ t, pitch: pitchAt(v, t + 0.6 * m.notes[k].len)! }));
}

/** The I–vi–IV–V chord tones at t (a bar each). */
const chordPcs = (t: number): number[] =>
  [
    [0, 4, 7],
    [9, 0, 4],
    [5, 9, 0],
    [7, 11, 2],
  ][Math.min(3, Math.floor(t / BAR + 1e-6))];

const strong = (t: number): boolean => {
  const b = t / BEAT;
  return Math.abs(b - Math.round(b)) < 1e-6 && Math.round(b) % 2 === 0;
};

describe('fitted melody over I–vi–IV–V (compiled score)', () => {
  it('sounds in key, on chord tones on strong beats, above the chords, with no merges', () => {
    const p = fitted();
    const m = tuneOf(p);
    expect(m.fit).toEqual({ seed: 12345 });
    const score = compile(p);
    expect(score.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
    const notes = sounding(score, m);
    expect(notes.length).toBeGreaterThan(8);
    let onStrong = 0;
    for (const { t, pitch } of notes) {
      expect(Number.isInteger(Math.round(pitch * 1000) / 1000)).toBe(true);
      expect(C_MAJOR).toContain(mod(Math.round(pitch), 12));
      if (!strong(t)) continue;
      onStrong++;
      expect(chordPcs(t), `t=${t}`).toContain(mod(Math.round(pitch), 12));
    }
    expect(onStrong).toBeGreaterThanOrEqual(8);
    // The chords keep their other lines: four lines sound through the melody.
    for (let t = 0.5; t < 4 * BAR; t += 0.5) {
      const lines = score.voices.filter((v) => pitchAt(v, t) !== null).length;
      expect(lines, `t=${t}`).toBe(4);
    }
  });

  it('the compiler ignores fit (same score with or without it)', () => {
    const p = fitted();
    const { fit: _, ...plain } = tuneOf(p);
    const q = { ...p, moments: p.moments.map((m) => (m.id === 'tune01' ? plain : m)) };
    expect(compile(q).voices).toEqual(compile(p).voices);
  });

  it('round-trips through the schema', () => {
    const p = fitted();
    const r = parsePiece(JSON.parse(serializePiece(p)));
    expect(r.ok).toBe(true);
    if (r.ok) expect(tuneOf(r.piece).fit).toEqual({ seed: 12345 });
  });
});

describe('refitTunes', () => {
  it('a chord edit under a fitted tune redraws it to fit the new chord', () => {
    const before = fitted();
    const after = refitTunes(before, withChord(before, 'c2', 'ii'));
    const m = tuneOf(after);
    expect(m.notes).not.toEqual(tuneOf(before).notes);
    expect(m.fit).toEqual({ seed: 12345 });
    for (const { t, pitch } of sounding(compile(after), m)) {
      if (t >= BAR - 1e-6 && t < 2 * BAR - 1e-6 && strong(t)) {
        expect([2, 5, 9]).toContain(mod(Math.round(pitch), 12));
      }
    }
  });

  it('a key change redraws it in the new key', () => {
    const before = fitted();
    const after = refitTunes(before, { ...before, key: { tonic: 'A', scale: 'minor' } });
    expect(tuneOf(after).notes).not.toEqual(tuneOf(before).notes);
  });

  it('edits that cannot change the harmony leave it alone', () => {
    const before = fitted();
    const level: Moment = { id: 'lev001', type: 'level', at: 2, gain: 0.5, over: 1 };
    const after = { ...before, moments: [...before.moments, level] };
    expect(refitTunes(before, after)).toBe(after);
    // An edit that changes nothing under the tune keeps the same notes.
    const moved = { ...before, moments: [...before.moments, chord('c5', 20, 'IV')] };
    expect(tuneOf(refitTunes(before, moved)).notes).toEqual(tuneOf(before).notes);
  });

  it('a hand edit of the notes drops fit; later chord edits leave the notes alone', () => {
    const before = fitted();
    const m = tuneOf(before);
    const notes: TuneNote[] = m.notes.map((n, i) =>
      i === 0 ? { pitch: n.pitch! + 2, len: n.len } : n,
    );
    const edited = refitTunes(before, patchMoment(before, 'tune01', { notes }));
    expect(tuneOf(edited).fit).toBeUndefined();
    expect(tuneOf(edited).notes).toEqual(notes);
    const later = refitTunes(edited, withChord(edited, 'c2', 'ii'));
    expect(tuneOf(later).notes).toEqual(notes);
  });

  it('a different line redraws instead of dropping fit', () => {
    const before = fitted();
    const after = refitTunes(before, patchMoment(before, 'tune01', { line: 'low' }));
    expect(tuneOf(after).fit).toEqual({ seed: 12345 });
    expect(tuneOf(after).notes).not.toEqual(tuneOf(before).notes);
  });
});

describe('re-fit in the edit path', () => {
  it('one undo entry: the chord edit and the melody; one undo restores both', () => {
    loadPiece(fitted());
    const start = usePlayer.getState().piece;
    expect(edit((p) => withChord(p, 'c2', 'ii'), 'Change chord')).toBe(true);
    const now = usePlayer.getState().piece;
    expect(tuneOf(now).notes).not.toEqual(tuneOf(start).notes);
    expect(useEditor.getState().undoLabel).toBe('Change chord');
    undo();
    const back = usePlayer.getState().piece;
    expect(tuneOf(back).notes).toEqual(tuneOf(start).notes);
    expect((back.moments.find((m) => m.id === 'c2') as ChordMoment).notes).toEqual({
      kind: 'chord',
      symbol: 'vi',
    });
    expect(useEditor.getState().canUndo).toBe(false);
  });
});

describe('Add → Melody default', () => {
  it('is fitted to the chord block at the add time, on the top line', () => {
    const p = base();
    p.moments = p.moments.filter((m) => m.id !== 'tune01');
    const s = compile(p);
    const m = defaultMoment('tune', BAR, 'zzzzzz', p, s);
    expect(m.fit).toBeDefined();
    expect(m.line).toBe('high');
    expect(m.notes.reduce((a, n) => a + n.len, 0)).toBeCloseTo(BAR, 6);
    const q = { ...p, moments: [...p.moments, m] };
    for (const { t, pitch } of sounding(compile(q), m)) {
      expect(C_MAJOR).toContain(mod(Math.round(pitch), 12));
      if (strong(t - BAR)) expect([9, 0, 4]).toContain(mod(Math.round(pitch), 12));
    }
  });
});

describe('"Like the video"', () => {
  it('six chord blocks and one Wander, no split, merge or unison; no diagnostics', () => {
    const p = likeTheVideo({ seed: 11 });
    expect(p.moments.filter((m) => m.type === 'chord')).toHaveLength(6);
    expect(p.moments.filter((m) => m.type === 'walk')).toHaveLength(1);
    expect(p.moments).toHaveLength(7);
    for (const t of ['split', 'merge', 'unison']) {
      expect(p.moments.some((m) => m.type === t)).toBe(false);
    }
    expect(compile(p).diagnostics).toEqual([]);
  });
});

describe('fitted melody over a lydian voicing (M13)', () => {
  it('avoids the notes a semitone above the held chord tones', () => {
    const p = newPiece({ seed: 7, poolSize: 6 });
    for (const v of p.voices) v.range = [36, 96];
    p.key = { tonic: 'Eb', scale: 'lydian' };
    p.view = { ...p.view, gridBpm: 80, meter: 4 };
    p.end = { at: 20, fade: 2 };
    p.moments = [
      {
        id: 'c1',
        type: 'chord',
        at: 0,
        notes: { kind: 'pitches', pitches: [51, 55, 62, 69, 74] },
        voicing: 'even',
        assign: 'ordered',
        count: 5,
      },
      { id: 'tune01', type: 'tune', at: 0, line: 'high', notes: [{ pitch: 79, len: 4 * BAR }] },
    ];
    // The top line plays the tune, so the other four hold.
    const held = [51, 55, 62, 69];
    for (const seed of [1, 2, 3, 4, 5, 12345]) {
      const m = tuneOf(fitTune(p, 'tune01', seed));
      const ts = tuneNoteStarts(m);
      m.notes.forEach((n, k) => {
        const q = n.pitch;
        if (q === undefined || !(strong(ts[k]) || n.len >= BEAT - 1e-6)) return;
        const rub = held.some((h) => mod(q - h, 12) === 1 && Math.abs(q - h) <= 13);
        expect(rub, `seed ${seed} note ${k} (${q})`).toBe(false);
      });
    }
  });
});
