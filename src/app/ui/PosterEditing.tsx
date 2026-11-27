/**
 * Editing on the poster's artboard (PLAN.md §15 M14): selection and handles over the canvas,
 * the selected object's panel, the tools, the layers list, margins, the label/line switches and
 * the re-fit hint. Every change is a poster edit on the piece's undo stack (../poster-sync); a
 * drag is one entry.
 *
 * - Click selects the topmost object; a label or line selects its whole group, Alt-click one
 *   member. With two rows or more, a part's lines select that part in their row (Alt-click: in
 *   every row, as the layers list does), and a row's empty space selects the row. Drag moves (snapping to the artboard, the margins and other objects; Alt: free),
 *   the eight handles resize (`resizeBox`: Shift proportional, Alt from the centre).
 * - A click on the paper where nothing is selects the background (its gradient's handles show
 *   only then). Snapping works on the outlines drawn (`drawnFrame`, `snapTargets`).
 * - The QR code (M17): added from the tool row when the watch link fits one, then moved,
 *   resized (always square) and deleted like a text box.
 * - Keys (nothing typed into): arrows nudge (Shift: ten times), Delete removes a text box or
 *   the QR code, or hides the rest (a part in one row: in that row only), Enter edits a text box, V / T pick the
 *   tool. Escape clears the selection.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import type {
  PosterDoc,
  PosterGroup,
  PosterGroupStyle,
  PosterLabelGroup,
  PosterLabelSide,
  PosterText,
} from '../../core/types';
import { toHex } from '../../render/colours';
import {
  HANDLES,
  layerOf,
  newTextId,
  overlapsMusic,
  posterTimeAt,
  putText,
  refitPoster,
  removeQr,
  removeText,
  resizeBox,
  setGroupStyle,
  setLayer,
  setLayerOrder,
  setLayerRow,
  setLayerRowHidden,
  setMargins,
  setMemberStyle,
  setQr,
  setRowBox,
  textBoxFor,
  textsOf,
  type Handle,
} from '../../render/poster-edit';
import {
  QR_DEFAULT_CARD,
  QR_DEFAULT_COLOUR,
  QR_MAX_CHARS,
  QR_MIN_MODULE_PX,
  qrContrast,
  qrModulePx,
  qrReadable,
} from '../../render/poster-qr';
import {
  DEFAULT_MARGIN,
  LABEL_GROUPS,
  GROUP_FIELDS,
  LINE_GROUPS,
  MARK_GROUPS,
  LINE_HEIGHT,
  estimateText,
  fillTokens,
  isLabelGroup,
  isMarkGroup,
  measureWith,
  textDefaults,
  textFont,
  type GroupField,
  type Measure,
  type PosterLayout,
  type Rect,
} from '../../render/poster-layout';
import {
  CLEAR_MEMBER,
  GROUP_NAMES,
  alignBox,
  drawnFrame,
  newText,
  newTextPad,
  outlineOf,
  newTextRect,
  nudgeDoc,
  placeRect,
  qrObject,
  resizable,
  selectedBoxes,
  selectionAt,
  selectionFrame,
  snapMove,
  snapResize,
  snapTargets,
  textGhost,
  textName,
  textOf,
  textSizeOf,
  withTextSize,
  type AlignTo,
  type PosterSelection,
  type SnapGuides,
} from '../poster-select';
import { editPoster, editPosterRun, posterGesture, type PosterGesture } from '../poster-sync';
import {
  layerRowsState,
  linesText,
  posterLayers,
  rowName,
  setLayersOpen,
  useWorkspace,
  type WorkspaceTool,
} from '../poster-workspace';
import { qrLinkLength } from '../poster-qr';
import { currentTime, usePlayer } from '../store';
import { Swatch } from './ColoursGroup';
import { Radios, Switch } from './export-controls';
import { UndoRedo } from './UndoRedo';

const docNow = (): PosterDoc | undefined => usePlayer.getState().piece.poster;

export function select(sel: PosterSelection | null): void {
  useWorkspace.setState({ selected: sel, editing: null });
}

/** Snap distance while dragging, CSS px. */
const SNAP_CSS = 6;
/** A press moves this far (CSS px) before it is a drag. */
const DRAG_CSS = 3;
/** Hit tolerance at least this, CSS px. */
const HIT_CSS = 4;

const hex = (c: string | undefined, fallback = '#808080'): string => (c && toHex(c)) || fallback;

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

/** Hides (or shows) layer `id` in row `row` of `layout`: one undo step. */
export function hideInRow(layout: PosterLayout, id: string, row: number, hidden: boolean): void {
  const r = layout.rows[row];
  if (!r) return;
  const keys = layout.rows.map((x) => x.key);
  editPoster(
    (d) => setLayerRowHidden(d, id, r.key, hidden, keys),
    `${hidden ? 'Hide' : 'Show'} in ${rowName(layout, row)}`,
  );
}

/**
 * Delete: removes a text box; hides a layer (a layer in one row: in that row), a group or one
 * member.
 */
export function deleteSelection(): void {
  const { selected: sel, layout } = useWorkspace.getState();
  if (!sel) return;
  if (sel.kind === 'text') {
    editPoster((d) => removeText(d, sel.id), 'Remove text box');
    select(null);
  } else if (sel.kind === 'qr') {
    editPoster((d) => removeQr(d), 'Remove QR code');
    select(null);
  } else if (sel.kind === 'layer') {
    if (sel.row !== undefined && layout) hideInRow(layout, sel.id, sel.row, true);
    else editPoster((d) => setLayer(d, sel.id, { hidden: true }), 'Hide layer');
  } else if (sel.kind === 'row' || sel.kind === 'background') {
    return;
  } else if (sel.kind === 'group') {
    editPoster((d) => setGroupStyle(d, sel.group, { visible: false }), 'Hide');
  } else {
    editPoster((d) => setMemberStyle(d, sel.group, sel.member, { visible: false }), 'Hide');
  }
}

/** Moves the selection by (dx, dy) artboard px (arrow keys); a run of nudges is one entry. */
export function nudgeSelection(dx: number, dy: number): boolean {
  const { selected: sel, layout } = useWorkspace.getState();
  if (!sel || !layout || !selectionFrame(layout, sel)) return false;
  return editPosterRun(
    `nudge ${JSON.stringify(sel)}`,
    (d) => nudgeDoc(d, layout, sel, dx, dy),
    'Move',
  );
}

/** Align buttons: the selection against the margins. */
export function alignSelection(how: AlignTo): void {
  const { selected: sel, layout } = useWorkspace.getState();
  const f = layout && selectionFrame(layout, sel);
  if (!sel || !layout || !f || !resizable(sel)) return;
  editPoster((d) => placeRect(d, layout, sel, f, alignBox(f, layout.content, how)), 'Align');
}

/** Adds the QR code at its default place and selects it (one per poster: else selects it). */
export function addQrCode(): void {
  if (!docNow()?.qr) editPoster((d) => setQr(d, {}), 'Add QR code');
  useWorkspace.setState({ selected: { kind: 'qr' }, tool: 'select', editing: null });
}

/**
 * The text box being typed into and its gesture: the text shows on the artboard as it is typed,
 * and the whole edit (a new box and its first text) is one undo entry when it ends.
 */
let typed: {
  id: string;
  gesture: PosterGesture;
  base: PosterText;
  /** The text as the editor shows it (tokens filled): kept as `base.text` while unchanged. */
  filled: string;
  isNew: boolean;
} | null = null;

/** The text to store for `text` as typed: an unchanged box keeps its tokens. */
const storedText = (t: NonNullable<typeof typed>, text: string): string =>
  text === t.filled ? t.base.text : text;

/**
 * The Text tool: a new text box with its top left at (x, y), as wide as its text, or `width`
 * wide with wrapping lines; edited in place. The tool goes back to Select (as Figma's does).
 */
export function addTextAt(layout: PosterLayout, x: number, y: number, width?: number): void {
  const id = newTextId(docNow());
  const text = newText(layout, id, x, y, width);
  endTyping();
  const gesture = posterGesture('Add text box');
  gesture.update((d) => putText(d, text));
  typed = { id, gesture, base: text, filled: text.text, isNew: true };
  useWorkspace.setState({
    selected: { kind: 'text', id },
    tool: 'select',
    editing: id,
    guides: null,
  });
}

/**
 * Starts typing into text box `id` (Enter, double-click): one undo entry for the edit. `filled`
 * is its text as shown (tokens filled in); a changed text is stored as plain words.
 */
function startTyping(id: string, filled: string): void {
  if (typed?.id === id) return;
  endTyping();
  const base = textOf(docNow(), id);
  if (base) typed = { id, gesture: posterGesture('Edit text'), base, filled, isNew: false };
}

/** Shows `text` in the box being typed into. */
function typeText(text: string): void {
  if (!typed) return;
  const t = { ...typed.base, text: storedText(typed, text) };
  typed.gesture.update((d) => putText(d, t));
}

/** Ends typing with `text` (none: as typed so far). An empty box goes (a new one leaves no trace). */
function endTyping(text?: string): void {
  const t = typed;
  if (!t) return;
  typed = null;
  if (text !== undefined && text.trim() === '') {
    if (t.isNew) t.gesture.cancel();
    else {
      t.gesture.update((d) => removeText(d, t.id));
      t.gesture.end();
    }
    const sel = useWorkspace.getState().selected;
    if (sel?.kind === 'text' && sel.id === t.id) useWorkspace.setState({ selected: null });
    return;
  }
  if (text !== undefined) {
    const next = { ...t.base, text: storedText(t, text) };
    t.gesture.update((d) => putText(d, next));
  }
  t.gesture.end();
}

/** Escape with the Text tool armed: back to Select. True when it did. */
export function disarmTextTool(): boolean {
  if (useWorkspace.getState().tool !== 'text') return false;
  useWorkspace.setState({ tool: 'select', guides: null });
  return true;
}

/** Whether a key event's target takes typing (the workspace's keys stand down). */
function typing(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select' || el.isContentEditable) return true;
  if (tag !== 'input') return false;
  const type = (el as HTMLInputElement).type;
  return type !== 'checkbox' && type !== 'radio' && type !== 'range' && type !== 'button';
}

/**
 * The workspace's own keys (document keydown while it shows). Returns true when used. Not while
 * typing, with ⌘/Ctrl (undo is the editor's), or a modal dialog open.
 */
export function workspaceKey(e: {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}): boolean {
  if (e.metaKey || e.ctrlKey || typing(e.target)) return false;
  if (document.querySelector('dialog[open]')) return false;
  const { selected, layout } = useWorkspace.getState();
  const k = e.key;
  if (!e.altKey && (k === 'v' || k === 'V' || k === 't' || k === 'T')) {
    useWorkspace.setState({ tool: k === 'v' || k === 'V' ? 'select' : 'text' });
    return true;
  }
  if (!selected || !layout) return false;
  // Sliders, switches and radios keep their arrows; a button keeps Enter.
  const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
  const control = tag === 'input' || tag === 'select';
  if (k.startsWith('Arrow') && !control) {
    const step = (e.shiftKey ? 10 : 1) * layout.unit;
    const dx = k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0;
    const dy = k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0;
    nudgeSelection(dx, dy);
    return true;
  }
  if ((k === 'Delete' || k === 'Backspace') && !control) {
    deleteSelection();
    return true;
  }
  if (k === 'Enter' && selected.kind === 'text' && !control && tag !== 'button') {
    useWorkspace.setState({ editing: selected.id });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// The artboard overlay
// ---------------------------------------------------------------------------------------------

interface Drag {
  kind: 'move' | 'resize';
  handle: Handle | null;
  sel: PosterSelection;
  layout: PosterLayout;
  frame: Rect;
  /** The outline drawn (`drawnFrame`): snapped by, its shift is the frame's. */
  drawn: Rect;
  x0: number;
  y0: number;
  started: boolean;
  gesture: PosterGesture | null;
  last: { x: number; y: number; shift: boolean; alt: boolean } | null;
  raf: number;
}

/** A press with the Text tool: a click places a box as wide as its text, a drag sets its width. */
interface Place {
  /** The new box's frame's top left (artboard px). */
  x0: number;
  y0: number;
  /** The drag's frame so far (artboard px), once it is a drag. */
  box: Rect | null;
}

/**
 * Over the artboard's canvas, in the poster's own coordinates as percentages: the margins as
 * guides (not exported), the selection's outlines and handles, snap guides while dragging, the
 * Text tool's ghost and the text box being edited. It takes the pointer for selecting, moving,
 * resizing and placing text.
 */
export function ArtboardOverlay({ width }: { width: number }) {
  const layout = useWorkspace((s) => s.layout);
  const selected = useWorkspace((s) => s.selected);
  const tool = useWorkspace((s) => s.tool);
  const guides = useWorkspace((s) => s.guides);
  const editing = useWorkspace((s) => s.editing);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const place = useRef<Place | null>(null);
  // The Text tool's ghost: where a click puts the new box (artboard px).
  const [ghost, setGhost] = useState<{ box: Rect; drag: boolean } | null>(null);

  useEffect(
    () => () => {
      const d = drag.current;
      if (d) {
        cancelAnimationFrame(d.raf);
        d.gesture?.end();
      }
    },
    [],
  );

  if (!layout) return null;
  const W = layout.width;
  const H = layout.height;
  const scale = width / W;
  const pct = (r: Rect) => ({
    left: `${(r.x / W) * 100}%`,
    top: `${(r.y / H) * 100}%`,
    width: `${(r.w / W) * 100}%`,
    height: `${(r.h / H) * 100}%`,
  });
  const board = (e: { clientX: number; clientY: number }) => {
    const b = root.current!.getBoundingClientRect();
    return { x: ((e.clientX - b.left) / b.width) * W, y: ((e.clientY - b.top) / b.height) * H };
  };
  const showGuides = (g: SnapGuides | null) =>
    useWorkspace.setState({ guides: g && (g.x !== undefined || g.y !== undefined) ? g : null });

  const apply = (d: Drag) => {
    d.raf = 0;
    const p = d.last;
    if (!p || !d.gesture) return;
    const dx = p.x - d.x0;
    const dy = p.y - d.y0;
    const snapOn = useWorkspace.getState().snap;
    const tol = SNAP_CSS / scale;
    let to: Rect;
    let g: { x?: number; y?: number } | null = null;
    if (d.kind === 'move') {
      to = { ...d.frame, x: d.frame.x + dx, y: d.frame.y + dy };
      // Alt moves freely.
      if (snapOn && !p.alt) {
        const at = { ...d.drawn, x: d.drawn.x + dx, y: d.drawn.y + dy };
        const s = snapMove(at, snapTargets(d.layout, d.sel), tol);
        to = { ...to, x: to.x + s.box.x - at.x, y: to.y + s.box.y - at.y };
        g = s.guides;
      }
    } else {
      let delta = { dx, dy };
      if (snapOn) {
        const s = snapResize(d.drawn, d.handle!, delta, snapTargets(d.layout, d.sel), tol);
        delta = s;
        g = s.guides;
      }
      to = resizeBox(d.frame, d.handle!, delta, {
        // The QR code stays square.
        shift: p.shift || d.sel.kind === 'qr',
        alt: p.alt,
        min: 4 * d.layout.unit,
      });
    }
    showGuides(g);
    const { sel, layout: L, frame } = d;
    d.gesture.update((doc) => placeRect(doc, L, sel, frame, to));
  };

  const finish = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    if (d.raf) cancelAnimationFrame(d.raf);
    if (d.gesture) {
      apply(d);
      d.gesture.end();
      if (d.sel.kind === 'text') useWorkspace.setState({ refit: false });
    }
    useWorkspace.setState({ guides: null });
  };

  /** The Text tool's snap distance (none with Alt or the Snap switch off). */
  const ghostTol = (alt: boolean) => (useWorkspace.getState().snap && !alt ? SNAP_CSS / scale : 0);

  /** The Text tool's ghost at the pointer, snapped as the box will be. */
  const hover = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = board(e);
    const g = textGhost(layout, p.x, p.y, ghostTol(e.altKey));
    setGhost({ box: g.box, drag: false });
    showGuides(g.guides);
  };

  /** A Text tool drag: from the press to the pointer, the moving edge of its outline snapped. */
  const placeDrag = (pl: Place, e: React.PointerEvent<HTMLDivElement>) => {
    const p = board(e);
    if (!pl.box && Math.abs(p.x - pl.x0) * scale < DRAG_CSS) return;
    const handle: Handle = p.x >= pl.x0 ? 'e' : 'w';
    const tol = ghostTol(e.altKey);
    const pad = newTextPad(layout);
    const start = outlineOf({ x: pl.x0, y: pl.y0, w: 0, h: 0 }, pad);
    const s =
      tol > 0
        ? snapResize(start, handle, { dx: p.x - pl.x0, dy: 0 }, snapTargets(layout, null), tol)
        : { dx: p.x - pl.x0, guides: {} };
    const x1 = pl.x0 + s.dx;
    const h = newTextRect(layout, pl.x0, pl.y0).h;
    pl.box = { x: Math.min(pl.x0, x1), y: pl.y0, w: Math.abs(x1 - pl.x0), h };
    setGhost({ box: outlineOf(pl.box, pad), drag: true });
    showGuides(s.guides);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    root.current?.closest<HTMLElement>('[data-testid="poster-workspace"]')?.focus({
      preventScroll: true,
    });
    const p = board(e);
    if (useWorkspace.getState().tool === 'text') {
      const g = textGhost(layout, p.x, p.y, ghostTol(e.altKey));
      place.current = { x0: g.frame.x, y0: g.frame.y, box: null };
      setGhost({ box: g.box, drag: false });
      root.current?.setPointerCapture(e.pointerId);
      return;
    }
    const handle = ((e.target as HTMLElement).dataset.handle as Handle | undefined) ?? null;
    let sel = useWorkspace.getState().selected;
    let frame = selectionFrame(layout, sel);
    const tol = Math.max(1.5 * layout.unit, HIT_CSS / scale);
    const onFrame =
      frame &&
      !e.altKey &&
      resizable(sel) &&
      p.x >= frame.x &&
      p.x <= frame.x + frame.w &&
      p.y >= frame.y &&
      p.y <= frame.y + frame.h &&
      // A row moves from its empty space: what is drawn in it stays clickable.
      (sel?.kind !== 'row' || selectionAt(layout, p.x, p.y, false, tol)?.kind === 'row');
    if (!(handle && frame) && !onFrame) {
      sel = selectionAt(layout, p.x, p.y, e.altKey, tol);
      select(sel);
      frame = selectionFrame(layout, sel);
    }
    if (!sel || !frame || sel.kind === 'group') return;
    root.current?.setPointerCapture(e.pointerId);
    drag.current = {
      kind: handle ? 'resize' : 'move',
      handle,
      sel,
      layout,
      frame,
      drawn: drawnFrame(layout, sel) ?? frame,
      x0: p.x,
      y0: p.y,
      started: false,
      gesture: null,
      last: null,
      raf: 0,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const pl = place.current;
    if (pl) {
      placeDrag(pl, e);
      return;
    }
    const d = drag.current;
    if (!d) {
      if (useWorkspace.getState().tool === 'text') hover(e);
      return;
    }
    const p = board(e);
    if (!d.started) {
      if (Math.hypot(p.x - d.x0, p.y - d.y0) * scale < DRAG_CSS) return;
      d.started = true;
      d.gesture = posterGesture(d.kind === 'move' ? 'Move' : 'Resize');
    }
    d.last = { x: p.x, y: p.y, shift: e.shiftKey, alt: e.altKey };
    if (!d.raf) d.raf = requestAnimationFrame(() => apply(d));
  };

  const onPointerUp = () => {
    const pl = place.current;
    if (!pl) {
      finish();
      return;
    }
    place.current = null;
    setGhost(null);
    const min = 4 * layout.unit;
    if (pl.box) addTextAt(layout, pl.box.x, pl.y0, Math.max(min, pl.box.w));
    else addTextAt(layout, pl.x0, pl.y0);
  };

  const boxes = selectedBoxes(layout, selected);
  const frame = resizable(selected) ? selectionFrame(layout, selected) : null;
  // A text box's handles sit on its outline (its frame with even space round the ink).
  const hRect = frame && selected?.kind === 'text' ? (boxes[0] ?? frame) : frame;
  const c = layout.content;
  const ghostSize = textDefaults('free').size * Math.min(W, H) * scale;
  const ghostPad = newTextPad(layout) * scale;
  return (
    <div
      ref={root}
      className={tool === 'text' ? 'ws-overlay text-tool' : 'ws-overlay'}
      data-testid="artboard-overlay"
      data-width={W}
      data-height={H}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        place.current = null;
        setGhost(null);
        finish();
      }}
      onPointerLeave={() => {
        if (place.current || drag.current) return;
        setGhost(null);
        if (useWorkspace.getState().tool === 'text') showGuides(null);
      }}
      onDoubleClick={() => {
        const s = useWorkspace.getState().selected;
        if (s?.kind === 'text') useWorkspace.setState({ editing: s.id });
      }}
    >
      <div className="ws-margins" style={pct(c)} data-testid="margin-guides" aria-hidden="true" />
      {boxes.length > 0 && (
        <div
          className="ws-selection"
          data-testid="selection"
          data-kind={selected?.kind}
          data-count={boxes.length}
          aria-hidden="true"
        >
          {boxes.map((r, i) => (
            <div key={i} className="ws-sel-box" style={pct(r)} />
          ))}
        </div>
      )}
      {hRect &&
        HANDLES.map((h) => (
          <div
            key={h}
            className={`ws-handle ws-handle-${h}`}
            data-handle={h}
            data-testid={`handle-${h}`}
            style={{
              left: `${((hRect.x + (h.includes('w') ? 0 : h.includes('e') ? hRect.w : hRect.w / 2)) / W) * 100}%`,
              top: `${((hRect.y + (h.includes('n') ? 0 : h.includes('s') ? hRect.h : hRect.h / 2)) / H) * 100}%`,
            }}
          />
        ))}
      {guides?.x !== undefined && (
        <div
          className="ws-guide ws-guide-x"
          data-testid="snap-guide-x"
          style={{ left: `${(guides.x / W) * 100}%` }}
        />
      )}
      {guides?.y !== undefined && (
        <div
          className="ws-guide ws-guide-y"
          data-testid="snap-guide-y"
          style={{ top: `${(guides.y / H) * 100}%` }}
        />
      )}
      {tool === 'text' && ghost && (
        <div
          className={ghost.drag ? 'ws-ghost ws-ghost-drag' : 'ws-ghost'}
          data-testid="text-ghost"
          aria-hidden="true"
          style={{
            ...pct(ghost.box),
            paddingLeft: ghostPad,
            font: textFont(layout, 'free', ghostSize),
            lineHeight: LINE_HEIGHT,
          }}
        >
          Text
        </div>
      )}
      <QrState layout={layout} pct={pct} />
      {editing && <InlineText key={editing} id={editing} layout={layout} scale={scale} />}
    </div>
  );
}

/**
 * Over a QR code the poster can't draw: "too long to scan" (left out of exports) or "making" while
 * it encodes. A ready code is drawn by the canvas itself.
 */
function QrState({ layout, pct }: { layout: PosterLayout; pct: (r: Rect) => React.CSSProperties }) {
  const o = qrObject(layout);
  if (!o || o.state === 'ok') return null;
  return (
    <div
      className={`ws-qr-state ws-qr-${o.state}`}
      data-testid="qr-state"
      data-state={o.state}
      style={pct(o.box)}
    >
      {o.state === 'long' ? (
        <span>
          <b>Too long to scan</b>
          <br />
          {o.link.length.toLocaleString('en')} of {QR_MAX_CHARS.toLocaleString('en')} characters.
          Left out of exports.
        </span>
      ) : (
        <span>Making the QR code…</span>
      )}
    </div>
  );
}

/** Text widths in CSS px, for the box being typed into. */
let cssMeasure: Measure | null = null;
const measureCss: Measure = (text, font, spacing) => {
  if (!cssMeasure) {
    const g = document.createElement('canvas').getContext('2d');
    cssMeasure = g ? measureWith(g) : estimateText;
  }
  return cssMeasure(text, font, spacing);
};

/**
 * A text box edited in place. The artboard draws the text as it is typed (its real font, size
 * and colour); the field over it shows only the caret and the selection. It shows the words as
 * drawn (tokens filled in); a changed text is stored as written, an unchanged one keeps its
 * tokens. Enter, Escape or leaving it keeps the text (an empty box goes); Shift+Enter breaks the
 * line.
 */
function InlineText({ id, layout, scale }: { id: string; layout: PosterLayout; scale: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const t = textOf(docNow(), id);
  const o = layout.objects.find((x) => x.type === 'text' && x.member === id);
  const [filled] = useState(() => (t ? fillTokens(t.text, layout.tokens) : ''));
  const [value, setValue] = useState(filled);
  const done = useRef(false);
  const latest = useRef(value);
  // A new text box shows once the artboard has drawn it: focus it then.
  const ready = !!t && o?.type === 'text';
  useLayoutEffect(() => {
    if (!ready) return;
    startTyping(id, filled);
    ref.current?.focus();
    ref.current?.select();
  }, [ready, id, filled]);
  // Undo, a selection change or closing the workspace ends the edit as typed so far (after a
  // tick: StrictMode remounts at once).
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      setTimeout(() => {
        if (!alive.current && !done.current && typed?.id === id) endTyping(latest.current);
      }, 0);
    };
  }, [id]);
  if (!t || !o || o.type !== 'text') return null;
  const W = layout.width;
  const H = layout.height;
  const f = o.frame;
  const commit = (text: string) => {
    if (done.current) return;
    done.current = true;
    endTyping(text);
    useWorkspace.setState({ editing: null });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      commit(e.currentTarget.value);
    }
  };
  const px = o.size * scale;
  const font = o.font.replace(/[\d.]+px/, `${px}px`);
  const lines = value.split('\n');
  // As wide as the typed text (an auto box), else the box.
  const auto = t.sizing === 'auto' || (!t.box && !t.sizing);
  const w = auto ? Math.max(...lines.map((l) => measureCss(l, font, 0))) + 2 : f.w * scale;
  const h = Math.max(f.h * scale, lines.length * LINE_HEIGHT * px);
  const fx = f.x * scale;
  const left = !auto
    ? fx
    : o.align === 'right'
      ? fx + f.w * scale - w
      : o.align === 'center'
        ? fx + (f.w * scale - w) / 2
        : fx;
  return (
    <textarea
      ref={ref}
      className="ws-inline-text"
      data-testid="inline-text"
      aria-label="Text"
      value={value}
      rows={1}
      wrap={auto ? 'off' : 'soft'}
      spellCheck={false}
      style={{
        left: `${(left / (W * scale)) * 100}%`,
        top: `${(f.y / H) * 100}%`,
        width: `${w}px`,
        height: `${h}px`,
        font,
        lineHeight: LINE_HEIGHT,
        textAlign: o.align,
        caretColor: o.colour,
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onChange={(e) => {
        const v = e.currentTarget.value;
        latest.current = v;
        setValue(v);
        typeText(v);
      }}
      onKeyDown={onKey}
      onBlur={(e) => commit(e.currentTarget.value)}
    />
  );
}

/**
 * The playhead while the music plays (owner): a thin line at the playing time's slice on its
 * row (`posterTimeAt`), moving row by row, and a fainter one on each moved layer's own slice.
 * Drawn every frame outside React; never exported; hidden when stopped.
 */
export function ArtboardPlayhead() {
  const playing = usePlayer((s) => s.transport.status === 'playing');
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const el = root.current;
      const layout = useWorkspace.getState().layout;
      if (!el || !layout) return;
      const at = posterTimeAt(layout, currentTime());
      const lines = el.children;
      if (!at) {
        el.hidden = true;
        return;
      }
      el.hidden = false;
      el.dataset.row = String(at.row);
      const W = layout.width;
      const H = layout.height;
      const place = (k: number, x: number, y0: number, y1: number) => {
        const line = lines[k] as HTMLElement | undefined;
        if (!line) return;
        line.hidden = false;
        line.style.left = `${(x / W) * 100}%`;
        line.style.top = `${(y0 / H) * 100}%`;
        line.style.height = `${((y1 - y0) / H) * 100}%`;
      };
      place(0, at.x, at.y0, at.y1);
      el.dataset.x = String(Math.round(at.x));
      // Moved layers: where their own slice is, if it isn't on the row's.
      const moved = at.layers.filter(
        (l) => Math.abs(l.x - at.x) > 0.5 || l.y0 < at.y0 - 0.5 || l.y1 > at.y1 + 0.5,
      );
      for (let k = 1; k < lines.length; k++) {
        const m = moved[k - 1];
        if (m) place(k, m.x, m.y0, m.y1);
        else (lines[k] as HTMLElement).hidden = true;
      }
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  if (!playing) return null;
  return (
    <div
      ref={root}
      className="ws-playhead"
      data-testid="artboard-playhead"
      aria-hidden="true"
      hidden
    >
      <div className="ws-playhead-line" />
      {Array.from({ length: PLAYHEAD_LAYERS }, (_, k) => (
        <div key={k} className="ws-playhead-line ws-playhead-layer" hidden />
      ))}
    </div>
  );
}

/** Moved layers the playhead marks at most. */
const PLAYHEAD_LAYERS = 8;

/** "Re-fit layout" after a size, rows or margins change leaves text boxes over the music. */
export function RefitHint() {
  const layout = useWorkspace((s) => s.layout);
  const armed = useWorkspace((s) => s.refit);
  if (!layout || !armed || !overlapsMusic(layout)) return null;
  return (
    <div className="ws-refit" role="status" data-testid="refit-hint">
      <span>Text covers the music.</span>
      <button
        type="button"
        data-testid="refit"
        onClick={() => {
          editPoster((d) => refitPoster(d), 'Re-fit layout');
          useWorkspace.setState({ refit: false });
        }}
      >
        Re-fit layout
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------------------------

/** A typed number: applied on Enter or leaving the field (Escape reverts). */
function NumField({
  label,
  value,
  testId,
  onCommit,
}: {
  label: string;
  value: number;
  testId: string;
  onCommit: (v: number) => void;
}) {
  const id = useId();
  const shown = String(Math.round(value));
  const [draft, setDraft] = useState({ of: shown, text: shown });
  const text = draft.of === shown ? draft.text : shown;
  const commit = () => {
    const v = Number(text);
    if (text.trim() !== '' && Number.isFinite(v) && String(Math.round(v)) !== shown) onCommit(v);
    else setDraft({ of: shown, text: shown });
  };
  return (
    <label className="ws-num" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        step={1}
        value={text}
        data-testid={testId}
        onChange={(e) => setDraft({ of: shown, text: e.target.value })}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape' && text !== shown) {
            e.preventDefault();
            e.stopPropagation();
            setDraft({ of: shown, text: shown });
          }
        }}
      />
    </label>
  );
}

/** X, Y, W and H in artboard px. */
function BoxFields({ frame, onBox }: { frame: Rect; onBox: (r: Rect) => void }) {
  const set = (k: keyof Rect) => (v: number) => {
    const r = { ...frame, [k]: v };
    if ((k === 'w' || k === 'h') && !(v >= 1)) return;
    onBox(r);
  };
  return (
    <div className="ws-box-fields" role="group" aria-label="Position and size (px)">
      <NumField label="X" value={frame.x} testId="sel-x" onCommit={set('x')} />
      <NumField label="Y" value={frame.y} testId="sel-y" onCommit={set('y')} />
      <NumField label="W" value={frame.w} testId="sel-w" onCommit={set('w')} />
      <NumField label="H" value={frame.h} testId="sel-h" onCommit={set('h')} />
    </div>
  );
}

/** A slider with its value shown; a drag of it is one undo entry. */
function Slider({
  label,
  min,
  max,
  step,
  value,
  text,
  testId,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  text: string;
  testId: string;
  onChange: (v: number) => void;
}) {
  const id = useId();
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <div className="field-row look-range">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-valuetext={text}
          data-testid={testId}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        <output htmlFor={id} data-testid={`${testId}-value`}>
          {text}
        </output>
      </div>
    </>
  );
}

const pctText = (v: number) => `${Math.round(v)} %`;

// ---------------------------------------------------------------------------------------------
// The selection panel
// ---------------------------------------------------------------------------------------------

/**
 * The right panel while an object is selected: the whole panel is that object's settings (a
 * header names it; × or Escape returns to the poster's). With nothing selected, `children` (the
 * poster's options) show instead. Any selection kind plugs in by adding its title and body here.
 */
export function SelectionPanel({ children }: { children?: React.ReactNode }) {
  const sel = useWorkspace((s) => s.selected);
  const layout = useWorkspace((s) => s.layout);
  const doc = usePlayer((s) => s.piece.poster);
  const voices = usePlayer((s) => s.piece.voices);
  // The background's settings are the poster's (Colours): its handles show on the artboard.
  if (!sel || !layout || sel.kind === 'background') return <>{children}</>;
  let title: string;
  let body: React.ReactNode;
  if (sel.kind === 'layer') {
    const vid = sel.id.startsWith('line:') ? sel.id.slice(5) : null;
    const v = vid ? voices.find((x) => x.id === vid) : null;
    title = vid ? (v?.name ?? 'Line') : sel.id.slice(5) || 'Lines';
    if (sel.row !== undefined) title += ` · row ${sel.row + 1}`;
    body = <LayerPanel sel={sel} layout={layout} doc={doc} />;
  } else if (sel.kind === 'row') {
    title = `Row ${sel.row + 1}`;
    body = <RowPanel row={sel.row} layout={layout} doc={doc} />;
  } else if (sel.kind === 'text') {
    const t = textOf(doc, sel.id);
    if (!t) return <>{children}</>;
    title = textName(t);
    body = <TextPanel id={sel.id} t={t} layout={layout} />;
  } else if (sel.kind === 'qr') {
    if (!doc?.qr) return <>{children}</>;
    title = 'QR code';
    body = <QrPanel layout={layout} />;
  } else {
    title = GROUP_NAMES[sel.group];
    body = <GroupPanel sel={sel} layout={layout} doc={doc} />;
  }
  return (
    <section className="ws-selpanel" aria-label="Selected" data-testid="selection-panel">
      <header className="ws-selpanel-head">
        <h3 data-testid="selection-title">
          {title}
          {sel.kind === 'member' && <small> · one</small>}
          {sel.kind === 'group' && <small> · all</small>}
        </h3>
        <button
          type="button"
          className="ws-deselect"
          aria-label="Clear the selection"
          onClick={() => select(null)}
        >
          ×
        </button>
      </header>
      {body}
    </section>
  );
}

function LayerPanel({
  sel,
  layout,
  doc,
}: {
  sel: Extract<PosterSelection, { kind: 'layer' }>;
  layout: PosterLayout;
  doc: PosterDoc | undefined;
}) {
  const entry = doc?.layers?.find((l) => l.id === sel.id);
  const L = layerOf(layout, sel.id);
  const frame = selectionFrame(layout, sel);
  const hidden = entry?.hidden === true;
  const ink = hex(layout.style.tokens.ink);
  const isLine = sel.id.startsWith('line:');
  const row = sel.row !== undefined ? layout.rows[sel.row] : undefined;
  const placed = row ? L?.frames[row.index]?.base !== undefined : false;
  const rowShown = row ? layerRowsState(layout, entry).rows[row.index] : true;
  return (
    <>
      {sel.row !== undefined && (
        <small className="hud-sample">Position and size: this row only.</small>
      )}
      {frame ? (
        <BoxFields
          frame={frame}
          onBox={(r) =>
            editPosterRun(
              `box ${sel.id} ${sel.row ?? ''}`,
              (d) => placeRect(d, layout, sel, frame, r),
              'Move',
            )
          }
        />
      ) : (
        isLine &&
        !hidden && (
          <button
            type="button"
            data-testid="split-line"
            onClick={() =>
              editPoster(
                (d) => setLayer(d, sel.id, { box: { x: 0, y: 0, w: 1, h: 1 } }),
                'Move line on its own',
              )
            }
          >
            Move on its own
          </button>
        )
      )}
      {row && placed && (
        <button
          type="button"
          data-testid="sel-row-reset"
          onClick={() => editPoster((d) => setLayerRow(d, sel.id, row.key, undefined), 'Reset row')}
        >
          Back in line with the other rows
        </button>
      )}
      {sel.row !== undefined && <small className="hud-sample">Style: in every row.</small>}
      {row && (
        <Switch
          label="Hidden in this row"
          checked={!rowShown}
          testId="sel-hidden-row"
          onChange={(v) => hideInRow(layout, sel.id, row.index, v)}
        />
      )}
      <Switch
        label={row ? 'Hidden in every row' : 'Hidden'}
        checked={hidden}
        testId="sel-hidden"
        onChange={(v) =>
          editPoster(
            (d) => setLayer(d, sel.id, { hidden: v || undefined, hiddenRows: undefined }),
            v ? 'Hide' : 'Show',
          )
        }
      />
      <div className="look-grid">
        <Swatch
          label="Colour"
          value={hex(entry?.colour, ink)}
          set={!!entry?.colour}
          testId="sel-colour"
          hint="also in the video"
          onChange={(c) =>
            editPosterRun(
              `colour ${sel.id}`,
              (d) => setLayer(d, sel.id, { colour: c ?? undefined }),
              'Colour',
            )
          }
        />
      </div>
    </>
  );
}

/** A row moved as a block: X/Y/W/H and a reset. */
function RowPanel({
  row,
  layout,
  doc,
}: {
  row: number;
  layout: PosterLayout;
  doc: PosterDoc | undefined;
}) {
  const r = layout.rows[row];
  if (!r) return null;
  const sel: PosterSelection = { kind: 'row', row };
  const frame = r.rect;
  return (
    <>
      <small className="hud-sample">Everything in the row moves with it.</small>
      <BoxFields
        frame={frame}
        onBox={(to) =>
          editPosterRun(`box row ${row}`, (d) => placeRect(d, layout, sel, frame, to), 'Move row')
        }
      />
      {doc?.rowBoxes?.[r.key] && (
        <button
          type="button"
          data-testid="sel-row-reset"
          onClick={() => editPoster((d) => setRowBox(d, r.key, undefined), 'Reset row')}
        >
          Back to its place
        </button>
      )}
    </>
  );
}

const FONTS = [
  { id: 'serif', label: 'Serif' },
  { id: 'sans', label: 'Sans' },
  { id: 'mono', label: 'Mono' },
] as const;
const WEIGHTS = [
  { id: 300, label: 'Light' },
  { id: 400, label: 'Regular' },
  { id: 500, label: 'Medium' },
  { id: 700, label: 'Bold' },
] as const;
const ALIGNS = [
  { id: 'left', label: 'Left' },
  { id: 'center', label: 'Centre' },
  { id: 'right', label: 'Right' },
] as const;
const TEXT_FONT: Record<PosterText['kind'], 'serif' | 'sans' | 'mono'> = {
  title: 'serif',
  subtitle: 'serif',
  credit: 'mono',
  free: 'sans',
};

function TextPanel({ id, t, layout }: { id: string; t: PosterText; layout: PosterLayout }) {
  const fid = useId();
  const o = layout.objects.find((x) => x.type === 'text' && x.member === id);
  const frame = o && o.type === 'text' ? o.frame : null;
  const style = t.style ?? {};
  const put = (key: string, fn: (cur: PosterText) => PosterText, label = 'Text style') =>
    editPosterRun(
      `${key} ${id}`,
      (d) => {
        const cur = textOf(d, id);
        return cur ? putText(d, fn(cur)) : d;
      },
      label,
    );
  const setStyle = (key: string, patch: PosterText['style']) =>
    put(key, (cur) => {
      const s = { ...cur.style, ...patch };
      for (const k of Object.keys(s) as (keyof typeof s)[]) if (s[k] === undefined) delete s[k];
      const { style: _s, ...rest } = cur;
      // An auto-width box keeps where it is drawn: its edge for the new alignment stays put.
      if (cur.sizing === 'auto' && frame) rest.box = textBoxFor(layout, frame);
      return Object.keys(s).length > 0 ? { ...rest, style: s } : rest;
    });
  const size = textSizeOf(layout, id) * 100;
  const sel: PosterSelection = { kind: 'text', id };
  const colour = o && o.type === 'text' ? o.colour : layout.style.tokens.ink;
  return (
    <>
      <label className="ws-textfield" htmlFor={fid}>
        <span>Text</span>
        <textarea
          id={fid}
          rows={2}
          value={fillTokens(t.text, layout.tokens)}
          spellCheck={false}
          data-testid="sel-text"
          onChange={(e) => {
            const text = e.target.value;
            put('text', (cur) => ({ ...cur, text }), 'Edit text');
          }}
        />
      </label>
      <Radios
        legend="Font"
        name={`${fid}-font`}
        value={style.font ?? TEXT_FONT[t.kind]}
        options={FONTS}
        testId="sel-font"
        onChange={(font) => setStyle('font', { font })}
      />
      <div className="look-grid">
        <Slider
          label="Size"
          min={0.5}
          max={15}
          step={0.1}
          value={Math.round(size * 10) / 10}
          text={`${(Math.round(size * 10) / 10).toFixed(1)} %`}
          testId="sel-size"
          onChange={(v) =>
            editPosterRun(`size ${id}`, (d) => withTextSize(d, layout, id, v / 100), 'Text size')
          }
        />
      </div>
      <Radios
        legend="Weight"
        name={`${fid}-weight`}
        value={style.weight ?? (t.kind === 'title' ? 400 : 400)}
        options={WEIGHTS}
        testId="sel-weight"
        onChange={(weight) => setStyle('weight', { weight })}
      />
      <Radios
        legend="Align"
        name={`${fid}-align`}
        value={style.align ?? 'left'}
        options={ALIGNS}
        testId="sel-align"
        onChange={(align) => setStyle('align', { align })}
      />
      <div className="look-grid">
        <Swatch
          label="Colour"
          value={hex(colour)}
          set={!!style.colour}
          testId="sel-colour"
          onChange={(c) => setStyle('colour', { colour: c ?? undefined })}
        />
      </div>
      {frame && (
        <BoxFields
          frame={frame}
          onBox={(r) =>
            editPosterRun(`box ${id}`, (d) => placeRect(d, layout, sel, frame, r), 'Move')
          }
        />
      )}
      <button
        type="button"
        className="ws-remove"
        data-testid="sel-remove"
        onClick={() => {
          editPoster((d) => removeText(d, id), 'Remove text box');
          select(null);
        }}
      >
        Remove text box
      </button>
    </>
  );
}

/**
 * The QR code: what it holds, its colours (warned when too faint to scan), place and size
 * (square; warned when a module is under a few px at the export size), and Remove.
 */
function QrPanel({ layout }: { layout: PosterLayout }) {
  const q = usePlayer((s) => s.piece.poster?.qr);
  const o = qrObject(layout);
  if (!q || !o) return null;
  const sel: PosterSelection = { kind: 'qr' };
  const colour = q.colour ?? QR_DEFAULT_COLOUR;
  const card = q.card ?? QR_DEFAULT_CARD;
  const contrast = qrContrast(colour, card);
  const modulePx = qrModulePx(o.box.w, o.matrix);
  const frame = o.box;
  return (
    <>
      <p className="ws-qr-what" data-testid="qr-what">
        {o.state === 'long'
          ? `The watch link is ${o.link.length.toLocaleString('en')} characters, over the ${QR_MAX_CHARS.toLocaleString('en')} a code that scans easily holds: it is left out of exports.`
          : o.link
            ? `Opens the piece to watch (${o.link.length.toLocaleString('en')} characters).`
            : 'Making the code…'}
      </p>
      <div className="look-grid">
        <Swatch
          label="Modules"
          value={hex(colour, QR_DEFAULT_COLOUR)}
          set={q.colour !== undefined}
          testId="qr-colour"
          onChange={(c) =>
            editPosterRun('qr colour', (d) => setQr(d, { colour: c ?? undefined }), 'QR colour')
          }
        />
        <Swatch
          label="Card"
          value={hex(card, QR_DEFAULT_CARD)}
          set={q.card !== undefined}
          testId="qr-card"
          onChange={(c) =>
            editPosterRun('qr card', (d) => setQr(d, { card: c ?? undefined }), 'QR colour')
          }
        />
      </div>
      {!qrReadable(colour, card) && (
        <p className="ws-warn" role="status" data-testid="qr-contrast-warning">
          {contrast !== null && contrast < 0
            ? 'Lighter modules than card: many phones won’t read it. Use dark modules on a light card.'
            : `Contrast ${Math.abs(contrast ?? 0).toFixed(1)}:1 is too low to scan reliably: use darker modules or a lighter card.`}
        </p>
      )}
      {o.matrix && modulePx < QR_MIN_MODULE_PX && (
        <p className="ws-warn" role="status" data-testid="qr-size-warning">
          {`Each module is ${modulePx.toFixed(1)} px at this size (${o.matrix.n} across): make the code larger, or the poster, so it scans.`}
        </p>
      )}
      <BoxFields
        frame={frame}
        onBox={(r) => {
          // Square: the side typed wins.
          const side = r.w !== frame.w ? r.w : r.h;
          const to = { ...r, w: side, h: side };
          editPosterRun('box qr', (d) => placeRect(d, layout, sel, frame, to), 'Move');
        }}
      />
      <button
        type="button"
        className="ws-remove"
        data-testid="sel-remove"
        onClick={() => {
          editPoster((d) => removeQr(d), 'Remove QR code');
          select(null);
        }}
      >
        Remove QR code
      </button>
    </>
  );
}

const SIDES: Readonly<
  Partial<Record<PosterLabelGroup, readonly { id: PosterLabelSide; label: string }[]>>
> = {
  sectionLabels: [
    { id: 'left', label: 'Left' },
    { id: 'right', label: 'Right' },
  ],
  momentLabels: [
    { id: 'left', label: 'Left' },
    { id: 'right', label: 'Right' },
  ],
  guideLabels: [
    { id: 'out', label: 'Outside' },
    { id: 'above', label: 'Above' },
    { id: 'below', label: 'Below' },
  ],
  pitchLabels: [
    { id: 'out', label: 'Outside' },
    { id: 'above', label: 'Above' },
    { id: 'below', label: 'Below' },
  ],
};
const LABEL_WEIGHTS = [
  { id: 400, label: 'Regular' },
  { id: 500, label: 'Medium' },
  { id: 700, label: 'Bold' },
] as const;
const EXTENTS = [
  { id: 'full', label: 'Full height' },
  { id: 'tick', label: 'Tick' },
] as const;

const ALONG = [
  { id: 'start', label: 'Start' },
  { id: 'end', label: 'End' },
] as const;

/** A group's resolved style (labels, lines or marks) as the panel shows it. */
function resolvedOf(layout: PosterLayout, g: PosterGroup) {
  if (isLabelGroup(g)) return { kind: 'label' as const, ...layout.labels[g] };
  if (isMarkGroup(g)) return { kind: 'mark' as const, ...layout.marks[g] };
  return { kind: 'line' as const, ...layout.lines[g] };
}

/** Whether a group shows on the poster now. */
export const groupVisible = (layout: PosterLayout, g: PosterGroup): boolean =>
  resolvedOf(layout, g).visible;

/**
 * A group's (or one member's) style controls: the fields `GROUP_FIELDS` lists for it, each a
 * poster edit (a slider's run is one undo entry). Used by the selection panel and by a switch's
 * details in the right panel (`testPrefix` tells them apart).
 */
export function GroupStyleFields({
  group: g,
  member = null,
  layout,
  doc,
  testPrefix = 'sel',
  showVisible = true,
}: {
  group: PosterGroup;
  member?: string | null;
  layout: PosterLayout;
  doc: PosterDoc | undefined;
  testPrefix?: string;
  showVisible?: boolean;
}) {
  const fid = useId();
  const gs: PosterGroupStyle = doc?.groups?.[g] ?? {};
  const ms: PosterGroupStyle = member ? (doc?.members?.[g]?.[member] ?? {}) : {};
  const s: PosterGroupStyle = { ...gs, ...ms };
  const key = member ? `${g}/${member}` : g;
  const set = (k: string, patch: PosterGroupStyle) =>
    editPosterRun(
      `style ${key} ${k}`,
      member ? (d) => setMemberStyle(d, g, member, patch) : (d) => setGroupStyle(d, g, patch),
      'Style',
    );
  const has = (f: GroupField) => GROUP_FIELDS[g].includes(f);
  const r = resolvedOf(layout, g);
  const visible = s.visible ?? r.visible;
  const factor = (v: number | undefined) => Math.round((v ?? 1) * 100);
  const t = (id: string) => `${testPrefix}-${id}`;
  return (
    <>
      {showVisible && has('visible') && (
        <Switch
          label="Visible"
          checked={visible}
          testId={t('visible')}
          onChange={(v) => set('visible', { visible: v })}
        />
      )}
      <div className="look-grid">
        {has('size') && (
          <Slider
            label={r.kind === 'mark' ? 'Length' : 'Size'}
            min={r.kind === 'mark' ? 25 : 50}
            max={r.kind === 'mark' ? 400 : 300}
            step={5}
            value={factor(s.size)}
            text={pctText(factor(s.size))}
            testId={t('size')}
            onChange={(v) => set('size', { size: v === 100 ? undefined : v / 100 })}
          />
        )}
        {has('width') && (
          <Slider
            label="Width"
            min={25}
            max={400}
            step={5}
            value={factor(s.width)}
            text={pctText(factor(s.width))}
            testId={t('width')}
            onChange={(v) => set('width', { width: v === 100 ? undefined : v / 100 })}
          />
        )}
        {has('opacity') && (
          <Slider
            label="Opacity"
            min={0}
            max={100}
            step={1}
            value={Math.round((s.opacity ?? r.opacity) * 100)}
            text={pctText((s.opacity ?? r.opacity) * 100)}
            testId={t('opacity')}
            onChange={(v) => set('opacity', { opacity: v / 100 })}
          />
        )}
        {has('colour') && (
          <Swatch
            label="Colour"
            value={hex(s.colour ?? r.colour)}
            set={!!s.colour}
            {...(r.kind === 'mark' && !s.colour ? { hint: 'each line’s own' } : {})}
            testId={t('colour')}
            onChange={(c) => set('colour', { colour: c ?? undefined })}
          />
        )}
        {has('offset') && (
          <Slider
            label="Offset"
            min={0}
            max={400}
            step={5}
            value={factor(s.offset)}
            text={pctText(factor(s.offset))}
            testId={t('offset')}
            onChange={(v) => set('offset', { offset: v === 100 ? undefined : v / 100 })}
          />
        )}
      </div>
      {has('weight') && r.kind === 'label' && (
        <Radios
          legend="Weight"
          name={`${fid}-weight`}
          value={s.weight ?? r.weight}
          options={LABEL_WEIGHTS}
          testId={t('weight')}
          onChange={(weight) => set('weight', { weight })}
        />
      )}
      {has('side') && r.kind === 'label' && SIDES[g as PosterLabelGroup] && (
        <Radios
          legend="Side"
          name={`${fid}-side`}
          value={s.side ?? r.side}
          options={SIDES[g as PosterLabelGroup] ?? []}
          testId={t('side')}
          onChange={(side) => set('side', { side })}
        />
      )}
      {has('along') && r.kind === 'label' && (
        <Radios
          legend="End of the line"
          name={`${fid}-along`}
          value={s.along ?? r.along}
          options={ALONG}
          testId={t('along')}
          onChange={(along) => set('along', { along })}
        />
      )}
      {has('dashed') && r.kind === 'line' && (
        <Switch
          label="Dashed"
          checked={s.dashed ?? r.dashed}
          testId={t('dashed')}
          onChange={(dashed) => set('dashed', { dashed })}
        />
      )}
      {has('extent') && r.kind === 'line' && (
        <Radios
          legend="Length"
          name={`${fid}-extent`}
          value={s.extent ?? r.extent}
          options={EXTENTS}
          testId={t('extent')}
          onChange={(extent) => set('extent', { extent })}
        />
      )}
    </>
  );
}

function GroupPanel({
  sel,
  layout,
  doc,
}: {
  sel: Extract<PosterSelection, { kind: 'group' | 'member' }>;
  layout: PosterLayout;
  doc: PosterDoc | undefined;
}) {
  const g = sel.group;
  const member = sel.kind === 'member' ? sel.member : null;
  const ms: PosterGroupStyle = member ? (doc?.members?.[g]?.[member] ?? {}) : {};
  return (
    <>
      <GroupStyleFields group={g} member={member} layout={layout} doc={doc} />
      {member ? (
        <button
          type="button"
          data-testid="sel-reset-member"
          disabled={Object.keys(ms).length === 0}
          onClick={() =>
            editPoster((d) => setMemberStyle(d, g, member, CLEAR_MEMBER), 'Reset to group')
          }
        >
          Reset to group
        </button>
      ) : (
        <small className="hud-sample">Applies to every one. Alt-click one to style it alone.</small>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Right panel additions: margins, labels and lines
// ---------------------------------------------------------------------------------------------

const MARGIN_KEYS = ['top', 'right', 'bottom', 'left'] as const;

/** The four margins (linked by default), as % of the shorter side; drawn as guides. */
export function MarginsField({ disabled }: { disabled: boolean }) {
  const layout = useWorkspace((s) => s.layout);
  if (!layout) return null;
  const m = layout.settings.margins;
  const linked = m.linked !== false;
  const v = (x: number) => Math.round(x * 1000) / 10;
  const write = (next: typeof m) => {
    const same = MARGIN_KEYS.every((k) => Math.abs(next[k] - DEFAULT_MARGIN) < 1e-9);
    editPosterRun(
      'margins',
      (d) => setMargins(d, same && next.linked !== false ? undefined : next),
      'Margins',
    );
    useWorkspace.setState({ refit: true });
  };
  return (
    <fieldset className="field ws-margins-field" disabled={disabled} data-testid="poster-margins">
      <legend>Margins</legend>
      <Switch
        label="Same on every side"
        checked={linked}
        testId="margins-linked"
        onChange={(on) => write(on ? { ...m, linked: true } : { ...m, linked: false })}
      />
      <div className="look-grid">
        {linked ? (
          <Slider
            label="Margin"
            min={0}
            max={20}
            step={0.5}
            value={v(m.top)}
            text={`${v(m.top)} %`}
            testId="margin-all"
            onChange={(x) => write({ ...m, top: x / 100, linked: true })}
          />
        ) : (
          MARGIN_KEYS.map((k) => (
            <Slider
              key={k}
              label={k[0].toUpperCase() + k.slice(1)}
              min={0}
              max={20}
              step={0.5}
              value={v(m[k])}
              text={`${v(m[k])} %`}
              testId={`margin-${k}`}
              onChange={(x) => write({ ...m, [k]: x / 100, linked: false })}
            />
          ))
        )}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------------------------
// The tool row
// ---------------------------------------------------------------------------------------------

const TOOLS: readonly { id: WorkspaceTool; label: string; key: string }[] = [
  { id: 'select', label: 'Select', key: 'V' },
  { id: 'text', label: 'Text', key: 'T' },
];

const ALIGN_BUTTONS: readonly [AlignTo, string, string][] = [
  ['left', 'Align left', '⇤'],
  ['centre', 'Centre horizontally', '↔'],
  ['right', 'Align right', '⇥'],
  ['top', 'Align top', '⤒'],
  ['middle', 'Centre vertically', '↕'],
  ['bottom', 'Align bottom', '⤓'],
];

/**
 * Select and Text, align to the margins, snap guides, undo and redo, and the caret that brings
 * the Layers list up over the artboard (`drawer`: its element's id).
 */
export function ToolRow({ drawer }: { drawer?: string }) {
  const layersOpen = useWorkspace((s) => s.layersOpen);
  const tool = useWorkspace((s) => s.tool);
  const snap = useWorkspace((s) => s.snap);
  const sel = useWorkspace((s) => s.selected);
  const layout = useWorkspace((s) => s.layout);
  const canAlign = !!layout && resizable(sel) && selectionFrame(layout, sel) !== null;
  return (
    <div className="ws-tools" role="group" aria-label="Tools" data-testid="poster-tools">
      <div className="seg ws-tool-seg">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={tool === t.id}
            title={`${t.label} (${t.key})`}
            data-testid={`tool-${t.id}`}
            onClick={() => useWorkspace.setState({ tool: t.id })}
          >
            {t.label}
          </button>
        ))}
      </div>
      <QrButton />
      {tool === 'text' && (
        <span className="ws-tool-hint" role="status" data-testid="text-tool-hint">
          Click to place text · drag to set its width · Esc to cancel
        </span>
      )}
      <div className="seg ws-align" role="group" aria-label="Align to the margins">
        {ALIGN_BUTTONS.map(([k, label, glyph]) => (
          <button
            key={k}
            type="button"
            disabled={!canAlign}
            aria-label={label}
            title={canAlign ? `${label} (to the margins)` : `${label}: select a layer or text box`}
            data-testid={`align-${k}`}
            onClick={() => alignSelection(k)}
          >
            {glyph}
          </button>
        ))}
      </div>
      <Switch
        checked={snap}
        testId="tool-snap"
        label="Snap guides"
        hint="Alt while dragging: no snapping"
        onChange={(on) => useWorkspace.setState({ snap: on })}
      />
      <UndoRedo />
      {drawer && (
        <button
          type="button"
          className="ws-caret"
          aria-expanded={layersOpen}
          aria-controls={drawer}
          title={layersOpen ? 'Hide the layers' : 'Show the layers'}
          data-testid="layers-toggle"
          onClick={() => setLayersOpen(!layersOpen)}
        >
          Layers <span aria-hidden="true">{layersOpen ? '˅' : '˄'}</span>
        </button>
      )}
    </div>
  );
}

/**
 * The watch link's length a QR code would hold for the piece (null while it is measured), a
 * moment after the piece last changed. With a code, the code's own link.
 */
function useQrLinkLength(): number | null {
  const piece = usePlayer((s) => s.piece);
  const layout = useWorkspace((s) => s.layout);
  const own = layout ? qrObject(layout) : undefined;
  const [len, setLen] = useState<{ of: unknown; n: number } | null>(null);
  useEffect(() => {
    if (piece.poster?.qr) return;
    let live = true;
    const t = setTimeout(() => {
      qrLinkLength(piece).then(
        (n) => live && setLen({ of: piece, n }),
        () => undefined,
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [piece]);
  if (own?.link) return own.link.length;
  return len ? len.n : null;
}

/**
 * Adds the QR code (M17), or selects it. Disabled while the watch link is too long for a code
 * that scans easily, saying how long it is.
 */
function QrButton() {
  const has = usePlayer((s) => s.piece.poster?.qr !== undefined);
  const n = useQrLinkLength();
  const long = !has && n !== null && n > QR_MAX_CHARS;
  const why = long
    ? `The watch link is ${n.toLocaleString('en')} characters; a QR code that scans easily holds ${QR_MAX_CHARS.toLocaleString('en')}`
    : null;
  return (
    <>
      <button
        type="button"
        className="ws-qr-add"
        disabled={long || (!has && n === null)}
        aria-describedby={long ? 'qr-too-long' : undefined}
        title={
          why ??
          (has
            ? 'Select the QR code'
            : 'Add a QR code that opens the piece to watch (point a phone at the poster)')
        }
        data-testid="tool-qr"
        onClick={addQrCode}
      >
        QR code
      </button>
      {long && (
        <span className="ws-tool-hint" id="qr-too-long" role="status" data-testid="qr-too-long">
          Link too long for a QR code: {n.toLocaleString('en')} of{' '}
          {QR_MAX_CHARS.toLocaleString('en')} characters
        </span>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// The layers list
// ---------------------------------------------------------------------------------------------

/** A show/hide toggle; `mixed` (shown in some rows): a click shows it everywhere. */
function Eye({
  shown,
  mixed = false,
  name,
  testId,
  onChange,
}: {
  shown: boolean;
  mixed?: boolean;
  name: string;
  testId: string;
  onChange: (shown: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      className="ws-eye"
      aria-checked={mixed ? 'mixed' : shown}
      aria-label={`Show ${name}`}
      data-testid={testId}
      onClick={() => onChange(mixed || !shown)}
    >
      {mixed ? (
        <>
          <span aria-hidden="true">◐</span> Some rows
        </>
      ) : shown ? (
        'Shown'
      ) : (
        'Hidden'
      )}
    </button>
  );
}

function Row({
  name,
  meta,
  on,
  testId,
  data,
  onSelect,
  children,
  lead,
}: {
  name: string;
  meta?: string;
  on: boolean;
  testId: string;
  data?: Record<string, string>;
  onSelect: () => void;
  children?: React.ReactNode;
  lead?: React.ReactNode;
}) {
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(data ?? {})) attrs[`data-${k}`] = v;
  return (
    <span className={on ? 'ws-layer-row on' : 'ws-layer-row'} data-testid={testId} {...attrs}>
      {lead}
      <button type="button" className="ws-layer-name" aria-pressed={on} onClick={onSelect}>
        {name}
      </button>
      {meta && <small>{meta}</small>}
      {children}
    </span>
  );
}

/** What's on the poster: text boxes, the music's parts (lines expandable), labels and lines. */
export function LayersList() {
  const voices = usePlayer((s) => s.piece.voices);
  const doc = usePlayer((s) => s.piece.poster);
  const expanded = useWorkspace((s) => s.expanded);
  const rowsOpen = useWorkspace((s) => s.rowsOpen);
  const sel = useWorkspace((s) => s.selected);
  const layout = useWorkspace((s) => s.layout);
  const parts = posterLayers({ voices });
  // Part layers in drawing order (back to front), as the layout ordered them.
  const order = layout
    ? layout.layers.filter((l) => l.kind === 'part').map((l) => l.id)
    : parts.map((p) => `part:${p.part}`);
  const byId = new Map(parts.map((p) => [`part:${p.part}`, p]));
  const ordered = order.map((id) => byId.get(id)).filter((p) => p !== undefined);
  for (const p of parts) if (!ordered.includes(p)) ordered.push(p);
  const isSel = (s: PosterSelection) => JSON.stringify(s) === JSON.stringify(sel);
  const entry = (id: string) => doc?.layers?.find((l) => l.id === id);
  const toggle = (part: string) =>
    useWorkspace.setState({
      expanded: expanded.includes(part) ? expanded.filter((p) => p !== part) : [...expanded, part],
    });
  const move = (i: number, by: number) => {
    const ids = ordered.map((p) => `part:${p.part}`);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    editPoster((d) => setLayerOrder(d, ids), 'Reorder layers');
  };
  const hide = (id: string, shown: boolean) =>
    editPoster(
      (d) => setLayer(d, id, { hidden: shown ? undefined : true, hiddenRows: undefined }),
      shown ? 'Show' : 'Hide',
    );
  const toggleRows = (part: string) =>
    useWorkspace.setState({
      rowsOpen: rowsOpen.includes(part) ? rowsOpen.filter((p) => p !== part) : [...rowsOpen, part],
    });
  const groupShown = (g: PosterGroup) => (layout ? groupVisible(layout, g) : false);

  return (
    <div className="ws-layers" aria-label="Layers" data-testid="poster-layers">
      <h4 className="ws-layers-head">Text</h4>
      <ul>
        {textsOf(doc).map((t) => {
          const s: PosterSelection = { kind: 'text', id: t.id };
          return (
            <li key={t.id} className="ws-layer" data-testid="layer-text" data-id={t.id}>
              <Row
                name={textName(t)}
                meta={t.box ? 'placed' : 'auto'}
                on={isSel(s)}
                testId="layer-text-row"
                onSelect={() => select(s)}
              >
                <Eye
                  shown={!t.hidden}
                  name={textName(t)}
                  testId="layer-eye"
                  onChange={(shown) =>
                    editPoster(
                      (d) => {
                        const cur = textOf(d, t.id);
                        if (!cur) return d;
                        const { hidden: _h, ...rest } = cur;
                        return putText(d, shown ? rest : { ...rest, hidden: true });
                      },
                      shown ? 'Show' : 'Hide',
                    )
                  }
                />
              </Row>
            </li>
          );
        })}
        {doc?.qr && (
          <li className="ws-layer" data-testid="layer-qr">
            <Row
              name="QR code"
              meta={doc.qr.box ? 'placed' : 'auto'}
              on={isSel({ kind: 'qr' })}
              testId="layer-qr-row"
              onSelect={() => select({ kind: 'qr' })}
            />
          </li>
        )}
      </ul>
      <h4 className="ws-layers-head">Music</h4>
      <ul>
        {ordered.map((l, i) => {
          const id = `part:${l.part}`;
          const open = expanded.includes(l.part);
          const listId = `layer-lines-${l.part || 'lines'}`;
          const s: PosterSelection = { kind: 'layer', id };
          const st = layout ? layerRowsState(layout, entry(id)) : null;
          const mixed = st?.state === 'mixed';
          const rowsShown = mixed && rowsOpen.includes(l.part);
          const rowsId = `layer-rows-${l.part || 'lines'}`;
          return (
            <li key={l.part} className="ws-layer" data-testid="layer-part" data-part={l.part}>
              <Row
                name={l.label}
                meta={`${l.part === '' ? '' : 'part · '}${linesText(l.lines.length)}`}
                on={isSel(s)}
                testId="layer-part-row"
                onSelect={() => select(s)}
                lead={
                  <button
                    type="button"
                    className="ws-layer-toggle"
                    aria-expanded={open}
                    aria-controls={open ? listId : undefined}
                    aria-label={`${open ? 'Hide' : 'Show'} the lines of ${l.label}`}
                    onClick={() => toggle(l.part)}
                  >
                    <span aria-hidden="true">{open ? '▾' : '▸'}</span>
                  </button>
                }
              >
                <Eye
                  shown={entry(id)?.hidden !== true}
                  mixed={mixed}
                  name={l.label}
                  testId="layer-eye"
                  onChange={(shown) => hide(id, shown)}
                />
                {mixed && (
                  <button
                    type="button"
                    className="ws-rows-toggle"
                    aria-expanded={rowsShown}
                    aria-controls={rowsShown ? rowsId : undefined}
                    aria-label={`${rowsShown ? 'Hide' : 'Show'} the rows of ${l.label}`}
                    data-testid="layer-rows-toggle"
                    onClick={() => toggleRows(l.part)}
                  >
                    <span aria-hidden="true">{rowsShown ? '▾' : '▸'}</span>
                  </button>
                )}
                <button
                  type="button"
                  className="ws-order"
                  aria-label={`Move ${l.label} back`}
                  data-testid="layer-back"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="ws-order"
                  aria-label={`Move ${l.label} forward`}
                  data-testid="layer-forward"
                  disabled={i === ordered.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
              </Row>
              {rowsShown && layout && st && (
                <ul id={rowsId} className="ws-layer-lines" aria-label={`${l.label} by row`}>
                  {layout.rows.map((r) => {
                    const name = rowName(layout, r.index);
                    return (
                      <li key={r.key} data-testid="layer-row" data-row={r.key}>
                        <span className="ws-layer-row">
                          <span className="ws-layer-name">{name}</span>
                          <Eye
                            shown={st.rows[r.index]}
                            name={`${l.label} in ${name}`}
                            testId="layer-row-eye"
                            onChange={(shown) => hideInRow(layout, id, r.index, !shown)}
                          />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              {open && (
                <ul id={listId} className="ws-layer-lines">
                  {l.lines.map((v) => {
                    const lid = `line:${v.id}`;
                    const ls: PosterSelection = { kind: 'layer', id: lid };
                    return (
                      <li key={v.id} data-testid="layer-line" data-id={v.id}>
                        <Row
                          name={v.label}
                          on={isSel(ls)}
                          testId="layer-line-row"
                          onSelect={() => select(ls)}
                        >
                          <Eye
                            shown={entry(lid)?.hidden !== true}
                            name={v.label}
                            testId="layer-eye"
                            onChange={(shown) => hide(lid, shown)}
                          />
                        </Row>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {(
        [
          ['Labels', LABEL_GROUPS],
          ['Lines', LINE_GROUPS],
          ['Marks', MARK_GROUPS],
        ] as const
      ).map(([head, groups]) => (
        <div key={head}>
          <h4 className="ws-layers-head">{head}</h4>
          <ul>
            {groups.map((g: PosterGroup) => {
              const s: PosterSelection = { kind: 'group', group: g };
              const shown = groupShown(g);
              return (
                <li key={g} className="ws-layer" data-testid="layer-group" data-group={g}>
                  <Row
                    name={GROUP_NAMES[g]}
                    on={isSel(s)}
                    testId="layer-group-row"
                    onSelect={() => select(s)}
                  >
                    <Eye
                      shown={shown}
                      name={GROUP_NAMES[g]}
                      testId="layer-eye"
                      onChange={(on) =>
                        editPoster(
                          (d) => setGroupStyle(d, g, { visible: on }),
                          on ? 'Show' : 'Hide',
                        )
                      }
                    />
                  </Row>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
