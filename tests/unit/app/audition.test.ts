import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import type { CompiledScore, Moment, Piece } from '../../../src/core/types';
import {
  AUDITION_SECONDS,
  audition,
  auditionAfterEdit,
  auditionMoment,
  auditionScore,
  auditionState,
  holdNote,
  momentNotes,
  stopAudition,
} from '../../../src/app/audition';
import { liveNotes } from '../../../src/app/ui/inspector/fields';
import { loadPiece, setPiece, usePlayer } from '../../../src/app/store';

/** Three voices: a split at 0, a level ramp at 1 s, and a C major chord at 2 s. */
function piece(): Piece {
  const p = newPiece({ seed: 3 });
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
  return { ...p, moments };
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
