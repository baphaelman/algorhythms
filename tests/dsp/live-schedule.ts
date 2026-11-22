/**
 * The live session the no-GC harness replays ('live' mode, tests/dsp/node/gc-harness.ts): the
 * main thread's decisions (LiveRig) over 96 s of 24 voices, written as JSON. A key change every
 * 4–34 blocks (chords, unisons, `exact` and `range`, releases with hold, fade and tonic, sustain,
 * a 30 ms stagger) and bends; changes ≤ 15 ms apart re-plan their press (the rewind path); the first 30 s (in the harness's 35 s warm-up) change every 2 blocks, so
 * every apply path (compaction included) is optimised before the measured minute.
 */

import { writeFileSync } from 'node:fs';
import { mergeLiveSettings } from '../../src/core/live';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import { Prng } from '../../src/dsp/rng';
import { FIXTURE_MIX } from '../../src/audio/fixtures/scores';
import { LiveRig, liveSetupOf } from '../../src/audio/fixtures/live-rig';
import { liveScore } from '../../src/audio/live-setup';

const RATE = 48000;

interface Message {
  block: number;
  seq: number;
  moves: number[];
  n: number;
  gain: number | null;
  over: number;
  /** The press it re-plans (rewinding to its first change), or 0. */
  press: number;
}

/** Writes the session to `file`; returns its message and bend counts. */
export function writeLiveSchedule(file: string): {
  messages: number;
  bends: number;
  presses: number;
} {
  const setup = liveSetupOf(24, 'glass', [36, 84], 60, FIXTURE_MIX);
  const total = Math.round((96 * RATE) / BLOCK_FRAMES);
  const warmBlocks = Math.round((35 * RATE) / BLOCK_FRAMES);
  const fast = Math.round((30 * RATE) / BLOCK_FRAMES);
  const plan = new LiveRig(setup, { glide: 0.2, stagger: 0.03 }, RATE);
  plan.record = false;
  const messages: Message[] = [];
  const bends: { block: number; semitones: number }[] = [];
  let block = 0;
  const queue = plan.input.queue.bind(plan.input);
  plan.input.queue = (seq, m, n, gain, over, press = 0) => {
    const moves = Array.from(m);
    messages.push({ block, seq, moves, n, gain: gain === gain ? gain : null, over, press });
    return queue(seq, m, n, gain, over, press);
  };
  const setBend = plan.input.setBend.bind(plan.input);
  plan.input.setBend = (semitones) => {
    bends.push({ block, semitones });
    setBend(semitones);
  };
  const rng = new Prng(5);
  const held = new Set<number>();
  const releases = ['hold', 'fade', 'tonic'] as const;
  let next = 0;
  for (block = 0; block < total; block++) {
    if (block >= next) {
      const r = rng.next();
      if (r < 0.45 || held.size === 0) {
        const p = 40 + Math.floor(rng.next() * 40);
        held.add(p);
        plan.noteOn(p);
      } else if (r < 0.85) {
        const list = [...held];
        const p = list[Math.floor(rng.next() * list.length)];
        held.delete(p);
        plan.noteOff(p);
      } else if (r < 0.93) {
        plan.bend((rng.next() * 2 - 1) * 2);
      } else if (r < 0.97) {
        plan.sustain(rng.next() < 0.5);
      } else {
        plan.settings = mergeLiveSettings(plan.settings, {
          release: releases[Math.floor(rng.next() * 3)],
          chord: rng.next() < 0.5 ? 'exact' : 'range',
        });
      }
      next = block + (block < fast ? 2 : 4 + Math.floor(rng.next() * 30));
    }
    plan.block();
  }
  const json = {
    score: liveScore(setup),
    mix: setup.mix,
    voices: setup.voices.length,
    warmBlocks,
    messages,
    bends,
  };
  writeFileSync(file, JSON.stringify(json));
  return {
    messages: messages.length,
    bends: bends.length,
    presses: messages.filter((m) => m.press > 0).length,
  };
}
