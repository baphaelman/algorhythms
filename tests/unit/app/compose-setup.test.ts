import { describe, expect, it } from 'vitest';
import {
  COMPOSE_PREFS_KEY,
  DEFAULT_ANSWERS,
  buildBrief,
  loadAnswers,
  loadWatch,
  melodyOf,
  parseAnswers,
  saveAnswers,
  saveWatch,
  shownAnswers,
  type ComposeAnswers,
} from '../../../src/app/compose-setup';
import { PROGRESSIONS } from '../../../src/core/compose-brief';
import { newPiece } from '../../../src/core/defaults';
import type { Moment, Piece } from '../../../src/core/types';

const melody = [
  { at: 0, pitch: 60, dur: 1 },
  { at: 1, pitch: 62, dur: 0.5 },
];

describe('buildBrief (M12 D2)', () => {
  it('all Surprise me gives only the seed', () => {
    expect(buildBrief(DEFAULT_ANSWERS, 42)).toEqual({ seed: 42 });
    expect(buildBrief(DEFAULT_ANSWERS, -1).seed).toBe(0xffffffff);
  });

  it('every answer lands in its field', () => {
    const a: ComposeAnswers = {
      mood: 'dark',
      length: 180,
      shape: 'journey',
      parts: ['bells', 'chords'],
      start: { progression: PROGRESSIONS[0].name },
      tonic: 2,
      scale: 'dorian',
      tempo: 96,
    };
    expect(buildBrief(a, 7)).toEqual({
      seed: 7,
      mood: 'dark',
      length: 180,
      shape: 'journey',
      parts: ['chords', 'bells'],
      start: { kind: 'progression', name: PROGRESSIONS[0].name },
      key: { tonic: 2, mode: 'dorian' },
      tempo: 96,
    });
  });

  it('the scale counts only with a key; Nothing and the melody start', () => {
    expect(buildBrief({ ...DEFAULT_ANSWERS, scale: 'lydian' }, 1)).toEqual({ seed: 1 });
    expect(buildBrief({ ...DEFAULT_ANSWERS, start: 'none' }, 1).start).toEqual({ kind: 'none' });
    expect(buildBrief({ ...DEFAULT_ANSWERS, start: 'melody' }, 1, melody).start).toEqual({
      kind: 'melody',
      notes: melody,
    });
    // No melody to start from: Surprise.
    expect(buildBrief({ ...DEFAULT_ANSWERS, start: 'melody' }, 1, null).start).toBe(undefined);
    expect(shownAnswers({ ...DEFAULT_ANSWERS, start: 'melody' }, false).start).toBe('surprise');
  });
});

describe('melodyOf', () => {
  const tune = (id: string, at: number, extra: Partial<Moment> = {}): Moment =>
    ({
      id,
      at,
      type: 'tune',
      target: { part: 'Melody' },
      notes: [
        { pitch: 64, len: 0.5 },
        { rest: true, len: 0.5 },
        { pitch: 67, len: 1 },
      ],
      ...extra,
    }) as Moment;
  const with_ = (moments: Moment[]): Piece => ({ ...newPiece({ seed: 1 }), moments });

  it('none without a tune', () => {
    expect(melodyOf(newPiece({ seed: 1 }))).toBe(null);
  });

  it("the first tune's line at absolute times, rests skipped, muted and other lines left out", () => {
    const p = with_([
      tune('b', 4),
      tune('a', 1),
      tune('m', 2, { muted: true }),
      tune('o', 3, { target: { part: 'Bass' } }),
    ]);
    expect(melodyOf(p)).toEqual([
      { at: 1, pitch: 64, dur: 0.5 },
      { at: 2, pitch: 67, dur: 1 },
      { at: 4, pitch: 64, dur: 0.5 },
      { at: 5, pitch: 67, dur: 1 },
    ]);
  });
});

describe('remembered answers', () => {
  const store = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
  };

  it('round-trips, and defaults when empty or broken', () => {
    const st = store();
    expect(loadAnswers(st)).toEqual(DEFAULT_ANSWERS);
    const a: ComposeAnswers = { ...DEFAULT_ANSWERS, mood: 'calm', parts: ['bass'], tempo: 120 };
    expect(saveAnswers(a, st)).toBe(true);
    expect(loadAnswers(st)).toEqual(a);
    st.setItem(COMPOSE_PREFS_KEY, '{nope');
    expect(loadAnswers(st)).toEqual(DEFAULT_ANSWERS);
    expect(loadAnswers(null)).toEqual(DEFAULT_ANSWERS);
  });

  it('keeps only valid fields', () => {
    expect(
      parseAnswers({
        mood: 'angry',
        length: 90,
        shape: 'arc',
        parts: ['bass', 'kazoo'],
        start: { progression: 'unknown' },
        tonic: 12,
        scale: 'nope',
        tempo: 999,
      }),
    ).toEqual({ ...DEFAULT_ANSWERS, shape: 'arc', parts: ['bass'] });
    expect(parseAnswers({ parts: [] }).parts).toBe('surprise');
  });

  it('Watch the composer: ticked by default, remembered, ticked when storage fails', () => {
    const st = store();
    expect(loadWatch(st)).toBe(true);
    expect(saveWatch(false, st)).toBe(true);
    expect(loadWatch(st)).toBe(false);
    expect(saveWatch(true, st)).toBe(true);
    expect(loadWatch(st)).toBe(true);
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadWatch(broken)).toBe(true);
    expect(saveWatch(false, broken)).toBe(false);
    expect(loadWatch(null)).toBe(true);
  });
});
