/**
 * The piano ruler (PLAN.md §11.3 "Piano ruler"): the score's pitch axis as piano keys, one button
 * per semitone in view, at the score's left edge (editor layout).
 * - Keys of the key in effect (at the selected moment, else at the playhead) are marked; the
 *   tonic more strongly.
 * - With one chord selected, its notes are pressed and a click toggles a note (freezing the chord;
 *   the note count follows); with one pin selected, a click moves the pin there. One undo entry
 *   each; the result sounds once (stopped transport only, §11.3 auditioning).
 * - Otherwise a click sounds the key's pitch on the line nearest the playhead (stopped transport
 *   only).
 * - In live mode (§9, the Live drawer open) the ruler is an input instead: pressing a key plays it
 *   until release, dragging across keys glides from key to key (legato: the next key is pressed
 *   before the last is released), Enter plays while held. Keys held by any live input are marked.
 * Keys are laid out per score frame by direct style writes (React renders only when the semitone
 * range, the selection or the key changes). One tab stop: ↑/↓ move between keys, Enter presses
 * (Space stays play and pause).
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { activeAt, keyAt } from '../../core/query';
import type { Key, Moment, Pitch } from '../../core/types';
import { noteLabel, pitchToY, type View } from '../../render';
import { announce } from '../announce';
import { audition } from '../audition';
import { pianoKeyEdit } from '../editor/actions';
import { chordNotes } from '../editor/chord-notes';
import { useEditor } from '../editor/history';
import { liveInputs, useLive } from '../live-ui';
import { PIANO_WIDTH, isBlackKey, keyRole, pianoKeys } from '../editor/piano';
import { onScoreFrame } from '../loop';
import { currentTime, usePlayer } from '../store';
import './piano.css';

/** The moment the ruler edits: one selected chord or pin. */
function useTarget(): Extract<Moment, { type: 'chord' | 'pin' }> | null {
  const selection = useEditor((s) => s.selection);
  const piece = usePlayer((s) => s.piece);
  if (selection.length !== 1) return null;
  const m = piece.moments.find((x) => x.id === selection[0]);
  return m && (m.type === 'chord' || m.type === 'pin') ? m : null;
}

const keySig = (k: Key): string => `${k.tonic}|${JSON.stringify(k.scale)}`;

export function PianoRuler() {
  const target = useTarget();
  const piece = usePlayer((s) => s.piece);
  const compiled = usePlayer((s) => s.compiled);
  const [range, setRange] = useState<[number, number]>([60, 59]);
  const [key, setKey] = useState<Key>(piece.key);
  const [focusP, setFocusP] = useState<Pitch | null>(null);
  const els = useRef(new Map<Pitch, HTMLButtonElement>());
  const lastView = useRef<View | null>(null);
  const layoutSig = useRef('');
  const liveOn = useLive((s) => s.open);
  /** The key the pointer holds in live mode. */
  const held = useRef<Pitch | null>(null);

  const on = useMemo(() => {
    if (!target) return new Set<Pitch>();
    if (target.type === 'pin') return new Set([Math.round(target.pitch)]);
    return new Set((chordNotes(piece, compiled, target) ?? []).map((p) => Math.round(p)));
  }, [target, piece, compiled]);

  const layout = (v: View, force = false): void => {
    const sig = `${v.pLo}|${v.pHi}|${v.height}|${v.padT}|${v.padB}`;
    if (!force && sig === layoutSig.current) return;
    layoutSig.current = sig;
    for (const [p, el] of els.current) {
      const top = pitchToY(v, p + 0.5);
      const h = pitchToY(v, p - 0.5) - top;
      el.style.transform = `translateY(${top.toFixed(1)}px)`;
      el.style.height = `${Math.max(1, h).toFixed(1)}px`;
    }
  };

  /** The selected moment's time: the key shown is the one in effect there (else at the playhead). */
  const atRef = useRef<number | null>(null);
  const targetAt = target ? target.at : null;
  useEffect(() => {
    atRef.current = targetAt;
  }, [targetAt]);

  useEffect(
    () =>
      onScoreFrame((v) => {
        lastView.current = v;
        const lo = Math.ceil(v.pLo - 0.5);
        const hi = Math.floor(v.pHi + 0.5);
        setRange((r) => (r[0] === lo && r[1] === hi ? r : [lo, hi]));
        const { compiled: score } = usePlayer.getState();
        const k = keyAt(score, atRef.current ?? v.t);
        setKey((cur) => (keySig(cur) === keySig(k) ? cur : k));
        layout(v);
      }),
    [],
  );

  /** Marks the keys live inputs hold (direct writes; also after a re-render). */
  const markHeld = (): void => {
    for (const [p, el] of els.current) {
      const on = liveInputs.holds(p);
      if (on !== el.hasAttribute('data-held')) el.toggleAttribute('data-held', on);
    }
  };
  useEffect(() => liveInputs.subscribe(markHeld), []);

  useLayoutEffect(() => {
    if (lastView.current) layout(lastView.current, true);
    markHeld();
  });

  /** Live: the key under a pointer, if it is on this ruler. */
  const keyAtPoint = (x: number, y: number): Pitch | null => {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('.piano-key[data-pitch]');
    return el && els.current.get(Number(el.dataset.pitch)) === el ? Number(el.dataset.pitch) : null;
  };
  const liveMove = (p: Pitch | null): void => {
    const was = held.current;
    if (p === was || p === null) return;
    held.current = p;
    liveInputs.down('ruler', p);
    if (was !== null) liveInputs.up('ruler', was);
  };
  const liveEnd = (): void => {
    held.current = null;
    liveInputs.release('ruler');
  };
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!liveOn || e.button !== 0) return;
    const p = keyAtPoint(e.clientX, e.clientY);
    if (p === null) return;
    e.preventDefault(); // no focus move or text selection while playing
    e.currentTarget.setPointerCapture?.(e.pointerId);
    liveMove(p);
  };

  const keys = useMemo(() => pianoKeys(range[0], range[1]).reverse(), [range]);
  const tab =
    focusP !== null && keys.includes(focusP) ? focusP : (keys[Math.floor(keys.length / 2)] ?? null);

  const press = (p: Pitch): void => {
    if (useLive.getState().open) return; // live: pointer and Enter play (above)
    const name = noteLabel(p, key);
    if (target) {
      const r = pianoKeyEdit(target.id, p);
      if (r.kind === 'added') announce(`Added ${name} to the chord`);
      else if (r.kind === 'removed') announce(`Removed ${name} from the chord`);
      else if (r.kind === 'pin') announce(`Pin moved to ${name}`);
      else if (r.kind === 'refused') {
        announce(
          r.reason === 'last-note'
            ? 'A chord keeps at least one note'
            : `All ${piece.voices.length} notes are in use; add notes in the Notes drawer`,
        );
      }
      return;
    }
    const t = currentTime();
    const voice = activeAt(compiled, t)[0] ?? 0;
    audition([{ voice, pitch: p }], t);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, p: Pitch): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown' && e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Enter') {
      if (!liveOn) press(p);
      else if (!e.repeat) liveInputs.down('ruler', p);
      return;
    }
    const next = p + (e.key === 'ArrowUp' ? 1 : -1);
    const el = els.current.get(next);
    if (el) {
      setFocusP(next);
      el.focus({ preventScroll: true });
    }
  };

  const what = liveOn
    ? 'press a key to play it live, drag across keys to glide'
    : target
      ? target.type === 'chord'
        ? 'click a key to add or remove that note in the selected chord'
        : 'click a key to move the selected pin there'
      : 'select a chord or pin to edit its notes; a click sounds the key';

  return (
    <div
      className="piano-ruler"
      data-testid="piano-ruler"
      role="group"
      aria-label={`Piano ruler: ${what}`}
      style={{ width: PIANO_WIDTH }}
      data-target={target?.type}
      data-live={liveOn || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        if (held.current !== null) liveMove(keyAtPoint(e.clientX, e.clientY));
      }}
      onPointerUp={liveEnd}
      onPointerCancel={liveEnd}
      onLostPointerCapture={liveEnd}
    >
      {keys.map((p) => {
        const name = noteLabel(p, key);
        const role = keyRole(p, key);
        const pressed = on.has(p);
        return (
          <button
            key={p}
            ref={(el) => {
              if (el) els.current.set(p, el);
              else els.current.delete(p);
            }}
            type="button"
            className="piano-key"
            data-pitch={p}
            data-black={isBlackKey(p) || undefined}
            data-role={role}
            data-on={pressed || undefined}
            aria-pressed={target ? pressed : undefined}
            aria-label={`${name}${role === 'tonic' ? ', tonic' : role === 'scale' ? ', in key' : ''}`}
            title={name}
            tabIndex={p === tab ? 0 : -1}
            onFocus={() => setFocusP(p)}
            onClick={() => press(p)}
            onKeyDown={(e) => onKeyDown(e, p)}
            onKeyUp={(e) => {
              if (e.key === 'Enter') liveInputs.up('ruler', p);
            }}
            onBlur={() => liveInputs.up('ruler', p)}
          >
            {p % 12 === 0 && <span className="piano-c">{name}</span>}
          </button>
        );
      })}
    </div>
  );
}
