import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import type { Key } from '../../../src/core/types';
import { defaultMoment } from '../../../src/app/editor/new-moment';
import { PALETTE } from '../../../src/app/editor/shortcuts';
import { fitOf } from '../../../src/app/editor/chord-fit';
import { piece } from '../core/compiler-fixtures';
import { progression } from '../core/progression-fixture';

const C: Key = { tonic: 'C', scale: 'major' };

describe('theory-aware Add → Chord (§11.3 rev 14)', () => {
  it('uses the chord that best fits the spot', () => {
    const p = progression(C, ['I', 'V']);
    p.moments = p.moments.map((m) => (m.at === 4 ? { ...m, at: 8 } : m));
    const m = defaultMoment('chord', 4, 'new001', p, compile(p));
    expect(m).toMatchObject({
      id: 'new001',
      at: 4,
      type: 'chord',
      notes: { kind: 'chord', symbol: 'IV' },
      voicing: 'even',
    });
  });

  it('keeps the old default in a key without chord theory', () => {
    const p = piece({ start: [], moments: [], key: { tonic: 'B', scale: 'locrian' } });
    const m = defaultMoment('chord', 2, 'new001', p, compile(p));
    expect(m.notes).toEqual({ kind: 'degrees', degrees: [0, 2, 4] });
  });
});

describe('chord picker fit marks', () => {
  it('marks rank 0 best and ranks 1–2 good', () => {
    expect([0, 1, 2, 3, undefined].map(fitOf)).toEqual([
      'best',
      'good',
      'good',
      undefined,
      undefined,
    ]);
  });
});

describe('palette', () => {
  it('has no note or pin', () => {
    expect(PALETTE.map((e) => e.type)).not.toEqual(expect.arrayContaining(['note']));
    expect(PALETTE.map((e) => e.type)).not.toEqual(expect.arrayContaining(['pin']));
  });
});
