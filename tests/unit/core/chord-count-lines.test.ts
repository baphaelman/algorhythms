/**
 * M4.5-17: changing a chord's count never makes lines cross or start or stop in mid-air
 * (PLAN.md §6.2 chord and merge rows, §7.2, §7.4, §15 M4.5). See line-artifacts.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { compile, compileWithTrace } from '../../../src/core/compiler/compile';
import { activeAt, pitchAt } from '../../../src/core/query';
import { parsePiece } from '../../../src/core/schema';
import type { ChordMoment, CompiledScore, Piece } from '../../../src/core/types';
import { piece, type MomentInput } from './compiler-fixtures';
import { lineArtifacts, type Artifact } from './line-artifacts';

// Slowest test 4 s on 1 worker; ~10× so a loaded machine passes (build log: test hardening).
vi.setConfig({ testTimeout: 60_000 });

const EXAMPLES = join(import.meta.dirname, '../../../examples');
const GLIDE = { length: 3, jitter: 0.3, stagger: 1.5, ease: 'smootherstep' as const };

function chord(at: number, count: number, extra: Partial<ChordMoment> = {}): MomentInput {
  return {
    id: `c${at}`,
    type: 'chord',
    at,
    notes: { kind: 'chord', symbol: 'Dm9' },
    voicing: 'even',
    assign: 'ordered',
    count,
    ...extra,
  };
}

const show = (as: Artifact[]): string[] =>
  as.map(
    (a) => `${a.kind} ${a.voice}${a.other ? '/' + a.other : ''} @${a.t.toFixed(2)} ${a.detail}`,
  );

/** The voice sounding nearest p at t, other than v. */
function nearestOther(s: CompiledScore, v: number, t: number, p: number): number {
  let best = Infinity;
  for (const u of s.voices) {
    if (u.index === v) continue;
    const q = pitchAt(u, t);
    if (q !== null && Math.abs(q - p) < best) best = Math.abs(q - p);
  }
  return best;
}

describe('chord count keeps lines whole (M4.5-17)', () => {
  it('every chord of every example, count changed by 1 to 3 either way: no new artifacts', () => {
    const files = readdirSync(EXAMPLES).filter((f) => f.endsWith('.algorhythms.json'));
    let tried = 0;
    for (const f of files) {
      const r = parsePiece(readFileSync(join(EXAMPLES, f), 'utf8'));
      if (!r.ok) throw new Error(f);
      const base: Piece = r.piece;
      const s0 = compile(base);
      base.moments.forEach((m, i) => {
        if (m.type !== 'chord' || m.assign === 'free' || m.target) return;
        const next = base.moments.slice(i + 1).find((x) => x.at > m.at + 0.01);
        const win = { from: m.at, to: Math.min(s0.duration, (next?.at ?? m.at + 10) + 1) };
        const key = (a: Artifact) => `${a.kind}:${a.voice}:${a.other ?? ''}`;
        const before = new Set(lineArtifacts(s0, win).map(key));
        const n = activeAt(s0, m.at).length;
        for (const d of [-3, -2, -1, 1, 2, 3]) {
          const c = n + d;
          if (c < 1 || c > base.voices.length) continue;
          const p = structuredClone(base);
          (p.moments[i] as ChordMoment).count = c;
          const added = lineArtifacts(compile(p), win).filter((a) => !before.has(key(a)));
          expect(show(added), `${f} ${m.id} ${n} -> ${c}`).toEqual([]);
          tried++;
        }
      });
    }
    expect(tried).toBeGreaterThan(100);
  });

  it('from a stacked line: count counts lines, so the line forks; no crossing', () => {
    // Five start voices on 60 are one line standing for five (revision 8); count 3 is three lines
    // (owner, 2026-11-21): the stacked line shares its voices with the newborn, nothing dies.
    const s = compile(
      piece({
        start: [60, 60, 60, 60, 60, 61],
        glide: GLIDE,
        end: { at: 20, fade: 1 },
        moments: [chord(1, 3, { notes: { kind: 'pitches', pitches: [48, 60, 72] } })],
      }),
    );
    expect(show(lineArtifacts(s))).toEqual([]);
    const heard = activeAt(s, 15);
    expect(heard).toHaveLength(3);
    expect(heard.map((i) => pitchAt(s.voices[i], 15)).sort((a, b) => a! - b!)).toEqual([
      48, 60, 72,
    ]);
    expect(s.voices[5].lives[0].died).toBe(20);
    const w = heard.reduce((a, i) => a + (s.voices[i].weight?.at(-1)?.w ?? 1), 0);
    expect(w).toBeCloseTo(6, 9);
  });

  it('a survivor that moves on while a voice fades into it carries that voice along', () => {
    // The next chord comes during the dying voices' fade (fade = glide length).
    const s = compile(
      piece({
        start: [48, 55, 60, 64, 67],
        glide: { ...GLIDE, stagger: 0.5 },
        end: { at: 30, fade: 1 },
        moments: [
          chord(1, 3),
          chord(5.5, 3, { notes: { kind: 'chord', symbol: 'G7' }, voicing: 'close' }),
        ],
      }),
    );
    expect(show(lineArtifacts(s))).toEqual([]);
    for (const v of [s.voices[0], s.voices[4]]) {
      const life = v.lives[0];
      expect(life.died).toBeGreaterThan(5.5);
      // On a survivor's line all through the fade, including the part after the second chord.
      for (let t = life.died! - life.fadeOut!; t < life.died!; t += 0.05) {
        expect(nearestOther(s, v.index, t, pitchAt(v, t)!), `${v.id} @${t}`).toBeLessThan(1e-6);
      }
    }
  });

  it('count up then down: newborns fork from a sounding neighbour, deaths end on one', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      for (const arrive of ['together', 'spread'] as const) {
        const s = compile(
          piece({
            seed,
            start: [50, 57, 62],
            glide: { ...GLIDE, stagger: 2, order: 'random', arrive },
            end: { at: 40, fade: 1 },
            moments: [
              chord(1, 8),
              chord(6.5, 2, { notes: { kind: 'chord', symbol: 'Am7' } }),
              chord(12, 6, { notes: { kind: 'current' } }),
              chord(17.5, 1, { notes: { kind: 'pitches', pitches: [57] } }),
            ],
          }),
        );
        const arts = lineArtifacts(s).filter((a) => arrive === 'together' || a.kind !== 'cross');
        expect(show(arts), `seed ${seed} ${arrive}`).toEqual([]);
      }
    }
  });

  it('under arrive: spread a dying voice fades only once its survivor has arrived', () => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const s = compile(
        piece({
          seed,
          start: [48, 55, 60, 64, 67],
          glide: { ...GLIDE, jitter: 0.8, stagger: 2, order: 'random', arrive: 'spread' },
          end: { at: 30, fade: 1 },
          moments: [chord(1, 2)],
        }),
      );
      for (const v of s.voices) {
        const life = v.lives[0];
        if (!life || life.died === undefined || life.died >= s.duration) continue;
        const tg = life.died - life.fadeOut!;
        const gap = nearestOther(s, v.index, tg, pitchAt(v, tg)!);
        expect(gap, `seed ${seed} ${v.id}`).toBeLessThan(1e-6);
      }
    }
  });

  it('a chord with count inside a walk: parents hold for their newborns', () => {
    // The two voices already sound chord notes, so they have no move of their own while their
    // newborns fork at staggered times; a walk step in between used to move the fork.
    const notes = { kind: 'pitches' as const, pitches: [50, 55, 59, 62, 66, 69, 74] };
    let forks = 0;
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const { score: s, trace } = compileWithTrace(
        piece({
          seed,
          start: [55, 62],
          glide: { ...GLIDE, stagger: 3 },
          end: { at: 30, fade: 1 },
          moments: [
            {
              id: 'w',
              type: 'walk',
              at: 0.5,
              until: 20,
              grid: 0.25,
              density: 1,
              steps: [-1, 1],
              stepGlide: 0.2,
            },
            chord(4, 7, { notes }),
          ],
        }),
      );
      const c = trace.moments.find((m) => m.id === 'c4')!;
      for (const it of c.intents!) {
        if (it.kind !== 'birth') continue;
        const v = s.voices[it.voice];
        const born = v.lives[0].born;
        const p0 = v.segments.find((g) => g.t0 === born)!.p0;
        const parent = s.voices[it.parent!];
        // Forked on its parent's pitch at its birth (revision 9: at its own staggered start)...
        expect(p0, `seed ${seed} ${v.id}`).toBeCloseTo(pitchAt(parent, born)!, 9);
        // ...which a parent with no move of its own in the chord held since the chord planned it.
        const moves = parent.segments.some((g) => g.momentId === 'c4' && g.p0 !== g.p1);
        if (!moves) expect(pitchAt(parent, born), `seed ${seed} ${v.id}`).toBe(pitchAt(parent, 4));
        forks++;
      }
    }
    expect(forks).toBe(40);
  });
});
