/** The piece's camera field (PLAN.md §15 M11.5 C1): schema, canonical numbers, share links. */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeShareLink, encodeShareLink, packPiece, unpackPiece } from '../../../src/app/share';
import { canonicalPiece } from '../../../src/core/canonical';
import { parsePiece, stripDefaults } from '../../../src/core/schema';
import type { CameraKey, Piece } from '../../../src/core/types';

const EXAMPLES = join(import.meta.dirname, '../../../examples');
const BASE = 'https://example.org/algorhythms/';

function parsed(json: unknown): Piece {
  const r = parsePiece(json);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}

const example = (name: string): Piece =>
  parsed(readFileSync(join(EXAMPLES, `${name}.algorhythms.json`), 'utf8'));

const KEYS: CameraKey[] = [
  { at: 0, window: 8, place: 0.25, pitch: 60, range: 12 },
  { at: 10.5, window: 32, place: 0.5, pitch: 66.5, range: 24, ease: 'linear' },
  { at: 20, window: 16, place: 0.75, pitch: 62, range: 16 },
];

describe('Piece.camera schema', () => {
  it('reads and keeps a camera; absent stays absent', () => {
    const p = example('tidewater-hymn');
    expect(p).not.toHaveProperty('camera');
    const withCam = parsed({ ...p, camera: { mode: 'keys', keys: KEYS } });
    expect(withCam.camera).toEqual({ mode: 'keys', keys: KEYS });
    expect(parsed(JSON.parse(JSON.stringify(withCam)))).toEqual(withCam);
    expect(parsed(stripDefaults(withCam))).toEqual(withCam);
    expect(stripDefaults(withCam).camera).toEqual({ mode: 'keys', keys: KEYS });
    expect(parsed({ ...p, camera: { mode: 'auto' } }).camera).toEqual({ mode: 'auto' });
  });

  it('refuses bad keys: unsorted, place outside 0..1, a window or range ≤ 0, an unknown mode', () => {
    const p = example('tidewater-hymn');
    const bad = (camera: unknown) => parsePiece({ ...p, camera }).ok;
    expect(bad({ mode: 'keys', keys: [KEYS[1], KEYS[0]] })).toBe(false);
    expect(bad({ mode: 'keys', keys: [{ ...KEYS[0], place: 1.5 }] })).toBe(false);
    expect(bad({ mode: 'keys', keys: [{ ...KEYS[0], window: 0 }] })).toBe(false);
    expect(bad({ mode: 'keys', keys: [{ ...KEYS[0], range: -1 }] })).toBe(false);
    expect(bad({ mode: 'keys', keys: [{ ...KEYS[0], at: -1 }] })).toBe(false);
    expect(bad({ mode: 'pan' })).toBe(false);
  });

  it('canonicalises key numbers (times and windows to 1 ms, place to 3 digits)', () => {
    const p = example('tidewater-hymn');
    const c = canonicalPiece({
      ...p,
      camera: {
        mode: 'keys',
        keys: [{ at: 1.23456, window: 9.87654, place: 0.33333, pitch: 60.1 + 0.2, range: 12 }],
      },
    });
    expect(c.camera!.keys![0]).toEqual({
      at: 1.235,
      window: 9.877,
      place: 0.333,
      pitch: 60.3,
      range: 12,
    });
    expect(canonicalPiece(p)).toBe(p);
  });
});

describe('share links', () => {
  it('pack plain keys flat and keys with an ease as objects; round-trip exactly', async () => {
    const p = parsed({ ...example('tidewater-hymn'), camera: { mode: 'keys', keys: KEYS } });
    const packed = packPiece(p)!;
    // One key has an ease: all stay objects.
    expect(packed.camera).toEqual({ mode: 'keys', keys: KEYS });
    expect(await decodeShareLink(await encodeShareLink(p, BASE)).then(parsed)).toEqual(p);

    const plain = parsed({
      ...example('tidewater-hymn'),
      camera: { mode: 'keys', keys: KEYS.map(({ ease: _e, ...k }) => k) },
    });
    const flat = packPiece(plain)!;
    expect(flat.camera).toEqual({
      mode: 'keys',
      keys: [0, 8, 0.25, 60, 12, 10.5, 32, 0.5, 66.5, 24, 20, 16, 0.75, 62, 16],
    });
    expect(parsed(unpackPiece(JSON.parse(JSON.stringify(flat))))).toEqual(plain);
    const link = await encodeShareLink(plain, BASE);
    expect(link.startsWith(`${BASE}#p=2.`)).toBe(true);
    expect(await decodeShareLink(link).then(parsed)).toEqual(plain);
    // Three keys cost little.
    const without = await encodeShareLink(example('tidewater-hymn'), BASE);
    expect(link.length - without.length).toBeLessThan(80);
  });

  it('a piece without camera packs without one (links of existing pieces unchanged)', () => {
    for (const f of readdirSync(EXAMPLES).filter((n) => n.endsWith('.algorhythms.json'))) {
      const p = example(f.replace('.algorhythms.json', ''));
      expect(packPiece(p) ?? {}).not.toHaveProperty('camera');
    }
  });
});
