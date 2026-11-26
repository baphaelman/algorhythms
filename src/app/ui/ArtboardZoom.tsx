/**
 * The poster artboard's zoom and pan (owner, poster notes round 3, items 5 and 7): ⌘/Ctrl-wheel
 * and pinch zoom at the pointer; plain scroll pans a page larger than the box (Shift-wheel
 * sideways); Space-drag or a middle-button drag pans; ⇧1 fits, ⇧0 is 100 %, ⌘+ / ⌘− step; a
 * click on the gray area deselects. The view is view state (../artboard-view), never the piece's.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  clampView,
  fitView,
  panBy,
  stepZoom,
  zoomAt,
  zoomText,
  type ArtboardView,
  type Poster,
  type Size,
} from '../artboard-view';
import { takesText } from '../editor/shortcuts';
import { spaceHold } from '../space-key';
import { useWorkspace } from '../poster-workspace';
import { wheelIntent } from '../wheel';

/** A press on the gray area moves less than this (CSS px) to count as a click. */
const CLICK_CSS = 4;

export interface ArtboardZoom {
  view: ArtboardView;
  /** Zoom around the box's centre (`'fit'`, a zoom, or a step in/out). */
  zoomTo: (to: 'fit' | number | 'in' | 'out') => void;
  /** Space is held: the cursor grabs. */
  grab: boolean;
  /** A pan drag is under way. */
  panning: boolean;
}

/**
 * The artboard's view, with its input on `box` (the gray area) and the document's keys.
 * `section` is the artboard: ⌘+ / ⌘− zoom it while the pointer or focus is on it.
 */
export function useArtboardZoom(
  box: RefObject<HTMLDivElement | null>,
  section: RefObject<HTMLElement | null>,
  avail: Size,
  poster: Poster,
): ArtboardZoom {
  const [raw, setRaw] = useState<ArtboardView>(() => fitView(avail, poster));
  const [grab, setGrab] = useState(false);
  const [panning, setPanning] = useState(false);
  const view = clampView(raw, avail, poster);
  const now = useRef({ view, avail, poster });
  useLayoutEffect(() => {
    now.current = { view, avail, poster };
  });

  // The handlers read the latest view and set the next one from it.
  const set = useCallback((f: (v: ArtboardView, box: Size, poster: Poster) => ArtboardView) => {
    const n = now.current;
    const next = clampView(f(n.view, n.avail, n.poster), n.avail, n.poster);
    now.current = { ...n, view: next };
    setRaw(next);
  }, []);

  const zoomTo = useCallback(
    (to: 'fit' | number | 'in' | 'out') =>
      set((v, b, p) => {
        if (to === 'fit') return fitView(b, p);
        const z = to === 'in' || to === 'out' ? stepZoom(v.zoom, to === 'in' ? 1 : -1, b, p) : to;
        return zoomAt(v, z, b, p);
      }),
    [set],
  );

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const local = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    let gesture: { zoom: number } | null = null;

    const onWheel = (e: WheelEvent) => {
      const w = wheelIntent(e);
      if (w.kind === 'zoom') {
        // Alt-wheel is the editor's; here only ⌘/Ctrl (and a pinch, which comes as Ctrl).
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        if (gesture) return;
        const at = local(e);
        set((v, b, p) => zoomAt(v, v.zoom / w.factor, b, p, at));
        return;
      }
      const { view: v, avail: b, poster: p } = now.current;
      // A poster that fits keeps the browser's scroll (the stacked layout scrolls past it).
      if (!(p.width * v.zoom > b.w + 0.5 || p.height * v.zoom > b.h + 0.5)) return;
      const unit = e.deltaMode === 1 ? 16 : 1;
      let dx = e.deltaX * unit;
      let dy = e.deltaY * unit;
      if (e.shiftKey && dx === 0) [dx, dy] = [dy, 0];
      if (dx === 0 && dy === 0) return;
      e.preventDefault();
      set((v1, b1, p1) => panBy(v1, -dx, -dy, b1, p1));
    };

    // Safari's pinch.
    type Gesture = Event & { scale: number; clientX: number; clientY: number };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      gesture = { zoom: now.current.view.zoom };
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      if (!gesture) return;
      const g = e as Gesture;
      const at = local(g);
      const z = gesture.zoom * g.scale;
      set((v, b, p) => zoomAt(v, z, b, p, at));
    };
    const onGestureEnd = (e: Event) => {
      e.preventDefault();
      gesture = null;
    };

    // Space-drag and middle-drag pan (before the overlay sees the press); a click on the gray
    // area deselects.
    let pan: { id: number; x: number; y: number } | null = null;
    let press: { id: number; x: number; y: number; moved: boolean } | null = null;
    const onDownCapture = (e: PointerEvent) => {
      if (!(e.button === 1 || (e.button === 0 && spaceHold.down))) return;
      e.preventDefault();
      e.stopPropagation();
      pan = { id: e.pointerId, x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
      setPanning(true);
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || pan) return;
      if ((e.target as Element | null)?.closest?.('.artboard-page')) return;
      e.preventDefault();
      el.closest<HTMLElement>('[data-testid="poster-workspace"]')?.focus({ preventScroll: true });
      press = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    };
    const onMove = (e: PointerEvent) => {
      if (pan && e.pointerId === pan.id) {
        const dx = e.clientX - pan.x;
        const dy = e.clientY - pan.y;
        pan.x = e.clientX;
        pan.y = e.clientY;
        if (dx === 0 && dy === 0) return;
        if (spaceHold.down) spaceHold.panned = true;
        set((v, b, p) => panBy(v, dx, dy, b, p));
        return;
      }
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) >= CLICK_CSS) {
        press.moved = true;
      }
    };
    const onUp = (e: PointerEvent) => {
      if (pan && e.pointerId === pan.id) {
        pan = null;
        setPanning(false);
        return;
      }
      const p = press;
      press = null;
      if (p && p.id === e.pointerId && !p.moved) {
        useWorkspace.setState({ selected: null, editing: null });
      }
    };
    const onCancel = () => {
      pan = null;
      press = null;
      setPanning(false);
    };
    // A middle click would paste or open links on some systems.
    const onAux = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart);
    el.addEventListener('gesturechange', onGestureChange);
    el.addEventListener('gestureend', onGestureEnd);
    el.addEventListener('pointerdown', onDownCapture, true);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('auxclick', onAux);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart);
      el.removeEventListener('gesturechange', onGestureChange);
      el.removeEventListener('gestureend', onGestureEnd);
      el.removeEventListener('pointerdown', onDownCapture, true);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.removeEventListener('auxclick', onAux);
    };
  }, [box, set]);

  useEffect(() => {
    let over = false;
    const sec = section.current;
    const enter = () => (over = true);
    const leave = () => (over = false);
    sec?.addEventListener('pointerenter', enter);
    sec?.addEventListener('pointerleave', leave);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || takesText(e.target)) return;
      if (document.querySelector('dialog[open]')) return;
      const cmd = e.metaKey || e.ctrlKey;
      if (cmd && !e.altKey) {
        const k = e.key;
        const dir = k === '=' || k === '+' ? 'in' : k === '-' || k === '_' ? 'out' : null;
        if (!dir) return;
        const a = document.activeElement;
        const focused =
          !!a &&
          (a === document.body ||
            (sec?.contains(a) ?? false) ||
            a === sec?.closest('[data-testid="poster-workspace"]'));
        if (!over && !focused) return;
        // Not the browser's own zoom.
        e.preventDefault();
        zoomTo(dir);
        return;
      }
      if (cmd || e.altKey || !e.shiftKey) return;
      if (e.code === 'Digit1') zoomTo('fit');
      else if (e.code === 'Digit0') zoomTo(1);
      else return;
      e.preventDefault();
    };
    // Space held shows the grab cursor.
    const onSpace = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      queueMicrotask(() => setGrab(spaceHold.down));
    };
    const onBlur = () => setGrab(false);
    document.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onSpace, true);
    window.addEventListener('keyup', onSpace, true);
    window.addEventListener('blur', onBlur);
    return () => {
      sec?.removeEventListener('pointerenter', enter);
      sec?.removeEventListener('pointerleave', leave);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onSpace, true);
      window.removeEventListener('keyup', onSpace, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [section, zoomTo]);

  return { view, zoomTo, grab, panning };
}

const MENU: readonly { label: string; keys?: string; to: 'fit' | number | 'in' | 'out' }[] = [
  { label: 'Zoom in', keys: '⌘+', to: 'in' },
  { label: 'Zoom out', keys: '⌘−', to: 'out' },
  { label: 'Zoom to fit', keys: '⇧1', to: 'fit' },
  { label: '50 %', to: 0.5 },
  { label: '100 %', keys: '⇧0', to: 1 },
  { label: '200 %', to: 2 },
];

/** The zoom readout ("64 %") in the artboard's corner; it opens the zoom menu. */
export function ZoomReadout({ zoom, zoomTo }: Pick<ArtboardZoom, 'zoomTo'> & { zoom: number }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    if (open) first.current?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus({ preventScroll: true });
  };
  return (
    <div className="ws-zoom" ref={root}>
      <button
        ref={button}
        type="button"
        className="ws-zoom-readout"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Zoom ${zoomText(zoom)}`}
        data-testid="zoom-readout"
        onClick={() => setOpen((o) => !o)}
      >
        {zoomText(zoom)}
      </button>
      {open && (
        <div
          className="ws-zoom-menu"
          role="menu"
          aria-label="Zoom"
          data-testid="zoom-menu"
          onKeyDown={(e) => {
            const items = [
              ...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []),
            ];
            const at = items.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === 'Escape') close();
            else if (e.key === 'ArrowDown') items[(at + 1) % items.length]?.focus();
            else if (e.key === 'ArrowUp') items[(at - 1 + items.length) % items.length]?.focus();
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          {MENU.map((m, i) => (
            <button
              key={m.label}
              ref={i === 0 ? first : undefined}
              type="button"
              role="menuitem"
              data-testid={`zoom-menu-${typeof m.to === 'number' ? Math.round(m.to * 100) : m.to}`}
              onClick={() => {
                zoomTo(m.to);
                close();
              }}
            >
              <span>{m.label}</span>
              {m.keys && <kbd>{m.keys}</kbd>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
