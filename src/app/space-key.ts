/**
 * Space always plays and pauses (PLAN.md §11.5, owner 2026-11-21): one decision for every Space
 * keydown and keyup, whatever has focus. Focused controls never act on Space (the caller cancels
 * the event in the capture phase); only a text field types it. In the editor layout Space-drag
 * pans (rev 7), so play/pause waits for the release and is skipped if the press panned.
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
  /** A modal dialog is open: it keeps the browser's own Space. */
  dialog: boolean;
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

/** Decides one Space keydown or keyup; updates `held`. */
export function spaceKey(e: SpaceEvent, held: SpaceHeld, ctx: SpaceContext): SpaceOutcome {
  if (e.type === 'keyup') {
    if (held.down) {
      held.down = false;
      return { consume: true, toggle: !held.panned && !ctx.dialog };
    }
    return ctx.dialog || typesSpace(e.target) ? PASS : { consume: true, toggle: false };
  }
  if (ctx.dialog || typesSpace(e.target)) return PASS;
  if (e.repeat || held.down) return { consume: true, toggle: false };
  if (!ctx.editor) return { consume: true, toggle: true };
  held.down = true;
  held.panned = false;
  return { consume: true, toggle: false };
}
