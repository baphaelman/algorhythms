/**
 * The Live drawer (PLAN.md §9, §11.2 drawers: Voices · Sound · Live): opening it enters live mode
 * and turns musical typing on, closing it leaves (../live-ui.ts). The panel's settings: single key
 * (unison or octaves), chord voicing (exact notes or across the range), release (hold, fade out,
 * return to the tonic), glide length (the mod wheel's scale), stagger and order; the MIDI input
 * and its status; short help. Wide layout only. It can be open with the Notes or Sound drawer
 * (mix edits while live are heard).
 */

import { useEffect, useRef } from 'react';
import type { GlideOrder } from '../../core/types';
import { glideFromModWheel } from '../../core/live';
import { recordElapsed, useRecord } from '../live';
import {
  closeLive,
  connectMidi,
  selectMidi,
  setPanel,
  setTyping,
  toggleLive,
  toggleRecord,
  useLive,
  type LivePanel,
  type MidiStatus,
} from '../live-ui';
import { ALL_INPUTS } from '../midi-input';
import { octaveLabel } from '../typing-keys';
import './live.css';

/** The view-bar button that opens the drawer (hidden in the narrow player layout by CSS). */
export function LiveToggle() {
  const open = useLive((s) => s.open);
  return (
    <button
      type="button"
      className="toggle live-toggle"
      aria-pressed={open}
      aria-controls="live-drawer"
      data-testid="live-toggle"
      title="Play the notes live: keyboard, MIDI or the piano ruler"
      onClick={() => toggleLive()}
    >
      Live
    </button>
  );
}

/** The transport's musical typing button and indicator (`). */
export function TypingToggle() {
  const typing = useLive((s) => s.typing);
  const octave = useLive((s) => s.octave);
  return (
    <button
      type="button"
      className="typing-toggle"
      aria-pressed={typing}
      aria-keyshortcuts="`"
      data-testid="typing-toggle"
      data-on={typing || undefined}
      title={
        typing
          ? 'Musical typing is on: letters play notes (A–K), Z/X change octave. ` turns it off'
          : 'Musical typing: play notes with the letter keys (`)'
      }
      onClick={() => setTyping(!typing)}
    >
      {typing ? (
        <>
          Typing <span data-testid="typing-octave">{octaveLabel(octave)}</span>
        </>
      ) : (
        'Typing'
      )}
    </button>
  );
}

/** m:ss.s */
function clockText(t: number): string {
  const tenths = Math.floor(t * 10);
  const m = Math.floor(tenths / 600);
  const sec = (tenths % 600) / 10;
  return `${m}:${sec < 10 ? '0' : ''}${sec.toFixed(1)}`;
}

/** The time recorded so far, updated every animation frame while recording. */
function Elapsed() {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = (): void => {
      if (ref.current) ref.current.textContent = clockText(recordElapsed());
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, []);
  return <span ref={ref} className="live-record-time" data-testid="live-record-time" />;
}

/**
 * Record (§9 Recording, record into silence): arms a take at the playhead while live; pressing
 * it again (or Pause, Space, Escape, closing the drawer) stops and keeps it. Shown in the
 * transport while live (`live-record`) and in the drawer's header (`live-record-drawer`).
 */
export function RecordToggle({ where }: { where: 'transport' | 'drawer' }) {
  const open = useLive((s) => s.open);
  const status = useRecord((s) => s.status);
  if (where === 'transport' && !open) return null;
  const on = status === 'starting' || status === 'recording';
  return (
    <button
      type="button"
      className="live-record"
      aria-pressed={on}
      data-testid={where === 'transport' ? 'live-record' : 'live-record-drawer'}
      data-status={status}
      disabled={status === 'saving'}
      title={
        on
          ? 'Stop recording and keep the take (Space, Escape)'
          : 'Record what you play from the playhead (replaces the piece from there)'
      }
      onClick={() => toggleRecord()}
    >
      <span className="live-record-dot" aria-hidden="true" />
      {status === 'recording' ? (
        <>
          Recording <Elapsed />
        </>
      ) : status === 'starting' ? (
        'Arming…'
      ) : status === 'saving' ? (
        'Saving…'
      ) : (
        'Record'
      )}
    </button>
  );
}

/** Glide slider positions: the mod wheel's 0..127 (`glideFromModWheel`). */
const GLIDE_STEPS = 127;

function glidePosition(g: number): number {
  const lo = glideFromModWheel(0);
  const hi = glideFromModWheel(GLIDE_STEPS);
  const u = Math.log(Math.min(hi, Math.max(lo, g)) / lo) / Math.log(hi / lo);
  return Math.round(u * GLIDE_STEPS);
}

const seconds = (s: number): string => `${s < 1 ? s.toFixed(2) : s.toFixed(1)} s`;

const ORDERS: readonly (readonly [GlideOrder, string])[] = [
  ['random', 'Random'],
  ['low-first', 'Low → high'],
  ['high-first', 'High → low'],
  ['center-out', 'Centre out'],
  ['outside-in', 'Outside in'],
];

/** A row of mutually exclusive buttons for one panel field. */
function Choice<K extends 'single' | 'chord' | 'release'>(props: {
  field: K;
  label: string;
  options: readonly (readonly [LivePanel[K], string])[];
}) {
  const value = useLive((s) => s.panel[props.field]);
  return (
    <div className="ctl" role="group" aria-label={props.label}>
      <span>{props.label}</span>
      <div className="seg">
        {props.options.map(([v, text]) => (
          <button
            key={v}
            type="button"
            aria-pressed={value === v}
            data-testid={`live-${props.field}-${v}`}
            onClick={() => setPanel({ [props.field]: v } as Partial<LivePanel>)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

const MIDI_TEXT: Record<MidiStatus, string> = {
  unsupported: 'No Web MIDI in this browser (Safari): use the keyboard or the piano ruler.',
  off: 'Not connected.',
  asking: 'Asking for MIDI access…',
  ready: '',
  denied: 'MIDI access was refused.',
};

function Midi() {
  const midi = useLive((s) => s.midi);
  const status =
    midi.status === 'ready'
      ? midi.devices.length === 0
        ? 'No MIDI devices connected.'
        : midi.selected === ALL_INPUTS
          ? `Listening to ${midi.devices.length === 1 ? midi.devices[0].name : `${midi.devices.length} devices`}.`
          : `Listening to ${midi.devices.find((d) => d.id === midi.selected)?.name ?? 'the device'}.`
      : MIDI_TEXT[midi.status];
  return (
    <div className="ctl live-midi">
      <span>MIDI</span>
      {midi.status === 'ready' ? (
        <select
          aria-label="MIDI input"
          data-testid="live-midi-input"
          value={midi.selected}
          disabled={midi.devices.length === 0}
          onChange={(e) => {
            selectMidi(e.target.value);
            e.currentTarget.blur(); // letters play notes again (a focused select takes them)
          }}
        >
          <option value={ALL_INPUTS}>All inputs</option>
          {midi.devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      ) : (
        midi.status !== 'unsupported' && (
          <button
            type="button"
            data-testid="live-midi-connect"
            disabled={midi.status === 'asking'}
            onClick={() => void connectMidi()}
          >
            Connect
          </button>
        )
      )}
      <output className="live-midi-status" data-testid="live-midi-status" aria-live="polite">
        {status}
      </output>
    </div>
  );
}

/** The drawer itself; renders nothing while closed. Mount it in the wide layout only. */
export function LiveDrawer() {
  const open = useLive((s) => s.open);
  const running = useLive((s) => s.running);
  const glide = useLive((s) => s.panel.glide);
  const stagger = useLive((s) => s.panel.stagger);
  const order = useLive((s) => s.panel.order);
  if (!open) return null;
  return (
    <section
      id="live-drawer"
      className="live-drawer"
      aria-label="Live"
      data-testid="live-drawer"
      data-running={running || undefined}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) {
          e.preventDefault();
          void closeLive();
        }
      }}
    >
      <header className="vd-head live-head">
        <h2>Live</h2>
        <span className="live-state" data-testid="live-state">
          {running ? 'Playing live' : 'Starting…'}
        </span>
        <RecordToggle where="drawer" />
        <Midi />
        <button
          type="button"
          className="vd-close"
          aria-label="Close live drawer"
          onClick={() => void closeLive()}
        >
          ×
        </button>
      </header>
      <div className="live-body">
        <Choice
          field="single"
          label="One key"
          options={[
            ['unison', 'Unison'],
            ['octaves', 'Octaves'],
          ]}
        />
        <Choice
          field="chord"
          label="Chords"
          options={[
            ['exact', 'Exact notes'],
            ['range', 'Across the range'],
          ]}
        />
        <Choice
          field="release"
          label="Release"
          options={[
            ['hold', 'Hold'],
            ['fade', 'Fade out'],
            ['tonic', 'Return to tonic'],
          ]}
        />
        <label className="ctl">
          <span>Glide</span>
          <input
            type="range"
            min={0}
            max={GLIDE_STEPS}
            step={1}
            value={glidePosition(glide)}
            aria-valuetext={seconds(glide)}
            data-testid="live-glide"
            onChange={(e) => setPanel({ glide: glideFromModWheel(Number(e.target.value)) })}
          />
          <output>{seconds(glide)}</output>
        </label>
        <label className="ctl">
          <span>Stagger</span>
          <input
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={stagger}
            aria-valuetext={seconds(stagger)}
            data-testid="live-stagger"
            onChange={(e) => setPanel({ stagger: Number(e.target.value) })}
          />
          <output>{seconds(stagger)}</output>
        </label>
        <label className="ctl">
          <span>Order</span>
          <select
            value={order}
            data-testid="live-order"
            onChange={(e) => {
              setPanel({ order: e.target.value as GlideOrder });
              e.currentTarget.blur();
            }}
          >
            {ORDERS.map(([v, text]) => (
              <option key={v} value={v}>
                {text}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="live-help" data-testid="live-help">
        Play with the letter keys <kbd>A</kbd>–<kbd>K</kbd> (black keys on <kbd>W</kbd> <kbd>E</kbd>{' '}
        <kbd>T</kbd> <kbd>Y</kbd> <kbd>U</kbd>), <kbd>Z</kbd>/<kbd>X</kbd> for the octave;{' '}
        <kbd>`</kbd> turns musical typing on and off (editor letter shortcuts are off while it is
        on). Press keys on the piano ruler, or play a MIDI keyboard: the mod wheel sets the glide,
        the pedal holds, pitch bend ±2. Firefox asks you to install a site-permission add-on the
        first time you connect MIDI; Safari has no Web MIDI, so use the keyboard there.
      </p>
    </section>
  );
}
