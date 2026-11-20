/**
 * The Generate panel's form, as pure functions (PLAN.md §11.3 "Generate"): parsing the seed,
 * validating the fields, and mapping them to `generate()`'s arguments. No DOM and no store, so
 * they are unit-tested in Node.
 */

import { generate, type GenerateMode, type GenerateOptions } from '../core/generate';
import { MAX_VOICES, type Piece } from '../core/types';

/** The modes `generate()` offers, with their labels. */
export const GENERATE_MODES: readonly { id: GenerateMode; label: string }[] = [
  { id: 'dorian', label: 'Dorian' },
  { id: 'aeolian', label: 'Aeolian' },
  { id: 'lydian', label: 'Lydian' },
  { id: 'pentatonic', label: 'Pentatonic' },
];

/** Voice count range: `generate()` clamps to 2..MAX_VOICES. */
export const VOICES_MIN = 2;
export const VOICES_MAX = MAX_VOICES;
/** Length range in seconds. Every section is kept, so about 100 s is the shortest piece. */
export const LENGTH_MIN = 100;
export const LENGTH_MAX = 900;
export const LENGTH_STEP = 10;
/** The slider's starting point when the length is switched from "natural" to chosen. */
export const LENGTH_START = 150;

/** What the panel's controls hold. */
export interface GenerateForm {
  /** Free text: a number is used as it is, anything else is hashed to one. */
  seed: string;
  mode: GenerateMode;
  /** Chosen length in seconds; used only when `naturalLength` is false. */
  length: number;
  /** True: the prototype's proportions (about 2.5 minutes), as `generate()` does with no length. */
  naturalLength: boolean;
  voices: number;
  /** Walk density, 0..1. */
  density: number;
}

/** The panel's starting values (the seed is drawn fresh by the panel). */
export const DEFAULT_FORM: Omit<GenerateForm, 'seed'> = {
  mode: 'dorian',
  length: LENGTH_START,
  naturalLength: true,
  voices: 12,
  density: 0.45,
};

/** A validated form: the seed as `generate()` takes it, and the options. */
export interface GenerateRequest {
  seed: number;
  options: GenerateOptions;
}

export type FieldErrors = Partial<Record<'seed' | 'length' | 'voices' | 'density', string>>;

export type FormCheck = { ok: true; request: GenerateRequest } | { ok: false; errors: FieldErrors };

/** FNV-1a over the UTF-16 code units: a stable unsigned 32-bit hash for text seeds. */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The numeric seed for a seed field. A whole number (digits, optional sign) is taken modulo 2³²,
 * as `generate()` does, so "7" and "4294967303" are the same seed. Other text is hashed. Blank
 * text gives null (an error in the form).
 */
export function parseSeed(text: string): number | null {
  const t = text.trim();
  if (t === '') return null;
  // BigInt keeps long digit strings exact.
  if (/^[+-]?\d+$/.test(t)) return Number(BigInt.asUintN(32, BigInt(t)));
  return hashSeed(t);
}

/** A fresh random seed (an integer 0..2³²−1). The app may use Math.random; core may not. */
export function newSeed(random: () => number = Math.random): number {
  return Math.floor(random() * 0x1_0000_0000) >>> 0;
}

/**
 * Checks the form and maps it to `generate()`'s arguments. Out-of-range numbers are errors (the
 * sliders cannot produce them, but a hand-edited state or test can); `now` becomes `meta.created`.
 */
export function checkForm(form: GenerateForm, now?: string): FormCheck {
  const errors: FieldErrors = {};
  const seed = parseSeed(form.seed);
  if (seed === null) errors.seed = 'Enter a seed: a number or any text.';
  if (!Number.isInteger(form.voices) || form.voices < VOICES_MIN || form.voices > VOICES_MAX) {
    errors.voices = `Voices must be a whole number from ${VOICES_MIN} to ${VOICES_MAX}.`;
  }
  if (!Number.isFinite(form.density) || form.density < 0 || form.density > 1) {
    errors.density = 'Density must be from 0 to 1.';
  }
  if (
    !form.naturalLength &&
    (!Number.isFinite(form.length) || form.length < LENGTH_MIN || form.length > LENGTH_MAX)
  ) {
    errors.length = `Length must be from ${LENGTH_MIN} to ${LENGTH_MAX} seconds.`;
  }
  if (Object.keys(errors).length > 0 || seed === null) return { ok: false, errors };
  const options: GenerateOptions = {
    mode: form.mode,
    voices: form.voices,
    density: Math.round(form.density * 100) / 100,
  };
  if (!form.naturalLength) options.length = Math.round(form.length);
  if (now !== undefined) options.now = now;
  return { ok: true, request: { seed, options } };
}

/** Runs a validated request through core's `generate`. */
export function generateFromRequest(req: GenerateRequest): Piece {
  return generate(req.seed, req.options);
}

/** "2:30" for 150 seconds. */
export function formatLength(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
