/**
 * Video frames leave no state behind (CI v66: macOS WebKit drew frame k differently the second
 * time). Frames of a bundled piece on one target and one ghost layer, as the export draws them:
 * frame k's calls (with the state each draw reads) are the same whatever was drawn before,
 * save/restore balance, and no clip is set inside another or under a composite.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { parsePiece } from '../../../src/core/schema';
import {
  drawVideoFrame,
  videoMarkers,
  videoStyle,
  type Ctx2D,
  type VideoAspect,
} from '../../../src/render';

const ROOT = join(import.meta.dirname, '../../..');

interface Rec {
  ctx: Ctx2D;
  calls: string[];
  /** Problems seen: unbalanced restore, nested clip, drawImage under a clip. */
  bad: string[];
  depth(): number;
}

/** A recording context: each call with the state it reads, and whether a clip is set. */
function recorder(): Rec {
  const calls: string[] = [];
  const bad: string[] = [];
  // Per save level: whether a clip is set at that level or below.
  const clipped: boolean[] = [false];
  const state: Record<string, unknown> = {
    globalAlpha: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    globalCompositeOperation: 'source-over',
  };
  const saved: Record<string, unknown>[] = [];
  const s = (k: string) => String(state[k]);
  const read = (op: string) => {
    if (op.startsWith('fill')) return `${s('fillStyle')} ${s('globalAlpha')}`;
    if (op.startsWith('stroke'))
      return ['strokeStyle', 'globalAlpha', 'lineWidth', 'lineCap', 'lineJoin'].map(s).join(' ');
    if (op === 'drawImage') return s('globalAlpha');
    return '';
  };
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop === 'measureText')
        return (t: string) => ({
          width: t.length * 6,
          actualBoundingBoxAscent: 7,
          actualBoundingBoxDescent: 2,
        });
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (prop in target) return target[prop];
      return (...a: unknown[]) => {
        const text = prop.endsWith('Text')
          ? ['font', 'textAlign', 'textBaseline'].map(s).join(' ')
          : '';
        calls.push(
          `${prop}${JSON.stringify(a)} ${read(prop)} ${text} ${s('globalCompositeOperation')}`,
        );
        const top = clipped.length - 1;
        if (prop === 'save') {
          saved.push({ ...target });
          clipped.push(clipped[top]);
        } else if (prop === 'restore') {
          if (saved.length === 0) bad.push('restore without save');
          else {
            Object.assign(target, saved.pop());
            clipped.pop();
          }
        } else if (prop === 'clip') {
          if (clipped[top]) bad.push('clip inside a clip');
          clipped[top] = true;
        } else if (prop === 'drawImage' && clipped[top]) {
          bad.push('drawImage under a clip');
        }
      };
    },
    set(target, prop: string, value: unknown) {
      target[prop] = value;
      return true;
    },
  }) as unknown as Ctx2D;
  return { ctx, calls, bad, depth: () => saved.length };
}

let layers: Rec[] = [];
class FakeOffscreen {
  constructor(
    public width: number,
    public height: number,
  ) {}
  getContext() {
    const r = recorder();
    layers.push(r);
    return r.ctx;
  }
}

function load(file: string) {
  const r = parsePiece(JSON.parse(readFileSync(join(ROOT, file), 'utf8')));
  if (!r.ok) throw new Error(r.errors.join('; '));
  return r.piece;
}

describe('video frames leave no state behind', () => {
  beforeEach(() => {
    layers = [];
    vi.stubGlobal('OffscreenCanvas', FakeOffscreen);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // video-frames.spec's piece; its frames, and one with the ghost layer in use.
  const piece = load('examples/songs/tide-pools.algorhythms.json');
  const score = compile(piece);
  for (const aspect of ['16:9', '9:16', '1:1'] as VideoAspect[]) {
    it(aspect, () => {
      const style = videoStyle({
        theme: aspect === '9:16' ? 'dark' : 'light',
        thickness: true,
        oklch: true,
        customColors: piece.voices.map((v) => v.color),
        ...videoMarkers(piece),
      });
      const opts = { aspect, size: '1080' as const, camera: 'follow' as const, window: 24, style };
      let ghost = -1;
      for (let k = 0; k < score.duration * 30 && ghost < 0; k += 15) {
        drawVideoFrame(recorder().ctx, score, opts, k, 30);
        if (layers.some((l) => l.calls.some((c) => c.startsWith('fill')))) ghost = k;
        layers = [];
      }
      expect(ghost).toBeGreaterThanOrEqual(0);
      const g = recorder();
      const runs: { main: string[]; layer: string[] }[] = [];
      const ks = [ghost, 1500, 30, 3000, ghost, 1500, 0, ghost];
      for (const k of ks) {
        const m0 = g.calls.length;
        const l0 = layers.map((l) => l.calls.length);
        drawVideoFrame(g.ctx, score, opts, k, 30);
        expect(g.depth(), `frame ${k}: save depth`).toBe(0);
        for (const l of layers) expect(l.depth(), `frame ${k}: layer save depth`).toBe(0);
        runs.push({
          main: g.calls.slice(m0),
          layer: layers.flatMap((l, i) => l.calls.slice(l0[i] ?? 0)),
        });
      }
      expect(g.bad).toEqual([]);
      for (const l of layers) expect(l.bad).toEqual([]);
      expect(layers.length, 'one ghost layer, reused').toBe(1);
      expect(runs[0].layer.length).toBeGreaterThan(0);
      for (let i = 1; i < ks.length; i++) {
        const j = ks.indexOf(ks[i]);
        if (j === i) continue;
        expect(runs[i].main, `frame ${ks[i]}`).toEqual(runs[j].main);
        expect(runs[i].layer, `frame ${ks[i]}: layer`).toEqual(runs[j].layer);
      }
    });
  }
});
