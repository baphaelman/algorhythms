import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store needs a few browser globals and the audio module; stub them before importing it.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  g.document = {
    title: '',
    querySelector: () => null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  g.location = { hash: '', pathname: '/', search: '' };
  g.history = { replaceState: () => undefined };
  g.requestAnimationFrame = (cb: (t: number) => void) => {
    cb(0);
    return 0;
  };
  const store = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

interface Job {
  score: CompiledScore;
  from: number;
}
const audio = vi.hoisted(() => ({ jobs: [] as Job[], fades: [] as (number | undefined)[] }));
vi.mock('../../../src/app/audio', () => {
  const ok = () => Promise.resolve({});
  return {
    configureAudio: () => undefined,
    getEngine: () => null,
    loadAudio: ok,
    mixAudio: ok,
    primeAudio: ok,
    resumeAudio: () => undefined,
    swapAudio: ok,
    whenReady: ok,
    loopAudio: ok,
    auditionAudio: (score: CompiledScore, _t: unknown, _c: unknown, _w: unknown, from = 0) => {
      audio.jobs.push({ score, from });
      return Promise.resolve(true);
    },
    endAuditionAudio: (fade?: number) => {
      audio.fades.push(fade);
    },
  };
});

import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import { evalSegment } from '../../../src/core/segment';
import { pitchAt } from '../../../src/core/query';
import type { CompiledScore, Moment, Piece } from '../../../src/core/types';
import { withOpening } from '../opened-piece';
import { auditionState, stopAudition } from '../../../src/app/audition';
import {
  AFTER_SECONDS,
  HOLD_SECONDS,
  hoverPlan,
  hoverScore,
  hoverSoundState,
  playHover,
  setHoverSound,
  soundPreview,
  stopHoverSound,
  useHoverSound,
} from '../../../src/app/hover-sound';
import { cardResult, resultLabel } from '../../../src/app/editor/card-result';
import { appendMoment } from '../../../src/app/editor/suggestions';
import { startMomentPreview, stopPreview } from '../../../src/app/preview';
import { loadPiece, usePlayer } from '../../../src/app/store';

const PROBE = '__probe';

/** Three lines from 0 (A3, C4, E4 by a split), C major at 4 s, then `extra`. */
function piece(extra: Moment[] = []): Piece {
  const p = withOpening(newPiece({ seed: 3 }));
  const moments = [
    { id: 'spl001', type: 'split', at: 0, count: 3, voicing: 'even' },
    { id: 'chd001', type: 'chord', at: 4, notes: { kind: 'chord', symbol: 'C' } },
  ] as unknown as Moment[];
  return { ...p, moments: [...p.moments, ...moments, ...extra] };
}

const chordAt = (at: number, symbol: string, length: number): Moment =>
  ({
    id: PROBE,
    type: 'chord',
    at,
    notes: { kind: 'chord', symbol },
    glide: { length, stagger: 0 },
  }) as unknown as Moment;

const setStatus = (status: 'idle' | 'paused' | 'playing'): void =>
  usePlayer.setState((s) => ({ transport: { ...s.transport, status } }));

beforeEach(() => {
  stopAudition();
  stopPreview();
  setHoverSound(true);
  loadPiece(piece());
  setStatus('paused');
  audio.jobs = [];
  audio.fades = [];
});

describe('what a hover plays', () => {
  it('a chord: the move into it from the notes sounding, then the chord held', () => {
    const score = compile(piece([chordAt(10, 'Dm', 1)]));
    const plan = hoverPlan(score, PROBE, 'chord', 10);
    const span = score.momentSpans.find((s) => s.id === PROBE)!;
    expect(plan).toMatchObject({ mode: 'transition', t0: span.start, t1: span.end, k: 1 });
    expect(plan.hold).toBe(HOLD_SECONDS);
    const h = hoverScore(score, plan);
    expect(h.from).toBeCloseTo(span.start, 6);
    expect(h.seconds).toBeCloseTo(span.end - span.start + HOLD_SECONDS, 6);
    // It starts on what sounds before the move and holds D minor's notes (D, A, D here).
    expect(h.notes).toHaveLength(3);
    for (const n of h.notes) expect([2, 5, 9]).toContain(((Math.round(n.pitch) % 12) + 12) % 12);
    for (const n of h.notes) {
      const v = h.score.voices[n.voice];
      expect(pitchAt(v, h.from)).toBeCloseTo(pitchAt(score.voices[n.voice], span.start)!, 6);
      expect(pitchAt(v, h.score.duration - 0.01)).toBeCloseTo(n.pitch, 6);
    }
    // Nothing after the chord is heard (the C at 4 s is before it; nothing follows).
    expect(h.score.duration).toBeCloseTo(span.end + HOLD_SECONDS, 6);
  });

  it('a long glide is compressed to 2 s and keeps its shape', () => {
    const score = compile(piece([chordAt(10, 'Dm', 5)]));
    const plan = hoverPlan(score, PROBE, 'chord', 10);
    const d = plan.t1 - plan.t0;
    expect(d).toBeGreaterThan(2);
    expect(plan.k).toBeCloseTo(2 / d, 9);
    const h = hoverScore(score, plan);
    expect(h.seconds).toBeCloseTo(2 + HOLD_SECONDS, 6);
    // At each fraction of the move, the heard pitch is the real one at the same fraction.
    for (const n of h.notes) {
      const real = score.voices[n.voice];
      const heard = h.score.voices[n.voice];
      for (const u of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
        const t = plan.t0 + u * d;
        expect(pitchAt(heard, plan.k * t)).toBeCloseTo(pitchAt(real, t)!, 6);
      }
    }
  });

  it('a segment cut at the window end keeps its whole curve', () => {
    // Window ends inside a glide of another moment: the cut part follows the real curve.
    const score = compile(piece([chordAt(4.8, 'Dm', 0.2)]));
    const v = score.voices.find((x) => x.segments.some((s) => s.t0 < 4.5 && s.t1 > 4.5))!;
    const s = v.segments.find((x) => x.t0 < 4.5 && x.t1 > 4.5)!;
    const h = hoverScore(score, { mode: 'transition', t0: s.t0, t1: 4.5, k: 0.5, hold: 1 });
    const heard = h.score.voices[v.index].segments.find((x) => x.t0 === s.t0 * 0.5)!;
    for (const t of [s.t0, (s.t0 + 4.5) / 2, 4.5])
      expect(evalSegment(heard, 0.5 * t)).toBeCloseTo(evalSegment(s, t), 6);
  });

  it('a shift or fold plays its move into the landing chord, named on its card', () => {
    const fold = {
      id: PROBE,
      type: 'spread',
      at: 10,
      factor: -1,
      around: 'mean',
      snap: 'scale',
    } as unknown as Moment;
    const score = compile(piece([fold]));
    const plan = hoverPlan(score, PROBE, 'spread', 10);
    expect(plan.mode).toBe('transition');
    const h = hoverScore(score, plan);
    expect(h.notes.length).toBe(3);
    const label = resultLabel(fold, 'Upside down', score);
    expect(label).toMatch(/^→ \S/);
    const shift = { id: PROBE, type: 'shift', at: 10, by: 2, unit: 'semitones' } as Moment;
    // C's E, E, C up a whole step: no template, so its notes from the bass.
    expect(cardResult(piece(), shift, 'Up', appendMoment, PROBE)).toBe('→ F♯ D');
  });

  it('a level or timbre plays the sounding notes as they sound after it, for 2 s', () => {
    const level = { id: PROBE, type: 'level', at: 10, gain: 0.5, over: 1 } as unknown as Moment;
    const score = compile(piece([level]));
    const plan = hoverPlan(score, PROBE, 'level', 10);
    expect(plan.mode).toBe('after');
    expect(plan.t0).toBeCloseTo(11, 6);
    expect(plan.hold).toBe(AFTER_SECONDS);
    const h = hoverScore(score, plan);
    expect(h.seconds).toBeCloseTo(AFTER_SECONDS, 6);
    expect(h.notes.length).toBe(3);
    const v = h.score.voices[h.notes[0].voice];
    // The level the notes sound at once it is done.
    expect(v.level.at(-1)!.gain).toBe(0.5);

    const timbre = { id: PROBE, type: 'timbre', at: 10, preset: 'bell', fade: 1 } as Moment;
    const ts = compile(piece([timbre]));
    const tp = hoverPlan(ts, PROBE, 'timbre', 10);
    expect(tp.mode).toBe('after');
    const th = hoverScore(ts, tp);
    expect(th.score.voices[th.notes[0].voice].timbre.at(-1)!.preset).toBe('bell');
  });

  it('a texture plays as it would, from its start, for 2 s', () => {
    const pulse = {
      id: PROBE,
      type: 'pulse',
      at: 10,
      until: 14,
      step: 0.25,
      pattern: [1, 0.5],
      decay: 0.2,
      floor: 0,
      mode: 'together',
    } as unknown as Moment;
    const score = compile(piece([pulse]));
    const plan = hoverPlan(score, PROBE, 'pulse', 10);
    expect(plan).toMatchObject({ mode: 'played', t0: 10, t1: 12, k: 1, hold: 0 });
    const h = hoverScore(score, plan);
    expect(h.from).toBe(10);
    expect(h.seconds).toBeCloseTo(2, 6);
    const hits = h.score.voices[h.notes[0].voice].pulse!.filter((r) => r.hit && r.t >= 10);
    expect(hits.length).toBeGreaterThanOrEqual(7);
    expect(hits.every((r) => r.t <= 12 + 1e-6)).toBe(true);
  });
});

describe('result labels', () => {
  it('names what a card lands on, or nothing when it would repeat the title', () => {
    const at = 10;
    expect(resultLabel({ id: PROBE, type: 'level', at, gain: 0.5, over: 2 }, 'Level')).toBe(
      '→ 50%',
    );
    expect(resultLabel({ id: PROBE, type: 'level', at, gain: 0, over: 2 }, 'Fade out')).toBe(
      '→ silence',
    );
    expect(
      resultLabel({ id: PROBE, type: 'key', at, key: { tonic: 'G', scale: 'major' } }, 'Key'),
    ).toBe('→ G major');
    expect(resultLabel({ id: PROBE, type: 'timbre', at, preset: 'bell', fade: 1 }, 'Sound')).toBe(
      '→ bell',
    );
    const arp = {
      id: PROBE,
      type: 'pulse',
      at,
      until: 12,
      step: 0.25,
      pattern: [1],
      decay: 0.2,
      floor: 0,
      mode: 'up',
    } as unknown as Moment;
    expect(resultLabel(arp, 'Texture')).toBe('→ Arpeggio');
    expect(resultLabel(arp, 'Arpeggio')).toBe('');
    expect(cardResult(piece(), chordAt(at, 'Dm', 1), 'Chord', appendMoment, PROBE)).toBe('→ Dm');
  });
});

describe('playing and stopping', () => {
  it('plays the preview showing from its window start; leaving fades over 50 ms', () => {
    expect(startMomentPreview(chordAt(10, 'Dm', 1), null, appendMoment)).toBe(true);
    expect(soundPreview()).toBe(true);
    expect(audio.jobs).toHaveLength(1);
    expect(auditionState).toMatchObject({ active: true, kind: 'hover' });
    expect(audio.jobs[0].from).toBeCloseTo(hoverSoundState.plan!.t0, 6);
    stopHoverSound();
    expect(auditionState.active).toBe(false);
    expect(audio.fades).toEqual([0.05]);
  });

  it('only while stopped, and not with Hover sound off (remembered)', () => {
    const score = compile(piece([chordAt(10, 'Dm', 1)]));
    setStatus('playing');
    const suppressed = auditionState.suppressed;
    expect(playHover(score, PROBE, 'chord', 10)).toBe(false);
    expect(auditionState.suppressed).toBe(suppressed + 1);
    setStatus('paused');
    setHoverSound(false);
    expect(localStorage.getItem('algorhythms.hoverSound')).toBe('0');
    expect(useHoverSound.getState().on).toBe(false);
    expect(playHover(score, PROBE, 'chord', 10)).toBe(false);
    expect(audio.jobs).toHaveLength(0);
    setHoverSound(true);
    expect(localStorage.getItem('algorhythms.hoverSound')).toBeNull();
    expect(playHover(score, PROBE, 'chord', 10)).toBe(true);
  });

  it('a stop that is not a hover sound leaves other auditions alone', () => {
    const score = compile(piece([chordAt(10, 'Dm', 1)]));
    playHover(score, PROBE, 'chord', 10);
    stopAudition();
    stopHoverSound();
    expect(audio.fades).toEqual([undefined]);
  });
});
