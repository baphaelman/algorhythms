/**
 * The automated layout check (PLAN.md §15 M14 acceptance): for every Song, at 16:9, square and
 * A4 portrait, rows 1–8, the whole piece and a middle section, the default poster has no clipped
 * text, no text outside the margins, no text over other text and no text box over the music.
 * Run with every label group shown too (the defaults show few), so the collision rules are
 * exercised. Rows by sections (M14 P5) too, with row labels edited (short, primed, long).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { Piece } from '../../../src/core/types';
import {
  EXPORT_LOOK,
  layoutPoster,
  posterIssues,
  posterSectionItems,
  setRowSection,
  setRowsBy,
  type Look,
} from '../../../src/render';

const ROOT = join(import.meta.dirname, '../../..');
const DIR = join(ROOT, 'examples', 'songs');
const SONGS = readdirSync(DIR)
  .filter((f) => f.endsWith('.algorhythms.json'))
  .map((f) => {
    const r = parsePiece(JSON.parse(readFileSync(join(DIR, f), 'utf8')));
    if (!r.ok) throw new Error(r.errors.join('; '));
    return { name: f, piece: r.piece as Piece };
  });
const SIZES = [
  { w: 3840, h: 2160 },
  { w: 2160, h: 2160 },
  { w: 2480, h: 3508 },
];

/** Every label and line group on, the HUD too. */
const BUSY: Look = {
  ...EXPORT_LOOK,
  guides: true,
  guideLabels: true,
  markers: true,
  momentLabels: true,
  beats: 'auto',
  pitchGuides: { pitches: [60, 67, 72], labels: true },
  hud: ['formula', 'notes', 'chord', 'key', 'title'],
};

describe('default posters keep the layout rules', () => {
  it('has Songs to check', () => expect(SONGS.length).toBeGreaterThan(4));

  for (const { name, piece } of SONGS) {
    it(name, () => {
      const compiled = compile(piece);
      const D = compiled.duration;
      const middle = { start: D * 0.3, end: D * 0.7 };
      const failures: string[] = [];
      for (const look of [undefined, BUSY]) {
        for (const size of SIZES) {
          for (let rows = 1; rows <= 8; rows++) {
            for (const section of [undefined, middle]) {
              const layout = layoutPoster({
                compiled,
                piece,
                ...(look ? { look } : {}),
                base: { size, rows, ...(section ? { section } : {}) },
              });
              for (const i of posterIssues(layout)) {
                failures.push(
                  `${look ? 'busy' : 'default'} ${size.w}×${size.h} rows ${rows}${section ? ' section' : ''}: ${i.kind} ${i.what.join(' / ')}`,
                );
              }
            }
          }
        }
      }
      expect(failures.slice(0, 20)).toEqual([]);
    });
  }
});

describe('rows by sections keep the layout rules', () => {
  for (const { name, piece } of SONGS) {
    it(name, () => {
      const compiled = compile(piece);
      const D = compiled.duration;
      const failures: string[] = [];
      for (const section of [undefined, { start: D * 0.3, end: D * 0.7 }]) {
        const base = setRowsBy(undefined, 'sections')!;
        const items = posterSectionItems(compiled, piece, base, section ? { section } : {});
        // Row labels as the owner writes them, one long one, one emptied.
        let doc = base;
        const names = ['A', 'B', 'A′', 'B′', 'A rather long row label for a section', ''];
        items.forEach((it, i) => {
          doc = setRowSection(doc, it.id, { label: names[i % names.length] }, it.section)!;
        });
        for (const d of [base, doc]) {
          for (const look of [undefined, BUSY]) {
            for (const size of SIZES) {
              const layout = layoutPoster({
                compiled,
                piece,
                doc: d,
                ...(look ? { look } : {}),
                base: { size, ...(section ? { section } : {}) },
              });
              if (layout.rows.length > 8) failures.push(`${layout.rows.length} rows`);
              for (const i of posterIssues(layout)) {
                failures.push(
                  `${d === base ? 'labels' : 'edited'} ${look ? 'busy' : 'default'} ${size.w}×${size.h}${section ? ' section' : ''}: ${i.kind} ${i.what.join(' / ')}`,
                );
              }
            }
          }
        }
      }
      expect(failures.slice(0, 20)).toEqual([]);
    });
  }
});
