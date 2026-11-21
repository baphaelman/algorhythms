/**
 * Regressions for the core property seeds that failed after M4.5-29a (build log "M4.5 property
 * seeds after 29").
 */
import { describe, expect, it } from 'vitest';
import { compile, compileWithTrace } from '../../../src/core/compiler/compile';
import { linesAt, pitchAt, stackAt } from '../../../src/core/query';
import { chordAt, piece } from './compiler-fixtures';
import { lineArtifacts } from './line-artifacts';

describe('note moments after cancelling pending moves (note 2611/332)', () => {
  it("an ordered note's intents stay sorted by target when it cancels staggered moves", () => {
    // v4 and v5 head low (v5's move still pending at 1.5 s); the note cancels v5's pending move
    // and re-plans it to the same destination. Its intents were listed in the post-cancel order
    // (v5 back on 96), so 39 came last.
    const p = piece({
      start: [40, 52, 60, 72, 96],
      glide: { length: 2, jitter: 0, stagger: 4, order: 'low-first', ease: 'linear' },
      moments: [
        {
          type: 'chord',
          at: 1,
          target: { voices: ['v4', 'v5'] },
          notes: { kind: 'pitches', pitches: [38, 39] },
          voicing: 'even',
          assign: 'ordered',
        },
        { type: 'note', at: 1.5, order: true, from: 52, to: 55 },
      ],
    });
    const { trace } = compileWithTrace(p);
    const m = trace.moments.find((x) => x.id === 'm1')!;
    expect(m.plan?.ordered).toBe(true);
    const tos = m.intents!.map((it) => it.to);
    expect(tos).toEqual([38, 39, 40, 55, 60]);
  });

  it('marks a logical target folded into range (note 512133634/732)', () => {
    // A stacked line's copy sent below the range folds per logical voice; when that copy cannot
    // fork (pool exhausted) no pool target folds, so the trace itself must say it was folded.
    const p = piece({
      pool: 2,
      start: [40, 40],
      glide: { length: 1, jitter: 0, stagger: 0, ease: 'linear' },
      moments: [{ type: 'note', at: 5, order: true, from: 40, to: 30 }],
    });
    const { trace } = compileWithTrace(p);
    const m = trace.moments.find((x) => x.id === 'm0')!;
    expect(m.logical).toEqual([
      { voice: 0, to: 42, kind: 'move', folded: true },
      { voice: 1, to: 40, kind: 'move' },
    ]);
    expect(m.intents!.some((it) => 'folded' in it)).toBe(false);
  });
});

describe('newborns of one parent (chord-count 439040815/857)', () => {
  it('forks born together on a moving parent do not swap right after their birth', () => {
    // v1 is mid walk step when the chord forks four lines off it. With a steep-start bézier, each
    // newborn's carried velocity m₀ = v·d − Δ·e′(0) differs by its interval Δ, so v10 (to 86)
    // dipped below v9 (to 84) at first; the planner took that for "out of order before the
    // moment" and left it.
    const p = piece({
      seed: 32011,
      pool: 15,
      start: [62, 51, 50],
      glide: { length: 4.7, jitter: 0.8, stagger: 1, order: 'high-first', ease: 'smootherstep' },
      moments: [
        {
          id: 'm00002',
          type: 'walk',
          at: 0.6,
          grid: 1.1,
          density: 0.6,
          steps: [1, 2, 3],
          stepGlide: 0.8,
          until: 8.5,
          glide: { length: 2.1, jitter: 0, stagger: 1.2, order: 'low-first', ease: 'cosine' },
        },
        {
          id: 'm00005',
          type: 'chord',
          at: 2,
          notes: { kind: 'current' },
          voicing: 'nearest',
          assign: 'ordered',
          count: 11,
          byVoice: true,
          glide: {
            length: 1.8,
            jitter: 0.8,
            stagger: 0.9,
            ease: { kind: 'bezier', x1: 0.3, y1: 0.9, x2: 0.8, y2: 0.2 },
          },
        },
      ],
    });
    const { score, trace } = compileWithTrace(p);
    const m = trace.moments.find((x) => x.id === 'm00005')!;
    const born = new Set(m.intents!.filter((x) => x.kind === 'birth').map((x) => x.voice));
    expect(born.size).toBeGreaterThan(3);
    const [ws, we] = m.plan!.window;
    let pairs = 0;
    for (let k = 0; k + 1 < m.plan!.order.length; k++) {
      const lo = score.voices[m.plan!.order[k]];
      const hi = score.voices[m.plan!.order[k + 1]];
      if (!born.has(lo.index) || !born.has(hi.index)) continue;
      pairs++;
      // Between the planner's 64 check samples a sliver may remain (as the property allows).
      for (let j = 0; j <= 200; j++) {
        const t = ws + ((we - ws) * j) / 200;
        const a = pitchAt(lo, t);
        const b = pitchAt(hi, t);
        if (a !== null && b !== null)
          expect(a, `${lo.id}/${hi.id} at ${t}`).toBeLessThanOrEqual(b + 0.02);
      }
    }
    expect(pairs).toBeGreaterThan(2);
  });
});

describe('a line that joins another passes on what depended on it (chord-count 439040815)', () => {
  it('lines dying into it follow its survivor, not the voice reborn later (/984)', () => {
    // m1 sends v1 and v6 to 90 (they join: v6 closes into v1) while v7 and v8 die into v6. m2
    // reuses v6 as a newborn going to 27: v7 and v8 followed it down through the other lines.
    const s = compile(
      piece({
        seed: 65534,
        pool: 10,
        range: [24, 108],
        start: [72],
        glide: {
          length: 2.5,
          jitter: 0,
          stagger: 1.4,
          arrive: 'together',
          order: 'random',
          ease: 'smoothstep',
        },
        end: { at: 30, fade: 2 },
        moments: [
          {
            type: 'chord',
            at: 1,
            notes: { kind: 'chord', symbol: 'Esus4' },
            voicing: 'nearest',
            assign: 'ordered',
            count: 8,
          },
          {
            type: 'chord',
            at: 5.2,
            notes: { kind: 'pitches', pitches: [86, 90, 75, 90] },
            voicing: 'close',
            assign: 'ordered',
            count: 3,
          },
          {
            type: 'chord',
            at: 9.4,
            notes: { kind: 'current' },
            voicing: 'even',
            assign: 'ordered',
            count: 4,
          },
        ],
      }),
    );
    const v6 = s.voices[5];
    expect(v6.lives.length).toBe(2); // joined at 90, reborn by m2
    for (const id of ['v7', 'v8']) {
      const v = s.voices.find((x) => x.id === id)!;
      for (const g of v.segments) expect(g.p1, `${id} at ${g.t0}`).toBeGreaterThanOrEqual(89.99);
    }
    expect(lineArtifacts(s)).toEqual([]);
  });

  it('a fork still waiting on it is born from its survivor, on the note it joined (/429)', () => {
    // At 33.4 the spread forks a copy of v6 (hand-set to 43.4) while v6 is gliding onto v4's
    // note 52, where it joins and closes at 33.56; the fork is born at 34.76, after that.
    const s = compile(
      piece({
        seed: 25284,
        pool: 14,
        start: [56],
        glide: { length: 4.9, jitter: 0, stagger: 0.2, order: 'random', ease: 'expo' },
        end: { at: 45, fade: 2 },
        moments: [
          {
            type: 'chord',
            id: 'm00008',
            at: 2.9,
            notes: { kind: 'pitches', pitches: [29, 54] },
            voicing: 'close',
            assign: 'free',
            count: 9,
            byVoice: false,
            glide: {
              length: 3.8,
              jitter: 1,
              stagger: 2.6,
              order: 'random',
              ease: { kind: 'bezier', x1: 0.8, y1: -0.4, x2: 0.1, y2: -0.5 },
            },
          },
          {
            type: 'chord',
            id: 'm00000',
            at: 3.4,
            notes: { kind: 'pitches', pitches: [54, 76] },
            voicing: 'nearest',
            assign: 'ordered',
            count: 6,
            byVoice: false,
            glide: {
              length: 1.5,
              jitter: 0.6,
              stagger: 0,
              order: 'outside-in',
              ease: { kind: 'bezier', x1: 0.9, y1: 0.8, x2: 0.2, y2: 0.6 },
            },
          },
          {
            type: 'chord',
            id: 'm00003',
            at: 27.4,
            notes: { kind: 'current' },
            voicing: 'close',
            assign: 'ordered',
            register: [43, 52],
            count: 13,
            byVoice: false,
            glide: { jitter: 0.3, stagger: 0.1, order: 'high-first', ease: 'smootherstep' },
          },
          {
            type: 'spread',
            id: 'm00007',
            at: 33.4,
            target: { rank: [2, 5] },
            factor: 1.6,
            around: 'mean',
            snap: 'scale',
            overrides: [
              { voice: 2, end: 4.9 },
              { voice: 5, pitch: 43.4, end: 3.9 },
            ],
            glide: {
              length: 5.1,
              jitter: 0.6,
              stagger: 2.2,
              order: 'low-first',
              ease: { kind: 'bezier', x1: 0.3, y1: 1.1, x2: 0.6, y2: 0.9 },
            },
          },
        ],
      }),
    );
    const v7 = s.voices[6];
    const life = v7.lives[v7.lives.length - 1];
    expect(life.born).toBeGreaterThan(34);
    expect(pitchAt(v7, life.born + 1e-6)).toBeCloseTo(52, 3); // on v4, which v6 joined
    expect(lineArtifacts(s, { noCross: true })).toEqual([]);
  });
});

describe('a fork whose move a later moment replaces (crossings −1185324365/156)', () => {
  it('goes where its parent goes and rejoins it on arrival', () => {
    // The pin forks a copy of the stacked line toward 50 (born later, by its stagger); the shift
    // cancels that move before the birth, so the fork moves with its parent and joins it. The
    // two meet on one note (the crossing property no longer counts such a pair as crossing).
    const s = compile(
      piece({
        pool: 3,
        start: [60, 60],
        glide: { length: 2, jitter: 0, stagger: 0.5, ease: 'cosine' },
        end: { at: 12, fade: 1 },
        moments: [
          { type: 'pin', at: 1, voice: 'v2', pitch: 50, glide: { stagger: 3 } },
          { type: 'shift', at: 1.1, by: -2, unit: 'semitones' },
        ],
      }),
    );
    expect(linesAt(s, 8)).toBe(1);
    expect(chordAt(s, 8)).toEqual([58]);
    const line = s.voices.find((v) => pitchAt(v, 8) === 58)!;
    expect(stackAt(line, 8)).toBe(2);
  });
});

describe('a fork of a line not born yet (chord-count 1987819535/617, sweep)', () => {
  it('starts where that line still is, on its parent', () => {
    // The split's newborns stand for two voices each (the start is one stacked line); the unison
    // forks a copy of v4 before v4 itself is born (its birth moved to its new departure), so the
    // fork v5 was born in mid-air on its target 81. It now starts on v1, where v4 still is.
    const s = compile(
      piece({
        seed: 65535,
        pool: 11,
        start: [67, 67],
        glide: { length: 4.6, jitter: 0.1, stagger: 0.6, order: 'outside-in', ease: 'smoothstep' },
        end: { at: 30, fade: 2 },
        moments: [
          {
            id: 'm00000',
            type: 'chord',
            at: 2.8,
            notes: { kind: 'degrees', degrees: [1, 6, 8, 2] },
            voicing: 'nearest',
            assign: 'ordered',
            register: [68, 98],
            count: 1,
            overrides: [{ voice: 10, pitch: 79, end: 5.5 }],
          },
          { id: 'm00008', type: 'split', at: 7.9, count: 9, voicing: 'close' },
          {
            id: 'm00002',
            type: 'unison',
            at: 8.1,
            target: { voices: ['v3', 'v5', 'v6', 'v7', 'v8', 'v10', 'v11'] },
            pitch: 'tonic',
            octaves: false,
            glide: {
              length: 6,
              jitter: 0.7,
              stagger: 2.2,
              order: 'outside-in',
              ease: 'smootherstep',
            },
          },
          {
            id: 'm00004',
            type: 'split',
            at: 8.6,
            target: { voices: ['v2', 'v4', 'v5', 'v6', 'v7', 'v10'] },
            count: 3,
            voicing: 'nearest',
            glide: { length: 4.2, order: 'random', ease: 'smootherstep' },
          },
        ],
      }),
    );
    expect(lineArtifacts(s, { noCross: true }).filter((a) => a.kind === 'birth')).toEqual([]);
    const v5 = s.voices[4];
    expect(v5.lives.length).toBeGreaterThan(0);
    expect(pitchAt(v5, v5.lives[0].born + 1e-6)).toBeCloseTo(71, 3);
  });

  it('waits for that line to be born (chord-count 512133634/367, sweep)', () => {
    // Two chords at one time: the first births v7 (fresh, at 7.79 by its stagger), the second
    // forks v9 off v7, drawn to start at 7.70, before v7 sounds: v9 was born in mid-air.
    const s = compile(
      piece({
        seed: 55180,
        pool: 15,
        start: [],
        glide: { length: 0.4, jitter: 0.6, stagger: 0.3, order: 'random', ease: 'smoothstep' },
        end: { at: 12, fade: 1 },
        moments: [
          {
            id: 'm00003',
            type: 'chord',
            at: 7.6,
            target: { voices: ['v1', 'v2', 'v3', 'v4', 'v6', 'v7', 'v9', 'v10', 'v15'] },
            notes: { kind: 'degrees', degrees: [1] },
            voicing: 'close',
            assign: 'ordered',
            register: [43, 53],
            count: 14,
          },
          {
            id: 'm00008',
            type: 'chord',
            at: 7.6,
            target: { voices: ['v4', 'v5', 'v6', 'v7', 'v8', 'v10', 'v11'] },
            notes: { kind: 'degrees', degrees: [2, 8, 6] },
            voicing: 'nearest',
            assign: 'ordered',
            byVoice: false,
          },
        ],
      }),
    );
    const v7 = s.voices[6];
    const v9 = s.voices[8];
    // Fresh births (v1, v4, …) appear on their own notes; the fork must appear on v7's.
    expect(lineArtifacts(s, { noCross: true }).filter((a) => a.voice === 'v9')).toEqual([]);
    expect(v9.lives[0].born).toBeGreaterThanOrEqual(v7.lives[0].born);
    expect(pitchAt(v9, v9.lives[0].born + 1e-6)).toBeCloseTo(71, 3);
  });
});

describe('a newborn re-planned before its birth (crossings 439040815/675, sweep)', () => {
  it('the planner sees it born when its new move departs, as the compiler does', () => {
    // The chord count births v4 and v5; two shifts re-plan them before they sound, so each is
    // born when its new move departs (29a). The planner projected them born at the old time, on
    // their parent's pitch, and missed v5 passing above v4 (by ~0.02 st) after its birth.
    const s = compile(
      piece({
        seed: 12376,
        pool: 10,
        start: [47, 72, 54],
        glide: {
          length: 2.6,
          jitter: 0.3,
          stagger: 0.5,
          order: 'center-out',
          ease: 'smootherstep',
        },
        end: { at: 12, fade: 1 },
        moments: [
          {
            id: 'm00002',
            type: 'chord',
            at: 0.1,
            notes: { kind: 'current' },
            voicing: 'even',
            assign: 'ordered',
            count: 10,
            byVoice: true,
            glide: { length: 5.4, jitter: 0.5, stagger: 1.2, order: 'low-first', ease: 'cosine' },
          },
          {
            id: 'm00008',
            type: 'shift',
            at: 0.5,
            by: -5,
            unit: 'semitones',
            glide: { length: 0.5, jitter: 0.9, stagger: 2.7, order: 'low-first', ease: 'linear' },
          },
          { id: 'm00001', type: 'shift', at: 0.6, by: -4, unit: 'scaleSteps' },
        ],
      }),
    );
    const [v4, v5] = [s.voices[3], s.voices[4]];
    const reported = s.diagnostics.some(
      (d) => d.momentId === 'm00001' && d.code === 'crossing-unresolved',
    );
    let crossed = false;
    for (let j = 0; j <= 400; j++) {
      const t = 1.2 + (4.3 * j) / 400;
      const a = pitchAt(v5, t);
      const b = pitchAt(v4, t);
      if (a !== null && b !== null && a > b + 1e-9) crossed = true;
    }
    expect(crossed && !reported).toBe(false);
  });
});

describe('a line dying into its own unborn newborn (chord-count -41577023/608, sweep)', () => {
  it('the newborn is born when the weight passes, on the dying line, not later in mid-air', () => {
    // The split forks v4 off v1 (born later, by its stagger); the merge then kills v1 into v4,
    // its neighbour by destination. v1 closed before v4's birth, so v4 had no parent left and
    // appeared on its own target, and v1's weight went nowhere.
    const s = compile(
      piece({
        seed: 32287,
        pool: 13,
        start: [63],
        glide: { length: 5, jitter: 0.9, stagger: 2.8, order: 'high-first', ease: 'smootherstep' },
        end: { at: 30, fade: 1 },
        moments: [
          {
            id: 'm00001',
            type: 'spread',
            at: 18.7,
            factor: -0.8,
            around: 'median',
            snap: 'scale',
            glide: { length: 0.7, jitter: 0.7, stagger: 0.6, order: 'low-first', ease: 'linear' },
          },
          {
            id: 'm00000',
            type: 'split',
            at: 19.1,
            target: { rank: [6, 8] },
            count: 8,
            voicing: 'close',
            glide: { jitter: 0.9, stagger: 2.2, order: 'random', ease: 'linear' },
          },
          {
            id: 'm00007',
            type: 'merge',
            at: 19.7,
            count: 4,
            which: 'random',
            fade: 0.7,
            glide: { length: 0.5, jitter: 0.7, stagger: 1.9, order: 'center-out', ease: 'linear' },
          },
        ],
      }),
    );
    const v4 = s.voices[3];
    expect(v4.lives.length).toBeGreaterThan(0);
    expect(lineArtifacts(s, { noCross: true }).filter((a) => a.kind === 'birth')).toEqual([]);
  });
});
