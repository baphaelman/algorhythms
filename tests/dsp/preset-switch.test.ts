/**
 * M6 acceptance (PLAN.md §15 M6, docs/m6-acceptance.md): preset changes during playback cause no
 * clicks, and preset files round-trip to a bit-identical render.
 *
 * Switches go through the live host's sequence (`AudioEngine.swap`: build and post the tables of
 * every timbre whose definition the worklet doesn't have, then post the score; the worklet's
 * handlers call `Graph.setTables` and `Graph.swap`, applied at the next block boundary), on a
 * compiled piece edited as the app edits it, over every ordered pair of the built-in presets plus
 * FM at non-integer ratios (1.41, 2.76) and the M6-a bell (stretch + FM 1.41 + noise):
 * - `voices`: the Voices drawer gives every note another timbre (`setAllTimbres`);
 * - `edit`: the Sound drawer redefines the timbre the notes use (an edit, Revert or a preset
 *   loaded over it): same name, new tables;
 * - `moment`: a `timbre` moment with fade 0 dropped just behind the playhead (display latency).
 * The swap lands mid-glide. Sound drawer drags (one table set per frame), edits just after a strike
 * and an undo inside the 20 ms table crossfade are checked the same way. Detector as in clicks.test.ts: worst ratio within [−30, +60] ms of the
 * swap ≤ 2 × the worse clean render of the two timbres.
 */

import { describe, expect, it, vi } from 'vitest';
import { setAllTimbres } from '../../src/app/editor/voices';
import { DRY_MIX, M6A_BELL, makeScore } from '../../src/audio/fixtures/scores';
import { createLoadedGraph, renderOffline } from '../../src/audio/offline';
import { resolveTimbre, tablesFor, timbreKey } from '../../src/audio/timbres';
import { compile } from '../../src/core/compiler/compile';
import { flatten } from '../../src/core/flat';
import { parsePiece, serializePiece } from '../../src/core/schema';
import { parseTimbrePreset, serializeTimbrePreset } from '../../src/core/timbre-preset';
import { BUILTIN_TIMBRES } from '../../src/core/timbres';
import type { Moment, Piece, Timbre } from '../../src/core/types';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import type { Graph } from '../../src/dsp/graph';
import { piece } from '../unit/core/compiler-fixtures';
import { clickScore, Driver, RATE } from './helpers';

vi.setConfig({ testTimeout: 300_000 });

const fm = (ratio: number, index: number): Timbre => ({
  harmonics: [1, 0.3],
  stretch: 0,
  fm: { ratio, index, indexTrack: 0.4 },
  brightness: { tilt: -1, track: 0.3 },
  detuneSpread: 1,
  accent: 0.2,
  articulation: { amount: 0.3, attack: 0.005, decay: 0.8 },
  vibrato: { rate: 5, depthCents: 4, delay: 0.4 },
});

/** Piece timbres beside the built-ins: non-integer FM ratios and the M6-a bell. */
const CUSTOM: Record<string, Timbre> = {
  fm141: fm(1.41, 1.2),
  fm276: fm(2.76, 2),
  m6a: M6A_BELL,
};
const NAMES = [...Object.keys(BUILTIN_TIMBRES), ...Object.keys(CUSTOM)];
const DEF: Record<string, Timbre> = { ...BUILTIN_TIMBRES, ...CUSTOM };

const SECONDS = 2.2;
const blocks = (s: number) => Math.ceil((s * RATE) / BLOCK_FRAMES);

/** Three notes, then a chord moment at 0.8 s gliding for 2 s (the swap lands mid-glide). */
function basePiece(timbre: string, timbres: Record<string, Timbre> = {}): Piece {
  const p = piece({
    pool: 3,
    start: [57, 64, 69],
    glide: { length: 2, stagger: 0.2, jitter: 0, arrive: 'together', ease: 'smootherstep' },
    moments: [
      {
        type: 'chord',
        at: 0.8,
        notes: { kind: 'pitches', pitches: [59, 62, 72] },
        voicing: 'even',
        assign: 'ordered',
      },
    ],
    end: { at: 20, fade: 1 },
  });
  p.timbres = { ...p.timbres, ...CUSTOM, ...timbres };
  return setAllTimbres(p, timbre);
}

/** `AudioEngine.swap`'s sequence: tables whose definition changed, then the score. */
class LiveHost {
  readonly graph: Graph;
  private readonly sent = new Map<string, string>();
  private readonly bl = new Float32Array(BLOCK_FRAMES);
  private readonly br = new Float32Array(BLOCK_FRAMES);
  readonly left: Float32Array;
  readonly right: Float32Array;
  private at = 0;

  constructor(p: Piece, seconds: number) {
    const score = compile(p);
    this.graph = createLoadedGraph({ score, mix: DRY_MIX, sampleRate: RATE, timbres: p.timbres });
    for (const name of flatten(score).timbreNames) {
      this.sent.set(name, timbreKey(resolveTimbre(name, p.timbres), RATE));
    }
    this.left = new Float32Array(blocks(seconds) * BLOCK_FRAMES);
    this.right = new Float32Array(blocks(seconds) * BLOCK_FRAMES);
    this.graph.play(0);
  }

  swap(p: Piece): void {
    const flat = flatten(compile(p));
    for (const name of flat.timbreNames) {
      const t = resolveTimbre(name, p.timbres);
      const key = timbreKey(t, RATE);
      if (this.sent.get(name) === key) continue;
      this.sent.set(name, key);
      this.graph.setTables(name, tablesFor(t, RATE));
    }
    this.graph.swap(flat);
  }

  /** Renders until `seconds` (whole blocks); returns the time reached. */
  runTo(seconds: number): number {
    const end = Math.min(this.left.length, blocks(seconds) * BLOCK_FRAMES);
    for (; this.at < end; this.at += BLOCK_FRAMES) {
      this.graph.process(this.bl, this.br);
      this.left.set(this.bl, this.at);
      this.right.set(this.br, this.at);
    }
    return this.at / RATE;
  }
}

const both = (l: Float32Array, r: Float32Array, from: number, to: number) =>
  Math.max(
    clickScore(l, Math.floor(from * RATE), Math.floor(to * RATE)).ratio,
    clickScore(r, Math.floor(from * RATE), Math.floor(to * RATE)).ratio,
  );

/** Each timbre's clean render of the same piece, worst ratio over [0.6, 2.2] s. */
const clean = new Map<string, number>();
function cleanOf(name: string): number {
  let c = clean.get(name);
  if (c === undefined) {
    const h = new LiveHost(basePiece(name), SECONDS);
    h.runTo(SECONDS);
    c = both(h.left, h.right, 0.6, SECONDS);
    clean.set(name, c);
  }
  return c;
}

type Mode = 'voices' | 'edit' | 'moment';

/** Plays A, switches to B at about 1.3 s by `mode`; worst ratio around the switch. */
function switchScore(mode: Mode, a: string, b: string, k: number): number {
  const start = mode === 'edit' ? basePiece('x', { x: DEF[a] }) : basePiece(a);
  const h = new LiveHost(start, SECONDS);
  // Vary the swap time so the swap meets the waveforms at different phases.
  const t = h.runTo(1.3 + (k % 7) * 0.0131);
  let next: Piece;
  if (mode === 'voices') next = setAllTimbres(start, b);
  else if (mode === 'edit') next = { ...start, timbres: { ...start.timbres, x: DEF[b] } };
  else {
    const m = { id: 'tm', type: 'timbre', at: t - 0.05, preset: b, fade: 0 } as Moment;
    next = { ...start, moments: [...start.moments, m] };
  }
  h.swap(next);
  h.runTo(SECONDS);
  return both(h.left, h.right, t - 0.03, t + 0.06);
}

describe.each<Mode>(['voices', 'edit', 'moment'])('preset change during playback (%s)', (mode) => {
  it('is click-free for every ordered pair, FM at non-integer ratios included', () => {
    const fails: string[] = [];
    let worst = { r: 0, pair: '' };
    let k = 0;
    for (const a of NAMES) {
      for (const b of NAMES) {
        if (a === b) continue;
        const limit = 2 * Math.max(cleanOf(a), cleanOf(b));
        const r = switchScore(mode, a, b, k++);
        const rel = r / limit;
        if (rel > worst.r)
          worst = { r: rel, pair: `${a} → ${b} ${r.toFixed(3)} / ${limit.toFixed(3)}` };
        if (r > limit) fails.push(`${a} → ${b}: ${r.toFixed(3)} > ${limit.toFixed(3)}`);
      }
    }
    console.info(
      `${mode}: ${k} pairs, worst ${(worst.r * 100).toFixed(0)} % of the limit (${worst.pair})`,
    );
    expect(fails).toEqual([]);
  });
});

describe('Sound drawer edits while a note sounds', () => {
  /** Holds `pitch` (arriving, with a strike, at 1 s), installs `steps` every `every` s from `from`. */
  function edits(a: Timbre, steps: Timbre[], every: number, from: number, pitch: number) {
    const score = makeScore(
      [{ start: pitch, timbre: 'x', moves: [{ at: 0.9, to: pitch + 2, len: 0.1 }] }],
      6,
    );
    const d = new Driver(score, DRY_MIX, RATE, { x: a });
    d.graph.play(0);
    d.run(from);
    const t0 = d.frames / RATE;
    for (const s of steps) {
      d.graph.setTables('x', tablesFor(s, RATE));
      d.run(every);
    }
    const t1 = d.frames / RATE;
    d.run(2.6 - t1);
    const out = d.out().left;
    return clickScore(out, Math.floor((t0 - 0.01) * RATE), Math.floor((t1 + 0.05) * RATE)).ratio;
  }
  const cleanIn = (t: Timbre, pitch: number) => {
    const score = makeScore(
      [{ start: pitch, timbre: 'x', moves: [{ at: 0.9, to: pitch + 2, len: 0.1 }] }],
      6,
    );
    const d = new Driver(score, DRY_MIX, RATE, { x: t });
    d.graph.play(0);
    d.run(2.6);
    return clickScore(d.out().left, Math.floor(0.95 * RATE), Math.floor(2.5 * RATE)).ratio;
  };

  const glassFm = (ratio: number): Timbre => ({
    ...BUILTIN_TIMBRES.glass,
    fm: { ratio, index: 1.5, indexTrack: 0.3 },
  });
  const pl = BUILTIN_TIMBRES.pluck;
  const soft: Timbre = { ...pl, articulation: { ...pl.articulation, amount: 0.1 } };
  const cases: [string, Timbre, Timbre[], number, number][] = [
    // A drag sends one update per frame; each rebuilds the tables, installed mid-crossfade.
    [
      'FM ratio dragged 1 → 2.76 (one table set per frame)',
      glassFm(1),
      Array.from({ length: 30 }, (_, k) => glassFm(1 + (1.76 * (k + 1)) / 30)),
      1 / 60,
      1.1,
    ],
    // Articulation parameters switch at install: 10 ms after a strike is the worst place.
    ['pluck articulation 0.9 → 0.1, 10 ms after a strike', pl, [soft], 0.1, 1.01],
    ['pluck articulation 0.1 → 0.9, 10 ms after a strike', soft, [pl], 0.1, 1.01],
    // Undo straight after a change: a second install inside the 20 ms crossfade.
    [
      'glass ↔ fm 2.76 flipped every 12 ms',
      BUILTIN_TIMBRES.glass,
      [glassFm(2.76), BUILTIN_TIMBRES.glass, glassFm(2.76), BUILTIN_TIMBRES.glass],
      0.012,
      1.3,
    ],
  ];
  it.each(cases)('%s', (_, a, steps, every, from) => {
    for (const pitch of [45, 60, 76]) {
      const limit = 2 * Math.max(cleanIn(a, pitch), ...steps.map((s) => cleanIn(s, pitch)));
      const r = edits(a, steps, every, from, pitch);
      expect(r, `p${pitch}: ${r.toFixed(3)} vs limit ${limit.toFixed(3)}`).toBeLessThanOrEqual(
        limit,
      );
    }
  });
});

describe('the switch really happens', () => {
  it('a hard switch (A’s render spliced onto B’s) fails the same limit (positive control)', () => {
    const renders = new Map<string, LiveHost>();
    const of = (n: string) => {
      let h = renders.get(n);
      if (!h) {
        h = new LiveHost(basePiece(n), SECONDS);
        h.runTo(SECONDS);
        renders.set(n, h);
      }
      return h;
    };
    const rel: number[] = [];
    const pairs = ['fm141', 'fm276', 'm6a', 'bell', 'brass', 'glass', 'epiano'];
    for (const a of pairs) {
      for (const b of pairs) {
        if (a === b) continue;
        const ha = of(a);
        const hb = of(b);
        const cut = Math.floor(1.3 * RATE);
        const l = Float32Array.from(ha.left);
        const r = Float32Array.from(ha.right);
        l.set(hb.left.subarray(cut), cut);
        r.set(hb.right.subarray(cut), cut);
        rel.push(both(l, r, 1.27, 1.36) / (2 * Math.max(cleanOf(a), cleanOf(b))));
      }
    }
    rel.sort((x, y) => x - y);
    const median = rel[Math.floor(rel.length / 2)];
    console.info(`hard switch: median ${(median * 100).toFixed(0)} % of the limit`);
    expect(median).toBeGreaterThan(1);
  });

  it('after a Voices-drawer switch the notes sound the new timbre (sine → fm276)', () => {
    const a = basePiece('sine');
    const h = new LiveHost(a, 3);
    h.runTo(1);
    h.swap(setAllTimbres(a, 'fm276'));
    h.runTo(3);
    const ref = renderOffline(
      {
        score: compile(setAllTimbres(a, 'fm276')),
        mix: DRY_MIX,
        sampleRate: RATE,
        timbres: a.timbres,
      },
      blocks(3) * BLOCK_FRAMES,
    );
    // Same score, same timbre after the 20 ms crossfade: the level of the two matches.
    const lvl = (x: Float32Array) => {
      let s = 0;
      for (let i = Math.floor(2 * RATE); i < Math.floor(2.8 * RATE); i++) s += x[i] * x[i];
      return 10 * Math.log10(s);
    };
    expect(Math.abs(lvl(h.left) - lvl(ref.left))).toBeLessThan(0.5);
  });
});

describe('preset files round-trip to the same sound', () => {
  /** Every optional field set, FM at a non-integer ratio. */
  const FULL: Timbre = {
    ...M6A_BELL,
    fm: { ratio: 2.76, index: 1.3, indexTrack: 0.4, held: 0.5 },
    strikePartials: BUILTIN_TIMBRES.bell.strikePartials,
    formants: BUILTIN_TIMBRES.choir.formants,
    drift: { cents: 2, rate: 0.3, amp: 0.04 },
    vibrato: { rate: 5, depthCents: 6, delay: 0.3, jitter: 0.5 },
  };
  const presets: [string, Timbre][] = [...Object.entries(BUILTIN_TIMBRES), ['full', FULL]];

  it.each(presets)('%s: save → load → bit-identical render (and piece file too)', (name, t) => {
    const r = parseTimbrePreset(serializeTimbrePreset(name, t));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.name).toBe(name);
    const render = (p: Piece) =>
      renderOffline(
        { score: compile(p), mix: DRY_MIX, sampleRate: RATE, timbres: p.timbres },
        blocks(2) * BLOCK_FRAMES,
      );
    const mine = (timbre: Timbre) => basePiece('mine', { mine: timbre });
    const before = render(mine(t));
    const loaded = render(mine(r.timbre));
    const parsed = parsePiece(JSON.parse(serializePiece(mine(r.timbre))));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const reopened = render(parsed.piece);
    for (const out of [loaded, reopened]) {
      expect(Buffer.from(out.left.buffer).equals(Buffer.from(before.left.buffer))).toBe(true);
      expect(Buffer.from(out.right.buffer).equals(Buffer.from(before.right.buffer))).toBe(true);
    }
  });
});
