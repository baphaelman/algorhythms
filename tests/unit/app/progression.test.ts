/**
 * PLAN rev 10 `progression` in the editor: typed chords, lane items (chord names, end drag),
 * Freeze into chord moments (same sound), the share codec, the palette, key carry and MIDI.
 */
import { describe, expect, it } from 'vitest';
import { freezeAll, canFreeze } from '../../../src/app/editor/freeze';
import { endDragPatch, laneItems } from '../../../src/app/editor/lane';
import { defaultMoment } from '../../../src/app/editor/new-moment';
import {
  formatProgressionText,
  freezeProgression,
  parseProgressionText,
  progressionEndDrag,
} from '../../../src/app/editor/progression';
import { PALETTE, momentTypeForKey } from '../../../src/app/editor/shortcuts';
import { decodeShareLink, encodeShareLink, packPiece } from '../../../src/app/share';
import { compile } from '../../../src/core/compiler/compile';
import { remapMoment } from '../../../src/core/transpose';
import { parsePiece } from '../../../src/core/schema';
import type { Piece, ProgressionMoment } from '../../../src/core/types';
import { exportMidi, PPQ } from '../../../src/midi/export';
import { piece } from '../core/compiler-fixtures';
import { parseSmf, reconstruct, tempoOf } from '../midi/smf-parser';

const C = { tonic: 'C', scale: 'major' } as const;

function withProg(chords: [string, number][], extra: Partial<ProgressionMoment> = {}): Piece {
  const p = piece({
    pool: 6,
    start: [48, 60, 64, 67],
    glide: { length: 0.5, stagger: 0, jitter: 0 },
    end: { at: 12, fade: 0.5 },
    key: C,
  });
  const m: ProgressionMoment = {
    id: 'pg',
    type: 'progression',
    at: 1,
    chords: chords.map(([notes, len]) => ({ notes, len })),
    voicing: 'even',
    assign: 'ordered',
    ...extra,
  };
  return { ...p, moments: [...p.moments, m] };
}

const rnd = (() => {
  let i = 0;
  return () => 0x1234567 + 7919 * i++;
})();

describe('typed chords', () => {
  it('parses lengths in beats, a missing length is the default, names errors by chord', () => {
    const beat = 0.5;
    const r = parseProgressionText('IV 2, V 2, iii, vi 1.5', beat, C, [], 3);
    expect(r).toEqual({
      ok: true,
      chords: [
        { notes: 'IV', len: 1 },
        { notes: 'V', len: 1 },
        { notes: 'iii', len: 3 },
        { notes: 'vi', len: 0.75 },
      ],
    });
    // Seconds without a tempo; a missing length is `defaultLen`.
    expect(parseProgressionText('Am, F 3', null, C, [], 2)).toEqual({
      ok: true,
      chords: [
        { notes: 'Am', len: 2 },
        { notes: 'F', len: 3 },
      ],
    });
    expect(parseProgressionText('', null, C)).toEqual({ ok: true, chords: [] });
    const bad = parseProgressionText('I 1, Xq 1', beat, C);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/^Chord 2: “Xq”/);
    const len = parseProgressionText('I 1, IV x', beat, C);
    expect(!len.ok && len.error).toMatch(/^Chord 2: “x” is not a length/);
    expect(parseProgressionText('I 1,, V 1', beat, C).ok).toBe(false);
  });

  it('formats as typed, and committing the shown text changes nothing', () => {
    const chords = [
      { notes: 'IV', len: 1 / 3 },
      { notes: 'V7', len: 1 },
    ];
    const text = formatProgressionText(chords, 0.5);
    expect(text).toBe('IV 0.667, V7 2');
    expect(parseProgressionText(text, 0.5, C, chords)).toEqual({ ok: true, chords });
  });
});

describe('lane', () => {
  it('one region bar with each chord name over its span; the end handle sets the last length', () => {
    const p = withProg([
      ['I', 1],
      ['IV', 1],
      ['V', 2],
    ]);
    const s = compile(p);
    const it = laneItems(p, s.momentSpans, undefined, s.harmony, s.voices, s.keys).find(
      (x) => x.id === 'pg',
    )!;
    expect(it.endEdit).toBe('chords');
    expect(it.start).toBeCloseTo(1, 6);
    expect(it.end).toBeCloseTo(5, 6);
    expect(it.art?.kind).toBe('progression');
    if (it.art?.kind !== 'progression') return;
    expect(it.art.chords.map((c) => c.name)).toEqual(['I · C', 'IV · F', 'V · G']);
    expect(it.art.chords.map((c) => Math.round(c.left))).toEqual([0, 25, 50]);
    expect(it.art.chords.map((c) => Math.round(c.width))).toEqual([25, 25, 50]);
    const m = p.moments.at(-1) as ProgressionMoment;
    expect(endDragPatch(m, p.defaults.glide, 0.5, false)).toEqual({
      chords: [m.chords[0], m.chords[1], { notes: 'V', len: 2.5 }],
    });
    expect(progressionEndDrag({ chords: [] }, 1)).toBeNull();
  });
});

describe('Freeze', () => {
  it('splits into chord moments that sound the same', () => {
    const p = withProg(
      [
        ['ii7', 2],
        ['V7', 2],
        ['I', 2],
      ],
      { glide: { stagger: 0.3, jitter: 0.4 }, count: 5, label: 'turn' },
    );
    const m = p.moments.at(-1)!;
    expect(canFreeze(m)).toBe(true);
    const f = freezeAll(p, ['pg'], compile, rnd);
    expect(f.moments.some((x) => x.id === 'pg')).toBe(false);
    const chords = f.moments.filter((x) => x.type === 'chord' && x.id !== 'start0');
    expect(chords.map((c) => c.at)).toEqual([1, 3, 5]);
    expect(chords[0].label).toBe('turn');
    const strip = (s: ReturnType<typeof compile>) =>
      s.voices.map((v) => ({ ...v, segments: v.segments.map(({ momentId: _, ...r }) => r) }));
    expect(strip(compile(f))).toEqual(strip(compile(p)));
  });

  it('keeps the progression’s place among moments at a chord’s time', () => {
    const p = withProg([
      ['I', 2],
      ['IV', 2],
    ]);
    p.moments.push({ id: 'k', type: 'key', at: 3, key: { tonic: 'D', scale: 'major' } });
    const f = freezeProgression(p, 'pg', rnd);
    const order = f.moments.map((x) => `${x.type}@${x.at}`);
    expect(order.slice(-3)).toEqual(['chord@1', 'chord@3', 'key@3']);
    expect(compile(f).harmony?.map((h) => h.label)).toEqual(
      compile(p).harmony?.map((h) => h.label),
    );
  });
});

describe('share, schema, palette, key carry', () => {
  it('round-trips through a share link with chords packed flat', async () => {
    const r = parsePiece(
      JSON.parse(
        JSON.stringify(
          withProg(
            [
              ['IV', 2],
              ['V/V', 1.5],
            ],
            { register: [50, 80] },
          ),
        ),
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const packed = packPiece(r.piece) as { moments: Record<string, unknown>[] };
    expect(packed.moments.at(-1)?.chords).toEqual(['IV', 2, 'V/V', 1.5]);
    const link = await encodeShareLink(r.piece, 'https://example.org/');
    expect(link).toContain('#p=2.');
    const back = parsePiece(await decodeShareLink(link));
    expect(back.ok && back.piece).toEqual(r.piece);
  });

  it('no progression on the palette (§6.4: typed into a chord block), and a default progression with an effect', () => {
    expect(PALETTE.find((e) => e.type === 'progression')).toBeUndefined();
    expect(
      momentTypeForKey({
        key: 'o',
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
      }),
    ).toBeNull();
    const keys = PALETTE.flatMap((e) => (e.key ? [e.key] : []));
    expect(new Set(keys).size).toBe(keys.length);
    const p = withProg([]);
    p.view = { ...p.view, gridBpm: 120, meter: 4 };
    const m = defaultMoment('progression', 2, 'x', p, compile(p));
    expect(m.chords.map((c) => c.notes)).toEqual(['I', 'vi', 'IV', 'V']);
    // The default spacing: glide 0.5 s + a bar (2 s), in whole beats.
    expect(m.chords.every((c) => c.len === 2.5)).toBe(true);
    // The key in effect at the insert time picks the chords: A dorian from 1 s.
    const d = withProg([['I', 8]]);
    d.moments.unshift({ id: 'k', type: 'key', at: 1, key: { tonic: 'A', scale: 'dorian' } });
    const md = defaultMoment('progression', 2, 'y', d, compile(d));
    expect(md.chords.map((c) => c.notes)).toEqual(['i', 'IV', '♭VII', 'i']);
    const m0 = defaultMoment('progression', 0.5, 'z', d, compile(d));
    expect(m0.chords.map((c) => c.notes)).toEqual(['I', 'vi', 'IV', 'V']);
  });

  it('key carry transposes letter chords and keeps numerals', () => {
    const p = withProg([
      ['C', 1],
      ['IV', 1],
      ['G/B', 1],
    ]);
    const m = p.moments.at(-1)!;
    const r = remapMoment(p, m, C, { tonic: 'D', scale: 'major' });
    expect((r.moment as ProgressionMoment).chords.map((c) => c.notes)).toEqual(['D', 'IV', 'A/C#']);
    expect(r.skipped).toBe(false);
    const minor = remapMoment(p, m, C, { tonic: 'A', scale: 'minor' });
    expect(minor.skipped).toBe(true);
  });
});

describe('MIDI', () => {
  it('each chord sounds as notes over its span', () => {
    const p = withProg([
      ['F', 2],
      ['G', 2],
      ['C', 2],
    ]);
    const file = exportMidi(compile(p), { mode: 'notesOnly' }).files[0];
    const smf = parseSmf(file.data);
    const tps = (PPQ * 1e6) / tempoOf(smf.tracks[0]);
    const sounding = (t: number): number[] => {
      const pcs = new Set<number>();
      for (const tr of smf.tracks.slice(1))
        for (const n of reconstruct(tr).notes)
          if (n.on / tps <= t && n.off / tps > t) pcs.add(n.note % 12);
      return [...pcs].sort((a, b) => a - b);
    };
    // Notes of each chord only (a held pitch may keep its earlier note), at least two of them.
    for (const [t, tones] of [
      [2.8, [0, 5, 9]],
      [4.8, [2, 7, 11]],
      [6.8, [0, 4, 7]],
    ] as const) {
      const pcs = sounding(t);
      expect(pcs.length).toBeGreaterThanOrEqual(2);
      expect(pcs.every((x) => (tones as readonly number[]).includes(x))).toBe(true);
    }
  });
});
