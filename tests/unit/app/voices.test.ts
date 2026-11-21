import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import { parsePiece } from '../../../src/core/schema';
import type { Moment, Piece } from '../../../src/core/types';
import {
  clearSolo,
  freeVoiceId,
  heardVoices,
  normalizeRange,
  patchVoice,
  poolShrinkEffects,
  resizePool,
  timbreOptions,
  toggleMute,
  toggleSolo,
} from '../../../src/app/editor/voices';

const base = (): Piece => newPiece({ seed: 1, poolSize: 6 });

function withMoments(p: Piece, moments: Moment[]): Piece {
  return { ...p, moments };
}

const valid = (p: Piece): void => {
  const r = parsePiece(JSON.parse(JSON.stringify(p)));
  expect(r.ok, r.ok ? '' : r.errors.join('; ')).toBe(true);
  const errs = compile(p).diagnostics.filter((d) => d.code === 'unknown-voice');
  expect(errs).toEqual([]);
};

describe('resizePool', () => {
  it('grows with unique ids, copying the last timbre and range', () => {
    let p = base();
    p = patchVoice(p, 'v6', { timbre: 'organ', range: [40, 70] });
    p = { ...p, voices: p.voices.map((v) => (v.id === 'v2' ? { ...v, id: 'v8' } : v)) };
    const q = resizePool(p, 9);
    expect(q.voices.map((v) => v.id)).toEqual([
      'v1',
      'v8',
      'v3',
      'v4',
      'v5',
      'v6',
      'v7',
      'v9',
      'v10',
    ]);
    expect(q.voices[8]).toMatchObject({ timbre: 'organ', range: [40, 70], pan: 'auto', gain: 1 });
    expect(q.timbres.organ).toBeDefined();
    valid(q);
  });

  it('clamps to 1..32 and returns the same piece when unchanged', () => {
    const p = base();
    expect(resizePool(p, 6)).toBe(p);
    expect(resizePool(p, 99).voices).toHaveLength(32);
    expect(resizePool(p, 0).voices).toHaveLength(1);
  });

  it('shrinks keeping the piece valid', () => {
    let p = base();
    p = withMoments(p, [
      {
        id: 'start0',
        type: 'chord',
        at: 0,
        notes: { kind: 'pitches', pitches: [57, 60] },
        voicing: 'even',
        assign: 'ordered',
        target: { voices: ['v1', 'v5'] },
        byVoice: true,
      },
      { id: 'pin5', type: 'pin', at: 1, voice: 'v5', pitch: 62 },
      { id: 'pin1', type: 'pin', at: 1, voice: 'v1', pitch: 62 },
      {
        id: 'tgtA',
        type: 'shift',
        at: 2,
        by: 1,
        unit: 'semitones',
        target: { voices: ['v1', 'v6'] },
      },
      {
        id: 'tgtB',
        type: 'shift',
        at: 3,
        by: 1,
        unit: 'semitones',
        target: { voices: ['v5', 'v6'] },
      },
      { id: 'splt', type: 'split', at: 4, count: 6, voicing: 'even' },
      { id: 'mrge', type: 'merge', at: 5, count: 5, which: 'top', fade: 2 },
      { id: 'allv', type: 'shift', at: 6, by: 1, unit: 'semitones', target: 'all' },
    ]);
    expect(poolShrinkEffects(p, 4)).toEqual({ voices: ['v5', 'v6'], moments: 2 });
    const q = resizePool(p, 4);
    expect(q.voices.map((v) => v.id)).toEqual(['v1', 'v2', 'v3', 'v4']);
    expect(q.moments.map((m) => m.id)).toEqual(['start0', 'pin1', 'tgtA', 'splt', 'mrge', 'allv']);
    // The opening keeps v1's own note (a by-voice chord drops the removed voices' pitches).
    expect(q.moments[0]).toMatchObject({
      target: { voices: ['v1'] },
      notes: { kind: 'pitches', pitches: [57] },
    });
    expect(q.moments[2].target).toEqual({ voices: ['v1'] });
    expect((q.moments[3] as { count: number }).count).toBe(4);
    expect((q.moments[4] as { count: number }).count).toBe(4);
    expect(q.moments[5]).toBe(p.moments[7]);
    valid(q);
  });

  it('clamps a chord count to the new pool', () => {
    const p = base();
    const q = resizePool(
      {
        ...p,
        moments: [
          {
            id: 'chd1',
            type: 'chord',
            at: 1,
            notes: { kind: 'chord', symbol: 'C' },
            voicing: 'even',
            assign: 'ordered',
            count: p.voices.length,
          },
        ],
      },
      3,
    );
    expect((q.moments[0] as { count: number }).count).toBe(3);
    valid(q);
  });

  it('reports nothing when growing', () => {
    expect(poolShrinkEffects(base(), 10)).toEqual({ voices: [], moments: 0 });
  });
});

describe('voice patches', () => {
  it('patches, removes undefined fields, and is a no-op when equal', () => {
    const p = base();
    expect(patchVoice(p, 'v1', { gain: 1 })).toBe(p);
    expect(patchVoice(p, 'nope', { gain: 0.5 })).toBe(p);
    const q = patchVoice(p, 'v1', { gain: 0.5, color: '#ff0000' });
    expect(q.voices[0]).toMatchObject({ gain: 0.5, color: '#ff0000' });
    expect(p.voices[0].gain).toBe(1);
    const r = patchVoice(q, 'v1', { color: undefined });
    expect('color' in r.voices[0]).toBe(false);
    expect(patchVoice(p, 'v1', { range: [38, 84] })).toBe(p);
  });

  it('copies a built-in timbre into the piece when selected', () => {
    const p = base();
    expect(p.timbres.reed).toBeUndefined();
    const q = patchVoice(p, 'v2', { timbre: 'reed' });
    expect(q.voices[1].timbre).toBe('reed');
    expect(q.timbres.reed).toBeDefined();
    expect(timbreOptions(q)).toContain('wobble');
    expect(timbreOptions(q, 'mystery')).toContain('mystery');
  });

  it('normalizes ranges', () => {
    expect(normalizeRange(70, 40)).toEqual([40, 70]);
    expect(normalizeRange(-5, 200)).toEqual([0, 127]);
    expect(normalizeRange(40.4, 60.6)).toEqual([40, 61]);
  });
});

describe('mute and solo', () => {
  it('decides who is heard like the DSP', () => {
    let p = base();
    expect(heardVoices(p.voices).every(Boolean)).toBe(true);
    p = toggleMute(p, 'v2');
    expect(heardVoices(p.voices)).toEqual([true, false, true, true, true, true]);
    p = toggleSolo(p, 'v3');
    p = toggleSolo(p, 'v2');
    // Muted wins over solo.
    expect(heardVoices(p.voices)).toEqual([false, false, true, false, false, false]);
    p = toggleMute(p, 'v2');
    expect('mute' in p.voices[1]).toBe(false);
    expect(heardVoices(p.voices)).toEqual([false, true, true, false, false, false]);
    p = clearSolo(p);
    expect(p.voices.some((v) => 'solo' in v)).toBe(false);
  });

  it('exclusive solo leaves one soloed voice, and toggles off when already alone', () => {
    let p = toggleSolo(toggleSolo(base(), 'v1'), 'v2');
    p = toggleSolo(p, 'v4', true);
    expect(p.voices.filter((v) => v.solo).map((v) => v.id)).toEqual(['v4']);
    p = toggleSolo(p, 'v4', true);
    expect(p.voices.some((v) => v.solo)).toBe(false);
  });
});

describe('voice ids', () => {
  it('finds free ids', () => {
    const p = base();
    expect(freeVoiceId(p.voices, 3)).toBe('v7');
    expect(freeVoiceId([], 1)).toBe('v1');
  });
});
