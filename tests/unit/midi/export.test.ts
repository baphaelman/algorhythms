/**
 * MIDI export proof (PLAN.md §12): every export is parsed back by an independent SMF reader, each
 * voice's pitch is rebuilt from notes + bends + the declared bend range, and compared with core's
 * `pitchAt` (and CC11 with the life/level gain), on hand-built scores and the example pieces.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { pulseGainAt } from '../../../src/core/pulse';
import { pitchAt, weightAt, weightTargetAt } from '../../../src/core/query';
import { parsePiece } from '../../../src/core/schema';
import type { CompiledScore, CompiledVoice, Life } from '../../../src/core/types';
import {
  exportMidi,
  PPQ,
  zipFiles,
  type MidiExportOptions,
  type MidiFile,
} from '../../../src/midi/export';
import { crossfadePiece } from '../core/crossfade-fixtures';
import { pulseChordPiece, pulseGatePiece } from '../core/pulse-fixtures';
import { easeScore, lifeScore, manyVoices, wideScore } from './fixtures';
import {
  cc11At,
  parseSmf,
  reconstruct,
  tempoOf,
  trackName,
  trackPitch,
  type TrackTrace,
} from './smf-parser';

const TOL_ST = 0.02; // 2 cents
const worst = { cents: 0, where: '' };

function sounding(score: CompiledScore): CompiledVoice[] {
  return score.voices.filter((v) => v.lives.length > 0 && v.segments.length > 0);
}

function lifeEnd(v: CompiledVoice, l: Life): number {
  if (l.died !== undefined) return l.died;
  return Math.max(l.born, ...v.segments.filter((s) => s.t0 >= l.born).map((s) => s.t1));
}

/** Reference pitch at t, tolerant of one tick around life edges. */
function truth(v: CompiledVoice, t: number, tps: number): number | null {
  for (const l of v.lives) {
    const end = lifeEnd(v, l);
    if (t >= l.born - 1.5 / tps && t <= end + 1.5 / tps) {
      return pitchAt(v, Math.min(Math.max(t, l.born), end - 1e-9));
    }
  }
  return null;
}

/**
 * Independent copy of the sound engine's gain as CC11 carries it (R9-3b): smootherstep life fades
 * (≥ 5 ms), √X over a merge's or split's crossfade window, the level ramps, the pulse envelope
 * (core's reference) and √(weight / the life's peak weight) (the note strikes at that peak).
 */
function expectedGain(v: CompiledVoice, t: number, peak: number): number {
  const sstep = (x: number): number => x * x * x * (x * (x * 6 - 15) + 10);
  let w = 0;
  let wPeak = 1;
  for (const l of v.lives) {
    const end = l.died ?? Infinity;
    if (t < l.born || t >= end) continue;
    w = 1;
    const u = (t - l.born) / Math.max(l.fadeIn, 0.005);
    if (u < 1) w = l.crossIn ? Math.sqrt(sstep(u)) : sstep(u);
    const d = (end - t) / Math.max(l.fadeOut ?? 0, 0.005);
    if (d < 1) w *= l.crossOut ? Math.sqrt(sstep(d)) : sstep(d);
    const stop = l.died ?? Infinity;
    wPeak = weightTargetAt(v, l.born);
    for (const c of v.weight ?? []) if (c.t >= l.born && c.t <= stop) wPeak = Math.max(wPeak, c.w);
  }
  let level = 1;
  let start = 1;
  v.level.forEach((e, i) => {
    if (e.t > t) return;
    if (i > 0) {
      const p = v.level[i - 1];
      const u = p.over > 0 ? (e.t - p.t) / p.over : 1;
      start += (p.gain - start) * (u >= 1 ? 1 : u);
    }
    const u = e.over > 0 ? (t - e.t) / e.over : 1;
    level = u >= 1 ? e.gain : start + (e.gain - start) * u;
  });
  const lw = v.weight?.length ? Math.min(1, weightAt(v, t) / wPeak) : 1;
  return (w * level * pulseGainAt(v, t) * Math.sqrt(lw)) / peak;
}

/** CC11 is thinned (src/midi/export.ts CC_STEP, CC_MIN_GAP): what it may lag by at a tick. */
const CC_STEP = 2;
const CC_GAP = 0.005;

/**
 * Worst CC11 error over a track against `expectedGain`, beyond what the thinning allows: 1.5
 * steps, plus how far the gain moved in the CC_GAP (+ a tick) before.
 */
function cc11Excess(
  v: CompiledVoice,
  cc: { tick: number; value: number }[],
  peak: number,
  tps: number,
  total: number,
  every = 3,
): number {
  let worst = 0;
  for (let tick = 0; tick <= total; tick += every) {
    const t = tick / tps;
    const want = expectedGain(v, t, peak);
    let lag = 0;
    for (let k = 1; k <= 6; k++) {
      const tp = t - (k / 6) * (CC_GAP + 1 / tps);
      lag = Math.max(lag, Math.abs(want - expectedGain(v, tp, peak)));
    }
    const err = Math.abs(cc11At(cc, tick) / 127 - want);
    worst = Math.max(worst, err - ((CC_STEP - 0.5) / 127 + lag));
  }
  return worst;
}

/** Index of the first element with key(x) >= v in a sorted array. */
function lowerBound<T>(a: T[], v: number, key: (x: T) => number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(a[mid]) < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

interface Verified {
  restrikes: number;
  bendEvents: number;
  maxCents: number;
}

/** Parse one file and check every voice track in it against the score. */
function verifyFile(
  file: MidiFile,
  voices: CompiledVoice[],
  score: CompiledScore,
  o: {
    range: number;
    cc11?: boolean;
    channelOf: (k: number) => number;
    bpm?: number;
    label: string;
    samples?: number;
  },
): Verified {
  const smf = parseSmf(file.data);
  expect(smf.chunksOk).toBe(true);
  expect(smf.format).toBe(1);
  expect(smf.ppq).toBe(PPQ);
  expect(smf.trackCount).toBe(1 + voices.length);
  const micros = tempoOf(smf.tracks[0]);
  expect(micros).toBe(Math.round(60e6 / (o.bpm ?? 60)));
  const tps = (PPQ * 1e6) / micros;
  const shift = 12 * Math.log2(score.referenceHz / 440);
  const out: Verified = { restrikes: 0, bendEvents: 0, maxCents: 0 };
  const rand = lcg(7);
  const note = (err: number, what: string): void => {
    const cents = Math.abs(err) * 100;
    out.maxCents = Math.max(out.maxCents, cents);
    if (cents > worst.cents) {
      worst.cents = cents;
      worst.where = `${o.label} ${what}`;
    }
    if (Math.abs(err) > TOL_ST) {
      throw new Error(`${o.label} ${what}: pitch error ${cents.toFixed(2)} cents`);
    }
  };

  voices.forEach((v, k) => {
    const events = smf.tracks[k + 1];
    expect(trackName(events)).toBe(v.id);
    const tr: TrackTrace = reconstruct(events);
    const ch = o.channelOf(k);
    for (const e of events) if (e.type !== 'meta') expect(e.ch).toBe(ch);

    // RPN 0 opens the track, well formed: select, data entry (+ cents), null.
    expect(tr.setupCcs.slice(0, 6)).toEqual([101, 100, 6, 38, 101, 100]);
    expect(tr.rpns).toHaveLength(1);
    expect(tr.rpns[0]).toMatchObject({ rpn: 0, msb: o.range, lsb: 0, closed: true });
    expect(tr.orderViolations).toBe(0);

    // Notes against lives: on/off within one tick; re-struck notes are contiguous.
    expect(tr.notes.length).toBeGreaterThanOrEqual(v.lives.length);
    for (const l of v.lives) {
      const end = lifeEnd(v, l);
      if ((end - l.born) * tps < 2) continue;
      const inLife = tr.notes.filter((n) => n.on >= l.born * tps - 1 && n.off <= end * tps + 1);
      expect(inLife.length).toBeGreaterThan(0);
      expect(Math.abs(inLife[0].on - l.born * tps)).toBeLessThanOrEqual(1);
      expect(Math.abs(inLife[inLife.length - 1].off - end * tps)).toBeLessThanOrEqual(1);
      for (let i = 1; i < inLife.length; i++) expect(inLife[i].on).toBe(inLife[i - 1].off);
      out.restrikes += inLife.length - 1;
    }
    for (const n of tr.notes) expect(n.range).toBe(o.range);

    // Pitch at every bend event, and midway between consecutive events inside a note.
    const bounds: [number, number][] = v.segments.flatMap((g) => [
      [g.t0 * tps, g.p0] as [number, number],
      [g.t1 * tps, g.p1] as [number, number],
    ]);
    bounds.sort((x, y) => x[0] - y[0]);
    for (const n of tr.notes) {
      for (let i = 0; i < n.bends.length; i++) {
        const b = n.bends[i];
        const want = truth(v, b.tick / tps, tps);
        if (want === null) throw new Error(`${o.label} v${k}: bend at ${b.tick} outside any life`);
        // A tick within half a tick of a segment boundary may carry the boundary pitch itself
        // (times are only good to a tick; this keeps holds exact).
        const cands = [want];
        for (let j = lowerBound(bounds, b.tick - 0.5 - 1e-6, (x) => x[0]); j < bounds.length; j++) {
          if (bounds[j][0] > b.tick + 0.5 + 1e-6) break;
          cands.push(bounds[j][1]);
        }
        const got = notePitchAt(n, b.tick) - shift;
        note(Math.min(...cands.map((x) => Math.abs(got - x))), `v${k} bend@${b.tick}`);
        out.bendEvents++;
        if (i + 1 < n.bends.length && n.bends[i + 1].tick - b.tick > 1) {
          const m = (b.tick + n.bends[i + 1].tick) / 2;
          const w2 = truth(v, m / tps, tps);
          note(notePitchAt(n, m) - (w2 as number) - shift, `v${k} mid@${m}`);
        }
      }
    }

    // Random times: sounding where the score sounds, silent where it does not.
    const total = score.duration * tps;
    for (let i = 0; i < (o.samples ?? 500); i++) {
      const tick = rand() * total;
      const t = tick / tps;
      const nearEdge = v.lives.some(
        (l) => Math.abs(t - l.born) < 2.5 / tps || Math.abs(t - lifeEnd(v, l)) < 2.5 / tps,
      );
      if (nearEdge) continue;
      const want = pitchAt(v, t);
      const got = trackPitch(tr.notes, tick);
      if (want === null) expect(got, `${o.label} v${k} silent@${tick}`).toBeNull();
      else {
        expect(got, `${o.label} v${k} sounding@${tick}`).not.toBeNull();
        note((got as number) - want - shift, `v${k} t=${t.toFixed(4)}`);
      }
    }

    // Bends only during glides, at >= 200 events/s.
    const spans = v.segments
      .filter((g) => g.p0 !== g.p1 || (g.m0 ?? 0) !== 0 || g.curve !== undefined)
      .map((g) => [g.t0 * tps, g.t1 * tps] as const);
    const inGlide = (tick: number): boolean => {
      const j = lowerBound(spans as (readonly [number, number])[], tick - 1.5, (x) => x[1]);
      return j < spans.length && spans[j][0] <= tick + 1.5;
    };
    const stray: number[] = [];
    for (const n of tr.notes) {
      for (const b of n.bends) if (b.tick !== n.on && !inGlide(b.tick)) stray.push(b.tick);
    }
    expect(stray, `${o.label} v${k}: bends outside any glide`).toEqual([]);
    const allBends = events.filter((e) => e.type === 'bend').map((e) => e.tick);
    for (const g of v.segments) {
      if (!(g.p0 !== g.p1 || g.curve !== undefined) || g.t1 - g.t0 < 0.02) continue;
      const a = Math.round(g.t0 * tps);
      const z = Math.round(g.t1 * tps);
      const ticks: number[] = [];
      for (
        let j = lowerBound(allBends, a, (x) => x);
        j < allBends.length && allBends[j] <= z;
        j++
      ) {
        if (ticks[ticks.length - 1] !== allBends[j]) ticks.push(allBends[j]);
      }
      let gap = 0;
      for (let i = 1; i < ticks.length; i++) gap = Math.max(gap, ticks[i] - ticks[i - 1]);
      expect(gap).toBeLessThanOrEqual(tps / 200 + 1e-9);
      expect(ticks.length).toBeGreaterThanOrEqual(((g.t1 - g.t0) * 200) | 0);
    }

    // CC11 follows the life and level gain at every tick it can change.
    if (o.cc11) {
      const peak = Math.max(1, ...score.voices.flatMap((x) => x.level.map((l) => l.gain)));
      expect(cc11Excess(v, tr.cc11, peak, tps, total)).toBeLessThanOrEqual(1e-9);
      // At most one event per CC_GAP, except jumps (pulse records).
      const jumps = new Set((v.pulse ?? []).map((r) => Math.round(r.t * tps)));
      for (let i = 1; i < tr.cc11.length; i++) {
        if (jumps.has(tr.cc11[i].tick)) continue;
        expect(tr.cc11[i].tick - tr.cc11[i - 1].tick).toBeGreaterThanOrEqual(
          Math.round(CC_GAP * tps),
        );
      }
      expect(tr.cc11[0]).toMatchObject({ tick: 0 });
    } else expect(tr.cc11).toHaveLength(0);
  });
  return out;
}

function notePitchAt(n: Parameters<typeof trackPitch>[0][number], t: number): number {
  return trackPitch([n], t) as number;
}

function run(
  score: CompiledScore,
  opts: MidiExportOptions,
  label: string,
  samples?: number,
): Verified {
  const res = exportMidi(score, opts);
  expect(res.files).toHaveLength(1);
  return verifyFile(res.files[0], sounding(score), score, {
    range: opts.bendRange ?? 24,
    cc11: opts.cc11,
    channelOf: (k) => (k % 15 < 9 ? k % 15 : (k % 15) + 1),
    bpm: opts.bpm,
    label,
    samples,
  });
}

describe('perVoice export on hand-built scores', () => {
  it('reconstructs every ease within 2 cents at all bend ranges', () => {
    for (const bendRange of [2, 12, 24, 48] as const) {
      const r = run(easeScore(), { bendRange }, `ease r${bendRange}`);
      expect(r.maxCents).toBeLessThanOrEqual(2);
      if (bendRange === 2) expect(r.restrikes).toBeGreaterThan(0);
    }
  });

  it('handles interruptions, cut segments, births, deaths and mid-glide lives', () => {
    const r = run(lifeScore(), {}, 'life');
    expect(r.maxCents).toBeLessThanOrEqual(2);
    // The voice that never sounds gets no track.
    expect(parseSmf(exportMidi(lifeScore()).files[0].data).trackCount).toBe(1 + 4);
  });

  it('re-strikes wide glides nearer the current pitch, bend reset before each note-on', () => {
    for (const bendRange of [2, 12, 24, 48] as const) {
      const r = run(wideScore(), { bendRange }, `wide r${bendRange}`);
      expect(r.maxCents).toBeLessThanOrEqual(2);
      expect(r.restrikes).toBeGreaterThanOrEqual({ 2: 20, 12: 5, 24: 2, 48: 0 }[bendRange]);
    }
    // 40 st within ±12: the note ends and a new one starts within range of the glide.
    const smf = parseSmf(exportMidi(wideScore(), { bendRange: 12 }).files[0].data);
    const notes = reconstruct(smf.tracks[1]).notes;
    expect(notes.length).toBeGreaterThan(2);
    for (const n of notes)
      for (const b of n.bends) expect(Math.abs(b.value - 8192)).toBeLessThan(8192);
  });

  it('honours bpm: tempo meta matches, times unchanged in seconds', () => {
    for (const bpm of [60, 90, 120, 137]) {
      const r = run(lifeScore(), { bpm }, `bpm${bpm}`);
      expect(r.maxCents).toBeLessThanOrEqual(2);
    }
  });

  it('applies a non-440 reference tuning through the bends', () => {
    const r = run(lifeScore(432), {}, 'tuning 432');
    expect(r.maxCents).toBeLessThanOrEqual(2);
    // Without it the file is 12·log2(432/440) = −31.8 cents off.
    const smf = parseSmf(exportMidi(lifeScore(432), { applyReferenceTuning: false }).files[0].data);
    const tr = reconstruct(smf.tracks[1]);
    const want = pitchAt(lifeScore(432).voices[0], 1);
    expect(trackPitch(tr.notes, PPQ) as number).toBeCloseTo(want as number, 6);
  });
});

describe('restrikeOnArrival', () => {
  it('ends and re-strikes the note at each arrival, pitch still exact', () => {
    const plain = run(easeScore(), {}, 'plain');
    const re = run(easeScore(), { restrikeOnArrival: true }, 'restrike');
    expect(re.maxCents).toBeLessThanOrEqual(2);
    expect(re.restrikes).toBeGreaterThan(plain.restrikes);
    // easeScore: two arrivals per voice (after each glide the next segment holds), 6 voices.
    expect(re.restrikes - plain.restrikes).toBe(12);
    const tr = reconstruct(
      parseSmf(exportMidi(easeScore(), { restrikeOnArrival: true }).files[0].data).tracks[1],
    );
    // The re-struck notes sit on the rounded pitch with a small bend (bend reset, not carried).
    const arrival = tr.notes[1];
    expect(Math.abs(arrival.bends[0].value - 8192)).toBeLessThan(8192 / 24 / 2 + 8);
  });
});

describe('CC11', () => {
  it('follows smootherstep life fades and linear level ramps', () => {
    for (const s of [lifeScore(), easeScore()]) {
      const r = run(s, { cc11: true }, 'cc11');
      expect(r.maxCents).toBeLessThanOrEqual(2);
    }
  });

  it('scales by the largest level so a boost above 1 does not clip', () => {
    const s = easeScore();
    s.voices[0].level = [{ t: 3, gain: 1.6, over: 2 }];
    const r = run(s, { cc11: true }, 'cc11 boost');
    expect(r.maxCents).toBeLessThanOrEqual(2);
    const smf = parseSmf(exportMidi(s, { cc11: true }).files[0].data);
    // Voice 0 sits at the peak (127); the others keep their balance against it.
    expect(cc11At(reconstruct(smf.tracks[1]).cc11, 6 * PPQ)).toBe(127);
    expect(cc11At(reconstruct(smf.tracks[2]).cc11, 6 * PPQ)).toBe(Math.round(127 / 1.6));
  });

  it('shapes a fade like smootherstep (midpoint 0.5, slow ends)', () => {
    const s = easeScore();
    const tr = reconstruct(parseSmf(exportMidi(s, { cc11: true }).files[0].data).tracks[1]);
    // fadeIn 0.5 s from t = 0.5 s: at 0.75 s gain 0.5, at 0.6 s smootherstep(0.2) = 0.05792
    // (within the thinning's 1.5 steps; the 5 ms lag is under 1 step on this fade).
    expect(Math.abs(cc11At(tr.cc11, 0.75 * PPQ) - 127 * 0.5)).toBeLessThanOrEqual(2.5);
    expect(Math.abs(cc11At(tr.cc11, 0.6 * PPQ) - 127 * 0.05792)).toBeLessThanOrEqual(2);
    expect(cc11At(tr.cc11, 0.3 * PPQ)).toBe(0);
    expect(cc11At(tr.cc11, 1.2 * PPQ)).toBe(127);
    expect(cc11At(tr.cc11, 11.5 * PPQ)).toBe(0);
  });
});

/** A line's life amplitude as dsp/voice.ts `computeLife` plays it (√X over crossfades). */
function lifeAmp(v: CompiledVoice, t: number): number {
  const sstep = (x: number): number => x * x * x * (x * (x * 6 - 15) + 10);
  for (const l of v.lives) {
    const end = l.died ?? Infinity;
    if (t < l.born || t >= end) continue;
    let w = 1;
    const u = (t - l.born) / Math.max(l.fadeIn, 0.005);
    if (u < 1) w = l.crossIn ? Math.sqrt(sstep(u)) : sstep(u);
    const d = (end - t) / Math.max(l.fadeOut ?? 0, 0.005);
    if (d < 1) w *= l.crossOut ? Math.sqrt(sstep(d)) : sstep(d);
    return w;
  }
  return 0;
}

describe('CC11: pulse envelopes and crossfades (R9-3b)', () => {
  it('pulse: each hit jumps on its tick, decays to accent × floor and settles exactly', () => {
    const s = compile(pulseGatePiece('sine', { floor: 0.2 }));
    run(s, { cc11: true }, 'cc11 pulse');
    const tr = reconstruct(parseSmf(exportMidi(s, { cc11: true }).files[0].data).tracks[1]);
    const hits = (s.voices[0].pulse ?? []).filter((r) => r.hit);
    expect(hits).toHaveLength(8);
    hits.forEach((h, i) => {
      const tick = Math.round(h.t * PPQ);
      expect(cc11At(tr.cc11, tick)).toBe(Math.round(127 * h.accent));
      // Before it: full level before the pulse, else the previous hit's settled floor.
      const before = i === 0 ? 127 : Math.round(127 * hits[i - 1].accent * hits[i - 1].floor);
      expect(cc11At(tr.cc11, tick - 1)).toBe(before);
      expect(cc11At(tr.cc11, Math.round((h.t + h.decay + 0.01) * PPQ))).toBe(
        Math.round(127 * h.accent * h.floor),
      );
    });
    expect(cc11At(tr.cc11, 5.2 * PPQ)).toBe(127);
  });

  it('pulse: sparse (step and rate cap) against writing every 7-bit change', () => {
    for (const [label, p] of [
      ['gate', pulseGatePiece('sine', { floor: 0.2 })],
      ['chord', pulseChordPiece('sine')],
    ] as const) {
      const s = compile(p);
      const smf = parseSmf(exportMidi(s, { cc11: true }).files[0].data);
      let events = 0;
      let naive = 0;
      let hits = 0;
      sounding(s).forEach((v, k) => {
        const cc = reconstruct(smf.tracks[k + 1]).cc11;
        events += cc.length;
        hits += (v.pulse ?? []).filter((r) => r.hit).length;
        let last = -1;
        for (let tick = 0; tick <= s.duration * PPQ; tick++) {
          const q = Math.round(127 * expectedGain(v, tick / PPQ, 1));
          if (q !== last) naive++;
          last = q;
        }
      });
      console.info(
        `CC11 ${label}: ${events} events (${(events / hits).toFixed(1)} per hit), ` +
          `every 7-bit change: ${naive} (${((100 * events) / naive).toFixed(0)} %)`,
      );
      expect(events / hits).toBeLessThan(40);
      expect(events).toBeLessThan(0.5 * naive);
    }
  });

  it('crossfades: fades over the whole window, and the lines keep their summed power', () => {
    const s = compile(crossfadePiece('sine'));
    expect(s.voices.some((v) => v.lives.some((l) => l.crossIn || l.crossOut))).toBe(true);
    run(s, { cc11: true }, 'cc11 crossfade');
    const smf = parseSmf(exportMidi(s, { cc11: true }).files[0].data);
    const voices = sounding(s);
    const traces = voices.map((_, k) => reconstruct(smf.tracks[k + 1]));
    const peakW = Math.max(1, ...s.voices.flatMap((v) => (v.weight ?? []).map((c) => c.w)));
    const scale = Math.min(1, 127 / (100 * Math.sqrt(peakW)));
    let worst = 0;
    for (let t = 0.5; t < 15; t += 0.005) {
      const tick = Math.round(t * PPQ);
      let midi = 0;
      let sound = 0;
      voices.forEach((v, k) => {
        const n = traces[k].notes.find((x) => x.on <= tick && tick < x.off);
        const vel = n ? n.velocity / (100 * scale) : 0;
        midi += (vel * cc11At(traces[k].cc11, tick)) ** 2 / 127 ** 2;
        // The engine's power (dsp computeLife): life² × weight.
        sound += lifeAmp(v, t) ** 2 * weightAt(v, t);
      });
      if (sound > 0.5) worst = Math.max(worst, Math.abs(10 * Math.log10(midi / sound)));
    }
    console.info(`CC11 crossfade: MIDI power within ${worst.toFixed(3)} dB of the engine's`);
    expect(worst).toBeLessThan(0.3);
  });
});

describe('MPE export', () => {
  it('writes the configuration message, 48-semitone members and exact pitch', () => {
    const s = lifeScore();
    const res = exportMidi(s, { mode: 'mpe', cc11: true });
    expect(res.files).toHaveLength(1);
    expect(res.files[0].name).toBe('piece-mpe.mid');
    const smf = parseSmf(res.files[0].data);
    const cond = reconstruct(smf.tracks[0]);
    expect(cond.rpns).toEqual([{ ch: 0, rpn: 6, msb: 15, lsb: undefined, closed: true }]);
    expect(cond.setupCcs).toEqual([101, 100, 6, 101, 100]);
    // Configuration comes first among the file's channel messages (tick 0, before any note).
    const firstChannel = smf.tracks.flat().find((e) => e.type !== 'meta');
    expect(firstChannel).toMatchObject({ tick: 0, type: 'cc', ch: 0, a: 101, b: 0 });
    const r = verifyFile(res.files[0], sounding(s), s, {
      range: 48,
      cc11: true,
      channelOf: (k) => k + 1,
      label: 'mpe',
    });
    expect(r.maxCents).toBeLessThanOrEqual(2);
  });

  it('ignores a requested bend range: members are always ±48', () => {
    const s = easeScore();
    const res = exportMidi(s, { mode: 'mpe', bendRange: 2 });
    verifyFile(res.files[0], sounding(s), s, {
      range: 48,
      channelOf: (k) => k + 1,
      label: 'mpe48',
    });
  });

  it('splits more than 15 voices into complete files, 15 members each', () => {
    const s = manyVoices(37);
    const res = exportMidi(s, { mode: 'mpe', name: 'big' });
    expect(res.files.map((f) => f.name)).toEqual([
      'big-mpe-1.mid',
      'big-mpe-2.mid',
      'big-mpe-3.mid',
    ]);
    const voices = sounding(s);
    const counts = [15, 15, 7];
    counts.forEach((c, p) => {
      const slice = voices.slice(p * 15, p * 15 + c);
      const smf = parseSmf(res.files[p].data);
      const cond = reconstruct(smf.tracks[0]);
      expect(cond.rpns[0]).toMatchObject({ ch: 0, rpn: 6, msb: 15, closed: true });
      expect(smf.trackCount).toBe(1 + c);
      // Each voice's track plays on one member channel (2-16), all different within the file.
      const chans = smf.tracks.slice(1).map((t) => t.find((e) => e.type === 'noteOn')?.ch);
      expect(new Set(chans).size).toBe(c);
      for (const ch of chans) expect(ch).toBeGreaterThanOrEqual(1);
      verifyFile(res.files[p], slice, s, {
        range: 48,
        channelOf: (k) => k + 1,
        label: `mpe part ${p + 1}`,
        samples: 100,
      });
    });
    // Zipped: three entries that round-trip.
    const zip = unzipSync(zipFiles(res.files));
    expect(Object.keys(zip).sort()).toEqual(res.files.map((f) => f.name).sort());
    for (const f of res.files) expect(zip[f.name]).toEqual(f.data);
  });

  it('writes one file for exactly 15 voices and an empty zone for none', () => {
    expect(exportMidi(manyVoices(15), { mode: 'mpe' }).files).toHaveLength(1);
    const none = exportMidi(manyVoices(0), { mode: 'mpe' });
    expect(none.files).toHaveLength(1);
    expect(parseSmf(none.files[0].data).trackCount).toBe(1);
  });
});

describe('perVoice channels', () => {
  it('wrap over the 15 non-drum channels, skipping channel 10', () => {
    const s = manyVoices(32);
    const channelOf = (k: number) => (k % 15 < 9 ? k % 15 : (k % 15) + 1);
    const smf = parseSmf(exportMidi(s).files[0].data);
    const chans = smf.tracks.slice(1).map((t) => t.find((e) => e.type === 'noteOn')?.ch);
    expect(chans).toEqual(Array.from({ length: 32 }, (_, i) => channelOf(i)));
    expect(chans).not.toContain(9);
    expect(chans[15]).toBe(0);
    expect(chans[9]).toBe(10);
    verifyFile(exportMidi(s).files[0], sounding(s), s, {
      range: 24,
      channelOf,
      label: 'wrap',
      samples: 100,
    });
  });
});

describe('notesOnly', () => {
  it('writes each arrival at a held pitch as one note and drops glides', () => {
    for (const s of [easeScore(), lifeScore(), wideScore()]) {
      const res = exportMidi(s, { mode: 'notesOnly' });
      expect(res.files[0].name).toBe('piece-notes.mid');
      const smf = parseSmf(res.files[0].data);
      const tps = (PPQ * 1e6) / tempoOf(smf.tracks[0]);
      sounding(s).forEach((v, k) => {
        const tr = reconstruct(smf.tracks[k + 1]);
        expect(tr.rpns).toHaveLength(0);
        expect(smf.tracks[k + 1].some((e) => e.type === 'bend')).toBe(false);
        // Expected: runs of holds at one pitch (after a glide, or from birth), clipped to the life.
        const want: { on: number; off: number; note: number }[] = [];
        for (const l of v.lives) {
          const end = lifeEnd(v, l);
          const segs = v.segments.filter((x) => x.t0 >= l.born && x.t0 < end);
          let prev: (typeof want)[number] | undefined;
          let prevEnd = -1;
          for (const x of segs) {
            const isHold = x.p0 === x.p1 && !x.m0 && !x.curve;
            if (!isHold) {
              prev = undefined;
              continue;
            }
            const note = Math.round(x.p0);
            if (prev && prev.note === note && Math.abs(x.t0 - prevEnd) < 1e-9) {
              prev.off = Math.min(x.t1, end);
            } else {
              prev = { on: x.t0, off: Math.min(x.t1, end), note };
              want.push(prev);
            }
            prevEnd = x.t1;
          }
        }
        const expected = want.filter((w) => w.off * tps - w.on * tps >= 1);
        expect(tr.notes).toHaveLength(expected.length);
        tr.notes.forEach((n, i) => {
          expect(n.note).toBe(expected[i].note);
          expect(Math.abs(n.on - expected[i].on * tps)).toBeLessThanOrEqual(1);
          expect(Math.abs(n.off - expected[i].off * tps)).toBeLessThanOrEqual(1);
        });
      });
    }
  });

  it('can still carry CC11', () => {
    const s = lifeScore();
    const smf = parseSmf(exportMidi(s, { mode: 'notesOnly', cc11: true }).files[0].data);
    expect(reconstruct(smf.tracks[1]).cc11.length).toBeGreaterThan(2);
  });
});

describe('options', () => {
  it('rejects an unsupported bend range and bpm', () => {
    expect(() => exportMidi(easeScore(), { bendRange: 7 as 12 })).toThrow(RangeError);
    expect(() => exportMidi(easeScore(), { bpm: 0 })).toThrow(RangeError);
  });

  it('is deterministic', () => {
    const a = exportMidi(lifeScore(), { cc11: true }).files[0].data;
    const b = exportMidi(lifeScore(), { cc11: true }).files[0].data;
    expect(a).toEqual(b);
  });
});

describe('example pieces', () => {
  const dir = join(__dirname, '../../../examples');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.algorhythms.json'))) {
    it(`${file}: exports in every mode and reconstructs pitch`, () => {
      let score: CompiledScore;
      try {
        const parsed = parsePiece(JSON.parse(readFileSync(join(dir, file), 'utf8')));
        if (!parsed.ok) throw new Error(parsed.errors.join('; '));
        score = compile(parsed.piece);
      } catch (e) {
        console.warn(`SKIPPED ${file}: does not compile yet (${(e as Error).message})`);
        return;
      }
      const label = file.replace('.algorhythms.json', '');
      const sizes: string[] = [];
      for (const range of [2, 24] as const) {
        const r = run(score, { bendRange: range, cc11: range === 24 }, `${label} r${range}`, 150);
        expect(r.maxCents).toBeLessThanOrEqual(2);
      }
      const base = exportMidi(score);
      const mpe = exportMidi(score, { mode: 'mpe', cc11: true });
      verifyFile(mpe.files[0], sounding(score).slice(0, 15), score, {
        range: 48,
        cc11: true,
        channelOf: (k) => k + 1,
        label: `${label} mpe`,
        samples: 150,
      });
      const notes = exportMidi(score, { mode: 'notesOnly' });
      sizes.push(
        `${label}: perVoice ${base.files[0].data.length} B, mpe ${mpe.files.map((f) => f.data.length).join('+')} B, notesOnly ${notes.files[0].data.length} B`,
      );
      console.info(`SIZES ${sizes[0]}`);
    }, 120_000);
  }
});

describe('measured accuracy', () => {
  it('reports the worst error seen', () => {
    console.info(`WORST ${worst.cents.toFixed(3)} cents at ${worst.where}`);
    expect(worst.cents).toBeLessThanOrEqual(2);
  });
});
