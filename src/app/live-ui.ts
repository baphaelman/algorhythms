/**
 * Live mode's app state and inputs (PLAN.md §9, §11.2 drawers, §11.3): the Live drawer (open ⇔
 * live mode), musical typing, Web MIDI and the panel's settings.
 * - Opening the drawer enters live mode (from the gesture) and turns musical typing on; closing it
 *   leaves live mode and turns typing off. Typing can be toggled meanwhile (transport button, `).
 *   A note key with typing on and the drawer closed opens it.
 * - The panel's settings (single key, chord voicing, release, glide, stagger, order) are viewer
 *   settings, not the piece's: kept for the session and remembered per viewer (localStorage).
 * - While typing is on, letters are taken in the window's capture phase, before any editor key
 *   handler: no single-letter shortcut fires. Text fields, ⌘/Ctrl/Alt chords, Space and Escape
 *   are left alone.
 */

import { create } from 'zustand';
import {
  bendFromMidi,
  DEFAULT_LIVE_SETTINGS,
  mergeLiveSettings,
  type LiveSettings,
} from '../core/live';
import type { Pitch } from '../core/types';
import { LiveInputHub } from './live-input';
import { enterLive, exitLive, live } from './live';
import {
  ALL_INPUTS,
  hasWebMidi,
  MidiInputs,
  type MidiAccessLike,
  type MidiDevice,
  type MidiSink,
} from './midi-input';
import { pushNotice } from './store';
import { DEFAULT_OCTAVE, letterCode, shiftOctave, typingAction } from './typing-keys';

/** The panel's settings (a subset of `LiveSettings`). */
export type LivePanel = Pick<
  LiveSettings,
  'single' | 'chord' | 'release' | 'glide' | 'stagger' | 'order'
>;

export const DEFAULT_PANEL: Readonly<LivePanel> = Object.freeze({
  single: DEFAULT_LIVE_SETTINGS.single,
  chord: DEFAULT_LIVE_SETTINGS.chord,
  release: DEFAULT_LIVE_SETTINGS.release,
  glide: DEFAULT_LIVE_SETTINGS.glide,
  stagger: DEFAULT_LIVE_SETTINGS.stagger,
  order: DEFAULT_LIVE_SETTINGS.order,
});

/**
 * Web MIDI: 'unsupported' (no API: Safari), 'off' (not asked yet), 'asking', 'ready', 'denied'
 * (refused, or the Firefox add-on not installed).
 */
export type MidiStatus = 'unsupported' | 'off' | 'asking' | 'ready' | 'denied';

export interface LiveUi {
  /** The Live drawer is open (live mode on or starting). */
  open: boolean;
  /** Live mode runs (the interactive engine started). */
  running: boolean;
  /** Musical typing is on. */
  typing: boolean;
  /** Octave of the A key's C. */
  octave: number;
  panel: LivePanel;
  midi: { status: MidiStatus; devices: MidiDevice[]; selected: string; error?: string };
}

const STORE_KEY = 'algorhythms.live';

/** The remembered panel and whether MIDI was connected before (guarded: storage may throw). */
function loadSaved(): { panel: LivePanel; midi: boolean } {
  try {
    const raw = globalThis.localStorage?.getItem(STORE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as { panel?: Partial<LivePanel>; midi?: boolean };
      const merged = mergeLiveSettings(DEFAULT_LIVE_SETTINGS, v.panel ?? {});
      return { panel: panelOf(merged), midi: v.midi === true };
    }
  } catch {
    // Defaults.
  }
  return { panel: { ...DEFAULT_PANEL }, midi: false };
}

function save(): void {
  try {
    const s = useLive.getState();
    globalThis.localStorage?.setItem(
      STORE_KEY,
      JSON.stringify({ panel: s.panel, midi: s.midi.status === 'ready' || midiRemembered }),
    );
  } catch {
    // Not remembered: the settings still apply for this page.
  }
}

function panelOf(s: Readonly<LiveSettings>): LivePanel {
  return {
    single: s.single,
    chord: s.chord,
    release: s.release,
    glide: s.glide,
    stagger: s.stagger,
    order: s.order,
  };
}

const saved = loadSaved();
let midiRemembered = saved.midi;

export const useLive = create<LiveUi>()(() => ({
  open: false,
  running: false,
  typing: false,
  octave: DEFAULT_OCTAVE,
  panel: saved.panel,
  midi: {
    status: hasWebMidi() ? 'off' : 'unsupported',
    devices: [],
    selected: ALL_INPUTS,
  },
}));

/** Where every live input presses and releases notes. */
export const liveInputs = new LiveInputHub(live);

// The mod wheel changes the glide in the engine: the panel follows.
live.subscribe(() => {
  const g = live.settings.glide;
  const s = useLive.getState();
  if (s.open && g !== s.panel.glide) useLive.setState({ panel: { ...s.panel, glide: g } });
});

// ---------------------------------------------------------------------------------------------
// Drawer and typing
// ---------------------------------------------------------------------------------------------

let session = 0;

/** Opens the Live drawer and enters live mode. Call from a user gesture. */
export function openLive(): void {
  const s = useLive.getState();
  if (s.open) return;
  const token = ++session;
  useLive.setState({ open: true, typing: true, running: false });
  enterLive({ ...s.panel }).then(
    () => {
      if (token !== session) return;
      useLive.setState({ running: true });
      liveInputs.resync();
    },
    (e: unknown) => {
      if (token !== session) return;
      pushNotice('error', 'Live mode could not start', [
        e instanceof Error ? e.message : String(e),
      ]);
      closeLive();
    },
  );
  if (midiRemembered && useLive.getState().midi.status === 'off') void connectMidi();
}

/** Closes the Live drawer and leaves live mode (playback works again). */
export function closeLive(): void {
  if (!useLive.getState().open) return;
  session++;
  releaseTyping();
  liveInputs.releaseAll();
  useLive.setState({ open: false, typing: false, running: false });
  void exitLive();
}

/** Opens or closes the drawer. */
export function toggleLive(open = !useLive.getState().open): void {
  if (open) openLive();
  else closeLive();
}

/** Turns musical typing on or off. */
export function setTyping(on: boolean): void {
  if (!on) releaseTyping();
  useLive.setState({ typing: on });
}

/** Moves the typing octave by `dir` (within the limits). */
export function moveOctave(dir: number): void {
  const s = useLive.getState();
  const octave = shiftOctave(s.octave, dir);
  if (octave !== s.octave) useLive.setState({ octave });
}

/** Changes panel settings; the engine uses them from the next change of the held notes. */
export function setPanel(patch: Partial<LivePanel>): void {
  const s = useLive.getState();
  const panel = panelOf(mergeLiveSettings({ ...DEFAULT_LIVE_SETTINGS, ...s.panel }, patch));
  useLive.setState({ panel });
  live.setSettings(patch);
  save();
}

// ---------------------------------------------------------------------------------------------
// Musical typing keys
// ---------------------------------------------------------------------------------------------

/** Note keys down: code → pitch played (kept, so an octave change releases the right note). */
const typingDown = new Map<string, Pitch>();

function releaseTyping(): void {
  typingDown.clear();
  liveInputs.release('keys');
}

function editorLayout(): boolean {
  return document.querySelector('.app[data-layout="full"]') !== null;
}

/**
 * Installs musical typing's key handlers (window, capture phase: before the editor's document
 * handlers, the lane's and React's); returns a function that removes them.
 */
export function attachLiveKeys(): () => void {
  const onDown = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || document.querySelector('dialog[open]') || !editorLayout()) return;
    const s = useLive.getState();
    const a = typingAction(e, s.typing, s.octave);
    if (!a) return;
    e.preventDefault();
    e.stopPropagation();
    if (a.kind === 'toggle') setTyping(!s.typing);
    else if (a.kind === 'octave') moveOctave(a.dir);
    else if (a.kind === 'note') {
      if (typingDown.has(a.code)) return;
      typingDown.set(a.code, a.pitch);
      if (!s.open) openLive();
      liveInputs.down('keys', a.pitch);
    }
  };
  const onUp = (e: KeyboardEvent): void => {
    const code = letterCode(e);
    if (code === null) return;
    const p = typingDown.get(code);
    if (p !== undefined) {
      typingDown.delete(code);
      liveInputs.up('keys', p);
    }
    // A letter's release is the mode's too (the N-held tracking for note points must not see it).
    if (p !== undefined || (useLive.getState().typing && typingAction(e, true) !== null)) {
      e.stopPropagation();
    }
  };
  const onBlur = (): void => releaseTyping();
  window.addEventListener('keydown', onDown, true);
  window.addEventListener('keyup', onUp, true);
  window.addEventListener('blur', onBlur);
  return () => {
    window.removeEventListener('keydown', onDown, true);
    window.removeEventListener('keyup', onUp, true);
    window.removeEventListener('blur', onBlur);
    releaseTyping();
  };
}

// ---------------------------------------------------------------------------------------------
// Web MIDI
// ---------------------------------------------------------------------------------------------

/** MIDI messages to the live engine (notes through the hub, so they merge with the others). */
export const midiSink: MidiSink = {
  noteOn: (p, v) => liveInputs.down('midi', p, v),
  noteOff: (p) => liveInputs.up('midi', p),
  sustain: (on) => live.sustain(on),
  modWheel: (cc) => live.modWheel(cc),
  bend: (v14) => live.bend(bendFromMidi(v14, live.settings.bendRange)),
  allNotesOff: () => liveInputs.release('midi'),
};

let midi: MidiInputs | null = null;

function setMidi(patch: Partial<LiveUi['midi']>): void {
  useLive.setState((s) => ({ midi: { ...s.midi, ...patch } }));
}

/**
 * Asks for Web MIDI (Firefox: the site-permission add-on prompt) and listens to the inputs.
 * `access` replaces navigator.requestMIDIAccess (tests).
 */
export async function connectMidi(access?: () => Promise<MidiAccessLike>): Promise<void> {
  const request =
    access ??
    (hasWebMidi()
      ? () => navigator.requestMIDIAccess({ sysex: false }) as unknown as Promise<MidiAccessLike>
      : null);
  if (!request) {
    setMidi({ status: 'unsupported' });
    return;
  }
  if (midi) return;
  setMidi({ status: 'asking', error: undefined });
  try {
    const a = await request();
    (midi as MidiInputs | null)?.close(); // a second connect finished first
    midi = new MidiInputs(a, midiSink, (devices) => {
      const sel = useLive.getState().midi.selected;
      const keep = sel === ALL_INPUTS || devices.some((d) => d.id === sel);
      setMidi({ devices, ...(keep ? {} : { selected: ALL_INPUTS }) });
    });
    const sel = useLive.getState().midi.selected;
    if (sel !== ALL_INPUTS) midi.select(sel);
    setMidi({ status: 'ready' });
    midiRemembered = true;
    save();
  } catch (e) {
    setMidi({ status: 'denied', error: e instanceof Error ? e.message : String(e) });
    midiRemembered = false;
    save();
  }
}

/** Listens to all inputs or one. */
export function selectMidi(id: string): void {
  setMidi({ selected: id });
  midi?.select(id);
}

/** Stops listening to MIDI (tests). */
export function disconnectMidi(): void {
  midi?.close();
  midi = null;
  setMidi({ status: hasWebMidi() ? 'off' : 'unsupported', devices: [], selected: ALL_INPUTS });
}
