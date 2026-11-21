/**
 * The timbre editor behind the Sound drawer (PLAN.md §11.3, §8.5): pure recipes on a piece's
 * timbres, the slider table, preset loading, and the drawer's own state.
 *
 * - **Built-ins stay put.** Editing a built-in preset stores an edited copy under the same name in
 *   `Piece.timbres` (which overrides built-ins), so every note using it changes at once and the
 *   built-in itself is never touched. "Revert" puts the built-in's values back.
 * - **One drag, one undo entry.** `dragTimbre` opens a history gesture, coalesces the slider's
 *   input events to one piece update per animation frame (each rebuilds the timbre's tables), and
 *   `endTimbreDrag` flushes and closes it. Keyboard steps are one `edit` each.
 * - **Names follow (M6-b3).** Renaming the piece's own timbre renames it on its notes and on the
 *   timbre moments naming it; deleting one (only when no note uses it) leaves those moments
 *   naming a missing timbre, so they show `unknown-timbre`.
 */

import { create } from 'zustand';
import { BUILTIN_TIMBRES } from '../../core/timbres';
import type { MomentId, Piece, Timbre, VoiceId } from '../../core/types';
import { beginGesture, endGesture, inGesture, updateGesture, type Recipe } from './history';

/** Most partials a timbre has (§8.5); a stretched timbre plays only the first 16. */
export const MAX_PARTIALS = 32;
export const STRETCH_PARTIALS = 16;

// ---------------------------------------------------------------------------------------------
// Drawer state
// ---------------------------------------------------------------------------------------------

/** Where "Load preset" puts the loaded timbre. */
export type LoadTarget = 'users' | 'all' | 'none' | { voice: VoiceId };

interface SoundDrawerState {
  open: boolean;
  /** The timbre being edited; null follows the first note's timbre. */
  name: string | null;
}

/** The drawer's state (not saved with the piece). */
export const useSoundDrawer = create<SoundDrawerState>()(() => ({ open: false, name: null }));

/** Opens or closes the drawer. */
export function toggleSoundDrawer(open = !useSoundDrawer.getState().open): void {
  useSoundDrawer.setState({ open });
}

/** Chooses the timbre to edit. */
export function selectTimbre(name: string): void {
  useSoundDrawer.setState({ name });
}

/** The timbre the editor shows: the chosen one while it exists, else the first note's. */
export function editedName(piece: Piece, chosen: string | null): string {
  if (chosen !== null && (chosen in piece.timbres || chosen in BUILTIN_TIMBRES)) return chosen;
  return piece.voices[0]?.timbre ?? 'sine';
}

// ---------------------------------------------------------------------------------------------
// Reading and comparing
// ---------------------------------------------------------------------------------------------

/** The definition `name` plays with in `piece` (as the engine resolves it). */
export function timbreIn(piece: Piece, name: string): Timbre {
  return piece.timbres[name] ?? BUILTIN_TIMBRES[name] ?? BUILTIN_TIMBRES.sine;
}

/** Structural equality of JSON-like values (key order ignored, undefined fields ignored). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => sameValue(x, bb[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) if (!sameValue(ra[k], rb[k])) return false;
  return true;
}

/** True if `name` is a built-in whose piece copy differs from it. */
export function isModified(piece: Piece, name: string): boolean {
  const b = BUILTIN_TIMBRES[name];
  const own = piece.timbres[name];
  return b !== undefined && own !== undefined && !sameValue(b, own);
}

/** True if `name` is the piece's own timbre (not a built-in name). */
export function isCustom(piece: Piece, name: string): boolean {
  return name in piece.timbres && !(name in BUILTIN_TIMBRES);
}

/** Ids of the notes (voices) whose timbre is `name`. */
export function timbreUsers(piece: Piece, name: string): VoiceId[] {
  return piece.voices.filter((v) => v.timbre === name).map((v) => v.id);
}

/** Ids of the timbre moments (M6) that change to `name`. */
export function timbreMoments(piece: Piece, name: string): MomentId[] {
  return piece.moments.filter((m) => m.type === 'timbre' && m.preset === name).map((m) => m.id);
}

// ---------------------------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------------------------

/** A pure timbre transform; return the same object for "no change". */
export type TimbreFn = (t: Timbre) => Timbre;

/**
 * Applies `f` to timbre `name` and stores the result in the piece. A built-in is deep-copied
 * first, so the result shares nothing with it. Same piece when nothing changes.
 */
export function editTimbre(piece: Piece, name: string, f: TimbreFn): Piece {
  const own = piece.timbres[name];
  const base = own ?? structuredClone(timbreIn(piece, name));
  const next = f(base);
  if (own !== undefined && (next === own || sameValue(next, own))) return piece;
  if (own === undefined && sameValue(next, timbreIn(piece, name))) return piece;
  return { ...piece, timbres: { ...piece.timbres, [name]: next } };
}

/** A recipe for `editTimbre`, for `edit` and gestures. */
export function timbreRecipe(name: string, f: TimbreFn): Recipe {
  return (p) => editTimbre(p, name, f);
}

type Rec = Record<string, unknown>;

/** The number at `path` in `t`, or undefined (e.g. `fm` absent). */
export function valueAt(t: Timbre, path: readonly string[]): number | undefined {
  let cur: unknown = t;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Rec)[k];
  }
  return typeof cur === 'number' ? cur : undefined;
}

/** Sets the number at `path` (copying the objects on the way); no-op if a parent is absent. */
export function setAt(path: readonly string[], value: number): TimbreFn {
  return (t) => {
    const go = (obj: Rec, i: number): Rec | null => {
      const k = path[i];
      if (i === path.length - 1) return obj[k] === value ? obj : { ...obj, [k]: value };
      const child = obj[k];
      if (child === null || typeof child !== 'object') return null;
      const next = go(child as Rec, i + 1);
      return next === null ? null : next === child ? obj : { ...obj, [k]: next };
    };
    return (go(t as unknown as Rec, 0) as unknown as Timbre | null) ?? t;
  };
}

/** Sets partial `i` (0 = fundamental). */
export function setHarmonic(i: number, amp: number): TimbreFn {
  return (t) => {
    if (i < 0 || i >= t.harmonics.length || t.harmonics[i] === amp) return t;
    const harmonics = t.harmonics.slice();
    harmonics[i] = amp;
    return { ...t, harmonics };
  };
}

/** Adds a silent partial at the top (up to 32). */
export const addPartial: TimbreFn = (t) =>
  t.harmonics.length >= MAX_PARTIALS ? t : { ...t, harmonics: [...t.harmonics, 0] };

/** Removes the top partial (keeping at least one). */
export const removePartial: TimbreFn = (t) =>
  t.harmonics.length <= 1 ? t : { ...t, harmonics: t.harmonics.slice(0, -1) };

/** Values a section starts from when switched on. */
export const FM_ON: NonNullable<Timbre['fm']> = { ratio: 2, index: 1, indexTrack: 0.5 };
export const NOISE_ON: NonNullable<Timbre['noise']> = { level: 0.1, bandwidth: 0.5 };

function without<T extends object, K extends keyof T>(t: T, key: K): T {
  const out = { ...t };
  delete out[key];
  return out;
}

/** Switches FM on (from `FM_ON`) or off. */
export function setFmOn(on: boolean): TimbreFn {
  return (t) =>
    on === (t.fm !== undefined) ? t : on ? { ...t, fm: { ...FM_ON } } : without(t, 'fm');
}

/** Switches breath noise on (from `NOISE_ON`) or off. */
export function setNoiseOn(on: boolean): TimbreFn {
  return (t) =>
    on === (t.noise !== undefined)
      ? t
      : on
        ? { ...t, noise: { ...NOISE_ON } }
        : without(t, 'noise');
}

/** The strike style: `auto` leaves `crisp` out (crisp from amount ≥ 0.5). */
export type Strike = 'auto' | 'crisp' | 'soft';

export function strikeOf(t: Timbre): Strike {
  const c = t.articulation.crisp;
  return c === undefined ? 'auto' : c ? 'crisp' : 'soft';
}

export function setStrike(s: Strike): TimbreFn {
  return (t) => {
    if (strikeOf(t) === s) return t;
    const articulation =
      s === 'auto' ? without(t.articulation, 'crisp') : { ...t.articulation, crisp: s === 'crisp' };
    return { ...t, articulation };
  };
}

/** Puts a built-in's own values back (keeps the piece's copy, as new pieces store one). */
export function revertTimbre(piece: Piece, name: string): Piece {
  const b = BUILTIN_TIMBRES[name];
  if (!b || !isModified(piece, name)) return piece;
  return { ...piece, timbres: { ...piece.timbres, [name]: structuredClone(b) } };
}

/** `base` if it names nothing yet, else `base 2`, `base 3`, … */
export function freeTimbreName(piece: Piece, base: string): string {
  const taken = (n: string) => n in piece.timbres || n in BUILTIN_TIMBRES;
  const stem = base.replace(/ \d+$/, '').trim() || 'timbre';
  if (!taken(base)) return base;
  for (let k = 2; ; k++) if (!taken(`${stem} ${k}`)) return `${stem} ${k}`;
}

/** Why the piece's own timbre `from` can't be renamed `to`, or null when it can. */
export function timbreRenameError(piece: Piece, from: string, to: string): string | null {
  const name = to.trim();
  if (name === '') return 'A timbre needs a name';
  if (name === from) return null;
  if (Object.hasOwn(piece.timbres, name) || Object.hasOwn(BUILTIN_TIMBRES, name)) {
    return `A timbre named ${name} exists`;
  }
  return null;
}

/**
 * Renames the piece's own timbre `from` (not a built-in) to `to` (trimmed): its entry in
 * `timbres` (order kept), the notes using it and the timbre moments naming it, so one `edit` is
 * one undo entry. Same piece when the name is unchanged or refused (`timbreRenameError`).
 */
export function renameTimbre(piece: Piece, from: string, to: string): Piece {
  const name = to.trim();
  if (!isCustom(piece, from) || name === from || timbreRenameError(piece, from, name) !== null) {
    return piece;
  }
  const timbres = Object.fromEntries(
    Object.entries(piece.timbres).map(([k, t]) => [k === from ? name : k, t]),
  );
  const voices = piece.voices.map((v) => (v.timbre === from ? { ...v, timbre: name } : v));
  const moments = piece.moments.map((m) =>
    m.type === 'timbre' && m.preset === from ? { ...m, preset: name } : m,
  );
  return { ...piece, timbres, voices, moments };
}

/**
 * Deletes the piece's own timbre `name` (not a built-in) when no note uses it. Timbre moments
 * naming it are kept: they name a missing timbre (`unknown-timbre`, skipped) until one exists.
 */
export function deleteTimbre(piece: Piece, name: string): Piece {
  if (!isCustom(piece, name) || timbreUsers(piece, name).length > 0) return piece;
  const timbres = { ...piece.timbres };
  delete timbres[name];
  return { ...piece, timbres };
}

/** A copy of timbre `name` under a fresh name (no note uses it yet). */
export function duplicateTimbre(piece: Piece, name: string): { piece: Piece; name: string } {
  const copy = freeTimbreName(piece, `${name} 2`);
  return {
    piece: {
      ...piece,
      timbres: { ...piece.timbres, [copy]: structuredClone(timbreIn(piece, name)) },
    },
    name: copy,
  };
}

/**
 * Adds a loaded preset to the piece and gives it to `target`'s notes: `users` = the notes using
 * `current` (the timbre being edited), `all`, `none`, or one voice. The preset keeps its name
 * unless that name already means a different timbre (then `name 2`, …). Returns the new piece
 * and the name the timbre is stored under.
 */
export function loadPreset(
  piece: Piece,
  preset: { name: string; timbre: Timbre },
  target: LoadTarget,
  current: string,
): { piece: Piece; name: string } {
  const existing = piece.timbres[preset.name] ?? BUILTIN_TIMBRES[preset.name];
  let name = preset.name;
  let out = piece;
  if (existing === undefined || !sameValue(existing, preset.timbre)) {
    if (existing !== undefined) name = freeTimbreName(piece, preset.name);
    out = { ...out, timbres: { ...out.timbres, [name]: preset.timbre } };
  }
  const gets = (id: VoiceId, timbre: string): boolean =>
    target === 'all' ||
    (target === 'users' && timbre === current) ||
    (typeof target === 'object' && target.voice === id);
  if (target !== 'none' && out.voices.some((v) => gets(v.id, v.timbre) && v.timbre !== name)) {
    out = {
      ...out,
      voices: out.voices.map((v) => (gets(v.id, v.timbre) ? { ...v, timbre: name } : v)),
    };
  }
  return { piece: out, name };
}

// ---------------------------------------------------------------------------------------------
// Sliders
// ---------------------------------------------------------------------------------------------

/** How a slider's position maps to its value. */
export type Curve = 'lin' | 'log' | 'sqrt';

export interface TimbreControl {
  /** Test id suffix and React key. */
  id: string;
  label: string;
  section: 'shape' | 'fm' | 'noise' | 'articulation' | 'vibrato';
  path: readonly string[];
  min: number;
  max: number;
  /** Linear sliders round to this; log and sqrt ones to 3 significant digits. */
  step: number;
  curve: Curve;
  unit: string;
}

const c = (
  id: string,
  label: string,
  section: TimbreControl['section'],
  path: readonly string[],
  min: number,
  max: number,
  step: number,
  unit = '',
  curve: Curve = 'lin',
): TimbreControl => ({ id, label, section, path, min, max, step, curve, unit });

/** Every slider of the editor except the partials; all ranges lie inside the schema's bounds. */
export const TIMBRE_CONTROLS: readonly TimbreControl[] = [
  c('stretch', 'Stretch', 'shape', ['stretch'], -0.5, 1, 0.005),
  c('tilt', 'Brightness', 'shape', ['brightness', 'tilt'], -12, 6, 0.1, ' dB/oct'),
  c('track', 'Brightness tracking', 'shape', ['brightness', 'track'], 0, 1, 0.01),
  c('detune', 'Detune spread', 'shape', ['detuneSpread'], 0, 20, 0.1, ' ct'),
  c('accent', 'Accent', 'shape', ['accent'], 0, 1, 0.01),
  c('fm-ratio', 'FM ratio', 'fm', ['fm', 'ratio'], 0.05, 16, 0.01, '', 'log'),
  c('fm-index', 'FM index', 'fm', ['fm', 'index'], 0, 10, 0.01),
  c('fm-track', 'FM index tracking', 'fm', ['fm', 'indexTrack'], -4, 4, 0.05),
  c('noise-level', 'Noise level', 'noise', ['noise', 'level'], 0, 2, 0.005, '', 'sqrt'),
  c('noise-band', 'Noise band', 'noise', ['noise', 'bandwidth'], 0.02, 8, 0.01, '', 'log'),
  c('art-amount', 'Articulation', 'articulation', ['articulation', 'amount'], 0, 1, 0.01),
  c(
    'art-attack',
    'Attack',
    'articulation',
    ['articulation', 'attack'],
    0.001,
    1,
    0.001,
    ' s',
    'log',
  ),
  c('art-decay', 'Decay', 'articulation', ['articulation', 'decay'], 0.01, 8, 0.01, ' s', 'log'),
  c('vib-rate', 'Vibrato rate', 'vibrato', ['vibrato', 'rate'], 0, 12, 0.1, ' Hz'),
  c('vib-depth', 'Vibrato depth', 'vibrato', ['vibrato', 'depthCents'], 0, 60, 0.5, ' ct'),
  c('vib-delay', 'Vibrato delay', 'vibrato', ['vibrato', 'delay'], 0, 3, 0.01, ' s'),
  c('vib-jitter', 'Vibrato jitter', 'vibrato', ['vibrato', 'jitter'], 0, 1, 0.01),
];

/** The partial sliders: amplitude 0..1 on a square-root curve (fine control near silence). */
export const PARTIAL_CONTROL = c('partial', 'Partial', 'shape', [], 0, 1, 0.001, '', 'sqrt');

/** Slider resolution: positions run 0..SLIDER_STEPS. */
export const SLIDER_STEPS = 1000;

const sig3 = (x: number): number => (x === 0 ? 0 : Number(x.toPrecision(3)));

/** The value at slider position `pos` (0..SLIDER_STEPS), rounded to the control's resolution. */
export function valueOf(ctl: TimbreControl, pos: number): number {
  const u = Math.max(0, Math.min(1, pos / SLIDER_STEPS));
  let x: number;
  if (ctl.curve === 'log') x = ctl.min * Math.pow(ctl.max / ctl.min, u);
  else if (ctl.curve === 'sqrt') x = ctl.min + (ctl.max - ctl.min) * u * u;
  else x = ctl.min + (ctl.max - ctl.min) * u;
  if (ctl.curve !== 'lin') return Math.max(ctl.min, Math.min(ctl.max, sig3(x)));
  const decimals = Math.max(0, -Math.floor(Math.log10(ctl.step) + 1e-9));
  const r = Number((Math.round(x / ctl.step) * ctl.step).toFixed(decimals));
  return Object.is(r, -0) ? 0 : Math.max(ctl.min, Math.min(ctl.max, r));
}

/** The slider position (0..SLIDER_STEPS) showing `value` (clamped to the range). */
export function positionOf(ctl: TimbreControl, value: number): number {
  const x = Math.max(ctl.min, Math.min(ctl.max, value));
  let u: number;
  if (ctl.curve === 'log') u = Math.log(x / ctl.min) / Math.log(ctl.max / ctl.min);
  else if (ctl.curve === 'sqrt') u = Math.sqrt((x - ctl.min) / (ctl.max - ctl.min));
  else u = (x - ctl.min) / (ctl.max - ctl.min);
  return Math.round(u * SLIDER_STEPS);
}

/** A value for display: up to 3 decimals, trailing zeros dropped. */
export function formatValue(ctl: TimbreControl, value: number | undefined): string {
  if (value === undefined) return '–';
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : value === 0 ? 0 : 3;
  return `${Number(value.toFixed(digits))}${ctl.unit}`;
}

// ---------------------------------------------------------------------------------------------
// Drags
// ---------------------------------------------------------------------------------------------

let pending: Recipe | null = null;
let frame = false;

function flush(): void {
  frame = false;
  const r = pending;
  pending = null;
  if (r && inGesture()) updateGesture(r);
}

/** Starts a slider drag: one undo entry, labelled `label`, until `endTimbreDrag`. */
export function beginTimbreDrag(label: string): void {
  pending = null;
  beginGesture(label);
}

/**
 * Shows `recipe` (applied to the piece as it was when the drag began). Updates are coalesced to
 * one per animation frame, since each one rebuilds the timbre's wavetables.
 */
export function dragTimbre(recipe: Recipe): void {
  pending = recipe;
  if (frame) return;
  frame = true;
  requestAnimationFrame(flush);
}

/** Ends the drag: applies the last value and closes the undo entry. */
export function endTimbreDrag(): void {
  if (pending) flush();
  endGesture();
}
