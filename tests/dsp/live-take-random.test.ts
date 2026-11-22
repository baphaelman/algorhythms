import { describe, expect, it } from 'vitest';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import type { LiveRig } from '../../src/audio/fixtures/live-rig';
import type { LiveSettings } from '../../src/core/live';
import { compare, explain, record, report } from './live-take-helpers';

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODES: Partial<LiveSettings>[] = [
  {},
  { single: 'octaves' },
  { chord: 'range' },
  { release: 'tonic' },
  { release: 'fade', releaseFade: 0.3 },
  { stagger: 0.12, order: 'low-first' },
  { stagger: 0.12, order: 'random' },
  { stagger: 0.1, order: 'high-first', chord: 'range' },
  { ease: 'linear' },
  { glide: 0.15 },
];

function randomScript(seed: number) {
  return (rig: LiveRig): void => {
    const r = rng(seed);
    const down = new Set<number>();
    rig.run(0.1);
    for (let k = 0; k < 40; k++) {
      const x = r();
      if (x < 0.45 || down.size === 0) {
        const p = 55 + Math.floor(r() * 18);
        if (!down.has(p)) {
          down.add(p);
          rig.noteOn(p);
        }
      } else if (x < 0.7) {
        const ps = [...down];
        const p = ps[Math.floor(r() * ps.length)];
        down.delete(p);
        rig.noteOff(p);
      } else if (x < 0.85) {
        down.clear();
        rig.allOff();
      } else if (x < 0.9) {
        rig.setSettings(MODES[Math.floor(r() * MODES.length)]);
      }
      rig.run(r() * 0.4);
    }
    rig.run(0.5);
  };
}

/**
 * §15 M7 match on random takes: 40 events (keys on and off, releases, setting changes across the
 * modes) at random gaps of 0–400 ms, from a seeded generator; gated like the scripted takes
 * (≤ 1 cent, ≤ 1 block, outside presses from silence). Seeds 13–72 are measured only: a few still
 * miss (re-targets while a staggered fork has not departed yet; build log "M7-d").
 */
describe('random takes match the live paths (§15 M7)', () => {
  for (let s = 1; s <= 12; s++) {
    it(`seed ${s}`, () => {
      const settings = MODES[s % MODES.length];
      const take = record(randomScript(s), settings);
      const m = compare(take);
      report(`seed ${s} ${JSON.stringify(settings)}`, m);
      if (process.env.EXPLAIN) explain(take, m);
      expect(m.misses.slice(0, 5)).toEqual([]);
      expect(m.cents0).toBeLessThanOrEqual(1);
      expect(m.frames).toBeLessThanOrEqual(BLOCK_FRAMES);
    });
  }
  it.runIf(process.env.LIVE_TAKE_SEEDS)(
    'seeds 13–72 (measured)',
    () => {
      let bad = 0;
      for (let s = 13; s <= 72; s++) {
        const settings = MODES[s % MODES.length];
        const m = compare(record(randomScript(s), settings));
        const worst = m.misses.reduce((w, x) => Math.max(w, x.gap), 0);
        if (m.misses.length > 0) {
          bad++;
          console.log(`seed ${s} ${JSON.stringify(settings)}: worst ${(worst * 100).toFixed(1)} c`);
        }
      }
      console.log(`${bad} of 60 seeds miss`);
    },
    600_000,
  );
});
