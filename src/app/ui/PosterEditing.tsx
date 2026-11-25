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
 * - Keys (nothing typed into): arrows nudge (Shift: ten times), Delete removes a text box or
 *   hides the rest, Enter edits a text box, V / T pick the tool. Escape clears the selection.
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
  removeText,
  resizeBox,
  setGroupStyle,
  setLayer,
  setLayerOrder,
  setLayerRow,
  setMargins,
  setMemberStyle,
  setRowBox,
  textsOf,
  type Handle,
} from '../../render/poster-edit';
import {
  DEFAULT_MARGIN,
  LABEL_GROUPS,
  GROUP_FIELDS,
  LINE_GROUPS,
  MARK_GROUPS,
  isLabelGroup,
  isMarkGroup,
  type GroupField,
  type PosterLayout,
  type Rect,
} from '../../render/poster-layout';
import {
  CLEAR_MEMBER,
  GROUP_NAMES,
  alignBox,
  nudgeDoc,
  placeRect,
  resizable,
  selectedBoxes,
  selectionAt,
  selectionFrame,
  snapMove,
  snapResize,
  snapTargets,
  textName,
  textOf,
  textSizeOf,
  withTextSize,
  type AlignTo,
  type PosterSelection,
} from '../poster-select';
import {
  editPoster,
  editPosterEntry,
  editPosterJoin,
  editPosterRun,
  posterGesture,
  type PosterGesture,
} from '../poster-sync';
import { linesText, posterLayers, useWorkspace, type WorkspaceTool } from '../poster-workspace';
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

/** Delete: removes a text box; hides a layer, a group or one member. */
export function deleteSelection(): void {
  const sel = useWorkspace.getState().selected;
  if (!sel) return;
  if (sel.kind === 'text') {
    editPoster((d) => removeText(d, sel.id), 'Remove text box');
    select(null);
  } else if (sel.kind === 'layer') {
    editPoster((d) => setLayer(d, sel.id, { hidden: true }), 'Hide layer');
  } else if (sel.kind === 'row') {
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

/** The text box the Text tool just added and its undo entry: its first text joins that entry. */
let added: { id: string; entry: object } | null = null;

/** The Text tool: a new text box with its top left at (x, y), edited in place. */
export function addTextAt(layout: PosterLayout, x: number, y: number): void {
  const doc = docNow();
  const id = newTextId(doc);
  const S = Math.min(layout.width, layout.height);
  const w = Math.min(0.4 * layout.width, layout.width - x);
  const h = 0.03 * S * 1.2;
  const text: PosterText = {
    id,
    kind: 'free',
    text: 'Text',
    box: {
      x: x / layout.width,
      y: Math.min(y, layout.height - h) / layout.height,
      w: Math.max(1, w) / layout.width,
      h: h / layout.height,
    },
  };
  const entry = editPosterEntry((d) => putText(d, text), 'Add text box');
  if (entry) {
    added = { id, entry };
    useWorkspace.setState({ selected: { kind: 'text', id }, tool: 'select', editing: id });
  }
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
  x0: number;
  y0: number;
  started: boolean;
  gesture: PosterGesture | null;
  last: { x: number; y: number; shift: boolean; alt: boolean } | null;
  raf: number;
}

/**
 * Over the artboard's canvas, in the poster's own coordinates as percentages: the margins as
 * guides (not exported), the selection's outlines and handles, snap guides while dragging, and
 * the text box being edited. It takes the pointer for selecting, moving and resizing.
 */
export function ArtboardOverlay({ width }: { width: number }) {
  const layout = useWorkspace((s) => s.layout);
  const selected = useWorkspace((s) => s.selected);
  const tool = useWorkspace((s) => s.tool);
  const guides = useWorkspace((s) => s.guides);
  const editing = useWorkspace((s) => s.editing);
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);

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
        const s = snapMove(to, snapTargets(d.layout, d.sel), tol);
        to = s.box;
        g = s.guides;
      }
    } else {
      let delta = { dx, dy };
      if (snapOn) {
        const s = snapResize(d.frame, d.handle!, delta, snapTargets(d.layout, d.sel), tol);
        delta = s;
        g = s.guides;
      }
      to = resizeBox(d.frame, d.handle!, delta, {
        shift: p.shift,
        alt: p.alt,
        min: 4 * d.layout.unit,
      });
    }
    useWorkspace.setState({ guides: g && (g.x !== undefined || g.y !== undefined) ? g : null });
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

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    root.current?.closest<HTMLElement>('[data-testid="poster-workspace"]')?.focus({
      preventScroll: true,
    });
    const p = board(e);
    if (useWorkspace.getState().tool === 'text') {
      addTextAt(layout, p.x, p.y);
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
      x0: p.x,
      y0: p.y,
      started: false,
      gesture: null,
      last: null,
      raf: 0,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const p = board(e);
    if (!d.started) {
      if (Math.hypot(p.x - d.x0, p.y - d.y0) * scale < DRAG_CSS) return;
      d.started = true;
      d.gesture = posterGesture(d.kind === 'move' ? 'Move' : 'Resize');
    }
    d.last = { x: p.x, y: p.y, shift: e.shiftKey, alt: e.altKey };
    if (!d.raf) d.raf = requestAnimationFrame(() => apply(d));
  };

  const boxes = selectedBoxes(layout, selected);
  const frame = resizable(selected) ? selectionFrame(layout, selected) : null;
  const c = layout.content;
  return (
    <div
      ref={root}
      className={tool === 'text' ? 'ws-overlay text-tool' : 'ws-overlay'}
      data-testid="artboard-overlay"
      data-width={W}
      data-height={H}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
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
      {frame &&
        HANDLES.map((h) => (
          <div
            key={h}
            className={`ws-handle ws-handle-${h}`}
            data-handle={h}
            data-testid={`handle-${h}`}
            style={{
              left: `${((frame.x + (h.includes('w') ? 0 : h.includes('e') ? frame.w : frame.w / 2)) / W) * 100}%`,
              top: `${((frame.y + (h.includes('n') ? 0 : h.includes('s') ? frame.h : frame.h / 2)) / H) * 100}%`,
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
      {editing && <InlineText key={editing} id={editing} layout={layout} scale={scale} />}
    </div>
  );
}

/** A text box edited in place: Enter (or leaving it) keeps the text, Escape drops the change. */
function InlineText({ id, layout, scale }: { id: string; layout: PosterLayout; scale: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const t = textOf(docNow(), id);
  const o = layout.objects.find((x) => x.type === 'text' && x.member === id);
  const done = useRef(false);
  // A new text box shows once the artboard has drawn it: focus it then.
  const ready = !!t && o?.type === 'text';
  useLayoutEffect(() => {
    if (!ready) return;
    ref.current?.focus();
    ref.current?.select();
  }, [ready]);
  if (!t || !o || o.type !== 'text') return null;
  const W = layout.width;
  const H = layout.height;
  const f = o.frame;
  const commit = (text: string) => {
    if (done.current) return;
    done.current = true;
    const join = added?.id === id ? added.entry : null;
    added = null;
    if (text !== t.text) {
      editPosterJoin(
        join,
        (d) => {
          const cur = textOf(d, id);
          return cur ? putText(d, { ...cur, text }) : d;
        },
        join ? 'Add text box' : 'Edit text',
      );
    }
    useWorkspace.setState({ editing: null });
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      commit(e.currentTarget.value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      done.current = true;
      added = null;
      useWorkspace.setState({ editing: null });
    }
  };
  return (
    <textarea
      ref={ref}
      className="ws-inline-text"
      data-testid="inline-text"
      aria-label="Text"
      defaultValue={t.text}
      spellCheck={false}
      style={{
        left: `${(f.x / W) * 100}%`,
        top: `${(f.y / H) * 100}%`,
        width: `${(Math.max(f.w, o.size * 4) / W) * 100}%`,
        minHeight: `${(f.h / H) * 100}%`,
        font: o.font.replace(/[\d.]+px/, `${Math.max(8, o.size * scale)}px`),
        lineHeight: 1.2,
        textAlign: o.align,
      }}
      onPointerDown={(e) => e.stopPropagation()}
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
  if (!sel || !layout) return <>{children}</>;
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
  return (
    <>
      {sel.row !== undefined && <small className="hud-sample">Style applies in every row.</small>}
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
      <Switch
        label="Hidden"
        checked={hidden}
        testId="sel-hidden"
        onChange={(v) =>
          editPoster((d) => setLayer(d, sel.id, { hidden: v || undefined }), v ? 'Hide' : 'Show')
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
          value={t.text}
          spellCheck={false}
          data-testid="sel-text"
          onChange={(e) => {
            const text = e.target.value;
            put('text', (cur) => ({ ...cur, text }), 'Edit text');
          }}
        />
      </label>
      <small className="hud-sample">
        Tokens: <code>{'{name}'}</code> <code>{'{key}'}</code> <code>{'{length}'}</code>
      </small>
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

/** Select and Text, align to the margins, snap guides, undo and redo. */
export function ToolRow() {
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
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The layers list
// ---------------------------------------------------------------------------------------------

function Eye({
  shown,
  name,
  testId,
  onChange,
}: {
  shown: boolean;
  name: string;
  testId: string;
  onChange: (shown: boolean) => void;
}) {
  return (
    <button
      type="button"
      className="ws-eye"
      aria-pressed={shown}
      aria-label={shown ? `Hide ${name}` : `Show ${name}`}
      data-testid={testId}
      onClick={() => onChange(!shown)}
    >
      {shown ? 'Shown' : 'Hidden'}
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
      (d) => setLayer(d, id, { hidden: shown ? undefined : true }),
      shown ? 'Show' : 'Hide',
    );
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
      </ul>
      <h4 className="ws-layers-head">Music</h4>
      <ul>
        {ordered.map((l, i) => {
          const id = `part:${l.part}`;
          const open = expanded.includes(l.part);
          const listId = `layer-lines-${l.part || 'lines'}`;
          const s: PosterSelection = { kind: 'layer', id };
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
                  name={l.label}
                  testId="layer-eye"
                  onChange={(shown) => hide(id, shown)}
                />
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
