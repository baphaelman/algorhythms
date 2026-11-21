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
export const PIECE_VERSION = 2;

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

/** When a moment's moving voices land (§5, §7.2; revision 6). */
export type GlideArrive = 'together' | 'spread';

/** How voices travel to a moment's targets. */
export interface Glide {
  /** Glide duration per voice, in seconds. */
  length: Seconds;
  /** 0..1. Each voice's length varies by ±jitter·length (seeded). */
  jitter: number;
  /** Spread of start times across the affected voices, in seconds. */
  stagger: Seconds;
  /**
   * 'together' (default; absent = 'together'): every voice the moment moves ends at one time,
   * at + stagger + length (jitter applied once). 'spread': each ends at its own start + length.
   */
  arrive?: GlideArrive;
  /**
   * Revision 9 "Land on the beat" (absent = false): `at` is when the voices arrive. The glide
   * starts length + stagger before `at` (clamped at 0, shortening the glide), and the moment
   * decides there. Point moments only (not key, level or walk).
   */
  land?: boolean;
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
   * Revision 9: a named group ("Melody", "Chords"). Distinct notes holds within a part: lines in
   * different parts never merge. Absent (or ''): the default group.
   */
  part?: string;
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
  | { rank: [number, number] }
  /** Revision 9: the active voices of that part (`VoiceDef.part`). */
  | { part: string };

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

/** Every moment type: the v1 catalog (§6.2) and `timbre` (M6, §6.3). */
export type MomentType =
  | 'chord'
  | 'unison'
  | 'split'
  | 'merge'
  | 'shift'
  | 'spread'
  | 'walk'
  | 'note'
  | 'pin'
  | 'key'
  | 'level'
  | 'pulse'
  | 'tune'
  | 'timbre';

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
  /**
   * Per-voice hand edits (§11.3 "Every dot is draggable", revision 6), applied by the compiler to
   * that voice's move in a point moment. A moment with overrides is not re-ordered (its lines may
   * cross). Key, level and walk moments ignore them.
   */
  overrides?: VoiceOverride[];
}

/** One per-voice override of a point moment's move (§11.3). */
export interface VoiceOverride {
  /** Pool index. */
  voice: number;
  /** Target pitch instead of the moment's (folded into the voice's range like any target). */
  pitch?: Pitch;
  /** The voice's arrival, as an offset from the moment's `at` (s). */
  end?: Seconds;
  /**
   * Revision 8: the weight of the note this voice ends on (1 = one line; a line of weight w
   * sounds at the power of w lines). Ramps over the glide length from `at`.
   */
  weight?: number;
}

/**
 * Moves the targeted voices to a voicing of `notes`; the voice count is unchanged. From silence
 * it *establishes* (schema v2, M4.5-27): its voices come in on their notes, with no glide (see
 * core/moments/establish.ts).
 */
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
  /**
   * Active voice count after the chord (revision 6), 1..pool size. Extra voices are born as in a
   * split; surplus voices die as in a merge (`which: 'outer'`, `fade` = the glide length).
   * Absent: the count is unchanged.
   */
  count?: number;
  /**
   * Set when the editor froze the chord for per-note editing (revision 6, §11.3): the `notes`
   * and `assign` it had before, restored by Unfreeze. The compiler ignores it.
   */
  frozenFrom?: { notes: NoteSet; assign: AssignMode };
  /**
   * Revision 6, "Keep lines in order" off: with a `pitches` NoteSet, pitch i goes to the i-th
   * targeted voice (by committed destination), unsorted, and lines may cross. Applies only when
   * there is one pitch per targeted voice and the voice count doesn't change. From silence,
   * pitch i goes to the i-th voice brought in (the target's listed voices, else pool order).
   */
  byVoice?: boolean;
}

/** All targeted voices go to one pitch (or its nearest octaves). From silence it establishes. */
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
  /**
   * Frozen walk (§6.2, revision 5): when present the walk draws nothing; on each listed tick each
   * listed voice glides to its pitch, unlisted voices hold. density, steps, bass and seed are ignored.
   */
  fixed?: WalkNote[];
}

/** One note of a frozen walk: the absolute target of `voice` at tick `tick` (§6.2). */
export interface WalkNote {
  /** Tick index: time = at + tick·grid. May be fractional (a step added between ticks, §11.3). */
  tick: number;
  voice: VoiceId;
  pitch: Pitch;
}

/** A step a walk took, or a frozen walk's note (§7.9, revision 5). */
export interface WalkStepRecord {
  momentId: MomentId;
  /** Tick index. */
  tick: number;
  voice: VoiceId;
  t: Seconds;
  from: Pitch;
  /** The pitch it glides to; equal to `from` for a frozen note that holds or is blocked. */
  to: Pitch;
  /** From the walk's `fixed` notes. */
  fixed: boolean;
}

/** One note change of a `note` moment: the sounding note `from` becomes `to`. */
export interface NoteChange {
  /** The sounding note to change (matched to the nearest committed destination within ½ semitone). */
  from: Pitch;
  /** Its new pitch. */
  to: Pitch;
}

/**
 * A note point (§6.2, revision 6): the sounding note `from` becomes `to`. With `order`, the target
 * set is the current pitches with one `from` replaced by `to`, reached by ordered voice leading
 * (§7.2); without, only that voice moves.
 *
 * Grouped note changes (§11.3 revision 7): `changes` holds several changes made at the same time
 * (one moment, shown as "Shift"); each matches a different voice. A moment has either `from` and
 * `to` (one change) or `changes`; read them through `noteChanges` (core/moments/note.ts).
 */
export interface NoteMoment extends MomentBase {
  type: 'note';
  /** One change: the sounding note to change (nearest committed destination within ½ semitone). */
  from?: Pitch;
  /** One change: its new pitch. */
  to?: Pitch;
  /** Several changes at once (instead of `from`/`to`), applied together. */
  changes?: NoteChange[];
  /** When present, the notes return this many seconds after their glides end. */
  back?: Seconds;
  /**
   * Keep lines in order (revision 6): true = ordered voice leading, no crossings; false or absent
   * = only the voices sounding the `from`s move, and may cross their neighbours.
   */
  order?: boolean;
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

/** How a pulse picks the voices it hits on each step (§6.2 `pulse`, revision 9). */
export type PulseMode = 'together' | 'up' | 'down' | 'updown' | 'random';

/**
 * Region moment (revision 9): a repeating volume pattern. Every `step` seconds from `at` while
 * `< until`, the next accent of `pattern` (cycling) hits; between `at` and `until` the targeted
 * voices sit at `floor` (times their level) except when hit. Multiplies the level; no pitch
 * effect. Compiled into per-voice `PulseRecord`s (core/pulse.ts documents the envelope).
 */
export interface PulseMoment extends MomentBase {
  type: 'pulse';
  /** End of the region; steps at at, at + step, … while < until. */
  until: Seconds;
  /** Step spacing (> 0). */
  step: Seconds;
  /** Accent per step, 0..1, cycling; 0 is a rest (no hit). Non-empty. */
  pattern: number[];
  /** Fall time from the accent to floor × accent. */
  decay: Seconds;
  /** 0..1: the level a hit falls to, and where the voices sit between hits. */
  floor: number;
  /** 'together' hits every targeted voice; the others one voice per step, in pitch order. */
  mode: PulseMode;
  /** Each hit re-strikes the timbre's articulation. Absent means true. */
  strike?: boolean;
}

/** One note of a tune (revision 9): its pitch, held for `len` seconds. */
export interface TuneNote {
  pitch: Pitch;
  /** How long the note lasts (> 0); the next note starts `len` after this one. */
  len: Seconds;
}

/**
 * Revision 9: a melody on one line. From `at`, the targeted voice (the first in pitch order of
 * the target, normally a part with one line) moves to each note in turn, note k starting at
 * at + the lengths before it. Each move uses the moment's glide as portamento (default length
 * 0.1 s, stagger and jitter 0; capped at the note's length). With `glide.land` each note
 * arrives on its start instead. Like `pin` it may cross other lines; under distinct notes it
 * merges only with lines of its own part.
 */
export interface TuneMoment extends MomentBase {
  type: 'tune';
  notes: TuneNote[];
}

/**
 * M6 (§6.3): crossfades the targeted voices to another timbre from `at` over `fade`; no pitch
 * effect. Unlike other moments it also changes voices that are silent at `at` (a later birth
 * sounds the new timbre): 'all', `{ voices }` and `{ part }` pick pool voices whether sounding or
 * not; `{ rank }` picks sounding voices by pitch order. `glide` and `overrides` are ignored.
 */
export interface TimbreMoment extends MomentBase {
  type: 'timbre';
  /** Key into `Piece.timbres`, or a built-in preset name. */
  preset: string;
  /** Crossfade length (≥ 0; 0 = instant). */
  fade: Seconds;
}

/** Any moment, discriminated by `type`. */
export type Moment =
  | ChordMoment
  | UnisonMoment
  | SplitMoment
  | MergeMoment
  | ShiftMoment
  | SpreadMoment
  | WalkMoment
  | NoteMoment
  | PinMoment
  | KeyMoment
  | LevelMoment
  | PulseMoment
  | TuneMoment
  | TimbreMoment;

/** Look up a moment interface by its type, e.g. `MomentOf<'walk'>`. */
export type MomentOf<T extends MomentType> = Extract<Moment, { type: T }>;

// ---------------------------------------------------------------------------------------------
// Timbre (§8.5)
// ---------------------------------------------------------------------------------------------

/** A voice's sound. Built-in presets are referenced by name; `Piece.timbres` adds or overrides. */
export interface Timbre {
  /** Amplitudes of partials 1..32 (index 0 = fundamental); used to build the wavetables. */
  harmonics: number[];
  /**
   * Inharmonicity, −0.5..1: partial n sits at n^(1 + stretch). Nonzero uses the additive path
   * (M6): the first 16 partials, each from its own sine.
   */
  stretch: number;
  /**
   * Two-operator phase modulation (M6): the carrier is read at φ + β/2π·sin(2π·φm), φm running at
   * `ratio` × f (0 < ratio ≤ 32, any real). `index` is β at middle C in radians (0..20); it
   * scales by 2^(−indexTrack) per octave above middle C, and the engine lowers it further where
   * sidebands would pass Nyquist. Harmonic (or partial) n of the carrier sees n·β.
   */
  fm?: { ratio: number; index: number; indexTrack: number };
  /**
   * Breath noise (M6): white noise through a band-pass centred on f, of −3 dB width
   * `bandwidth`·f (0 < bandwidth ≤ 8), at `level` (0..4) times the tone's RMS, under the voice's
   * envelope.
   */
  noise?: { level: number; bandwidth: number };
  /** Spectral tilt in dB/octave, and how strongly the tilt follows pitch. */
  brightness: { tilt: number; track: number };
  /**
   * Extra detune spread across voices, in cents; can't take any voice below 1 cent (§8.4). Voices
   * that meet on one pitch mid-glide still lock into one steady tone.
   */
  detuneSpread: number;
  /** Amount by which motion raises the level: gain · (1 + accent · motion). */
  accent: number;
  /**
   * Attack–decay envelope triggered when a glide arrives at a new pitch. A soft strike (not
   * `crisp`) blooms: its attack is at least 50 ms·√amount, and strikes landing together share one
   * bloom. A crisp strike keeps its attack (≥ 12 ms). Absent `crisp`: amount ≥ 0.5 (pluck).
   */
  articulation: { amount: number; attack: Seconds; decay: Seconds; crisp?: boolean };
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
  /**
   * Unison wobble, in cents. Revision 8: read and ignored (`info wobble-ignored`), since lines
   * never rest on one pitch; the engine no longer reads it.
   */
  wobble?: number;
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
export type LineColors = 'ink' | 'pitch' | 'custom';

/** How the view follows the playhead (§10 revision 5): playhead at 35 %, page turns, or never. */
export type FollowMode = 'smooth' | 'page' | 'off';

/** View settings stored with the piece. Theme and other per-user preferences are not here. */
export interface ViewSettings {
  /** Visible time window in seconds: 2 s up to the whole piece, on a log slider. */
  window: Seconds;
  /** Line coloring mode; 'custom' uses `VoiceDef.color`. */
  colors: LineColors;
  /** Show the heads-up display. */
  hud: boolean;
  /**
   * Tempo of the drawn bar grid, beats per minute (D9). Revision 7: drawn only, not a default snap
   * target; absent draws bars at 60 bpm.
   */
  gridBpm?: number;
  /**
   * "Snap to beats" (revision 9): with a tempo (`gridBpm`), adding and dragging moments, dots and
   * note points snap to its beats. Absent = on when the piece has a tempo; false turns it off.
   */
  snapBeats?: boolean;
  /** Beats per bar of the drawn bar grid (revision 7). @default 4 */
  meter?: number;
  /** 0..1 opacity of the future (not yet played) lines. @default 0.35 (revision 5; was 0) */
  futureOpacity?: number;
  /** Unused since revision 5 (Smooth follow holds the playhead at 35 %); kept so files load. */
  playheadX?: number;
  /** Follow mode the view opens with (§10). @default 'smooth' */
  follow?: FollowMode;
  /** Loop region (§11.3 revision 6); absent means none. */
  loop?: LoopRegion;
}

/** A loop region [start, end) in seconds; `on: false` keeps it without looping (§11.3). */
export interface LoopRegion {
  start: Seconds;
  end: Seconds;
  /** Whether playback loops it. @default true */
  on?: boolean;
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
  version: typeof PIECE_VERSION;
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
  /**
   * Merges and splits crossfade (owner 2026-11-21): the fade-in (a split's newborn) or fade-out
   * (a line merging, ending where it meets the merged line) follows core/ease `crossfade` in
   * power, √X in amplitude, matched by a `cross` weight change on the parent or merged line.
   */
  crossIn?: true;
  crossOut?: true;
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

/**
 * A pulse record (revision 9 `pulse`; envelope in core/pulse.ts). From `t` until the voice's next
 * record the pulse gain is accent·(floor + (1 − floor)·(1 − u)³), u = (t' − t)/decay, and
 * accent·floor once u ≥ 1 (or when decay is 0). A hit (`hit`) is one step of a pulse; a boundary
 * (no `hit`) has accent 1 and decay 0: it puts the voice at `floor` when it joins a pulse, or back
 * at 1 (floor 1) when the pulse ends.
 */
export interface PulseRecord {
  t: Seconds;
  /** 0..1. */
  accent: number;
  /** Fall time (≥ 0). */
  decay: Seconds;
  /** 0..1. */
  floor: number;
  /** Re-strike the timbre's articulation (hits only). */
  strike: boolean;
  /** A step's hit; absent on a boundary. */
  hit?: true;
}

/**
 * A weight change (revision 8, "Distinct notes"): a line of weight w sounds at the power of w
 * lines (√w amplitude). Changes add up (crossfades 2026-11-21): change k adds w_k − w_(k−1)
 * (w_(−1) = 1) over [t − lead, t − lead + over], linearly or along `crossfade`, so ramps that
 * overlap (staggered forks of one line) each keep their own shape. core/query `weightAt`.
 */
export interface WeightChange {
  /** When the change is made (the timeline is sorted by it): the ramp starts `lead` earlier. */
  t: Seconds;
  /** Target weight (> 0). */
  w: number;
  /** Ramp length; 0 = step. */
  over: Seconds;
  /** How long before `t` the ramp starts (a merge's crossfade ends at its meeting `t`); 0 if absent. */
  lead?: Seconds;
  /** The ramp follows core/ease `crossfade`, not a line (a merge or split crossfade). */
  cross?: true;
}

/**
 * A change in how many voices a line stands for (revision 8): `n` from `t` on. Stacked voices
 * (a coincidence merge) count; a moment without a count sees the line `n` times.
 */
export interface StackChange {
  t: Seconds;
  n: number;
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
  /**
   * Timbre timeline, sorted; the first entry is { t: 0, preset: VoiceDef.timbre, fade: 0 }. Later
   * entries come from timbre moments (M6), at most one per time after the first (the later moment
   * wins); each names a different preset than the entry before it.
   */
  timbre: TimbreChange[];
  /** Level timeline, sorted; the level is 1 before the first entry. */
  level: LevelChange[];
  /**
   * Weight timeline, sorted (revision 8): the weight is 1 before the first entry. Absent or empty:
   * 1 throughout. Merged lines sum their weights; splits share them out.
   */
  weight?: WeightChange[];
  /** Stack timeline, sorted (revision 8): 1 before the first entry; absent: 1 throughout. */
  stack?: StackChange[];
  /**
   * Pulse records, sorted by t (revision 9; ties: the later one applies). The pulse gain is 1
   * before the first; absent or empty: 1 throughout. Multiplies the level.
   */
  pulse?: PulseRecord[];
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

/**
 * The harmony set by a moment, in effect from `t` until the next entry (HUD, §10). Extension of
 * §7.9. Walks, key and level moments add none.
 */
export interface HarmonyChange {
  /** The moment's time. */
  t: Seconds;
  /** The moment that set it. */
  momentId: MomentId;
  /** Pitch classes of the active voices' destinations, from the lowest voice up, unique. */
  pcs: number[];
  /** Pitch class of the lowest voice's destination. */
  bass: number;
  /** Display label, e.g. "ii7 · Dm7", "F/A" or "C E F♯" (core/harmony.ts). */
  label: string;
}

/** Output of `compile(piece)` (§7.9): what audio, picture and MIDI all read (P1). */
export interface CompiledScore {
  /** Time at which the last life has died: the end of the piece's sound before FX tails. */
  duration: Seconds;
  /** One entry per pool voice, in pool order (voices[i].index === i), including never-active ones. */
  voices: CompiledVoice[];
  /** Per-moment spans, for the moment lane. */
  momentSpans: MomentSpan[];
  /**
   * Every step a walk took (from !== to), or every applied `fixed` note incl. holds; sorted by t
   * (ties: walk order, then low to high). Revision 5, §6.2.
   */
  walkSteps: WalkStepRecord[];
  /** Compiler messages. */
  diagnostics: Diagnostic[];
  /** Key timeline, sorted; the first entry is { t: 0, key: piece.key }. Extension of §7.9. */
  keys: KeyChange[];
  /** Harmony timeline, sorted by t (ties in moment order). Absent on hand-built scores. */
  harmony?: HarmonyChange[];
  /** Hz of pitch 69, copied from piece.tuning so the DSP needs only this score. Extension. */
  referenceHz: number;
  /** Piece seed, copied for the DSP's seeded phases and noise (§8.10). Extension. */
  seed: number;
}
