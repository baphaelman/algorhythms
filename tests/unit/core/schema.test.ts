/** Unit tests for core/schema.ts (PLAN.md §5). */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { renderFileFormatDoc } from '../../../scripts/file-format-doc';
import {
  DEFAULT_GLIDE,
  DEFAULT_MIX,
  DEFAULT_VIEW,
  MOMENT_DEFAULTS,
  cloneJson,
  newPiece,
} from '../../../src/core/defaults';
import { DEFAULT_MIGRATIONS, migrationRegistry } from '../../../src/core/migrations';
import {
  MOMENT_TYPES,
  PieceSchema,
  formatPath,
  parsePiece,
  serializePiece,
  type ParsePieceResult,
} from '../../../src/core/schema';
import type { Piece } from '../../../src/core/types';
import { fullPiece, injectUnknown } from './schema-fixtures';

/** Compile-time check: the schema's parsed output is the types.ts Piece (version aside). */
type Parsed = z.output<typeof PieceSchema>;
const _parsedIsPiece = (p: Parsed): Omit<Piece, 'version'> => p;
void _parsedIsPiece;

function ok(r: ParsePieceResult): Extract<ParsePieceResult, { ok: true }> {
  if (!r.ok) throw new Error(`expected ok, got errors:\n${r.errors.join('\n')}`);
  return r;
}

function errors(r: ParsePieceResult): string[] {
  if (r.ok) throw new Error('expected errors, got ok');
  return r.errors;
}

const MINIMAL = { format: 'algorhythms', version: 2 };

describe('parsePiece: defaults', () => {
  it('fills a minimal file to the full parsed form', () => {
    const { piece, warnings, newerVersion } = ok(parsePiece(MINIMAL));
    expect(warnings).toEqual([]);
    expect(newerVersion).toBe(false);
    expect(piece.meta).toEqual({
      title: 'Untitled',
      created: '1970-01-01T00:00:00.000Z',
      modified: '1970-01-01T00:00:00.000Z',
    });
    expect(piece.seed).toBe(0);
    expect(piece.tuning).toEqual({ referenceHz: 440, system: { kind: '12tet' } });
    expect(piece.key).toEqual({ tonic: 'A', scale: 'dorian' });
    expect(piece.defaults.glide).toEqual(DEFAULT_GLIDE);
    expect(piece.voices.map((v) => v.id)).toEqual(
      Array.from({ length: 12 }, (_, i) => `v${i + 1}`),
    );
    expect(piece.voices[0]).toEqual({
      id: 'v1',
      timbre: 'glass',
      pan: 'auto',
      gain: 1,
      range: [38, 84],
    });
    expect(piece).not.toHaveProperty('start');
    expect(piece.moments).toEqual([]);
    expect(piece.timbres).toEqual({});
    expect(piece.mix).toEqual(DEFAULT_MIX);
    expect(piece.end).toEqual({ fade: 6 });
    expect(piece.view).toEqual(DEFAULT_VIEW);
  });

  it('fills nested defaults inside partially given objects', () => {
    const { piece } = ok(
      parsePiece({
        ...MINIMAL,
        mix: { reverb: { size: 0.2 }, limiter: {} },
        defaults: { glide: { length: 5 } },
        voices: [{ id: 'a' }, { id: 'b', pan: 0.3 }],
        timbres: { t: { harmonics: [1, 0.5], vibrato: { rate: 6 } } },
      }),
    );
    expect(piece.mix.reverb).toEqual({ ...DEFAULT_MIX.reverb, size: 0.2 });
    expect(piece.mix.limiter.ceilingDb).toBe(-1);
    expect(piece.mix.delay.returnLevel).toBe(0);
    expect(piece.defaults.glide).toEqual({ ...DEFAULT_GLIDE, length: 5 });
    expect(piece.voices[1]).toEqual({
      id: 'b',
      timbre: 'glass',
      pan: 0.3,
      gain: 1,
      range: [38, 84],
    });
    expect(piece.timbres.t).toEqual({
      harmonics: [1, 0.5],
      stretch: 0,
      brightness: { tilt: 0, track: 0 },
      detuneSpread: 0,
      accent: 0,
      articulation: { amount: 0, attack: 0.01, decay: 0.2 },
      vibrato: { rate: 6, depthCents: 0, delay: 0.5 },
    });
  });

  it('fills every moment default and leaves optional fields absent', () => {
    const moments = [
      { id: 'm1', type: 'chord', at: 1, notes: { kind: 'current' } },
      { id: 'm2', type: 'unison', at: 2 },
      { id: 'm3', type: 'split', at: 3, count: 3 },
      { id: 'm4', type: 'merge', at: 4, count: 1 },
      { id: 'm5', type: 'shift', at: 5, by: 2 },
      { id: 'm6', type: 'spread', at: 6, factor: 2 },
      { id: 'm7', type: 'walk', at: 7, until: 9 },
      { id: 'm8', type: 'pin', at: 8, voice: 'v1', pitch: 60 },
      { id: 'm9', type: 'key', at: 9, key: { tonic: 'C', scale: 'major' } },
      { id: 'm10', type: 'level', at: 10, gain: 0.5 },
      { id: 'm11', type: 'timbre', at: 11, preset: 'bell' },
    ];
    const { piece } = ok(parsePiece({ ...MINIMAL, moments }));
    piece.moments.forEach((m, i) => {
      expect(m).toEqual({ ...moments[i], ...MOMENT_DEFAULTS[m.type] });
      expect('target' in m).toBe(false);
      expect('glide' in m).toBe(false);
    });
    expect(MOMENT_TYPES).toEqual(Object.keys(MOMENT_DEFAULTS));
  });

  it("parses PLAN.md §5's example piece", () => {
    const example = {
      format: 'algorhythms',
      version: 1,
      meta: {
        title: 'First Light',
        created: '2026-11-19T00:00:00Z',
        modified: '2026-11-19T00:00:00Z',
      },
      seed: 2611,
      tuning: { referenceHz: 440, system: { kind: '12tet' } },
      key: { tonic: 'A', scale: 'dorian' },
      defaults: {
        glide: { length: 3, jitter: 0.2, stagger: 0.8, order: 'random', ease: 'smootherstep' },
      },
      voices: [{ id: 'v1', timbre: 'glass', pan: 'auto', gain: 1, range: [38, 86] }],
      start: [{ voice: 'v1', pitch: 57 }],
      moments: [
        { id: 'k3f9', type: 'split', at: 9, count: 3, notes: { kind: 'chord', symbol: 'Am7' } },
        { id: 'p0x2', type: 'split', at: 17, count: 8, notes: { kind: 'current' } },
        { id: 'q7aa', type: 'chord', at: 26, notes: { kind: 'degrees', degrees: [3, 5, 7, 9] } },
        {
          id: 'u1zz',
          type: 'unison',
          at: 40,
          pitch: 64,
          glide: {
            length: 4.5,
            jitter: 0.1,
            stagger: 0.9,
            order: 'outside-in',
            ease: 'smootherstep',
          },
        },
        { id: 'r2kd', type: 'key', at: 50, key: { tonic: 'D', scale: 'aeolian' } },
        { id: 'w8mm', type: 'walk', at: 52, until: 70, grid: 0.5, density: 0.45 },
      ],
      end: { fade: 6 },
      view: { window: 20, colors: 'pitch', hud: true },
    };
    // A version 1 file: its `start` becomes the opening chord, first in `moments`.
    const { piece } = ok(parsePiece(example));
    expect(piece.version).toBe(2);
    expect(piece.moments[0]).toMatchObject({
      id: 'start0',
      type: 'chord',
      at: 0,
      notes: { kind: 'pitches', pitches: [57] },
    });
    expect(piece.moments[6]).toMatchObject({ steps: [-2, -1, 1, 2], stepGlide: 0.3 });
    expect(piece.moments[4]).toMatchObject({ octaves: false });
  });

  it('keeps view.snapBeats (revision 9); absent stays absent', () => {
    const p = newPiece({ seed: 5 });
    p.view = { ...p.view, gridBpm: 96, snapBeats: false };
    const r = ok(parsePiece(JSON.parse(serializePiece(p))));
    expect(r.piece.view.snapBeats).toBe(false);
    expect(ok(parsePiece(newPiece({ seed: 5 }))).piece.view.snapBeats).toBeUndefined();
  });

  it('keeps view.loop (revision 6)', () => {
    const p = { ...newPiece({ seed: 5 }) };
    p.view = { ...p.view, loop: { start: 4, end: 9.5, on: false } };
    const r = ok(parsePiece(JSON.stringify(p)));
    expect(r.piece.view.loop).toEqual({ start: 4, end: 9.5, on: false });
    expect(ok(parsePiece(newPiece({ seed: 5 }))).piece.view.loop).toBeUndefined();
  });

  it("reads the retired colors 'voice' as 'pitch'", () => {
    const old = { ...newPiece({ seed: 5 }), view: { window: 20, colors: 'voice', hud: true } };
    const r = ok(parsePiece(JSON.stringify(old)));
    expect(r.piece.view.colors).toBe('pitch');
    expect(r.warnings).toEqual([]);
  });

  it('round-trips the empty template exactly', () => {
    const p = newPiece({ seed: 5 });
    expect(ok(parsePiece(p)).piece).toEqual(p);
  });
});

describe('parsePiece: unknown fields at every level', () => {
  it('keeps them through parse → serialize → parse', () => {
    const input = fullPiece();
    const touched = injectUnknown(input);
    expect(touched).toBeGreaterThan(60);

    const first = ok(parsePiece(input)).piece;
    // The input already had every default, so parsing must give back exactly the input.
    expect(first).toEqual(input);

    const text = serializePiece(first);
    const second = ok(parsePiece(text)).piece;
    expect(second).toEqual(first);
    expect(serializePiece(second)).toBe(text);
  });

  it('keeps them inside every union branch', () => {
    const input = fullPiece();
    injectUnknown(input);
    const piece = ok(parsePiece(input)).piece as unknown as {
      moments: Record<string, Record<string, unknown>>[];
      key: { scale: Record<string, unknown> };
    };
    expect(piece.moments[1].target).toHaveProperty('zFuture3');
    expect(piece.moments[2].target).toHaveProperty('zFuture3');
    expect(piece.moments[1].notes).toHaveProperty('zFuture3');
    expect(piece.moments[11].key).toHaveProperty('zFuture3');
    expect(piece.moments[9].bass).toHaveProperty('zFuture3');
  });
});

describe('parsePiece: unknown fields named like Object.prototype members', () => {
  it('keeps valueOf, toString, constructor and hasOwnProperty; drops only __proto__', () => {
    // Regression: `'valueOf' in {}` is true, which once dropped such fields on save.
    const text = `{"format": "algorhythms", "version": 1,
      "valueOf": false, "toString": {"valueOf": 1}, "constructor": [1],
      "meta": {"hasOwnProperty": "x", "__proto__": {"deep": true}}}`;
    const first = ok(parsePiece(text)).piece as unknown as Record<string, unknown>;
    expect(Object.hasOwn(first, 'valueOf')).toBe(true);
    expect(first.toString).toEqual({ valueOf: 1 });
    expect(first.constructor).toEqual([1]);
    const meta = first.meta as Record<string, unknown>;
    expect(meta.hasOwnProperty).toBe('x');
    // Zod drops an own __proto__ key (a prototype-pollution guard); nothing is polluted.
    expect(Object.hasOwn(meta, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(meta)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).deep).toBeUndefined();

    const saved = serializePiece(first as unknown as Piece);
    const back = JSON.parse(saved) as Record<string, unknown>;
    expect(back.valueOf).toBe(false);
    expect(back.toString).toEqual({ valueOf: 1 });
    expect(ok(parsePiece(saved)).piece).toEqual(first);
  });
});

describe('parsePiece: errors', () => {
  it('rejects duplicate moment ids', () => {
    const errs = errors(
      parsePiece({
        ...MINIMAL,
        moments: [
          { id: 'abc123', type: 'level', at: 1, gain: 1 },
          { id: 'abc123', type: 'level', at: 2, gain: 0 },
        ],
      }),
    );
    expect(errs).toEqual([
      "moments[1].id: Duplicate moment id 'abc123'; every moment needs its own id.",
    ]);
  });

  it('rejects duplicate voice ids, an oversized pool and bad v1 start entries', () => {
    expect(errors(parsePiece({ ...MINIMAL, voices: [{ id: 'a' }, { id: 'a' }] }))).toEqual([
      "voices[1].id: Duplicate voice id 'a'.",
    ]);
    const big = Array.from({ length: 33 }, (_, i) => ({ id: `v${i}` }));
    expect(errors(parsePiece({ ...MINIMAL, voices: big }))[0]).toMatch(
      /33 voices; the maximum is 32/,
    );
    const v1 = { ...MINIMAL, version: 1 };
    expect(errors(parsePiece({ ...v1, start: [{ voice: 'v99', pitch: 60 }] }))).toEqual([
      "Upgrading from file format 1 failed: start[0].voice: 'v99' is not a voice in the pool.",
    ]);
    expect(
      errors(
        parsePiece({
          ...v1,
          start: [
            { voice: 'v1', pitch: 60 },
            { voice: 'v1', pitch: 62 },
          ],
        }),
      ),
    ).toEqual(["Upgrading from file format 1 failed: start[1].voice: 'v1' is started twice."]);
  });

  it('rejects things that are not pieces', () => {
    expect(errors(parsePiece('{oops'))[0]).toMatch(/^Not valid JSON/);
    expect(errors(parsePiece([]))).toEqual(['A piece must be a JSON object.']);
    expect(errors(parsePiece(null))).toEqual(['A piece must be a JSON object.']);
    expect(errors(parsePiece({ version: 1 }))[0]).toMatch(/"format" field is missing/);
    expect(errors(parsePiece({ format: 'other', version: 1 }))[0]).toMatch(/"format" is "other"/);
    expect(errors(parsePiece({ format: 'algorhythms' }))[0]).toMatch(/^version:/);
    expect(errors(parsePiece({ format: 'algorhythms', version: 1.5 }))[0]).toMatch(/^version:/);
  });

  it('points at the bad field with a readable message', () => {
    const errs = errors(
      parsePiece({
        ...MINIMAL,
        seed: 'x',
        moments: [
          { id: 'a', type: 'split', at: 1 },
          { id: 'b', type: 'chord', at: 2, notes: { kind: 'chord', symbol: 7 } },
          { id: 'c', type: 'level', at: 3, gain: 1, target: { rank: [1] } },
          { id: 'd', type: 'key', at: 4, key: { tonic: 'H', scale: 'dorian' } },
          {
            id: 'e',
            type: 'key',
            at: 5,
            key: { tonic: 'C', scale: { kind: 'custom', intervals: [2, 1] } },
          },
          { id: 'f', type: 'level', at: -1, gain: 1 },
        ],
        voices: [{ id: 'v1', range: [80, 40] }],
      }),
    );
    expect(errs).toContain('seed: Invalid input: expected number, received string');
    expect(errs).toContain('moments[0].count: Invalid input: expected number, received undefined');
    expect(errs).toContain(
      'moments[1].notes.symbol: Invalid input: expected string, received number',
    );
    expect(errs.some((e) => e.startsWith('moments[2].target.rank:'))).toBe(true);
    expect(errs.some((e) => e.startsWith('moments[3].key.tonic:'))).toBe(true);
    expect(errs).toContain(
      'moments[4].key.scale.intervals: Intervals must start with 0 and ascend without repeats.',
    );
    expect(errs.some((e) => e.startsWith('moments[5].at:'))).toBe(true);
    expect(errs).toContain('voices[0].range: The low end must not be above the high end.');
  });

  it('rejects unknown moment types in a current-version file, naming the position', () => {
    const errs = errors(
      parsePiece({
        ...MINIMAL,
        moments: [
          { id: 'a', type: 'mirror', at: 1 },
          { id: 'b', type: 'split', at: 2 },
        ],
      }),
    );
    expect(errs).toEqual([
      "moments[0].type: unknown moment type 'mirror' (expected one of chord, unison, split, merge, shift, spread, walk, note, pin, key, level, pulse, tune, timbre).",
      'moments[1].count: Invalid input: expected number, received undefined',
    ]);
  });
});

describe('parsePiece: versions', () => {
  it('opens a newer file with a warning, keeping its version and unknown moments', () => {
    const input = {
      ...MINIMAL,
      version: 3,
      futureTopLevel: { a: 1 },
      moments: [
        { id: 'a', type: 'split', at: 1, count: 2 },
        { id: 'b', type: 'mirror', at: 2, axis: 60 },
        { id: 'c', type: 'level', at: 3, gain: 0.5 },
      ],
    };
    const r = ok(parsePiece(input));
    expect(r.newerVersion).toBe(true);
    expect(r.warnings[0]).toMatch(/newer AlgoRhythms \(file format 3; this version reads 2\)/);
    expect(r.warnings[1]).toMatch(/1 moment\(s\) of a type this version doesn't know \(mirror\)/);
    expect(r.piece.version).toBe(3);
    expect(r.piece.moments.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(r.piece.moments[1]).toEqual({ id: 'b', type: 'mirror', at: 2, axis: 60 });
    expect((r.piece as unknown as Record<string, unknown>).futureTopLevel).toEqual({ a: 1 });
    const again = ok(parsePiece(serializePiece(r.piece)));
    expect(again.piece).toEqual(r.piece);
  });

  it('still reports errors in a newer file at their original positions', () => {
    const errs = errors(
      parsePiece({
        ...MINIMAL,
        version: 3,
        moments: [
          { id: 'b', type: 'mirror', at: 2 },
          { id: 'a', type: 'split', at: 1 },
        ],
      }),
    );
    expect(errs).toEqual(['moments[1].count: Invalid input: expected number, received undefined']);
  });

  it('migrates older files with the registry it is given', () => {
    const registry = migrationRegistry([
      DEFAULT_MIGRATIONS.get(1)!,
      {
        from: 0,
        description: 'v0 kept the title at the top level',
        migrate: (raw) => {
          const { title, ...rest } = raw;
          return { ...rest, meta: { title } };
        },
      },
    ]);
    const r = ok(
      parsePiece({ format: 'algorhythms', version: 0, title: 'Old' }, { migrations: registry }),
    );
    expect(r.migratedFrom).toBe(0);
    expect(r.piece.version).toBe(2);
    expect(r.piece.meta.title).toBe('Old');
    expect('title' in r.piece).toBe(false);
    // The shipped registry starts at version 1.
    expect(errors(parsePiece({ format: 'algorhythms', version: 0 }))[0]).toMatch(/cannot upgrade/);
  });

  it('warns about tuning systems that are not supported yet', () => {
    const r = ok(
      parsePiece({ ...MINIMAL, tuning: { system: { kind: 'scala', scl: '! x.scl\n' } } }),
    );
    expect(r.warnings).toEqual(["Tuning system 'scala' is not supported yet; 12-TET is used."]);
  });
});

describe('parsePiece: isolation', () => {
  it('does not mutate its input or share references with it', () => {
    const input = fullPiece();
    injectUnknown(input);
    const snapshot = cloneJson(input);
    const { piece } = ok(parsePiece(input));
    expect(input).toEqual(snapshot);
    piece.moments[0].at = 999;
    (piece.voices[0].range as number[])[0] = 1;
    (piece as unknown as { zFuture0: { list: unknown[] } }).zFuture0.list.push('x');
    expect(input).toEqual(snapshot);
  });
});

describe('serializePiece', () => {
  it('is stable: key order in the input does not matter', () => {
    const p = fullPiece();
    injectUnknown(p);
    const reversed = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(reversed);
      if (v !== null && typeof v === 'object') {
        return Object.fromEntries(
          Object.entries(v)
            .reverse()
            .map(([k, x]) => [k, reversed(x)]),
        );
      }
      return v;
    };
    const a = serializePiece(ok(parsePiece(p)).piece);
    const b = serializePiece(reversed(p) as Piece);
    expect(b).toBe(a);
  });

  it('writes known keys in schema order, then unknown keys alphabetically', () => {
    const p = newPiece({ seed: 1 }) as Piece & Record<string, unknown>;
    p.zebra = 1;
    p.apple = 2;
    const parsed = JSON.parse(serializePiece(p)) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      'format',
      'version',
      'meta',
      'seed',
      'tuning',
      'key',
      'defaults',
      'voices',
      'moments',
      'timbres',
      'mix',
      'end',
      'view',
      'apple',
      'zebra',
    ]);
    const m = JSON.parse(serializePiece(fullPiece())) as { moments: Record<string, unknown>[] };
    expect(Object.keys(m.moments[1])).toEqual([
      'type',
      'id',
      'at',
      'target',
      'seed',
      'notes',
      'voicing',
      'register',
      'assign',
    ]);
  });

  it('prints readable, valid JSON within 100 columns', () => {
    const text = serializePiece(fullPiece());
    expect(text.endsWith('}\n')).toBe(true);
    expect(() => JSON.parse(text) as unknown).not.toThrow();
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(100);
    // Short values stay on one line.
    expect(text).toContain('"range": [38, 84]');
    expect(text).toContain('"pitches": [57, 64.5]');
    expect(text).toContain(
      '{ "id": "aaaab2", "type": "pin", "at": 30, "voice": "v3", "pitch": 72 }'.replace(
        '"id": "aaaab2", "type": "pin"',
        '"type": "pin", "id": "aaaab2"',
      ),
    );
  });

  it('is idempotent and drops undefined fields', () => {
    const p = newPiece({ seed: 3 });
    (p.meta as { author?: string }).author = undefined;
    const once = serializePiece(p);
    expect(once).not.toContain('author');
    expect(serializePiece(ok(parsePiece(once)).piece)).toBe(once);
  });
});

describe('published JSON Schema', () => {
  it('docs/file-format.md is up to date (run `pnpm docs:schema`)', () => {
    const path = fileURLToPath(new URL('../../../docs/file-format.md', import.meta.url));
    expect(readFileSync(path, 'utf8')).toBe(renderFileFormatDoc());
  });

  it('describes the input form', () => {
    const doc = renderFileFormatDoc();
    expect(doc).toContain('"$schema": "https://json-schema.org/draft/2020-12/schema"');
    expect(doc).toMatch(/"required": \[\s*"format",\s*"version"\s*\]/);
  });
});

describe('formatPath', () => {
  it('formats Zod paths', () => {
    expect(formatPath(['moments', 3, 'notes', 'symbol'])).toBe('moments[3].notes.symbol');
    expect(formatPath([])).toBe('');
    expect(formatPath([0, 'a'])).toBe('[0].a');
  });
});
