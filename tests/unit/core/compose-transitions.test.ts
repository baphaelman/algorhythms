/**
 * The directed composer, from the owner's listening notes (PLAN §15 M12, D3): section changes
 * spread over at least a bar and the harmony leads into them; a lone part leads instead of
 * looping.
 *
 * "A line's pattern change": a line's figure is the pulse covering it (its rhythm: step, accents,
 * decay, floor, all lines together or one at a time, bar restart, strike; not an arpeggio's
 * direction) and the walk covering it (grid and steps; not how often it steps), or 'hold' when
 * none does. A line changes pattern at a time
 * where its figure differs from the figure just before, while it is audible (level > 0.05).
 * Lines: those of the parts written as textures (Chords, Pulse, Bells).
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import type { ComposeBrief, ComposePart } from '../../../src/core/compose-brief';
import {
  PART_NAME,
  composeDirectedWithBrief,
  type DirectedComposition,
} from '../../../src/core/compose-directed';
import { composedPiece } from '../../../src/core/generate';
import { pitchAt } from '../../../src/core/query';
import { theoryOf, transition } from '../../../src/core/theory';
import type {
  CompiledScore,
  Moment,
  Piece,
  PulseMoment,
  WalkMoment,
} from '../../../src/core/types';
import { alive, levelAt } from './compose-metrics';

const TEXTURED = new Set([PART_NAME.chords, PART_NAME.pulse, PART_NAME.bells]);

/** The voice ids a moment's target names (a part, parts or voices; anything else: all). */
function targetIds(p: Piece, m: Moment): Set<string> {
  const t = m.target;
  const ids = p.voices.filter((v) => {
    if (!t || t === 'all') return true;
    if ('part' in t) return v.part === t.part;
    if ('parts' in t) return t.parts.includes(v.part ?? '');
    if ('voices' in t) return t.voices.includes(v.id);
    return true;
  });
  return new Set(ids.map((v) => v.id));
}

interface Region {
  at: number;
  until: number;
  ids: Set<string>;
  figure: string;
}

/** Pulse and walk regions with their figures. */
function regions(p: Piece): { pulse: Region[]; walk: Region[] } {
  const pulse: Region[] = [];
  const walk: Region[] = [];
  for (const m of p.moments) {
    if (m.type === 'pulse') {
      const x = m as PulseMoment;
      pulse.push({
        at: x.at,
        until: x.until,
        ids: targetIds(p, m),
        figure: JSON.stringify([
          x.step,
          x.pattern,
          x.decay,
          x.floor,
          x.mode === 'together',
          x.restart ?? 0,
          x.strike ?? true,
        ]),
      });
    } else if (m.type === 'walk') {
      const x = m as WalkMoment;
      walk.push({
        at: x.at,
        until: x.until,
        ids: targetIds(p, m),
        figure: JSON.stringify([x.grid, x.steps, x.over ?? 'key']),
      });
    }
  }
  return { pulse, walk };
}

function figureAt(r: ReturnType<typeof regions>, id: string, t: number): string {
  const find = (rs: Region[]) =>
    rs.find((x) => x.ids.has(id) && x.at <= t + 1e-6 && t < x.until - 1e-6)?.figure ?? '-';
  const pu = find(r.pulse);
  const wa = find(r.walk);
  return pu === '-' && wa === '-' ? 'hold' : `${pu}|${wa}`;
}

/** Each audible textured line's pattern changes within two bars (inclusive) of each section boundary. */
function boundaryChanges(
  d: DirectedComposition,
  p: Piece,
  score: CompiledScore,
): { at: number; bar: number; changes: { id: string; part: string; t: number }[] }[] {
  const beat = 60 / p.view.gridBpm!;
  const bar = beat * p.view.meter!;
  const r = regions(p);
  const lines = p.voices.filter((v) => TEXTURED.has(v.part ?? ''));
  return d.sections.slice(1).map((s) => {
    const changes: { id: string; part: string; t: number }[] = [];
    for (const v of lines) {
      const cv = score.voices[p.voices.indexOf(v)];
      let before = figureAt(r, v.id, s.at - 2 * bar - beat / 4);
      // To two bars after, inclusive (a slow piece hands over across two bars).
      for (let k = -8; k <= 16 * p.view.meter!; k++) {
        const t = s.at - 2 * bar + (k * beat) / 4;
        const f = figureAt(r, v.id, t + 2e-3); // moment times are on a 1 ms grid
        // A line coming in or going out is a fade, not a change of pattern.
        const heardAt = (x: number) => alive(cv, x) && levelAt(cv, x) > 0.05;
        const heard = heardAt(t - beat / 2) && heardAt(t + 0.01);
        if (f !== before && heard && t >= s.at - 2 * bar - 1e-6)
          changes.push({ id: v.id, part: v.part!, t });
        before = f;
      }
    }
    return { at: s.at, bar, changes };
  });
}

const BRIEFS: ComposeBrief[] = [
  { seed: 2771674892, mood: 'dreamy', parts: ['chords'], shape: 'arc', length: 120 },
  { seed: 404, mood: 'dark', length: 120, shape: 'journey', parts: ['chords', 'bass', 'pulse'] },
  { seed: 7, mood: 'driving', length: 120, shape: 'build' },
  { seed: 8, mood: 'calm', length: 120, shape: 'arc', parts: ['chords', 'bells', 'melody'] },
  { seed: 9, mood: 'bright', length: 120, shape: 'journey', parts: ['pulse', 'bells', 'bass'] },
  { seed: 10, mood: 'dreamy', length: 180, shape: 'build', parts: ['chords', 'pulse'] },
  { seed: 11, mood: 'dark', length: 60, shape: 'arc' },
  ...Array.from({ length: 12 }, (_, i) => ({ seed: 300 + i, length: 120 as const })),
];

describe('section transitions (PLAN M12 listening notes)', { timeout: 120_000 }, () => {
  it('at every boundary the lines change pattern over at least a bar, part by part or line by line', () => {
    let staged = 0;
    for (const brief of BRIEFS) {
      const d = composeDirectedWithBrief(brief);
      const p = composedPiece(d.composition);
      const score = compile(p);
      for (const b of boundaryChanges(d, p, score)) {
        const what = `${p.meta.title} at ${b.at}`;
        if (b.changes.length < 2) continue;
        const ts = b.changes.map((c) => c.t);
        expect(Math.max(...ts) - Math.min(...ts), what).toBeGreaterThanOrEqual(b.bar - 1e-3);
        // Part by part, or line by line when one part changes alone.
        const byPart = new Map<string, number[]>();
        for (const c of b.changes) byPart.set(c.part, [...(byPart.get(c.part) ?? []), c.t]);
        if (byPart.size === 1)
          for (const [part, pts] of byPart)
            expect(new Set(pts).size, `${what} ${part}: all lines on one beat`).toBeGreaterThan(1);
        staged++;
      }
    }
    expect(staged).toBeGreaterThan(20);
  });

  it("the owner's example: no line switches figure on A to B's downbeat with all the others", () => {
    const d = composeDirectedWithBrief(BRIEFS[0]);
    const p = composedPiece(d.composition);
    expect(p.meta.title).toBe('Dreamy E♭ Dorian 2771674892');
    const all = boundaryChanges(d, p, compile(p));
    // A to B (at 32.432 s before Speed; now drawn slow, so the sections are longer).
    const atB = d.sections.find((s) => s.name === 'B')!.at;
    expect(all.some((b) => Math.abs(b.at - atB) < 1e-3)).toBe(true);
    for (const b of all) {
      const on = b.changes.filter((c) => Math.abs(c.t - b.at) < 1e-3).length;
      expect(on, `at ${b.at}`).toBeLessThan(p.voices.length);
    }
    // Its texture changes somewhere, line by line.
    expect(all.some((b) => new Set(b.changes.map((c) => c.t)).size > 1)).toBe(true);
  });

  it('the harmony leads into each new section', () => {
    let n = 0;
    let strong = 0;
    for (const brief of BRIEFS) {
      const d = composeDirectedWithBrief(brief);
      for (const s of d.sections.slice(1)) {
        if (s.name === 'Outro') continue;
        const k = d.chords.findIndex((c) => Math.abs(c.t - s.at) < 2e-3);
        expect(k, `${brief.seed} ${s.name}`).toBeGreaterThan(0);
        let a = d.chords[k - 1];
        const b = d.chords[k];
        // An anticipation: the new chord arrived early and carries across; judge its arrival.
        if (a.symbol === b.symbol && k >= 2) a = d.chords[k - 2];
        if (a.key.tonic !== b.key.tonic) continue;
        const th = theoryOf(b.key)!;
        const w = transition(th, a.num, b.num);
        // A good way in, or (into a Surprise chord few chords lead to) close to the best there is.
        const best = Math.max(...th.chords.map((c) => transition(th, c.num, b.num)));
        expect(w, `${brief.seed} ${s.name}: ${a.symbol} → ${b.symbol}`).toBeGreaterThanOrEqual(
          Math.min(1, 0.6 * best),
        );
        n++;
        if (w >= 2) strong++;
      }
    }
    expect(strong / n).toBeGreaterThan(0.6);
  });
});

// ---------------------------------------------------------------------------------------------
// A lone part leads
// ---------------------------------------------------------------------------------------------

/** 4 bars from t: the plan's chord on every beat and the lead line's top pitch on every eighth. */
function span4(
  d: DirectedComposition,
  p: Piece,
  score: CompiledScore,
  lead: ComposePart,
  t0: number,
): string {
  const beat = 60 / p.view.gridBpm!;
  const meter = p.view.meter!;
  const vs = score.voices.filter((v) => v.part === PART_NAME[lead]);
  const chords: string[] = [];
  const tops: string[] = [];
  for (let k = 0; k < 8 * meter; k++) {
    const t = t0 + (k + 0.5) * (beat / 2);
    if (k % 2 === 0) {
      let c = d.chords[0];
      for (const x of d.chords) if (x.t <= t) c = x;
      chords.push(`${c.symbol}@${c.key.tonic}`);
    }
    const ps = vs
      .filter((v) => alive(v, t) && levelAt(v, t) > 0.05)
      .map((v) => pitchAt(v, t))
      .filter((x): x is number => x !== null && Number.isFinite(x));
    tops.push(ps.length ? String(Math.round(Math.max(...ps))) : '.');
  }
  return `${chords.join(',')}#${tops.join(',')}`;
}

const LONE: ComposeBrief[] = [
  { seed: 2771674892, mood: 'dreamy', parts: ['chords'], shape: 'arc', length: 120 },
  ...(['chords', 'pulse', 'bells', 'bass'] as const).flatMap((part, i) =>
    [0, 1, 2].map((k): ComposeBrief => ({
      seed: 50 + 10 * i + k,
      parts: [part],
      mood: (['calm', 'bright', 'dreamy', 'dark', 'driving'] as const)[(i + k) % 5],
      shape: (['build', 'arc', 'steady', 'journey'] as const)[(i + 2 * k) % 4],
      length: k === 2 ? 180 : 120,
    })),
  ),
  // No part carries a tune.
  { seed: 404, mood: 'dark', length: 180, shape: 'journey', parts: ['chords', 'bass', 'pulse'] },
  { seed: 81, length: 120, shape: 'steady', parts: ['chords', 'bass'] },
  // A named progression keeps its chords; the lead still moves.
  {
    seed: 82,
    length: 120,
    shape: 'steady',
    parts: ['chords'],
    start: { kind: 'progression', name: 'I–V–vi–IV' },
  },
];

describe('a lone part leads (PLAN M12 listening notes)', { timeout: 120_000 }, () => {
  it('never plays the same 4 bars (chords and top line) more than twice in a row', () => {
    for (const brief of LONE) {
      const d = composeDirectedWithBrief(brief);
      expect(d.lead, `${brief.seed}`).not.toBeNull();
      const p = composedPiece(d.composition);
      const score = compile(p);
      const bar = (60 / p.view.gridBpm!) * p.view.meter!;
      const n = Math.floor(p.end.at! / bar + 1e-6);
      const spans = Array.from({ length: n - 3 }, (_, b) => span4(d, p, score, d.lead!, b * bar));
      for (let b = 0; b + 8 < spans.length; b++) {
        const thrice = spans[b] === spans[b + 4] && spans[b + 4] === spans[b + 8];
        expect(thrice, `${p.meta.title} ${JSON.stringify(brief.parts)} from bar ${b}`).toBe(false);
      }
    }
  });

  it('the progression develops: a lone part plays more distinct chord bars than a backing loop', () => {
    const distinct = (brief: ComposeBrief) => {
      const d = composeDirectedWithBrief(brief);
      return new Set(
        d.sections.flatMap((s) =>
          d.chords
            .filter((c) => c.t >= s.at - 1e-3 && c.t < s.end - 1e-3)
            .map((c) => `${s.name.replace(/[′″‴]/g, '')}:${c.symbol}`),
        ),
      ).size;
    };
    let more = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const base = { seed, mood: 'calm', length: 180, shape: 'arc' } as const;
      if (
        distinct({ ...base, parts: ['chords'] }) >
        distinct({ ...base, parts: ['chords', 'melody'] })
      )
        more++;
    }
    expect(more).toBeGreaterThanOrEqual(7);
  });
});
