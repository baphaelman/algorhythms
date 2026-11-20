/**
 * Voicing: from a NoteSet to target pitches (PLAN.md §7.3).
 *
 * - `pitches`: the notes themselves, sorted. If there are more than k, k evenly spaced ones are
 *   chosen; if fewer, the caller's surjective assignment doubles them.
 * - `chord`, `degrees`, `current`: resolve to pitch classes, list every candidate pitch of those
 *   classes in the register, then pick k by the voicing mode:
 *   - `even`: k indices evenly spaced over the candidates (the prototype's method);
 *   - `close`: k consecutive candidates centred on the register's middle;
 *   - `nearest`: each voice takes the candidate nearest its committed destination (may double).
 *   A slash bass (`C/E`) puts the bass's pitch class in the lowest voice.
 *
 * Integer pitches only (12-TET candidates). Ties go downward, as everywhere in §7.8.
 */

import { parseChord } from './chords';
import { mod } from './math';
import { degreesToPcs, pitchesWithPcs } from './scales';
import type { Key, NoteSet, Pitch, Voicing } from './types';

export type VoicingResult =
  | {
      ok: true;
      /** Sorted ascending. May hold fewer than k entries (the assignment then doubles). */
      targets: Pitch[];
      /** True when targets[i] belongs to voice i (mode `nearest`): no assignment needed. */
      perVoice: boolean;
    }
  | { ok: false; code: string; message: string };

export interface VoicingInput {
  notes: NoteSet;
  /** Number of target pitches wanted (the voices to be voiced). */
  k: number;
  mode: Voicing;
  /** Candidate register [low, high], inclusive. */
  register: readonly [Pitch, Pitch];
  key: Key;
  /** Committed destinations of every active voice, for `current`. */
  current: readonly Pitch[];
  /**
   * Committed destinations of the voices being voiced, sorted ascending (for `nearest`). Its
   * length may be below k (a split's newborns have no destination yet).
   */
  voices: readonly Pitch[];
}

/** Nearest integer, ties down. */
export function roundTiesDown(x: number): number {
  return Math.ceil(x - 0.5);
}

/** k indices evenly spaced over 0..c−1 (c ≥ k ≥ 1); k = 1 gives the middle, ties low. */
export function evenIndices(c: number, k: number): number[] {
  if (k <= 0) return [];
  if (k === 1) return [Math.floor((c - 1) / 2)];
  const out: number[] = [];
  for (let i = 0; i < k; i++) out.push(Math.round((i * (c - 1)) / (k - 1)));
  return out;
}

/** Index of the candidate nearest x (ties: the lower one). Candidates are sorted, non-empty. */
function nearestIndex(cands: readonly Pitch[], x: Pitch): number {
  let best = 0;
  let bestD = Math.abs(cands[0] - x);
  for (let i = 1; i < cands.length; i++) {
    const d = Math.abs(cands[i] - x);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

/** Picks k from sorted candidates by mode; fewer than k candidates are all returned. */
function pick(
  cands: readonly Pitch[],
  k: number,
  mode: Voicing,
  mid: Pitch,
  voices: readonly Pitch[],
): { targets: Pitch[]; perVoice: boolean } {
  const c = cands.length;
  if (c === 0) return { targets: [], perVoice: false };
  if (mode === 'nearest' && voices.length > 0) {
    const own = voices.map((p) => cands[nearestIndex(cands, p)]);
    if (voices.length >= k) return { targets: own, perVoice: voices.length === k };
    // Newborns (a split) take evenly spaced candidates from those no voice is on.
    const taken = new Set(own);
    const free = cands.filter((p) => !taken.has(p));
    const extra = k - voices.length;
    const add = free.length >= extra ? evenIndices(free.length, extra).map((i) => free[i]) : free;
    return { targets: [...own, ...add].sort((a, b) => a - b), perVoice: false };
  }
  if (c <= k) return { targets: cands.slice(), perVoice: false };
  if (mode === 'close') {
    const m = nearestIndex(cands, mid);
    let s = m - Math.floor((k - 1) / 2);
    if (s < 0) s = 0;
    if (s > c - k) s = c - k;
    return { targets: cands.slice(s, s + k), perVoice: false };
  }
  if (k === 1) return { targets: [cands[nearestIndex(cands, mid)]], perVoice: false };
  return { targets: evenIndices(c, k).map((i) => cands[i]), perVoice: false };
}

/** Resolves a NoteSet to pitch classes (and a slash bass); `pitches` is handled separately. */
function pitchClasses(
  notes: Exclude<NoteSet, { kind: 'pitches' }>,
  key: Key,
  current: readonly Pitch[],
): { ok: true; pcs: number[]; bass?: number } | { ok: false; code: string; message: string } {
  switch (notes.kind) {
    case 'chord': {
      const r = parseChord(notes.symbol, key);
      if (!r.ok) return { ok: false, code: 'chord-parse', message: r.error };
      return r.bass === undefined
        ? { ok: true, pcs: r.pcs }
        : { ok: true, pcs: r.pcs, bass: r.bass };
    }
    case 'degrees':
      return { ok: true, pcs: degreesToPcs(notes.degrees, key) };
    case 'current': {
      const pcs: number[] = [];
      for (const p of current) {
        if (!Number.isFinite(p)) continue;
        const pc = mod(roundTiesDown(p), 12);
        if (!pcs.includes(pc)) pcs.push(pc);
      }
      return { ok: true, pcs };
    }
  }
}

/** Voices a NoteSet into target pitches (§7.3). */
export function voiceNotes(input: VoicingInput): VoicingResult {
  const { notes, k, mode, register, key } = input;
  const lo = register[0] < register[1] ? register[0] : register[1];
  const hi = register[0] < register[1] ? register[1] : register[0];
  const mid = (lo + hi) / 2;

  if (notes.kind === 'pitches') {
    const ps = notes.pitches.filter((p) => Number.isFinite(p)).sort((a, b) => a - b);
    if (ps.length === 0) return { ok: false, code: 'empty-notes', message: 'No pitches given.' };
    if (ps.length <= k) return { ok: true, targets: ps, perVoice: false };
    return { ok: true, targets: evenIndices(ps.length, k).map((i) => ps[i]), perVoice: false };
  }

  const pc = pitchClasses(notes, key, input.current);
  if (!pc.ok) return pc;
  if (pc.pcs.length === 0) {
    return { ok: false, code: 'empty-notes', message: 'The notes resolve to no pitch classes.' };
  }
  const cands = pitchesWithPcs(pc.pcs, lo, hi);
  if (cands.length === 0) {
    return {
      ok: false,
      code: 'empty-register',
      message: `No note of the chord lies in the register [${lo}, ${hi}].`,
    };
  }

  if (pc.bass === undefined || k < 2) {
    if (pc.bass !== undefined) {
      const bassCands = pitchesWithPcs([pc.bass], lo, hi);
      if (bassCands.length > 0) {
        return { ok: true, targets: [bassCands[nearestIndex(bassCands, mid)]], perVoice: false };
      }
    }
    const r = pick(cands, k, mode, mid, input.voices);
    return { ok: true, targets: r.targets, perVoice: r.perVoice };
  }

  // Slash bass: the lowest voice takes the bass's pitch class, the rest are voiced above it.
  const bassCands = pitchesWithPcs([pc.bass], lo, hi);
  if (bassCands.length === 0) {
    const r = pick(cands, k, mode, mid, input.voices);
    return { ok: true, targets: r.targets, perVoice: r.perVoice };
  }
  let bass: Pitch;
  let upper: Pitch[];
  if (mode === 'nearest' && input.voices.length > 0) {
    bass = bassCands[nearestIndex(bassCands, input.voices[0])];
    // With no chord tone above the bass in the register, the upper voices double within it
    // (as for 'close'); picking from an empty list would give NaN targets.
    const above = cands.filter((p) => p > bass);
    upper = pick(above.length > 0 ? above : cands, k - 1, mode, mid, input.voices.slice(1)).targets;
  } else if (mode === 'close') {
    const above = cands.filter((p) => p > bassCands[0]);
    upper = pick(above.length > 0 ? above : cands, k - 1, 'close', mid, []).targets;
    const below = bassCands.filter((p) => p < upper[0]);
    bass = below.length > 0 ? below[below.length - 1] : bassCands[0];
  } else {
    bass = bassCands[0];
    upper = pick(
      cands.filter((p) => p > bass),
      k - 1,
      'even',
      mid,
      [],
    ).targets;
  }
  const targets = [bass, ...upper].sort((a, b) => a - b);
  return {
    ok: true,
    targets,
    perVoice: mode === 'nearest' && targets.length === k && input.voices.length === k,
  };
}
