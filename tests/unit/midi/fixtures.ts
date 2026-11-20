/** Hand-built CompiledScore fixtures for the MIDI exporter tests. */

import { evalSegment } from '../../../src/core/segment';
import type {
  CompiledScore,
  CompiledVoice,
  EaseRef,
  LevelChange,
  Life,
  Segment,
} from '../../../src/core/types';

export function hold(t0: number, t1: number, p: number): Segment {
  return { t0, t1, p0: p, p1: p, ease: 'linear' };
}

export function glide(
  t0: number,
  t1: number,
  p0: number,
  p1: number,
  ease: EaseRef = 'smootherstep',
  m0?: number,
): Segment {
  return m0 === undefined ? { t0, t1, p0, p1, ease } : { t0, t1, p0, p1, ease, m0 };
}

/** A glide planned to run t0..plannedT1 to plannedP1 but cut at cutT, as an interruption leaves it. */
export function cutGlide(
  t0: number,
  cutT: number,
  p0: number,
  plannedT1: number,
  plannedP1: number,
  ease: EaseRef = 'smootherstep',
  m0?: number,
): Segment {
  const planned = glide(t0, plannedT1, p0, plannedP1, ease, m0);
  return {
    ...planned,
    t1: cutT,
    p1: evalSegment(planned, cutT),
    curve: { t1: plannedT1, p1: plannedP1 },
  };
}

export function voice(
  index: number,
  lives: Life[],
  segments: Segment[],
  level: LevelChange[] = [],
): CompiledVoice {
  return {
    id: `v${index + 1}`,
    index,
    lives,
    segments,
    timbre: [{ t: 0, preset: 'sine', fade: 0 }],
    level,
    gain: 1,
    pan: 'auto',
    mute: false,
    solo: false,
    sends: {},
  };
}

export function score(voices: CompiledVoice[], duration: number, referenceHz = 440): CompiledScore {
  return {
    duration,
    voices,
    momentSpans: [],
    diagnostics: [],
    keys: [{ t: 0, key: { tonic: 'C', scale: 'major' } }],
    referenceHz,
    seed: 1,
  };
}

const EASES: EaseRef[] = [
  'smootherstep',
  'smoothstep',
  'cosine',
  'linear',
  'expo',
  { kind: 'bezier', x1: 0.3, y1: -0.4, x2: 0.7, y2: 1.5 },
];

/** One voice per ease: born holding on a fractional pitch, glides up 17.5 st and back down. */
export function easeScore(): CompiledScore {
  const voices = EASES.map((e, i) => {
    const p0 = 55.3 + i;
    const p1 = p0 + 17.5;
    return voice(
      i,
      [{ born: 0.5, died: 11, fadeIn: 0.5, fadeOut: 1 }],
      [
        hold(0.5, 2, p0),
        glide(2, 5, p0, p1, e),
        hold(5, 7, p1),
        glide(7, 9.5, p1, p0, e),
        hold(9.5, 11, p0),
      ],
    );
  });
  return score(voices, 11);
}

/** Interruptions (m0), cut segments, births and deaths mid-glide, level ramps, two lives. */
export function lifeScore(referenceHz = 440): CompiledScore {
  // v1: a glide cut at 3.2 s by an interruption; the next glide carries m0 from the cut.
  const cutA = cutGlide(2, 3.2, 60, 5, 72, 'smootherstep');
  const cutB = glide(3.2, 6, cutA.p1, 64.4, 'cosine', 3.1);
  const v1 = voice(
    0,
    [{ born: 0, died: 8, fadeIn: 0, fadeOut: 1.5 }],
    [hold(0, 2, 60), cutA, cutB, hold(6, 8, 64.4)],
  );
  // v2: two lives; the first dies in the middle of a glide, the second is born gliding.
  const v2 = voice(
    1,
    [
      { born: 1, died: 4.5, fadeIn: 0.5, fadeOut: 0.3 },
      { born: 6, died: 10, fadeIn: 1.25, fadeOut: 2 },
    ],
    [
      hold(1, 2.5, 48.5),
      cutGlide(2.5, 4.5, 48.5, 5.5, 56, 'linear'),
      glide(6, 8, 70, 62.25, 'expo'),
      hold(8, 10, 62.25),
    ],
    [
      { t: 7, gain: 0.4, over: 1 },
      { t: 9, gain: 1, over: 0 },
    ],
  );
  // v3: a cut glide whose follower is an m0 hold-start (p0 = p1 but moving), bezier overshoot.
  const cutC = cutGlide(
    1,
    2.4,
    50,
    4,
    66,
    { kind: 'bezier', x1: 0.2, y1: -0.3, x2: 0.8, y2: 1.4 },
    -2,
  );
  const v3 = voice(
    2,
    [{ born: 0.2, died: 9.6, fadeIn: 0.001, fadeOut: 0.004 }],
    [
      hold(0.2, 1, 50),
      cutC,
      glide(2.4, 3.6, cutC.p1, cutC.p1, 'smoothstep', 2.5),
      hold(3.6, 9.6, cutC.p1),
    ],
  );
  // v4: never sounds. v5: alive at the end (no died).
  const v4 = voice(3, [], []);
  const v5 = voice(
    4,
    [{ born: 3, fadeIn: 1 }],
    [hold(3, 5, 80), glide(5, 12, 80, 40, 'smootherstep'), hold(12, 12, 40)],
  );
  return score([v1, v2, v3, v4, v5], 12, referenceHz);
}

/** Wide and fast glides that run out of bend range: 40 st in 2 s, 36 st in 0.05 s, an up-down. */
export function wideScore(): CompiledScore {
  const lives = (d: number): Life[] => [{ born: 0, died: d, fadeIn: 0.1, fadeOut: 0.1 }];
  const v1 = voice(0, lives(6), [
    hold(0, 1, 40.2),
    glide(1, 3, 40.2, 80.2, 'smootherstep'),
    hold(3, 6, 80.2),
  ]);
  const v2 = voice(1, lives(6), [
    hold(0, 1, 90.7),
    glide(1, 3, 90.7, 50.7, 'cosine'),
    hold(3, 6, 50.7),
  ]);
  const v3 = voice(2, lives(6), [
    hold(0, 1, 50),
    glide(1, 1.05, 50, 86, 'smootherstep'),
    hold(1.05, 6, 86),
  ]);
  const v4 = voice(3, lives(6), [
    hold(0, 1, 60),
    glide(1, 2, 60, 80, 'linear'),
    glide(2, 3, 80, 40, 'smoothstep'),
    glide(3, 3.7, 40, 41.5, 'expo'),
    hold(3.7, 6, 41.5),
  ]);
  return score([v1, v2, v3, v4], 6);
}

/** n voices that each hold, glide and hold again, for the MPE split. */
export function manyVoices(n: number): CompiledScore {
  const voices = Array.from({ length: n }, (_, i) =>
    voice(
      i,
      [{ born: 0.1 * i, died: 6 + 0.1 * i, fadeIn: 0.5, fadeOut: 0.5 }],
      [
        hold(0.1 * i, 2 + 0.1 * i, 48 + i),
        glide(2 + 0.1 * i, 4 + 0.1 * i, 48 + i, 52.4 + i),
        hold(4 + 0.1 * i, 6 + 0.1 * i, 52.4 + i),
      ],
    ),
  );
  return score(voices, 7.1 + 0.1 * n);
}
