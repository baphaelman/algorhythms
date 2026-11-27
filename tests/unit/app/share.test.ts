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
  linkDropsPicture,
  nextId,
  packPiece,
  shareablePiece,
  sharePayloadOf,
  unpackPiece,
} from '../../../src/app/share';
import { SHARE_DICTIONARY_V2 } from '../../../src/app/share-dict';
import { newPiece } from '../../../src/core/defaults';
import { withOpening } from '../opened-piece';
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

  it('round-trips tune rests, strike and writtenIn (revision 10); absent fields stay absent', async () => {
    const piece = withOpening(newPiece({ seed: 9 }));
    piece.moments.push(
      {
        id: 'tn1',
        type: 'tune',
        at: 2,
        notes: [
          { pitch: 60, len: 0.5 },
          { rest: true, len: 0.25 },
          { pitch: 62, len: 1 },
        ],
        strike: false,
        writtenIn: 'Eb',
      },
      { id: 'tn2', type: 'tune', at: 5, notes: [{ pitch: 64, len: 1 }] },
    );
    const p = parsed(piece);
    const packed = packPiece(p) as { moments: Record<string, unknown>[] };
    const [a, b] = packed.moments.slice(-2);
    expect(a.notes).toEqual([60, 0.5, null, 0.25, 62, 1]);
    expect(a.strike).toBe(false);
    expect(a.writtenIn).toBe('Eb');
    expect(b).not.toHaveProperty('strike');
    expect(b).not.toHaveProperty('writtenIn');
    const link = await encodeShareLink(p, BASE);
    expect(link).toContain('#p=2.');
    expect(await open(link)).toEqual(p);
  });

  it('round-trips multi-part targets (revision 10)', async () => {
    const piece = withOpening(newPiece({ seed: 9 }));
    piece.voices[0].part = 'Melody';
    piece.voices[1].part = 'Bass';
    piece.moments.push(
      {
        id: 'mp1',
        type: 'shift',
        at: 2,
        by: 2,
        unit: 'semitones',
        target: { parts: ['Melody', 'Bass'] },
      },
      { id: 'mp2', type: 'level', at: 3, gain: 0.5, over: 1, target: { exceptParts: ['Bass'] } },
    );
    const p = parsed(piece);
    const link = await encodeShareLink(p, BASE);
    expect(link).toContain('#p=2.');
    const q = await open(link);
    expect(q).toEqual(p);
    expect(q.moments.slice(-2).map((m) => m.target)).toEqual([
      { parts: ['Melody', 'Bass'] },
      { exceptParts: ['Bass'] },
    ]);
  });

  it("mix.normalise (revision 10): links omit the default 'part'; 'all' round-trips", async () => {
    const piece = withOpening(newPiece({ seed: 9 }));
    piece.voices[0].part = 'Melody';
    const p = parsed(piece);
    expect(p.mix.normalise).toBe('part');
    // An older link without the field opens as 'part'.
    const { normalise: _, ...oldMix } = p.mix;
    expect((await open(await encodeShareLink({ ...p, mix: oldMix }, BASE))).mix.normalise).toBe(
      'part',
    );
    expect(packPiece(p)).not.toHaveProperty(['mix', 'normalise']);
    const all = parsed({ ...p, mix: { ...p.mix, normalise: 'all' } });
    const link = await encodeShareLink(all, BASE);
    const back = await open(link);
    expect(back.mix.normalise).toBe('all');
    expect(back).toEqual(all);
    expect(await encodeShareLink(back, BASE)).toBe(link);
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
    const piece = withOpening(newPiece({ seed: 1 }));
    piece.moments.push({ id: 'lvl001', type: 'level', at: 2.00049, gain: 0.123456, over: 1 });
    const back = await open(await encodeShareLink(piece, BASE));
    expect(back.moments[1]).toMatchObject({ at: 2, gain: 0.123 });
    expect(back).toEqual(parsed(piece));
  });
});

describe('poster pictures stay out of links (M14 P5)', () => {
  it('a link drops the picture and keeps the rest of the poster; the file keeps it', async () => {
    const base = newPiece({ seed: 3, title: 'Pictured' });
    const picture = { src: 'data:image/png;base64,iVBORw0KGgo=', w: 2, h: 1, dim: 0.25 };
    const r = parsePiece({
      ...base,
      poster: { rowsBy: 'sections', rowSections: { start: { label: 'A′' } }, picture },
    });
    if (!r.ok) throw new Error(r.errors.join('; '));
    const piece = r.piece;
    expect(piece.poster?.picture).toEqual(picture);
    expect(linkDropsPicture(piece)).toBe(true);
    const back = parsePiece(await decodeShareLink(await encodeShareLink(piece, 'https://x/')));
    if (!back.ok) throw new Error(back.errors.join('; '));
    expect(back.piece.poster).toEqual({
      rowsBy: 'sections',
      rowSections: { start: { label: 'A′' } },
    });
    expect(shareablePiece(piece)).toEqual(back.piece);
    const only = parsePiece({ ...base, poster: { picture } });
    if (!only.ok) throw new Error(only.errors.join('; '));
    expect(shareablePiece(only.piece).poster).toBeUndefined();
    expect(linkDropsPicture(base)).toBe(false);
  });

  it("a poster's save point is in the file but never in a link", () => {
    const base = newPiece({ seed: 3 });
    const r = parsePiece({
      ...base,
      poster: { rows: 2 },
      posterSaved: { rows: 3, look: { theme: 'dark' } },
    });
    if (!r.ok) throw new Error(r.errors.join('; '));
    expect(r.piece.posterSaved?.rows).toBe(3);
    const link = shareablePiece(r.piece);
    expect(link.posterSaved).toBeUndefined();
    expect(link.poster?.rows).toBe(2);
  });

  it('the schema refuses a picture that is not an image data URL', () => {
    const base = newPiece({ seed: 3 });
    const bad = parsePiece({
      ...base,
      poster: { picture: { src: 'https://example.com/x.png', w: 2, h: 1 } },
    });
    expect(bad.ok).toBe(false);
  });
});

describe('Play the poster fields (M15)', () => {
  const base = () => newPiece({ seed: 4, title: 'Played' });
  const camera = {
    mode: 'keys' as const,
    frame: 'poster' as const,
    rowBreak: 'scroll' as const,
    keys: [{ at: 0, window: 12, place: 0.35, pitch: 60, range: 24 }],
    posterKeys: [
      { at: 0, x: 0.5, y: 0.25, h: 0.3 },
      { at: 4.5, x: 0.6, y: 0.75, h: 0.25, ease: 'linear' as const },
      { at: 9, x: 0.4, y: 0.5, h: 1 },
    ],
  };
  const poster = {
    texts: [{ id: 'title', kind: 'title' as const, text: '{name}', travels: true }],
    groups: { hud: { travels: false } },
    members: { hud: { time: { travels: true } } },
  };

  it('frame, row break, poster keys and travels survive save and a share link', async () => {
    const piece = parsed({ ...base(), camera, poster });
    expect(piece.camera).toEqual(camera);
    expect(piece.poster).toEqual(poster);
    const back = await open(await encodeShareLink(piece, BASE));
    expect(back).toEqual(piece);
    // Keys without an ease pack flat; one with an ease stays an object.
    const packed = packPiece(piece) as { camera: { posterKeys: unknown[] } };
    expect(packed.camera.posterKeys.every((k) => typeof k === 'number')).toBe(false);
    const plain = parsed({ ...base(), camera: { ...camera, posterKeys: [camera.posterKeys[0]] } });
    expect((packPiece(plain) as { camera: { posterKeys: unknown } }).camera.posterKeys).toEqual([
      0, 0.5, 0.25, 0.3,
    ]);
    expect(await open(await encodeShareLink(plain, BASE))).toEqual(plain);
  });

  it('the schema refuses a bad frame, row break or poster key', () => {
    for (const cam of [
      { mode: 'follow', frame: 'page' },
      { mode: 'follow', rowBreak: 'wipe' },
      { mode: 'keys', posterKeys: [{ at: 0, x: 0.5, y: 0.5, h: 0 }] },
      {
        mode: 'keys',
        posterKeys: [
          { at: 2, x: 0.5, y: 0.5, h: 1 },
          { at: 1, x: 0.5, y: 0.5, h: 1 },
        ],
      },
    ])
      expect(parsePiece({ ...base(), camera: cam }).ok).toBe(false);
  });
});

describe('the video in the piece (M17)', () => {
  const kite = () => example('songs/kite-day');
  const video = {
    aspect: '9:16' as const,
    window: 12.5,
    hud: ['time', 'chord'],
    hudLayout: { time: { anchor: 'bl', x: 0.03, y: -0.04 } },
    section: { start: 4, end: 30 },
    fadeIn: 1,
    titleCard: true,
    subtitle: 'for Sam',
    fadeOut: 1.5,
    endCard: 10,
    credit: '',
    look: { theme: 'dark', glow: 0.4, playhead: false },
  };

  it('survives save and a share link, packed short; an empty record too', async () => {
    const piece = parsed({ ...kite(), video });
    expect(piece.video).toEqual(video);
    expect(await open(await encodeShareLink(piece, BASE))).toEqual(piece);
    const packed = packPiece(piece) as { video: Record<string, unknown> };
    expect(packed.video).toMatchObject({ a: '9:16', s: [4, 30], h: 'time,chord' });
    expect(packed.video.H).toEqual({ time: ['bl', 0.03, -0.04] });
    expect(unpackPiece(JSON.parse(JSON.stringify(packed)))).toMatchObject({ video });
    const empty = parsed({ ...kite(), video: {} });
    expect(await open(await encodeShareLink(empty, BASE))).toEqual(empty);
    const none = parsed({ ...kite(), video: { hud: [] } });
    expect(await open(await encodeShareLink(none, BASE))).toEqual(none);
    // A field this version doesn't know keeps the record as written.
    const later = parsed({ ...kite(), video: { ...video, wipe: 'iris' } });
    expect(await open(await encodeShareLink(later, BASE))).toEqual(later);
  });

  it('an edited video (aspect, window, HUD, section, cards, Look) adds under 160 characters to Kite Day’s link', async () => {
    const plain = await encodeShareLink(kite(), BASE);
    const edited = await encodeShareLink(parsed({ ...kite(), video }), BASE);
    expect(edited.length - plain.length).toBeLessThan(160);
  });

  it('a piece without a record links as before', async () => {
    const piece = kite();
    expect(piece.video).toBeUndefined();
    expect(packPiece(piece)).not.toHaveProperty('video');
  });

  it('the schema refuses a bad aspect, fade, section or playhead place', () => {
    for (const v of [
      { aspect: '4:3' },
      { fadeIn: 4 },
      { section: { start: 5, end: 5 } },
      { followAt: 95 },
      { window: 0 },
      { hud: 'time' },
    ])
      expect(parsePiece({ ...kite(), video: v }).ok).toBe(false);
  });
});
