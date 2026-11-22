/**
 * Musical typing (PLAN.md §9 "Inputs"): the DAW layout `A W S E D F T G Y H U J K` (C up to the
 * next C), `Z`/`X` for the octave, and `` ` `` to toggle the mode. Pure: the key handler lives in
 * ./live-ui.ts. Keys are read by physical position (`KeyboardEvent.code`), falling back to the
 * letter when a browser gives no code.
 */

import type { Pitch } from '../core/types';
import { takesText } from './editor/shortcuts';

/** Semitones above the octave's C for each note key. */
export const TYPING_NOTES: Readonly<Record<string, number>> = {
  KeyA: 0,
  KeyW: 1,
  KeyS: 2,
  KeyE: 3,
  KeyD: 4,
  KeyF: 5,
  KeyT: 6,
  KeyG: 7,
  KeyY: 8,
  KeyH: 9,
  KeyU: 10,
  KeyJ: 11,
  KeyK: 12,
};

/** Octave of the A key's C (scientific: C4 = MIDI 60), and its limits (top key C8). */
export const DEFAULT_OCTAVE = 4;
export const OCTAVE_MIN = 1;
export const OCTAVE_MAX = 7;

type KeyLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'> & {
  code?: string;
  repeat?: boolean;
  target?: unknown;
};

/** `KeyA`…`KeyZ` for a letter key: its code, else (no code) its letter. */
export function letterCode(e: Pick<KeyLike, 'key' | 'code'>): string | null {
  if (e.code && /^Key[A-Z]$/.test(e.code)) return e.code;
  if (!e.code && /^[a-z]$/i.test(e.key)) return `Key${e.key.toUpperCase()}`;
  return null;
}

/** The pitch a note key plays in `octave`, or null for any other key. */
export function typingPitch(code: string, octave: number): Pitch | null {
  const k = TYPING_NOTES[code];
  return k === undefined ? null : 12 * (octave + 1) + k;
}

/** `octave` moved by `dir`, within [OCTAVE_MIN, OCTAVE_MAX]. */
export function shiftOctave(octave: number, dir: number): number {
  return Math.min(OCTAVE_MAX, Math.max(OCTAVE_MIN, octave + dir));
}

/** What a keydown does with musical typing. */
export type TypingAction =
  | { kind: 'toggle' }
  | { kind: 'note'; code: string; pitch: Pitch }
  | { kind: 'octave'; dir: -1 | 1 }
  /** A letter with no note: used up so no editor shortcut fires. */
  | { kind: 'swallow' };

/** True for the toggle key, `` ` `` (Backquote). */
export function isToggleKey(e: Pick<KeyLike, 'key' | 'code'>): boolean {
  return e.code === 'Backquote' || (!e.code && e.key === '`');
}

/**
 * The musical-typing action for a keydown (notes in `octave`), or null to leave the key to the editor. Text fields
 * keep their keys, and ⌘/Ctrl/Alt chords stay shortcuts; with the mode on, every other letter
 * (Shift or not, repeats included) is taken. Repeats of note keys are `swallow`, not notes.
 */
export function typingAction(
  e: KeyLike,
  on: boolean,
  octave: number = DEFAULT_OCTAVE,
): TypingAction | null {
  if (takesText(e.target)) return null;
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  if (isToggleKey(e)) return e.repeat ? { kind: 'swallow' } : { kind: 'toggle' };
  if (!on) return null;
  const code = letterCode(e);
  if (code === null) return null;
  if (e.repeat) return { kind: 'swallow' };
  if (code === 'KeyZ') return { kind: 'octave', dir: -1 };
  if (code === 'KeyX') return { kind: 'octave', dir: 1 };
  const pitch = typingPitch(code, octave);
  return pitch === null ? { kind: 'swallow' } : { kind: 'note', code, pitch };
}

/** "C4" for octave 4 (the A key's note). */
export function octaveLabel(octave: number): string {
  return `C${octave}`;
}
