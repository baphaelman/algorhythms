/**
 * Space always plays and pauses (PLAN.md §11.5, owner 2026-11-21): one decision for every Space
 * keydown and keyup, whatever has focus. Focused controls never act on Space (the caller cancels
 * the event in the capture phase); only a text field types it. In the editor layout Space-drag
 * pans (rev 7), so play/pause waits for the release and is skipped if the press panned. A modal
 * dialog keeps the browser's Space, unless it registers its own play/pause (`setDialogSpace`: the
 * Export dialog's video preview, §12), which then takes Space the same way.
 */

import { takesText } from './editor/shortcuts';

/** Space held (editor layout): a drag pans, and the release plays/pauses only if none did. */
export interface SpaceHeld {
  down: boolean;
  panned: boolean;
}

export interface SpaceEvent {
  type: string;
  target: unknown;
  repeat: boolean;
}

export interface SpaceContext {
  /** The wide (editor) layout is shown. */
  editor: boolean;
  /** A modal dialog is open: it keeps the browser's own Space unless `dialogPlay`. */
  dialog: boolean;
  /** The open dialog plays and pauses on Space itself (`dialogSpace()`); a text field still types. */
  dialogPlay?: boolean;
  /** Space-drag pans here too (the poster workspace's artboard), as in the editor layout. */
  pan?: boolean;
}

export interface SpaceOutcome {
  /** Cancel the event (preventDefault and stop it reaching any other handler). */
  consume: boolean;
  toggle: boolean;
}

const PASS: SpaceOutcome = { consume: false, toggle: false };

/** True if `target` types a space itself: text-like inputs, textarea, contenteditable. */
export function typesSpace(target: unknown): boolean {
  if (!takesText(target)) return false;
  const tag = (target as { tagName?: unknown }).tagName;
  return !(typeof tag === 'string' && tag.toLowerCase() === 'select');
}

/** True for a Space key event. */
export function isSpace(e: { key: string; code?: string }): boolean {
  return e.code === 'Space' || e.key === ' ';
}

/** The one Space hold (canvas-input keeps it; the poster artboard pans while it is down). */
export const spaceHold: SpaceHeld = { down: false, panned: false };

let dialogToggle: (() => void) | null = null;

/**
 * Registers the open dialog's own play/pause for Space; returns the unregister function. Only
 * one at a time (dialogs are modal).
 */
export function setDialogSpace(toggle: () => void): () => void {
  dialogToggle = toggle;
  return () => {
    if (dialogToggle === toggle) dialogToggle = null;
  };
}

/** The open dialog's play/pause for Space, if one is registered. */
export function dialogSpace(): (() => void) | null {
  return dialogToggle;
}

/** Decides one Space keydown or keyup; updates `held`. `toggle` means the dialog's when `dialogPlay`. */
export function spaceKey(e: SpaceEvent, held: SpaceHeld, ctx: SpaceContext): SpaceOutcome {
  const pass = ctx.dialog && !ctx.dialogPlay;
  if (e.type === 'keyup') {
    if (held.down) {
      held.down = false;
      return { consume: true, toggle: !held.panned && (!ctx.dialog || ctx.pan === true) };
    }
    return pass || typesSpace(e.target) ? PASS : { consume: true, toggle: false };
  }
  if (pass || typesSpace(e.target)) return PASS;
  if (e.repeat || held.down) return { consume: true, toggle: false };
  // A dialog has no Space-drag pan: it toggles on the press.
  if (!ctx.pan && (!ctx.editor || ctx.dialog)) return { consume: true, toggle: true };
  held.down = true;
  held.panned = false;
  return { consume: true, toggle: false };
}
