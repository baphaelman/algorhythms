/**
 * fast-check generators of valid, varied pieces for the compiler property tests (PLAN.md §14).
 *
 * Pieces overlap moments on purpose: dense moment times, long glides with stagger and jitter (and
 * `land` lead-ins, revision 9; splits and merges stagger their births and deaths too), walk
 * regions with point moments inside them, splits and merges back to back, subset selectors, pins,
 * note points (with and without returns, some with grouped `changes`; `from` often a start pitch,
 * so it sounds), out-of-range
 * pitches (folding), key changes, pulses, tunes (revision 9) and every ease (béziers with finite
 * start slopes).
 */
import fc from 'fast-check';
import { newPiece } from '../../../src/core/defaults';
import type {
  EaseRef,
  Glide,
  GlideOrder,
  Moment,
  NoteSet,
  Piece,
  VoiceOverride,
  VoiceSelector,
} from '../../../src/core/types';
import { withStart } from '../../unit/core/compiler-fixtures';

const tenths = (lo: number, hi: number): fc.Arbitrary<number> =>
  fc.integer({ min: Math.round(lo * 10), max: Math.round(hi * 10) }).map((x) => x / 10);

export const easeArb: fc.Arbitrary<EaseRef> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.constantFrom<EaseRef>('smootherstep', 'smoothstep', 'cosine', 'linear', 'expo'),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('bezier' as const),
      x1: tenths(0.1, 0.9),
      y1: tenths(-0.5, 1.5),
      x2: tenths(0.1, 0.9),
      y2: tenths(-0.5, 1.5),
    }),
  },
);

const orderArb = fc.constantFrom<GlideOrder>(
  'random',
  'low-first',
  'high-first',
  'center-out',
  'outside-in',
);

/** Revision 9 `land`: a lead-in before `at`, often overlapping other moments. */
const landArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant(false) },
  { weight: 1, arbitrary: fc.constant(true) },
);

export const glideArb: fc.Arbitrary<Glide> = fc.record({
  length: tenths(0.2, 5),
  jitter: tenths(0, 1),
  stagger: tenths(0, 3),
  land: landArb,
  order: orderArb,
  ease: easeArb,
});

const partialGlideArb: fc.Arbitrary<Partial<Glide>> = fc.record(
  {
    length: tenths(0.2, 6),
    jitter: tenths(0, 1),
    stagger: tenths(0, 3),
    land: fc.boolean(),
    order: orderArb,
    ease: easeArb,
  },
  { requiredKeys: [] },
);

const SYMBOLS = ['Am7', 'C', 'Dm9', 'G7', 'F#m7b5', 'C/E', 'ii7', 'V9', 'Bbmaj7', 'Esus4', 'Cadd9'];

const notesArb: fc.Arbitrary<NoteSet> = fc.oneof(
  fc.record({ kind: fc.constant('chord' as const), symbol: fc.constantFrom(...SYMBOLS) }),
  fc.record({
    kind: fc.constant('degrees' as const),
    degrees: fc.array(fc.integer({ min: 0, max: 11 }), { minLength: 1, maxLength: 5 }),
  }),
  fc.record({
    kind: fc.constant('pitches' as const),
    pitches: fc.array(fc.integer({ min: 24, max: 108 }), { minLength: 1, maxLength: 8 }),
  }),
  fc.constant({ kind: 'current' as const }),
);

/** Part names the generators use ('C' is never given to a voice: an unknown part). */
export const PART_NAMES = ['A', 'B'] as const;

function selectorArb(ids: string[], parts: boolean): fc.Arbitrary<VoiceSelector | undefined> {
  const part = {
    weight: 3,
    arbitrary: fc.constantFrom('A', 'A', 'B', 'B', 'C').map((part) => ({ part })),
  };
  return fc.oneof(
    ...(parts ? [part] : []),
    { weight: 6, arbitrary: fc.constant(undefined) },
    { weight: 1, arbitrary: fc.constant('all' as const) },
    {
      weight: 2,
      arbitrary: fc
        .tuple(fc.integer({ min: 0, max: 8 }), fc.integer({ min: 0, max: 8 }))
        .map(([a, b]) => ({ rank: [Math.min(a, b), Math.max(a, b)] as [number, number] })),
    },
    {
      weight: 2,
      arbitrary: fc.subarray(ids, { minLength: 1 }).map((voices) => ({ voices })),
    },
  );
}

export type Draft = Omit<Moment, 'id'>;

/** Per-voice overrides (§11.3, revision 6): mostly none, else up to three hand edits. */
function overridesArb(pool: number): fc.Arbitrary<VoiceOverride[] | undefined> {
  return fc.oneof(
    { weight: 6, arbitrary: fc.constant(undefined) },
    {
      weight: 1,
      arbitrary: fc.array(
        fc.record(
          {
            voice: fc.integer({ min: 0, max: Math.max(0, pool - 1) }),
            pitch: fc.oneof(fc.integer({ min: 30, max: 100 }), tenths(40, 80)),
            end: tenths(0, 6),
          },
          { requiredKeys: ['voice'] },
        ),
        { minLength: 1, maxLength: 3 },
      ),
    },
  );
}

export function momentArb(ids: string[], maxT: number, parts = false): fc.Arbitrary<Draft> {
  const at = tenths(0, maxT);
  const base = {
    at,
    target: selectorArb(ids, parts),
    glide: fc.option(partialGlideArb, { nil: undefined }),
    overrides: overridesArb(ids.length),
  };
  return fc
    .oneof(
      {
        weight: 4,
        arbitrary: fc.record(
          {
            ...base,
            type: fc.constant('chord' as const),
            notes: notesArb,
            voicing: fc.constantFrom('even' as const, 'close' as const, 'nearest' as const),
            assign: fc.constantFrom('ordered' as const, 'ordered' as const, 'free' as const),
            register: fc.option(
              fc
                .tuple(fc.integer({ min: 36, max: 72 }), fc.integer({ min: 6, max: 30 }))
                .map(([lo, w]) => [lo, lo + w] as [number, number]),
              { nil: undefined },
            ),
            count: fc.integer({ min: 1, max: Math.max(1, ids.length) }),
            byVoice: fc.boolean(),
          },
          { requiredKeys: ['at', 'type', 'notes', 'voicing', 'assign'] },
        ),
      },
      {
        weight: 2,
        arbitrary: fc.record(
          {
            ...base,
            type: fc.constant('unison' as const),
            pitch: fc.oneof(
              fc.integer({ min: 30, max: 100 }),
              fc.constantFrom('center' as const, 'tonic' as const),
            ),
            octaves: fc.boolean(),
          },
          { requiredKeys: ['at', 'type', 'pitch', 'octaves'] },
        ),
      },
      {
        weight: 3,
        arbitrary: fc.record(
          {
            ...base,
            type: fc.constant('split' as const),
            count: fc.integer({ min: 1, max: 14 }),
            notes: fc.option(notesArb, { nil: undefined }),
            voicing: fc.constantFrom('even' as const, 'close' as const, 'nearest' as const),
          },
          { requiredKeys: ['at', 'type', 'count', 'voicing'] },
        ),
      },
      {
        weight: 2,
        arbitrary: fc.record(
          {
            ...base,
            type: fc.constant('merge' as const),
            count: fc.integer({ min: 0, max: 8 }),
            which: fc.constantFrom(
              'top' as const,
              'bottom' as const,
              'inner' as const,
              'outer' as const,
              'random' as const,
            ),
            fade: tenths(0, 3),
          },
          { requiredKeys: ['at', 'type', 'count', 'which', 'fade'] },
        ),
      },
      {
        weight: 2,
        arbitrary: fc.record(
          {
            ...base,
            type: fc.constant('shift' as const),
            by: fc.integer({ min: -14, max: 14 }),
            unit: fc.constantFrom('semitones' as const, 'scaleSteps' as const),
          },
          { requiredKeys: ['at', 'type', 'by', 'unit'] },
        ),
      },
      {
        weight: 2,
        arbitrary: fc.record(
          {
            ...base,
            type: fc.constant('spread' as const),
            factor: tenths(-1, 2.5),
            around: fc.oneof(
              fc.constantFrom('mean' as const, 'median' as const),
              fc.integer({ min: 40, max: 80 }),
            ),
            snap: fc.constantFrom('scale' as const, 'chromatic' as const, 'none' as const),
          },
          { requiredKeys: ['at', 'type', 'factor', 'around', 'snap'] },
        ),
      },
      {
        weight: 2,
        arbitrary: fc
          .record(
            {
              ...base,
              type: fc.constant('walk' as const),
              len: tenths(1, 20),
              grid: tenths(0.2, 1.5),
              density: tenths(0, 1),
              steps: fc.constantFrom([-2, -1, 1, 2], [-1, 1], [1, 2, 3], [-3, 3]),
              stepGlide: tenths(0.1, 2),
              bass: fc.option(
                fc
                  .tuple(fc.integer({ min: 2, max: 7 }), fc.integer({ min: 7, max: 14 }))
                  .map(([a, b]) => ({ leap: [a, b] as [number, number] })),
                { nil: undefined },
              ),
            },
            { requiredKeys: ['at', 'type', 'len', 'grid', 'density', 'steps', 'stepGlide'] },
          )
          .map(({ len, ...w }) => ({ ...w, until: w.at + len }) as Draft),
      },
      {
        weight: 1,
        arbitrary: fc.record(
          {
            at,
            glide: base.glide,
            type: fc.constant('pin' as const),
            voice: fc.constantFrom(...ids),
            pitch: fc.integer({ min: 30, max: 100 }),
          },
          { requiredKeys: ['at', 'type', 'voice', 'pitch'] },
        ),
      },
      {
        weight: 2,
        arbitrary: fc.record(
          {
            ...base,
            type: fc.constant('note' as const),
            from: fc.integer({ min: 40, max: 80 }),
            to: fc.oneof(fc.integer({ min: 30, max: 100 }), tenths(40, 80)),
            back: tenths(0, 4),
            order: fc.boolean(),
            // Grouped note changes (revision 7): extra changes make it a `changes` list.
            more: fc.array(
              fc.record({
                from: fc.integer({ min: 40, max: 80 }),
                to: fc.integer({ min: 30, max: 100 }),
              }),
              { minLength: 1, maxLength: 2 },
            ),
          },
          { requiredKeys: ['at', 'type', 'from', 'to'] },
        ),
      },
      {
        weight: 1,
        arbitrary: fc.record({
          at,
          type: fc.constant('key' as const),
          key: fc.record({
            tonic: fc.constantFrom(
              'C' as const,
              'D' as const,
              'Eb' as const,
              'F#' as const,
              'A' as const,
            ),
            scale: fc.constantFrom(
              'major' as const,
              'dorian' as const,
              'aeolian' as const,
              'pentatonic-minor' as const,
              'whole-tone' as const,
            ),
          }),
        }),
      },
      {
        weight: 1,
        arbitrary: fc.record(
          {
            ...base,
            type: fc.constant('level' as const),
            gain: tenths(0, 1.5),
            over: tenths(0, 4),
          },
          { requiredKeys: ['at', 'type', 'gain', 'over'] },
        ),
      },
      {
        weight: 1,
        arbitrary: fc
          .record(
            {
              ...base,
              type: fc.constant('pulse' as const),
              len: tenths(0.5, 12),
              step: fc.constantFrom(0.125, 0.25, 1 / 3, 0.5, 0.75, 1),
              pattern: fc.array(fc.constantFrom(0, 0.3, 0.5, 0.8, 1), {
                minLength: 1,
                maxLength: 4,
              }),
              decay: tenths(0, 1),
              floor: tenths(0, 1),
              mode: fc.constantFrom(
                'together' as const,
                'up' as const,
                'down' as const,
                'updown' as const,
                'random' as const,
              ),
              strike: fc.boolean(),
            },
            { requiredKeys: ['at', 'type', 'len', 'step', 'pattern', 'decay', 'floor', 'mode'] },
          )
          .map(({ len, ...m }) => ({ ...m, until: m.at + len }) as Draft),
      },
      {
        // Revision 9: a melody on one line (it may cross others; joins within its part).
        weight: 2,
        arbitrary: fc.record(
          {
            at,
            target: base.target,
            glide: base.glide,
            type: fc.constant('tune' as const),
            notes: fc.array(
              fc.record({
                pitch: fc.oneof(fc.integer({ min: 30, max: 100 }), tenths(40, 80)),
                len: fc.constantFrom(0.05, 0.1, 0.25, 0.5, 1, 2),
              }),
              { minLength: 0, maxLength: 8 },
            ),
          },
          { requiredKeys: ['at', 'type', 'notes'] },
        ),
      },
    )
    .map((m) => m as Draft);
}

export interface PieceShape {
  pool: number;
  maxT: number;
  maxMoments: number;
  /** Give voices individual ranges (some narrower than an octave). */
  varyRanges: boolean;
  /** Put voices in parts 'A', 'B' or none (revision 9), and target parts. */
  parts: boolean;
}

/** A random valid piece. */
export function pieceArb(shape: Partial<PieceShape> = {}): fc.Arbitrary<Piece> {
  const maxT = shape.maxT ?? 40;
  return fc
    .record({
      seed: fc.integer({ min: 0, max: 0xffff }),
      pool: shape.pool !== undefined ? fc.constant(shape.pool) : fc.integer({ min: 3, max: 16 }),
      glide: glideArb,
      starts: fc.array(fc.integer({ min: 40, max: 80 }), { minLength: 0, maxLength: 4 }),
      ranges: shape.varyRanges
        ? fc.array(
            fc
              .tuple(fc.integer({ min: 30, max: 70 }), fc.integer({ min: 8, max: 40 }))
              .map(([lo, w]) => [lo, lo + w] as [number, number]),
            { minLength: 16, maxLength: 16 },
          )
        : fc.constant(null),
      parts: shape.parts
        ? fc.array(fc.constantFrom<string | undefined>(...PART_NAMES, undefined), {
            minLength: 16,
            maxLength: 16,
          })
        : fc.constant(null),
    })
    .chain((r) => {
      const ids = Array.from({ length: r.pool }, (_, i) => `v${i + 1}`);
      return fc
        .array(momentArb(ids, maxT, r.parts !== null), {
          minLength: 1,
          maxLength: shape.maxMoments ?? 14,
        })
        .map((moments) => {
          const p = newPiece({ seed: r.seed, poolSize: r.pool });
          p.defaults.glide = r.glide;
          p.voices.forEach((v, i) => (v.range = r.ranges ? r.ranges[i] : [36, 96]));
          if (r.parts) {
            const parts = r.parts;
            p.voices.forEach((v, i) => {
              if (parts[i] !== undefined) v.part = parts[i];
            });
          }
          p.moments = moments.map((m, i) => {
            // Half the notes start on a start pitch, so they often find their note sounding.
            const from =
              m.type === 'note' && i % 2 === 0 && r.starts.length > 0
                ? { from: r.starts[i % Math.min(r.starts.length, r.pool)] }
                : {};
            const out = { ...m, ...from, id: `m${i.toString(36).padStart(5, '0')}` } as Record<
              string,
              unknown
            >;
            const more = out.more as { from: number; to: number }[] | undefined;
            delete out.more;
            if (more) {
              out.changes = [{ from: out.from, to: out.to }, ...more];
              delete out.from;
              delete out.to;
            }
            return out as unknown as Moment;
          });
          p.moments = withStart(p, r.starts.slice(0, r.pool));
          return p;
        });
    });
}
