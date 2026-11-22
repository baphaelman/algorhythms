/**
 * Too few voices (audio/live-setup `fill`): live mode plays at least 4 voices. Fewer sounding at
 * the playhead (recording: before T₀) are filled from the pool, nearest by pool index, then with
 * new default voices; each added voice takes the timbre, part, mute and solo of the nearest
 * sounding voice. Normalisation stays constant (every live voice alive, silence a level of 0), and
 * a take writes the added voices into the piece (core/live-take `takeVoices`) and plays back on them.
 */

import { describe, expect, it } from 'vitest';
import { compile } from '../../src/core/compiler/compile';
import { newPiece } from '../../src/core/defaults';
import { takeBase, takeVoices } from '../../src/core/live-take';
import { lifeAt } from '../../src/core/query';
import type { ChordMoment, Piece, TimbreMoment } from '../../src/core/types';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import { LiveRig } from '../../src/audio/fixtures/live-rig';
import { DRY_MIX } from '../../src/audio/fixtures/scores';
import { LIVE_MIN_VOICES, liveSetupFrom } from '../../src/audio/live-setup';
import { compare, press, record, report, wait } from './live-take-helpers';

/** A pool of `pool` glass voices; `sound` (pool indices) play a chord from 0 on sine, part A. */
function pieceWith(pool: number, sound: number[], parts: string[] = []): Piece {
  const p = newPiece({ poolSize: pool, timbre: 'glass', seed: 1 });
  p.mix = { ...DRY_MIX, normalise: p.mix.normalise };
  sound.forEach((i, k) => {
    p.voices[i].timbre = 'sine';
    p.voices[i].part = parts[k] ?? 'A';
  });
  if (sound.length > 0) {
    const m: ChordMoment = {
      id: 'c0',
      type: 'chord',
      at: 0,
      target: { voices: sound.map((i) => p.voices[i].id) },
      notes: { kind: 'pitches', pitches: sound.map((_, k) => 60 + 4 * k) },
      voicing: 'even',
      assign: 'ordered',
    };
    p.moments = [m];
  }
  return p;
}

const setupAt = (p: Piece, t = 1) => liveSetupFrom(p, compile(p), t);

describe('live voices filled up to 4', () => {
  it('0 sounding, pool of 2: both pool voices and 2 new default voices', () => {
    const p = newPiece({ poolSize: 2, timbre: 'sine', seed: 1 });
    p.voices[1].timbre = 'glass';
    const s = setupAt(p);
    expect(LIVE_MIN_VOICES).toBe(4);
    expect(s.voices.map((v) => v.id)).toEqual(['v1', 'v2', 'v3', 'v4']);
    expect(s.voices.map((v) => v.fill)).toEqual([undefined, undefined, 'new', 'new']);
    // New voices after the pool's end: their nearest is v2.
    expect(s.voices.map((v) => v.timbre)).toEqual(['sine', 'glass', 'glass', 'glass']);
    expect(s.added?.map((d) => [d.id, d.timbre, d.range])).toEqual([
      ['v3', 'glass', [38, 84]],
      ['v4', 'glass', [38, 84]],
    ]);
    // 0 sounding with a pool of 6: the whole pool, nothing added.
    expect(setupAt(newPiece({ poolSize: 6, seed: 1 })).voices).toHaveLength(6);
  });

  it('1 sounding: the nearest pool voices by index, with its timbre and part', () => {
    const p = pieceWith(6, [2]);
    p.voices[3].solo = true; // a fill takes the source's solo (none), not its own
    p.voices[1].gain = 0.5; // but keeps its own gain
    const s = setupAt(p);
    expect(s.voices.map((v) => v.id)).toEqual(['v1', 'v2', 'v3', 'v4']);
    expect(s.voices.map((v) => v.fill)).toEqual(['pool', 'pool', undefined, 'pool']);
    for (const v of s.voices) {
      expect(v.timbre).toBe('sine');
      expect(v.part).toBe('A');
      expect(v.solo).toBe(false);
    }
    expect(s.voices[1].baseGain).toBe(0.5);
    expect(s.added).toBeUndefined();
  });

  it('3 sounding in a pool of 3: one new voice, from the nearest (the last)', () => {
    const p = pieceWith(3, [0, 1, 2], ['A', 'A', 'B']);
    p.voices[2].timbre = 'pluck';
    p.voices[2].mute = true;
    const s = setupAt(p);
    expect(s.voices.map((v) => v.id)).toEqual(['v1', 'v2', 'v3', 'v4']);
    const v4 = s.voices[3];
    expect([v4.fill, v4.timbre, v4.part, v4.mute]).toEqual(['new', 'pluck', 'B', true]);
    expect(s.added).toEqual([
      { id: 'v4', timbre: 'pluck', pan: 'auto', gain: 1, range: [38, 84], part: 'B', mute: true },
    ]);
  });

  it('5 sounding: unchanged', () => {
    const s = setupAt(pieceWith(8, [0, 1, 2, 3, 4]));
    expect(s.voices.map((v) => v.id)).toEqual(['v1', 'v2', 'v3', 'v4', 'v5']);
    expect(s.voices.every((v) => v.fill === undefined)).toBe(true);
  });

  it('normalisation stays constant: every voice at the level of 4 live lines, before and after a fade', () => {
    const play = (p: Piece, normalise: 'part' | 'all' = 'part') => {
      p.mix = { ...p.mix, normalise };
      const s = setupAt(p);
      const rig = new LiveRig(s, { release: 'fade', releaseFade: 0.2 });
      rig.record = false;
      rig.run(0.05);
      press(rig, [60, 64, 67, 71], 0.002);
      rig.run(1);
      return { s, rig, amps: s.voices.map((_, k) => rig.graph.voiceAmplitude(k)) };
    };
    // As 4 voices that all sound there (no fill): g_n of 4 live lines, alive throughout. (Under
    // 'part' the part's share also follows the piece's peak lines, which differ here.)
    const filled = play(pieceWith(6, [2]), 'all').amps;
    const four = play(pieceWith(6, [0, 1, 2, 3]), 'all').amps;
    filled.forEach((a, k) => expect(Math.abs(a / four[k] - 1)).toBeLessThan(0.02));
    const { s, rig, amps: before } = play(pieceWith(6, [2]));
    rig.allOff();
    rig.run(0.5);
    for (let k = 0; k < 4; k++) expect(rig.graph.voiceAmplitude(k)).toBe(0);
    press(rig, [60, 64, 67, 71], 0.002);
    rig.run(1);
    s.voices.forEach((_, k) =>
      expect(Math.abs(rig.graph.voiceAmplitude(k) / before[k] - 1)).toBeLessThan(0.02),
    );
  });
});

describe('a take on filled voices', () => {
  it('writes them into the piece; a timbre moment where one is set before T', () => {
    const p = pieceWith(3, [1]);
    const tm: TimbreMoment = {
      id: 't0',
      type: 'timbre',
      at: 0.5,
      target: { voices: ['v1'] },
      preset: 'pluck',
      fade: 0,
    };
    p.moments.push(tm);
    let n = 0;
    const newId = () => `x${n++}`;
    const { piece: base, silentFrom } = takeBase(p, 2, newId);
    const s = liveSetupFrom(base, compile(base), silentFrom);
    expect(s.voices.map((v) => [v.id, v.fill, v.timbre])).toEqual([
      ['v1', 'pool', 'sine'],
      ['v2', undefined, 'sine'],
      ['v3', 'pool', 'sine'],
      ['v4', 'new', 'sine'],
    ]);
    const out = takeVoices(base, s.voices, s.added ?? [], 2, newId);
    expect(out.voices.map((v) => [v.id, v.timbre, v.part])).toEqual([
      ['v1', 'sine', 'A'],
      ['v2', 'sine', 'A'],
      ['v3', 'sine', 'A'],
      ['v4', 'sine', 'A'],
    ]);
    // v1's timbre at 2 s is the pluck the earlier moment set: a timbre moment puts it back.
    expect(out.moments.filter((m) => m.type === 'timbre' && m.at === 2)).toEqual([
      { id: 'x1', type: 'timbre', at: 2, target: { voices: ['v1'] }, preset: 'sine', fade: 0 },
    ]);
    // Nothing added: unchanged.
    const full = pieceWith(6, [0, 1, 2, 3]);
    const fs = setupAt(full);
    expect(takeVoices(full, fs.voices, fs.added ?? [], 2, newId)).toBe(full);
  });

  it('plays back as played (a triad plus doubling on 1 sounding voice and on a pool of 2)', () => {
    const script = (rig: LiveRig) => {
      wait(rig, 0.1);
      press(rig, [60, 64, 67], 0.002);
      wait(rig, 0.5);
      rig.allOff();
      press(rig, [57, 60, 64, 69], 0.002);
      wait(rig, 0.6);
      rig.allOff();
      rig.noteOn(62);
      wait(rig, 0.5);
    };
    const one = pieceWith(6, [2]);
    one.end = { ...one.end, at: 1.5 };
    const pools = [
      ['1 sounding of 6', one],
      ['pool of 2', newPiece({ poolSize: 2, timbre: 'sine', seed: 1 })],
    ] as const;
    for (const [name, piece] of pools) {
      const take = record(script, {}, piece);
      expect(take.rig.input.tracks.data).toHaveLength(4);
      const score = compile(take.piece);
      const ids = ['v1', 'v2', 'v3', 'v4'];
      // The 4-note chord sounds on all four.
      for (const id of ids) {
        const cv = score.voices.find((v) => v.id === id);
        expect(cv && lifeAt(cv, take.T0 + 1.1), `${name} ${id}`).toBeTruthy();
      }
      const m = compare(take);
      report(`fill: ${name}`, m);
      expect(m.misses.slice(0, 5)).toEqual([]);
      expect(m.cents0).toBeLessThanOrEqual(1);
      expect(m.frames).toBeLessThanOrEqual(BLOCK_FRAMES);
    }
  });
});
