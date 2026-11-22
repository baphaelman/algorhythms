/**
 * PLAN §6.2 `pulse`, revision 10, editor side: the typed order, the mode chooser, share links
 * (`#p=2.`, defaults stripped) and undo.
 */
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  g.document = { title: '', querySelector: () => null };
  g.location = { hash: '', pathname: '/', search: '' };
  g.history = { replaceState: () => undefined };
  g.requestAnimationFrame = (cb: (t: number) => void) => cb(0);
});
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
  };
});

import { updateMoment } from '../../../src/app/editor/actions';
import { undo } from '../../../src/app/editor/history';
import { patternSvg, PULSE_MODES, formatOrder, parseOrder } from '../../../src/app/editor/pulse';
import { decodeShareLink, encodeShareLink, packPiece } from '../../../src/app/share';
import { loadPiece, usePlayer } from '../../../src/app/store';
import { newPiece } from '../../../src/core/defaults';
import { parsePiece, serializePiece, stripDefaults } from '../../../src/core/schema';
import type { Piece, PulseMoment } from '../../../src/core/types';

function withPulse(fields: Partial<PulseMoment> = {}): Piece {
  const p = newPiece({ seed: 3, poolSize: 4 });
  p.moments = [
    {
      id: 'p1',
      type: 'pulse',
      at: 1,
      until: 5,
      step: 0.5,
      pattern: [1, 0.5],
      decay: 0.3,
      floor: 0,
      mode: 'order',
      order: [1, 3, 2, 4],
      ...fields,
    },
  ];
  const r = parsePiece(JSON.parse(serializePiece(p)));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}

describe('the typed order', () => {
  it('parses spaces or commas into whole numbers ≥ 1', () => {
    expect(parseOrder('1 3 2 4')).toEqual({ ok: true, order: [1, 3, 2, 4] });
    expect(parseOrder(' 2,1 ,  5 ')).toEqual({ ok: true, order: [2, 1, 5] });
  });

  it('rejects empty, zero, fractions, words and too many steps', () => {
    for (const t of ['', '  ', '0', '1 0 2', '1.5', '-1', '1 a', 'x', '33'])
      expect(parseOrder(t).ok, t).toBe(false);
    expect(parseOrder(Array(33).fill('1').join(' ')).ok).toBe(false);
    expect(parseOrder(Array(32).fill('1').join(' ')).ok).toBe(true);
  });

  it('formats as typed, 1 2 3 4 when unset', () => {
    expect(formatOrder([1, 3, 2, 4])).toBe('1 3 2 4');
    expect(formatOrder(undefined)).toBe('1 2 3 4');
    const r = parseOrder(formatOrder([4, 1, 7]));
    expect(r.ok && r.order).toEqual([4, 1, 7]);
  });

  it('the mode chooser offers Custom order; the lane drawing ignores the mode', () => {
    expect(PULSE_MODES.find(([m]) => m === 'order')?.[1]).toBe('Custom order');
    expect(patternSvg([1, 0.5])).toContain('<rect');
  });
});

describe('order in files and share links', () => {
  it('round-trips through a `#p=2.` link with defaults stripped', async () => {
    const piece = withPulse();
    expect((stripDefaults(piece).moments as PulseMoment[])[0].order).toEqual([1, 3, 2, 4]);
    expect((packPiece(piece)!.moments as PulseMoment[])[0]).toMatchObject({
      mode: 'order',
      order: [1, 3, 2, 4],
    });
    const link = await encodeShareLink(piece, 'https://example.org/');
    expect(link).toContain('#p=2.');
    const r = parsePiece(await decodeShareLink(link));
    expect(r.ok && r.piece).toEqual(piece);
  });
});

describe('undo', () => {
  it('order edits and the mode switch are one entry each', () => {
    loadPiece(withPulse({ mode: 'together', order: undefined }));
    const pulse = (): PulseMoment => usePlayer.getState().piece.moments[0] as PulseMoment;
    expect(updateMoment('p1', { mode: 'order', order: [1, 2, 3, 4] }, 'Change pulse mode')).toBe(
      true,
    );
    expect(updateMoment('p1', { order: [1, 3, 2, 4] }, 'Edit pulse order')).toBe(true);
    expect(pulse().order).toEqual([1, 3, 2, 4]);
    // Leaving the mode drops the order.
    updateMoment('p1', { mode: 'up', order: undefined }, 'Change pulse mode');
    expect('order' in pulse()).toBe(false);
    undo();
    expect(pulse()).toMatchObject({ mode: 'order', order: [1, 3, 2, 4] });
    undo();
    expect(pulse().order).toEqual([1, 2, 3, 4]);
    undo();
    expect(pulse().mode).toBe('together');
    expect('order' in pulse()).toBe(false);
  });
});
