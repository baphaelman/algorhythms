/**
 * The directed composer, round 2 of the owner's listening notes (PLAN §15 M12 "Listening notes,
 * round 2", Acceptance): mood is the sounds and the pace, not only the mode; arpeggios are one
 * texture among several; no Wobble.
 *
 * Measured on the pieces' moments, 50 seeds per mood (every other answer Surprise):
 * - a figure: a pulse's step, a walk's grid, a tune's notes (the last note of a tune, which
 *   takes the section's remainder, and a given melody excepted);
 * - an arpeggio: a pulse whose lines sound one at a time (not 'together'), a beat or quicker, with
 *   at least 60 % of the steps in its cycle (a bar when it restarts) sounding. A broken chord rests
 *   every other step; its share of the piece is the union of such pulses' spans over the length.
 */
import { describe, expect, it } from 'vitest';
import {
  MOODS,
  MOOD_REGIONS,
  modeFamily,
  resolveBrief,
  type ComposePart,
  type Mood,
} from '../../../src/core/compose-brief';
import { PART_NAME, composeDirectedPiece } from '../../../src/core/compose-directed';
import type { Piece, PulseMoment } from '../../../src/core/types';
import { arpShare, quickest } from './compose-metrics';

const N = 50;
const SLOW: readonly Mood[] = ['dark', 'calm', 'dreamy'];
const BOUNCY = new Set(['pluck', 'marimba', 'epiano']);

const pieces = new Map<string, Piece>();
function piece(seed: number, mood?: Mood): Piece {
  const k = `${mood ?? 'surprise'} ${seed}`;
  let p = pieces.get(k);
  if (!p) pieces.set(k, (p = composeDirectedPiece(mood ? { seed, mood } : { seed })));
  return p;
}

const beatOf = (p: Piece) => 60 / p.view.gridBpm!;

/** The voice ids of a moment's target. */
function idsOf(p: Piece, t: PulseMoment['target']): string[] {
  return p.voices
    .filter((v) => {
      if (!t || t === 'all') return true;
      if ('part' in t) return v.part === t.part;
      if ('parts' in t) return t.parts.includes(v.part ?? '');
      if ('voices' in t) return t.voices.includes(v.id);
      return true;
    })
    .map((v) => v.id);
}

/** The timbres of the parts' voices. */
function soundsOf(p: Piece, part: ComposePart): string[] {
  return p.voices.filter((v) => v.part === PART_NAME[part]).map((v) => v.timbre);
}

describe(
  'mood is the sounds and the pace (PLAN M12 listening notes, round 2)',
  { timeout: 120_000 },
  () => {
    it('Dark, Calm and Dreamy: no bouncy chords or pulse, nothing faster than eighths', () => {
      for (const mood of SLOW) {
        for (let seed = 1; seed <= N; seed++) {
          const p = piece(seed, mood);
          const what = `${p.meta.title}`;
          for (const part of ['chords', 'pulse'] as const)
            for (const t of soundsOf(p, part))
              expect(BOUNCY.has(t), `${what} ${part} ${t}`).toBe(false);
          expect(quickest(p), what).toBeGreaterThanOrEqual(beatOf(p) / 2 - 1e-3);
        }
      }
    });

    it('Dark tempos stay at or below 80 bpm, and its register sits lower', () => {
      for (let seed = 1; seed <= N; seed++)
        expect(piece(seed, 'dark').view.gridBpm!, `${seed}`).toBeLessThanOrEqual(80);
      expect(MOOD_REGIONS.dark.centre[1]).toBeLessThanOrEqual(
        Math.min(...MOODS.filter((m) => m !== 'dark').map((m) => MOOD_REGIONS[m].centre[0])),
      );
    });

    it('a Surprise piece is coherent: its title mood matches its sounds, pace and mode', () => {
      let slow = 0;
      for (let seed = 1; seed <= 2 * N; seed++) {
        const r = resolveBrief({ seed });
        const p = piece(seed);
        const what = p.meta.title;
        // Blends mix neighbouring moods only: never Dark with Bright or Driving.
        expect(r.mood.dark > 0 && r.mood.bright + r.mood.driving > 0, what).toBe(false);
        if (r.moodName === 'dark') expect(modeFamily(r.key.mode), what).toBe('minor');
        if (r.moodName === 'bright') expect(modeFamily(r.key.mode), what).toBe('major');
        if (!SLOW.includes(r.moodName)) continue;
        slow++;
        expect(r.unhurried, what).toBe(true);
        for (const part of ['chords', 'pulse'] as const)
          for (const t of soundsOf(p, part))
            expect(BOUNCY.has(t), `${what} ${part} ${t}`).toBe(false);
        expect(quickest(p), what).toBeGreaterThanOrEqual(beatOf(p) / 2 - 1e-3);
      }
      expect(slow).toBeGreaterThan(30);
    });
  },
);

describe('arpeggios are one texture among several', { timeout: 120_000 }, () => {
  it('fill at most a third of any piece, in every mood and Surprise', () => {
    const shares: number[] = [];
    for (const mood of [...MOODS, undefined]) {
      for (let seed = 1; seed <= N; seed++) {
        const p = piece(seed, mood);
        const s = arpShare(p);
        shares.push(s);
        expect(s, p.meta.title).toBeLessThanOrEqual(1 / 3);
      }
    }
    // Still a texture the composer uses.
    expect(shares.filter((s) => s > 0.05).length).toBeGreaterThan(50);
  });

  it('a slow glide through a chord change under one-at-a-time lines is a rare feature', () => {
    let features = 0;
    for (const mood of [...MOODS, undefined]) {
      for (let seed = 1; seed <= 20; seed++) {
        const p = piece(seed, mood);
        const chords = new Set(idsOf(p, { part: PART_NAME.chords }));
        const broken = p.moments.filter(
          (m): m is PulseMoment =>
            m.type === 'pulse' &&
            m.mode !== 'together' &&
            idsOf(p, m.target).some((id) => chords.has(id)),
        );
        let n = 0;
        for (const m of p.moments) {
          if (m.type !== 'chord' || m.at === 0 || (m.glide?.length ?? 0) < 0.3) continue;
          const t = m.target;
          if (typeof t !== 'object' || !('part' in t) || t.part !== PART_NAME.chords) continue;
          if (broken.some((b) => b.at <= m.at + 1e-3 && m.at < b.until - 1e-3)) n++;
        }
        expect(n, p.meta.title).toBeLessThanOrEqual(2);
        features += n;
      }
    }
    expect(features).toBeGreaterThan(0);
  });
});

describe('sounds', { timeout: 120_000 }, () => {
  it('no piece uses Wobble; at most one flute line', () => {
    for (const mood of [...MOODS, undefined]) {
      for (let seed = 1; seed <= N; seed++) {
        const p = piece(seed, mood);
        expect(
          p.voices.some((v) => v.timbre === 'wobble'),
          p.meta.title,
        ).toBe(false);
        expect(p.voices.filter((v) => v.timbre === 'flute').length).toBeLessThanOrEqual(1);
      }
    }
    for (const m of MOODS)
      for (const list of Object.values(MOOD_REGIONS[m].sounds))
        expect(list).not.toContain('wobble');
  });
});
