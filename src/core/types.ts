/**
 * AlgoRhythms shared data contracts (PLAN.md §5, §6.1–6.2, §7.9, §8.5, §8.6).
 *
 * This file is shared by agents working in parallel. Extend it; do not rename or reshape existing
 * fields without recording the change in docs/build-log.md.
 *
 * Conventions:
 * - Types describe the *parsed* piece, i.e. what the compiler receives after the Zod schema (M1)
 *   has validated a file and filled defaults. A field without `?` is always present after parsing,
 *   even if a file may omit it; `@default` notes say what the schema fills in. A field with `?`
 *   may be absent after parsing, and consumers apply the documented fallback.
 * - Unknown fields survive load and save (§5); the schema is passthrough, so these interfaces
 *   are the known subset of what a parsed object may carry.
 * - Times are seconds from the start of the piece. Pitches are fractional MIDI note numbers.
 *
 * This module contains types and a few constants only, so every layer may import it.
 */

// ---------------------------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------------------------

/** Seconds from the start of the piece (D9: the model's time unit is seconds). */
export type Seconds = number;

/** Fractional MIDI note number; 69 = A4. Converted to Hz only at synthesis time. */
export type Pitch = number;

/** Stable voice id, e.g. "v1". Never used for ordering: ties break by pool index (§7.2). */
export type VoiceId = string;

/**
 * Stable moment id: 6 base62 characters, assigned at creation. Load-bearing, because it seeds
 * the moment's randomness (§7.7).
 */
export type MomentId = string;

/** The value of `Piece.format`. */
export const PIECE_FORMAT = 'algorhythms';

/** The newest `Piece.version` this build understands; migrations only run forward (§5). */
export const PIECE_VERSION = 1;

/** Maximum size of the voice pool (§5, owner decision §16.6). */
export const MAX_VOICES = 32;

// ---------------------------------------------------------------------------------------------
// Keys and scales
// ---------------------------------------------------------------------------------------------

/** A pitch class by name. Sharps and flats are both accepted; they are enharmonic. */
export type PitchClass =
  | 'C'
  | 'C#'
  | 'Db'
  | 'D'
  | 'D#'
  | 'Eb'
  | 'E'
  | 'F'
  | 'F#'
  | 'Gb'
  | 'G'
  | 'G#'
  | 'Ab'
  | 'A'
  | 'A#'
  | 'Bb'
  | 'B';

/** Built-in scales. The interval tables live in core/scales (M1). */
export type ScaleName =
  | 'major'
  | 'minor'
  | 'ionian'
  | 'dorian'
  | 'phrygian'
  | 'lydian'
  | 'mixolydian'
  | 'aeolian'
  | 'locrian'
  | 'harmonic-minor'
  | 'melodic-minor'
  | 'pentatonic-major'
  | 'pentatonic-minor'
  | 'blues'
  | 'whole-tone'
  | 'chromatic';

/** A scale: a built-in name, or explicit semitone offsets from the tonic. */
export type ScaleRef =
  | ScaleName
  | {
      kind: 'custom';
      /** Optional display name. */
      name?: string;
      /** Semitone offsets from the tonic: ascending, unique, each in [0, 12), starting with 0. */
      intervals: number[];
    };

/** A key: tonic plus scale. Changed over time by `key` moments; see CompiledScore.keys. */
export interface Key {
  /** The tonic's pitch class. */
  tonic: PitchClass;
  /** The scale built on the tonic. */
  scale: ScaleRef;
}

// ---------------------------------------------------------------------------------------------
// Glides and easing
// ---------------------------------------------------------------------------------------------

/**
 * An easing curve e(x) on x ∈ [0, 1] with e(0) = 0 and e(1) = 1 (§7.6). Applied in pitch space.
 * `bezier` uses CSS cubic-bezier semantics: x1 and x2 must lie in [0, 1]; y1 and y2 are free,
 * so a bézier may overshoot.
 */
export type EaseRef =
  | 'smootherstep'
  | 'smoothstep'
  | 'cosine'
  | 'linear'
  | 'expo'
  | { kind: 'bezier'; x1: number; y1: number; x2: number; y2: number };

/** Order in which stagger offsets are handed out across the affected voices (§5). */
export type GlideOrder = 'random' | 'low-first' | 'high-first' | 'center-out' | 'outside-in';

/** How voices travel to a moment's targets. */
export interface Glide {
  /** Glide duration per voice, in seconds. */
  length: Seconds;
  /** 0..1. Each voice's length varies by ±jitter·length (seeded). */
  jitter: number;
  /** Spread of start times across the affected voices, in seconds. */
  stagger: Seconds;
  /** Which voices start first within the stagger. */
  order: GlideOrder;
  /** Easing curve of each glide. */
  ease: EaseRef;
}

// ---------------------------------------------------------------------------------------------
// Voices, selectors and note sets
// ---------------------------------------------------------------------------------------------

/** One entry of the voice pool. Its index in `Piece.voices` is its *pool index*. */
export interface VoiceDef {
  /** Stable id, unique within the piece. */
  id: VoiceId;
  /** Display name. */
  name?: string;
  /** CSS color, used when `view.colors` is 'custom'. */
  color?: string;
  /** Key into `Piece.timbres`, or the name of a built-in preset. */
  timbre: string;
  /** Stereo position -1 (left) .. 1 (right), or 'auto' (by index or pitch, per `mix.panAuto`). */
  pan: number | 'auto';
  /** Linear gain. @default 1 */
  gain: number;
  /** Inclusive pitch range [low, high]. Out-of-range targets fold by octave (§7.8). */
  range: [Pitch, Pitch];
  /** Silenced in playback and exports; still compiled and drawn. */
  mute?: boolean;
  /** When any voice is soloed, only soloed voices are heard. */
  solo?: boolean;
  /**
   * Per-voice FX send levels (linear 0..1) overriding `mix.sends`. A missing key falls back to
   * the mix default. Extension of §5 for the send-based FX in §8.6.
   */
  sends?: { reverb?: number; delay?: number };
}

/** Which voices a moment acts on, resolved at the moment's time (§6.1). */
export type VoiceSelector =
  /** All voices active at the moment's time. */
  | 'all'
  /** These voices, if active. */
  | { voices: VoiceId[] }
  /** By pitch order at that time, inclusive; 0 = lowest. Ties break by pool index. */
  | { rank: [number, number] };

/** A set of notes a moment moves voices to (§5, §7.3). */
export type NoteSet =
  /** Explicit pitches. */
  | { kind: 'pitches'; pitches: Pitch[] }
  /** A chord symbol such as "Am9", "F#m7b5", "C/E", or a Roman numeral in the key ("ii7"). */
  | { kind: 'chord'; symbol: string }
  /** 0-based scale degrees in the key in effect at the moment's time. May exceed the scale length. */
  | { kind: 'degrees'; degrees: number[] }
  /** The pitch classes sounding at the moment's time. */
  | { kind: 'current' };

/** How a chord-like NoteSet becomes k target pitches (§7.3). */
export type Voicing = 'even' | 'close' | 'nearest';

/** Voice-leading mode (§7.2): 'ordered' never crosses lines; 'free' (Hungarian) may. */
export type AssignMode = 'ordered' | 'free';

// ---------------------------------------------------------------------------------------------
// Moments (§6)
// ---------------------------------------------------------------------------------------------

/** Every v1 moment type (§6.2). `timbre` arrives in M6 (§6.3) and will extend this union. */
export type MomentType =
  'chord' | 'unison' | 'split' | 'merge' | 'shift' | 'spread' | 'walk' | 'pin' | 'key' | 'level';

/** Fields common to every moment (§6.1). */
export interface MomentBase {
  /** Stable id; seeds the moment's randomness (§7.7). */
  id: MomentId;
  /** Discriminant. */
  type: MomentType;
  /** Time of the moment. */
  at: Seconds;
  /** Which voices it acts on. Absent means 'all'. */
  target?: VoiceSelector;
  /** Merged over `Piece.defaults.glide` at compile time (§7.1 step 1). */
  glide?: Partial<Glide>;
  /** Explicit seed; when absent the effective seed is hash32(piece.seed, id) (§7.7). */
  seed?: number;
  /** User label shown on the lane. */
  label?: string;
  /** Skipped by the compiler, still shown on the lane. */
  muted?: boolean;
}

/** Moves the targeted voices to a voicing of `notes`; the voice count is unchanged. */
export interface ChordMoment extends MomentBase {
  type: 'chord';
  /** Target notes. */
  notes: NoteSet;
  /** @default 'even' */
  voicing: Voicing;
  /** Candidate register [low, high]; absent means the union of the targeted voices' ranges. */
  register?: [Pitch, Pitch];
  /** @default 'ordered' */
  assign: AssignMode;
}

/** All targeted voices go to one pitch (or its nearest octaves). */
export interface UnisonMoment extends MomentBase {
  type: 'unison';
  /** The pitch, or 'center' (middle of the targeted voices) or 'tonic' (of the key in effect). */
  pitch: Pitch | 'center' | 'tonic';
  /** Each voice goes to the nearest octave of the pitch class instead. */
  octaves: boolean;
}

/** Raises the active count to `count` by births from dormant pool voices (§7.4). */
export interface SplitMoment extends MomentBase {
  type: 'split';
  /** Active voice count after the split. */
  count: number;
  /** Target notes; absent means { kind: 'current' }. */
  notes?: NoteSet;
  /** @default 'even' */
  voicing: Voicing;
}

/** Which voices die in a merge. */
export type MergeWhich = 'top' | 'bottom' | 'inner' | 'outer' | 'random';

/** Lowers the active count; each dying voice glides into a survivor, then fades out (§7.4). */
export interface MergeMoment extends MomentBase {
  type: 'merge';
  /** Active voice count after the merge. */
  count: number;
  /** Which voices die. */
  which: MergeWhich;
  /** Fade-out length after the dying voice's glide ends. */
  fade: Seconds;
}

/** Transposes the targeted voices. */
export interface ShiftMoment extends MomentBase {
  type: 'shift';
  /** Amount, in `unit`s; may be negative. */
  by: number;
  /** Scale steps count in the key in effect; off-scale pitches snap first (§7.8). */
  unit: 'semitones' | 'scaleSteps';
}

/** Scales pitches around a centre: p → c + factor·(p − c), then snaps. */
export interface SpreadMoment extends MomentBase {
  type: 'spread';
  /** Above 1 widens the voicing; below 1 squeezes it. */
  factor: number;
  /** The centre c. */
  around: Pitch | 'mean' | 'median';
  /** Snapping after scaling; 'scale' uses the key in effect, ties downward (§7.8). */
  snap: 'scale' | 'chromatic' | 'none';
}

/** Region moment: independent stepwise melodies that keep pitch order (§6.2, §7.1). */
export interface WalkMoment extends MomentBase {
  type: 'walk';
  /** End of the region; ticks run at at, at + grid, … while < until. */
  until: Seconds;
  /** Tick spacing. */
  grid: Seconds;
  /** 0..1: probability that an eligible voice steps on a tick. */
  density: number;
  /** Allowed steps in scale steps. @default [-2, -1, 1, 2] */
  steps: number[];
  /** Glide length of each step. */
  stepGlide: Seconds;
  /** When present, the lowest voice leaps by a random interval in [min, max] semitones. */
  bass?: { leap: [number, number] };
}

/** Moves one voice to an exact pitch; may cross other voices. */
export interface PinMoment extends MomentBase {
  type: 'pin';
  /** The voice to move. */
  voice: VoiceId;
  /** Its target pitch. */
  pitch: Pitch;
}

/** Changes the key from `at` onwards; no pitch effect. */
export interface KeyMoment extends MomentBase {
  type: 'key';
  /** The new key. */
  key: Key;
}

/** Ramps the targeted voices' level to `gain` over `over` seconds. */
export interface LevelMoment extends MomentBase {
  type: 'level';
  /** Target linear level (1 = unchanged). */
  gain: number;
  /** Ramp length. */
  over: Seconds;
}

/** Any v1 moment, discriminated by `type`. */
export type Moment =
  | ChordMoment
  | UnisonMoment
  | SplitMoment
  | MergeMoment
  | ShiftMoment
  | SpreadMoment
  | WalkMoment
  | PinMoment
  | KeyMoment
  | LevelMoment;

/** Look up a moment interface by its type, e.g. `MomentOf<'walk'>`. */
export type MomentOf<T extends MomentType> = Extract<Moment, { type: T }>;

// ---------------------------------------------------------------------------------------------
// Timbre (§8.5)
// ---------------------------------------------------------------------------------------------

/** A voice's sound. Built-in presets are referenced by name; `Piece.timbres` adds or overrides. */
export interface Timbre {
  /** Amplitudes of partials 1..32 (index 0 = fundamental); used to build the wavetables. */
  harmonics: number[];
  /** Inharmonicity: partial n sits at n^(1 + stretch). Nonzero uses the additive path (M6). */
  stretch: number;
  /** Two-operator phase modulation (M6). Ratio is modulator/carrier frequency. */
  fm?: { ratio: number; index: number; indexTrack: number };
  /** Breath noise through a band-pass tracking f (M6). */
  noise?: { level: number; bandwidth: number };
  /** Spectral tilt in dB/octave, and how strongly the tilt follows pitch. */
  brightness: { tilt: number; track: number };
  /** Extra detune spread across voices, in cents; can't take any voice below 1 cent (§8.4). */
  detuneSpread: number;
  /** Amount by which motion raises the level: gain · (1 + accent · motion). */
  accent: number;
  /** Attack–decay envelope triggered when a glide arrives at a new pitch. */
  articulation: { amount: number; attack: Seconds; decay: Seconds };
  /**
   * Vibrato after arrival only: rate in Hz, depth in cents, onset delay in seconds. `jitter`
   * (0..1, default 0) varies rate and depth per voice and slowly over time, so vibrato is not
   * perfectly periodic.
   */
  vibrato: { rate: number; depthCents: number; delay: Seconds; jitter?: number };
  /**
   * Fixed-frequency formants: resonances at `hz` (centre, Hz) with bandwidth `bw` (Hz) and linear
   * peak `gain`, summed into an envelope that weights each harmonic by its frequency in Hz. The
   * vowel then stays put as the pitch moves. Absent = no formant shaping.
   */
  formants?: { hz: number; bw: number; gain: number }[];
  /**
   * Slow seeded random wander, different per voice: pitch by up to about ±`cents`, changing at
   * roughly `rate` Hz, and optionally amplitude by about ±`amp` (a fraction). Absent = none.
   */
  drift?: { cents: number; rate: number; amp?: number };
}

// ---------------------------------------------------------------------------------------------
// Mix (§8.6)
// ---------------------------------------------------------------------------------------------

/**
 * Master FX settings. Every effect except tone and limiter is a send (§8.6), so stems sum
 * exactly (§12). All levels are linear amplitude unless the name says dB.
 */
export interface MixSettings {
  /** Feedback-delay-network reverb: 8 lines, Householder matrix, damping. */
  reverb: {
    /** 0..1: scales the delay-line lengths (room size). */
    size: number;
    /** Decay time (RT60) in seconds. */
    decay: Seconds;
    /** 0..1: high-frequency damping in the feedback loop. */
    damping: number;
    /** Pre-delay before the network, in seconds. */
    preDelay: Seconds;
    /** Linear level of the reverb return into the master sum. */
    returnLevel: number;
  };
  /** Stereo ping-pong delay on its own send. */
  delay: {
    /** Delay time in seconds. */
    time: Seconds;
    /** Feedback gain, 0..<1. */
    feedback: number;
    /** Linear level of the delay return into the master sum. */
    returnLevel: number;
  };
  /** Default send levels (linear 0..1) for every voice; `VoiceDef.sends` overrides per voice. */
  sends: { reverb: number; delay: number };
  /** Master tone: linear, so it distributes over stems. */
  tone: {
    /** Tilt EQ in dB/octave around ~1 kHz; positive is brighter. */
    tilt: number;
    /** Low-pass cutoff in Hz; at or above Nyquist means off. */
    lowpassHz: number;
  };
  /** Look-ahead (5 ms) peak limiter; always on (§8.8). */
  limiter: {
    /** Output ceiling in dBFS. @default -1 */
    ceilingDb: number;
  };
  /** How voices with `pan: 'auto'` are placed: spread by pool index, or by current pitch. */
  panAuto: 'index' | 'pitch';
}

// ---------------------------------------------------------------------------------------------
// View (§10, §11)
// ---------------------------------------------------------------------------------------------

/** How score lines are colored (§10). */
export type LineColors = 'ink' | 'voice' | 'pitch' | 'custom';

/** View settings stored with the piece. Theme and other per-user preferences are not here. */
export interface ViewSettings {
  /** Visible time window in seconds: 2 s up to the whole piece, on a log slider. */
  window: Seconds;
  /** Line coloring mode; 'custom' uses `VoiceDef.color`. */
  colors: LineColors;
  /** Show the heads-up display. */
  hud: boolean;
  /** Snapping grid in beats per minute; absent means no grid. Snapping only (D9). */
  gridBpm?: number;
  /** 0..1 opacity of the future lines (the "ghost") during playback. @default 0 */
  futureOpacity?: number;
  /** Playhead position as a fraction of the view width. @default 0.78 */
  playheadX?: number;
}

// ---------------------------------------------------------------------------------------------
// Piece (§5)
// ---------------------------------------------------------------------------------------------

/** Tuning system. Only 12-TET ships in v1; Scala is Later. */
export type TuningSystem = { kind: '12tet' } | { kind: 'scala'; scl: string; kbm?: string };

/** The document the user edits: a few KB of JSON (P4). */
export interface Piece {
  /** Always 'algorhythms'. */
  format: typeof PIECE_FORMAT;
  /** Schema version; migrations are keyed on it. */
  version: 1;
  /** Title and bookkeeping; `created`/`modified` are ISO 8601 strings. */
  meta: { title: string; author?: string; created: string; modified: string };
  /** Piece seed; per-moment seeds derive from it (§7.7). The DSP also seeds phases from it. */
  seed: number;
  /** Tuning: Hz of pitch 69 and the tuning system. */
  tuning: {
    /** Hz of pitch 69 (A4). @default 440 */
    referenceHz: number;
    /** Tuning system. */
    system: TuningSystem;
  };
  /** Initial key; `key` moments change it. */
  key: Key;
  /** Defaults merged under each moment's partial glide. */
  defaults: { glide: Glide };
  /** The voice pool (max 32). Array index = pool index, used for every tie-break. */
  voices: VoiceDef[];
  /** Voices active and holding at t = 0. */
  start: { voice: VoiceId; pitch: Pitch }[];
  /** All moments. Array order breaks ties between moments with equal `at`. */
  moments: Moment[];
  /** Timbre presets referenced by `VoiceDef.timbre`, adding to or overriding built-ins. */
  timbres: Record<string, Timbre>;
  /** Master FX. */
  mix: MixSettings;
  /** End of the piece: `at` absent means last activity + 4 s; `fade` is the closing fade. */
  end: { at?: Seconds; fade: Seconds };
  /** View settings. */
  view: ViewSettings;
}

// ---------------------------------------------------------------------------------------------
// Compiled score (§7.9)
// ---------------------------------------------------------------------------------------------

/**
 * One piece of a voice's pitch path:
 *
 *   p(x) = p0 + (p1 − p0)·ease(x) + m0·(x³ − 2x² + x),   x = (t − t0)/(t1 − t0) ∈ [0, 1]
 *
 * or, for a segment cut short by an interruption (`curve` present, M1 extension):
 *
 *   p(x) = p0 + (curve.p1 − p0)·ease(x) + m0·H(x),   x = (t − t0)/(curve.t1 − t0) ∈ [0, x(t1)]
 *
 * Evaluate with core/segment.ts `evalSegment`, never by hand (P1). p(t0) = p0 and p(t1) = p1
 * exactly. A hold is p0 === p1 with m0 absent or 0 and no `curve`.
 */
export interface Segment {
  /** Start time. */
  t0: Seconds;
  /** End time; t1 >= t0. */
  t1: Seconds;
  /** Pitch at t0. */
  p0: Pitch;
  /** Pitch at t1. */
  p1: Pitch;
  /** Easing curve requested by the moment (kept through interruptions, §7.5). */
  ease: EaseRef;
  /** Carried-velocity term from an interruption, in semitones; 0 if absent. */
  m0?: number;
  /** The overshoot clamp reduced m0, so the join at t0 is C⁰ only (§7.5). */
  clamped?: boolean;
  /**
   * Present when the glide was interrupted (§7.5 "truncate S at tᵢ"): it was planned to reach
   * `curve.p1` at `curve.t1`, but stopped at t1 (< curve.t1), where its pitch is p1. The curve keeps
   * that planned parametrisation, so the part that sounded is unchanged. M1 extension; absent means
   * curve = { t1, p1 }.
   */
  curve?: { t1: Seconds; p1: Pitch };
  /** The moment that produced this segment, for selection highlighting (§11.3). */
  momentId?: MomentId;
}

/**
 * One audible life span of a voice. Life gain is 0 before `born` and after `died`; it rises from
 * 0 to 1 over [born, born + fadeIn] and falls from 1 to 0 over [died − fadeOut, died]. The fade
 * shape is the DSP's (M2); MIDI CC11 export follows it.
 */
export interface Life {
  /** Audible onset: start of the fade-in; equals the t0 of the life's first segment. */
  born: Seconds;
  /** End of the fade-out, when the voice is silent and dormant again; absent = alive at the end. */
  died?: Seconds;
  /** Fade-in length; max(0.5 s, glide length / 2) for births (§7.4); 0 for voices active at 0. */
  fadeIn: Seconds;
  /** Fade-out length, ending at `died`; 0 if absent. */
  fadeOut?: Seconds;
}

/** A timbre change: crossfade to `preset` over `fade` seconds starting at `t`. */
export interface TimbreChange {
  /** Start of the crossfade. */
  t: Seconds;
  /** Key into Piece.timbres or a built-in preset name. */
  preset: string;
  /** Crossfade length; 0 = instant (used for the initial entry at t = 0). */
  fade: Seconds;
}

/** A level change: ramp linearly in amplitude from the level in effect at `t` to `gain`. */
export interface LevelChange {
  /** Start of the ramp. */
  t: Seconds;
  /** Target linear level. */
  gain: number;
  /** Ramp length; 0 = step. */
  over: Seconds;
}

/** One pool voice's compiled output. */
export interface CompiledVoice {
  /** Voice id, as in Piece.voices. */
  id: VoiceId;
  /** Pool index; equals this voice's index in CompiledScore.voices and Piece.voices. */
  index: number;
  /**
   * Life spans, sorted and non-overlapping. Empty if the voice never sounds. Voice state used for
   * targeting ("active from the birth moment's time", §7.1) is compiler-internal.
   */
  lives: Life[];
  /** Sorted segments, contiguous within each life (seg[i].t1 === seg[i+1].t0); gaps between lives. */
  segments: Segment[];
  /** Timbre timeline, sorted; the first entry is { t: 0, preset: VoiceDef.timbre, fade: 0 }. */
  timbre: TimbreChange[];
  /** Level timeline, sorted; the level is 1 before the first entry. */
  level: LevelChange[];
  /** Static linear gain from VoiceDef.gain. Extension of §7.9, so the DSP needs only this score. */
  gain: number;
  /** Static pan from VoiceDef.pan. Extension of §7.9. */
  pan: number | 'auto';
  /** VoiceDef.mute, defaulted to false. Extension of §7.9. */
  mute: boolean;
  /** VoiceDef.solo, defaulted to false. Extension of §7.9. */
  solo: boolean;
  /** VoiceDef.sends overrides; a missing key means "use mix.sends". Extension of §7.9. */
  sends: { reverb?: number; delay?: number };
}

/** Severity of a compiler diagnostic. */
export type DiagnosticLevel = 'info' | 'warn' | 'error';

/** A message from the compiler, shown in the inspector next to its moment (§11.3). */
export interface Diagnostic {
  /** The moment it concerns; absent for piece-level messages. */
  momentId?: MomentId;
  /** Severity. 'error' means the moment (or the piece) was not applied as written. */
  level: DiagnosticLevel;
  /** Stable kebab-case identifier for tests and UI, e.g. 'pool-exhausted', 'chord-parse'. */
  code: string;
  /** Human-readable explanation. */
  message: string;
}

/** The time a moment's moves occupy, for the editor's glide bars (§7.9). */
export interface MomentSpan {
  /** The moment. */
  id: MomentId;
  /** Earliest move start. */
  start: Seconds;
  /** Latest move end. */
  end: Seconds;
}

/** A key in effect from `t` until the next entry (§6.2 `key`). */
export interface KeyChange {
  /** When the key takes effect. */
  t: Seconds;
  /** The key from `t` on. */
  key: Key;
}

/** Output of `compile(piece)` (§7.9): what audio, picture and MIDI all read (P1). */
export interface CompiledScore {
  /** Time at which the last life has died: the end of the piece's sound before FX tails. */
  duration: Seconds;
  /** One entry per pool voice, in pool order (voices[i].index === i), including never-active ones. */
  voices: CompiledVoice[];
  /** Per-moment spans, for the moment lane. */
  momentSpans: MomentSpan[];
  /** Compiler messages. */
  diagnostics: Diagnostic[];
  /** Key timeline, sorted; the first entry is { t: 0, key: piece.key }. Extension of §7.9. */
  keys: KeyChange[];
  /** Hz of pitch 69, copied from piece.tuning so the DSP needs only this score. Extension. */
  referenceHz: number;
  /** Piece seed, copied for the DSP's seeded phases and noise (§8.10). Extension. */
  seed: number;
}
