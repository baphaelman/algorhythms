/**
 * Key changes carry forward to fixed notes (PLAN.md §6.2 `key`, owner 2026-11-21): after a key
 * moment is added or its tonic or scale is edited, and its span holds fixed notes, the inspector
 * asks inline whether to move them to the new key. Move joins the key edit's undo entry; Keep
 * dismisses. The prompt goes away when the selection changes or the key edit is undone; editing
 * the key again asks again, from the key the notes are still in.
 */

import { create } from 'zustand';
import { compile } from '../../core/compiler/compile';
import { sameKey } from '../../core/effect';
import { freezeChord } from '../../core/freeze-chord';
import { carryKey, fixedNoteMoments } from '../../core/transpose';
import type { CompiledScore, Key, MomentId, Seconds } from '../../core/types';
import { pushNotice, usePlayer } from '../store';
import { amend, lastEntry, useEditor } from './history';
import { keyMomentOf, withPieceKeyMoment, withoutPieceKeyMoment } from './piece-key';

export interface KeyCarryPrompt {
  keyId: MomentId;
  /** The key the fixed notes were written in. */
  from: Key;
  /** The key moment's key when asked. */
  to: Key;
  /** Moments in the span with fixed notes. */
  ids: MomentId[];
  /** End of the span (the next key moment); null = the end of the piece. */
  until: Seconds | null;
  /** The key edit's undo entry, which Move joins. */
  entry: object | null;
}

export const useKeyCarry = create<{ prompt: KeyCarryPrompt | null }>()(() => ({ prompt: null }));

/**
 * A prompt closed by a piece change (the key edited again, or undone) without an answer: the
 * notes are still in its `from`, so the next prompt for that moment starts from there.
 */
let unanswered: { keyId: MomentId; from: Key } | null = null;

/** Closes the prompt as answered (or abandoned: the selection moved on). */
const clear = (): void => {
  unanswered = null;
  if (useKeyCarry.getState().prompt) useKeyCarry.setState({ prompt: null });
};

/**
 * Call right after key moment `keyId` was added or its key edited; `from` is the key in effect
 * before (the previous key, or the moment's old key). Asks when the span holds fixed notes. An
 * open, unanswered prompt for the same moment keeps its `from`: the notes are still in that key.
 */
export function offerKeyCarry(keyId: MomentId, from: Key): void {
  // The piece key at 0:00 is a key moment here (editor/piece-key.ts).
  const piece = withPieceKeyMoment(usePlayer.getState().piece);
  const m = keyMomentOf(piece, keyId);
  if (!m) return clear();
  const open = useKeyCarry.getState().prompt ?? unanswered;
  const old = open?.keyId === keyId ? open.from : from;
  const { ids, until } = fixedNoteMoments(piece, keyId);
  if (sameKey(old, m.key) || ids.length === 0) return clear();
  useKeyCarry.setState({
    prompt: { keyId, from: old, to: m.key, ids, until, entry: lastEntry() },
  });
}

/** Move: remaps the span's fixed notes, joined to the key edit's undo entry. */
export function moveKeyCarry(): boolean {
  const p = useKeyCarry.getState().prompt;
  if (!p) return false;
  clear();
  let folds = 0;
  let skipped = 0;
  const changed = amend(
    p.entry,
    (stored) => {
      const piece = withPieceKeyMoment(stored);
      let score: CompiledScore | null = null;
      const voiced = (m: { id: MomentId; type: string }) => {
        if (m.type !== 'chord') return null;
        score ??= compile(piece);
        const f = freezeChord(piece, score, m.id);
        return f && f.notes.kind === 'pitches' ? f.notes.pitches : null;
      };
      const r = carryKey(piece, p.keyId, p.from, { voiced });
      folds = r.folds.length;
      skipped = r.skipped.length;
      return r.piece === piece ? stored : withoutPieceKeyMoment(r.piece);
    },
    'Move fixed notes',
  );
  const lines: string[] = [];
  if (folds > 0) {
    lines.push(
      `${folds} ${folds === 1 ? 'note was' : 'notes were'} folded by an octave into ${folds === 1 ? 'its range' : 'their ranges'}.`,
    );
  }
  if (skipped > 0) {
    lines.push(
      `${skipped} named ${skipped === 1 ? 'chord is' : 'chords are'} not sounding, so ${skipped === 1 ? 'it was' : 'they were'} left as written.`,
    );
  }
  if (lines.length > 0) pushNotice('info', 'Moved the fixed notes', lines);
  return changed;
}

/** Keep: leaves the fixed notes as they are. */
export function keepKeyCarry(): void {
  clear();
}

// The prompt belongs to the selected key moment and its edit.
useEditor.subscribe((s, prev) => {
  const p = useKeyCarry.getState().prompt;
  if (!p || s.selection === prev.selection) return;
  if (s.selection.length !== 1 || s.selection[0] !== p.keyId) clear();
});

usePlayer.subscribe((s, prev) => {
  const p = useKeyCarry.getState().prompt;
  if (!p || s.piece === prev.piece) return;
  const m = keyMomentOf(s.piece, p.keyId);
  if (m && sameKey(m.key, p.to)) return;
  useKeyCarry.setState({ prompt: null });
  unanswered = m ? { keyId: p.keyId, from: p.from } : null;
});
