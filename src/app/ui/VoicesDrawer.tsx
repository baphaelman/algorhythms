/**
 * The Voices drawer (PLAN.md §11.3): pool size, and per voice colour, timbre, pan, gain, FX
 * sends (over the master's), range, mute and solo. With parts (revision 9) notes are grouped under part headers that rename the
 * part and set timbre, pan, gain and range for all its notes; each row has a Part select. What sounds at the start is the moment at t = 0 (M4.5-27), not a drawer setting. Wide layout only. Every change is one undo entry
 * (`edit`), and a slider or colour drag is one gesture. Edits reach the engine through the store's
 * recompile and hot-swap, so playback keeps going.
 */

import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { create } from 'zustand';
import { noteName } from '../../core/scales';
import { MAX_VOICES, type VoiceDef } from '../../core/types';
import {
  beginGesture,
  edit,
  endGesture,
  inGesture,
  updateGesture,
  type Recipe,
} from '../editor/history';
import {
  assignPart,
  common,
  deletePart,
  freePartName,
  momentsTargeting,
  partNames,
  partVoices,
  patchPart,
  renameError,
  renamePart,
  setPartRangeBound,
} from '../editor/parts';
import {
  anySolo,
  clearSolo,
  commonTimbre,
  heardVoices,
  normalizeRange,
  patchVoice,
  PITCH_MAX,
  PITCH_MIN,
  poolShrinkEffects,
  resizePool,
  sendOf,
  setAllTimbres,
  setVoiceSend,
  timbreOptions,
  toggleMute,
  toggleSolo,
} from '../editor/voices';
import { pushNotice, usePlayer } from '../store';
import './voices.css';

/** Whether the drawer is open (not saved with the piece). */
export const useVoicesDrawer = create<{ open: boolean }>()(() => ({ open: false }));

/** Opens or closes the drawer. */
export function toggleVoicesDrawer(open = !useVoicesDrawer.getState().open): void {
  useVoicesDrawer.setState({ open });
}

/** The view-bar button that opens the drawer (hidden in the narrow player layout by CSS). */
export function VoicesToggle() {
  const open = useVoicesDrawer((s) => s.open);
  return (
    <button
      type="button"
      className="toggle voices-toggle"
      aria-pressed={open}
      aria-controls="voices-drawer"
      data-testid="voices-toggle"
      onClick={() => toggleVoicesDrawer()}
    >
      Notes
    </button>
  );
}

// ---------------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------------

/**
 * A number field that commits on Enter, blur, or a stepper/arrow step, not on every keystroke
 * (typing "12" must not shrink the pool to 1 on the way). Escape reverts.
 */
function NumberField(props: {
  /** null shows `placeholder` (a part's mixed values). */
  value: number | null;
  placeholder?: string;
  min: number;
  max: number;
  label: string;
  onCommit: (n: number) => void;
  testId?: string;
  className?: string;
}) {
  const { value, min, max, label, onCommit, testId, className, placeholder } = props;
  const [draft, setDraft] = useState<string | null>(null);
  // An outside change (undo, another edit) drops a typed draft: blur must not commit it.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setDraft(null);
  }
  const commit = (text: string): void => {
    setDraft(null);
    const n = Number(text);
    if (text.trim() !== '' && Number.isFinite(n))
      onCommit(Math.max(min, Math.min(max, Math.round(n))));
  };
  return (
    <input
      type="number"
      className={className}
      inputMode="numeric"
      min={min}
      max={max}
      step={1}
      aria-label={label}
      data-testid={testId}
      placeholder={placeholder}
      value={draft ?? (value === null ? '' : String(value))}
      onChange={(e: ChangeEvent<HTMLInputElement>) => {
        // Steppers and arrow keys fire a plain `input` event (no inputType): commit at once.
        if (!(e.nativeEvent as InputEvent).inputType) commit(e.target.value);
        else setDraft(e.target.value);
      }}
      onBlur={() => {
        if (draft !== null) commit(draft);
      }}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' && draft !== null) commit(draft);
        else if (e.key === 'Escape') setDraft(null);
      }}
    />
  );
}

/** A range input whose drag is one undo entry; keyboard steps are one entry each. */
function GestureSlider(props: {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  gestureLabel: string;
  valueText: string;
  disabled?: boolean;
  testId?: string;
  recipe: (x: number) => Recipe;
}) {
  const { value, min, max, step, label, gestureLabel, valueText, disabled, testId, recipe } = props;
  const dragging = useRef(false);
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={label}
      aria-valuetext={valueText}
      data-testid={testId}
      onPointerDown={() => {
        dragging.current = true;
        beginGesture(gestureLabel);
        window.addEventListener(
          'pointerup',
          () => {
            dragging.current = false;
            endGesture();
          },
          { once: true },
        );
      }}
      onChange={(e) => {
        const x = Number(e.target.value);
        if (dragging.current) updateGesture(recipe(x));
        else edit(recipe(x), gestureLabel);
      }}
    />
  );
}

/** Hex for the colour input (it only takes #rrggbb). */
function hexOf(color: string | undefined): string {
  if (color && /^#[0-9a-f]{6}$/i.test(color)) return color;
  if (color && /^#[0-9a-f]{3}$/i.test(color)) {
    return '#' + [...color.slice(1)].map((c) => c + c).join('');
  }
  return '#808080';
}

function ColorField({ voice }: { voice: VoiceDef }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // The native `change` fires when the picker closes: the end of the colour gesture.
    const end = (): void => endGesture();
    el.addEventListener('change', end);
    return () => el.removeEventListener('change', end);
  }, []);
  return (
    <span className="vd-color">
      <input
        ref={ref}
        type="color"
        aria-label={`Colour of ${voice.id}`}
        value={hexOf(voice.color)}
        onChange={(e) => {
          if (!inGesture()) beginGesture('Note colour');
          const color = e.target.value;
          updateGesture((p) => patchVoice(p, voice.id, { color }));
        }}
        onBlur={() => endGesture()}
      />
      {voice.color !== undefined && (
        <button
          type="button"
          className="vd-mini"
          aria-label={`Clear colour of ${voice.id}`}
          title="Clear colour"
          onClick={() => edit((p) => patchVoice(p, voice.id, { color: undefined }), 'Clear colour')}
        >
          ×
        </button>
      )}
    </span>
  );
}

const fmtPan = (pan: number): string =>
  Math.abs(pan) < 0.005 ? 'C' : `${pan < 0 ? 'L' : 'R'}${Math.round(Math.abs(pan) * 100)}`;
const fmtGain = (g: number): string => (g <= 0 ? '−∞ dB' : `${(20 * Math.log10(g)).toFixed(1)} dB`);

const fmtSend = (x: number): string => String(Number(x.toFixed(2)));

/**
 * A note's reverb (R) and delay (D) sends. Without its own value a slider shows the master
 * default, dimmed; moving it gives the note its own. ↺ goes back to the master default.
 */
function Sends({ voice }: { voice: VoiceDef }) {
  const id = voice.id;
  const piece = usePlayer((s) => s.piece);
  const own = voice.sends !== undefined && Object.keys(voice.sends).length > 0;
  return (
    <span className="vd-sends">
      {(['reverb', 'delay'] as const).map((key) => {
        const value = sendOf(piece, voice, key);
        const inherited = voice.sends?.[key] === undefined;
        const text = `${fmtSend(value)}${inherited ? ' (master)' : ''}`;
        return (
          <span key={key} className={inherited ? 'vd-send vd-inherited' : 'vd-send'}>
            <span className="vd-send-k" aria-hidden="true">
              {key === 'reverb' ? 'R' : 'D'}
            </span>
            <GestureSlider
              value={value}
              min={0}
              max={1}
              step={0.01}
              label={`${key === 'reverb' ? 'Reverb' : 'Delay'} send of ${id}`}
              gestureLabel="Note send"
              valueText={text}
              testId={`send-${key}-${id}`}
              recipe={(x) => (p) => setVoiceSend(p, id, key, x)}
            />
            <output className="vd-out" data-testid={`send-${key}-${id}-out`}>
              {fmtSend(value)}
            </output>
          </span>
        );
      })}
      <button
        type="button"
        className="vd-mini"
        aria-label={`Master sends for ${id}`}
        title="Use the master sends (Sound drawer)"
        data-testid={`send-reset-${id}`}
        disabled={!own}
        onClick={() =>
          edit(
            (p) => setVoiceSend(setVoiceSend(p, id, 'reverb', undefined), id, 'delay', undefined),
            'Note sends',
          )
        }
      >
        ↺
      </button>
    </span>
  );
}

const NEW_PART = '\u0000new';

/** A note's Part select: Unassigned, the parts, or "New part…" (a fresh part holding it). */
function PartSelect({ voice, parts }: { voice: VoiceDef; parts: readonly string[] }) {
  const id = voice.id;
  return (
    <select
      aria-label={`Part of ${id}`}
      data-testid={`part-${id}`}
      value={voice.part ?? ''}
      onChange={(e) => {
        const v = e.target.value;
        if (v === NEW_PART) edit((p) => assignPart(p, id, freePartName(p)), 'New part');
        else edit((p) => assignPart(p, id, v), 'Move note to part');
      }}
    >
      <option value="">Unassigned</option>
      {parts.map((p) => (
        <option key={p} value={p}>
          {p}
        </option>
      ))}
      <option value={NEW_PART}>New part…</option>
    </select>
  );
}

function VoiceRow({
  voice,
  index,
  heard,
  parts,
}: {
  voice: VoiceDef;
  index: number;
  heard: boolean;
  /** The piece's parts, when it has any (adds the Part column). */
  parts: readonly string[] | null;
}) {
  const id = voice.id;
  const piece = usePlayer((s) => s.piece);
  const pan = voice.pan;
  const name = voice.name ? `${voice.name} (${id})` : id;
  return (
    <tr data-voice={id} className={heard ? undefined : 'vd-silent'}>
      <th scope="row" title={`Pool index ${index}`}>
        {name}
      </th>
      <td>
        <ColorField voice={voice} />
      </td>
      <td>
        <select
          aria-label={`Timbre of ${id}`}
          data-testid={`timbre-${id}`}
          value={voice.timbre}
          onChange={(e) => {
            const timbre = e.target.value;
            edit((p) => patchVoice(p, id, { timbre }), 'Note timbre');
          }}
        >
          {timbreOptions(piece, voice.timbre).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </td>
      <td>
        <span className="vd-pan">
          <button
            type="button"
            className="vd-mini"
            aria-pressed={pan === 'auto'}
            aria-label={`Automatic pan for ${id}`}
            title="Auto pan"
            onClick={() =>
              edit((p) => patchVoice(p, id, { pan: pan === 'auto' ? 0 : 'auto' }), 'Note pan')
            }
          >
            A
          </button>
          <GestureSlider
            value={pan === 'auto' ? 0 : pan}
            min={-1}
            max={1}
            step={0.01}
            disabled={pan === 'auto'}
            label={`Pan of ${id}`}
            gestureLabel="Note pan"
            valueText={pan === 'auto' ? 'auto' : fmtPan(pan)}
            recipe={(x) => (p) => patchVoice(p, id, { pan: x })}
          />
          <output className="vd-out">{pan === 'auto' ? 'auto' : fmtPan(pan)}</output>
        </span>
      </td>
      <td>
        <span className="vd-gain">
          <GestureSlider
            value={voice.gain}
            min={0}
            max={2}
            step={0.01}
            label={`Gain of ${id}`}
            gestureLabel="Note gain"
            valueText={fmtGain(voice.gain)}
            recipe={(x) => (p) => patchVoice(p, id, { gain: x })}
          />
          <output className="vd-out">{fmtGain(voice.gain)}</output>
        </span>
      </td>
      <td>
        <Sends voice={voice} />
      </td>
      <td>
        <span className="vd-range">
          <NumberField
            className="vd-num"
            value={voice.range[0]}
            min={PITCH_MIN}
            max={PITCH_MAX}
            label={`Lowest pitch of ${id}`}
            onCommit={(n) =>
              edit(
                (p) => patchVoice(p, id, { range: normalizeRange(n, voice.range[1]) }),
                'Note range',
              )
            }
          />
          <span className="vd-note">{noteName(voice.range[0])}</span>
          <span aria-hidden="true">–</span>
          <NumberField
            className="vd-num"
            value={voice.range[1]}
            min={PITCH_MIN}
            max={PITCH_MAX}
            label={`Highest pitch of ${id}`}
            onCommit={(n) =>
              edit(
                (p) => patchVoice(p, id, { range: normalizeRange(voice.range[0], n) }),
                'Note range',
              )
            }
          />
          <span className="vd-note">{noteName(voice.range[1])}</span>
        </span>
      </td>
      <td>
        <button
          type="button"
          className="vd-mini"
          aria-pressed={voice.mute === true}
          aria-label={`Mute ${id}`}
          data-testid={`mute-${id}`}
          onClick={() => edit((p) => toggleMute(p, id), voice.mute ? 'Unmute note' : 'Mute note')}
        >
          M
        </button>
        <button
          type="button"
          className="vd-mini"
          aria-pressed={voice.solo === true}
          aria-label={`Solo ${id}`}
          title="Solo (Alt: solo only this note)"
          data-testid={`solo-${id}`}
          onClick={(e) => edit((p) => toggleSolo(p, id, e.altKey), 'Solo note')}
        >
          S
        </button>
      </td>
      {parts && (
        <td>
          <PartSelect voice={voice} parts={parts} />
        </td>
      )}
    </tr>
  );
}

/** A part's name field: commits on Enter or blur, Escape reverts; a taken name is refused. */
function PartName({ part }: { part: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seen, setSeen] = useState(part);
  if (seen !== part) {
    setSeen(part);
    setDraft(null);
    setError(null);
  }
  const commit = (): void => {
    if (draft === null) return;
    const err = renameError(usePlayer.getState().piece, part, draft);
    if (err) {
      setError(err);
      return;
    }
    setDraft(null);
    setError(null);
    edit((p) => renamePart(p, part, draft), 'Rename part');
  };
  return (
    <input
      type="text"
      className="vd-part-name"
      aria-label={`Name of part ${part}`}
      aria-invalid={error ? true : undefined}
      title={error ?? undefined}
      data-testid="part-name"
      spellCheck={false}
      autoComplete="off"
      value={draft ?? part}
      onChange={(e) => {
        setDraft(e.target.value);
        setError(null);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        else if (e.key === 'Escape') {
          setDraft(null);
          setError(null);
        }
      }}
    />
  );
}

const panText = (pan: number | 'auto' | undefined): string =>
  pan === undefined ? 'Mixed' : pan === 'auto' ? 'auto' : fmtPan(pan);

/** A part's header row: name, delete, and timbre, pan, gain and range for all its notes. */
function PartHeader({ part, cols }: { part: string; cols: number }) {
  const piece = usePlayer((s) => s.piece);
  const [confirming, setConfirming] = useState(false);
  const voices = partVoices(piece, part);
  const timbre = common(voices, (v) => v.timbre);
  const allAuto = voices.every((v) => v.pan === 'auto');
  const pan = common(voices, (v) => v.pan);
  const panValue = voices.map((v) => v.pan).find((x): x is number => x !== 'auto');
  const gain = common(voices, (v) => v.gain);
  const lo = common(voices, (v) => v.range[0]);
  const hi = common(voices, (v) => v.range[1]);
  const targeting = momentsTargeting(piece, part).length;
  const remove = (): void => {
    setConfirming(false);
    edit((p) => deletePart(p, part), 'Delete part');
  };
  const label = `part ${part}`;
  return (
    <>
      <tr className="vd-part" data-part={part}>
        <th scope="rowgroup">
          <span className="vd-part-head">
            <PartName part={part} />
            <button
              type="button"
              className="vd-mini"
              aria-label={`Delete part ${part}`}
              title="Delete part (its notes become unassigned)"
              data-testid="part-delete"
              onClick={() => (targeting > 0 ? setConfirming(true) : remove())}
            >
              ×
            </button>
          </span>
        </th>
        <td />
        <td>
          <select
            aria-label={`Timbre of ${label}`}
            data-testid="part-timbre"
            value={timbre ?? MIXED}
            onChange={(e) => {
              const t = e.target.value;
              if (t !== MIXED) edit((p) => patchPart(p, part, { timbre: t }), 'Part timbre');
            }}
          >
            {timbre === undefined && (
              <option value={MIXED} disabled>
                Mixed
              </option>
            )}
            {timbreOptions(piece, timbre).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </td>
        <td>
          <span className="vd-pan">
            <button
              type="button"
              className="vd-mini"
              aria-pressed={allAuto}
              aria-label={`Automatic pan for ${label}`}
              title="Auto pan"
              onClick={() =>
                edit((p) => patchPart(p, part, { pan: allAuto ? 0 : 'auto' }), 'Part pan')
              }
            >
              A
            </button>
            <GestureSlider
              value={panValue ?? 0}
              min={-1}
              max={1}
              step={0.01}
              disabled={allAuto}
              label={`Pan of ${label}`}
              gestureLabel="Part pan"
              valueText={panText(pan)}
              recipe={(x) => (p) => patchPart(p, part, { pan: x })}
            />
            <output className="vd-out">{panText(pan)}</output>
          </span>
        </td>
        <td>
          <span className="vd-gain">
            <GestureSlider
              value={gain ?? voices[0]?.gain ?? 1}
              min={0}
              max={2}
              step={0.01}
              label={`Gain of ${label}`}
              gestureLabel="Part gain"
              valueText={gain === undefined ? 'Mixed' : fmtGain(gain)}
              recipe={(x) => (p) => patchPart(p, part, { gain: x })}
            />
            <output className="vd-out" data-testid="part-gain-out">
              {gain === undefined ? 'Mixed' : fmtGain(gain)}
            </output>
          </span>
        </td>
        <td />
        <td>
          <span className="vd-range">
            <NumberField
              className="vd-num"
              value={lo ?? null}
              placeholder="Mixed"
              min={PITCH_MIN}
              max={PITCH_MAX}
              label={`Lowest pitch of ${label}`}
              onCommit={(n) => edit((p) => setPartRangeBound(p, part, 0, n), 'Part range')}
            />
            <span className="vd-note">{lo !== undefined ? noteName(lo) : ''}</span>
            <span aria-hidden="true">–</span>
            <NumberField
              className="vd-num"
              value={hi ?? null}
              placeholder="Mixed"
              min={PITCH_MIN}
              max={PITCH_MAX}
              label={`Highest pitch of ${label}`}
              onCommit={(n) => edit((p) => setPartRangeBound(p, part, 1, n), 'Part range')}
            />
            <span className="vd-note">{hi !== undefined ? noteName(hi) : ''}</span>
          </span>
        </td>
        <td />
        <td className="vd-count">
          {voices.length} {voices.length === 1 ? 'note' : 'notes'}
        </td>
      </tr>
      {confirming && (
        <tr className="vd-confirm">
          <td colSpan={cols} role="alert">
            {targeting} {targeting === 1 ? 'moment targets' : 'moments target'} {part}. Deleting the
            part makes {targeting === 1 ? 'it' : 'them'} target its notes by pick.{' '}
            <button
              type="button"
              className="danger"
              data-testid="part-delete-confirm"
              onClick={remove}
            >
              Delete part
            </button>{' '}
            <button type="button" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------------------------

function resize(size: number): void {
  const piece = usePlayer.getState().piece;
  const fx = poolShrinkEffects(piece, size);
  if (!edit((p) => resizePool(p, size), 'Pool size')) return;
  if (fx.moments > 0) {
    pushNotice(
      'info',
      `Removed ${fx.moments} ${fx.moments === 1 ? 'moment' : 'moments'} with the notes`,
      [`They acted only on ${fx.voices.join(', ')}. Undo restores them.`],
    );
  }
}

const MIXED = '\u0000mixed';

/** The drawer itself; renders nothing while closed. Mount it in the wide layout only. */
export function VoicesDrawer() {
  const open = useVoicesDrawer((s) => s.open);
  const piece = usePlayer((s) => s.piece);
  if (!open) return null;
  const voices = piece.voices;
  const heard = heardVoices(voices);
  const soloed = anySolo(voices);
  const allTimbre = commonTimbre(voices);
  const parts = partNames(piece);
  const grouped = parts.length > 0;
  const unassigned = voices.filter((v) => !v.part);
  const cols = grouped ? 9 : 8;
  const row = (v: VoiceDef) => {
    const i = voices.indexOf(v);
    return (
      <VoiceRow key={v.id} voice={v} index={i} heard={heard[i]} parts={grouped ? parts : null} />
    );
  };
  return (
    <section
      id="voices-drawer"
      className="voices-drawer"
      aria-label="Notes"
      data-testid="voices-drawer"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) {
          e.preventDefault(); // used: the editor keys must not also clear the selection
          toggleVoicesDrawer(false);
        }
      }}
    >
      <header className="vd-head">
        <h2>Notes</h2>
        <label className="ctl">
          <span>Pool</span>
          <NumberField
            className="vd-num"
            value={voices.length}
            min={1}
            max={MAX_VOICES}
            label="Pool size"
            testId="pool-size"
            onCommit={resize}
          />
        </label>
        <label className="ctl">
          <span>All notes</span>
          <select
            aria-label="Timbre of all notes"
            data-testid="timbre-all"
            value={allTimbre ?? MIXED}
            onChange={(e) => {
              const timbre = e.target.value;
              if (timbre !== MIXED) edit((p) => setAllTimbres(p, timbre), 'All notes timbre');
            }}
          >
            {allTimbre === undefined && (
              <option value={MIXED} disabled>
                Mixed
              </option>
            )}
            {timbreOptions(piece, allTimbre).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <button type="button" disabled={!soloed} onClick={() => edit(clearSolo, 'Clear solo')}>
          Clear solo
        </button>
        <button
          type="button"
          data-testid="new-part"
          disabled={grouped && unassigned.length === 0}
          title={
            grouped
              ? 'Puts the unassigned notes in a new part'
              : 'Puts every note in a part; move notes to other parts on their rows'
          }
          onClick={() =>
            edit((p) => {
              const name = freePartName(p);
              return p.voices.reduce((acc, v) => (v.part ? acc : assignPart(acc, v.id, name)), p);
            }, 'New part')
          }
        >
          New part
        </button>
        <p className="vd-hint">Colours show when Lines is Custom.</p>
        <button
          type="button"
          className="vd-close"
          aria-label="Close notes drawer"
          onClick={() => toggleVoicesDrawer(false)}
        >
          ×
        </button>
      </header>
      <div className="vd-scroll">
        <table className="vd-table">
          <thead>
            <tr>
              <th scope="col">Note</th>
              <th scope="col">Colour</th>
              <th scope="col">Timbre</th>
              <th scope="col">Pan</th>
              <th scope="col">Gain</th>
              <th scope="col" title="Reverb and delay sends (dim: the master default)">
                Sends
              </th>
              <th scope="col">Range</th>
              <th scope="col">Mute · Solo</th>
              {grouped && <th scope="col">Part</th>}
            </tr>
          </thead>
          {!grouped && <tbody>{voices.map(row)}</tbody>}
          {grouped &&
            parts.map((part) => (
              <tbody key={part} data-testid="part-group" data-part={part}>
                <PartHeader part={part} cols={cols} />
                {partVoices(piece, part).map(row)}
              </tbody>
            ))}
          {grouped && unassigned.length > 0 && (
            <tbody data-testid="part-group" data-part="">
              <tr className="vd-part">
                <th scope="rowgroup" colSpan={cols}>
                  Unassigned
                </th>
              </tr>
              {unassigned.map(row)}
            </tbody>
          )}
        </table>
      </div>
    </section>
  );
}
