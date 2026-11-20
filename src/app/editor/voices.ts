/**
 * Pure piece recipes for the Voices drawer (PLAN.md §11.3): pool size, voices active at start and
 * per-voice settings. Each returns the same piece object when nothing changes (so `edit` records
 * no entry), else a new piece sharing the untouched parts.
 *
 * Shrinking the pool removes voices from the end (highest pool index) and keeps the piece valid:
 * their `start` entries go; `{ voices }` targets drop them, and a moment left with no target
 * voices is deleted; pins on removed voices are deleted; split and merge counts are clamped to the
 * new pool size. `poolShrinkEffects` reports this beforehand.
 */

import {
  builtinTimbresFor,
  DEFAULT_RANGE,
  DEFAULT_START_PITCH,
  DEFAULT_TIMBRE,
} from '../../core/defaults';
import { BUILTIN_TIMBRES } from '../../core/timbres';
import {
  MAX_VOICES,
  type Moment,
  type Piece,
  type Pitch,
  type VoiceDef,
  type VoiceId,
} from '../../core/types';

/** Lowest and highest MIDI pitch the range fields accept. */
export const PITCH_MIN = 0;
export const PITCH_MAX = 127;

/** Fields the drawer edits; `undefined` removes an optional field. */
export type VoicePatch = Partial<
  Pick<VoiceDef, 'color' | 'timbre' | 'pan' | 'gain' | 'range' | 'mute' | 'solo'>
>;

const clampInt = (x: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.round(x)));

/** A voice id not used in `voices`: `v<n>` with the smallest n ≥ `from`. */
export function freeVoiceId(voices: readonly VoiceDef[], from: number): VoiceId {
  const used = new Set(voices.map((v) => v.id));
  let n = Math.max(1, from);
  while (used.has(`v${n}`)) n++;
  return `v${n}`;
}

/** What shrinking the pool to `size` would remove. */
export interface ShrinkEffects {
  /** Removed voice ids. */
  voices: VoiceId[];
  /** Start entries dropped. */
  start: number;
  /** Moments deleted (pins on removed voices, targets left empty). */
  moments: number;
}

function removedIds(piece: Piece, size: number): Set<VoiceId> {
  return new Set(piece.voices.slice(size).map((v) => v.id));
}

/** The moment after removing `gone` voices, or null when it must be deleted. */
function pruneMoment(m: Moment, gone: Set<VoiceId>, size: number): Moment | null {
  let out = m;
  if (m.type === 'pin' && gone.has(m.voice)) return null;
  const t = m.target;
  if (t && t !== 'all' && 'voices' in t && t.voices.some((id) => gone.has(id))) {
    const voices = t.voices.filter((id) => !gone.has(id));
    if (voices.length === 0) return null;
    out = { ...out, target: { voices } };
  }
  if ((out.type === 'split' || out.type === 'merge') && out.count > size) {
    out = { ...out, count: size };
  }
  return out;
}

/** What `resizePool(piece, size)` would remove (all zero when growing). */
export function poolShrinkEffects(piece: Piece, size: number): ShrinkEffects {
  const n = clampInt(size, 1, MAX_VOICES);
  const gone = removedIds(piece, n);
  return {
    voices: [...gone],
    start: piece.start.filter((s) => gone.has(s.voice)).length,
    moments:
      gone.size === 0 ? 0 : piece.moments.filter((m) => pruneMoment(m, gone, n) === null).length,
  };
}

/**
 * Sets the pool size (clamped to 1..32). New voices copy the last voice's timbre and range, with
 * auto pan and gain 1; removed voices are pruned as described at the top of this file.
 */
export function resizePool(piece: Piece, size: number): Piece {
  const n = clampInt(size, 1, MAX_VOICES);
  const cur = piece.voices.length;
  if (n === cur) return piece;
  if (n > cur) {
    const last = piece.voices.at(-1);
    const voices = [...piece.voices];
    for (let i = cur; i < n; i++) {
      voices.push({
        id: freeVoiceId(voices, i + 1),
        timbre: last?.timbre ?? DEFAULT_TIMBRE,
        pan: 'auto',
        gain: 1,
        range: last ? [last.range[0], last.range[1]] : [DEFAULT_RANGE[0], DEFAULT_RANGE[1]],
      });
    }
    return withTimbres({ ...piece, voices });
  }
  const gone = removedIds(piece, n);
  const moments: Moment[] = [];
  let changed = false;
  for (const m of piece.moments) {
    const p = pruneMoment(m, gone, n);
    if (p !== m) changed = true;
    if (p) moments.push(p);
  }
  return {
    ...piece,
    voices: piece.voices.slice(0, n),
    start: piece.start.filter((s) => !gone.has(s.voice)),
    moments: changed ? moments : piece.moments,
  };
}

/** Copies built-in presets the voices use into `piece.timbres` when missing (self-contained file). */
function withTimbres(piece: Piece): Piece {
  const missing = builtinTimbresFor(piece.voices.filter((v) => !(v.timbre in piece.timbres)));
  return Object.keys(missing).length === 0
    ? piece
    : { ...piece, timbres: { ...piece.timbres, ...missing } };
}

/** Patches one voice. Returns the same piece when the voice is unknown or nothing changes. */
export function patchVoice(piece: Piece, id: VoiceId, patch: VoicePatch): Piece {
  const i = piece.voices.findIndex((v) => v.id === id);
  if (i < 0) return piece;
  const old = piece.voices[i];
  const next: VoiceDef = { ...old };
  let changed = false;
  for (const [k, value] of Object.entries(patch) as [keyof VoicePatch, unknown][]) {
    if (k === 'range') {
      const r = value as [Pitch, Pitch];
      if (r[0] === old.range[0] && r[1] === old.range[1]) continue;
      next.range = [r[0], r[1]];
    } else {
      if (old[k] === value) continue;
      if (value === undefined) delete next[k];
      else (next as unknown as Record<string, unknown>)[k] = value;
    }
    changed = true;
  }
  if (!changed) return piece;
  const voices = [...piece.voices];
  voices[i] = next;
  const out = { ...piece, voices };
  return patch.timbre !== undefined ? withTimbres(out) : out;
}

/** A valid range from two typed bounds: integers in 0..127, swapped if reversed. */
export function normalizeRange(lo: number, hi: number): [Pitch, Pitch] {
  const a = clampInt(lo, PITCH_MIN, PITCH_MAX);
  const b = clampInt(hi, PITCH_MIN, PITCH_MAX);
  return a <= b ? [a, b] : [b, a];
}

/** Timbre names to offer: the piece's own, then built-ins not shadowed, then `current` if unknown. */
export function timbreOptions(piece: Piece, current?: string): string[] {
  const names = Object.keys(piece.timbres);
  for (const b of Object.keys(BUILTIN_TIMBRES)) if (!names.includes(b)) names.push(b);
  if (current !== undefined && !names.includes(current)) names.push(current);
  return names;
}

// ---------------------------------------------------------------------------------------------
// Mute and solo
// ---------------------------------------------------------------------------------------------

/** True if some voice is soloed. */
export function anySolo(voices: readonly VoiceDef[]): boolean {
  return voices.some((v) => v.solo === true);
}

/** Whether each voice is heard: not muted, and soloed when any voice is (as the DSP decides). */
export function heardVoices(voices: readonly VoiceDef[]): boolean[] {
  const solo = anySolo(voices);
  return voices.map((v) => !v.mute && (!solo || v.solo === true));
}

/** Toggles a voice's mute (`mute` is removed rather than set false). */
export function toggleMute(piece: Piece, id: VoiceId): Piece {
  const v = piece.voices.find((x) => x.id === id);
  return v ? patchVoice(piece, id, { mute: v.mute ? undefined : true }) : piece;
}

/**
 * Toggles a voice's solo. With `exclusive`, the voice becomes the only soloed one (or, if it
 * already was, solo is cleared).
 */
export function toggleSolo(piece: Piece, id: VoiceId, exclusive = false): Piece {
  const v = piece.voices.find((x) => x.id === id);
  if (!v) return piece;
  if (!exclusive) return patchVoice(piece, id, { solo: v.solo ? undefined : true });
  const only = v.solo === true && piece.voices.every((x) => x.id === id || !x.solo);
  let out = piece;
  for (const x of piece.voices) {
    out = patchVoice(out, x.id, { solo: !only && x.id === id ? true : undefined });
  }
  return out;
}

/** Clears every solo. */
export function clearSolo(piece: Piece): Piece {
  let out = piece;
  for (const v of piece.voices) if (v.solo) out = patchVoice(out, v.id, { solo: undefined });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Voices active at start
// ---------------------------------------------------------------------------------------------

/** The start pitch of `id`, or undefined when it doesn't start. */
export function startPitchOf(piece: Piece, id: VoiceId): Pitch | undefined {
  return piece.start.find((s) => s.voice === id)?.pitch;
}

/** Folds `p` into `[lo, hi]` by octaves (the compiler folds too; this keeps the field honest). */
function foldInto(p: Pitch, lo: Pitch, hi: Pitch): Pitch {
  if (hi - lo < 12) return Math.max(lo, Math.min(hi, p));
  let x = p;
  while (x < lo) x += 12;
  while (x > hi) x -= 12;
  return x;
}

/** A start pitch for a newly started voice: a fifth above the highest start pitch, else A3. */
function newStartPitch(piece: Piece, v: VoiceDef): Pitch {
  const top = piece.start.reduce((m, s) => Math.max(m, s.pitch), -Infinity);
  const p = Number.isFinite(top) ? top + 7 : DEFAULT_START_PITCH;
  return foldInto(p, v.range[0], v.range[1]);
}

/** Starts or stops voice `id` at t = 0. A started voice gets `pitch`, or a default. */
export function setStarts(piece: Piece, id: VoiceId, on: boolean, pitch?: Pitch): Piece {
  const v = piece.voices.find((x) => x.id === id);
  if (!v) return piece;
  const i = piece.start.findIndex((s) => s.voice === id);
  if (!on) {
    return i < 0 ? piece : { ...piece, start: piece.start.filter((_, j) => j !== i) };
  }
  if (i >= 0) return pitch === undefined ? piece : setStartPitch(piece, id, pitch);
  return {
    ...piece,
    start: [...piece.start, { voice: id, pitch: pitch ?? newStartPitch(piece, v) }],
  };
}

/** Changes a started voice's pitch (no change if it doesn't start). */
export function setStartPitch(piece: Piece, id: VoiceId, pitch: Pitch): Piece {
  const i = piece.start.findIndex((s) => s.voice === id);
  if (i < 0 || !Number.isFinite(pitch) || piece.start[i].pitch === pitch) return piece;
  const start = [...piece.start];
  start[i] = { ...start[i], pitch };
  return { ...piece, start };
}

/** Number of pool voices active at start (entries naming unknown voices aren't counted). */
export function startCount(piece: Piece): number {
  const ids = new Set(piece.voices.map((v) => v.id));
  return new Set(piece.start.filter((s) => ids.has(s.voice)).map((s) => s.voice)).size;
}

/**
 * Sets how many voices are active at start (0..pool size): stops the started voices with the
 * highest pool index, or starts the lowest-index silent ones.
 */
export function setStartCount(piece: Piece, count: number): Piece {
  const n = clampInt(count, 0, piece.voices.length);
  let out = piece;
  let cur = startCount(piece);
  if (n < cur) {
    for (let i = piece.voices.length - 1; i >= 0 && cur > n; i--) {
      const id = piece.voices[i].id;
      if (startPitchOf(out, id) !== undefined) {
        out = setStarts(out, id, false);
        cur--;
      }
    }
  } else {
    for (let i = 0; i < piece.voices.length && cur < n; i++) {
      const id = piece.voices[i].id;
      if (startPitchOf(out, id) === undefined) {
        out = setStarts(out, id, true);
        cur++;
      }
    }
  }
  return out;
}
