/**
 * The poster workspace's own state and pure helpers (PLAN.md §15 M14 "Layout"): the tool, the
 * selection (P3 fills it), the artboard's fit and the layers list.
 */

import { create } from 'zustand';
import type { Piece } from '../core/types';
import { partOf } from '../core/parts';
import type { PosterLayout } from '../render/poster-layout';
import type { PosterSelection, SnapGuides } from './poster-select';

export type WorkspaceTool = 'select' | 'text';

export interface WorkspaceState {
  tool: WorkspaceTool;
  /**
   * What is selected on the artboard (a layer, text box, or a label or line group or one
   * member). Null = nothing; Escape leaves the workspace only then.
   */
  selected: PosterSelection | null;
  /** Parts whose lines are listed in the layers panel. */
  expanded: readonly string[];
  /** The layout the artboard drew last (hit-testing, outlines, the panels). */
  layout: PosterLayout | null;
  /** Snap guides on (the tool row's switch; Alt while dragging turns them off). */
  snap: boolean;
  /** The snap lines a drag hits now. */
  guides: SnapGuides | null;
  /** The text box being edited in place. */
  editing: string | null;
  /** A size, rows or margins change happened: "Re-fit layout" shows if text covers the music. */
  refit: boolean;
  /** Parts whose per-row eyes are listed (rows that disagree). */
  rowsOpen: readonly string[];
  /** The Layers list is up over the artboard (the bottom bar's caret; remembered per viewer). */
  layersOpen: boolean;
}

const LAYERS_KEY = 'algorhythms.posterLayersOpen';

function loadLayersOpen(): boolean {
  try {
    return globalThis.localStorage?.getItem(LAYERS_KEY) === '1';
  } catch {
    return false;
  }
}

/** Opens or closes the Layers list (remembered). */
export function setLayersOpen(open: boolean): void {
  useWorkspace.setState({ layersOpen: open });
  try {
    if (open) globalThis.localStorage?.setItem(LAYERS_KEY, '1');
    else globalThis.localStorage?.removeItem(LAYERS_KEY);
  } catch {
    // Not remembered (private mode, blocked storage): still open for this visit.
  }
}

export const useWorkspace = create<WorkspaceState>()(() => ({
  tool: 'select',
  selected: null,
  expanded: [],
  layout: null,
  snap: true,
  guides: null,
  editing: null,
  refit: false,
  rowsOpen: [],
  layersOpen: loadLayersOpen(),
}));

/** Padding around the poster on the artboard, CSS px. */
export const ARTBOARD_PAD = 24;

/**
 * The poster's box on the artboard (CSS px): the whole poster, as large as fits inside `avail`
 * less `pad` on every side, its aspect kept; at least 1 px each way.
 */
export function artboardFit(
  avail: { w: number; h: number },
  poster: { width: number; height: number },
  pad = ARTBOARD_PAD,
): { w: number; h: number } {
  const aw = Math.max(1, avail.w - 2 * pad);
  const ah = Math.max(1, avail.h - 2 * pad);
  const aspect = poster.width / poster.height;
  const w = Math.max(1, Math.floor(Math.min(aw, ah * aspect)));
  return { w, h: Math.max(1, Math.round(w / aspect)) };
}

export interface LayerLine {
  id: string;
  label: string;
}

export interface Layer {
  /** The part's name ('' = lines with no part). */
  part: string;
  label: string;
  lines: LayerLine[];
}

/**
 * The music layers: one per part in pool order (lines with no part form one "Lines" layer),
 * each with its lines.
 */
export function posterLayers(piece: Pick<Piece, 'voices'>): Layer[] {
  const out: Layer[] = [];
  piece.voices.forEach((v, i) => {
    const part = partOf(v);
    let layer = out.find((l) => l.part === part);
    if (!layer) {
      layer = { part, label: part === '' ? 'Lines' : part, lines: [] };
      out.push(layer);
    }
    layer.lines.push({ id: v.id, label: v.name || `Line ${i + 1}` });
  });
  return out;
}

/** A row's name in the layers list: its label and section ("A · Verse"), else "Row 2". */
export function rowName(layout: PosterLayout, row: number): string {
  const r = layout.rows[row];
  const item =
    r?.section !== undefined ? layout.sectionRows?.find((i) => i.id === r.section) : null;
  const parts = [r?.name?.trim(), item?.section.trim()].filter((x): x is string => !!x);
  const uniq = parts.filter((x, i) => parts.indexOf(x) === i);
  return uniq.length > 0 ? uniq.join(' · ') : `Row ${row + 1}`;
}

/**
 * Where layer `id` (as `PosterDoc.layers`) shows, by row: 'shown', 'hidden' (everywhere, or
 * in every row) or 'mixed' (hidden in some rows), and each row's own state.
 */
export function layerRowsState(
  layout: PosterLayout,
  layer: { hidden?: boolean; hiddenRows?: readonly string[] } | undefined,
): { state: 'shown' | 'hidden' | 'mixed'; rows: boolean[] } {
  const keys = layout.rows.map((r) => r.key);
  if (layer?.hidden) return { state: 'hidden', rows: keys.map(() => false) };
  const off = new Set(layer?.hiddenRows ?? []);
  const rows = keys.map((k) => !off.has(k));
  const n = rows.filter((x) => !x).length;
  return { state: n === 0 ? 'shown' : n === rows.length ? 'hidden' : 'mixed', rows };
}

/** "1 line", "4 lines". */
export const linesText = (n: number): string => (n === 1 ? '1 line' : `${n} lines`);
