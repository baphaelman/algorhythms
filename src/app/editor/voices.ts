/**
 * Pure piece recipes for the Voices drawer (PLAN.md §11.3): pool size and per-voice settings.
 * Each returns the same piece object when nothing changes (so `edit` records no entry), else a new
 * piece sharing the untouched parts. What sounds at the start is the moment at t = 0 (M4.5-27),
 * edited like any other moment.
 *
 * Shrinking the pool removes voices from the end (highest pool index) and keeps the piece valid:
 * `{ voices }` targets drop them, and a moment left with no target
 * voices is deleted; pins on removed voices are deleted; split, merge and chord counts are
 * clamped to the new pool size. `poolShrinkEffects` reports this beforehand.
 */

import { builtinTimbresFor, DEFAULT_RANGE, DEFAULT_TIMBRE } from '../../core/defaults';
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
    // A by-voice chord (a migrated opening) gives pitch i to voice i: drop the removed ones'.
    if (out.type === 'chord' && out.byVoice && out.notes.kind === 'pitches') {
      const ps = out.notes.pitches;
      if (ps.length === t.voices.length) {
        const pitches = ps.filter((_, i) => !gone.has(t.voices[i]));
        out = { ...out, notes: { kind: 'pitches', pitches } };
      }
    }
  }
  if (
    (out.type === 'split' ||
      out.type === 'merge' ||
      out.type === 'chord' ||
      out.type === 'progression') &&
    out.count !== undefined &&
    out.count > size
  ) {
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

export type SendKey = 'reverb' | 'delay';

/** The send level voice `v` plays with: its own, else the mix default. */
export function sendOf(piece: Piece, v: VoiceDef, key: SendKey): number {
  return v.sends?.[key] ?? piece.mix.sends[key];
}

/**
 * Sets voice `id`'s own `key` send (linear 0..1); `undefined` goes back to the mix default (an
 * empty `sends` is dropped). Same piece when unchanged.
 */
export function setVoiceSend(
  piece: Piece,
  id: VoiceId,
  key: SendKey,
  value: number | undefined,
): Piece {
  const i = piece.voices.findIndex((v) => v.id === id);
  const old = piece.voices[i];
  if (!old || old.sends?.[key] === value) return piece;
  const sends = { ...old.sends, [key]: value };
  if (value === undefined) delete sends[key];
  const next: VoiceDef = { ...old, sends };
  if (Object.keys(sends).length === 0) delete next.sends;
  const voices = [...piece.voices];
  voices[i] = next;
  return { ...piece, voices };
}

/** Timbre names to offer: the piece's own, then built-ins not shadowed, then `current` if unknown. */
export function timbreOptions(piece: Piece, current?: string): string[] {
  const names = Object.keys(piece.timbres);
  for (const b of Object.keys(BUILTIN_TIMBRES)) if (!names.includes(b)) names.push(b);
  if (current !== undefined && !names.includes(current)) names.push(current);
  return names;
}

/** Sets one timbre on every voice (one recipe, so one undo entry when passed to `edit`). */
export function setAllTimbres(piece: Piece, timbre: string): Piece {
  let out = piece;
  for (const v of piece.voices) out = patchVoice(out, v.id, { timbre });
  return out;
}

/** The timbre every voice shares, or undefined when they differ. */
export function commonTimbre(voices: readonly VoiceDef[]): string | undefined {
  const t = voices[0]?.timbre;
  return voices.every((v) => v.timbre === t) ? t : undefined;
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
