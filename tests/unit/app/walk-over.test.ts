/**
 * PLAN §6.2 walk `over`, revision 10, editor side: share links (`#p=2.`, defaults stripped),
 * the Key / Chord switch's patch, and undo.
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
import { decodeShareLink, encodeShareLink, packPiece } from '../../../src/app/share';
import { loadPiece, usePlayer } from '../../../src/app/store';
import { newPiece } from '../../../src/core/defaults';
import { parsePiece, serializePiece, stripDefaults } from '../../../src/core/schema';
import type { Piece, WalkMoment } from '../../../src/core/types';

function withWalk(fields: Partial<WalkMoment> = {}): Piece {
  const p = newPiece({ seed: 3, poolSize: 4 });
  p.moments = [
    ...p.moments,
    {
      id: 'w1',
      type: 'walk',
      at: 1,
      until: 9,
      grid: 0.5,
      density: 0.5,
      steps: [-2, -1, 1, 2],
      stepGlide: 0.3,
      over: 'chord',
      ...fields,
    },
  ];
  const r = parsePiece(JSON.parse(serializePiece(p)));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}

const walkOf = (p: Piece): WalkMoment => p.moments.find((m) => m.id === 'w1') as WalkMoment;

describe('over in files and share links', () => {
  it('round-trips through a `#p=2.` link with defaults stripped', async () => {
    const piece = withWalk();
    expect(walkOf(stripDefaults(piece) as unknown as Piece).over).toBe('chord');
    expect(walkOf(packPiece(piece) as unknown as Piece).over).toBe('chord');
    const link = await encodeShareLink(piece, 'https://example.org/');
    expect(link).toContain('#p=2.');
    const r = parsePiece(await decodeShareLink(link));
    expect(r.ok && r.piece).toEqual(piece);
  });

  it('an absent over stays absent', async () => {
    const piece = withWalk({ over: undefined });
    expect('over' in walkOf(piece)).toBe(false);
    const r = parsePiece(await decodeShareLink(await encodeShareLink(piece, 'https://x.org/')));
    expect(r.ok && 'over' in walkOf(r.piece)).toBe(false);
  });
});

describe('undo', () => {
  it('each switch is one entry; Key drops the field', () => {
    loadPiece(withWalk({ over: undefined }));
    const walk = (): WalkMoment => walkOf(usePlayer.getState().piece);
    expect(updateMoment('w1', { over: 'chord' }, 'Walk over')).toBe(true);
    expect(walk().over).toBe('chord');
    updateMoment('w1', { over: undefined }, 'Walk over');
    expect('over' in walk()).toBe(false);
    undo();
    expect(walk().over).toBe('chord');
    undo();
    expect('over' in walk()).toBe(false);
  });
});
