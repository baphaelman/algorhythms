/**
 * Freezing a chord for per-voice editing (PLAN.md §6.2, §11.3; revision 6).
 *
 * `freezeChord` returns the chord with its notes replaced by what each voice it voices currently
 * gets (survivors and newborns, after range folding), as `pitches` low→high with
 * `assign: 'ordered'` and `count` kept. Pitch i then belongs to the i-th lowest of those voices,
 * so the editor can change one voice's note. Replacing the chord with it keeps the sound, with
 * two exceptions: a `free` chord whose lines cross is uncrossed, and a chord whose range folding
 * reorders its targets gets them in ascending order.
 */

import { compileWithTrace } from './compiler/compile';
import type { ChordMoment, CompiledScore, MomentId, Piece, Pitch } from './types';

/**
 * The chord `momentId` of `piece`, frozen (see above); null if it is not a chord or was not
 * applied (no targets, a parse error). `score` is the compiled piece: it gives the target state
 * only indirectly, so the helper re-runs the compiler with a trace up to the chord.
 */
export function freezeChord(
  piece: Piece,
  score: CompiledScore,
  momentId: MomentId,
): ChordMoment | null {
  const index = piece.moments.findIndex((m) => m.id === momentId);
  if (index < 0) return null;
  const m = piece.moments[index];
  if (m.type !== 'chord' || m.muted) return null;
  if (!score.momentSpans.some((s) => s.id === momentId)) return null;
  // Only events before the chord shape its state: drop the moments that come after it.
  const before = piece.moments.filter((x, j) => x.at < m.at || (x.at === m.at && j <= index));
  const { trace } = compileWithTrace({ ...piece, moments: before });
  const tr = trace.moments.find((x) => x.id === momentId);
  if (!tr || !tr.intents) return null;
  const pitches: Pitch[] = [];
  for (const it of tr.intents) if (it.kind !== 'death') pitches.push(it.to);
  if (pitches.length === 0) return null;
  pitches.sort((a, b) => a - b);
  return { ...m, notes: { kind: 'pitches', pitches }, assign: 'ordered' };
}
