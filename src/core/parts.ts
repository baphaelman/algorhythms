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

/**
 * The part filter a selector applies (revision 10): `{ part }` and `{ parts }` keep voices of the
 * named parts; `{ exceptParts }` keeps every voice outside them (voices with no part included).
 * Null for a selector that does not filter by part.
 */
export interface PartScope {
  names: readonly string[];
  except: boolean;
}

const strings = (a: unknown): a is string[] =>
  Array.isArray(a) && a.every((s) => typeof s === 'string');

export function partScope(sel: VoiceSelector | undefined): PartScope | null {
  if (!sel || typeof sel !== 'object') return null;
  if ('part' in sel && typeof sel.part === 'string') return { names: [sel.part], except: false };
  if ('parts' in sel && strings(sel.parts)) return { names: sel.parts, except: false };
  if ('exceptParts' in sel && strings(sel.exceptParts))
    return { names: sel.exceptParts, except: true };
  return null;
}

/** True when a voice of `part` passes `scope` (a null scope passes everything). */
export function inPartScope(scope: PartScope | null, part: string): boolean {
  return scope === null || scope.names.includes(part) !== scope.except;
}

/** The selector with part `from` renamed to `to` (the same object when it doesn't name `from`). */
export function renamePartIn(
  sel: VoiceSelector | undefined,
  from: string,
  to: string,
): VoiceSelector | undefined {
  const sc = partScope(sel);
  if (!sc || !sc.names.includes(from)) return sel;
  if (typeof sel === 'object' && 'part' in sel) return { part: to };
  const names = [...new Set(sc.names.map((n) => (n === from ? to : n)))];
  return sc.except ? { exceptParts: names } : { parts: names };
}

/** A message's name for a scope: "the part 'A'", "the parts 'A' and 'B'", "the parts outside 'A'". */
export function scopeName(scope: PartScope): string {
  const q = (n: string): string => (n === '' ? 'unassigned' : `'${n}'`);
  const list = scope.names.map(q);
  const joined =
    list.length <= 1
      ? (list[0] ?? '')
      : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  if (scope.except) return `the parts outside ${joined}`;
  if (list.length === 1)
    return scope.names[0] === '' ? 'the unassigned part' : `the part ${joined}`;
  return `the parts ${joined}`;
}
