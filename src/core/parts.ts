/**
 * Parts (PLAN.md §5, §11.3 revision 9): a voice may belong to a named part. Distinct notes holds
 * within a part only: lines in different parts may rest on one pitch and never merge. Voices with
 * no part form the default group '' (a piece without parts behaves as before revision 9).
 */

import type { VoiceSelector } from './types';

/** The part of a voice definition: its name, or '' (the default group). */
export function partOf(def: { part?: unknown } | null | undefined): string {
  const p = def?.part;
  return typeof p === 'string' ? p : '';
}

/** The part a `{ part }` selector names, or null for any other selector. */
export function selectorPart(sel: VoiceSelector | undefined): string | null {
  if (sel && typeof sel === 'object' && 'part' in sel && typeof sel.part === 'string')
    return sel.part;
  return null;
}
