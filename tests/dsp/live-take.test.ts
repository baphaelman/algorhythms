/**
 * §15 M7 acceptance: "a recorded take plays back with pitch paths matching the live ones within
 * 1 cent and 1 block". A scripted take is played through the live rig (the worklet's LiveInput
 * and the mirror, src/audio/fixtures/live-rig.ts), recorded into moments (core/live-take.ts),
 * compiled, and the compiled pitch paths are compared with the live ones at every block.
 *
 * Compared: the set of distinct pitches sounding (live: every voice while the shared level is
 * above 0; compiled: every line alive with its level above 0), as the compiler plays doubled
 * voices as one line (distinct notes, revision 8). A point matches if a pitch of the other set is
 * within 1 cent at some time offset of at most 128 frames. Bend is excluded (not recorded).
 * Blocks inside the merge window of a key-by-key chord from silence are measured, not gated:
 * live mode sounds its first key at once (no debounce, §9), the take starts the whole chord there.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile } from '../../src/core/compiler/compile';
import { parsePiece } from '../../src/core/schema';
import { takeBase } from '../../src/core/live-take';
import type { LiveSettings } from '../../src/core/live';
import { lifeAt } from '../../src/core/query';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import type { LiveRig } from '../../src/audio/fixtures/live-rig';
import { liveSetupFrom } from '../../src/audio/live-setup';
import { compare, explain, press, record, report, wait } from './live-take-helpers';

describe('recorded take plays back as played (§15 M7)', () => {
  it('scripted take: notes, key-by-key chords, re-targets, releases, sustain', () => {
    const take = record((rig) => {
      wait(rig, 0.3);
      rig.noteOn(60); // from silence: establishes
      wait(rig, 0.4);
      rig.allOff(); // hold
      wait(rig, 0.1);
      press(rig, [64, 67, 71]); // 5 ms apart: one chord
      wait(rig, 0.12); // mid-glide
      rig.allOff();
      press(rig, [62, 65, 69]); // re-targets mid-glide, one chord
      wait(rig, 0.1);
      rig.allOff();
      rig.noteOn(60); // 0.1 s later: re-targets mid-glide again (unison)
      wait(rig, 0.5);
      rig.allOff();
      press(rig, [57, 64], 0.0107); // 10.7 ms (4 blocks): merged
      wait(rig, 0.4);
      rig.allOff();
      rig.sustain(true);
      rig.noteOn(55);
      wait(rig, 0.2);
      rig.noteOff(55); // held by the pedal: no change
      wait(rig, 0.1);
      rig.noteOn(59); // {55, 59}
      wait(rig, 0.2);
      rig.noteOff(59);
      rig.sustain(false); // drops both: hold
      wait(rig, 0.3);
      rig.setSettings({ release: 'tonic' });
      rig.noteOn(67);
      wait(rig, 0.3);
      rig.allOff(); // glides to the tonic
      wait(rig, 0.4);
      rig.setSettings({ release: 'fade', releaseFade: 0.4 });
      rig.noteOn(64);
      wait(rig, 0.3);
      rig.allOff(); // fades
      wait(rig, 0.2);
      rig.noteOn(62); // mid-fade: glides, level back up
      wait(rig, 0.3);
      rig.allOff();
      wait(rig, 0.6); // fade done: silent
      rig.noteOn(65); // from silence again
      wait(rig, 0.3);
      rig.allOff();
      wait(rig, 0.6);
      press(rig, [60, 64, 67]); // key by key from silence
      wait(rig, 0.4);
    });
    const types = take.moments.map((m) => m.type);
    expect(types).toContain('merge');
    expect(types).toContain('level');
    const m = compare(take);
    report('scripted take', m);
    expect(m.misses.slice(0, 5)).toEqual([]);
    expect(m.cents0).toBeLessThanOrEqual(1);
    expect(m.frames).toBeLessThanOrEqual(BLOCK_FRAMES);
  });

  it('glide settings: stagger with an order, range voicing, linear ease', () => {
    const take = record(
      (rig) => {
        wait(rig, 0.1);
        press(rig, [60, 64, 67], 0.004);
        wait(rig, 0.6);
        rig.allOff();
        rig.setSettings({ stagger: 0.15, order: 'low-first' });
        press(rig, [62, 65, 69]);
        wait(rig, 0.7);
        rig.allOff();
        rig.setSettings({ stagger: 0, order: 'high-first', chord: 'range' });
        press(rig, [57, 60, 64]);
        wait(rig, 0.7);
        rig.allOff();
        rig.setSettings({ chord: 'exact', ease: 'linear' });
        press(rig, [59, 62]);
        wait(rig, 0.6);
      },
      { glide: 0.4 },
    );
    const m = compare(take);
    report('glide settings', m);
    expect(m.misses.slice(0, 5)).toEqual([]);
    expect(m.cents0).toBeLessThanOrEqual(1);
    expect(m.frames).toBeLessThanOrEqual(BLOCK_FRAMES);
  });

  // Formerly known gaps (M7-c): a key > 15 ms after a unison while the voices still glide to it
  // (the compiler forks from the stacked line and re-times the line it crosses), random order with
  // stagger, octaves. Live mode now plans by the compiler's rules (core/live-plan.ts).
  it('re-target splitting a doubled line mid-glide; random order + stagger; octaves', () => {
    const cases: [string, (rig: LiveRig) => void, Partial<LiveSettings>][] = [
      [
        'split mid-glide',
        (rig) => {
          wait(rig, 0.1);
          press(rig, [64, 67, 71]);
          wait(rig, 0.4);
          rig.allOff();
          rig.noteOn(62);
          wait(rig, 0.02);
          rig.noteOn(69);
          wait(rig, 0.5);
        },
        {},
      ],
      [
        'random order + stagger',
        (rig) => {
          wait(rig, 0.1);
          press(rig, [60, 64, 67]);
          wait(rig, 0.5);
          rig.allOff();
          press(rig, [57, 60, 64]);
          wait(rig, 0.7);
        },
        { stagger: 0.15, order: 'random', chord: 'range' },
      ],
      [
        'octaves',
        (rig) => {
          wait(rig, 0.1);
          press(rig, [60, 64, 67]);
          wait(rig, 0.5);
          rig.allOff();
          rig.noteOn(62);
          wait(rig, 0.5);
        },
        { single: 'octaves' },
      ],
    ];
    for (const [name, script, settings] of cases) {
      const take = record(script, settings);
      const m = compare(take);
      if (process.env.EXPLAIN) explain(take, m);
      report(name, m);
      expect(m.misses.slice(0, 5)).toEqual([]);
      expect(m.cents0).toBeLessThanOrEqual(1);
      expect(m.frames).toBeLessThanOrEqual(BLOCK_FRAMES);
    }
  });
});

describe('takeBase', () => {
  it('a take into a sounding piece: every line has died by silentFrom, shortly after T', () => {
    const raw: unknown = JSON.parse(
      readFileSync('examples/tidewater-hymn.algorhythms.json', 'utf8'),
    );
    const parsed = parsePiece(raw);
    if (!parsed.ok) throw new Error('example did not parse');
    for (const T of [6, 30]) {
      let n = 0;
      const { piece, silentFrom } = takeBase(parsed.piece, T, () => `cut${n++}`);
      expect(silentFrom).toBeLessThan(T + 0.07);
      const score = compile(piece);
      for (const v of score.voices) expect(lifeAt(v, silentFrom)).toBeNull();
      // The live pool: every voice that sounded before T (1 at 6 s, 8 at 30 s).
      expect(liveSetupFrom(piece, score, silentFrom).voices.length).toBe(T === 6 ? 1 : 8);
    }
  });
});
