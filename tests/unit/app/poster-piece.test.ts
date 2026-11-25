/** The piece's poster field (PLAN.md §15 M14 P1): schema, canonical numbers, share links. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeShareLink, encodeShareLink } from '../../../src/app/share';
import { canonicalPiece } from '../../../src/core/canonical';
import { parsePiece, stripDefaults } from '../../../src/core/schema';
import type { Piece, PosterDoc } from '../../../src/core/types';

const SONGS = join(import.meta.dirname, '../../../examples/songs');
const BASE = 'https://baphaelman.github.io/algorhythms/';

function parsed(json: unknown): Piece {
  const r = parsePiece(json);
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}

const song = (name: string): Piece =>
  parsed(readFileSync(join(SONGS, `${name}.algorhythms.json`), 'utf8'));

/** A typical poster after a few edits in the workspace. */
const TYPICAL: PosterDoc = {
  size: { w: 2480, h: 3508 },
  rows: 3,
  margins: { top: 0.08, right: 0.08, bottom: 0.08, left: 0.08 },
  look: { theme: 'dark', guides: true, sectionLines: false },
  layers: [
    { id: 'part:Melody', box: { x: 0.1, y: 0.2, w: 0.8, h: 0.3 }, colour: '#e0a040' },
    { id: 'line:v2', hidden: true },
  ],
  texts: [
    { id: 'title', kind: 'title', text: '{name}', style: { size: 0.09 } },
    { id: 'credit', kind: 'credit', text: '{meta} · AlgoRhythms' },
    { id: 'text1', kind: 'free', text: 'for R.', box: { x: 0.7, y: 0.9, w: 0.2, h: 0.03 } },
  ],
  groups: { guideLabels: { size: 1.4, colour: '#888888' }, sectionLabels: { side: 'left' } },
  members: { guideLabels: { '69': { visible: false } } },
};

describe('Piece.poster schema', () => {
  it('reads and keeps a poster; absent stays absent', () => {
    const p = song('kite-day');
    expect(p).not.toHaveProperty('poster');
    const withPoster = parsed({ ...p, poster: TYPICAL });
    expect(withPoster.poster).toEqual(TYPICAL);
    expect(parsed(JSON.parse(JSON.stringify(withPoster)))).toEqual(withPoster);
    expect(parsed(stripDefaults(withPoster))).toEqual(withPoster);
    expect(stripDefaults(withPoster).poster).toEqual(TYPICAL);
    expect(parsed({ ...p, poster: {} }).poster).toEqual({});
  });

  it('refuses bad posters', () => {
    const p = song('kite-day');
    const ok = (poster: unknown) => parsePiece({ ...p, poster }).ok;
    expect(ok({ rows: 9 })).toBe(false);
    expect(ok({ rows: 0 })).toBe(false);
    expect(ok({ size: { w: 10, h: 3000 } })).toBe(false);
    expect(ok({ margins: { top: 0.5, right: 0, bottom: 0, left: 0 } })).toBe(false);
    expect(ok({ section: { start: 10, end: 5 } })).toBe(false);
    expect(ok({ layers: [{ id: 'melody' }] })).toBe(false);
    expect(ok({ layers: [{ id: 'part:A' }, { id: 'part:A' }] })).toBe(false);
    expect(ok({ texts: [{ id: 't', kind: 'banner', text: '' }] })).toBe(false);
    expect(
      ok({ texts: [{ id: 't', kind: 'free', text: 'x', box: { x: 0, y: 0, w: 0, h: 1 } }] }),
    ).toBe(false);
    expect(ok({ groups: { nope: {} } })).toBe(false);
    expect(ok({ groups: { hud: { opacity: 2 } } })).toBe(false);
    expect(ok(TYPICAL)).toBe(true);
  });

  it('keeps unknown fields (a newer build’s)', () => {
    const p = parsed({ ...song('kite-day'), poster: { ...TYPICAL, grain: 0.3 } });
    expect((p.poster as Record<string, unknown>).grain).toBe(0.3);
  });

  it('canonicalises: boxes and margins to 4 digits, factors and opacity as levels, times to 1 ms', () => {
    const p = canonicalPiece({
      ...song('kite-day'),
      poster: {
        section: { start: 1.23456, end: 20.000049 },
        margins: { top: 0.0612345, right: 0.0612345, bottom: 0.0612345, left: 0.0612345 },
        layers: [{ id: 'part:A', box: { x: 0.123456, y: 0.2 + 0.1, w: 0.5, h: 0.333333 } }],
        texts: [
          {
            id: 't',
            kind: 'free',
            text: 'x',
            box: { x: 0.11111, y: 0.22222, w: 0.33333, h: 0.044444 },
            style: { size: 0.0333333, opacity: 0.55555 },
          },
        ],
        groups: { hud: { size: 1.23456, opacity: 0.33333 } },
        members: { guideLabels: { '69': { dx: 0.0123456, width: 2.22222 } } },
      },
    });
    expect(p.poster).toEqual({
      section: { start: 1.235, end: 20 },
      margins: { top: 0.06123, right: 0.06123, bottom: 0.06123, left: 0.06123 },
      layers: [{ id: 'part:A', box: { x: 0.1235, y: 0.3, w: 0.5, h: 0.3333 } }],
      texts: [
        {
          id: 't',
          kind: 'free',
          text: 'x',
          box: { x: 0.1111, y: 0.2222, w: 0.3333, h: 0.04444 },
          style: { size: 0.03333, opacity: 0.556 },
        },
      ],
      groups: { hud: { size: 1.23, opacity: 0.333 } },
      members: { guideLabels: { '69': { dx: 0.01235, width: 2.22 } } },
    });
    expect(canonicalPiece(p)).toBe(p);
  });
});

describe('Piece.poster in share links', () => {
  it('round-trips exactly', async () => {
    const p = canonicalPiece(parsed({ ...song('kite-day'), poster: TYPICAL }));
    const link = await encodeShareLink(p, BASE);
    const back = parsed(await decodeShareLink(link));
    expect(back.poster).toEqual(p.poster);
    expect(back).toEqual(p);
  });

  it('a typical poster adds little to the link', async () => {
    const p = song('kite-day');
    const plain = (await encodeShareLink(p, BASE)).length;
    const typical = (await encodeShareLink(parsed({ ...p, poster: TYPICAL }), BASE)).length;
    const small = (
      await encodeShareLink(parsed({ ...p, poster: { rows: 2, look: { theme: 'dark' } } }), BASE)
    ).length;
    expect(small - plain).toBeLessThan(60);
    expect(typical - plain).toBeLessThan(400);
  });
});
