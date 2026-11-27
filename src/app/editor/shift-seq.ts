/**
 * Shift sequence editing (M13): the Moved block's typed sequence, "−2 −1 −1 +1 +1:2". Each item is
 * an amount in the moment's unit with an optional length after a colon, in beats (with a tempo)
 * or seconds; a missing length is the moment's spacing (`progressionSpacing`, as typed chords).
 * Pure: parse, format, the patch, and the summary the inspector shows.
 */

import { shiftAmountText } from '../../core/moments/shift';
import type { Seconds, ShiftMoment, ShiftStep } from '../../core/types';
import { formatNum, parseNum } from '../ui/inspector/fields';
import { MAX_BEATS, MAX_SECONDS } from './progression';
import { MIN_TUNE_LEN, formatTuneLen, lenFromShown } from './tune';

/** Most steps a typed sequence may have. */
export const MAX_SHIFT_STEPS = 256;

export type ShiftSeqParse = { ok: true; seq: ShiftStep[] } | { ok: false; error: string };

/** Vulgar fractions a length may use ("½", "1½"). */
const FRACTIONS: Record<string, number> = {
  '½': 1 / 2,
  '⅓': 1 / 3,
  '⅔': 2 / 3,
  '¼': 1 / 4,
  '¾': 3 / 4,
  '⅛': 1 / 8,
};

/** A typed length: "2", "0.5", "1/2", "½", "1½"; null if it is none. */
function parseLen(text: string): number | null {
  const t = text.trim();
  const frac = /^(\d*)([½⅓⅔¼¾⅛])$/.exec(t);
  if (frac) return (frac[1] ? Number(frac[1]) : 0) + FRACTIONS[frac[2]];
  const ratio = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/.exec(t);
  if (ratio) {
    const v = Number(ratio[1]) / Number(ratio[2]);
    return Number.isFinite(v) ? v : null;
  }
  return parseNum(t);
}

/** A typed amount: "+2", "-1", "−1", "3", "0.5"; null if it is none. */
function parseAmount(text: string): number | null {
  const t = text.trim().replace(/^−/, '-');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/**
 * Parses a typed sequence: items split by spaces or commas, each "<amount>" or
 * "<amount>:<length>". Amounts are whole scale steps, or semitones (decimals allowed); lengths
 * are beats (with a tempo, `beat` s each) or seconds, at least `MIN_TUNE_LEN` s. A missing length
 * is `spacing` s. With `prev`, a length typed as shown keeps its exact value, so committing the
 * shown text changes nothing. Empty text is no sequence. Errors name the step.
 */
export function parseShiftSeq(
  text: string,
  unit: ShiftMoment['unit'],
  beat: Seconds | null,
  spacing: Seconds,
  prev: readonly ShiftStep[] = [],
): ShiftSeqParse {
  const t = text.trim();
  if (t === '') return { ok: true, seq: [] };
  const items = t.split(/[\s,]+/).filter(Boolean);
  if (items.length > MAX_SHIFT_STEPS)
    return { ok: false, error: `At most ${MAX_SHIFT_STEPS} steps` };
  const unitName = beat ? 'beats' : 's';
  const min = beat ? MIN_TUNE_LEN / beat : MIN_TUNE_LEN;
  const max = beat ? MAX_BEATS : MAX_SECONDS;
  const seq: ShiftStep[] = [];
  for (let k = 0; k < items.length; k++) {
    const at = `Step ${k + 1}`;
    const [a, l, more] = items[k].split(':');
    if (more !== undefined)
      return {
        ok: false,
        error: `${at}: “${items[k]}” should be an amount and a length, like “−1:2”`,
      };
    const by = parseAmount(a);
    if (by === null) return { ok: false, error: `${at}: “${a}” is not an amount like −1 or +2` };
    if (unit === 'scaleSteps' && !Number.isInteger(by))
      return { ok: false, error: `${at}: scale steps are whole numbers` };
    let len: Seconds;
    if (l === undefined) len = spacing;
    else {
      const v = parseLen(l);
      if (v === null) return { ok: false, error: `${at}: “${l}” is not a length` };
      if (v < min - 1e-9)
        return {
          ok: false,
          error: `${at}: the length must be at least ${formatNum(min, 3)} ${unitName}`,
        };
      if (v > max)
        return { ok: false, error: `${at}: the length must be at most ${max} ${unitName}` };
      const old = prev[k];
      len =
        old && formatTuneLen(old.len, beat) === formatNum(v, 3) ? old.len : lenFromShown(v, beat);
    }
    seq.push({ by, len });
  }
  return { ok: true, seq };
}

/**
 * A sequence as typed: "−2 −1 −1 +1:2", each length shown only where it is not `spacing` (beats
 * with a tempo, else seconds).
 */
export function formatShiftSeq(
  seq: readonly ShiftStep[],
  beat: Seconds | null,
  spacing: Seconds,
): string {
  const plain = formatTuneLen(spacing, beat);
  return seq
    .map((s) => {
      const len = formatTuneLen(s.len, beat);
      return len === plain ? shiftAmountText(s.by) : `${shiftAmountText(s.by)}:${len}`;
    })
    .join(' ');
}

/**
 * The patch a typed sequence makes: the steps, with `by` kept as the first step's (so a build
 * without sequences plays the first step); an empty one drops `seq` (one shift by `by`).
 */
export function shiftSeqPatch(seq: readonly ShiftStep[]): Partial<ShiftMoment> {
  return seq.length === 0 ? { seq: undefined } : { seq: seq.slice(), by: seq[0].by };
}

/**
 * "7 steps, net −1 step, ends at 0:24.0": the step count, the sum of the amounts and where the
 * sequence ends (`when` formats the time).
 */
export function shiftSeqSummary(
  seq: readonly ShiftStep[],
  unit: ShiftMoment['unit'],
  at: Seconds,
  when: (t: Seconds) => string,
): string {
  let net = 0;
  let end = at;
  for (const s of seq) {
    net += s.by;
    end += s.len;
  }
  net = Math.round(net * 1e9) / 1e9;
  const one = Math.abs(net) === 1;
  const u = unit === 'scaleSteps' ? (one ? 'step' : 'steps') : one ? 'semitone' : 'semitones';
  const n = seq.length === 1 ? '1 step' : `${seq.length} steps`;
  return `${n}, net ${net === 0 ? '0' : shiftAmountText(net)} ${u}, ends at ${when(end)}`;
}
