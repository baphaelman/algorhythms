/**
 * Live mode in the app (PLAN.md §9, §8.3): the one `LiveEngine`, and entering and leaving it.
 * Entering stops the transport, closes the playback context and opens an 'interactive' one with
 * the piece's voices at the playhead, its timbres and mix; leaving closes it and loads the piece
 * into a new 'playback' engine. The inputs (musical typing, Web MIDI, the piano ruler) and the
 * Live drawer call `live.noteOn` etc. (src/audio/live-engine.ts).
 *
 * Recording (§9 "Recording", record into silence; docs/build-log.md "M7-c"): `armRecord` takes
 * the playhead T₀, builds the piece the take replaces from T₀ (core/live-take `takeBase`) and
 * re-enters live mode on it, so the take starts in silence with the voices playback will use.
 * The transport then runs on the live clock (playhead = T₀ + live time since arming; only the
 * live voices sound). `stopRecord` waits for the last change's stamp, turns the changes into
 * moments (`takeMoments`) and writes base + take as one undo step, with the voices live mode added
 * to reach 4 (`takeVoices`). Pause, Space, Escape, closing
 * the drawer and leaving live mode all stop and keep the take; a take with no notes changes
 * nothing. Opening another piece drops it.
 */

import { create } from 'zustand';
import { LiveEngine } from '../audio/live-engine';
import { liveSetupFrom, type LiveSetup } from '../audio/live-setup';
import { compile } from '../core/compiler/compile';
import type { LiveSettings } from '../core/live';
import {
  takeBase,
  takeMoments,
  takeVoices,
  type TakeChange,
  type TakeVoice,
} from '../core/live-take';
import type { Moment, MomentId, Piece, Seconds, VoiceDef } from '../core/types';
import { beginLiveAudio, endLiveAudio, isLiveAudio } from './audio';
import { edit } from './editor/history';
import { newMomentIds } from './editor/ops';
import {
  currentTime,
  onLoadPiece,
  pause,
  reloadAudio,
  startRecordClock,
  stopRecordClock,
  usePlayer,
} from './store';

/** The live instrument. */
export const live = new LiveEngine();

// Mix edits while live (the Sound drawer's Master tab) reach the live engine at once; the playback
// engine's queued `mixAudio` job applies them after leaving. `setMix` also follows a `normalise`
// change with each voice's gain (live-setup `liveGains`).
usePlayer.subscribe((s, prev) => {
  if (s.piece.mix !== prev.piece.mix && live.active) live.setMix(s.piece.mix);
});

/** Enter, exit and recording run one after another. */
let busy: Promise<void> = Promise.resolve();

/** True while live mode is on (or being entered). */
export function isLive(): boolean {
  return isLiveAudio();
}

/**
 * Enters live mode. Call from a user gesture: the 'interactive' context is created before
 * anything is awaited. Resolves once the live voices run.
 */
export function enterLive(settings?: Partial<LiveSettings>): Promise<void> {
  if (isLiveAudio()) return busy;
  const context = new AudioContext({ latencyHint: 'interactive' });
  pause();
  const { piece, compiled } = usePlayer.getState();
  const setup = liveSetupFrom(piece, compiled, currentTime());
  const run = busy.then(async () => {
    await beginLiveAudio();
    try {
      await live.enter({ context, setup, settings });
    } catch (e) {
      if (context.state !== 'closed') await context.close();
      void endLiveAudio();
      reloadAudio();
      throw e;
    }
  });
  busy = run.catch(() => undefined);
  return run;
}

/** Leaves live mode (stopping a take first, which is kept). */
export function exitLive(): Promise<void> {
  void stopRecord();
  const run = busy.then(async () => {
    if (!isLiveAudio()) return;
    await live.exit();
    void endLiveAudio();
    reloadAudio();
  });
  busy = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------------------------

/** Recording state for the UI. */
export interface RecordState {
  /** off; starting (re-entering live on the take's base); recording; saving (writing it). */
  status: 'off' | 'starting' | 'recording' | 'saving';
  /** Piece time the take starts at (T₀), and the live time it maps to (once recording). */
  at: Seconds;
  liveAt: Seconds;
}

export const useRecord = create<RecordState>()(() => ({ status: 'off', at: 0, liveAt: 0 }));

interface Take {
  /** Piece time of the take start, and the live time it maps to. */
  T0: Seconds;
  liveAt: Seconds;
  /** When the take may first sound (after the cut-off fade, `takeBase`). */
  silentFrom: Seconds;
  /** Live voice ids, in live voice order. */
  voices: string[];
  /** The live voices as the piece gets them (voices added to reach 4 included), and new ones. */
  played: TakeVoice[];
  added: VoiceDef[];
  /** The take's slice of `live.changes`: from, and to (set at stop). */
  from: number;
  to: number;
}

let take: Take | null = null;

/** True while a take is starting or being recorded. */
export function isRecording(): boolean {
  const s = useRecord.getState().status;
  return s === 'starting' || s === 'recording';
}

/** Seconds recorded so far (0 when not recording). */
export function recordElapsed(): Seconds {
  return take && useRecord.getState().status === 'recording'
    ? Math.max(0, live.now() - take.liveAt)
    : 0;
}

/** Fresh moment ids, unique in `piece` and among each other. */
function idMaker(piece: Piece): () => MomentId {
  const used: Piece = { ...piece, moments: piece.moments.slice() };
  return () => {
    const [id] = newMomentIds(used, 1);
    used.moments.push({ id } as Moment);
    return id;
  };
}

/**
 * Arms recording while live: the take starts at the playhead and replaces the piece from there.
 * Call from a user gesture (it opens a new 'interactive' context). Resolves once recording runs.
 */
export function armRecord(): Promise<void> {
  if (!isLiveAudio() || useRecord.getState().status !== 'off') return busy;
  const context = new AudioContext({ latencyHint: 'interactive' });
  const T0 = currentTime();
  useRecord.setState({ status: 'starting', at: T0 });
  const run = busy.then(async () => {
    let silentFrom: Seconds;
    let setup: LiveSetup;
    try {
      if (!isLiveAudio() || useRecord.getState().status !== 'starting') {
        throw new Error('Recording was cancelled');
      }
      const { piece } = usePlayer.getState();
      const cut = takeBase(piece, T0, idMaker(piece));
      silentFrom = cut.silentFrom;
      setup = liveSetupFrom(cut.piece, compile(cut.piece), silentFrom);
      await live.enter({ context, setup });
    } catch (e) {
      if (useRecord.getState().status === 'starting') useRecord.setState({ status: 'off' });
      if (context.state !== 'closed') await context.close();
      if (!live.active && isLiveAudio()) {
        void endLiveAudio();
        reloadAudio();
        throw e;
      }
      return;
    }
    if (useRecord.getState().status !== 'starting') return; // stopped while starting
    const t: Take = {
      T0,
      liveAt: live.now(),
      silentFrom,
      voices: live.voiceIds,
      played: setup.voices.map((v) => ({
        id: v.id,
        timbre: v.timbre,
        part: v.part,
        mute: v.mute,
        solo: v.solo,
        ...(v.fill ? { fill: v.fill } : {}),
      })),
      added: setup.added ?? [],
      from: live.changes.length,
      to: -1,
    };
    take = t;
    startRecordClock(
      () => t.T0 + Math.max(0, live.now() - t.liveAt),
      () => void stopRecord(),
    );
    useRecord.setState({ status: 'recording', liveAt: t.liveAt });
  });
  busy = run.catch(() => undefined);
  return run;
}

/** Stops recording and writes the take (one undo step). Live mode stays on. */
export function stopRecord(): Promise<void> {
  const status = useRecord.getState().status;
  if (status === 'starting') useRecord.setState({ status: 'off' });
  const t = take;
  if (status !== 'recording' || !t) return busy;
  const stopLive = live.now();
  const stopAt = t.T0 + Math.max(0, stopLive - t.liveAt);
  t.to = live.changes.length;
  stopRecordClock(stopAt);
  useRecord.setState({ status: 'saving' });
  const run = busy.then(async () => {
    try {
      await live.settled();
      if (take === t) writeTake(t, stopLive, stopAt);
    } finally {
      if (take === t) take = null;
      if (useRecord.getState().status === 'saving') useRecord.setState({ status: 'off' });
    }
  });
  busy = run.catch(() => undefined);
  return run;
}

/** The take's changes as core/live-take reads them (each press at its first stamped time). */
function takeChanges(t: Take): TakeChange[] {
  const changes = live.changes.slice(t.from, t.to);
  const bySeq = new Map(changes.map((c) => [c.seq, c]));
  const out: TakeChange[] = [];
  for (const c of changes) {
    const stamp = (bySeq.get(c.press) ?? c).stamp ?? c.stamp;
    if (!stamp) continue;
    out.push({
      press: c.press,
      time: stamp.liveTime,
      held: c.held,
      settings: c.settings,
      seed: c.seed,
      update: c.update,
    });
  }
  return out;
}

function writeTake(t: Take, stopLive: Seconds, stopAt: Seconds): void {
  const changes = takeChanges(t);
  if (changes.length === 0) return;
  const sounding = live.snapshot(stopLive).voices.some((v) => v.level > 1e-4);
  edit((piece) => {
    const newId = idMaker(piece);
    const { piece: base } = takeBase(piece, t.T0, newId);
    const moments = takeMoments(changes, {
      at: t.T0,
      liveAt: t.liveAt,
      voices: t.voices,
      earliest: t.silentFrom,
      newId,
    });
    if (moments.length === 0) return piece;
    // Voices live mode added (fewer than 4 sounding) play the take back.
    const voiced = takeVoices(base, t.played, t.added, t.T0, newId);
    const out: Piece = { ...voiced, moments: [...voiced.moments, ...moments] };
    // Still sounding at the stop: the piece lasts at least until then.
    if (sounding && compile(out).duration < stopAt) {
      out.end = { ...out.end, at: Math.round(stopAt * 1000) / 1000 };
    }
    return out;
  }, 'Record take');
}

// Opening another piece drops a take being recorded (store.loadPiece stops its clock).
onLoadPiece(() => {
  if (useRecord.getState().status === 'off') return;
  take = null;
  useRecord.setState({ status: 'off' });
});
