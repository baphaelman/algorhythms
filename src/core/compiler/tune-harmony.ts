/**
 * The HUD harmony of tune-driven passages (composing.md §3 #11). Tune notes are melody and set no
 * harmony entry (R9-4), so a piece made only of tunes kept the last chord entry for its whole
 * length. Rule:
 *
 * - A line is tune-driven from a tune note until a moment that records harmony (chord, unison,
 *   note, pin, split, …) sets its pitch; walks leave it as it was. Lines start chord-driven.
 * - While any sounding line is chord-driven, the compiled entries stand: a melody over a chord
 *   never renames it.
 * - While every sounding line is tune-driven, the HUD names what sounds, one window at a time:
 *   windows are whole beats of the bar grid (`gridBpm`, else 60 bpm) and at least 0.4 s long,
 *   aligned to t = 0. In each window every line gives the pitch class it sounds longest (ties:
 *   the earlier, so the on-beat note beats a passing one); the lowest of those is the bass. The
 *   shown name stays while those pitch classes are all in it; otherwise the window's set is
 *   named (core/harmony.ts `nameChord`), but never within 0.4 s of the last entry.
 * - When a chord-driven line sounds again, the chord entry then in effect is shown again (a copy
 *   at that time, `from: 'resume'`).
 *
 * Pure and deterministic; reads only the compiler's output and driver records.
 */

import { mod } from '../math';
import type { HarmonyChange, Key, KeyChange, MomentId, Seconds, Segment } from '../types';

/** A change of who sets a line's pitch (compile.ts `markDrivers`). */
export interface DriverRecord {
  t: Seconds;
  voice: number;
  /** True: a tune's note; false: a moment that records harmony. */
  tune: boolean;
  momentId: MomentId;
}

/** Shortest time a name is kept, seconds. */
export const MIN_NAME_HOLD = 0.4;

interface VoiceView {
  lives: readonly { born: Seconds; died?: Seconds }[];
  segments: readonly Segment[];
}

/** Window length: whole beats of the bar grid, at least MIN_NAME_HOLD. */
export function nameWindow(gridBpm: number | undefined): Seconds {
  const bpm = typeof gridBpm === 'number' && Number.isFinite(gridBpm) && gridBpm > 0 ? gridBpm : 60;
  const beat = 60 / bpm;
  return beat * Math.max(1, Math.ceil(MIN_NAME_HOLD / beat - 1e-9));
}

/**
 * The HUD timeline: `raw` (the compiled entries) with tune-driven passages named from their
 * sounding notes. Returns `raw` itself when no line is ever tune-driven.
 */
export function tuneHarmony(
  raw: readonly HarmonyChange[],
  drivers: readonly DriverRecord[],
  voices: readonly VoiceView[],
  keys: readonly KeyChange[],
  duration: Seconds,
  gridBpm: number | undefined,
  label: (pcs: readonly number[], bass: number, key: Key) => string,
): HarmonyChange[] {
  if (!drivers.some((d) => d.tune)) return raw as HarmonyChange[];
  // Events are handled in time order, so each line keeps cursors into its records and segments.
  const byVoice: DriverRecord[][] = voices.map(() => []);
  for (const d of drivers) byVoice[d.voice]?.push(d);
  for (const list of byVoice) list.sort((a, b) => a.t - b.t); // stable: same-t order kept
  const dCur = new Int32Array(voices.length).fill(-1);
  const driverAt = (v: number, t: Seconds): DriverRecord | null => {
    const list = byVoice[v];
    while (dCur[v] + 1 < list.length && list[dCur[v] + 1].t <= t) dCur[v]++;
    return dCur[v] < 0 ? null : list[dCur[v]];
  };
  const lCur = new Int32Array(voices.length);
  const alive = (v: number, t: Seconds): boolean => {
    const lives = voices[v].lives;
    while (lCur[v] < lives.length) {
      const l = lives[lCur[v]];
      if (l.died !== undefined && l.died <= t) lCur[v]++;
      else return l.born <= t;
    }
    return false;
  };
  /** Sounding lines at t, and whether every one is tune-driven (false if none sounds). */
  const tuneMode = (t: Seconds): { lines: number[]; tune: boolean } => {
    const lines: number[] = [];
    let tune = true;
    for (let v = 0; v < voices.length; v++) {
      if (!alive(v, t)) continue;
      lines.push(v);
      if (!driverAt(v, t)?.tune) tune = false;
    }
    return { lines, tune: tune && lines.length > 0 };
  };
  let kCur = 0;
  const keyAt = (t: Seconds): Key => {
    while (kCur + 1 < keys.length && keys[kCur + 1].t <= t) kCur++;
    return keys[kCur].key;
  };
  const sCur = new Int32Array(voices.length);
  /** The pitch a line sounds longest in [a, b) (by segment destination; ties: the earlier). */
  const mainPitch = (v: number, a: Seconds, b: Seconds): number | null => {
    const segs = voices[v].segments;
    while (sCur[v] < segs.length && segs[sCur[v]].t1 <= a) sCur[v]++;
    let best: number | null = null;
    let bestD = 0;
    const dur = new Map<number, number>();
    for (let j = sCur[v]; j < segs.length && segs[j].t0 < b; j++) {
      const g = segs[j];
      const d = Math.min(b, g.t1) - Math.max(a, g.t0);
      if (!(d > 0)) continue;
      const p = Math.round(g.p1);
      const total = (dur.get(p) ?? 0) + d;
      dur.set(p, total);
      if (best === null || total > bestD + 1e-9) {
        best = p; // a later pitch must sound strictly longer than the earlier best
        bestD = total;
      } else if (p === best) bestD = total;
    }
    return best;
  };

  const win = nameWindow(gridBpm);
  // Events in time order: raw entries (0), chord drivers (1), windows (2).
  const ev: { t: Seconds; kind: 0 | 1 | 2; h?: HarmonyChange }[] = [];
  for (const h of raw) ev.push({ t: h.t, kind: 0, h });
  for (const d of drivers) if (!d.tune) ev.push({ t: d.t, kind: 1 });
  for (let k = 0; k * win < duration; k++) ev.push({ t: k * win, kind: 2 });
  ev.sort((a, b) => a.t - b.t || a.kind - b.kind); // stable: raw entries keep their order

  const out: HarmonyChange[] = [];
  let inEffect: HarmonyChange | null = null; // last raw entry reached
  let shownRaw: HarmonyChange | null = null; // the raw entry shown, null while a tune name is
  const last = (): HarmonyChange | undefined => out[out.length - 1];
  for (const e of ev) {
    if (e.kind === 0) inEffect = e.h!;
    const mode = tuneMode(e.t);
    if (!mode.tune) {
      if (inEffect && shownRaw !== inEffect && (e.kind === 0 || mode.lines.length > 0)) {
        out.push(
          e.kind === 0 && e.h === inEffect ? inEffect : { ...inEffect, t: e.t, from: 'resume' },
        );
        shownRaw = inEffect;
      }
      continue;
    }
    if (e.kind !== 2) continue;
    const notes: { v: number; p: number }[] = [];
    for (const v of mode.lines) {
      const p = mainPitch(v, e.t, e.t + win);
      if (p !== null) notes.push({ v, p });
    }
    if (notes.length === 0) continue;
    notes.sort((a, b) => a.p - b.p || a.v - b.v);
    const bass = mod(notes[0].p, 12);
    const pcs: number[] = [];
    for (const n of notes) {
      const pc = mod(n.p, 12);
      if (!pcs.includes(pc)) pcs.push(pc);
    }
    const prev = last();
    // The shown name stays while what sounds is part of it (F A C, then F C: still "F").
    if (prev && pcs.every((p) => prev.pcs.includes(p))) continue;
    if (prev && e.t - prev.t < MIN_NAME_HOLD - 1e-9) continue;
    const name = label(pcs, bass, keyAt(e.t));
    if (prev && prev.label === name) continue;
    out.push({
      t: e.t,
      momentId: driverAt(notes[0].v, e.t)!.momentId,
      pcs,
      bass,
      label: name,
      from: 'tunes',
    });
    shownRaw = null;
  }
  return out;
}
