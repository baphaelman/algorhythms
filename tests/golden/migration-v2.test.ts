/**
 * Schema v1 → v2 (M4.5-27, "the start is a moment"): every example sounds as it did.
 *
 * `V1_AUDIBLE` pins `audibleJson` hashes computed with the version 1 compiler (main 6783fd9, before
 * this change) on the version 1 files. The examples on disk are now version 2 (their `start` is
 * the opening chord at t = 0); compiled, they must hash the same. R9-2 (revision 9: splits and
 * merges honour stagger and order) re-pinned the five originals; the compositions are unchanged. Seeds-4 re-pinned seven-doors (a newborn forks 35 ms earlier). The rev 9 composition rewrite
 * replaced the three compositions on disk (parts, tune, pulse, land), so they are no longer checked
 * against their version 1 sound; the v1 Kite Day fixture still is. The full golden hashes changed
 * only by what is not heard: the opening's moment span, its harmony entry (the HUD now names the
 * opening chord) and the opening holds' `momentId`.
 *
 * tests/golden/v1/ keeps two files as they were in version 1: one original (a plain start) and
 * one composition (a start out of pitch order: `byVoice`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../src/core/compiler/compile';
import { parsePiece } from '../../src/core/schema';
import { audibleJson, canonicalJson, hashString } from './canonical';

const ROOT = join(import.meta.dirname, '../..');
const V1 = join(import.meta.dirname, 'v1');

const V1_AUDIBLE: Record<string, string> = {
  'clockwork-heron.algorhythms.json': 'cdbd03aafc4cb9da',
  'lanterns-over-salt-flats.algorhythms.json': '02bacdc7c4b1ee45',
  'seven-doors-in-fog.algorhythms.json': 'ab5b1b312ff8a477',
  'the-cartographers-rain.algorhythms.json': 'f7880deb9770c50c',
  'tidewater-hymn.algorhythms.json': '2dcf9f4ab6ca22a6',
};

/** Compositions as written in version 1, before the rev 9 rewrite (kept in tests/golden/v1). */
const V1_COMPOSITIONS: Record<string, string> = {
  'kite-day.algorhythms.json': 'c89cab9187e3dffb',
};

const examplePath = (f: string): string => join(ROOT, 'examples', f);

function load(path: string) {
  const r = parsePiece(readFileSync(path, 'utf8'));
  if (!r.ok) throw new Error(`${path}: ${r.errors.join('; ')}`);
  return r;
}

describe('schema v1 → v2', () => {
  it('covers the five originals', () => {
    const originals = readdirSync(join(ROOT, 'examples')).filter((f) => f.endsWith('.json'));
    expect(originals.sort()).toEqual(Object.keys(V1_AUDIBLE).sort());
  });

  for (const [f, hash] of Object.entries(V1_AUDIBLE)) {
    it(`${f}: is version 2 on disk and sounds as in version 1`, () => {
      const raw = JSON.parse(readFileSync(examplePath(f), 'utf8')) as Record<string, unknown>;
      expect(raw.version).toBe(2);
      expect(raw).not.toHaveProperty('start');
      const r = load(examplePath(f));
      expect(r.migratedFrom).toBeUndefined();
      const m = r.piece.moments[0];
      expect(m).toMatchObject({ id: 'start0', type: 'chord', at: 0 });
      expect(hashString(audibleJson(compile(r.piece)))).toBe(hash);
    });
  }

  for (const f of readdirSync(V1).sort()) {
    if (f in V1_COMPOSITIONS) {
      it(`v1 fixture ${f}: migrates and sounds as in version 1`, () => {
        const v1 = load(join(V1, f));
        expect(v1.migratedFrom).toBe(1);
        expect(v1.warnings).toEqual([]);
        expect(v1.piece.moments[0]).toMatchObject({ id: 'start0', type: 'chord', at: 0 });
        expect(hashString(audibleJson(compile(v1.piece)))).toBe(V1_COMPOSITIONS[f]);
      });
      continue;
    }
    it(`v1 fixture ${f}: migrates to the file on disk, same compiled score`, () => {
      const v1 = load(join(V1, f));
      expect(v1.migratedFrom).toBe(1);
      expect(v1.warnings).toEqual([]);
      const v2 = load(examplePath(f));
      expect(v1.piece).toEqual(v2.piece);
      const a = compile(v1.piece);
      expect(hashString(canonicalJson(a))).toBe(hashString(canonicalJson(compile(v2.piece))));
      expect(hashString(audibleJson(a))).toBe(V1_AUDIBLE[f]);
    });
  }

  it('a start out of pitch order or of later pool voices keeps each voice on its own pitch', () => {
    const r = load(join(V1, 'kite-day.algorhythms.json'));
    expect(r.piece.moments[0]).toMatchObject({ byVoice: true });
    expect(r.piece.moments[0].target).toBeUndefined();
    const json = {
      format: 'algorhythms',
      version: 1,
      voices: ['a', 'b', 'c'].map((id) => ({ id, range: [30, 90] })),
      start: [
        { voice: 'c', pitch: 50 },
        { voice: 'a', pitch: 70 },
      ],
    };
    const p = parsePiece(json);
    if (!p.ok) throw new Error(p.errors.join('; '));
    expect(p.piece.moments).toEqual([
      {
        id: 'start0',
        type: 'chord',
        at: 0,
        notes: { kind: 'pitches', pitches: [50, 70] },
        voicing: 'even',
        assign: 'ordered',
        target: { voices: ['c', 'a'] },
        byVoice: true,
      },
    ]);
    const s = compile(p.piece);
    expect(s.voices.map((v) => v.segments[0]?.p0 ?? null)).toEqual([70, null, 50]);
    expect(s.voices.map((v) => v.lives.map((l) => [l.born, l.fadeIn]))).toEqual([
      [[0, 0]],
      [],
      [[0, 0]],
    ]);
  });

  it('an empty start migrates to no moment (the piece begins silent); ids stay unique', () => {
    const silent = parsePiece({ format: 'algorhythms', version: 1, start: [] });
    expect(silent.ok && silent.piece.moments).toEqual([]);
    const taken = parsePiece({
      format: 'algorhythms',
      version: 1,
      start: [{ voice: 'v1', pitch: 57 }],
      moments: [{ id: 'start0', type: 'key', at: 3, key: { tonic: 'D', scale: 'major' } }],
    });
    expect(taken.ok && taken.piece.moments.map((m) => m.id)).toEqual(['start1', 'start0']);
  });
});
