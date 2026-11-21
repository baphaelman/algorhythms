/** A recording stand-in for a 2D context: each stroke or fill with its style, alpha and path. */

import type { Ctx2D } from '../../../src/render';

export interface Shape {
  style: unknown;
  alpha: number;
  width: number;
  dashed: boolean;
  /** Path points (moveTo, lineTo), in order. */
  pts: [number, number][];
  /** Arcs in the path. */
  arcs: { x: number; y: number; r: number; a0: number; a1: number }[];
}

export function pathCtx(): { ctx: Ctx2D; strokes: Shape[]; fills: Shape[] } {
  const strokes: Shape[] = [];
  const fills: Shape[] = [];
  const state: Record<string, unknown> = {
    globalAlpha: 1,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
  };
  let pts: [number, number][] = [];
  let arcs: Shape['arcs'] = [];
  let dash: number[] = [];
  const shape = (style: unknown): Shape => ({
    style,
    alpha: state.globalAlpha as number,
    width: state.lineWidth as number,
    dashed: dash.length > 0,
    pts,
    arcs,
  });
  const ctx = new Proxy(state, {
    get(target, prop: string) {
      if (prop === 'measureText') return (s: string) => ({ width: s.length * 6 });
      if (prop === 'createLinearGradient') return () => ({ addColorStop() {} });
      if (prop in target) return target[prop];
      return (...args: number[] & unknown[]) => {
        if (prop === 'setLineDash') dash = args[0] as unknown as number[];
        if (prop === 'beginPath') {
          pts = [];
          arcs = [];
        }
        if (prop === 'moveTo' || prop === 'lineTo') pts.push([args[0], args[1]]);
        if (prop === 'arc')
          arcs.push({ x: args[0], y: args[1], r: args[2], a0: args[3], a1: args[4] });
        if (prop === 'stroke') strokes.push(shape(target.strokeStyle));
        if (prop === 'fill') fills.push(shape(target.fillStyle));
      };
    },
    set(target, prop: string, value: unknown) {
      target[prop] = value;
      return true;
    },
  }) as unknown as Ctx2D;
  return { ctx, strokes, fills };
}
