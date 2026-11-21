/**
 * Test fixtures for core/schema.ts: a piece that exercises every moment type, every optional
 * field and every union branch, so "unknown fields at every level" really reaches every level.
 */

import { newPiece } from '../../../src/core/defaults';
import type { Piece } from '../../../src/core/types';

/** A fully specified piece (all defaults already present), touching every schema branch. */
export function fullPiece(): Piece {
  const p = newPiece({ seed: 2611, title: 'Everything', now: '2026-11-19T00:00:00Z' });
  p.meta.author = 'Test';
  p.tuning = { referenceHz: 442, system: { kind: '12tet' } };
  p.defaults.glide.ease = { kind: 'bezier', x1: 0.3, y1: -0.2, x2: 0.7, y2: 1.2 };
  p.voices[0] = { ...p.voices[0], name: 'Lead', color: '#c33', mute: false, solo: true };
  p.voices[1] = { ...p.voices[1], pan: -0.5, gain: 0.8, sends: { reverb: 0.1, delay: 0.3 } };
  p.voices[2] = { ...p.voices[2], timbre: 'mine', range: [40, 70] };
  p.moments = [
    {
      id: 'start0',
      type: 'chord',
      at: 0,
      notes: { kind: 'pitches', pitches: [57, 64.5] },
      voicing: 'even',
      assign: 'ordered',
    },
    {
      id: 'aaaaa1',
      type: 'split',
      at: 2,
      count: 4,
      notes: { kind: 'chord', symbol: 'Am7' },
      voicing: 'even',
      label: 'Open',
      glide: { length: 2, order: 'low-first' },
    },
    {
      id: 'aaaaa2',
      type: 'chord',
      at: 8,
      notes: { kind: 'degrees', degrees: [3, 5, 7, 9] },
      voicing: 'close',
      register: [45, 75],
      assign: 'free',
      target: { rank: [0, 2] },
      seed: 77,
    },
    {
      id: 'aaaaa3',
      type: 'chord',
      at: 12,
      notes: { kind: 'pitches', pitches: [50, 57, 62.5] },
      voicing: 'nearest',
      assign: 'ordered',
      target: { voices: ['v1', 'v2'] },
      glide: { ease: { kind: 'bezier', x1: 0, y1: 0, x2: 0.2, y2: 1 } },
    },
    {
      id: 'aaaaa4',
      type: 'chord',
      at: 14,
      notes: { kind: 'current' },
      voicing: 'even',
      assign: 'ordered',
    },
    { id: 'aaaaa5', type: 'unison', at: 16, pitch: 'tonic', octaves: true, target: 'all' },
    { id: 'aaaaa6', type: 'unison', at: 18, pitch: 60, octaves: false, muted: true },
    { id: 'aaaaa7', type: 'shift', at: 20, by: -2, unit: 'scaleSteps' },
    { id: 'aaaaa8', type: 'spread', at: 22, factor: 1.5, around: 'median', snap: 'chromatic' },
    { id: 'aaaaa9', type: 'spread', at: 23, factor: 0.5, around: 60, snap: 'none' },
    {
      id: 'aaaab1',
      type: 'walk',
      at: 24,
      until: 40,
      grid: 0.5,
      density: 0.4,
      steps: [-1, 1],
      stepGlide: 0.25,
      bass: { leap: [5, 12] },
    },
    { id: 'aaaab2', type: 'pin', at: 30, voice: 'v3', pitch: 72 },
    {
      id: 'aaaab3',
      type: 'key',
      at: 41,
      key: { tonic: 'D', scale: { kind: 'custom', name: 'hira', intervals: [0, 2, 3, 7, 8] } },
    },
    { id: 'aaaab4', type: 'key', at: 42, key: { tonic: 'F#', scale: 'lydian' } },
    { id: 'aaaab5', type: 'level', at: 44, gain: 0.5, over: 3 },
    { id: 'aaaab6', type: 'merge', at: 46, count: 1, which: 'outer', fade: 1.5 },
    { id: 'aaaan1', type: 'note', at: 48, from: 72, to: 74, back: 0.5 },
  ];
  p.timbres.mine = {
    harmonics: [1, 0.5, 0.25],
    stretch: 0.01,
    fm: { ratio: 2, index: 1.5, indexTrack: 0.2 },
    noise: { level: 0.1, bandwidth: 300 },
    brightness: { tilt: -3, track: 0.5 },
    detuneSpread: 2,
    accent: 0.3,
    articulation: { amount: 0.4, attack: 0.01, decay: 0.3 },
    vibrato: { rate: 5, depthCents: 10, delay: 0.4 },
  };
  p.end = { at: 60, fade: 4 };
  p.view = {
    window: 30,
    colors: 'custom',
    hud: false,
    gridBpm: 90,
    futureOpacity: 0.2,
    playheadX: 0.5,
  };
  return p;
}

/**
 * Adds an unknown field to every plain object in `value` (recursively, including objects inside
 * arrays and union members), except the `timbres` record itself, whose keys are preset names.
 * Returns the number of objects touched.
 */
export function injectUnknown(value: unknown, depth = 0, parentKey = ''): number {
  if (Array.isArray(value)) {
    return value.reduce<number>((n, v) => n + injectUnknown(v, depth + 1, parentKey), 0);
  }
  if (value === null || typeof value !== 'object') return 0;
  const obj = value as Record<string, unknown>;
  let n = 0;
  for (const [k, v] of Object.entries(obj)) n += injectUnknown(v, depth + 1, k);
  if (parentKey !== 'timbres') {
    obj[`zFuture${depth}`] = {
      note: `added at depth ${depth}`,
      list: [1, { deep: true }],
      flag: null,
    };
    n++;
  }
  return n;
}
