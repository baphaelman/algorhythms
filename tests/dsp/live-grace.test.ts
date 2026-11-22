/**
 * The staggered chord release (core/live.ts ReleaseGrace, RELEASE_GRACE = 60 ms) through the live
 * rig (worklet LiveInput + mirror): a chord lifted key by key within 60 ms is one release of the
 * chord as held, in each release mode; a partial release re-targets at the grace's expiry; a press
 * during the grace is decided at once without the released keys; the sustain pedal is unaffected.
 */

import { describe, expect, it } from 'vitest';
import { RELEASE_GRACE, type LiveSettings } from '../../src/core/live';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import { LiveRig, liveSetupOf } from '../../src/audio/fixtures/live-rig';
import { distinct } from './live-take-helpers';

const BLOCK = BLOCK_FRAMES / 48000;

function rig(settings: Partial<LiveSettings> = {}): LiveRig {
  const r = new LiveRig(liveSetupOf(4, 'sine'), { glide: 0.2, ...settings });
  r.record = false;
  r.run(0.05);
  return r;
}

/** Distinct pitches sounding now (none when silent). */
function sounding(r: LiveRig): number[] {
  const tr = r.input.tracks;
  const t = r.time;
  return tr.levelAt(0, t) > 1e-6 ? distinct(tr.data.map((_, i) => tr.pitchAt(i, t))) : [];
}

/** Plays C E G and lets it settle. */
function chord(r: LiveRig): void {
  for (const p of [60, 64, 67]) r.noteOn(p);
  r.run(0.5);
  expect(sounding(r)).toEqual([60, 64, 67]);
}

/** Lifts `keys` one by one, `blocks` blocks apart. */
function lift(r: LiveRig, keys: number[], blocks: number): void {
  keys.forEach((k, i) => {
    if (i > 0) for (let b = 0; b < blocks; b++) r.block();
    r.noteOff(k);
  });
}

describe('staggered chord release (60 ms grace)', () => {
  it('hold: lifted 20 ms apart, the chord keeps sounding; nothing is posted', () => {
    const r = rig();
    chord(r);
    const n = r.changes.length;
    lift(r, [67, 60, 64], 8); // 21.3 ms apart, 42.7 ms in all
    r.run(0.5);
    expect(sounding(r)).toEqual([60, 64, 67]);
    expect(r.changes.length).toBe(n); // hold on the chord as held: nothing to post
  });

  it('boundary: all up after 22 blocks (58.7 ms) is one release; after 23 (61.3 ms) not', () => {
    expect(22 * BLOCK).toBeLessThan(RELEASE_GRACE);
    expect(23 * BLOCK).toBeGreaterThan(RELEASE_GRACE);
    const a = rig();
    chord(a);
    lift(a, [67, 64, 60], 11);
    a.run(0.5);
    expect(sounding(a)).toEqual([60, 64, 67]);
    const b = rig();
    chord(b);
    const n = b.changes.length;
    b.noteOff(67);
    b.noteOff(64);
    for (let k = 0; k < 23; k++) b.block();
    b.noteOff(60);
    b.run(0.5);
    // The grace ran out with 60 down: a unison on 60, then hold.
    expect(b.changes[n].held).toEqual([60]);
    expect(sounding(b)).toEqual([60]);
  });

  it('fade: the chord as held fades from the last key; tonic: it glides to the tonic', () => {
    const f = rig({ release: 'fade', releaseFade: 0.2 });
    chord(f);
    const n = f.changes.length;
    lift(f, [60, 64, 67], 6);
    const t = f.time;
    expect(f.changes[n].update.level).toEqual({ gain: 0, over: 0.2 });
    expect(f.changes[n].posted).toBeCloseTo(t, 9);
    f.run(0.1);
    expect(sounding(f)).toEqual([60, 64, 67]); // still the chord, fading
    f.run(0.2);
    expect(sounding(f)).toEqual([]);
    const g = rig({ release: 'tonic' });
    chord(g);
    const m = g.changes.length;
    lift(g, [64, 67, 60], 6);
    expect(g.changes.length).toBe(m + 1);
    g.run(0.5);
    expect(sounding(g)).toEqual([60]); // C major's tonic
    expect(g.changes[m].held).toEqual([]);
  });

  it('a partial release re-targets at the grace expiry, not before', () => {
    const r = rig();
    chord(r);
    const n = r.changes.length;
    r.noteOff(67);
    const t = r.time;
    // Checked at each block start: 22 blocks (58.7 ms) after the release, not yet.
    for (let k = 0; k < 23; k++) r.block();
    expect(r.changes.length).toBe(n);
    expect(sounding(r)).toEqual([60, 64, 67]);
    r.block();
    expect(r.changes.length).toBe(n + 1);
    const c = r.changes[n];
    expect(c.held).toEqual([60, 64]);
    expect(c.time - t).toBeGreaterThan(RELEASE_GRACE);
    expect(c.time - t).toBeLessThan(RELEASE_GRACE + BLOCK);
    r.run(0.5);
    expect(sounding(r)).toEqual([60, 64]);
  });

  it('a press during the grace ends it and is decided at once, without the released key', () => {
    const r = rig();
    chord(r);
    const n = r.changes.length;
    r.noteOff(67);
    for (let k = 0; k < 8; k++) r.block();
    const t = r.time;
    r.noteOn(71);
    expect(r.changes.length).toBe(n + 1);
    expect(r.changes[n].held).toEqual([60, 64, 71]);
    expect(r.changes[n].time).toBe(t);
    expect(r.grace.waiting).toBe(false);
    r.run(0.5);
    expect(r.changes.length).toBe(n + 1); // no late re-target
    expect(sounding(r)).toEqual([60, 64, 71]);
  });

  it('sustain: keys released under the pedal start no grace; lifting it re-targets at once', () => {
    const r = rig();
    chord(r);
    r.sustain(true);
    const n = r.changes.length;
    r.noteOff(67);
    r.noteOff(64);
    expect(r.grace.waiting).toBe(false);
    r.run(0.2);
    expect(r.changes.length).toBe(n);
    const t = r.time;
    r.sustain(false); // 60 still down
    expect(r.changes.length).toBe(n + 1);
    expect(r.changes[n].held).toEqual([60]);
    expect(r.changes[n].time).toBe(t);
    r.run(0.5);
    expect(sounding(r)).toEqual([60]);
  });
});
