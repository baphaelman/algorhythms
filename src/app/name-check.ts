/** The decision behind "name it before moving on" (PLAN.md §11.4); see naming.ts. */

import { DEFAULT_TITLE } from '../core/defaults';
import { isGeneratedTitle } from '../core/generate';

/** The inputs of the decision. */
export interface NameCheck {
  title: string;
  /** An edit was committed since the piece was opened. */
  edited: boolean;
  /** The user already skipped the question for this piece. */
  skipped: boolean;
}

/** True for the default title, an empty one, or an automatic Generate / Compose title. */
export function isUnnamed(title: string): boolean {
  const t = title.trim();
  return t === '' || t === DEFAULT_TITLE || isGeneratedTitle(t);
}

/** True if the open piece is edited, still unnamed and not yet skipped: ask before moving on. */
export function shouldAskName({ title, edited, skipped }: NameCheck): boolean {
  return edited && !skipped && isUnnamed(title);
}

/** A name from the field: trimmed, and null when empty or still the default (nothing to save). */
export function cleanName(text: string): string | null {
  const t = text.trim();
  return isUnnamed(t) ? null : t;
}
