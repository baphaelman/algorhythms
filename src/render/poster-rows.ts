/**
 * Rows by sections (PLAN.md §15 M14, the owner's notes): each labelled moment shown on the poster
 * starts a row, unless its "New row" switch is off (`PosterDoc.rowSections[id].join`). The part
 * before the first section, if any, is a row of its own (`start`). Every row label defaults to
 * its section's label. P1's caps hold: at most POSTER_MAX_ROWS rows, none under MIN_SECTION
 * (the shortest row joins its neighbour until both hold). Pure.
 */

import type { PosterRowSection, Seconds } from '../core/types';
import { POSTER_MAX_ROWS } from './poster';
import { MIN_SECTION } from './section';

/** The id of the part before the first section. */
export const START_ROW = 'start';

/** A labelled moment on the poster. */
export interface RowSection {
  id: string;
  t: Seconds;
  label: string;
}

/** One entry of the Organize list. */
export interface SectionRowItem {
  /** The labelled moment's id, or `start`. */
  id: string;
  t: Seconds;
  /** The section's own label ('' for `start`). */
  section: string;
  /** Its row label: the stored one, else the section's. */
  label: string;
  /** "New row" as set (`start`, and a section at the poster's start, always). */
  newRow: boolean;
  /** Whether its switch can change (false for `start` and a section at the start). */
  canJoin: boolean;
  /** It starts a row on the poster (after the caps). */
  starts: boolean;
}

/** A row by sections: its time and the item that starts it. */
export interface SectionRow {
  start: Seconds;
  end: Seconds;
  id: string;
  label: string;
}

const EPS = 1e-6;

/**
 * The Organize list and the rows for [A, B]: `sections` are the labelled moments (any order),
 * `stored` the doc's per-section settings.
 */
export function sectionRows(
  sections: readonly RowSection[],
  stored: Readonly<Record<string, PosterRowSection>> | undefined,
  A: Seconds,
  B: Seconds,
): { items: SectionRowItem[]; rows: SectionRow[] } {
  const secs = sections.filter((s) => s.t >= A - EPS && s.t < B - EPS).sort((x, y) => x.t - y.t);
  const items: SectionRowItem[] = [];
  if (secs.length === 0 || secs[0].t > A + EPS) {
    items.push({
      id: START_ROW,
      t: A,
      section: '',
      label: stored?.[START_ROW]?.label ?? '',
      newRow: true,
      canJoin: false,
      starts: false,
    });
  }
  for (const s of secs) {
    const atStart = items.length === 0;
    const own = stored?.[s.id];
    items.push({
      id: s.id,
      t: Math.max(A, s.t),
      section: s.label,
      label: own?.label ?? s.label,
      newRow: atStart || own?.join !== true,
      canJoin: !atStart,
      starts: false,
    });
  }
  // Row starts, then the caps: the shortest row joins its neighbour while one is too short or
  // there are too many.
  let starts = items.filter((it) => it.newRow);
  const len = (k: number): number => (starts[k + 1]?.t ?? B) - starts[k].t;
  const min = Math.min(MIN_SECTION, B - A);
  while (starts.length > 1) {
    let k = 0;
    for (let i = 1; i < starts.length; i++) if (len(i) < len(k) - EPS) k = i;
    if (len(k) >= min - EPS && starts.length <= POSTER_MAX_ROWS) break;
    // The first row takes the second; any other joins the row before it.
    starts = starts.filter((_, i) => i !== (k === 0 ? 1 : k));
  }
  for (const s of starts) s.starts = true;
  const rows: SectionRow[] = starts.map((s, i) => ({
    start: s.t,
    end: starts[i + 1]?.t ?? B,
    id: s.id,
    label: s.label,
  }));
  return { items, rows };
}
