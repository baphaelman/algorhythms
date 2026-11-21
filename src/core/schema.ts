/**
 * The file format: Zod schemas for a Piece, parsing with defaults, and stable serialisation
 * (PLAN.md §5).
 *
 * - **Unknown fields survive.** Every object schema is `z.looseObject`, so a field this build
 *   doesn't know is kept, at every level, and written back on save. The one exception is a key
 *   named `__proto__`, which Zod drops to guard against prototype pollution.
 * - **Defaults are filled.** A parsed piece has every field that types.ts marks as non-optional;
 *   the values come from core/defaults.ts.
 * - **Versions.** Older files are migrated forward (core/migrations.ts). Newer files open with a
 *   warning and `newerVersion: true`; the app must not autosave over them (§5). Their `version`
 *   is kept as written, so at runtime `piece.version` may exceed PIECE_VERSION in that case, and
 *   moments of types this build doesn't know are kept untouched (the compiler skips them).
 * - **Stable output.** `serializePiece` writes known keys in schema order, then unknown keys
 *   alphabetically, with a deterministic Prettier-like layout.
 */

import { z } from 'zod';
import {
  DEFAULT_END_FADE,
  DEFAULT_GLIDE,
  DEFAULT_KEY,
  DEFAULT_MIX,
  DEFAULT_RANGE,
  DEFAULT_TIMBRE,
  DEFAULT_TIMESTAMP,
  DEFAULT_TITLE,
  DEFAULT_VIEW,
  MOMENT_DEFAULTS,
  TIMBRE_DEFAULTS,
  cloneJson,
  defaultVoices,
  setOwn,
} from './defaults';
import { canonicalPiece } from './canonical';
import { DEFAULT_MIGRATIONS, migratePiece, type MigrationRegistry } from './migrations';
import { DEFAULT_REFERENCE_HZ } from './tuning';
import { MAX_VOICES, PIECE_FORMAT, PIECE_VERSION, type MomentType, type Piece } from './types';

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------

const finite = z.number();
const nonNegative = z.number().min(0);
const unitInterval = z.number().min(0).max(1);
const pitch = z.number().describe('Fractional MIDI note number; 69 = A4.');
const seconds = z.number().min(0).describe('Seconds from the start of the piece.');
const id = z.string().min(1);

/** A [low, high] pitch pair with low ≤ high. */
const pitchRange = z
  .tuple([pitch, pitch])
  .refine(([lo, hi]) => lo <= hi, { message: 'The low end must not be above the high end.' });

const PITCH_CLASSES = [
  'C',
  'C#',
  'Db',
  'D',
  'D#',
  'Eb',
  'E',
  'F',
  'F#',
  'Gb',
  'G',
  'G#',
  'Ab',
  'A',
  'A#',
  'Bb',
  'B',
] as const;

const SCALE_NAME_LIST = [
  'major',
  'minor',
  'ionian',
  'dorian',
  'phrygian',
  'lydian',
  'mixolydian',
  'aeolian',
  'locrian',
  'harmonic-minor',
  'melodic-minor',
  'pentatonic-major',
  'pentatonic-minor',
  'blues',
  'whole-tone',
  'chromatic',
] as const;

const CustomScaleSchema = z.looseObject({
  kind: z.literal('custom'),
  name: z.string().optional(),
  intervals: z
    .array(z.number().int().min(0).max(11))
    .min(1)
    .refine((iv) => iv[0] === 0 && iv.every((x, i) => i === 0 || x > iv[i - 1]), {
      message: 'Intervals must start with 0 and ascend without repeats.',
    })
    .describe('Semitone offsets from the tonic: 0 first, ascending, each in 0..11.'),
});

export const KeySchema = z.looseObject({
  tonic: z.enum(PITCH_CLASSES),
  scale: z.union([z.enum(SCALE_NAME_LIST), CustomScaleSchema]),
});

const BezierSchema = z.looseObject({
  kind: z.literal('bezier'),
  x1: unitInterval,
  y1: finite,
  x2: unitInterval,
  y2: finite,
});

export const EaseSchema = z.union([
  z.enum(['smootherstep', 'smoothstep', 'cosine', 'linear', 'expo']),
  BezierSchema,
]);

const GLIDE_ORDERS = ['random', 'low-first', 'high-first', 'center-out', 'outside-in'] as const;
const GLIDE_ARRIVE = ['together', 'spread'] as const;

/** A full glide (Piece.defaults.glide); omitted fields come from DEFAULT_GLIDE. */
export const GlideSchema = z.looseObject({
  length: nonNegative.default(DEFAULT_GLIDE.length).describe('Glide duration per voice (s).'),
  jitter: unitInterval
    .default(DEFAULT_GLIDE.jitter)
    .describe('Each length varies by ±jitter·length.'),
  stagger: nonNegative.default(DEFAULT_GLIDE.stagger).describe('Spread of start times (s).'),
  arrive: z
    .enum(GLIDE_ARRIVE)
    .default(DEFAULT_GLIDE.arrive ?? 'together')
    .describe("'together': every moving voice lands at once; 'spread': each after its own length."),
  land: z
    .boolean()
    .optional()
    .describe('Land on the beat: `at` is when the voices arrive (absent = false).'),
  order: z.enum(GLIDE_ORDERS).default(DEFAULT_GLIDE.order),
  ease: EaseSchema.default(DEFAULT_GLIDE.ease),
});

/** A moment's partial glide: merged over the defaults at compile time, so nothing is filled. */
export const PartialGlideSchema = z.looseObject({
  length: nonNegative.optional(),
  jitter: unitInterval.optional(),
  stagger: nonNegative.optional(),
  arrive: z.enum(GLIDE_ARRIVE).optional(),
  land: z.boolean().optional(),
  order: z.enum(GLIDE_ORDERS).optional(),
  ease: EaseSchema.optional(),
});

export const VoiceSelectorSchema = z.union([
  z.literal('all'),
  z.looseObject({ voices: z.array(id) }),
  z.looseObject({ rank: z.tuple([z.number().int().min(0), z.number().int().min(0)]) }),
  z.looseObject({ part: z.string() }),
]);

export const NoteSetSchema = z.discriminatedUnion('kind', [
  z.looseObject({ kind: z.literal('pitches'), pitches: z.array(pitch) }),
  z.looseObject({ kind: z.literal('chord'), symbol: z.string() }),
  z.looseObject({ kind: z.literal('degrees'), degrees: z.array(z.number().int()) }),
  z.looseObject({ kind: z.literal('current') }),
]);

const voicing = z.enum(['even', 'close', 'nearest']);

// ---------------------------------------------------------------------------------------------
// Moments (§6)
// ---------------------------------------------------------------------------------------------

/** Fields common to every moment (§6.1). */
const momentBase = {
  id: id.describe('Stable id (6 base62 characters); seeds the moment.'),
  at: seconds,
  target: VoiceSelectorSchema.optional(),
  glide: PartialGlideSchema.optional(),
  seed: z.number().int().optional(),
  label: z.string().optional(),
  muted: z.boolean().optional(),
  overrides: z
    .array(
      z.looseObject({
        voice: z.number().int().min(0).describe('Pool index.'),
        pitch: pitch.optional(),
        end: nonNegative.optional().describe("The voice's arrival, seconds after `at`."),
        weight: z
          .number()
          .positive()
          .max(64)
          .optional()
          .describe('Revision 8: the weight (loudness) of the note this voice ends on.'),
      }),
    )
    .optional()
    .describe('Per-voice hand edits of a point moment (dot drags); its lines may cross.'),
};

const D = MOMENT_DEFAULTS;

const MOMENT_SCHEMAS = {
  chord: z.looseObject({
    type: z.literal('chord'),
    ...momentBase,
    notes: NoteSetSchema,
    voicing: voicing.default(D.chord.voicing),
    register: pitchRange.optional(),
    assign: z.enum(['ordered', 'free']).default(D.chord.assign),
    count: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe('Active voice count after the chord (1..pool size); absent: unchanged.'),
    frozenFrom: z
      .object({ notes: NoteSetSchema, assign: z.enum(['ordered', 'free']) })
      .optional()
      .describe('Editor only: the notes and assign before the chord was frozen (Unfreeze).'),
    byVoice: z
      .boolean()
      .optional()
      .describe('Pitches go to the voices in order, unsorted (lines may cross).'),
  }),
  unison: z.looseObject({
    type: z.literal('unison'),
    ...momentBase,
    pitch: z.union([pitch, z.enum(['center', 'tonic'])]).default(D.unison.pitch),
    octaves: z.boolean().default(D.unison.octaves),
  }),
  split: z.looseObject({
    type: z.literal('split'),
    ...momentBase,
    count: z.number().int().min(0),
    notes: NoteSetSchema.optional(),
    voicing: voicing.default(D.split.voicing),
  }),
  merge: z.looseObject({
    type: z.literal('merge'),
    ...momentBase,
    count: z.number().int().min(0),
    which: z.enum(['top', 'bottom', 'inner', 'outer', 'random']).default(D.merge.which),
    fade: nonNegative.default(D.merge.fade),
  }),
  shift: z.looseObject({
    type: z.literal('shift'),
    ...momentBase,
    by: finite,
    unit: z.enum(['semitones', 'scaleSteps']).default(D.shift.unit),
  }),
  spread: z.looseObject({
    type: z.literal('spread'),
    ...momentBase,
    factor: finite,
    around: z.union([pitch, z.enum(['mean', 'median'])]).default(D.spread.around),
    snap: z.enum(['scale', 'chromatic', 'none']).default(D.spread.snap),
  }),
  walk: z.looseObject({
    type: z.literal('walk'),
    ...momentBase,
    until: seconds,
    grid: z.number().positive().default(D.walk.grid),
    density: unitInterval.default(D.walk.density),
    steps: z
      .array(z.number().int())
      .default(() => [...D.walk.steps])
      .describe('Allowed steps in scale steps.'),
    stepGlide: nonNegative.default(D.walk.stepGlide),
    bass: z
      .looseObject({
        leap: z
          .tuple([nonNegative, nonNegative])
          .refine(([lo, hi]) => lo <= hi, { message: 'The smaller leap must come first.' }),
      })
      .optional(),
    fixed: z
      .array(
        z.looseObject({
          tick: z
            .number()
            .min(0)
            .describe('Tick index: time = at + tick·grid (may be fractional).'),
          voice: id,
          pitch,
        }),
      )
      .optional()
      .describe('Frozen walk: absolute notes per tick; when present the walk draws nothing.'),
  }),
  note: z
    .looseObject({
      type: z.literal('note'),
      ...momentBase,
      from: pitch
        .optional()
        .describe('One change: the sounding note to change (nearest within ½ semitone).'),
      to: pitch.optional().describe('One change: its new pitch.'),
      changes: z
        .array(
          z.looseObject({
            from: pitch.describe('The sounding note to change (nearest within ½ semitone).'),
            to: pitch,
          }),
        )
        .min(1)
        .optional()
        .describe('Several changes at once, each on a different voice (instead of from/to).'),
      back: nonNegative
        .optional()
        .describe('When present, the notes return this many seconds after their glides end.'),
      order: z
        .boolean()
        .optional()
        .describe(
          'Keep lines in order: true = ordered voice leading; false or absent = only that voice moves (may cross).',
        ),
    })
    .refine(
      (m) =>
        m.changes === undefined
          ? m.from !== undefined && m.to !== undefined
          : m.from === undefined && m.to === undefined,
      { message: 'A note moment has either from and to, or changes.' },
    ),
  pin: z.looseObject({ type: z.literal('pin'), ...momentBase, voice: id, pitch }),
  key: z.looseObject({ type: z.literal('key'), ...momentBase, key: KeySchema }),
  level: z.looseObject({
    type: z.literal('level'),
    ...momentBase,
    gain: nonNegative,
    over: nonNegative.default(D.level.over),
  }),
  pulse: z.looseObject({
    type: z.literal('pulse'),
    ...momentBase,
    until: seconds.describe('End of the region (after `at`); steps at at + k·step while < until.'),
    step: z.number().positive().default(D.pulse.step),
    pattern: z
      .array(unitInterval)
      .min(1)
      .default(() => [...D.pulse.pattern])
      .describe('Accent per step, 0..1, cycling; 0 is a rest.'),
    decay: nonNegative
      .default(D.pulse.decay)
      .describe('Fall time from the accent to floor × accent.'),
    floor: unitInterval
      .default(D.pulse.floor)
      .describe('Level between hits, relative to the voice level.'),
    mode: z
      .enum(['together', 'up', 'down', 'updown', 'random'])
      .default(D.pulse.mode)
      .describe(
        'together: every targeted voice hits; the others one voice per step, in pitch order.',
      ),
    strike: z
      .boolean()
      .optional()
      .describe("Each hit re-strikes the timbre's articulation (absent: true)."),
  }),
  tune: z.looseObject({
    type: z.literal('tune'),
    ...momentBase,
    notes: z
      .array(
        z.looseObject({
          pitch,
          len: z
            .number()
            .positive()
            .describe('Seconds the note lasts; the next one starts after it.'),
        }),
      )
      .default(() => [])
      .describe(
        'The melody, in order: from `at` the targeted line moves to each note in turn (glide default length 0.1 s, no stagger or jitter).',
      ),
  }),
  timbre: z.looseObject({
    type: z.literal('timbre'),
    ...momentBase,
    preset: z.string().min(1).describe('A key of `timbres` or a built-in.'),
    fade: nonNegative.default(D.timbre.fade).describe('Crossfade length (s); 0 is instant.'),
  }),
} satisfies Record<MomentType, z.ZodType>;

/** The moment types this build understands. */
export const MOMENT_TYPES = Object.keys(MOMENT_SCHEMAS) as MomentType[];

export const MomentSchema = z.discriminatedUnion('type', [
  MOMENT_SCHEMAS.chord,
  MOMENT_SCHEMAS.unison,
  MOMENT_SCHEMAS.split,
  MOMENT_SCHEMAS.merge,
  MOMENT_SCHEMAS.shift,
  MOMENT_SCHEMAS.spread,
  MOMENT_SCHEMAS.walk,
  MOMENT_SCHEMAS.note,
  MOMENT_SCHEMAS.pin,
  MOMENT_SCHEMAS.key,
  MOMENT_SCHEMAS.level,
  MOMENT_SCHEMAS.pulse,
  MOMENT_SCHEMAS.tune,
  MOMENT_SCHEMAS.timbre,
]);

// ---------------------------------------------------------------------------------------------
// Voices, timbres, mix, view
// ---------------------------------------------------------------------------------------------

export const VoiceSchema = z.looseObject({
  id,
  name: z.string().optional(),
  color: z.string().optional(),
  timbre: z.string().min(1).default(DEFAULT_TIMBRE).describe('A key of `timbres` or a built-in.'),
  pan: z.union([z.number().min(-1).max(1), z.literal('auto')]).default('auto'),
  gain: nonNegative.default(1),
  range: pitchRange.default((): [number, number] => [DEFAULT_RANGE[0], DEFAULT_RANGE[1]]),
  mute: z.boolean().optional(),
  solo: z.boolean().optional(),
  part: z
    .string()
    .optional()
    .describe('Revision 9: a named group; lines in different parts never merge.'),
  sends: z
    .looseObject({ reverb: nonNegative.optional(), delay: nonNegative.optional() })
    .optional(),
});

const T = TIMBRE_DEFAULTS;

export const TimbreSchema = z.looseObject({
  harmonics: z.array(finite).max(32).describe('Amplitudes of partials 1..32.'),
  stretch: z
    .number()
    .min(-0.5)
    .max(1)
    .default(T.stretch)
    .describe('Inharmonicity: partial n at n^(1 + stretch); nonzero renders additively.'),
  fm: z
    .looseObject({
      ratio: z.number().positive().max(32).describe('Modulator/carrier frequency ratio.'),
      index: nonNegative.max(20).describe('Peak phase deviation β at middle C, radians.'),
      indexTrack: z
        .number()
        .min(-4)
        .max(4)
        .describe('β scales by 2^(−indexTrack) per octave above middle C.'),
    })
    .optional()
    .describe('Two-operator phase modulation of the carrier.'),
  noise: z
    .looseObject({
      level: nonNegative.max(4).describe("RMS relative to the tone's."),
      bandwidth: z
        .number()
        .positive()
        .max(8)
        .describe('Band-pass width around f, as a fraction of f (Q = 1/bandwidth).'),
    })
    .optional()
    .describe('Breath noise through a band-pass tracking the pitch.'),
  brightness: z
    .looseObject({
      tilt: finite.default(T.brightness.tilt),
      track: finite.default(T.brightness.track),
    })
    .prefault({}),
  detuneSpread: nonNegative.default(T.detuneSpread),
  accent: finite.default(T.accent),
  articulation: z
    .looseObject({
      amount: finite.default(T.articulation.amount),
      attack: nonNegative.default(T.articulation.attack),
      decay: nonNegative.default(T.articulation.decay),
      crisp: z
        .boolean()
        .optional()
        .describe('Keep the attack crisp and unshared (absent: amount ≥ 0.5).'),
    })
    .prefault({}),
  vibrato: z
    .looseObject({
      rate: nonNegative.default(T.vibrato.rate),
      depthCents: nonNegative.default(T.vibrato.depthCents),
      delay: nonNegative.default(T.vibrato.delay),
      jitter: z.number().min(0).max(1).optional(),
    })
    .prefault({}),
  formants: z
    .array(
      z.looseObject({ hz: z.number().positive(), bw: z.number().positive(), gain: nonNegative }),
    )
    .max(8)
    .optional()
    .describe('Fixed-Hz formant resonances applied to the harmonics.'),
  drift: z
    .looseObject({ cents: nonNegative, rate: nonNegative, amp: nonNegative.optional() })
    .optional()
    .describe('Slow seeded random pitch (and amplitude) wander per voice.'),
  wobble: nonNegative
    .max(100)
    .optional()
    .describe('Unison wobble in cents: 0 (default) locks converged voices into a steady tone.'),
});

const M = DEFAULT_MIX;

export const MixSchema = z.looseObject({
  reverb: z
    .looseObject({
      size: unitInterval.default(M.reverb.size),
      decay: z.number().positive().default(M.reverb.decay),
      damping: unitInterval.default(M.reverb.damping),
      preDelay: nonNegative.default(M.reverb.preDelay),
      returnLevel: nonNegative.default(M.reverb.returnLevel),
    })
    .prefault({}),
  delay: z
    .looseObject({
      time: z.number().positive().default(M.delay.time),
      feedback: z.number().min(0).lt(1).default(M.delay.feedback),
      returnLevel: nonNegative.default(M.delay.returnLevel),
    })
    .prefault({}),
  sends: z
    .looseObject({
      reverb: nonNegative.default(M.sends.reverb),
      delay: nonNegative.default(M.sends.delay),
    })
    .prefault({}),
  tone: z
    .looseObject({
      tilt: finite.default(M.tone.tilt),
      lowpassHz: z.number().positive().default(M.tone.lowpassHz),
    })
    .prefault({}),
  limiter: z
    .looseObject({ ceilingDb: z.number().max(0).default(M.limiter.ceilingDb) })
    .prefault({}),
  panAuto: z.enum(['index', 'pitch']).default(M.panAuto),
});

const V = DEFAULT_VIEW;

export const ViewSchema = z.looseObject({
  window: z.number().positive().default(V.window).describe('Visible time window (s).'),
  colors: z.enum(['ink', 'pitch', 'custom']).default(V.colors),
  hud: z.boolean().default(V.hud),
  gridBpm: z.number().positive().optional(),
  snapBeats: z
    .boolean()
    .optional()
    .describe('Snap to beats (needs `gridBpm`): absent = on when the piece has a tempo.'),
  meter: z.number().int().min(1).max(32).optional().describe('Beats per bar.'),
  futureOpacity: unitInterval.optional(),
  playheadX: unitInterval.optional(),
  follow: z.enum(['smooth', 'page', 'off']).optional(),
  loop: z
    .looseObject({ start: seconds, end: seconds, on: z.boolean().optional() })
    .optional()
    .describe('Loop region [start, end) (s).'),
});

// ---------------------------------------------------------------------------------------------
// Piece
// ---------------------------------------------------------------------------------------------

const TuningSchema = z.looseObject({
  referenceHz: z.number().positive().default(DEFAULT_REFERENCE_HZ).describe('Hz of pitch 69.'),
  system: z
    .discriminatedUnion('kind', [
      z.looseObject({ kind: z.literal('12tet') }),
      z.looseObject({ kind: z.literal('scala'), scl: z.string(), kbm: z.string().optional() }),
    ])
    .default(() => ({ kind: '12tet' as const })),
});

/** Cross-field rules: unique ids and the pool limit. */
function checkPiece(
  p: {
    voices: { id: string }[];
    moments: {
      id: string;
      type?: string;
      count?: number;
      fixed?: { tick: number; voice: string }[];
    }[];
  },
  ctx: z.RefinementCtx,
): void {
  if (p.voices.length > MAX_VOICES) {
    ctx.addIssue({
      code: 'custom',
      path: ['voices'],
      message: `The voice pool has ${p.voices.length} voices; the maximum is ${MAX_VOICES}.`,
    });
  }
  const voiceIds = new Set<string>();
  p.voices.forEach((v, i) => {
    if (voiceIds.has(v.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['voices', i, 'id'],
        message: `Duplicate voice id '${v.id}'.`,
      });
    }
    voiceIds.add(v.id);
  });
  const momentIds = new Set<string>();
  p.moments.forEach((m, i) => {
    if (momentIds.has(m.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['moments', i, 'id'],
        message: `Duplicate moment id '${m.id}'; every moment needs its own id.`,
      });
    }
    momentIds.add(m.id);
    if (m.type === 'chord' && typeof m.count === 'number' && m.count > p.voices.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['moments', i, 'count'],
        message: `The chord count ${m.count} exceeds the pool of ${p.voices.length} voices.`,
      });
    }
    // Frozen walk notes: one per (tick, voice), on pool voices.
    if (Array.isArray(m.fixed)) {
      const seen = new Set<string>();
      m.fixed.forEach((n, j) => {
        const k = `${n.tick}\u0000${n.voice}`;
        if (!voiceIds.has(n.voice)) {
          ctx.addIssue({
            code: 'custom',
            path: ['moments', i, 'fixed', j, 'voice'],
            message: `'${n.voice}' is not a voice in the pool.`,
          });
        } else if (seen.has(k)) {
          ctx.addIssue({
            code: 'custom',
            path: ['moments', i, 'fixed', j],
            message: `Voice '${n.voice}' has two fixed notes on tick ${n.tick}.`,
          });
        }
        seen.add(k);
      });
    }
  });
}

export const PieceSchema = z
  .looseObject({
    format: z.literal(PIECE_FORMAT),
    version: z.literal(PIECE_VERSION),
    meta: z
      .looseObject({
        title: z.string().default(DEFAULT_TITLE),
        author: z.string().optional(),
        created: z.string().default(DEFAULT_TIMESTAMP).describe('ISO 8601.'),
        modified: z.string().default(DEFAULT_TIMESTAMP).describe('ISO 8601.'),
      })
      .prefault({}),
    seed: z.number().int().default(0).describe('Piece seed; moment seeds derive from it.'),
    tuning: TuningSchema.prefault({}),
    key: KeySchema.default(() => cloneJson(DEFAULT_KEY) as z.output<typeof KeySchema>),
    defaults: z.looseObject({ glide: GlideSchema.prefault({}) }).prefault({}),
    voices: z
      .array(VoiceSchema)
      .default(() => defaultVoices() as z.output<typeof VoiceSchema>[])
      .describe('The voice pool (at most 32); array index = pool index.'),
    moments: z.array(MomentSchema).default(() => []),
    timbres: z.record(z.string(), TimbreSchema).default(() => ({})),
    mix: MixSchema.prefault({}),
    end: z
      .looseObject({ at: seconds.optional(), fade: nonNegative.default(DEFAULT_END_FADE) })
      .prefault({}),
    view: ViewSchema.prefault({}),
  })
  .superRefine(checkPiece);

// ---------------------------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------------------------

/** Result of `parsePiece`. */
export type ParsePieceResult =
  | {
      ok: true;
      piece: Piece;
      /** Things the user should know, e.g. "made with a newer version". */
      warnings: string[];
      /** The file's version is newer than this build's: don't autosave over it (§5). */
      newerVersion: boolean;
      /** Set when migrations upgraded the file from this version. */
      migratedFrom?: number;
    }
  | { ok: false; errors: string[] };

/** Options for `parsePiece` (tests swap the migration registry). */
export interface ParsePieceOptions {
  migrations?: MigrationRegistry;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/** `moments[3].notes.symbol` from a Zod path. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out === '' ? String(seg) : `.${String(seg)}`;
  }
  return out;
}

/** Flattens Zod issues into readable lines, choosing the most specific branch of a union. */
function formatIssues(
  issues: readonly z.core.$ZodIssue[],
  prefix: readonly PropertyKey[] = [],
): string[] {
  const out: string[] = [];
  for (const issue of issues) {
    const path = [...prefix, ...issue.path];
    if (issue.code === 'invalid_union' && issue.errors.length > 0) {
      // The author most likely meant the branch whose fields they wrote (fewest complaints about
      // missing fields), and among those the one that got furthest (deepest path).
      const missing = (branch: readonly z.core.$ZodIssue[]): number =>
        branch.filter((i) => i.code === 'invalid_type' && i.message.endsWith('received undefined'))
          .length;
      const depth = (branch: readonly z.core.$ZodIssue[]): number =>
        Math.max(...branch.map((i) => i.path.length));
      const best = [...issue.errors].sort(
        (a, b) => missing(a) - missing(b) || depth(b) - depth(a),
      )[0];
      if (depth(best) > 0) {
        out.push(...formatIssues(best, path));
        continue;
      }
    }
    const where = formatPath(path);
    out.push(where === '' ? issue.message : `${where}: ${issue.message}`);
  }
  return out;
}

/** Index → raw moment, for moments whose type this build doesn't know. */
/**
 * Retired enum values that version-1 files may still hold, mapped to their replacements in place.
 * No version bump: the old value just reads as the new one. `view.colors: 'voice'` (per-voice
 * palette, removed 2026-11-20) → 'pitch'.
 */
function renameRetiredValues(raw: Record<string, unknown>): void {
  const view = raw.view;
  if (isRecord(view) && view.colors === 'voice') view.colors = 'pitch';
}

function extractUnknownMoments(raw: Record<string, unknown>): Map<number, unknown> {
  const unknown = new Map<number, unknown>();
  if (!Array.isArray(raw.moments)) return unknown;
  const known = new Set<string>(MOMENT_TYPES);
  raw.moments.forEach((m: unknown, i: number) => {
    if (isRecord(m) && typeof m.type === 'string' && !known.has(m.type)) unknown.set(i, m);
  });
  if (unknown.size > 0)
    raw.moments = raw.moments.filter((_: unknown, i: number) => !unknown.has(i));
  return unknown;
}

/**
 * Validates and normalises a piece: JSON text or an already-parsed value. Fills defaults, keeps
 * unknown fields, migrates older versions and flags newer ones. Never throws.
 */
export function parsePiece(json: unknown, options: ParsePieceOptions = {}): ParsePieceResult {
  let raw: unknown;
  try {
    // A JSON round trip gives a private, plain-data copy (no shared references, no undefined).
    raw = JSON.parse(typeof json === 'string' ? json : JSON.stringify(json));
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  if (!isRecord(raw)) return { ok: false, errors: ['A piece must be a JSON object.'] };
  if (raw.format !== PIECE_FORMAT) {
    return {
      ok: false,
      errors: [
        raw.format === undefined
          ? `Not an AlgoRhythms piece: the "format" field is missing (expected "${PIECE_FORMAT}").`
          : `Not an AlgoRhythms piece: "format" is ${JSON.stringify(raw.format)}, expected "${PIECE_FORMAT}".`,
      ],
    };
  }
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 0) {
    return { ok: false, errors: ['version: expected a whole number (the file-format version).'] };
  }

  const warnings: string[] = [];
  const newerVersion = version > PIECE_VERSION;
  let migratedFrom: number | undefined;
  if (newerVersion) {
    warnings.push(
      `This piece was saved by a newer AlgoRhythms (file format ${version}; this version reads ` +
        `${PIECE_VERSION}). Some of its features may be missing here. Save a copy rather than ` +
        `overwriting the original.`,
    );
    raw.version = PIECE_VERSION; // parse as the newest format we know, then restore
  } else if (version < PIECE_VERSION) {
    const migrated = migratePiece(raw, options.migrations ?? DEFAULT_MIGRATIONS);
    if (!migrated.ok) return { ok: false, errors: [migrated.error] };
    raw = migrated.value;
    migratedFrom = version;
  }
  const rec = raw as Record<string, unknown>;

  renameRetiredValues(rec);
  const unknownMoments = extractUnknownMoments(rec);
  const errors: string[] = [];
  if (unknownMoments.size > 0) {
    const types = [
      ...new Set([...unknownMoments.values()].map((m) => String((m as { type: string }).type))),
    ];
    if (newerVersion) {
      warnings.push(
        `${unknownMoments.size} moment(s) of a type this version doesn't know (${types.join(', ')}) ` +
          `are kept but not played.`,
      );
    } else {
      for (const [i, m] of unknownMoments) {
        errors.push(
          `moments[${i}].type: unknown moment type '${String((m as { type: string }).type)}' ` +
            `(expected one of ${MOMENT_TYPES.join(', ')}).`,
        );
      }
    }
  }

  const result = PieceSchema.safeParse(rec);
  if (!result.success) {
    // Re-map moment indices so errors point at the file's own positions.
    const original = (i: number): number => {
      let seen = -1;
      for (let j = 0; ; j++) {
        if (!unknownMoments.has(j)) seen++;
        if (seen === i) return j;
      }
    };
    const issues = result.error.issues.map((issue) =>
      issue.path[0] === 'moments' && typeof issue.path[1] === 'number' && unknownMoments.size > 0
        ? { ...issue, path: ['moments', original(issue.path[1]), ...issue.path.slice(2)] }
        : issue,
    );
    errors.push(...formatIssues(issues));
  }
  if (errors.length > 0 || !result.success) return { ok: false, errors };

  const piece = result.data as unknown as Piece & Record<string, unknown>;
  // Frozen walk notes are kept in tick order (stable within a tick).
  for (const m of piece.moments) {
    if (m.type === 'walk' && m.fixed) m.fixed.sort((a, b) => a.tick - b.tick);
  }
  if (newerVersion) (piece as { version: number }).version = version;
  if (unknownMoments.size > 0) {
    const moments: unknown[] = [...piece.moments];
    for (const [i, m] of [...unknownMoments].sort((a, b) => a[0] - b[0])) moments.splice(i, 0, m);
    piece.moments = moments as Piece['moments'];
  }
  if (piece.tuning.system.kind !== '12tet') {
    warnings.push(
      `Tuning system '${piece.tuning.system.kind}' is not supported yet; 12-TET is used.`,
    );
  }
  // Canonical numbers (§11.4): a silent normalisation, so share links round-trip exactly.
  const canon = canonicalPiece(piece);
  return migratedFrom === undefined
    ? { ok: true, piece: canon, warnings, newerVersion }
    : { ok: true, piece: canon, warnings, newerVersion, migratedFrom };
}

// ---------------------------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------------------------

type AnySchema = z.core.$ZodType;

/** Strips wrappers (optional, default, prefault, nullable, readonly, pipe) to the core schema. */
function unwrap(schema: AnySchema): AnySchema {
  let s = schema;
  for (;;) {
    const def = s._zod.def as { type: string; innerType?: AnySchema; in?: AnySchema };
    if (
      def.innerType &&
      ['optional', 'default', 'prefault', 'nullable', 'readonly', 'catch', 'nonoptional'].includes(
        def.type,
      )
    ) {
      s = def.innerType;
    } else if (def.type === 'pipe' && def.in) {
      s = def.in;
    } else {
      return s;
    }
  }
}

/**
 * Returns a copy of `value` with object keys in canonical order: the schema's keys in schema
 * order, then any unknown keys alphabetically (recursively). Values are not changed.
 */
function canonical(value: unknown, schema: AnySchema | null): unknown {
  if (Array.isArray(value)) {
    const def = schema
      ? (unwrap(schema)._zod.def as { type: string; element?: AnySchema; items?: AnySchema[] })
      : null;
    return value.map((v, i) =>
      canonical(
        v,
        def?.type === 'array'
          ? (def.element ?? null)
          : def?.type === 'tuple'
            ? (def.items?.[i] ?? null)
            : null,
      ),
    );
  }
  if (!isRecord(value)) return value;
  let s = schema ? unwrap(schema) : null;
  // Unions: use the first option the value satisfies (as Zod would when parsing).
  while (s && (s._zod.def as { type: string }).type === 'union') {
    const options = (s._zod.def as unknown as { options: AnySchema[] }).options;
    const match = options.find((o) => z.safeParse(o, value).success);
    s = match ? unwrap(match) : null;
  }
  const def = s
    ? (s._zod.def as { type: string; shape?: Record<string, AnySchema>; valueType?: AnySchema })
    : null;
  // Own-property checks only: `'valueOf' in {}` is true, and `out['__proto__'] = x` would set
  // the prototype instead of a field, so either would silently drop a user's unknown field.
  const out: Record<string, unknown> = {};
  if (def?.type === 'record') {
    for (const k of Object.keys(value).sort()) {
      setOwn(out, k, canonical(value[k], def.valueType ?? null));
    }
    return out;
  }
  const shape = def?.type === 'object' ? (def.shape ?? {}) : {};
  for (const k of Object.keys(shape)) {
    if (Object.hasOwn(value, k) && value[k] !== undefined) {
      setOwn(out, k, canonical(value[k], shape[k]));
    }
  }
  for (const k of Object.keys(value).sort()) {
    if (!Object.hasOwn(shape, k) && value[k] !== undefined) {
      setOwn(out, k, canonical(value[k], null));
    }
  }
  return out;
}

/** Line width of the serialised file, matching the repository's Prettier setting. */
const WIDTH = 100;

/** One-line JSON with a space after ':' and ',', as Prettier prints a short JSON value. */
function inline(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`;
  if (isRecord(value)) {
    const entries = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`);
    return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Lays out `value` starting at column `col` with block indentation `indent`. */
function layout(value: unknown, indent: string, col: number): string {
  const flat = inline(value);
  if (col + flat.length + 1 <= WIDTH || (!Array.isArray(value) && !isRecord(value))) return flat;
  const inner = indent + '  ';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.every((v) => typeof v === 'number')) {
      // Fill mode for number arrays (e.g. harmonics): as many per line as fit.
      const lines: string[] = [];
      let line = '';
      for (const v of value) {
        const item = `${JSON.stringify(v)},`;
        if (line !== '' && inner.length + line.length + 1 + item.length > WIDTH) {
          lines.push(line);
          line = item;
        } else {
          line = line === '' ? item : `${line} ${item}`;
        }
      }
      lines.push(line.slice(0, -1));
      return `[\n${lines.map((l) => inner + l).join('\n')}\n${indent}]`;
    }
    const items = value.map((v) => inner + layout(v, inner, inner.length));
    return `[\n${items.join(',\n')}\n${indent}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => {
    const key = `${JSON.stringify(k)}: `;
    return inner + key + layout(v, inner, inner.length + key.length);
  });
  return `{\n${entries.join(',\n')}\n${indent}}`;
}

/**
 * Serialises a piece as stable, readable JSON: known keys in schema order, unknown keys
 * alphabetically, short values on one line (Prettier-like, width 100), and a final newline.
 * The same piece always gives the same text.
 */
export function serializePiece(piece: Piece): string {
  return `${layout(canonical(piece, PieceSchema), '', 0)}\n`;
}

/** Any JSON value in `serializePiece`'s layout, keys in their own order (tests compare bytes). */
export function layoutJson(value: unknown): string {
  return `${layout(value, '', 0)}\n`;
}

/**
 * The published JSON Schema of the file format (the *input* form: fields with defaults are
 * optional). docs/file-format.md is generated from it by `pnpm docs:schema`.
 */
export function pieceJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(PieceSchema, { io: 'input', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >;
}

// ---------------------------------------------------------------------------------------------
// Default stripping (share links, §11.4)
// ---------------------------------------------------------------------------------------------

/** Deep equality of plain JSON data (key order ignored). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
}

const omitted = new WeakMap<AnySchema, { value: unknown }>();

/** The value a schema gives an omitted field, or undefined when it fills none. */
function omittedValue(schema: AnySchema): unknown {
  let hit = omitted.get(schema);
  if (!hit) {
    const r = z.safeParse(schema, undefined);
    hit = { value: r.success ? r.data : undefined };
    omitted.set(schema, hit);
  }
  return hit.value;
}

/** The union option `value` belongs to (the first it satisfies), unwrapped; null if none. */
function unionBranch(schema: AnySchema, value: unknown): AnySchema | null {
  let s: AnySchema | null = unwrap(schema);
  while (s && (s._zod.def as { type: string }).type === 'union') {
    const options: AnySchema[] = (s._zod.def as unknown as { options: AnySchema[] }).options;
    const match: AnySchema | undefined = options.find((o) => z.safeParse(o, value).success);
    s = match ? unwrap(match) : null;
  }
  return s;
}

function strip(value: unknown, schema: AnySchema | null): unknown {
  if (Array.isArray(value)) {
    const def = schema
      ? (unwrap(schema)._zod.def as { type: string; element?: AnySchema; items?: AnySchema[] })
      : null;
    return value.map((v, i) =>
      strip(
        v,
        def?.type === 'array'
          ? (def.element ?? null)
          : def?.type === 'tuple'
            ? (def.items?.[i] ?? null)
            : null,
      ),
    );
  }
  if (!isRecord(value)) return value;
  if (!schema) return canonical(value, null);
  const s = unionBranch(schema, value);
  const def = s
    ? (s._zod.def as { type: string; shape?: Record<string, AnySchema>; valueType?: AnySchema })
    : null;
  const out: Record<string, unknown> = {};
  if (def?.type === 'record') {
    for (const k of Object.keys(value).sort()) {
      setOwn(out, k, strip(value[k], def.valueType ?? null));
    }
    return out;
  }
  // Keys in `canonical`'s order (schema order, then unknown keys alphabetically), so equal pieces
  // always strip to the same text.
  const shape = def?.type === 'object' ? (def.shape ?? {}) : {};
  for (const k of Object.keys(shape)) {
    const v = Object.hasOwn(value, k) ? value[k] : undefined;
    if (v === undefined) continue;
    const filled = omittedValue(shape[k]);
    if (filled !== undefined && jsonEqual(filled, v)) continue;
    setOwn(out, k, strip(v, shape[k]));
  }
  for (const k of Object.keys(value).sort()) {
    if (!Object.hasOwn(shape, k) && value[k] !== undefined)
      setOwn(out, k, canonical(value[k], null));
  }
  return out;
}

/**
 * A copy of a parsed piece without the fields `parsePiece` would fill with the same value
 * (§11.4 default stripping): `parsePiece(stripDefaults(p))` gives back `p` for any parsed `p`.
 * Unknown fields are kept.
 */
export function stripDefaults(piece: Piece): Record<string, unknown> {
  return strip(piece, PieceSchema) as Record<string, unknown>;
}
