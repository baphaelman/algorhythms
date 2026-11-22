/**
 * Interval names and readouts (PLAN.md §12 "Export look": the HUD's spread and gaps). Pure.
 */

/** Names of the simple intervals, 0..11 semitones. */
const SIMPLE = [
  'unison',
  'minor 2nd',
  'major 2nd',
  'minor 3rd',
  'major 3rd',
  '4th',
  'tritone',
  '5th',
  'minor 6th',
  'major 6th',
  'minor 7th',
  'major 7th',
];

/** An interval is named when it is within this many semitones (10 cents) of a whole one. */
export const NAME_TOLERANCE = 0.1;

/**
 * Name of an interval of `st` semitones, e.g. 7 → "5th", 12 → "octave", 19 → "octave + 5th",
 * 24 → "2 octaves"; null when it is more than 10 cents from a whole semitone. Sign is ignored.
 */
export function intervalName(st: number): string | null {
  if (!Number.isFinite(st)) return null;
  const a = Math.abs(st);
  const n = Math.round(a);
  if (Math.abs(a - n) > NAME_TOLERANCE + 1e-9) return null;
  const oct = Math.floor(n / 12);
  const rest = n - oct * 12;
  if (oct === 0) return SIMPLE[rest];
  const o = oct === 1 ? 'octave' : `${oct} octaves`;
  return rest === 0 ? o : `${o} + ${SIMPLE[rest]}`;
}

/** Semitones as a readout: whole ("19"), else one decimal ("18.6") while a line glides. */
export function semitoneText(st: number): string {
  const n = Math.round(st);
  if (Math.abs(st - n) < 0.005) return String(n);
  return (Math.round(st * 10) / 10).toFixed(1);
}

/** The spread readout: "19 st · octave + 5th"; "18.6 st" mid-glide (no name). */
export function spreadText(st: number): string {
  const name = intervalName(st);
  const s = `${semitoneText(st)} st`;
  return name ? `${s} · ${name}` : s;
}
