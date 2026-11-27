/** The poster layout engine (PLAN.md §15 M14 P1): type scale, margins, fit, groups, layers. */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import type { Piece, PosterDoc } from '../../../src/core/types';
import {
  DEFAULT_POSTER_TEXTS,
  EXPORT_LOOK,
  POSTER_LOOK,
  fillTokens,
  layoutPoster,
  lookStyle,
  posterIssues,
  posterLook,
  posterUnit,
  textTokens,
  type LabelObject,
  type Look,
  type PosterLayout,
  type TextObject,
} from '../../../src/render';

const SONGS = join(import.meta.dirname, '../../../examples/songs');
function song(name: string): Piece {
  const r = parsePiece(JSON.parse(readFileSync(join(SONGS, `${name}.algorhythms.json`), 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}
const KITE = song('kite-day');
const KITE_C = compile(KITE);
const SIZES = {
  wide: { w: 3840, h: 2160 },
  square: { w: 2160, h: 2160 },
  a4: { w: 2480, h: 3508 },
};

const lay = (
  o: { doc?: PosterDoc; look?: Look; size?: { w: number; h: number }; rows?: number } = {},
) =>
  layoutPoster({
    compiled: KITE_C,
    piece: KITE,
    ...(o.doc ? { doc: o.doc } : {}),
    ...(o.look ? { look: o.look } : {}),
    base: { size: o.size ?? SIZES.wide, ...(o.rows ? { rows: o.rows } : {}) },
  });
const of = <T extends string>(L: PosterLayout, group: T) =>
  L.objects.filter((o) => o.group === group);
const text = (L: PosterLayout, id: string) =>
  L.objects.find((o): o is TextObject => o.type === 'text' && o.member === id);
const GUIDES: Look = { ...EXPORT_LOOK, guides: true, guideLabels: true };

describe('type scale', () => {
  it('is the shorter side / 480: 4.5 px at 16:9 4K and square, so today’s poster ratio', () => {
    expect(posterUnit(3840, 2160)).toBe(4.5);
    expect(posterUnit(2160, 2160)).toBe(4.5);
    expect(posterUnit(2480, 3508)).toBeCloseTo(2480 / 480, 12);
  });

  it('sizes text, gaps and lines by it, so every shape looks alike', () => {
    for (const size of Object.values(SIZES)) {
      const L = lay({ size, look: GUIDES });
      const S = Math.min(size.w, size.h);
      const label = of(L, 'guideLabels')[0] as LabelObject;
      expect(label.size / S).toBeCloseTo(9 / 480, 9);
      const sec = of(L, 'sectionLabels')[0] as LabelObject;
      expect(sec.size / S).toBeCloseTo(9.5 / 480, 9);
      expect(text(L, 'title')!.size / S).toBeCloseTo(0.075, 9);
      const line = L.objects.find((o) => o.type === 'line')!;
      expect(line.type === 'line' && line.width / S).toBeCloseTo(1 / 480, 9);
      expect(L.margins.left / S).toBeCloseTo(0.06, 9);
    }
  });
});

describe('margins and the default fit', () => {
  it('keeps text and music inside the margins', () => {
    for (const size of Object.values(SIZES)) {
      const L = lay({ size, look: GUIDES, rows: 3 });
      expect(posterIssues(L)).toEqual([]);
      for (const l of L.layers) {
        const b = l.bounds!;
        expect(b.x).toBeGreaterThanOrEqual(L.content.x - 1e-6);
        expect(b.x + b.w).toBeLessThanOrEqual(L.content.x + L.content.w + 1e-6);
        expect(b.y + b.h).toBeLessThanOrEqual(L.content.y + L.content.h + 1e-6);
      }
    }
  });

  it('moves everything with the margins', () => {
    const a = lay();
    const b = lay({ doc: { margins: { top: 0.1, right: 0.02, bottom: 0.15, left: 0.2 } } });
    expect(b.content).toEqual({ x: 432, y: 216, w: 3840 - 432 - 43.2, h: 2160 - 216 - 324 });
    expect(text(b, 'title')!.box.x).toBeCloseTo(432, 9);
    expect(b.music.x).toBeCloseTo(432, 9);
    expect(b.music.y + b.music.h).toBeCloseTo(2160 - 324, 9);
    expect(a.music.x).not.toBe(b.music.x);
  });

  it('reserves a band for the text boxes and fits the music below it', () => {
    const L = lay();
    expect(L.band).not.toBeNull();
    const title = text(L, 'title')!;
    const credit = text(L, 'credit')!;
    expect(title.box.y).toBeGreaterThanOrEqual(L.band!.y);
    expect(credit.box.y + credit.box.h).toBeLessThanOrEqual(L.band!.y + L.band!.h + 1e-6);
    expect(L.music.y).toBeGreaterThan(L.band!.y + L.band!.h);
    const none = lay({ doc: { texts: [] } });
    expect(none.band).toBeNull();
    expect(none.music.y).toBe(none.content.y);
    expect(none.music.h).toBeGreaterThan(L.music.h);
  });

  it('a placed text box leaves the band to the others', () => {
    const L = lay({
      doc: {
        texts: [
          { id: 'title', kind: 'title', text: '{name}', box: { x: 0.6, y: 0.85, w: 0.3, h: 0.08 } },
          { id: 'credit', kind: 'credit', text: '{meta}' },
        ],
      },
    });
    const t = text(L, 'title')!;
    expect(t.auto).toBe(false);
    expect(t.frame).toEqual({ x: 0.6 * 3840, y: 0.85 * 2160, w: 0.3 * 3840, h: 0.08 * 2160 });
    expect(t.size).toBeCloseTo((0.08 * 2160) / 1.2, 6);
    expect(L.band!.h).toBeLessThan(lay().band!.h);
  });

  it('shrinks a text too wide for its box rather than clip it', () => {
    const L = lay({
      doc: {
        texts: [
          {
            id: 't',
            kind: 'free',
            text: 'A long line of words',
            box: { x: 0.1, y: 0.1, w: 0.05, h: 0.1 },
          },
        ],
      },
    });
    const t = text(L, 't')!;
    expect(t.box.w).toBeLessThanOrEqual(t.frame.w + 1e-6);
  });
});

describe('text boxes', () => {
  it('start as today’s title block: the name, then length · key · credit', () => {
    const L = lay();
    expect(text(L, 'title')!.runs[0].text).toBe('Kite Day');
    expect(text(L, 'credit')!.runs[0].text).toBe('1:48 · C pentatonic major · AlgoRhythms');
    const sec = layoutPoster({
      compiled: KITE_C,
      piece: KITE,
      base: { section: { start: 30, end: 75 } },
    });
    expect(text(sec, 'credit')!.runs[0].text).toBe(
      '0:45 · 0:30–1:15 of 1:48 · C pentatonic major · AlgoRhythms',
    );
  });

  it('fills tokens and keeps unknown ones', () => {
    const t = textTokens(KITE_C, KITE, null);
    expect(fillTokens('{name} in {key}, {length} {tempo} {nope}', t)).toBe(
      'Kite Day in C pentatonic major, 1:48 100 bpm {nope}',
    );
  });

  it('draws nothing for a hidden text and splits lines', () => {
    const L = lay({
      doc: {
        texts: [
          { id: 'title', kind: 'title', text: '{name}', hidden: true },
          { id: 'two', kind: 'subtitle', text: 'one\ntwo' },
        ],
      },
    });
    expect(text(L, 'title')).toBeUndefined();
    expect(text(L, 'two')!.runs.map((r) => r.text)).toEqual(['one', 'two']);
  });
});

describe('label and line groups', () => {
  it('an old Look’s sections switch shows labels and lines', () => {
    const L = lay({ look: { ...EXPORT_LOOK, sections: true } });
    expect(of(L, 'sectionLabels').length).toBeGreaterThan(0);
    expect(of(L, 'sectionLines').length).toBe(of(L, 'sectionLabels').length);
  });

  it('toggles labels and their lines separately (Look and group styles)', () => {
    const labelsOnly = lay({ look: { ...EXPORT_LOOK, sectionLines: false } });
    expect(of(labelsOnly, 'sectionLabels').length).toBeGreaterThan(0);
    expect(of(labelsOnly, 'sectionLines')).toEqual([]);
    const linesOnly = lay({ doc: { groups: { sectionLabels: { visible: false } } } });
    expect(of(linesOnly, 'sectionLabels')).toEqual([]);
    expect(of(linesOnly, 'sectionLines').length).toBeGreaterThan(0);
    const guideLabels = lay({ look: GUIDES, doc: { groups: { guideLines: { visible: false } } } });
    expect(of(guideLabels, 'guideLabels').length).toBeGreaterThan(0);
    expect(of(guideLabels, 'guideLines')).toEqual([]);
    const momentLabels = lay({ look: { ...EXPORT_LOOK, momentLabels: true } });
    expect(of(momentLabels, 'momentLabels').length).toBeGreaterThan(0);
    expect(of(momentLabels, 'momentLines')).toEqual([]);
  });

  it('a group style restyles every member; a member style only that one', () => {
    const base = lay({ look: GUIDES });
    const big = lay({
      look: GUIDES,
      doc: { groups: { guideLabels: { size: 1.5, colour: '#ff0000' } } },
    });
    const a = of(base, 'guideLabels') as LabelObject[];
    const b = of(big, 'guideLabels') as LabelObject[];
    expect(b.length).toBe(a.length);
    for (const o of b) {
      expect(o.size).toBeCloseTo(a[0].size * 1.5, 9);
      expect(o.colour).toBe('#ff0000');
    }
    const one = lay({
      look: GUIDES,
      doc: { members: { guideLabels: { '69': { colour: '#00ff00', dx: 0.01 } } } },
    });
    const os = of(one, 'guideLabels') as LabelObject[];
    expect(os.filter((o) => o.colour === '#00ff00').map((o) => o.member)).toEqual(['69']);
    const moved = os.find((o) => o.member === '69')!;
    const was = a.find((o) => o.member === '69')!;
    expect(moved.box.x - was.box.x).toBeCloseTo(0.01 * 2160, 6);
    const hidden = lay({
      look: GUIDES,
      doc: { members: { guideLabels: { '69': { visible: false } } } },
    });
    expect(of(hidden, 'guideLabels').map((o) => o.member)).not.toContain('69');
    expect(of(hidden, 'guideLines').map((o) => o.member)).toContain('69');
  });

  it('line styles: width, dash and a short tick', () => {
    const L = lay({
      doc: { groups: { sectionLines: { width: 2, dashed: true, extent: 'tick' } } },
    });
    const line = of(L, 'sectionLines')[0];
    expect(line.type).toBe('line');
    if (line.type !== 'line') return;
    expect(line.width).toBeCloseTo(9, 9);
    expect(line.dash).toEqual([27, 18]);
    expect(line.y1 - line.y0).toBeCloseTo(12 * 4.5, 9);
  });

  it('places the Hz labels in a gutter left of the plot, centred on their lines', () => {
    const L = lay({ look: GUIDES });
    const row = L.rows[0];
    for (const o of of(L, 'guideLabels') as LabelObject[]) {
      expect(o.box.x + o.box.w).toBeLessThanOrEqual(row.plot.x + 1e-6);
      const line = L.objects.find((x) => x.group === 'guideLines' && x.member === o.member)!;
      expect(Math.abs(o.box.y + o.box.h / 2 - line.box.y)).toBeLessThan(o.size * 0.5);
    }
  });

  it('shifts colliding labels and hides what cannot fit', () => {
    const L = lay({ look: { ...EXPORT_LOOK, momentLabels: true }, size: { w: 1200, h: 800 } });
    expect(L.hidden.length).toBeGreaterThan(0);
    expect(posterIssues(L)).toEqual([]);
  });

  it('the hint takes no room: the band, music and labels are as without it', () => {
    const noHint = { texts: DEFAULT_POSTER_TEXTS.filter((t) => t.id !== 'hint') };
    for (const size of Object.values(SIZES)) {
      for (const rows of [1, 3]) {
        const look = { ...EXPORT_LOOK, momentLabels: true, hud: ['time' as const, 'key' as const] };
        const a = lay({ size, rows, look });
        const b = lay({ size, rows, look, doc: noHint });
        expect(a.band).toEqual(b.band);
        expect(a.music).toEqual(b.music);
        const rest = (L: PosterLayout) => L.objects.filter((o) => o.member !== 'hint');
        expect(rest(a)).toEqual(rest(b));
        expect(a.hidden).toEqual(b.hidden);
        // Shown at every preset size for Kite Day, inside the band, right-aligned.
        const h = text(a, 'hint')!;
        expect(h, `${size.w}×${size.h}`).toBeDefined();
        expect(h.box.x + h.box.w).toBeCloseTo(a.band!.x + a.band!.w, 0);
        expect(h.box.y).toBeGreaterThanOrEqual(a.band!.y - 1);
        expect(h.box.y + h.box.h).toBeLessThanOrEqual(a.band!.y + a.band!.h + 1);
        expect(posterIssues(a)).toEqual([]);
      }
    }
  });

  it('the hint is the lowest-priority text: it hides before a readout, label or text box', () => {
    const L0 = lay({ look: { ...EXPORT_LOOK, hud: ['time'] } });
    const hint = text(L0, 'hint')!;
    expect(hint).toBeDefined();
    // A readout placed on the hint keeps its place; the hint goes.
    const at = { anchor: 'tl' as const, x: hint.box.x / L0.width, y: hint.box.y / L0.height };
    const L = lay({ look: { ...EXPORT_LOOK, hud: ['time'], hudLayout: { time: at } } });
    const time = of(L, 'hud').find((o) => o.member === 'time') as LabelObject | undefined;
    expect(time).toBeDefined();
    expect(time!.box.x).toBeCloseTo(hint.box.x, 0);
    expect(L.hidden.map((o) => o.member)).not.toContain('time');
    expect(text(L, 'hint')).toBeUndefined();
    expect(text(L, 'credit')).toBeDefined();
    expect(posterIssues(L)).toEqual([]);
    // A text box placed over it: the box stays, the hint goes.
    const box = { x: hint.box.x / L0.width, y: hint.box.y / L0.height, w: 0.2, h: 0.03 };
    const texts = [
      ...DEFAULT_POSTER_TEXTS,
      { id: 'text1', kind: 'free' as const, text: 'Hi', box },
    ];
    const T = lay({ doc: { texts } });
    expect(text(T, 'text1')).toBeDefined();
    expect(text(T, 'hint')).toBeUndefined();
  });

  it('ignores invalid Look overrides', () => {
    const look = posterLook(POSTER_LOOK, {
      look: { theme: 'sepia', guides: 'yes', glow: 2, vignette: 0.5 },
    });
    expect(look.theme).toBe(POSTER_LOOK.theme);
    expect(look.guides).toBe(POSTER_LOOK.guides);
    expect(look.glow).toBeUndefined();
    expect(look.vignette).toBe(0.5);
  });

  it('lookStyle splits section lines from labels; an old Look draws as before', () => {
    expect(lookStyle({ ...EXPORT_LOOK }).sectionLines).toBeUndefined();
    expect(lookStyle({ ...EXPORT_LOOK, sectionLines: true }).sectionLines).toBeUndefined();
    expect(lookStyle({ ...EXPORT_LOOK, sectionLines: false }).sectionLines).toBe(false);
  });
});

describe('rows', () => {
  it('splits the music area, one pitch range and time scale for all', () => {
    const L = lay({ rows: 3 });
    expect(L.rows.length).toBe(3);
    const pps = L.rows.map((r) => r.plot.w / (r.end - r.start));
    for (const p of pps) expect(p).toBeCloseTo(pps[0], 6);
    for (let i = 1; i < 3; i++)
      expect(L.rows[i].rect.y).toBeGreaterThan(L.rows[i - 1].rect.y + L.rows[i - 1].rect.h);
    expect(of(L, 'rowLabels').map((o) => (o as LabelObject).runs[0].text)).toEqual([
      '0:36',
      '1:12',
    ]);
  });

  it('never cuts a row under 2 s', () => {
    const L = layoutPoster({
      compiled: KITE_C,
      piece: KITE,
      base: { rows: 8, section: { start: 10, end: 15 } },
    });
    expect(L.rows.length).toBe(2);
  });
});

describe('layers', () => {
  it('a layer per part, filling the music area', () => {
    const L = lay();
    expect(L.layers.map((l) => l.id)).toEqual([
      'part:Melody',
      'part:Chords',
      'part:Bass',
      'part:Sparkle',
    ]);
    const plot = L.rows[0].plot;
    for (const l of L.layers) {
      expect(l.box).toEqual(plot);
      expect(l.frames[0].rect).toEqual(plot);
    }
  });

  it('a part’s box moves and stretches its frames', () => {
    const L = lay({
      doc: { layers: [{ id: 'part:Melody', box: { x: 0.5, y: 0.5, w: 0.25, h: 0.1 } }] },
    });
    const m = L.layers.find((l) => l.id === 'part:Melody')!;
    const want = { x: 1920, y: 1080, w: 960, h: 216 };
    for (const k of ['x', 'y', 'w', 'h'] as const) {
      expect(m.box[k]).toBeCloseTo(want[k], 9);
      expect(m.frames[0].rect[k]).toBeCloseTo(want[k], 9);
    }
    expect(m.bounds!.x).toBeGreaterThanOrEqual(1920 - 1e-6);
    expect(m.bounds!.y + m.bounds!.h).toBeLessThanOrEqual(1080 + 216 + 1e-6);
  });

  it('draws parts in the doc’s order; a line with a box is a layer of its own inside its part', () => {
    const v = KITE.voices.findIndex((x) => x.part === 'Chords');
    const id = KITE.voices[v].id;
    const L = lay({
      doc: {
        layers: [
          { id: 'part:Bass' },
          { id: `line:${id}`, box: { x: 0, y: 0, w: 0.5, h: 0.5 }, colour: '#123456' },
          { id: 'part:Sparkle', hidden: true },
        ],
      },
    });
    expect(L.layers.map((l) => l.id)).toEqual([
      'part:Bass',
      'part:Sparkle',
      'part:Melody',
      'part:Chords',
      `line:${id}`,
    ]);
    const chords = L.layers.find((l) => l.id === 'part:Chords')!;
    const line = L.layers.find((l) => l.id === `line:${id}`)!;
    expect(chords.voices).not.toContain(v);
    expect(line.voices).toEqual([v]);
    expect(line.box).toEqual({
      x: chords.box.x,
      y: chords.box.y,
      w: chords.box.w / 2,
      h: chords.box.h / 2,
    });
    expect(line.colour).toBe('#123456');
    expect(L.objects.some((o) => o.type === 'layer' && o.member === 'part:Sparkle')).toBe(false);
  });

  it('a hidden line leaves its part', () => {
    const v = KITE.voices.findIndex((x) => x.part === 'Chords');
    const L = lay({ doc: { layers: [{ id: `line:${KITE.voices[v].id}`, hidden: true }] } });
    expect(L.layers.find((l) => l.id === 'part:Chords')!.voices).not.toContain(v);
  });

  it('colours from the layers by pool index', () => {
    const v = KITE.voices.findIndex((x) => x.part === 'Chords');
    const L = lay({
      doc: {
        layers: [
          { id: 'part:Chords', colour: '#aa0000' },
          { id: `line:${KITE.voices[v].id}`, colour: '#00aa00' },
        ],
      },
    });
    const vc = L.voiceColors!;
    KITE.voices.forEach((def, i) => {
      if (i === v) expect(vc[i]).toBe('#00aa00');
      else expect(vc[i]).toBe(def.part === 'Chords' ? '#aa0000' : undefined);
    });
    expect(lay().voiceColors).toBeUndefined();
  });
});
