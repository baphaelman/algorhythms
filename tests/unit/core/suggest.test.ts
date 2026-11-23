/** Next-move suggestions (PLAN.md §11.3, revisions 6 and 14): `suggestNext` and friends. */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseChord } from '../../../src/core/chords';
import { diatonicChords } from '../../../src/core/chord-spec';
import { compile } from '../../../src/core/compiler/compile';
import { momentEffectAt } from '../../../src/core/effect';
import { generate } from '../../../src/core/generate';
import { keyAt } from '../../../src/core/query';
import { SCALE_NAMES, pitchClassOf } from '../../../src/core/scales';
import { parsePiece } from '../../../src/core/schema';
import {
  SUGGEST_ID,
  chordDefaultAt,
  chordPickerRanks,
  suggestNext,
} from '../../../src/core/suggest';
import { matchChord, theoryOf } from '../../../src/core/theory';
import type { CompiledScore, Key, Moment, Piece } from '../../../src/core/types';
import { chordAt, piece } from './compiler-fixtures';
import { progression } from './progression-fixture';

const EXAMPLES = join(import.meta.dirname, '../../../examples');
const examples: [string, Piece][] = readdirSync(EXAMPLES)
  .filter((f) => f.endsWith('.algorhythms.json'))
  .map((f) => {
    const r = parsePiece(readFileSync(join(EXAMPLES, f), 'utf8'));
    if (!r.ok) throw new Error(f);
    return [f, r.piece];
  });

const withMoment = (p: Piece, m: Moment): Piece => ({
  ...p,
  moments: [...p.moments, { ...m, id: 'sugg01' }].sort((a, b) => a.at - b.at),
});

const C: Key = { tonic: 'C', scale: 'major' };
const Am: Key = { tonic: 'A', scale: 'minor' };
const LABEL = /^(Home|Near home|Lift|Tension|Surprise) · [A-G]/;

const symbolOf = (m: Moment): string =>
  m.type === 'chord' && m.notes.kind === 'chord' ? m.notes.symbol : '';

/** The harmony entry the suggested moment sets once added. */
function entryOf(p: Piece, m: Moment): NonNullable<CompiledScore['harmony']>[number] {
  const s = compile(withMoment(p, m));
  return s.harmony!.find((h) => h.momentId === 'sugg01')!;
}

describe('suggestNext: theory cards (revision 14)', () => {
  it('M10: after I–V–vi–IV the best card is Home; after V it is Home; i–♭VII–♭VI → V', () => {
    const cases: [Key, string[], RegExp][] = [
      [C, ['I', 'V', 'vi', 'IV'], /^Home · C$/],
      [C, ['V'], /^Home · C$/],
      [C, ['Imaj7', 'V7', 'vi7', 'IVmaj7'], /^Home · Cmaj7$/],
      [Am, ['i', 'bVII', 'bVI'], /^Tension · E$/],
      [Am, ['i7', 'bVII7', 'bVImaj7'], /^Tension · E7$/],
    ];
    for (const [key, syms, want] of cases) {
      const p = progression(key, syms);
      const su = suggestNext(p, compile(p), 4 * syms.length);
      expect(su[0].label, syms.join('–')).toMatch(want);
      expect(su[0].best).toBe(true);
      expect(su.slice(1).every((x) => !x.best)).toBe(true);
      expect(su.length).toBeLessThanOrEqual(4);
      expect(new Set(su.map((x) => x.job)).size).toBe(su.length);
      for (const x of su) {
        expect(x.kind).toBe('chord');
        expect(x.label).toMatch(LABEL);
        expect(x.tooltip).toMatch(/^[♭]?[ivIV]+.* — \S/);
        expect(x.tooltip.split(' — ')[1].split(/\s+/).length).toBeLessThanOrEqual(6);
        expect(x.moment).toMatchObject({ id: SUGGEST_ID, at: 4 * syms.length, voicing: 'even' });
        expect(x.moment.seed).toBeTypeOf('number');
      }
    }
  });

  it('a seventh chord for four or more lines, else a triad', () => {
    const tri = progression(C, ['I', 'V']);
    for (const x of suggestNext(tri, compile(tri), 8))
      expect(parseChord(symbolOf(x.moment), C)).toMatchObject({ ok: true, pcs: { length: 3 } });
    const sev = progression(C, ['Imaj7', 'V7']);
    for (const x of suggestNext(sev, compile(sev), 8)) expect(symbolOf(x.moment)).toMatch(/7/);
  });

  it('each card compiles to the chord its label names, and follows a later key change', () => {
    for (const [key, syms] of [
      [C, ['I', 'V', 'vi', 'IV']],
      [C, ['Imaj7', 'V7', 'vi7']],
      [Am, ['i', 'bVII', 'bVI']],
      [{ tonic: 'D', scale: 'dorian' }, ['i', 'IV']],
      [{ tonic: 'G', scale: 'mixolydian' }, ['I', 'bVII']],
    ] as [Key, string[]][]) {
      const p = progression(key, syms);
      const t = 4 * syms.length;
      const th = theoryOf(key)!;
      for (const x of suggestNext(p, compile(p), t)) {
        const sym = symbolOf(x.moment);
        const chord = parseChord(sym, key);
        if (!chord.ok) throw new Error(sym);
        const e = entryOf(p, x.moment);
        expect(e.label.endsWith(x.label.split(' · ')[1]), `${x.label}: ${e.label}`).toBe(true);
        expect(
          e.pcs.every((pc) => chord.pcs.includes(pc)),
          `${x.label}: ${e.pcs}`,
        ).toBe(true);
        expect(e.pcs.includes(chord.root), `${x.label}: ${e.pcs}`).toBe(true);
        expect(matchChord(th, e.pcs, e.bass), x.label).toBe(
          sym.replace(/maj7|ø7|7/, (s) => (s === 'ø7' ? '°' : '')),
        );
        // A key moment written later, before the card: the card follows it (a numeral).
        const up: Moment = {
          id: 'k2',
          type: 'key',
          at: t - 1,
          key: { tonic: 'E', scale: key.scale },
        } as Moment;
        const moved = entryOf({ ...p, moments: [...p.moments, up] }, x.moment);
        const shift = (pitchClassOf('E') - pitchClassOf(key.tonic) + 12) % 12;
        expect(moved.pcs.map((pc) => (pc - shift + 12) % 12).sort(), x.label).toEqual(
          [...e.pcs].sort(),
        );
      }
    }
  });

  it('every built-in scale gets job cards with no two of one job, or the old grammar; never a no-op', () => {
    for (const scale of SCALE_NAMES) {
      const key = { tonic: 'D', scale } as Key;
      const p = piece({ start: [50, 57, 62, 65], key, end: { at: 30, fade: 1 } });
      const s = compile(p);
      const su = suggestNext(p, s, 4);
      expect(su.length, scale).toBeGreaterThanOrEqual(2);
      if (theoryOf(key)) {
        expect(
          su.every((x) => x.kind === 'chord' && LABEL.test(x.label)),
          scale,
        ).toBe(true);
        expect(new Set(su.map((x) => x.job)).size).toBe(su.length);
      } else {
        expect(
          su.some((x) => x.job !== undefined || LABEL.test(x.label)),
          scale,
        ).toBe(false);
      }
      for (const x of su) {
        expect(momentEffectAt(p, s, x.moment).effect, `${scale}: ${x.label}`).toBe(true);
        const bad = compile(withMoment(p, x.moment)).diagnostics.filter(
          (d) => d.momentId === 'sugg01' && (d.level === 'error' || d.code === 'no-effect'),
        );
        expect(bad, `${scale}: ${x.label}`).toEqual([]);
      }
    }
  });

  it('from silence: Home (the tonic triad) and One note (the tonic)', () => {
    const p = piece({ start: [], moments: [], key: C });
    expect(suggestNext(p, compile(p), 1).map((x) => x.label)).toEqual(['Home · C', 'One note · C']);
    const m = piece({ start: [], moments: [], key: Am });
    const su = suggestNext(m, compile(m), 1);
    expect(su.map((x) => x.label)).toEqual(['Home · Am', 'One note · A']);
    expect(su[0].moment).toMatchObject({ type: 'chord', notes: { kind: 'chord', symbol: 'i' } });
    expect(su[1].moment).toMatchObject({ type: 'unison', pitch: 'tonic' });
    expect(suggestNext(m, compile(m), 1, 1)).toHaveLength(1);
  });

  it('is deterministic', () => {
    const p = progression(Am, ['i', 'iv', 'bVII']);
    const s = compile(p);
    expect(suggestNext(p, s, 12)).toEqual(suggestNext(p, s, 12));
    const g = generate(7);
    const gs = compile(g);
    expect(suggestNext(g, gs, 40)).toEqual(suggestNext(g, gs, 40));
  });
});

describe('suggestNext: examples', () => {
  it('every suggestion compiles without errors and is not flagged no-effect (all examples)', () => {
    let total = 0;
    for (const [name, ex] of examples) {
      const s = compile(ex);
      for (let i = 0; i < 6; i++) {
        const t = Math.round(((i + 0.5) / 6) * s.duration * 0.9 * 1000) / 1000;
        const su = suggestNext(ex, s, t);
        expect(su.length, `${name} @ ${t}`).toBeGreaterThanOrEqual(2);
        expect(new Set(su.map((x) => x.label)).size).toBe(su.length);
        for (const x of su) {
          total++;
          expect(momentEffectAt(ex, s, x.moment).effect, `${name} @ ${t}: ${x.label}`).toBe(true);
          const out = compile(withMoment(ex, x.moment));
          const bad = out.diagnostics.filter(
            (d) => d.momentId === 'sugg01' && (d.level === 'error' || d.code === 'no-effect'),
          );
          expect(bad, `${name} @ ${t}: ${x.label}`).toEqual([]);
          expect(out.diagnostics.filter((d) => d.level === 'error')).toEqual([]);
        }
      }
    }
    expect(total).toBeGreaterThan(60);
  });
});

describe('chordDefaultAt (Add → Chord)', () => {
  it('links the chord before to the next one; best next when nothing follows; tonic from silence', () => {
    // I at 0, V at 4: rebuild with V at 8 so there's a gap to add into.
    const p = progression(C, ['I', 'V']);
    p.moments = p.moments.map((m) => (m.at === 4 ? { ...m, at: 8 } : m));
    const s = compile(p);
    expect(chordDefaultAt(p, s, 4)).toMatchObject({
      moment: { type: 'chord', notes: { kind: 'chord', symbol: 'IV' }, voicing: 'even' },
      job: 'lift',
      name: 'F',
    });
    const loop = progression(C, ['I', 'V', 'vi', 'IV']);
    expect(chordDefaultAt(loop, compile(loop), 18)?.moment.notes).toEqual({
      kind: 'chord',
      symbol: 'I',
    });
    const sev = progression(C, ['IVmaj7', 'V7']);
    expect(chordDefaultAt(sev, compile(sev), 10)?.name).toBe('Cmaj7');
    const silent = piece({ start: [], moments: [], key: Am });
    expect(chordDefaultAt(silent, compile(silent), 2)).toMatchObject({
      moment: { notes: { symbol: 'i' } },
      name: 'Am',
    });
    const loc = piece({ start: [], moments: [], key: { tonic: 'B', scale: 'locrian' } });
    expect(chordDefaultAt(loc, compile(loc), 2)).toBeNull();
  });
});

describe('chordPickerRanks', () => {
  it('ranks the key’s diatonic chips for the selected chord’s spot', () => {
    const p = progression(C, ['ii', 'IV', 'I']);
    const s = compile(p);
    const id = p.moments.find((m) => m.at === 4)!.id;
    const r = chordPickerRanks(p, s, id)!;
    const chips = diatonicChords(C);
    expect(r.map((x) => x.degree)).toEqual(chips.map((c) => c.degree));
    expect(r.map((x) => x.symbol)).toEqual(chips.map((c) => c.symbol));
    expect(r.find((x) => x.rank === 0)!.symbol).toBe('G'); // ii → V → I
    expect(new Set(r.map((x) => x.rank)).size).toBe(r.length);
    // Without neighbours, Home first.
    const one = progression(C, ['IV']);
    const r1 = chordPickerRanks(one, compile(one), one.moments[0].id)!;
    expect(r1.find((x) => x.rank === 0)!.symbol).toBe('C');
    expect(chordPickerRanks(p, s, 'nope')).toBeNull();
  });
});

describe('suggestNext: keys without theory keep the composer grammar', () => {
  const LOC: Key = { tonic: 'B', scale: 'locrian' };

  it('opens a unison, moves, walks; from silence, an opening', () => {
    const uni = piece({ start: [59, 59, 59, 59], key: LOC });
    const su = suggestNext(uni, compile(uni), 2);
    expect(su[0].kind).toBe('open');
    expect(su[0].label).toMatch(/^Open to [A-G]/);
    expect(su[0].tooltip).toBe(su[0].label);
    const ch = piece({ start: [47, 53, 59, 62, 65, 69], key: LOC });
    const labels = suggestNext(ch, compile(ch), 2).map((x) => x.label);
    expect(labels.some((l) => /^Move to [A-G]/.test(l))).toBe(true);
    expect(labels.some((l) => /^Walk (8|12|16) s$/.test(l))).toBe(true);
    const silent = piece({ start: [], moments: [], key: { tonic: 'C', scale: 'whole-tone' } });
    expect(suggestNext(silent, compile(silent), 1).map((x) => x.label)[0]).toMatch(/^Start on /);
  });

  it('a home suggestion follows a key change written after it', () => {
    const ch = piece({ start: [47, 53, 59, 62, 65, 69], key: LOC });
    const late = { ...ch, end: { at: 4, fade: 1 } };
    const x = suggestNext(late, compile(late), 3, 12).find((y) => y.label.startsWith('Home'))!;
    expect(x.moment).toMatchObject({ type: 'unison', pitch: 'tonic' });
    const inB = chordAt(compile(withMoment(ch, x.moment)), 20);
    const inC = chordAt(
      compile(withMoment({ ...ch, key: { tonic: 'C#', scale: 'locrian' } }, x.moment)),
      20,
    );
    expect(inC.map((p, i) => p - inB[i])).toEqual(inB.map(() => 2));
    expect(keyAt(compile(ch), 1).scale).toBe('locrian');
  });
});
