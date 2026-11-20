/**
 * The Voices drawer (PLAN.md §11.3): pool size, voices active at start, and per voice colour,
 * timbre, pan, gain, range, mute and solo. Wide layout only. Every change is one undo entry
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
  anySolo,
  clearSolo,
  heardVoices,
  normalizeRange,
  patchVoice,
  PITCH_MAX,
  PITCH_MIN,
  poolShrinkEffects,
  resizePool,
  setStartCount,
  setStartPitch,
  setStarts,
  startCount,
  startPitchOf,
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
      Voices
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
  value: number;
  min: number;
  max: number;
  label: string;
  onCommit: (n: number) => void;
  testId?: string;
  className?: string;
}) {
  const { value, min, max, label, onCommit, testId, className } = props;
  const [draft, setDraft] = useState<string | null>(null);
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
      value={draft ?? String(value)}
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
  recipe: (x: number) => Recipe;
}) {
  const { value, min, max, step, label, gestureLabel, valueText, disabled, recipe } = props;
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
          if (!inGesture()) beginGesture('Voice colour');
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

function VoiceRow({ voice, index, heard }: { voice: VoiceDef; index: number; heard: boolean }) {
  const id = voice.id;
  const piece = usePlayer((s) => s.piece);
  const startPitch = startPitchOf(piece, id);
  const pan = voice.pan;
  const name = voice.name ? `${voice.name} (${id})` : id;
  return (
    <tr data-voice={id} className={heard ? undefined : 'vd-silent'}>
      <th scope="row" title={`Pool index ${index}`}>
        {name}
      </th>
      <td>
        <span className="vd-start">
          <button
            type="button"
            className="vd-mini"
            aria-pressed={startPitch !== undefined}
            aria-label={`${id} active at start`}
            onClick={() =>
              edit(
                (p) => setStarts(p, id, startPitch === undefined),
                startPitch === undefined ? 'Start voice' : 'Stop voice at start',
              )
            }
          >
            ▸
          </button>
          {startPitch !== undefined && (
            <>
              <NumberField
                className="vd-num"
                value={Math.round(startPitch)}
                min={PITCH_MIN}
                max={PITCH_MAX}
                label={`Start pitch of ${id}`}
                onCommit={(n) => edit((p) => setStartPitch(p, id, n), 'Start pitch')}
              />
              <span className="vd-note">{noteName(startPitch)}</span>
            </>
          )}
        </span>
      </td>
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
            edit((p) => patchVoice(p, id, { timbre }), 'Voice timbre');
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
              edit((p) => patchVoice(p, id, { pan: pan === 'auto' ? 0 : 'auto' }), 'Voice pan')
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
            gestureLabel="Voice pan"
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
            gestureLabel="Voice gain"
            valueText={fmtGain(voice.gain)}
            recipe={(x) => (p) => patchVoice(p, id, { gain: x })}
          />
          <output className="vd-out">{fmtGain(voice.gain)}</output>
        </span>
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
                'Voice range',
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
                'Voice range',
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
          onClick={() => edit((p) => toggleMute(p, id), voice.mute ? 'Unmute voice' : 'Mute voice')}
        >
          M
        </button>
        <button
          type="button"
          className="vd-mini"
          aria-pressed={voice.solo === true}
          aria-label={`Solo ${id}`}
          title="Solo (Alt: solo only this voice)"
          data-testid={`solo-${id}`}
          onClick={(e) => edit((p) => toggleSolo(p, id, e.altKey), 'Solo voice')}
        >
          S
        </button>
      </td>
    </tr>
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
      `Removed ${fx.moments} ${fx.moments === 1 ? 'moment' : 'moments'} with the voices`,
      [`They acted only on ${fx.voices.join(', ')}. Undo restores them.`],
    );
  }
}

/** The drawer itself; renders nothing while closed. Mount it in the wide layout only. */
export function VoicesDrawer() {
  const open = useVoicesDrawer((s) => s.open);
  const piece = usePlayer((s) => s.piece);
  if (!open) return null;
  const voices = piece.voices;
  const heard = heardVoices(voices);
  const soloed = anySolo(voices);
  return (
    <section
      id="voices-drawer"
      className="voices-drawer"
      aria-label="Voices"
      data-testid="voices-drawer"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) {
          e.preventDefault(); // used: the editor keys must not also clear the selection
          toggleVoicesDrawer(false);
        }
      }}
    >
      <header className="vd-head">
        <h2>Voices</h2>
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
          <span>At start</span>
          <NumberField
            className="vd-num"
            value={startCount(piece)}
            min={0}
            max={voices.length}
            label="Voices active at start"
            testId="start-count"
            onCommit={(n) => edit((p) => setStartCount(p, n), 'Voices at start')}
          />
        </label>
        <button type="button" disabled={!soloed} onClick={() => edit(clearSolo, 'Clear solo')}>
          Clear solo
        </button>
        <p className="vd-hint">Colours show when Lines is Custom.</p>
        <button
          type="button"
          className="vd-close"
          aria-label="Close voices drawer"
          onClick={() => toggleVoicesDrawer(false)}
        >
          ×
        </button>
      </header>
      <div className="vd-scroll">
        <table className="vd-table">
          <thead>
            <tr>
              <th scope="col">Voice</th>
              <th scope="col">Start</th>
              <th scope="col">Colour</th>
              <th scope="col">Timbre</th>
              <th scope="col">Pan</th>
              <th scope="col">Gain</th>
              <th scope="col">Range</th>
              <th scope="col">Mute · Solo</th>
            </tr>
          </thead>
          <tbody>
            {voices.map((v, i) => (
              <VoiceRow key={v.id} voice={v} index={i} heard={heard[i]} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
