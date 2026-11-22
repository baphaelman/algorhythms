/** Shared by the take-match tests (live-take*.test.ts): record a live take and compare. */

import { compile, compileWithTrace } from '../../src/core/compiler/compile';
import { newPiece } from '../../src/core/defaults';
import { takeBase, takeMoments, takeVoices } from '../../src/core/live-take';
import type { LiveSettings } from '../../src/core/live';
import { lifeAt, pitchAt } from '../../src/core/query';
import type { CompiledVoice, Moment, Piece } from '../../src/core/types';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import { LiveRig } from '../../src/audio/fixtures/live-rig';
import { liveSetupFrom } from '../../src/audio/live-setup';

export const CENT = 0.01;

/** Level of compiled voice `v` at t (linear ramps from the level at each entry). */
export function levelAt(v: CompiledVoice, t: number): number {
  let value = 1;
  let from = 1;
  let e: { t: number; gain: number; over: number } | null = null;
  for (const x of v.level) {
    if (x.t > t) break;
    if (e) {
      const u = e.over > 0 ? Math.min(1, (x.t - e.t) / e.over) : 1;
      value = from + (e.gain - from) * u;
    }
    from = value;
    e = x;
  }
  if (!e) return value;
  const u = e.over > 0 ? Math.min(1, (t - e.t) / e.over) : 1;
  return from + (e.gain - from) * u;
}

export function distinct(ps: number[]): number[] {
  const out: number[] = [];
  for (const p of ps.sort((a, b) => a - b)) {
    if (out.length === 0 || p - out[out.length - 1] > 1e-7) out.push(p);
  }
  return out;
}

export interface Take {
  rig: LiveRig;
  piece: Piece;
  moments: Moment[];
  liveAt: number;
  T0: number;
  /** When the take may sound (before: the piece's lines cut at T0 fading out, not compared). */
  silentFrom: number;
  /** Live-time spans of key-by-key presses from silence (first to last change). */
  silentPresses: [number, number][];
  /** Live-time spans of every key-by-key press (first to last change). */
  presses: [number, number][];
  /** What was heard at each block start (before later press changes rewound it). */
  heard: Map<number, number[]>;
}

/**
 * Plays `script` from the arm time into `into` (default: an Empty piece of 6 sine voices) at T0
 * and records it, as app/live.ts does (voices live mode added written in by `takeVoices`).
 */
export function record(
  script: (rig: LiveRig) => void,
  settings: Partial<LiveSettings> = {},
  into: Piece = newPiece({ poolSize: 6, timbre: 'sine', seed: 1 }),
): Take {
  const T0 = 2;
  let n = 0;
  const newId = () => `rec${n++}`;
  const { piece: base, silentFrom } = takeBase(into, T0, newId);
  const setup = liveSetupFrom(base, compile(base), silentFrom);
  const rig = new LiveRig(setup, { glide: 0.3, ...settings });
  rig.run(0.05);
  const liveAt = rig.time;
  const from = rig.changes.length;
  const heard = new Map<number, number[]>();
  const block = rig.block.bind(rig);
  rig.block = () => {
    const t = rig.time;
    block();
    const tr = rig.input.tracks;
    heard.set(
      Math.round(t * rig.graph.sampleRate),
      tr.levelAt(0, t) > 1e-6 ? distinct(tr.data.map((_, i) => tr.pitchAt(i, t))) : [],
    );
  };
  script(rig);
  rig.run(0.5);
  const changes = rig.changes.slice(from);
  const moments = takeMoments(changes, {
    at: T0,
    liveAt,
    voices: setup.voices.map((v) => v.id),
    earliest: silentFrom,
    newId,
  });
  const silentPresses: [number, number][] = [];
  const presses: [number, number][] = [];
  for (const c of changes) {
    const first = changes.find((x) => x.seq === c.press);
    if (c.seq === c.press || !first) continue;
    for (const list of [first.update.silent ? silentPresses : presses]) {
      const span = list.find((x) => x[0] === first.time);
      const end = c.posted;
      if (span) span[1] = Math.max(span[1], end);
      else list.push([first.time, end]);
    }
  }
  const voiced = takeVoices(base, setup.voices, setup.added ?? [], T0, newId);
  return {
    rig,
    piece: { ...voiced, moments: [...voiced.moments, ...moments] },
    moments,
    liveAt,
    T0,
    silentFrom,
    silentPresses,
    presses,
    heard,
  };
}

export interface Match {
  /** Largest pitch gap at offset 0 (semitones) and the largest offset needed for 1 cent. */
  cents0: number;
  frames: number;
  /** Points with no match within 1 cent and 128 frames. */
  misses: { t: number; p: number; side: 'live' | 'take'; gap: number }[];
  blocks: number;
  /** Largest gap inside key-by-key presses from silence (semitones). */
  inPress: number;
  /** Largest gap between what was heard inside any key-by-key press and the take (semitones). */
  heardInPress: number;
}

export function compare(take: Take): Match {
  const { rig, liveAt, T0 } = take;
  const tr = rig.input.tracks;
  const score = compile(take.piece);
  const rate = rig.graph.sampleRate;
  const live = (t: number): number[] => {
    if (!(tr.levelAt(0, t) > 1e-6)) return [];
    return distinct(tr.data.map((_, i) => tr.pitchAt(i, t)));
  };
  const comp = (t: number): number[] =>
    distinct(
      score.voices
        .filter((v) => lifeAt(v, t) !== null && levelAt(v, t) > 1e-6)
        .map((v) => pitchAt(v, t) as number),
    );
  const block = BLOCK_FRAMES / rate;
  const offsets: number[] = [];
  for (let f = 0; f <= BLOCK_FRAMES; f += 8) offsets.push(f, -f);
  /** [gap at offset 0, smallest offset within 1 cent, smallest gap at any offset]. */
  const near = (p: number, set: (t: number) => number[], t: number): number[] => {
    let best = Infinity;
    let bestF = Infinity;
    let any = Infinity;
    for (const f of offsets) {
      for (const q of set(t + f / rate)) {
        const g = Math.abs(p - q);
        if (g <= CENT && Math.abs(f) < bestF) bestF = Math.abs(f);
        if (f === 0 && g < best) best = g;
        if (g < any) any = g;
      }
    }
    return [best, bestF, any];
  };
  const out: Match = { cents0: 0, frames: 0, misses: [], blocks: 0, inPress: 0, heardInPress: 0 };
  const end = rig.time - 0.01;
  for (let tl = liveAt + (take.silentFrom - T0); tl < end; tl += block) {
    const tp = T0 + (tl - liveAt);
    const inPress = take.silentPresses.some(([a, b]) => tl >= a - 1e-9 && tl < b + block);
    out.blocks++;
    if (take.presses.some(([a, b]) => tl >= a - 1e-9 && tl < b + block)) {
      const h = take.heard.get(Math.round(tl * rate)) ?? [];
      const c = comp(tp);
      const gap = (xs: number[], ys: number[]) => {
        for (const p of xs) {
          let g = Infinity;
          for (const q of ys) g = Math.min(g, Math.abs(p - q));
          if (Number.isFinite(g)) out.heardInPress = Math.max(out.heardInPress, g);
        }
      };
      gap(h, c);
      gap(c, h);
    }
    const check = (p: number, other: (t: number) => number[], t: number, side: 'live' | 'take') => {
      const [g0, f, any] = near(p, other, t);
      if (inPress) {
        out.inPress = Math.max(out.inPress, any);
        return;
      }
      if (Number.isFinite(f)) out.cents0 = Math.max(out.cents0, Math.min(g0, any) / CENT);
      if (!Number.isFinite(f)) out.misses.push({ t: tl - liveAt, p, side, gap: any });
      else out.frames = Math.max(out.frames, f);
    };
    for (const p of live(tl)) check(p, (t) => comp(T0 + (t - liveAt)), tl, 'live');
    for (const p of comp(tp)) check(p, (t) => live(liveAt + (t - T0)), tp, 'take');
  }
  return out;
}

/** Waits `s` seconds of live time. */
export const wait = (rig: LiveRig, s: number): void => rig.run(s);

/** Keys pressed `gap` seconds apart (held). */
export function press(rig: LiveRig, keys: number[], gap = 0.005): void {
  keys.forEach((k, i) => {
    if (i > 0) wait(rig, gap);
    rig.noteOn(k);
  });
}

export function report(name: string, m: Match): void {
  const regions: string[] = [];
  let last = -1;
  for (const x of m.misses) {
    if (x.t - last > 0.01) regions.push(`${x.t.toFixed(3)}(${(x.gap * 100).toFixed(1)}c)`);
    last = x.t;
  }
  if (regions.length > 0) console.log(`${name} miss regions: ${regions.join(' ')}`);
  console.log(
    `${name}: ${m.blocks} blocks, max ${m.cents0.toFixed(4)} cents at offset 0, ` +
      `max offset ${m.frames} frames, misses ${m.misses.length}, in silent presses ${(m.inPress * 100).toFixed(1)} cents, heard in presses ${(m.heardInPress * 100).toFixed(2)} cents`,
  );
}

/** Debug: each miss region (live time from the take start) with its worst gap and the changes before it. */
export function explain(take: Take, m: Match, maxRegions = 4): void {
  const WIN = Number(process.env.EXPLAIN_WIN ?? 0.6);
  const regions: { a: number; b: number; worst: number }[] = [];
  for (const x of m.misses) {
    const r = regions[regions.length - 1];
    if (r && x.t - r.b <= 0.01) {
      r.b = x.t;
      r.worst = Math.max(r.worst, x.gap);
    } else regions.push({ a: x.t, b: x.t, worst: x.gap });
  }
  const changes = take.rig.changes.filter((c) => c.time >= take.liveAt);
  const tr = take.rig.input.tracks;
  const score = compile(take.piece);
  const sets = (tl: number): string => {
    const tp = take.T0 + tl;
    const live =
      tr.levelAt(0, take.liveAt + tl) > 1e-6
        ? distinct(tr.data.map((_, i) => tr.pitchAt(i, take.liveAt + tl)))
        : [];
    const comp = distinct(
      score.voices
        .filter((v) => lifeAt(v, tp) !== null && levelAt(v, tp) > 1e-6)
        .map((v) => pitchAt(v, tp) as number),
    );
    return `live [${live.map((p) => p.toFixed(2))}] take [${comp.map((p) => p.toFixed(2))}]`;
  };
  if (process.env.EXPLAIN?.includes('4')) {
    // First time a compiled voice (alive, level > 0) is not where the live voice of that index is.
    const step = BLOCK_FRAMES / take.rig.graph.sampleRate;
    for (let tl = 0; tl < (regions[0]?.b ?? 0); tl += step) {
      const tp = take.T0 + tl;
      if (!(tr.levelAt(0, take.liveAt + tl) > 1e-6)) continue;
      const bad = score.voices.filter(
        (v) =>
          lifeAt(v, tp) !== null &&
          levelAt(v, tp) > 1e-6 &&
          Math.abs((pitchAt(v, tp) as number) - tr.pitchAt(v.index, take.liveAt + tl)) > 1e-6,
      );
      if (bad.length > 0) {
        console.log(
          `identity diverges at ${tl.toFixed(4)}: ${bad.map((v) => v.id).join(' ')}; ${sets(tl)}`,
        );
        regions.unshift({ a: tl, b: tl, worst: 0 });
        break;
      }
    }
  }
  for (const r of regions.slice(0, maxRegions)) {
    console.log(
      `-- miss ${r.a.toFixed(3)}..${r.b.toFixed(3)} worst ${(r.worst * 100).toFixed(1)} c; at start ${sets(r.a)}; +50ms ${sets(r.a + 0.05)}`,
    );
    if (process.env.EXPLAIN?.includes('2')) {
      for (const tl of [r.a - 0.1, r.a, r.a + 0.1]) {
        const tp = take.T0 + tl;
        console.log(
          `  @${tl.toFixed(3)} ` +
            score.voices
              .map(
                (v) =>
                  `${v.id}:${lifeAt(v, tp) ? 'L' : '-'}${levelAt(v, tp).toFixed(2)}/${(pitchAt(v, tp) ?? NaN).toFixed(2)}`,
              )
              .join(' '),
        );
      }
    }
    if (process.env.EXPLAIN?.includes('3')) {
      const { trace } = compileWithTrace(take.piece);
      for (const mt of trace.moments) {
        const t = mt.t - take.T0;
        if (t < r.a - WIN || t > r.b || !mt.plan) continue;
        console.log(
          `  trace ${t.toFixed(4)} order [${mt.plan.order}] movers [${mt.plan.movers}] limits ` +
            mt.plan.limits
              .map(
                (l) =>
                  `${l.voice}:${l.up.toFixed(2)}/${l.down.toFixed(2)}x${l.crossScale.toFixed(3)}`,
              )
              .join(' ') +
            ` intents ${JSON.stringify(mt.intents)} targeted [${mt.targeted}] logical ${JSON.stringify(mt.logical)}`,
        );
      }
      for (const v of score.voices) {
        const segs = v.segments.filter((g) => g.t0 - take.T0 >= r.a - WIN && g.t0 - take.T0 <= r.b);
        console.log(
          `  ${v.id}: ` +
            segs
              .map(
                (g) =>
                  `[${(g.t0 - take.T0).toFixed(4)}..${(g.t1 - take.T0).toFixed(4)} ${g.p0.toFixed(3)}->${g.p1.toFixed(3)} m0 ${(g.m0 ?? 0).toFixed(3)}${g.curve ? ' cut' : ''}]`,
              )
              .join(' '),
        );
      }
    }
    for (const mo of take.moments) {
      const t = mo.at - take.T0;
      if (t >= r.a - WIN && t <= r.b)
        console.log(
          `  moment ${t.toFixed(4)} ${JSON.stringify({ ...mo, id: undefined, at: undefined })}`,
        );
    }
    for (const c of changes) {
      const t = c.time - take.liveAt;
      if (t < r.a - WIN || t > r.b) continue;
      const mv = c.update.moves
        .map(
          (x) =>
            `${x.voice}:${x.p1}@${x.delay.toFixed(3)}/${x.dur.toFixed(3)}s${x.scale.toFixed(2)}`,
        )
        .join(' ');
      console.log(
        `  ${t.toFixed(4)} seq ${c.seq} press ${c.press} held [${c.held}] ${c.update.silent ? 'silent ' : ''}` +
          `targets [${c.update.targets?.map((p) => p.toFixed(2)) ?? ''}] lvl ${c.update.level ? c.update.level.gain : '-'} moves ${mv}` +
          ` (${c.settings.single} ${c.settings.chord} ${c.settings.release} st${c.settings.stagger} ${c.settings.order})`,
      );
    }
  }
}
