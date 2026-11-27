/**
 * What an Add or Next card lands on, named on the card (PLAN.md M13 "Hover to hear"): the chord a
 * moment that moves pitches lands on ("→ Dm7", named as the Chords row names chords), else what
 * changes in a few words ("→ 50%", "→ G major", "→ Arpeggio"), or nothing when that would
 * only repeat the card's title.
 */

import { compile } from '../../core/compiler/compile';
import { nameChord } from '../../core/harmony';
import { keyAt } from '../../core/query';
import { evalSegment } from '../../core/segment';
import type {
  CompiledScore,
  CompiledVoice,
  Moment,
  MomentId,
  Piece,
  Pitch,
  Seconds,
  Segment,
} from '../../core/types';
import { keyName } from '../../render/draw';
import { chordPart, textureOf, TEXTURE_NAMES } from './rows';

/** Moment types named without compiling. */
const NAMED: ReadonlySet<Moment['type']> = new Set([
  'level',
  'key',
  'timbre',
  'pulse',
  'walk',
  'tune',
  'progression',
]);

/** Pitch of `v` at `t`, from the segment covering it (else the last one before it). */
export function pitchIn(v: CompiledVoice, t: Seconds): Pitch | null {
  let last: Segment | null = null;
  for (const s of v.segments) {
    if (s.t0 > t + 1e-9) break;
    last = s;
  }
  if (!last) return null;
  return t <= last.t1 ? evalSegment(last, t) : last.curve ? last.curve.p1 : last.p1;
}

/**
 * A card's result in a few words ("→ Dm7", "→ 50%", "→ G major"), or '' when it would only
 * repeat `title` or there is nothing to name. `score`: the piece with `moment` in (id `id`),
 * needed only for moments that move pitches (else it may be omitted).
 */
export function resultLabel(
  moment: Moment,
  title: string,
  score?: CompiledScore,
  id: MomentId = moment.id,
): string {
  let name = '';
  switch (moment.type) {
    case 'level':
      name = moment.gain <= 0 ? 'silence' : `${Math.round(moment.gain * 100)}%`;
      break;
    case 'key':
      name = keyName(moment.key);
      break;
    case 'timbre':
      name = typeof moment.preset === 'string' ? moment.preset : '';
      break;
    case 'pulse':
    case 'walk': {
      const kind = textureOf(moment);
      name = kind ? TEXTURE_NAMES[kind] : '';
      break;
    }
    case 'tune':
    case 'progression':
      break;
    default:
      name = score ? landingChord(score, id, moment.at) : '';
  }
  if (!name) return '';
  const t = title.toLowerCase();
  const n = name.toLowerCase();
  if (t.includes(n)) return '';
  return `→ ${name}`;
}

/**
 * The chord moment `id` lands on in `score`: its harmony entry's chord, else the pitches sounding
 * at its span's end named (core/harmony `nameChord`), as the Chords row names chords.
 */
export function landingChord(score: CompiledScore, id: MomentId, at: Seconds): string {
  const h = score.harmony?.find((x) => x.momentId === id && !x.from);
  if (h) return chordPart(h.label);
  const span = score.momentSpans.find((s) => s.id === id);
  const t = span ? Math.max(span.end, at) : at;
  const ps: Pitch[] = [];
  for (const v of score.voices) {
    if (!v.lives.some((l) => l.born <= t + 1e-6 && (l.died === undefined || l.died > t + 1e-6)))
      continue;
    const p = pitchIn(v, t);
    if (p !== null) ps.push(p);
  }
  if (ps.length === 0) return '';
  ps.sort((a, b) => a - b);
  return nameChord(
    ps.map((p) => Math.round(p)),
    Math.round(ps[0]),
    keyAt(score, t),
  );
}

/**
 * `moment`'s result label on a card titled `title`, compiling `build(piece, moment)` only when it
 * moves pitches (`probe`: the id it gets there). '' if it does not compile.
 */
export function cardResult(
  piece: Piece,
  moment: Moment,
  title: string,
  build: (piece: Piece, m: Moment) => Piece,
  probe: MomentId,
): string {
  const m = { ...moment, id: probe };
  if (NAMED.has(m.type)) return resultLabel(m, title);
  try {
    return resultLabel(m, title, compile(build(piece, m)));
  } catch {
    return '';
  }
}
