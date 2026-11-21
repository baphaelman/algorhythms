/**
 * "Name it before moving on" (PLAN.md §11.4, owner 2026-11-21). Opening another piece never
 * warns, since the open one is autosaved. But an edited piece that still has the default title
 * first gets a small popup (ui/NamePrompt) offering a name; Skip is remembered for that piece
 * (its My pieces entry) for the session, so it asks at most once per piece.
 *
 * Every way of replacing the piece calls `runOpen` (store.ts); importing this module installs
 * the gate it runs through.
 */

import { create } from 'zustand';
import { edit, hasEdited } from './editor/history';
import { cleanName, shouldAskName } from './name-check';
import { usePersist } from './persist';
import { setOpenGate, usePlayer } from './store';

interface NamingUi {
  open: boolean;
  /** What to do once answered. */
  pending: (() => void) | null;
}

export const useNaming = create<NamingUi>()(() => ({ open: false, pending: null }));

const skipped = new Set<string>();
/** The piece's identity for Skip: its My pieces entry. */
const pieceKey = (): string => usePersist.getState().current ?? '';

/** Runs `run` now, or after the popup if the open piece should be named first. */
function gate(run: () => void): void {
  const ask = shouldAskName({
    title: usePlayer.getState().piece.meta.title,
    edited: hasEdited(),
    skipped: skipped.has(pieceKey()),
  });
  if (!ask) {
    run();
    return;
  }
  useNaming.setState({ open: true, pending: run });
}

/** Closes the popup and moves on to the requested piece. */
function proceed(): void {
  const { pending } = useNaming.getState();
  useNaming.setState({ open: false, pending: null });
  pending?.();
}

/** Save name: the title is changed as an ordinary edit (history, autosave), then the piece opens. */
export function saveName(text: string): void {
  const name = cleanName(text);
  if (name === null) {
    skipName();
    return;
  }
  edit((p) => ({ ...p, meta: { ...p.meta, title: name } }), 'Name the piece');
  proceed();
}

/** Skip (or Escape): the piece stays as it is and is not asked about again this session. */
export function skipName(): void {
  skipped.add(pieceKey());
  proceed();
}

setOpenGate(gate);
