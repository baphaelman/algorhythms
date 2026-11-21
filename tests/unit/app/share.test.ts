import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  MAX_DECODED_BYTES,
  decodeShareLink,
  decodeSharePayload,
  encodeShareLink,
  encodeSharePayload,
  nextId,
  packPiece,
  sharePayloadOf,
  unpackPiece,
} from '../../../src/app/share';
import { SHARE_DICTIONARY_V2 } from '../../../src/app/share-dict';
import { newPiece } from '../../../src/core/defaults';
import { parsePiece } from '../../../src/core/schema';
import { BUILTIN_TIMBRES } from '../../../src/core/timbres';
import type { Piece } from '../../../src/core/types';

const sample = { format: 'algorhythms', version: 1, meta: { title: 'Ünïcode ♪ title' }, seed: 5 };
const BASE = 'https://example.org/algorhythms/';
const EXAMPLES = join(import.meta.dirname, '../../../examples');

function parsed(json: unknown): Piece {
  const r = parsePiece(json);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}

const example = (name: string): Piece =>
  parsed(readFileSync(join(EXAMPLES, `${name}.algorhythms.json`), 'utf8'));

/** Opens a link as the app does: decode, then `parsePiece`. */
async function open(link: string): Promise<Piece> {
  return parsed(await decodeShareLink(link));
}

describe('v1 payloads (§11.4): base64url(deflate-raw(JSON))', () => {
  it('round-trips JSON', async () => {
    const payload = await encodeSharePayload(sample);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/); // no padding, no + or /
    expect(await decodeSharePayload(payload)).toEqual(sample);
  });

  it('is interoperable with zlib deflate-raw in both directions', async () => {
    const json = JSON.stringify(sample);
    const theirs = deflateRawSync(Buffer.from(json)).toString('base64url');
    expect(await decodeSharePayload(theirs)).toEqual(sample);
    const ours = await encodeSharePayload(sample);
    expect(JSON.parse(inflateRawSync(Buffer.from(ours, 'base64url')).toString('utf8'))).toEqual(
      sample,
    );
  });

  it('reports damaged links with readable errors', async () => {
    await expect(decodeSharePayload('not base64!')).rejects.toThrow(/base64/);
    await expect(decodeSharePayload('AAAA-not-deflate')).rejects.toThrow(/damaged/);
    await expect(decodeSharePayload('2.AAAA-not-deflate')).rejects.toThrow(/damaged/);
    const notJson = deflateRawSync(Buffer.from('hello')).toString('base64url');
    await expect(decodeSharePayload(notJson)).rejects.toThrow(/valid JSON/);
  });

  it('refuses a decompression bomb, v1 and v2', async () => {
    const big = Buffer.alloc(MAX_DECODED_BYTES + 1024, 0x20);
    await expect(decodeSharePayload(deflateRawSync(big).toString('base64url'))).rejects.toThrow(
      /more data/,
    );
    const v2 = deflateRawSync(big, { dictionary: Buffer.from(SHARE_DICTIONARY_V2) });
    await expect(decodeSharePayload(`2.${v2.toString('base64url')}`)).rejects.toThrow(/more data/);
  });

  it('finds the payload in a fragment', () => {
    expect(sharePayloadOf('#other=1')).toBeNull();
    expect(sharePayloadOf('#p=')).toBeNull();
    expect(sharePayloadOf('#x=1&p=abc')).toBe('abc');
    expect(sharePayloadOf('#p=2.abc')).toBe('2.abc');
  });
});

describe('share links (v2: stripped, packed, preset dictionary)', () => {
  it('builds `#p=2.` links that open as exactly the piece, and re-encode to the same link', async () => {
    for (const name of ['tidewater-hymn', 'lanterns-over-salt-flats']) {
      const piece = example(name);
      const link = await encodeShareLink(piece, BASE);
      expect(link.startsWith(`${BASE}#p=2.`)).toBe(true);
      expect(link.split('#p=2.')[1]).toMatch(/^[A-Za-z0-9_-]+$/);
      const back = await open(link);
      expect(back).toEqual(piece);
      expect(await encodeShareLink(back, BASE)).toBe(link);
      expect(await open(link.slice(link.indexOf('#')))).toEqual(piece);
    }
    expect(await decodeShareLink('https://example.org/')).toBeNull();
  });

  it('old unstripped links still open', async () => {
    const piece = example('clockwork-heron');
    const link = `${BASE}#p=${await encodeSharePayload(piece)}`;
    expect(await open(link)).toEqual(piece);
    // And the raw file, as an outside encoder would write it.
    const raw = readFileSync(join(EXAMPLES, 'clockwork-heron.algorhythms.json'), 'utf8');
    expect(await open(`#p=${deflateRawSync(Buffer.from(raw)).toString('base64url')}`)).toEqual(
      piece,
    );
  });

  it('v2 payloads are standard deflate-raw with the preset dictionary', async () => {
    const piece = example('seven-doors-in-fog');
    const link = await encodeShareLink(piece, BASE);
    const bytes = Buffer.from(link.split('#p=2.')[1], 'base64url');
    const json = inflateRawSync(bytes, { dictionary: Buffer.from(SHARE_DICTIONARY_V2) });
    expect(JSON.parse(json.toString('utf8'))).toEqual(packPiece(piece));
    // zlib's own deflate (with the dictionary) decodes too.
    const theirs = deflateRawSync(json, { dictionary: Buffer.from(SHARE_DICTIONARY_V2) });
    expect(await open(`#p=2.${theirs.toString('base64url')}`)).toEqual(piece);
  });

  it('packs unchanged built-in timbres as 1 and keeps edited ones', () => {
    const piece = newPiece({ seed: 3, timbre: 'reed' });
    expect(packPiece(piece)?.timbres).toEqual({ reed: 1 });
    const edited = parsed({
      ...piece,
      timbres: { reed: { ...BUILTIN_TIMBRES.reed, accent: 0.5 } },
    });
    const t = packPiece(edited)?.timbres as Record<string, Record<string, unknown>>;
    expect(t.reed.accent).toBe(0.5);
    expect(t.reed.harmonics).toEqual(BUILTIN_TIMBRES.reed.harmonics);
    expect(unpackPiece({ timbres: { reed: 1, mine: 1 } })).toEqual({
      timbres: { reed: BUILTIN_TIMBRES.reed, mine: 1 },
    });
  });

  it('omits default voice ids and counted-up moment ids, writes times as ms steps', () => {
    const piece = parsed({
      format: 'algorhythms',
      version: 2,
      voices: [{ id: 'v1' }, { id: 'lead' }, { id: 'v3' }],
      moments: [
        { id: 'ab0009', type: 'level', at: 1.5, gain: 0.5 },
        { id: 'ab0010', type: 'level', at: 1.25, gain: 0.5 },
        { id: 'zz', type: 'level', at: 4, gain: 0.5 },
        { id: 'zz1', type: 'level', at: 4, gain: 0.5 },
        { id: 'zz2', type: 'tune', at: 5, notes: [{ pitch: 60, len: 0.5 }] },
      ],
    });
    const packed = packPiece(piece) as { voices: unknown[]; moments: Record<string, unknown>[] };
    expect(packed.voices).toEqual([{}, { id: 'lead' }, {}]);
    expect(packed.moments.map((m) => m.id)).toEqual(['ab0009', undefined, 'zz', 'zz1', undefined]);
    expect(packed.moments.map((m) => m.at)).toEqual([1500, -250, 2750, 0, 1000]);
    expect(packed.moments[4].notes).toEqual([60, 0.5]);
    expect(parsed(unpackPiece(JSON.parse(JSON.stringify(packed))))).toEqual(piece);
  });

  it('nextId counts up within the same width', () => {
    expect(nextId('kd0041')).toBe('kd0042');
    expect(nextId('m00009')).toBe('m00010');
    expect(nextId('a9')).toBeNull(); // would widen
    expect(nextId('start0')).toBe('start1');
    expect(nextId('abcdef')).toBeNull();
  });

  it('keeps unknown fields and unknown moment types (newer files)', async () => {
    const r = parsePiece({
      format: 'algorhythms',
      version: 99,
      future: { x: 1.23456789012345 },
      moments: [
        { id: 'm1', type: 'chord', at: 0, notes: { kind: 'pitches', pitches: [60] }, extra: 2 },
        { id: 'm2', type: 'laser', at: 1.0005, beam: [1, 2] },
      ],
    });
    if (!r.ok) throw new Error(r.errors.join('; '));
    const back = await decodeShareLink(await encodeShareLink(r.piece, BASE));
    const again = parsePiece(back);
    expect(again.ok && again.piece).toEqual(r.piece);
  });

  it('a piece that is not canonical opens as its canonical form', async () => {
    const piece = newPiece({ seed: 1 });
    piece.moments.push({ id: 'lvl001', type: 'level', at: 2.00049, gain: 0.123456, over: 1 });
    const back = await open(await encodeShareLink(piece, BASE));
    expect(back.moments[1]).toMatchObject({ at: 2, gain: 0.123 });
    expect(back).toEqual(parsed(piece));
  });
});
