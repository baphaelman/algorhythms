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
import type { EaseRef, MixSettings, Piece } from '../../src/core/types';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import { LIVE_SEG_CAP, type LiveTracks } from '../../src/dsp/live';
import { LiveRig, liveSetupOf } from '../../src/audio/fixtures/live-rig';
import { DRY_MIX, makeScore } from '../../src/audio/fixtures/scores';
import { liveGains, liveSetupFrom } from '../../src/audio/live-setup';
import { newPiece } from '../../src/core/defaults';
import { Prng } from '../../src/dsp/rng';
import { clickScore, Driver, RATE, rms } from './helpers';

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

  // §9 merge window (M7-c): a press re-plans from its first key, so it plays as one chord there.
  for (const [name, lead] of [
    ['holding', 0.5],
    ['mid-glide', 0.1],
  ] as const) {
    it(`a chord pressed key by key within 15 ms plays as the chord from its first key (${name})`, () => {
      const make = () => {
        const rig = new LiveRig(liveSetupOf(6, 'glass'), { glide: 0.3 });
        rig.run(0.05);
        rig.noteOn(55);
        rig.run(lead);
        rig.noteOff(55);
        return rig;
      };
      // C, E, G 5 ms apart, landing in three different blocks.
      const rig = make();
      const t0 = rig.time;
      rig.noteOn(60);
      rig.run(0.005);
      rig.noteOn(64);
      rig.run(0.005);
      const t2 = rig.time;
      rig.noteOn(67);
      rig.run(0.6);
      // The same chord as one change at t0.
      const ref = make();
      expect(ref.time).toBe(t0);
      ref.keys.noteOn(60);
      ref.keys.noteOn(64);
      ref.noteOn(67);
      ref.run(0.61);
      const a = rig.input.tracks;
      const b = ref.input.tracks;
      for (let i = 0; i < a.data.length; i++) {
        for (let t = t2; t < rig.time; t += 0.001) {
          expect(Math.abs(a.pitchAt(i, t) - b.pitchAt(i, t))).toBeLessThan(1e-9);
        }
        expect(a.dest(i)).toBe(b.dest(i));
      }
      expectSameTracks(rig.mirror, rig.input.tracks);
      expect(new Set(a.data.map((_, i) => a.dest(i)))).toEqual(new Set([60, 64, 67]));
      // Every press change is logged with the first one's press and time.
      const press = rig.changes.slice(-3);
      expect(press.map((c) => c.press)).toEqual([press[0].seq, press[0].seq, press[0].seq]);
      expect(press.every((c) => c.time === t0)).toBe(true);
    });
  }

  it('a key beyond 15 ms re-targets mid-glide, carrying velocity', () => {
    const rig = new LiveRig(liveSetupOf(4, 'glass'), { glide: 0.3 });
    rig.run(0.05);
    rig.noteOn(55);
    rig.run(0.5);
    rig.noteOn(60);
    rig.run(0.02);
    const t = rig.time;
    rig.noteOn(67);
    rig.run(0.4);
    const tr = rig.input.tracks;
    const h = 1e-5;
    let joins = 0;
    for (let i = 0; i < tr.data.length; i++) {
      const k = tr.segmentAt(i, t);
      if (tr.data[i].segs[k * SEG_STRIDE + SEG_T0] !== t) continue;
      joins++;
      const vBefore = (tr.pitchAt(i, t) - tr.pitchAt(i, t - h)) / h;
      const vAfter = (tr.pitchAt(i, t + h) - tr.pitchAt(i, t)) / h;
      expect(Math.abs(vAfter - vBefore)).toBeLessThan(0.02 * Math.max(1, Math.abs(vBefore)));
    }
    expect(joins).toBeGreaterThan(0);
    expect(rig.changes.at(-1)!.press).toBe(rig.changes.at(-1)!.seq);
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

describe("live under mix.normalise 'part' (the default)", () => {
  /** A: 3 lines from 0; B: 2 lines from 2 s; C: 1 line from 8 s (silent at 5 s); to 10 s. */
  function partsPiece(normalise: 'part' | 'all') {
    const specs = [
      ...[57, 64, 69].map((start) => ({ start, died: 10 })),
      ...[72, 76].map((start) => ({ start, born: 2, died: 10 })),
      { start: 81, born: 8, died: 10 },
    ];
    const score = makeScore(specs, 10);
    score.voices.forEach((v, i) => (v.part = i < 3 ? 'A' : i < 5 ? 'B' : 'C'));
    const mix: MixSettings = { ...DRY_MIX, normalise };
    const piece: Piece = {
      ...newPiece({ seed: 1, poolSize: specs.length, timbre: 'sine' }),
      mix,
    };
    return { score, piece, mix };
  }

  /** Each sounding voice's amplitude in the piece at 5 s and live (entered at 5 s, level 1). */
  function amplitudes(normalise: 'part' | 'all') {
    const { score, piece, mix } = partsPiece(normalise);
    const d = new Driver(score, mix);
    d.graph.play(0);
    d.run(5);
    const setup = liveSetupFrom(piece, score, 5);
    const rig = new LiveRig(setup);
    rig.record = false;
    rig.run(0.05);
    rig.post({ moves: [], level: { gain: 1, over: 0 }, targets: null, silent: false }); // sound at the piece's pitches
    rig.run(1);
    return setup.voices.map((v, k) => {
      const i = score.voices.findIndex((c) => c.id === v.id);
      return { piece: d.graph.voiceAmplitude(i), live: rig.graph.voiceAmplitude(k), rig, k };
    });
  }

  for (const normalise of ['part', 'all'] as const) {
    it(`entering keeps each voice's gain from the piece (${normalise})`, () => {
      const amps = amplitudes(normalise);
      expect(amps).toHaveLength(5); // C is silent at the playhead
      for (const a of amps) {
        expect(a.piece).toBeGreaterThan(0);
        expect(Math.abs(a.live / a.piece - 1)).toBeLessThan(0.02);
      }
    });
  }

  it('a normalise change while live follows the piece (liveGains, M7-b)', () => {
    const { score, piece } = partsPiece('part');
    const setup = liveSetupFrom(piece, score, 5);
    const rig = new LiveRig(setup);
    rig.record = false;
    rig.run(0.05);
    rig.post({ moves: [], level: { gain: 1, over: 0 }, targets: null, silent: false });
    rig.run(0.5);
    for (const normalise of ['all', 'part'] as const) {
      const mix: MixSettings = { ...DRY_MIX, normalise };
      const d = new Driver(score, mix);
      d.graph.play(0);
      d.run(5);
      const gains = liveGains(setup, mix);
      if (normalise === 'all') expect(gains.some((g, k) => g !== setup.voices[k].gain)).toBe(true);
      // What LiveEngine.setMix posts.
      rig.graph.setMix(mix);
      gains.forEach((g, k) => rig.graph.setParam(`voices.${k}.gain`, g));
      rig.run(2);
      setup.voices.forEach((v, k) => {
        const i = score.voices.findIndex((c) => c.id === v.id);
        const ratio = rig.graph.voiceAmplitude(k) / d.graph.voiceAmplitude(i);
        expect(Math.abs(ratio - 1), `${normalise} ${v.id}`).toBeLessThan(0.02);
      });
    }
  });

  it('silence as a shared level of 0 keeps the normalisation constant', () => {
    const { score, piece } = partsPiece('part');
    const rig = new LiveRig(liveSetupFrom(piece, score, 5), { release: 'fade', releaseFade: 0.2 });
    rig.run(0.05);
    rig.noteOn(60);
    rig.noteOn(67);
    rig.run(1);
    const before = rig.input.tracks.data.map((_, k) => rig.graph.voiceAmplitude(k));
    rig.allOff();
    rig.run(0.5);
    for (let k = 0; k < before.length; k++) expect(rig.graph.voiceAmplitude(k)).toBe(0);
    rig.noteOn(60);
    rig.noteOn(67);
    rig.run(1);
    rig.input.tracks.data.forEach((_, k) =>
      expect(Math.abs(rig.graph.voiceAmplitude(k) / before[k] - 1)).toBeLessThan(0.02),
    );
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
      // Press-window rewinds (M7-c): chords pressed key by key 3–10 ms apart, every 80–300 ms.
      const press = new LiveRig(liveSetupOf(8, timbre), { glide: 0.15, stagger: 0.02 });
      const rng = new Prng(17);
      press.run(0.05);
      let rewinds = 0;
      while (press.time < 8) {
        press.keys.allOff();
        const k = 2 + Math.floor(rng.next() * 3);
        for (let j = 0; j < k; j++) {
          press.noteOn(48 + Math.floor(rng.next() * 25));
          if (j > 0 && press.changes.at(-1)!.press !== press.changes.at(-1)!.seq) rewinds++;
          press.run(0.003 + rng.next() * 0.007);
        }
        press.run(0.08 + rng.next() * 0.22);
      }
      const pr = clickScore(press.out().left, Math.floor(0.2 * RATE));
      console.info(`live clicks ${timbre}: presses ${pr.ratio.toFixed(3)} (${rewinds} rewinds)`);
      expect(rewinds).toBeGreaterThan(20);
      expect(pr.ratio).toBeLessThan(Math.max(2 * ref.ratio, 0.05));
    });
  }
});
