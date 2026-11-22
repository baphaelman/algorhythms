/**
 * Pure helpers for the inspector (PLAN.md §11.3): parsing and formatting of field text, the key
 * in effect at a time, chord feedback, degree-picker cells and the easing-curve preview path.
 */

import { parseChord } from '../../../core/chords';
import { bezierOf, ease, easeCodeOf } from '../../../core/ease';
import {
  FLAT_NAMES,
  SHARP_NAMES,
  noteName,
  parsePitchClass,
  pitchOfDegreeIndex,
  scaleIntervals,
} from '../../../core/scales';
import { activeAt, segmentAt } from '../../../core/query';
import type {
  CompiledScore,
  EaseRef,
  Glide,
  GlideArrive,
  Key,
  MomentId,
  Pitch,
  Seconds,
  Segment,
  VoiceSelector,
} from '../../../core/types';

/** The walk's allowed-step chips (§11.3): −3…+3 without 0. */
export const STEP_CHOICES: readonly number[] = [-3, -2, -1, 1, 2, 3];

/** Chips to show for a walk's steps: the standard choices plus any other stored step, sorted. */
export function stepChips(steps: readonly number[]): number[] {
  return [...new Set([...STEP_CHOICES, ...steps])].sort((a, b) => a - b);
}

/** Toggles `s` in a step list, kept sorted; null when that would leave no step. */
export function toggleStep(steps: readonly number[], s: number): number[] | null {
  const next = steps.includes(s)
    ? steps.filter((x) => x !== s)
    : [...steps, s].sort((a, b) => a - b);
  return next.length > 0 ? next : null;
}

/**
 * The inspector's voice-target modes (§11.3 Voices): all, a `rank` range by pitch, or a pick of
 * voices (under "Advanced"; the owner dropped Top n / Bottom n, revision 6), or one part (the
 * main section's Part chooser, revision 9).
 */
export type TargetMode = 'all' | 'rank' | 'pick' | 'part';

export function targetMode(t: VoiceSelector | undefined): TargetMode {
  if (!t || t === 'all') return 'all';
  if ('voices' in t) return 'pick';
  if ('part' in t) return 'part';
  return 'rank';
}

/** The target the Part chooser writes: undefined (the default, all) for '', else `{ part }`. */
export function partTarget(part: string): VoiceSelector | undefined {
  return part === '' ? undefined : { part };
}

/**
 * The moment's partial glide with Arrive together set to `on` (§7.2): the field is dropped when
 * it equals the piece default (`'together'` when unset), and an empty glide becomes undefined.
 */
export function arriveGlide(
  glide: Partial<Glide> | undefined,
  fallback: GlideArrive | undefined,
  on: boolean,
): Partial<Glide> | undefined {
  const want: GlideArrive = on ? 'together' : 'spread';
  const rest = { ...glide };
  delete rest.arrive;
  const next = want === (fallback ?? 'together') ? rest : { ...rest, arrive: want };
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * The glide patch for "Land at the marker" (`glide.land`, revision 9): the moment's own `land`
 * only when it differs from the piece default (`fallback`), so "on" over an "on" default stores
 * nothing. Undefined when no glide field is left.
 */
export function landGlide(
  glide: Partial<Glide> | undefined,
  fallback: boolean | undefined,
  on: boolean,
): Partial<Glide> | undefined {
  const rest = { ...glide };
  delete rest.land;
  const next = on === (fallback === true) ? rest : { ...rest, land: on };
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Shortest decimal text for `x`, at most `digits` decimals ("3", "0.25", "-1.5"). */
export function formatNum(x: number, digits = 3): string {
  if (!Number.isFinite(x)) return '';
  const s = x.toFixed(digits);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Parses a number; null if it isn't one or lies outside [min, max]. */
export function parseNum(text: string, min = -Infinity, max = Infinity): number | null {
  const t = text.trim().replace(',', '.').replace(/^−/, '-');
  if (t === '' || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) && v >= min && v <= max ? v : null;
}

/** "m:ss.s", e.g. 42.31 → "0:42.3". */
export function formatTime(t: Seconds): string {
  const tenths = Math.round(Math.max(0, t) * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths - m * 600) / 10;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

/**
 * Parses a pitch: a MIDI number ("60", "61.5") or a note name with octave ("C4", "F#3", "Bb2",
 * "C4+25" for cents). Null if invalid or outside 0..127.
 */
export function parsePitch(text: string): Pitch | null {
  const t = text.trim();
  const n = parseNum(t, 0, 127);
  if (n !== null) return n;
  const m = /^([A-Ga-g])([#b♯♭]?)(-?\d+)([+-]\d+(?:\.\d+)?)?$/.exec(t);
  if (!m) return null;
  const letter = parsePitchClass(m[1]);
  if (letter === null) return null;
  const acc = m[2] === '#' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
  const p = letter + acc + 12 * (Number(m[3]) + 1) + (m[4] ? Number(m[4]) / 100 : 0);
  return p >= 0 && p <= 127 ? p : null;
}

/** A pitch as a note name when it is a whole semitone ("C4"), else its number ("60.5"). */
export function formatPitch(p: Pitch): string {
  return Number.isInteger(p) ? noteName(p) : formatNum(p, 2);
}

/** Parses a whitespace/comma-separated pitch list; null if any item is invalid or it is empty. */
export function parsePitchList(text: string): Pitch[] | null {
  const items = text.split(/[\s,]+/).filter(Boolean);
  if (items.length === 0) return null;
  const out: Pitch[] = [];
  for (const it of items) {
    const p = parsePitch(it);
    if (p === null) return null;
    out.push(p);
  }
  return out;
}

export function formatPitchList(ps: readonly Pitch[]): string {
  return ps.map(formatPitch).join(' ');
}

/** Parses a list of integers ("-2, -1, 1 2"); null if empty or any item is not an integer. */
export function parseIntList(text: string): number[] | null {
  const items = text.split(/[\s,]+/).filter(Boolean);
  if (items.length === 0) return null;
  const out: number[] = [];
  for (const it of items) {
    const v = parseNum(it);
    if (v === null || !Number.isInteger(v)) return null;
    out.push(v);
  }
  return out;
}

export function formatIntList(xs: readonly number[]): string {
  return xs.join(' ');
}

/** The key in effect at `t` (from the compiled key timeline), or `fallback`. */
export function keyAt(score: Pick<CompiledScore, 'keys'>, t: Seconds, fallback: Key): Key {
  let k = fallback;
  for (const c of score.keys) {
    if (c.t <= t) k = c.key;
    else break;
  }
  return k;
}

/** Whether to spell notes in `key` with flats. */
export function prefersFlats(key: Key): boolean {
  return key.tonic.includes('b') || key.tonic === 'F';
}

/** Live feedback for a chord-symbol field: the spelled pitch classes, or the parse error. */
export function chordFeedback(
  symbol: string,
  key: Key,
): { ok: true; text: string } | { ok: false; text: string } {
  const r = parseChord(symbol, key);
  if (!r.ok) return { ok: false, text: r.error };
  const names = prefersFlats(key) ? FLAT_NAMES : SHARP_NAMES;
  return { ok: true, text: r.pcs.map((pc) => names[pc]).join(' ') };
}

/** A suggested flat for a Roman numeral that falls outside a minor-type key (composing.md §3 #10). */
export interface NumeralHint {
  /** The numeral as typed, e.g. 'VI'. */
  numeral: string;
  /** Its root spelled in the key, e.g. 'F♯'. */
  note: string;
  /** The suggested numeral, e.g. '♭VI'. */
  flat: string;
  /** The flat's root spelled in the key, e.g. 'F'. */
  flatNote: string;
  /** The whole symbol rewritten with the flat (ASCII 'b'), e.g. 'bVI7/C'. */
  fixed: string;
}

const HINT_NUMERAL_RE = /^(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)(?![IVXiv])/;
const LETTERS = 'CDEFGAB';
const LETTER_PCS = [0, 2, 4, 5, 7, 9, 11];
/** Semitones above the tonic of the major-scale degrees I..VII (the numeral ruler, §7.3). */
const NUMERAL_STEPS = [0, 2, 4, 5, 7, 9, 11];
const NUMERAL_NAMES = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/** A key whose scale has a minor third and no major third (aeolian, dorian, minor pentatonic…). */
export function isMinorType(key: Key): boolean {
  const iv = scaleIntervals(key.scale);
  return iv.includes(3) && !iv.includes(4);
}

/** Spells pitch class `pc` on the letter `degree` steps above the tonic's letter. */
function spellOnLetter(key: Key, degree: number, pc: number): string {
  const li = (LETTERS.indexOf(key.tonic.charAt(0)) + degree) % 7;
  let acc = (((pc - LETTER_PCS[li]) % 12) + 12) % 12;
  if (acc > 6) acc -= 12;
  const mark = acc > 0 ? '♯'.repeat(acc) : '♭'.repeat(-acc);
  return LETTERS.charAt(li) + mark;
}

/**
 * When `symbol` starts with an unaltered Roman numeral whose root is outside a minor-type key's
 * scale but whose flat is in it ('VI' in A minor), the flat to suggest. Numerals keep the
 * major-scale ruler (owner, 2026-11-21); this only points the difference out. Null otherwise,
 * including for applied chords (V/V), whose numeral is not measured from the key's tonic.
 */
export function numeralHint(symbol: string, key: Key): NumeralHint | null {
  if (!isMinorType(key)) return null;
  const s = symbol.trim();
  const m = HINT_NUMERAL_RE.exec(s);
  if (!m) return null;
  const slash = s.indexOf('/');
  if (slash >= 0 && /^[#b♯♭]?(VII|VI|V|IV|III|II|I|vii|vi|v|iv|iii|ii|i)$/.test(s.slice(slash + 1)))
    return null;
  if (!parseChord(s, key).ok) return null;
  const degree = NUMERAL_NAMES.indexOf(m[1].toUpperCase());
  const tonic = parsePitchClass(key.tonic) ?? 0;
  const pcs = new Set(scaleIntervals(key.scale).map((i) => (tonic + i) % 12));
  const pc = (tonic + NUMERAL_STEPS[degree]) % 12;
  const flatPc = (pc + 11) % 12;
  if (pcs.has(pc) || !pcs.has(flatPc)) return null;
  return {
    numeral: m[1],
    note: spellOnLetter(key, degree, pc),
    flat: `♭${m[1]}`,
    flatNote: spellOnLetter(key, degree, flatPc),
    fixed: `b${s}`,
  };
}

/** One cell of the degree picker. */
export interface DegreeCell {
  /** 0-based degree index (the stored value). */
  degree: number;
  /** 1-based display number. */
  label: string;
  /** Note name of the degree, relative to the tonic at octave 4. */
  note: string;
}

/**
 * Degree-picker cells: two octaves of the key's scale, widened to include every degree in
 * `selected` (degrees may be negative or exceed the scale length).
 */
export function degreeCells(key: Key, selected: readonly number[]): DegreeCell[] {
  const n = scaleIntervals(key.scale).length;
  let lo = 0;
  let hi = 2 * n - 1;
  for (const d of selected) {
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  const flats = prefersFlats(key);
  const out: DegreeCell[] = [];
  for (let d = lo; d <= hi; d++) {
    const p = pitchOfDegreeIndex(d, key) + 60;
    out.push({ degree: d, label: String(d + 1), note: noteName(p, flats).replace(/-?\d+$/, '') });
  }
  return out;
}

/** Toggles `d` in a degree list, keeping it sorted. */
export function toggleDegree(degrees: readonly number[], d: number): number[] {
  return degrees.includes(d)
    ? degrees.filter((x) => x !== d)
    : [...degrees, d].sort((a, b) => a - b);
}

/**
 * An SVG path (in a w × h box, y down) of the easing curve, sampled at n + 1 points. Bézier
 * overshoot is kept inside the box by mapping the curve's own y range (at least [0, 1]).
 */
export function easePath(ref: EaseRef, w: number, h: number, n = 48): string {
  const code = easeCodeOf(ref);
  const bz = bezierOf(ref);
  const ys: number[] = [];
  for (let i = 0; i <= n; i++) ys.push(ease(code, i / n, bz));
  const lo = Math.min(0, ...ys);
  const hi = Math.max(1, ...ys);
  const span = hi - lo;
  return ys
    .map(
      (y, i) =>
        `${i === 0 ? 'M' : 'L'}${formatNum((i / n) * w, 2)} ${formatNum(h - ((y - lo) / span) * h, 2)}`,
    )
    .join(' ');
}

/**
 * The notes sounding once a moment lands, low to high: each voice's destination from the moment's
 * own segments, else (a voice it held still, or didn't target) the destination of the segment
 * sounding at the end of the moment's span. Empty if the moment has no span.
 */
export function liveNotes(
  score: Pick<CompiledScore, 'voices' | 'momentSpans'>,
  momentId: MomentId,
): Pitch[] {
  const span = score.momentSpans.find((s) => s.id === momentId);
  if (!span) return [];
  const dest = (s: Segment): Pitch => (s.curve ? s.curve.p1 : s.p1);
  const out: Pitch[] = [];
  for (const v of score.voices) {
    let p: Pitch | null = null;
    for (const s of v.segments) if (s.momentId === momentId) p = dest(s);
    if (p === null) {
      const s = segmentAt(v, span.end);
      if (s) p = dest(s);
    }
    if (p !== null) out.push(p);
  }
  return out.sort((a, b) => a - b);
}

/** Octaves either side of 0 on the shift slider (§11.3 "Shift amount slider"). */
export const SHIFT_OCTAVES = 2;
/** Raw slider distance (in steps) from an octave mark within which a drag snaps to it. */
export const SHIFT_SNAP = 0.75;

/** Steps in one octave for a shift: 12 semitones, or the key's scale length in scale steps. */
export function shiftOctave(unit: 'semitones' | 'scaleSteps', key: Key): number {
  return unit === 'semitones' ? 12 : scaleIntervals(key.scale).length;
}

/** Slider position in [0, 1] of shift amount `v` (0 at ½), clamped to ±SHIFT_OCTAVES octaves. */
export function shiftPosition(v: number, octave: number): number {
  const r = SHIFT_OCTAVES * octave;
  return (Math.min(r, Math.max(-r, v)) + r) / (2 * r);
}

/**
 * The integer shift for a raw (continuous) slider value: the nearest octave mark when within
 * SHIFT_SNAP of it, else the nearest step; clamped to ±SHIFT_OCTAVES octaves.
 */
export function snapShift(raw: number, octave: number): number {
  const r = SHIFT_OCTAVES * octave;
  const x = Math.min(r, Math.max(-r, raw));
  const mark = Math.round(x / octave) * octave;
  const v = Math.abs(x - mark) <= SHIFT_SNAP ? mark : Math.round(x);
  return v === 0 ? 0 : v; // no −0
}

/** The shift for slider position `pos` in [0, 1] (inverse of `shiftPosition`, snapped). */
export function shiftAtPosition(pos: number, octave: number): number {
  const r = SHIFT_OCTAVES * octave;
  return snapShift(pos * 2 * r - r, octave);
}

/** A signed integer: "+7", "−3", "0". */
export function formatSigned(v: number): string {
  return v > 0 ? `+${v}` : v < 0 ? `−${-v}` : '0';
}

/** Signed shift text with whole octaves named: "+7 (+1 oct)", "−3", "0". */
export function formatShift(v: number, octave: number): string {
  const s = formatSigned(v);
  if (v === 0 || v % octave !== 0) return s;
  const k = v / octave;
  return `${s} (${k > 0 ? '+' : '−'}${Math.abs(k)} oct)`;
}

/** A number field's text: `dirty` once the user has typed something not yet committed. */
export interface DraftState {
  text: string;
  dirty: boolean;
}

export type DraftAction =
  | { type: 'type'; text: string }
  /** The text is set by the field itself (a step, a commit, Escape): no longer a draft. */
  | { type: 'set'; text: string }
  /** The underlying value changed (undo, another edit): any draft is dropped. */
  | { type: 'external'; shown: string };

/** The draft rule: typing makes a draft; an external value change replaces it, never commits it. */
export function draftReduce(s: DraftState, a: DraftAction): DraftState {
  if (a.type === 'type') return { text: a.text, dirty: true };
  if (a.type === 'set') return { text: a.text, dirty: false };
  return s.text === a.shown && !s.dirty ? s : { text: a.shown, dirty: false };
}

// ---------------------------------------------------------------------------------------------
// Bounded number fields: when a slider is shown (owner 2026-11-21)
// ---------------------------------------------------------------------------------------------

/** Most values an automatic integer slider spans (0–100 % fits; pitches 0–127 do not). */
export const SLIDER_MAX_INTS = 101;
/** Most steps an automatic continuous slider spans. */
export const SLIDER_MAX_STEPS = 1000;
/** Integer sliders with at most this many values show no text box, only the value. */
export const COUNT_MAX_VALUES = 32;
/** Integer sliders with at most this many values show a tick per value. */
export const TICKS_MAX_VALUES = 16;

export interface SliderPlan {
  min: number;
  max: number;
  step: number;
  /** One tick per value (small integer ranges), else empty. */
  ticks: number[];
  /** Keep the text box beside the slider (false: a small count, shown as a value label). */
  box: boolean;
}

/**
 * Whether a number field gets a slider, and how. `slider` is an explicit range (may be narrower
 * than the typed one) or `false` (box only); absent, the typed range decides: a finite range of
 * at most SLIDER_MAX_INTS integers or SLIDER_MAX_STEPS steps gets one. An integer slider over the
 * whole typed range with at most COUNT_MAX_VALUES values drops the text box.
 */
export function sliderPlan(o: {
  min: number;
  max: number;
  step: number;
  integer: boolean;
  slider?: { min: number; max: number; step?: number } | false;
}): SliderPlan | null {
  if (o.slider === false) return null;
  const lo = o.slider ? o.slider.min : o.min;
  const hi = o.slider ? o.slider.max : o.max;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return null;
  const step = o.slider?.step ?? (o.integer ? Math.max(1, Math.round(o.step)) : o.step);
  if (!(step > 0)) return null;
  const values = Math.floor((hi - lo) / step + 1e-9) + 1;
  if (!o.slider) {
    if (o.integer ? values > SLIDER_MAX_INTS : values - 1 > SLIDER_MAX_STEPS) return null;
    if (!o.integer && hi === lo) return null;
  }
  const whole = lo <= o.min && hi >= o.max;
  const count = o.integer && step === 1 && whole && values <= COUNT_MAX_VALUES;
  const ticks: number[] = [];
  if (o.integer && values <= TICKS_MAX_VALUES)
    for (let i = 0; i < values; i++) ticks.push(lo + i * step);
  return { min: lo, max: hi, step, ticks, box: !count };
}

/**
 * The live range of a split's "Notes after" (its `count`, the lines heard after it): from the
 * lines sounding before it (no births) to the pool size, so births ≤ pool − sounding. Widened to
 * hold the stored count.
 */
export function splitCountBounds(
  sounding: number,
  pool: number,
  count: number,
): { min: number; max: number } {
  const max = Math.max(1, pool);
  const min = Math.min(max, Math.max(1, sounding));
  return { min: Math.max(1, Math.min(min, count)), max: Math.max(max, count) };
}

/** The live range of a merge's "Notes after": 1 to the lines sounding before it (no deaths). */
export function mergeCountBounds(sounding: number, count: number): { min: number; max: number } {
  return { min: 1, max: Math.max(1, sounding, count) };
}

/** How many lines sound just before `at` (lines born at `at` are not counted). */
export function soundingBefore(score: CompiledScore, at: Seconds): number {
  return activeAt(score, at - 1e-6).length;
}
