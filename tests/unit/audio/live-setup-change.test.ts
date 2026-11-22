/**
 * Edits while live (docs/build-log.md "M7 leftovers"): `liveSetupChange` says what to re-send for
 * the same live voices (timbre, gain, pan, mute, solo, sends), or null when live mode must
 * re-enter (other voices, ranges, parts or tuning).
 */

import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { newPiece } from '../../../src/core/defaults';
import type { ChordMoment, Piece } from '../../../src/core/types';
import { liveGains, liveSetupChange, liveSetupFrom } from '../../../src/audio/live-setup';

/** Four glass voices sounding a chord from 0. */
function piece(): Piece {
  const p = newPiece({ poolSize: 4, timbre: 'glass', seed: 1 });
  const m: ChordMoment = {
    id: 'c0',
    type: 'chord',
    at: 0,
    target: 'all',
    notes: { kind: 'pitches', pitches: [60, 64, 67, 72] },
    voicing: 'even',
    assign: 'ordered',
  };
  return { ...p, moments: [m] };
}

const setupOf = (p: Piece) => liveSetupFrom(p, compile(p), 1);

function withVoice(p: Piece, i: number, patch: Partial<Piece['voices'][number]>): Piece {
  return { ...p, voices: p.voices.map((v, k) => (k === i ? { ...v, ...patch } : v)) };
}

describe('liveSetupChange', () => {
  it('nothing changed: nothing to send', () => {
    const p = piece();
    const a = setupOf(p);
    expect(liveSetupChange(a, setupOf(p))).toEqual({
      timbres: [],
      params: [],
      gains: liveGains(a, a.mix),
    });
  });

  it('timbre, gain, mute, solo, pan and sends of one voice', () => {
    const p = piece();
    const a = setupOf(p);
    const q = withVoice(p, 2, {
      timbre: 'pluck',
      gain: 0.5,
      mute: true,
      solo: true,
      pan: 0.25,
      sends: { reverb: 0.1 },
    });
    const c = liveSetupChange(a, setupOf(q));
    expect(c).not.toBeNull();
    expect(c!.timbres).toEqual([{ voice: 2, timbre: 'pluck' }]);
    const paths = c!.params.map((x) => x.path).sort();
    expect(paths).toEqual(
      [
        'voices.2.gain',
        'voices.2.mute',
        'voices.2.pan',
        'voices.2.sends.reverb',
        'voices.2.solo',
      ].sort(),
    );
    expect(c!.params.find((x) => x.path === 'voices.2.mute')!.value).toBe(true);
    expect(c!.gains[2]).toBeCloseTo(c!.gains[0] * 0.5, 9);
  });

  it('every voice to one timbre (All notes)', () => {
    const p = piece();
    const q = { ...p, voices: p.voices.map((v) => ({ ...v, timbre: 'epiano' })) };
    const c = liveSetupChange(setupOf(p), setupOf(q));
    expect(c!.timbres.map((t) => t.voice)).toEqual([0, 1, 2, 3]);
    expect(c!.params).toEqual([]);
  });

  it('other voices, a range, a part or the tuning: re-enter (null)', () => {
    const p = piece();
    const a = setupOf(p);
    const bigger = newPiece({ poolSize: 6, timbre: 'glass', seed: 1 });
    expect(liveSetupChange(a, setupOf({ ...bigger, moments: p.moments }))).toBeNull();
    expect(liveSetupChange(a, setupOf(withVoice(p, 1, { range: [40, 70] })))).toBeNull();
    expect(liveSetupChange(a, setupOf(withVoice(p, 1, { part: 'B' })))).toBeNull();
    const b = setupOf(p);
    expect(liveSetupChange(a, { ...b, referenceHz: 432 })).toBeNull();
  });

  it('a written take appending the voices live mode added is the same pool', () => {
    const p = piece();
    const a = { ...setupOf(p), pool: ['v1', 'v2'], added: [{ ...p.voices[2], id: 'v3' }] };
    expect(liveSetupChange(a, { ...setupOf(p), pool: ['v1', 'v2', 'v3'] })).not.toBeNull();
    expect(liveSetupChange(a, { ...setupOf(p), pool: ['v1', 'v2', 'v9'] })).toBeNull();
  });
});
