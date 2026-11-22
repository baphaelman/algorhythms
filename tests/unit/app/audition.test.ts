import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The store needs a few browser globals and the audio module; stub them before importing it.
vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  g.document = { title: '', querySelector: () => null };
  g.location = { hash: '', pathname: '/', search: '' };
  g.history = { replaceState: () => undefined };
  g.requestAnimationFrame = (cb: (t: number) => void) => {
    cb(0);
    return 0;
  };
});

interface Job {
  score: CompiledScore;
  current: () => boolean;
  wanted: () => boolean;
}
const audio = vi.hoisted(() => ({ jobs: [] as Job[], ended: 0 }));
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
    auditionAudio: (
      score: CompiledScore,
      _t: unknown,
      current: () => boolean,
      wanted: () => boolean,
    ) => {
      audio.jobs.push({ score, current, wanted });
      return Promise.resolve(true);
    },
    endAuditionAudio: () => {
      audio.ended++;
    },
  };
});

import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import { withOpening } from '../opened-piece';
import type { ChordMoment, CompiledScore, Moment, Piece } from '../../../src/core/types';
import { moveChordNote, moveWalkStep, octaveDots } from '../../../src/app/editor/actions';
import { momentArrivals } from '../../../src/app/editor/arrival-points';
import { piece as fixture } from '../core/compiler-fixtures';
import {
  AUDITION_SECONDS,
  audition,
  auditionAfterEdit,
  auditionMelodyAfterEdit,
  auditionMoment,
  auditionScore,
  auditionState,
  holdNote,
  momentNotes,
  stopAudition,
} from '../../../src/app/audition';
import { tuneLineAt } from '../../../src/app/editor/tune';
import { liveNotes } from '../../../src/app/ui/inspector/fields';
import { loadPiece, setPiece, usePlayer } from '../../../src/app/store';

/** Three voices: a split at 0, a level ramp at 1 s, and a C major chord at 2 s. */
function piece(): Piece {
  const p = withOpening(newPiece({ seed: 3 }));
  const moments = [
    { id: 'spl001', type: 'split', at: 0, count: 3, voicing: 'even' },
    { id: 'lvl001', type: 'level', at: 1, gain: 0.5, over: 0 },
    {
      id: 'chd001',
      type: 'chord',
      at: 2,
      notes: { kind: 'chord', symbol: 'C' },
      glide: { length: 0.5, stagger: 0 },
    },
  ] as unknown as Moment[];
  return { ...p, moments: [...p.moments, ...moments] }; // after the opening (v1 at A3)
}

const setStatus = (status: 'idle' | 'paused' | 'playing'): void =>
  usePlayer.setState((s) => ({ transport: { ...s.transport, status } }));

beforeEach(() => {
  stopAudition();
  loadPiece(piece());
  setStatus('paused');
  audio.jobs = [];
  audio.ended = 0;
});

describe('auditioning', () => {
  it('plays while stopped and is suppressed while playing', () => {
    expect(audition([{ voice: 0, pitch: 60 }], 0)).toBe(true);
    expect(audio.jobs).toHaveLength(1);
    expect(auditionState.active).toBe(true);

    setStatus('playing');
    // Playing stops the audition that was sounding.
    expect(auditionState.active).toBe(false);
    expect(audio.ended).toBe(1);
    const suppressed = auditionState.suppressed;
    expect(audition([{ voice: 0, pitch: 62 }], 0)).toBe(false);
    expect(auditionMoment('chd001')).toBe(false);
    auditionAfterEdit('chd001');
    expect(audio.jobs).toHaveLength(1);
    expect(auditionState.suppressed).toBe(suppressed + 3);
  });

  it('a new audition replaces the last instead of stacking', () => {
    audition([{ voice: 0, pitch: 60 }], 0);
    audition([{ voice: 0, pitch: 64 }], 0);
    expect(audio.jobs).toHaveLength(2);
    const [a, b] = audio.jobs;
    // The older one is skipped by the engine queue; only the newest plays.
    expect(a.current()).toBe(false);
    expect(b.current()).toBe(true);
    expect(b.wanted()).toBe(true);
    stopAudition();
    expect(b.wanted()).toBe(false);
    expect(audio.ended).toBe(1);
  });

  it('a held note re-sounds only when its pitch changes, and stops on release', () => {
    holdNote(1, 60, 0.5);
    holdNote(1, 60, 0.5);
    holdNote(1, 62, 0.5);
    expect(audio.jobs).toHaveLength(2);
    expect(audio.jobs[1].current()).toBe(true);
    expect(auditionState.held).toBe(true);
    stopAudition();
    expect(auditionState.active).toBe(false);
  });

  it('selecting a moment plays what it moves to, once', () => {
    const { compiled } = usePlayer.getState();
    expect(auditionMoment('chd001')).toBe(true);
    const job = audio.jobs[0];
    const target = liveNotes(compiled, 'chd001');
    const heard = job.score.voices
      .filter((v) => v.segments.length > 0)
      .map((v) => {
        // Steady at the target: no transition.
        expect(v.segments).toHaveLength(1);
        expect(v.segments[0].p0).toBe(v.segments[0].p1);
        return v.segments[0].p0;
      })
      .sort((x, y) => x - y);
    expect(heard).toEqual(target);
    expect(job.score.duration).toBe(AUDITION_SECONDS);
  });

  it('an audition score keeps the voices, their timbre and level at that time', () => {
    const { compiled } = usePlayer.getState();
    const s = auditionScore(compiled, [{ voice: 2, pitch: 67 }], 3, 1.5);
    expect(s.voices.map((v) => v.id)).toEqual(compiled.voices.map((v) => v.id));
    expect(s.voices[0].lives).toEqual([]);
    const v = s.voices[2];
    expect(v.lives).toHaveLength(1);
    expect(v.level).toEqual([{ t: 0, gain: 0.5, over: 0 }]);
    expect(v.timbre[0].preset).toBe(compiled.voices[2].timbre[0].preset);
    expect(v.gain).toBe(compiled.voices[2].gain);
  });

  it('a pick plays the edited result once it has compiled; a newer pick replaces it', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // The store's recompile is synchronous here (requestAnimationFrame is stubbed).
      auditionAfterEdit('chd001');
      auditionAfterEdit('chd001');
      const p = usePlayer.getState().piece;
      setPiece({
        ...p,
        moments: p.moments.map((m) =>
          m.id === 'chd001' ? ({ ...m, notes: { kind: 'chord', symbol: 'Am' } } as Moment) : m,
        ),
      });
      expect(audio.jobs).toHaveLength(1);
      const pitches = momentNotes(compile(usePlayer.getState().piece), 'chd001').notes.map(
        (n) => n.pitch,
      );
      const heard = audio.jobs[0].score.voices.flatMap((v) => v.segments.map((s) => s.p0));
      expect(heard.sort()).toEqual(pitches.sort());
      // No second sound from the replaced pick.
      vi.advanceTimersByTime(1000);
      expect(audio.jobs).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('step edits audition the moved notes', () => {
  const heard = (job: Job): number[] =>
    job.score.voices
      .filter((v) => v.lives.length > 0)
      .map((v) => v.segments[0].p0)
      .sort((x, y) => x - y);
  const byId = (id: string) => usePlayer.getState().piece.moments.find((m) => m.id === id)!;
  const stepOf = (tick: number, voice: string) =>
    usePlayer
      .getState()
      .compiled.walkSteps.find((s) => s.momentId === 'w' && s.tick === tick && s.voice === voice)!;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    loadPiece(
      fixture({
        start: [48, 55, 60, 64],
        key: { tonic: 'C', scale: 'major' },
        glide: { length: 1, jitter: 0, stagger: 0 },
        moments: [
          {
            id: 'c',
            type: 'chord',
            at: 2,
            notes: { kind: 'chord', symbol: 'Am' },
            voicing: 'even',
            assign: 'ordered',
          },
          {
            id: 'w',
            type: 'walk',
            at: 10,
            until: 14,
            grid: 1,
            density: 1,
            steps: [-1, 1],
            stepGlide: 0.25,
          },
        ],
      }),
    );
    audio.jobs = [];
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** One-off edits audition at the end of their task (a microtask); drags on the next compile. */
  const settle = async (): Promise<void> => {
    await Promise.resolve();
    vi.advanceTimersByTime(600);
  };

  it('▲/▼ on a walk step plays its voice at the new pitch', async () => {
    const s0 = usePlayer.getState().compiled.walkSteps.find((s) => s.momentId === 'w')!;
    const ref = { momentId: 'w', tick: s0.tick, voice: s0.voice };
    expect(moveWalkStep(ref, 1)).toBe(true);
    await settle();
    const s1 = stepOf(ref.tick, ref.voice);
    expect(s1.to).not.toBe(s0.to);
    expect(audio.jobs).toHaveLength(1);
    expect(heard(audio.jobs[0])).toEqual([s1.to]);
    const voice = usePlayer.getState().piece.voices.findIndex((v) => v.id === ref.voice);
    expect(audio.jobs[0].score.voices[voice].lives).toHaveLength(1);
  });

  it('▲/▼ on a chord note plays that note; a newer step replaces the pending one', async () => {
    const before = liveNotes(usePlayer.getState().compiled, 'c');
    expect(moveChordNote('c', 0, 1)).toBe(true);
    expect(moveChordNote('c', 0, 1)).toBe(true);
    await settle();
    const after = (byId('c') as ChordMoment).notes;
    expect(after.kind).toBe('pitches');
    expect(audio.jobs).toHaveLength(1);
    const [p] = heard(audio.jobs[0]);
    expect(p).toBeGreaterThan(before[0]);
    expect(after.kind === 'pitches' && after.pitches).toContain(p);
  });

  it('Shift+▲/▼ on selected dots plays them an octave on', async () => {
    const { piece: p, compiled } = usePlayer.getState();
    const dots = momentArrivals(
      compiled,
      p.moments.find((m) => m.id === 'c')!,
    ).slice(0, 2);
    expect(dots).toHaveLength(2);
    expect(octaveDots(dots, 1)).not.toBeNull();
    await settle();
    expect(audio.jobs).toHaveLength(1);
    expect(heard(audio.jobs[0])).toEqual(dots.map((d) => d.pitch + 12).sort((x, y) => x - y));
  });

  it('plays nothing while the transport plays', async () => {
    setStatus('playing');
    const s0 = usePlayer.getState().compiled.walkSteps.find((s) => s.momentId === 'w')!;
    moveWalkStep({ momentId: 'w', tick: s0.tick, voice: s0.voice }, -1);
    moveChordNote('c', 1, -1);
    await settle();
    expect(audio.jobs).toHaveLength(0);
  });
});

describe('tune auditions', () => {
  it("a melody that keeps its line's pitch (no segment of the tune) still plays on that line", () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const tune = { id: 'tun001', type: 'tune', at: 4, notes: [{ pitch: 60, len: 1 }] };
      const p = usePlayer.getState().piece;
      const line = tuneLineAt(p, compile(p), tune as never);
      expect(line.voice).toBeDefined();
      // CI v59 flake: Random melody rolled the line's own pitch twice; nothing moved, no sound.
      const notes = [
        { pitch: line.pitch, len: 1 },
        { pitch: line.pitch, len: 1 },
      ];
      auditionMelodyAfterEdit('tun001', notes, 4);
      setPiece({ ...p, moments: [...p.moments, { ...tune, notes } as unknown as Moment] });
      const { compiled } = usePlayer.getState();
      expect(compiled.voices.some((v) => v.segments.some((x) => x.momentId === 'tun001'))).toBe(
        false,
      );
      expect(audio.jobs).toHaveLength(1);
      expect(auditionState.notes).toEqual([{ voice: line.voice, pitch: line.pitch }]);
    } finally {
      vi.useRealTimers();
    }
  });
});
