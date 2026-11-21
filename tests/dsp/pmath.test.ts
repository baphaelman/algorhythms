/**
 * dsp/pmath.ts: portable replacements for Math.exp/pow/log/sin/cos/tan/atan2 (renders must be
 * bit-identical across platforms; see docs/build-log.md "Portable DSP math"). The pinned hash
 * equals what core/ease.ts and core/math.ts give for the same algorithms.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as pm from '../../src/dsp/pmath';

/** Deterministic arguments spread over [lo, hi]. */
function grid(lo: number, hi: number, n = 20001): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(lo + ((hi - lo) * i) / (n - 1) + 1e-9 * ((i * 7919) % 101));
  return out;
}

function maxRel(f: (x: number) => number, ref: (x: number) => number, xs: number[]): number {
  let m = 0;
  for (const x of xs) {
    const r = ref(x);
    m = Math.max(m, Math.abs(f(x) - r) / Math.max(Math.abs(r), 1e-300));
  }
  return m;
}

function maxAbs(f: (x: number) => number, ref: (x: number) => number, xs: number[]): number {
  let m = 0;
  for (const x of xs) m = Math.max(m, Math.abs(f(x) - ref(x)));
  return m;
}

describe('dsp pmath', () => {
  it('matches Math to well below audible precision', () => {
    expect(maxRel(pm.exp, Math.exp, grid(-40, 40))).toBeLessThan(1e-13);
    expect(maxRel(pm.exp2, Math.pow.bind(null, 2), grid(-30, 30))).toBeLessThan(1e-13);
    expect(maxRel(pm.log2, Math.log2, grid(1e-6, 1e4))).toBeLessThan(1e-15);
    expect(maxRel(pm.ln, Math.log, grid(1e-6, 1e4))).toBeLessThan(1e-15);
    expect(
      maxRel(
        (x) => pm.pow(x, 1.37),
        (x) => Math.pow(x, 1.37),
        grid(1e-3, 100),
      ),
    ).toBeLessThan(1e-13);
    expect(maxRel(pm.dbToGain, (d) => Math.pow(10, d / 20), grid(-120, 24))).toBeLessThan(1e-13);
    expect(maxAbs(pm.sin, Math.sin, grid(-4000, 4000))).toBeLessThan(1e-12);
    expect(maxAbs(pm.cos, Math.cos, grid(-10, 10))).toBeLessThan(1e-13);
    expect(maxRel(pm.tan, Math.tan, grid(1e-6, 1.5))).toBeLessThan(1e-13);
    for (const a of grid(-Math.PI, Math.PI, 4001)) {
      for (const r of [1e-6, 0.3, 7]) {
        const y = r * Math.sin(a);
        const x = r * Math.cos(a);
        expect(Math.abs(pm.atan2(y, x) - Math.atan2(y, x))).toBeLessThan(1e-15);
      }
    }
  });

  it('handles the edge cases its callers can hit', () => {
    expect(pm.exp(0)).toBe(1);
    expect(pm.exp2(3)).toBe(8);
    expect(pm.exp2(-2)).toBe(0.25);
    expect(pm.log2(8)).toBe(3);
    expect(pm.pow(0, 2)).toBe(0);
    expect(pm.pow(5, 0)).toBe(1);
    expect(pm.pow(2, 10)).toBe(1024);
    expect(pm.dbToGain(0)).toBe(1);
    expect(pm.atan2(0, 1)).toBe(0);
    expect(pm.atan2(0, -1)).toBe(Math.PI);
    expect(pm.atan2(1, 0)).toBe(Math.PI / 2);
    expect(pm.atan2(-1, 0)).toBe(-Math.PI / 2);
    expect(pm.atan2(1, 1)).toBe(Math.PI / 4);
    expect(pm.atan2(-1, -1)).toBe((-3 * Math.PI) / 4);
    expect(pm.atan2(NaN, 1)).toBeNaN();
  });

  it("register forms give the plain forms' bits", () => {
    for (const x of grid(-7, 7, 2001)) {
      pm.R[0] = x;
      pm.sinCosR();
      expect(pm.R[0]).toBe(pm.sin(x));
      expect(pm.R[1]).toBe(pm.cos(x));
      pm.R[0] = x;
      pm.expR();
      expect(pm.R[0]).toBe(pm.exp(x));
      pm.R[0] = x;
      pm.R[1] = 0.3 - x;
      pm.atan2R();
      expect(pm.R[0]).toBe(pm.atan2(x, 0.3 - x));
    }
  });

  it('gives pinned bits (same on every platform: only + − × ÷ and exact operations)', () => {
    const h = createHash('sha256');
    const buf = new Float64Array(9);
    for (const x of grid(-3, 3, 5001)) {
      buf[0] = pm.exp(x * 7);
      buf[1] = pm.exp2(x * 5);
      buf[2] = pm.log2(Math.abs(x) + 0.01);
      buf[3] = pm.ln(Math.abs(x) * 30 + 1e-3);
      buf[4] = pm.pow(Math.abs(x) + 0.5, x);
      buf[5] = pm.sin(x * 100);
      buf[6] = pm.cos(x);
      buf[7] = pm.tan(x * 0.5);
      buf[8] = pm.atan2(x, 1.5 - x * x);
      h.update(new Uint8Array(buf.buffer));
    }
    expect(h.digest('hex').slice(0, 32)).toMatchInlineSnapshot(
      `"39a27dd6285b5968cc35f8d06e796053"`,
    );
  });
});
