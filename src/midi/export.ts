/**
 * MIDI export (PLAN.md §12): Type-1 Standard MIDI Files from a compiled score, in three modes.
 *
 * - `perVoice` (default): one track and one channel per voice that ever sounds (channels wrap over the 15
 *   non-drum channels, skipping channel 10), each opening with RPN 0 (bend range). Notes sound at birth on the rounded pitch, with
 *   pitch bend only during glides.
 * - `mpe`: the same, laid out as MPE lower zones: channel 1 is the manager, channels 2-16 carry
 *   one voice each at ±48, and every 15 voices start a further complete file.
 * - `notesOnly`: each arrival at a held pitch becomes a note; glides are dropped.
 *
 * Time is exact: 960 ticks per quarter note, 1 quarter = 60/bpm seconds (60 bpm by default, so
 * 1 beat = 1 s), with the tempo meta event written to match. Pitch is read through core's
 * `evalSegment` (P1), never recomputed by hand.
 */

import { zipSync } from 'fflate';
import { crossfade } from '../core/ease';
import { pulseGainAt } from '../core/pulse';
import { segmentIndexAt, weightAt, weightTargetAt } from '../core/query';
import { evalSegment } from '../core/segment';
import type { CompiledScore, CompiledVoice, Life, Segment } from '../core/types';
import { SmfTrack, writeSmf } from './smf';

/** Ticks per quarter note. */
export const PPQ = 960;
/** Pitch-bend ranges offered to the user, in semitones either way. */
export const BEND_RANGES = [2, 12, 24, 48] as const;
export type BendRange = (typeof BEND_RANGES)[number];
export type MidiMode = 'perVoice' | 'mpe' | 'notesOnly';

export interface MidiExportOptions {
  /** Layout; default 'perVoice'. */
  mode?: MidiMode;
  /** Bend range for 'perVoice' (and 'notesOnly', which writes no bends); default 24. 'mpe' is always 48. */
  bendRange?: BendRange;
  /** Tempo; default 60, so one beat is one second. */
  bpm?: number;
  /** End the note and strike it again on every arrival at a held pitch (plucked sounds). Default false. */
  restrikeOnArrival?: boolean;
  /**
   * Write life, level, pulse and weight gain as CC11, as the sound engine plays them (life fades,
   * crossfades, pulse envelopes); notes then strike at their life's peak weight. Default false.
   */
  cc11?: boolean;
  /**
   * Note-on velocity of a weight-1 line, 1..127; default 100. A line of weight w strikes at
   * √w times this (revision 8), all scaled down together if the heaviest would pass 127.
   */
  velocity?: number;
  /** Minimum pitch-bend events per second of a glide; default 250 (never below 200). */
  bendRate?: number;
  /** File name stem; default 'piece'. */
  name?: string;
  /** Name of the first (tempo) track; default 'AlgoRhythms'. */
  title?: string;
  /** Shift pitches by 12·log2(referenceHz / 440) so a non-440 tuning still sounds right (default true; bends only). */
  applyReferenceTuning?: boolean;
}

export interface MidiFile {
  name: string;
  data: Uint8Array;
}

export interface MidiExportResult {
  /** One file, or several for MPE with more than 15 voices (zip them with `zipFiles`). */
  files: MidiFile[];
}

/** MPE lower zone: member channels 2-16, so 15 voices per file. */
export const MPE_MEMBERS = 15;
/** Life fades are never shorter than this (the sound engine's floor). */
const MIN_LIFE_FADE = 0.005;
/** Linear-interpolation error allowed between bend events, in semitones (0.5 cent). */
const BEND_TOLERANCE = 0.005;
const BEND_CENTER = 8192;
const BEND_MAX = 16383;

// Event kinds in the per-track lists.
const OFF = 0;
const ON = 1;
const BEND = 2;
const CC = 3;
interface Ev {
  tick: number;
  kind: number;
  a: number;
  b: number;
}

/** Smootherstep, the shape of life fades. */
function smootherstep(x: number): number {
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function moving(s: Segment): boolean {
  return s.p0 !== s.p1 || (s.m0 ?? 0) !== 0 || s.curve !== undefined;
}

function clampNote(n: number): number {
  return n < 0 ? 0 : n > 127 ? 127 : n;
}

/** 14-bit bend value for an offset in semitones. */
export function bendValue(offset: number, range: number): number {
  const v = BEND_CENTER + Math.round((offset / range) * BEND_CENTER);
  return v < 0 ? 0 : v > BEND_MAX ? BEND_MAX : v;
}

interface Timing {
  /** Ticks per second, from the integer tempo actually written. */
  tps: number;
  micros: number;
}

function timing(bpm: number): Timing {
  if (!(bpm > 0) || !Number.isFinite(bpm)) throw new RangeError(`bad bpm ${bpm}`);
  const micros = Math.round(60e6 / bpm);
  if (micros < 1 || micros > 0xffffff) throw new RangeError(`bpm ${bpm} is out of range`);
  return { tps: (PPQ * 1e6) / micros, micros };
}

/** End of a life in seconds: its death, or the end of its last segment. */
function lifeEnd(voice: CompiledVoice, life: Life): number {
  if (life.died !== undefined) return life.died;
  let end = life.born;
  for (const s of voice.segments) if (s.t0 >= life.born && s.t1 > end) end = s.t1;
  return end;
}

/** Segments belonging to a life, in order. */
function lifeSegments(voice: CompiledVoice, life: Life, end: number): Segment[] {
  const out: Segment[] = [];
  const first = Math.max(0, segmentIndexAt(voice, life.born));
  for (let i = first; i < voice.segments.length; i++) {
    const s = voice.segments[i];
    if (s.t0 >= end && out.length > 0) break;
    if (s.t1 < life.born || s.t0 >= end) continue;
    out.push(s);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Pitch events: notes and bends
// ---------------------------------------------------------------------------------------------

interface PitchCtx {
  tps: number;
  range: number;
  shift: number;
  /** Note-on velocity of `voice` for a note starting at t seconds. */
  velocity: (voice: CompiledVoice, t: number) => number;
  bendRate: number;
  restrike: boolean;
}

/** Notes and bends for one voice, in tick order. */
function pitchEvents(voice: CompiledVoice, c: PitchCtx): Ev[] {
  const ev: Ev[] = [];
  const limit = (c.range * (BEND_CENTER - 1)) / BEND_CENTER;
  const maxStep = Math.max(1, Math.floor(c.tps / Math.max(200, c.bendRate)));
  const tk = (t: number): number => Math.round(t * c.tps);
  // Pitch at a tick of the life being written: the time is clamped into the life so that rounding
  // to a tick can never read a neighbouring life's segment.
  let lifeBorn = 0;
  let lifeStop = 0;
  let lastSeg: Segment = voice.segments[0];
  const pitchAtTick = (tick: number): number => {
    const t = Math.max(tick / c.tps, lifeBorn);
    if (t >= lifeStop) return evalSegment(lastSeg, lastSeg.t1) + c.shift;
    return evalSegment(voice.segments[Math.max(0, segmentIndexAt(voice, t))], t) + c.shift;
  };

  let note = -1;
  let curBend = BEND_CENTER;
  let pinned = false; // the note number hit 0 or 127, so the bend range cannot be honoured by re-striking
  const bend = (tick: number, offset: number, force = false): void => {
    const v = bendValue(offset, c.range);
    const last = ev[ev.length - 1];
    if (!force && last && last.kind === BEND && last.tick === tick && last.a === v) return;
    ev.push({ tick, kind: BEND, a: v, b: 0 });
    curBend = v;
  };
  const startNote = (tick: number, p: number): void => {
    const rounded = Math.round(p);
    note = clampNote(rounded);
    pinned = note !== rounded;
    bend(tick, p - note, true); // bend first, then the note, at the same tick
    ev.push({ tick, kind: ON, a: note, b: c.velocity(voice, Math.max(tick / c.tps, lifeBorn)) });
  };
  const endNote = (tick: number): void => {
    ev.push({ tick, kind: OFF, a: note, b: 0 });
    note = -1;
  };
  const inRange = (p: number): boolean => pinned || Math.abs(p - note) <= limit;
  const point = (tick: number, p: number): void => {
    if (inRange(p)) bend(tick, p - note);
    else {
      endNote(tick);
      startNote(tick, p);
    }
  };

  /** Advance from tick a (already written, pitch pa) to tick b (pitch pb), re-striking if the bend range runs out. */
  const link = (a: number, b: number, pb: number): void => {
    let from = a;
    let lastStrike = -1;
    for (;;) {
      if (inRange(pb)) {
        bend(b, pb - note);
        return;
      }
      // The last tick the current note can still reach: re-strike there, seamlessly.
      let lo = from;
      let hi = b;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (inRange(pitchAtTick(mid))) lo = mid;
        else hi = mid;
      }
      if (lo === lastStrike) {
        // A jump too wide for any note: strike at its end.
        endNote(b);
        startNote(b, pb);
        return;
      }
      const pl = pitchAtTick(lo);
      bend(lo, pl - note);
      endNote(lo);
      startNote(lo, pl);
      lastStrike = lo;
      from = lo;
    }
  };

  const sample = (a: number, pa: number, b: number, pb: number): void => {
    if (b - a >= 2) {
      const m = (a + b) >> 1;
      const pm = pitchAtTick(m);
      if (b - a > maxStep || Math.abs(pm - (pa + pb) / 2) > BEND_TOLERANCE) {
        sample(a, pa, m, pm);
        sample(m, pm, b, pb);
        return;
      }
    }
    link(a, b, pb);
  };

  for (const life of voice.lives) {
    const end = lifeEnd(voice, life);
    const t0 = tk(life.born);
    const t1 = tk(end);
    if (t1 <= t0) continue;
    const segs = lifeSegments(voice, life, end);
    if (segs.length === 0) continue;
    lifeBorn = life.born;
    lifeStop = end;
    lastSeg = segs[segs.length - 1];
    startNote(t0, pitchAtTick(t0));
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const ta = Math.min(t1, Math.max(t0, tk(s.t0)));
      const tb = Math.min(t1, Math.max(ta, tk(s.t1)));
      // A tick that is a segment's own boundary reads the exact boundary pitch, so holds are exact
      // and a glide's end never lands a fraction of a tick short of its target.
      const pa = ta === tk(s.t0) ? evalSegment(s, s.t0) + c.shift : pitchAtTick(ta);
      // A hold needs a bend event only if its pitch differs from the bend in force.
      if (moving(s) || !inRange(pa) || bendValue(pa - note, c.range) !== curBend) point(ta, pa);
      if (!moving(s) || tb <= ta) continue;
      const pb = tb === tk(s.t1) ? evalSegment(s, s.t1) + c.shift : pitchAtTick(tb);
      sample(ta, pa, tb, pb);
      const next = segs[i + 1];
      if (c.restrike && next && !moving(next) && tb < t1) {
        endNote(tb);
        startNote(tb, pb);
      }
    }
    endNote(t1);
  }
  return ev;
}

// ---------------------------------------------------------------------------------------------
// Notes-only
// ---------------------------------------------------------------------------------------------

/** One note per arrival at a held pitch, with no bends. */
function noteOnlyEvents(voice: CompiledVoice, c: PitchCtx): Ev[] {
  const ev: Ev[] = [];
  const tk = (t: number): number => Math.round(t * c.tps);
  for (const life of voice.lives) {
    const end = lifeEnd(voice, life);
    const tEnd = tk(end);
    const segs = lifeSegments(voice, life, end);
    let i = 0;
    while (i < segs.length) {
      if (moving(segs[i])) {
        i++;
        continue;
      }
      // A run of holds at one pitch is one arrival.
      const first = segs[i];
      let last = first;
      i++;
      while (
        i < segs.length &&
        !moving(segs[i]) &&
        Math.abs(segs[i].p0 - first.p0) < 1e-9 &&
        segs[i].t0 - last.t1 < 1e-9
      ) {
        last = segs[i];
        i++;
      }
      const on = tk(first.t0);
      const off = Math.min(tk(last.t1), tEnd);
      if (off <= on) continue;
      const n = clampNote(Math.round(first.p0));
      ev.push({ tick: on, kind: ON, a: n, b: c.velocity(voice, first.t0) });
      ev.push({ tick: off, kind: OFF, a: n, b: 0 });
    }
  }
  return ev;
}

// ---------------------------------------------------------------------------------------------
// Velocity: line weight
// ---------------------------------------------------------------------------------------------

/** Largest weight anywhere in the score, at least 1. */
function weightPeak(score: CompiledScore): number {
  let peak = 1;
  for (const v of score.voices) for (const c of v.weight ?? []) if (c.w > peak) peak = c.w;
  return peak;
}

/**
 * Note-on velocity by line weight (revision 8, integrator: velocity follows √weight): `base`·√w at
 * the weight the note settles on, where a weight-1 line strikes at `base`. If the heaviest line in
 * the score would pass 127, every velocity scales down by the same factor, so ratios hold. 1..127.
 */
export function weightVelocity(
  score: CompiledScore,
  base: number,
  slack = 0,
): (voice: CompiledVoice, t: number) => number {
  const scale = Math.min(1, 127 / (base * Math.sqrt(weightPeak(score))));
  // `slack` (half a tick): a note-on rounded to a tick a hair before the join that sets it.
  return (voice, t) => {
    if (!voice.weight || voice.weight.length === 0) return Math.max(1, Math.round(base * scale));
    const w = weightTargetAt(voice, t + slack);
    return Math.max(1, Math.min(127, Math.round(base * scale * Math.sqrt(w))));
  };
}

/**
 * With CC11 (R9-3b): every note of a life strikes at the velocity of the heaviest weight the life
 * reaches (`lifeWeightPeak`), scaled as `weightVelocity`; CC11 carries the rest.
 */
export function peakVelocity(
  score: CompiledScore,
  base: number,
): (voice: CompiledVoice, t: number) => number {
  const scale = Math.min(1, 127 / (base * Math.sqrt(weightPeak(score))));
  return (voice, t) => {
    let w = 1;
    if (voice.weight && voice.weight.length > 0) {
      const life =
        voice.lives.find((l) => t >= l.born && t < (l.died ?? Infinity)) ??
        voice.lives.find((l) => t < l.born);
      if (life) w = lifeWeightPeak(voice, life, lifeEnd(voice, life));
    }
    return Math.max(1, Math.min(127, Math.round(base * scale * Math.sqrt(w))));
  };
}

// ---------------------------------------------------------------------------------------------
// CC11: life, level, pulse and weight gain
// ---------------------------------------------------------------------------------------------

/**
 * CC11 sparsity (R9-3b). A new value is written when it differs from the one in force by at
 * least CC_STEP (2 of 127: under 1.6 % of full scale, about 0.14 dB at full level), at most once
 * per CC_MIN_GAP (5 ms: 200 events per second, the rate PLAN §12 already asks of glide bends).
 * Jumps (pulse records) are written on their tick whatever the gap, and once a change has
 * settled (after its span) the exact value is written. So the value in force is within 1.5 steps
 * of the engine's gain plus at most 5 ms of lag on the steepest decays, at about a third of the
 * events of writing every 7-bit change.
 */
const CC_STEP = 2;
const CC_MIN_GAP = 0.005;

/**
 * Life weight as the sound engine plays it (dsp/voice.ts `computeLife`): smootherstep fades, and
 * for a merge's or split's crossfade (`crossIn`/`crossOut`) √X over the whole window, so the
 * fading line's power follows core/ease `crossfade` while the merged line's weight rises.
 */
function lifeWeight(life: Life, t: number): number {
  const end = life.died ?? Infinity;
  if (t < life.born || t >= end) return 0;
  let w = 1;
  const u = (t - life.born) / Math.max(life.fadeIn, MIN_LIFE_FADE);
  if (u < 1) w = life.crossIn ? Math.sqrt(crossfade(u)) : smootherstep(u);
  const v = (end - t) / Math.max(life.fadeOut ?? 0, MIN_LIFE_FADE);
  if (v < 1) w *= life.crossOut ? Math.sqrt(crossfade(v)) : smootherstep(v);
  return w;
}

/**
 * The heaviest weight a life reaches (≥ its weight at birth). With CC11 a note strikes at this
 * weight's velocity and CC11 carries √(w(t) / this), so a merged line swells and a split's parent
 * thins with the crossfade (velocity cannot change while a note sounds).
 */
function lifeWeightPeak(voice: CompiledVoice, life: Life, end: number): number {
  let w = weightTargetAt(voice, life.born);
  for (const c of voice.weight ?? []) if (c.t >= life.born && c.t <= end && c.w > w) w = c.w;
  return w;
}

/** The voice's level timeline as a function: linear ramps in amplitude, 1 before the first entry. */
function levelFn(voice: CompiledVoice): (t: number) => number {
  const L = voice.level;
  const start: number[] = [];
  for (let i = 0; i < L.length; i++) {
    if (i === 0) {
      start.push(1);
      continue;
    }
    const p = L[i - 1];
    const u = p.over > 0 ? (L[i].t - p.t) / p.over : 1;
    start.push(start[i - 1] + (p.gain - start[i - 1]) * (u >= 1 ? 1 : u));
  }
  return (t) => {
    let lo = 0;
    let hi = L.length - 1;
    let k = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (L[mid].t <= t) {
        k = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (k < 0) return 1;
    const u = L[k].over > 0 ? (t - L[k].t) / L[k].over : 1;
    return u >= 1 ? L[k].gain : start[k] + (L[k].gain - start[k]) * u;
  };
}

/** Largest level gain anywhere in the score, at least 1: CC11 127 means this much gain. */
function gainPeak(score: CompiledScore): number {
  let peak = 1;
  for (const v of score.voices) for (const l of v.level) if (l.gain > peak) peak = l.gain;
  return peak;
}

/**
 * CC11 events where the gain changes (value = 127·gain/peak, linear in gain, `peak` the
 * score-wide maximum level ≥ 1 so a boost above 1 does not clip), thinned as CC_STEP and
 * CC_MIN_GAP describe.
 */
function gainEvents(voice: CompiledVoice, tps: number, peak: number): Ev[] {
  const level = levelFn(voice);
  const peaks = voice.lives.map((l) => lifeWeightPeak(voice, l, lifeEnd(voice, l)));
  const weighted = (voice.weight?.length ?? 0) > 0;
  const gainAt = (tick: number): number => {
    const t = tick / tps;
    for (let i = 0; i < voice.lives.length; i++) {
      const life = voice.lives[i];
      if (t < life.born || t >= (life.died ?? Infinity)) continue;
      let w = weighted ? weightAt(voice, t) / peaks[i] : 1;
      w = w > 1 ? 1 : w > 0 ? w : 0;
      return lifeWeight(life, t) * level(t) * pulseGainAt(voice, t) * Math.sqrt(w);
    }
    return 0;
  };
  const q = (g: number): number => Math.max(0, Math.min(127, Math.round((g / peak) * 127)));
  const tk = (t: number): number => Math.round(t * tps);
  const gap = Math.max(1, Math.round(CC_MIN_GAP * tps));

  // Tick spans where gain can change: fades, level and weight ramps inside a life, and pulse
  // decays; and the ticks where it jumps (pulse records).
  const spans: [number, number][] = [];
  const jumps = new Set<number>();
  for (const life of voice.lives) {
    const end = lifeEnd(voice, life);
    const a = life.born;
    spans.push([tk(a), tk(a + Math.max(life.fadeIn, MIN_LIFE_FADE))]);
    if (life.died !== undefined) {
      spans.push([tk(end - Math.max(life.fadeOut ?? 0, MIN_LIFE_FADE)), tk(end)]);
    }
    for (const l of voice.level) {
      if (l.t + l.over < a || l.t > end) continue;
      spans.push([tk(Math.max(l.t, a)), tk(Math.min(l.t + l.over, end))]);
    }
    for (const c of voice.weight ?? []) {
      const t0 = c.t - (c.lead ?? 0);
      if (t0 + c.over < a || t0 > end) continue;
      spans.push([tk(Math.max(t0, a)), tk(Math.min(t0 + c.over, end))]);
    }
  }
  for (const r of voice.pulse ?? []) {
    jumps.add(tk(r.t));
    spans.push([tk(r.t), tk(r.t + r.decay)]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  // Disjoint runs, each followed by a settling stretch where any change is written exactly.
  const runs: [number, number][] = [];
  for (const s of spans) {
    const last = runs[runs.length - 1];
    if (last && s[0] <= last[1] + 1) last[1] = Math.max(last[1], s[1]);
    else runs.push([s[0], s[1]]);
  }

  const ev: Ev[] = [];
  let cur = q(gainAt(0));
  ev.push({ tick: 0, kind: CC, a: 11, b: cur });
  let lastTick = 0;
  for (let r = 0; r < runs.length; r++) {
    const [from, to] = runs[r];
    const stop = Math.min(to + gap, r + 1 < runs.length ? runs[r + 1][0] - 1 : Infinity);
    for (let tick = from; tick <= stop; tick++) {
      const v = q(gainAt(tick));
      if (v === cur) continue;
      const free = tick - lastTick >= gap;
      if (!jumps.has(tick) && !(free && (Math.abs(v - cur) >= CC_STEP || tick > to))) continue;
      ev.push({ tick, kind: CC, a: 11, b: v });
      cur = v;
      lastTick = tick;
    }
  }
  return ev;
}

/** Merges two tick-ordered lists; at equal ticks a CC goes before a note-on, after everything else. */
function merge(pitch: Ev[], cc: Ev[]): Ev[] {
  if (cc.length === 0) return pitch;
  const out: Ev[] = [];
  let i = 0;
  let j = 0;
  while (i < pitch.length || j < cc.length) {
    if (j >= cc.length) out.push(pitch[i++]);
    else if (i >= pitch.length) out.push(cc[j++]);
    else if (cc[j].tick < pitch[i].tick || (cc[j].tick === pitch[i].tick && pitch[i].kind === ON)) {
      out.push(cc[j++]);
    } else out.push(pitch[i++]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

/** RPN select, data entry and RPN null, as a well-formed sequence. */
function writeRpn(
  track: SmfTrack,
  ch: number,
  rpn: number,
  msb: number,
  lsb: number | undefined,
): void {
  track.controlChange(0, ch, 101, 0);
  track.controlChange(0, ch, 100, rpn);
  track.controlChange(0, ch, 6, msb);
  if (lsb !== undefined) track.controlChange(0, ch, 38, lsb);
  track.controlChange(0, ch, 101, 127);
  track.controlChange(0, ch, 100, 127);
}

function writeEvents(track: SmfTrack, ch: number, events: Ev[]): void {
  for (const e of events) {
    if (e.kind === ON) track.noteOn(e.tick, ch, e.a, e.b);
    else if (e.kind === OFF) track.noteOff(e.tick, ch, e.a);
    else if (e.kind === BEND) track.pitchBend(e.tick, ch, e.a);
    else track.controlChange(e.tick, ch, e.a, e.b);
  }
}

interface FileSpec {
  voices: CompiledVoice[];
  /** Channel (0-15) for the k-th voice of the file. */
  channel: (k: number) => number;
  mpe: boolean;
}

function buildFile(
  spec: FileSpec,
  score: CompiledScore,
  o: Required<Omit<MidiExportOptions, 'name' | 'mode' | 'bendRange'>> & {
    range: number;
    notesOnly: boolean;
  },
): Uint8Array {
  const { tps, micros } = timing(o.bpm);
  const endTick = Math.round(score.duration * tps);
  const shift = o.applyReferenceTuning ? 12 * Math.log2(score.referenceHz / 440) : 0;
  const ctx: PitchCtx = {
    tps,
    range: o.range,
    shift: o.notesOnly ? 0 : shift,
    velocity: o.cc11
      ? peakVelocity(score, o.velocity)
      : weightVelocity(score, o.velocity, 0.5 / tps),
    bendRate: o.bendRate,
    restrike: o.restrikeOnArrival,
  };

  const peak = gainPeak(score);
  const conductor = new SmfTrack();
  conductor.name(0, o.title);
  conductor.tempo(0, micros);
  if (spec.mpe) writeRpn(conductor, 0, 6, MPE_MEMBERS, undefined);

  const chunks: Uint8Array[] = [];
  const tracks: SmfTrack[] = [];
  let last = endTick;
  const events = spec.voices.map((v) => {
    const pitch = o.notesOnly ? noteOnlyEvents(v, ctx) : pitchEvents(v, ctx);
    const all = o.cc11 ? merge(pitch, gainEvents(v, tps, peak)) : pitch;
    if (all.length > 0) last = Math.max(last, all[all.length - 1].tick);
    return all;
  });
  spec.voices.forEach((v, k) => {
    const track = new SmfTrack();
    const ch = spec.channel(k);
    track.name(0, v.id);
    if (!o.notesOnly) writeRpn(track, ch, 0, o.range, 0);
    writeEvents(track, ch, events[k]);
    tracks.push(track);
  });
  chunks.push(conductor.finish(last), ...tracks.map((t) => t.finish(last)));
  return writeSmf(PPQ, chunks);
}

/** Builds MIDI files from a compiled score. */
export function exportMidi(score: CompiledScore, opts: MidiExportOptions = {}): MidiExportResult {
  const mode = opts.mode ?? 'perVoice';
  const range = mode === 'mpe' ? 48 : (opts.bendRange ?? 24);
  if (!(BEND_RANGES as readonly number[]).includes(range)) {
    throw new RangeError(`bend range must be one of ${BEND_RANGES.join(', ')}`);
  }
  const o = {
    bpm: opts.bpm ?? 60,
    restrikeOnArrival: opts.restrikeOnArrival ?? false,
    cc11: opts.cc11 ?? false,
    velocity: Math.max(1, Math.min(127, Math.round(opts.velocity ?? 100))),
    bendRate: opts.bendRate ?? 250,
    title: opts.title ?? 'AlgoRhythms',
    applyReferenceTuning: opts.applyReferenceTuning ?? true,
    range,
    notesOnly: mode === 'notesOnly',
  };
  const base = opts.name ?? 'piece';
  const sounding = score.voices.filter((v) => v.lives.length > 0 && v.segments.length > 0);

  if (mode !== 'mpe') {
    const data = buildFile(
      { voices: sounding, channel: (k) => (k % 15 < 9 ? k % 15 : (k % 15) + 1), mpe: false },
      score,
      o,
    );
    return { files: [{ name: `${base}${mode === 'notesOnly' ? '-notes' : ''}.mid`, data }] };
  }
  const parts = Math.max(1, Math.ceil(sounding.length / MPE_MEMBERS));
  const files: MidiFile[] = [];
  for (let p = 0; p < parts; p++) {
    const voices = sounding.slice(p * MPE_MEMBERS, (p + 1) * MPE_MEMBERS);
    const data = buildFile({ voices, channel: (k) => k + 1, mpe: true }, score, o);
    files.push({ name: parts === 1 ? `${base}-mpe.mid` : `${base}-mpe-${p + 1}.mid`, data });
  }
  return { files };
}

/** Zips files without compression (MIDI is small; stored zips open everywhere). */
export function zipFiles(files: MidiFile[]): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const f of files) entries[f.name] = f.data;
  return zipSync(entries, { level: 0 });
}
