/**
 * Regressions for the core property seeds that failed after M4.5-29a (build log "M4.5 property
 * seeds after 29" and "M4.5 property seeds 2").
 */
import { describe, expect, it } from 'vitest';
import { compile, compileWithTrace } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { spreadInRange } from '../../../src/core/moments/spread';
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
    // v6 joins at 90 (with the crossfade, 2026-11-21, it closes at the meeting and m2 may reuse
    // another voice): either way v7 and v8 must not follow a reborn v6 down.
    for (const id of ['v7', 'v8']) {
      const v = s.voices.find((x) => x.id === id)!;
      for (const g of v.segments) expect(g.p1, `${id} at ${g.t0}`).toBeGreaterThanOrEqual(89.99);
    }
    expect(lineArtifacts(s)).toEqual([]);
  });

  it('a fork still waiting on it is born from its survivor, on the note it joined (/429)', () => {
    // At 33.4 the spread forked a copy of v6 (hand-set to 43.4) while v6 was gliding onto v4's
    // note 52, where it joined and closed at 33.56; the fork was born at 34.76, after that.
    // Revision 9 birth timings (ranked stagger offsets) no longer set this up; the piece stays
    // as a no-artifact regression.
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
    expect(lineArtifacts(s, { noCross: true })).toEqual([]);
  });
});

describe('a fork whose move a later moment replaces (crossings −1185324365/156)', () => {
  it('goes where its parent goes and rejoins it on arrival', () => {
    // The pin forks a copy of the stacked line toward 50; the shift at the same time cancels that
    // move before the birth (revision 9: a lone newborn starts on time, so the shift no longer
    // waits for a birth stagger), so the fork moves with its parent and joins it. The two meet on
    // one note (the crossing property no longer counts such a pair as crossing).
    const s = compile(
      piece({
        pool: 3,
        start: [60, 60],
        glide: { length: 2, jitter: 0, stagger: 0.5, ease: 'cosine' },
        end: { at: 12, fade: 1 },
        moments: [
          { type: 'pin', at: 1, voice: 'v2', pitch: 50, glide: { stagger: 3 } },
          { type: 'shift', at: 1, by: -2, unit: 'semitones' },
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
    // Schema v2: from silence the first chord establishes (at 7.6, no stagger or fade-in): its 14
    // voices on the 5 octaves of one pitch class in range, as 5 lines. The second chord's forks
    // then always find their parents sounding.
    const est = s.voices.filter((v) => v.lives[0]?.born === 7.6 && v.lives[0].fadeIn === 0);
    expect(est).toHaveLength(5);
    expect(lineArtifacts(s, { noCross: true }).filter((a) => a.kind === 'birth')).toEqual([]);
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
    // Revision 9 timings make v4 the lower line here: any change of order counts.
    let crossed = false;
    let sign = 0;
    for (let j = 0; j <= 400; j++) {
      const t = 1.2 + (4.3 * j) / 400;
      const a = pitchAt(v5, t);
      const b = pitchAt(v4, t);
      if (a === null || b === null || Math.abs(a - b) <= 1e-9) continue;
      const sg = a > b ? 1 : -1;
      if (sign !== 0 && sg !== sign) crossed = true;
      sign = sg;
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
    // v1 meets its survivor v2 as v2 is born: no room for a crossfade before the meeting, so it
    // keeps its own fade after it (crossfades, 2026-11-21).
    const v1 = s.voices[0].lives[0];
    expect(v1.crossOut).toBeUndefined();
    expect(v1.fadeOut).toBeCloseTo(0.7, 9);
    expect(lineArtifacts(s, { noCross: true }).filter((a) => a.kind === 'birth')).toEqual([]);
  });
});

describe('a crowded spread with per-voice ranges (spread −625473937/387)', () => {
  it('keeps the notes in order as well as in range', () => {
    // A squeeze to 45.5 on F# minor pentatonic: 8 voices, 8 scale notes in [37, 54], but v4's
    // range starts at 43 and v8's ends at 51, so some must coincide. Clamping each to its own
    // range put v4 on 45 above v5 on 42.
    const dests = [37, 39, 40, 45, 46, 47, 48, 49];
    const ranges = dests.map((): [number, number] => [37, 54]);
    ranges[3] = [43, 54];
    ranges[7] = [37, 51];
    const r = spreadInRange(dests, ranges, 45.5, 1e-9, 'scale', {
      tonic: 'F#',
      scale: 'pentatonic-minor',
    });
    expect(r.ok).toBe(false);
    r.pitches.forEach((p, i) => {
      expect(p).toBeGreaterThanOrEqual(ranges[i][0]);
      expect(p).toBeLessThanOrEqual(ranges[i][1]);
      if (i > 0) expect(p).toBeGreaterThanOrEqual(r.pitches[i - 1]);
    });
  });
});

describe('a walk’s span across a checkpoint (incremental −1808251847/498, 128577514/91)', () => {
  it('a resume between a walk’s moment event and its first tick keeps its span growing', () => {
    // The checkpoint before m2 (third moment event at 1) has handled m0's moment event but not
    // its first tick, which the setup queues and the checkpoint does not save; so m0 counted as
    // final and kept the old run's span end (3.9) where adding the pin skips the last step (3.5).
    const walk = {
      type: 'walk' as const,
      at: 1,
      target: { voices: ['v1'] },
      grid: 1,
      density: 1,
      steps: [1],
      stepGlide: 0.9,
      until: 3.5,
    };
    const lvl = { type: 'level' as const, gain: 0.9, over: 0, at: 1 };
    const p2 = piece({
      start: [60, 48],
      glide: { length: 3, jitter: 0, stagger: 0, ease: 'linear' },
      moments: [walk, lvl, lvl, { type: 'pin', at: 2.5, voice: 'v1', pitch: 70 }],
    });
    const p1 = { ...p2, moments: p2.moments.slice(0, 3) };
    const inc = createIncrementalCompiler();
    inc.compile(p1);
    const got = inc.compile(p2);
    expect(inc.stats.mode).toBe('resume');
    expect(inc.stats.from).toBe(1);
    const want = compile(p2);
    expect(want.momentSpans.find((m) => m.id === 'm0')!.end).toBe(3.5);
    expect(structuredClone(got)).toStrictEqual(structuredClone(want));
  });
});

describe('a dying line whose survivor’s move is replaced (chord-count 599296392/298)', () => {
  it('waits for the survivor’s new move instead of fading where it no longer goes', () => {
    // m1 kills v9 into a neighbour; m2's staggered move of that neighbour is where v9's death
    // glide heads, but m3 replaces it with a later move before it starts. v9 faded on its stale
    // target at its old time, the survivor elsewhere.
    const s = compile(
      piece({
        seed: 59130,
        pool: 9,
        start: [70],
        key: { tonic: 'A', scale: 'dorian' },
        glide: { length: 1.1, jitter: 0, stagger: 1.4, order: 'low-first', ease: 'linear' },
        end: { fade: 6 },
        moments: [
          {
            id: 'm00002',
            type: 'split',
            at: 13,
            count: 10,
            notes: { kind: 'chord', symbol: 'Esus4' },
            voicing: 'even',
          },
          { id: 'm00005', type: 'merge', at: 23, count: 7, which: 'top', fade: 1.3 },
          {
            id: 'm00006',
            type: 'chord',
            at: 23.5,
            glide: { length: 4.3, jitter: 1, stagger: 3, order: 'low-first', ease: 'expo' },
            notes: { kind: 'current' },
            voicing: 'close',
            assign: 'free',
          },
          {
            id: 'm00008',
            type: 'split',
            at: 26,
            count: 6,
            notes: { kind: 'pitches', pitches: [27, 72, 66] },
            voicing: 'close',
          },
        ],
      }),
    );
    expect(s.voices[8].lives[0].died).toBeGreaterThan(23);
    expect(lineArtifacts(s, { noCross: true }).filter((a) => a.kind === 'death')).toEqual([]);
  });
});

describe('a merge and its survivor’s walk tick at one time (overlap −41577023/907)', () => {
  it('the dying line follows the walk step from the start: no death glide of its own is left', () => {
    // v2 dies into v1 at 3 while the walk steps v1 at 3. The follow (M4.5-17) replaces v2's
    // death glide as it starts, so v2's next segment is the walk's; the property took that for
    // a walk step cutting v2's pin glide. Compiler unchanged (predates the 29 seeds fixes).
    const s = compile(
      piece({
        start: [48, 60],
        glide: { length: 2, jitter: 0, stagger: 0, ease: 'linear' },
        moments: [
          { type: 'pin', at: 1.5, voice: 'v2', pitch: 64 },
          {
            type: 'walk',
            at: 0,
            target: { voices: ['v1'] },
            grid: 1,
            density: 1,
            steps: [1],
            stepGlide: 0.2,
            until: 8,
          },
          { type: 'merge', at: 3, count: 1, which: 'top', fade: 0.2 },
        ],
      }),
    );
    const [v1, v2] = s.voices;
    const step = v1.segments.find((g) => g.t0 === 3)!;
    expect(step.momentId).toBe('m1');
    const cut = v2.segments.find((g) => g.momentId === 'm0')!;
    expect(cut.t1).toBe(3); // the pin's glide was still running
    const next = v2.segments.find((g) => g.t0 === 3)!;
    expect(next.momentId).toBe('m1');
    expect(next.p1).toBe(step.p1);
    expect(v2.segments.some((g) => g.momentId === 'm2')).toBe(false);
    // It still rides v1's steps until it meets v1 after the merge's glide, crossfading into it
    // (2026-11-21: the merge's `fade` no longer runs after the meeting).
    expect(v2.lives[0].died).toBeCloseTo(5, 6);
    expect(v2.lives[0].crossOut).toBe(true);
    for (const t of [3.5, 4.5, 4.99]) expect(pitchAt(v2, t)).toBe(pitchAt(v1, t));
  });
});
