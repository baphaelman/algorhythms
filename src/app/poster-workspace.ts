/**
 * The poster workspace's own state and pure helpers (PLAN.md §15 M14 "Layout"): the tool, the
 * selection (P3 fills it), the artboard's fit and the layers list.
 */

import { create } from 'zustand';
import type { Piece } from '../core/types';
import { partOf } from '../core/parts';

export type WorkspaceTool = 'select' | 'text';

export interface WorkspaceState {
  tool: WorkspaceTool;
  /**
   * P3: what is selected on the artboard (a layer, text box, or a label or line group or one
   * member). Null = nothing; Escape leaves the workspace only then.
   */
  selected: unknown;
  /** Parts whose lines are listed in the layers panel. */
  expanded: readonly string[];
}

export const useWorkspace = create<WorkspaceState>()(() => ({
  tool: 'select',
  selected: null,
  expanded: [],
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

/** "1 line", "4 lines". */
export const linesText = (n: number): string => (n === 1 ? '1 line' : `${n} lines`);
