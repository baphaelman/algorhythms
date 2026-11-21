import { beforeEach, describe, expect, it, vi } from 'vitest';

// The store needs a few browser globals and the audio module; stub them before importing it.
const audio = vi.hoisted(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = globalThis;
  g.document = { title: '', querySelector: () => null };
  g.location = { hash: '', pathname: '/', search: '' };
  g.history = { replaceState: () => undefined };
  // Animation frames run when the test says so (`frames()`), to see the drag coalescing.
  const queue: ((t: number) => void)[] = [];
  g.requestAnimationFrame = (cb: (t: number) => void) => queue.push(cb);
  g.__frames = () => {
    while (queue.length > 0) queue.shift()!(0);
  };
  return { mixes: [] as unknown[] };
});
vi.mock('../../../src/app/audio', () => {
  const ok = () => Promise.resolve({});
  return {
    configureAudio: () => undefined,
    getEngine: () => null,
    loadAudio: ok,
    mixAudio: (mix: unknown) => {
      audio.mixes.push(mix);
      return ok();
    },
    primeAudio: ok,
    resumeAudio: () => undefined,
    swapAudio: ok,
    whenReady: ok,
  };
});

import { DEFAULT_MIX, newPiece } from '../../../src/core/defaults';
import { MixSchema, parsePiece } from '../../../src/core/schema';
import type { MixSettings, Piece } from '../../../src/core/types';
import { undo, useEditor } from '../../../src/app/editor/history';
import {
  DELAY_BEATS,
  DELAY_TIME,
  delayTimeAt,
  formatDelay,
  formatMix,
  isSectionDefault,
  MIX_CONTROLS,
  mixValue,
  resetSection,
  setMixAt,
  setPanAuto,
  type MixSection,
} from '../../../src/app/editor/mix-edit';
import {
  beginTimbreDrag,
  dragTimbre,
  endTimbreDrag,
  positionOf,
  SLIDER_STEPS,
  valueOf,
} from '../../../src/app/editor/timbre-edit';
import { sendOf, setVoiceSend } from '../../../src/app/editor/voices';
import { loadPiece, usePlayer } from '../../../src/app/store';

const frames = (globalThis as unknown as { __frames: () => void }).__frames;
const DEFAULT_JSON = JSON.stringify(DEFAULT_MIX);

const base = (): Piece => newPiece({ seed: 5, poolSize: 3 });
const valid = (p: Piece): void => {
  const r = parsePiece(JSON.parse(JSON.stringify(p)));
  expect(r.ok, r.ok ? '' : r.errors.join('; ')).toBe(true);
};

describe('master sliders', () => {
  it('every range lies inside the schema bounds, at both ends', () => {
    const p = base();
    for (const ctl of MIX_CONTROLS) {
      for (const pos of [0, SLIDER_STEPS / 2, SLIDER_STEPS]) {
        const x = valueOf(ctl, pos);
        expect(x, ctl.id).toBeGreaterThanOrEqual(ctl.min);
        expect(x, ctl.id).toBeLessThanOrEqual(ctl.max);
        const q = setMixAt(ctl.path, x)(p);
        expect(mixValue(q.mix, ctl.path), ctl.id).toBe(x);
        const r = MixSchema.safeParse(q.mix);
        expect(r.success, `${ctl.id} = ${x}`).toBe(true);
        valid(q);
      }
    }
  });

  it('times and frequencies are log; values round-trip as clean numbers', () => {
    for (const id of ['rev-decay', 'dly-time', 'tone-lowpass']) {
      expect(MIX_CONTROLS.find((c) => c.id === id)!.curve, id).toBe('log');
    }
    for (const ctl of MIX_CONTROLS) {
      for (let pos = 0; pos <= SLIDER_STEPS; pos += 37) {
        const x = valueOf(ctl, pos);
        expect(Math.abs(positionOf(ctl, x) - pos), `${ctl.id} @${pos}`).toBeLessThanOrEqual(
          ctl.curve === 'lin' ? SLIDER_STEPS * (ctl.step / (ctl.max - ctl.min)) : 6,
        );
        expect(String(x).length, `${ctl.id} ${x}`).toBeLessThan(9);
      }
      // The defaults show inside their sliders.
      const d = mixValue(DEFAULT_MIX as MixSettings, ctl.path);
      expect(d, ctl.id).toBeGreaterThanOrEqual(ctl.min);
      expect(d, ctl.id).toBeLessThanOrEqual(ctl.max);
    }
  });

  it('a no-op edit is the same piece; an edit shares the other groups', () => {
    const p = base();
    expect(setMixAt(['reverb', 'decay'], p.mix.reverb.decay)(p)).toBe(p);
    const q = setMixAt(['reverb', 'decay'], 5)(p);
    expect(q.mix.reverb.decay).toBe(5);
    expect(q.mix.delay).toBe(p.mix.delay);
    expect(p.mix.reverb.decay).toBe(DEFAULT_MIX.reverb.decay);
    expect(setPanAuto('index')(p)).toBe(p);
    expect(setPanAuto('pitch')(p).mix.panAuto).toBe('pitch');
  });

  it('formats Hz as kHz and the delay in beats with a tempo', () => {
    const lp = MIX_CONTROLS.find((c) => c.id === 'tone-lowpass')!;
    expect(formatMix(lp, 20000)).toBe('20 kHz');
    expect(formatMix(lp, 440)).toBe('440 Hz');
    expect(formatDelay(0.375, {})).toBe('0.375 s');
    expect(formatDelay(0.45, { gridBpm: 100 })).toBe('dotted 1/8 · 0.75 beats · 0.45 s');
    expect(formatDelay(0.6, { gridBpm: 100 })).toBe('1/4 · 1 beat · 0.6 s');
    expect(formatDelay(0.5, { gridBpm: 100 })).toBe('0.83 beats · 0.5 s');
  });
});

describe('delay time snapped to beats', () => {
  const at = (t: number): number => positionOf(DELAY_TIME, t);

  it('snaps to the nearest note value with Snap to beats, free with Alt or without a tempo', () => {
    const view = { gridBpm: 100 };
    // 100 bpm: a beat is 0.6 s.
    expect(delayTimeAt(at(0.31), view)).toBe(0.3);
    expect(delayTimeAt(at(0.42), view)).toBe(0.45);
    expect(delayTimeAt(at(0.85), view)).toBe(0.9);
    expect(delayTimeAt(at(2), view)).toBe(1.2);
    expect(delayTimeAt(at(0.02), view)).toBe(0.15);
    expect(delayTimeAt(at(0.42), view, true)).toBeCloseTo(0.42, 2);
    expect(delayTimeAt(at(0.42), { gridBpm: 100, snapBeats: false })).toBeCloseTo(0.42, 2);
    expect(delayTimeAt(at(0.42), {})).toBeCloseTo(0.42, 2);
    // Every snapped value is one of the note values, inside the range.
    for (let pos = 0; pos <= SLIDER_STEPS; pos += 50) {
      const t = delayTimeAt(pos, { gridBpm: 72 });
      expect(DELAY_BEATS.some((d) => Math.abs((d.beats * 60) / 72 - t) < 1e-6)).toBe(true);
    }
  });

  it('skips note values outside the range (slow tempo: a half note > 2 s)', () => {
    // 40 bpm: a beat is 1.5 s; 1.5 and 2 beats exceed 2 s.
    expect(delayTimeAt(SLIDER_STEPS, { gridBpm: 40 })).toBe(1.5);
  });
});

describe('reset', () => {
  it('puts one section back to defaultMix(), leaving the others', () => {
    let p = base();
    p = setMixAt(['reverb', 'decay'], 9)(p);
    p = setMixAt(['delay', 'feedback'], 0.6)(p);
    p = setPanAuto('pitch')(p);
    p = setMixAt(['sends', 'delay'], 0.8)(p);
    const sections: MixSection[] = ['reverb', 'delay', 'sends', 'tone'];
    expect(sections.map((s) => isSectionDefault(p.mix, s))).toEqual([false, false, false, true]);
    expect(resetSection('tone')(p)).toBe(p);
    const r = resetSection('reverb')(p);
    expect(r.mix.reverb).toEqual(DEFAULT_MIX.reverb);
    expect(r.mix.delay.feedback).toBe(0.6);
    const s = resetSection('sends')(r);
    expect(s.mix.sends).toEqual(DEFAULT_MIX.sends);
    expect(s.mix.panAuto).toBe(DEFAULT_MIX.panAuto);
    // The reset copy is fresh: editing it later never touches the frozen default.
    expect(s.mix.reverb).not.toBe(DEFAULT_MIX.reverb);
    expect(JSON.stringify(DEFAULT_MIX)).toBe(DEFAULT_JSON);
    valid(s);
  });
});

describe('per-note sends', () => {
  it('a note overrides the master send and goes back to it', () => {
    const p = base();
    const v = p.voices[0];
    expect(sendOf(p, v, 'reverb')).toBe(DEFAULT_MIX.sends.reverb);
    expect(setVoiceSend(p, v.id, 'reverb', undefined)).toBe(p);
    const q = setVoiceSend(p, v.id, 'reverb', 0.2);
    expect(q.voices[0].sends).toEqual({ reverb: 0.2 });
    expect(sendOf(q, q.voices[0], 'reverb')).toBe(0.2);
    expect(sendOf(q, q.voices[0], 'delay')).toBe(DEFAULT_MIX.sends.delay);
    expect(q.voices[1]).toBe(p.voices[1]);
    valid(q);
    const back = setVoiceSend(q, v.id, 'reverb', undefined);
    expect(back.voices[0].sends).toBeUndefined();
    expect(back.voices[0]).toEqual(v);
  });
});

describe('a master drag is one undo entry, heard live', () => {
  beforeEach(() => {
    loadPiece(base());
    frames();
    audio.mixes.length = 0;
  });

  it('coalesces updates to one per frame, sends each to the engine, records one entry', () => {
    const start = usePlayer.getState().piece;
    let applied = 0;
    const unsub = usePlayer.subscribe((s, prev) => {
      if (s.piece !== prev.piece) applied++;
    });
    beginTimbreDrag('Reverb decay');
    for (const x of [4, 5, 6]) dragTimbre(setMixAt(['reverb', 'decay'], x));
    frames();
    expect(applied).toBe(1);
    expect(usePlayer.getState().piece.mix.reverb.decay).toBe(6);
    expect(audio.mixes).toHaveLength(1);
    expect((audio.mixes[0] as MixSettings).reverb.decay).toBe(6);
    dragTimbre(setMixAt(['reverb', 'decay'], 7.5));
    endTimbreDrag();
    unsub();
    expect(usePlayer.getState().piece.mix.reverb.decay).toBe(7.5);
    expect(audio.mixes).toHaveLength(2);
    expect(useEditor.getState().undoLabel).toBe('Reverb decay');
    expect(undo()).toBe(true);
    expect(usePlayer.getState().piece.mix).toEqual(start.mix);
    // Undo reaches the engine too.
    expect((audio.mixes.at(-1) as MixSettings).reverb.decay).toBe(DEFAULT_MIX.reverb.decay);
    expect(useEditor.getState().canUndo).toBe(false);
  });
});
