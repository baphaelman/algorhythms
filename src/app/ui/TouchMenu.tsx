/**
 * The long-press menu for touch editing (PLAN.md §11.3b), opened by ../touch `openTouchMenu` from
 * the lane or the score: Duplicate, Delete and Copy on the pressed moment (the whole selection
 * when it holds it), Paste at the playhead, and the latched modifiers that replace Alt and Shift
 * (Snap, "Ends set stagger", Select more). While a modifier is latched, a chip shows it; tapping
 * the chip turns it off.
 *
 * The menu opens under a finger that is still down, so an item reacts only to a press that
 * started on the menu (or to the keyboard), never to that finger's release.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MomentId } from '../../core/types';
import { announce, momentsText } from '../announce';
import { copySelection, hasClip, pasteHere } from '../clipboard';
import { deleteMoments, duplicateMoments } from '../editor/actions';
import { select, useEditor } from '../editor/history';
import { endEditOf } from '../editor/lane';
import { isPieceKey } from '../editor/piece-key';
import { beatStep } from '../editor/snap';
import { usePlayer } from '../store';
import { closeTouchMenu, setTouchMod, useTouchMenu, useTouchMods, type TouchMods } from '../touch';
import './touch.css';

/** Gap (px) between the finger and the menu. */
const OFFSET = 14;

/** The moments the menu acts on: the selection when it holds `id`, else `id`. */
function targetsOf(id: MomentId): MomentId[] {
  const sel = useEditor.getState().selection.filter((x) => !isPieceKey(x));
  return sel.includes(id) ? sel : [id];
}

/**
 * Duplicates `ids` just after their spans end (at least a beat, or 1 s, later), like an Alt-drag
 * without the drag; the copies are selected.
 */
function duplicateAfter(ids: readonly MomentId[]): MomentId[] {
  const { piece, compiled } = usePlayer.getState();
  const ms = piece.moments.filter((m) => ids.includes(m.id));
  if (ms.length === 0) return [];
  const start = Math.min(...ms.map((m) => m.at));
  const end = Math.max(
    ...ms.map((m) => Math.max(m.at, compiled.momentSpans.find((s) => s.id === m.id)?.end ?? m.at)),
  );
  return duplicateMoments(ids, Math.max(end - start, beatStep(piece.view) ?? 1));
}

const CHIPS: readonly [keyof TouchMods, string][] = [
  ['free', 'Snap off'],
  ['stagger', 'Ends set stagger'],
  ['add', 'Select more'],
];

export function TouchMenu() {
  const at = useTouchMenu((s) => s.at);
  const mods = useTouchMods();
  const box = useRef<HTMLDivElement>(null);
  const armed = useRef(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Beside the finger, inside the window.
  useLayoutEffect(() => {
    armed.current = false;
    const el = box.current;
    if (!at || !el) {
      setPos(null);
      return;
    }
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = at.x + OFFSET;
    if (left + w > window.innerWidth - 8) left = Math.max(8, at.x - OFFSET - w);
    let top = at.y - h / 2;
    top = Math.min(Math.max(8, top), Math.max(8, window.innerHeight - h - 8));
    setPos({ left, top });
  }, [at]);

  useEffect(() => {
    if (!at) return;
    const outside = (e: PointerEvent): void => {
      if (!(e.target instanceof Node) || !box.current?.contains(e.target)) closeTouchMenu();
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      closeTouchMenu();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
    };
  }, [at]);

  const on = Object.values(mods).some(Boolean);
  const chips = on && (
    <div className="touch-mods" role="group" aria-label="Touch modifiers" data-testid="touch-mods">
      {CHIPS.filter(([k]) => mods[k]).map(([k, label]) => (
        <button
          key={k}
          type="button"
          data-mod={k}
          title={`${label}: tap to turn off`}
          onClick={() => setTouchMod(k, false)}
        >
          {label} <span aria-hidden="true">×</span>
        </button>
      ))}
    </div>
  );
  if (!at) return chips || null;

  const id = at.id;
  const moment =
    id && !isPieceKey(id) ? usePlayer.getState().piece.moments.find((m) => m.id === id) : undefined;
  const stagger = !moment || endEditOf(moment.type) === 'glide';
  /** Runs `fn` for a press that began on the menu, or a keyboard click (detail 0). */
  const act =
    (fn: () => void) =>
    (e: React.MouseEvent): void => {
      if (!armed.current && e.detail !== 0) return;
      closeTouchMenu();
      fn();
    };
  const toggle = (k: keyof TouchMods, label: string, checked: boolean) => (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      data-testid={`touch-${k}`}
      onClick={act(() => {
        setTouchMod(k, k === 'free' ? checked : !checked);
        announce(`${label} ${checked ? 'off' : 'on'}`);
      })}
    >
      <span className="touch-check" aria-hidden="true">
        {checked ? '✓' : ''}
      </span>
      {label}
    </button>
  );

  return (
    <>
      {chips}
      <div
        ref={box}
        className="touch-menu"
        role="menu"
        aria-label={moment ? `${moment.label?.trim() || moment.type} moment` : 'Editing'}
        data-testid="touch-menu"
        style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}
        onPointerDown={() => {
          armed.current = true;
        }}
        onTouchStart={() => {
          armed.current = true;
        }}
        onMouseDown={() => {
          armed.current = true;
        }}
      >
        {moment && (
          <>
            <button
              type="button"
              role="menuitem"
              data-testid="touch-duplicate"
              onClick={act(() => {
                const ids = duplicateAfter(targetsOf(moment.id));
                announce(`Duplicated ${momentsText(ids.length)}`);
              })}
            >
              Duplicate
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="touch-copy"
              onClick={act(() => {
                const ids = targetsOf(moment.id);
                select(ids);
                copySelection();
              })}
            >
              Copy
            </button>
            <button
              type="button"
              role="menuitem"
              data-testid="touch-delete"
              onClick={act(() => {
                const ids = targetsOf(moment.id);
                if (deleteMoments(ids)) announce(`Deleted ${momentsText(ids.length)}`);
              })}
            >
              Delete
            </button>
          </>
        )}
        {hasClip() && (
          <button
            type="button"
            role="menuitem"
            data-testid="touch-paste"
            onClick={act(() => {
              pasteHere();
            })}
          >
            Paste at playhead
          </button>
        )}
        <hr />
        {toggle('free', 'Snap', !mods.free)}
        {stagger && toggle('stagger', 'Ends set stagger', mods.stagger)}
        {toggle('add', 'Select more', mods.add)}
      </div>
    </>
  );
}
