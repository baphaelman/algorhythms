/**
 * Live mode on the audio thread (PLAN.md §9, M7a): live messages apply on the next block at the
 * stamped frame, the main thread's mirror equals the worklet's records, chord presses re-target
 * smoothly, and rapid key changes, bends and releases do not click.
 */

import { describe, expect, it, vi } from 'vitest';
import type { EaseCode } from '../../src/core/ease';
import {
  evalFlatSegment,
  SEG_BX1,
  SEG_BX2,
  SEG_BY1,
  SEG_BY2,
  SEG_CLAMPED,
  SEG_CURVE_P1,
  SEG_CURVE_T1,
  SEG_EASE,
  SEG_M0,
  SEG_P0,
  SEG_P1,
  SEG_STRIDE,
  SEG_T0,
  SEG_T1,
  segmentVelocity,
} from '../../src/core/segment';
import type { EaseRef } from '../../src/core/types';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import { LIVE_SEG_CAP, type LiveTracks } from '../../src/dsp/live';
import { LiveRig, liveSetupOf } from '../../src/audio/fixtures/live-rig';
import { DRY_MIX } from '../../src/audio/fixtures/scores';
import { Prng } from '../../src/dsp/rng';
import { clickScore, RATE, rms } from './helpers';

vi.setConfig({ testTimeout: 60_000 });

/** Zero-crossing frequency of `x` over [a, b) seconds. */
function frequency(x: Float32Array, a: number, b: number): number {
  const from = Math.floor(a * RATE);
  const to = Math.floor(b * RATE);
  const cross: number[] = [];
  for (let i = from + 1; i < to; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) cross.push(i - 1 + -x[i - 1] / (x[i] - x[i - 1]));
  }
  return ((cross.length - 1) * RATE) / (cross[cross.length - 1] - cross[0]);
}

const hz = (p: number): number => 440 * 2 ** ((p - 69) / 12);
const cents = (f: number, p: number): number => 1200 * Math.log2(f / hz(p));

/** The two tracks hold identical records. */
function expectSameTracks(a: LiveTracks, b: LiveTracks): void {
  expect(a.data.length).toBe(b.data.length);
  for (let i = 0; i < a.data.length; i++) {
    const x = a.data[i];
    const y = b.data[i];
    expect(x.nSeg).toBe(y.nSeg);
    expect(Array.from(x.segs.subarray(0, x.nSeg * SEG_STRIDE))).toEqual(
      Array.from(y.segs.subarray(0, y.nSeg * SEG_STRIDE)),
    );
    expect(x.nLevel).toBe(y.nLevel);
    expect(Array.from(x.levels.subarray(0, x.nLevel * 3))).toEqual(
      Array.from(y.levels.subarray(0, y.nLevel * 3)),
    );
    expect(x.nStrike).toBe(y.nStrike);
    expect(Array.from(x.strikeT.subarray(0, x.nStrike))).toEqual(
      Array.from(y.strikeT.subarray(0, y.nStrike)),
    );
  }
}

/** A seeded run of key changes every 12–80 ms: chords, unisons, releases, sustain and bends. */
function rapidSession(rig: LiveRig, seconds: number, seed = 3): void {
  const rng = new Prng(seed);
  const held = new Set<number>();
  rig.run(0.05);
  while (rig.time < seconds) {
    const r = rng.next();
    if (r < 0.45 || held.size === 0) {
      const p = 48 + Math.floor(rng.next() * 25);
      held.add(p);
      rig.noteOn(p);
    } else if (r < 0.85) {
      const list = [...held];
      const p = list[Math.floor(rng.next() * list.length)];
      held.delete(p);
      rig.noteOff(p);
    } else if (r < 0.92) {
      rig.bend((rng.next() * 2 - 1) * 2);
    } else {
      rig.sustain(rng.next() < 0.5);
    }
    rig.run(0.012 + rng.next() * 0.068);
  }
}

describe('live messages (M7a)', () => {
  it('apply on the next block, at its first frame, and the sound starts there', () => {
    const rig = new LiveRig(liveSetupOf(4, 'sine'));
    rig.run(0.1);
    const before = rig.time;
    const seq = rig.noteOn(60);
    expect(rig.input.appliedCount).toBe(0); // queued, not applied
    rig.block();
    expect(rig.input.appliedCount).toBe(1);
    expect(rig.input.appliedSeq[0]).toBe(seq);
    expect(rig.input.appliedTime).toBe(before);
    const stamp = rig.stamps.get(seq)!;
    expect(stamp.frame).toBe(Math.round(before * RATE));
    // Every voice starts its note at the stamped time.
    for (const d of rig.input.tracks.data) {
      expect(d.segs[(d.nSeg - 1) * SEG_STRIDE + SEG_T0]).toBe(before);
      expect(d.segs[(d.nSeg - 1) * SEG_STRIDE + SEG_P1]).toBe(60);
    }
    rig.run(0.2);
    const { left } = rig.out();
    const delay = rig.graph.limiterDelayFrames;
    let first = -1;
    for (let i = 0; i < left.length; i++) {
      if (Math.abs(left[i]) > 1e-6) {
        first = i;
        break;
      }
    }
    expect(first).toBeGreaterThanOrEqual(stamp.frame + delay);
    expect(first).toBeLessThan(stamp.frame + delay + BLOCK_FRAMES);
    expect(rms(left, stamp.frame + delay + 2400, stamp.frame + delay + 7200)).toBeGreaterThan(0.01);
  });

  it('glides start at the stamped frame and land on the target', () => {
    const rig = new LiveRig(liveSetupOf(1, 'sine'));
    rig.run(0.05);
    rig.noteOn(60);
    rig.run(0.4);
    rig.noteOff(60); // hold
    rig.run(0.1);
    const t0 = rig.time;
    const seq = rig.noteOn(67);
    rig.run(0.6);
    const stamp = rig.stamps.get(seq)!;
    expect(stamp.time).toBe(t0);
    const d = rig.input.tracks.data[0];
    const k = d.nSeg - 2; // the glide, then its hold
    expect(d.segs[k * SEG_STRIDE + SEG_T0]).toBe(t0);
    expect(d.segs[k * SEG_STRIDE + SEG_P0]).toBe(60);
    expect(d.segs[k * SEG_STRIDE + SEG_P1]).toBe(67);
    const { left } = rig.out();
    const lat = rig.graph.limiterDelayFrames / RATE;
    expect(Math.abs(cents(frequency(left, t0 + lat - 0.04, t0 + lat), 60))).toBeLessThan(6);
    expect(Math.abs(cents(frequency(left, t0 + lat + 0.3, t0 + lat + 0.5), 67))).toBeLessThan(6);
  });

  it('the mirror equals the worklet after a rapid session (compaction included)', () => {
    const rig = new LiveRig(liveSetupOf(6, 'glass'), { stagger: 0.03, glide: 0.2 });
    rig.record = false;
    rapidSession(rig, 30);
    expect(rig.input.tracks.data[0].nSeg).toBeLessThanOrEqual(LIVE_SEG_CAP);
    expectSameTracks(rig.mirror, rig.input.tracks);
  });

  it('a chord pressed within 15 ms re-targets each voice with no velocity jump', () => {
    const rig = new LiveRig(liveSetupOf(6, 'glass'), { glide: 0.3 });
    rig.run(0.05);
    rig.noteOn(55);
    rig.run(0.5);
    rig.noteOff(55);
    // C, E, G 5 ms apart, landing in three different blocks.
    const t = [rig.time];
    rig.noteOn(60);
    rig.run(0.005);
    t.push(rig.time);
    rig.noteOn(64);
    rig.run(0.005);
    t.push(rig.time);
    rig.noteOn(67);
    rig.run(0.6);
    const tr = rig.input.tracks;
    const h = 1e-5;
    let joins = 0;
    for (let i = 0; i < tr.data.length; i++) {
      for (const tj of t.slice(1)) {
        const vBefore = (tr.pitchAt(i, tj) - tr.pitchAt(i, tj - h)) / h;
        const vAfter = (tr.pitchAt(i, tj + h) - tr.pitchAt(i, tj)) / h;
        const k = tr.segmentAt(i, tj);
        if (tr.data[i].segs[k * SEG_STRIDE + SEG_T0] !== tj) continue; // not moved here
        joins++;
        expect(tr.data[i].segs[k * SEG_STRIDE + SEG_CLAMPED]).toBe(0);
        expect(Math.abs(vAfter - vBefore)).toBeLessThan(0.02 * Math.max(1, Math.abs(vBefore)));
      }
      expect(Math.abs(tr.pitchAt(i, rig.time) - tr.dest(i))).toBeLessThan(1e-9);
    }
    expect(joins).toBeGreaterThan(0);
    const dests = tr.data.map((_, i) => tr.dest(i)).sort((a, b) => a - b);
    expect(new Set(dests)).toEqual(new Set([60, 64, 67]));
  });

  it('bend shifts every voice continuously', () => {
    const rig = new LiveRig(liveSetupOf(2, 'sine'));
    rig.run(0.05);
    rig.noteOn(57);
    rig.run(0.3);
    const t = rig.time;
    rig.bend(2);
    rig.run(0.3);
    rig.bend(5); // clamped to the ±2 range
    rig.run(0.1);
    const { left } = rig.out();
    const lat = rig.graph.limiterDelayFrames / RATE;
    expect(Math.abs(cents(frequency(left, t + lat - 0.1, t + lat), 57))).toBeLessThan(6);
    expect(Math.abs(cents(frequency(left, t + lat + 0.1, t + lat + 0.3), 59))).toBeLessThan(6);
    expect(Math.abs(cents(frequency(left, t + lat + 0.32, t + lat + 0.4), 59))).toBeLessThan(6);
  });

  it('fade release falls silent; the next key steps in from silence', () => {
    const rig = new LiveRig(liveSetupOf(3, 'glass', [36, 84], 60, DRY_MIX), {
      release: 'fade',
      releaseFade: 0.3,
    });
    rig.run(0.05);
    rig.noteOn(62);
    rig.run(0.4);
    const off = rig.time;
    rig.noteOff(62);
    rig.run(0.5);
    const on = rig.time;
    rig.noteOn(69);
    rig.run(0.3);
    const { left } = rig.out();
    const f = (s: number) => Math.floor(s * RATE);
    expect(rms(left, f(off - 0.1), f(off))).toBeGreaterThan(0.01);
    expect(rms(left, f(off + 0.32), f(on))).toBeLessThan(
      1e-3 * rms(left, f(off - 0.1), f(off)) + 1e-3,
    );
    // Stepped, not glided: the voices hold 69 from the start.
    for (let i = 0; i < 3; i++) expect(rig.input.tracks.pitchAt(i, on + 0.001)).toBe(69);
  });
});

describe('live segment evaluation', () => {
  it('equals core/segment for every ease (the written-out polynomials included)', () => {
    const eases: EaseRef[] = [
      'smootherstep',
      'smoothstep',
      'cosine',
      'linear',
      'expo',
      { kind: 'bezier', x1: 0.3, y1: -0.2, x2: 0.6, y2: 1.3 },
    ];
    const rig = new LiveRig(liveSetupOf(1, 'sine'));
    rig.run(0.05);
    rig.noteOn(60);
    rig.run(0.1);
    const rng = new Prng(9);
    for (const ease of eases) {
      rig.settings = { ...rig.settings, ease, glide: 0.2 };
      for (let k = 0; k < 6; k++) {
        rig.keys.allOff();
        rig.noteOn(48 + Math.floor(rng.next() * 24));
        rig.run(0.01 + rng.next() * 0.05); // interrupted mid-glide: carried velocity
      }
    }
    const tr = rig.input.tracks;
    const d = tr.data[0];
    let n = 0;
    for (let t = 0.05; t < rig.time; t += 0.0007) {
      const k = tr.segmentAt(0, t);
      expect(tr.pitchAt(0, t)).toBe(evalFlatSegment(d.segs, k * SEG_STRIDE, t));
      const o = k * SEG_STRIDE;
      const s = d.segs;
      const v = segmentVelocity(
        s[o + SEG_T0],
        s[o + SEG_T1],
        s[o + SEG_P0],
        s[o + SEG_P1],
        s[o + SEG_EASE] as EaseCode,
        s[o + SEG_BX1],
        s[o + SEG_BY1],
        s[o + SEG_BX2],
        s[o + SEG_BY2],
        s[o + SEG_M0],
        t,
        s[o + SEG_CURVE_T1],
        s[o + SEG_CURVE_P1],
      );
      if (tr.glidingAt(0, t)) {
        expect(tr.velocityAt(0, t)).toBe(v);
        n++;
      }
    }
    expect(n).toBeGreaterThan(100);
  });
});

describe('no clicks under rapid key changes (M7a)', () => {
  for (const timbre of ['sine', 'glass', 'pluck', 'epiano']) {
    it(timbre, () => {
      // Reference: the same voices, one slow change per second.
      const slow = new LiveRig(liveSetupOf(8, timbre), { glide: 0.4 });
      slow.run(0.05);
      for (const p of [60, 64, 67, 72]) {
        slow.keys.allOff();
        slow.noteOn(p);
        slow.run(0.6);
        slow.noteOn(p - 5);
        slow.run(0.6);
      }
      const ref = clickScore(slow.out().left, Math.floor(0.2 * RATE));
      const fast = new LiveRig(liveSetupOf(8, timbre), { glide: 0.15, stagger: 0.02 });
      rapidSession(fast, 8, 11);
      const out = fast.out();
      const got = clickScore(out.left, Math.floor(0.2 * RATE));
      console.info(
        `live clicks ${timbre}: rapid ${got.ratio.toFixed(3)} vs slow ${ref.ratio.toFixed(3)}`,
      );
      expect(got.ratio).toBeLessThan(Math.max(2 * ref.ratio, 0.05));
    });
  }
});
