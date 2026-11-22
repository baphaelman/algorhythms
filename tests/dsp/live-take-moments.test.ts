/**
 * `takeMoments` from changes decided as LiveEngine decides them (audio/live-mirror `decideLive`,
 * explicit call times, no worklet): the 15 ms press window boundary, each release mode, and the
 * glide settings carried into the moments (core/live-take.ts, docs/build-log.md "M7-c").
 */

import { describe, expect, it } from 'vitest';
import { compile } from '../../src/core/compiler/compile';
import { newPiece } from '../../src/core/defaults';
import { DEFAULT_LIVE_SETTINGS, mergeLiveSettings, type LiveSettings } from '../../src/core/live';
import { takeMoments, type TakeChange } from '../../src/core/live-take';
import type { Moment, Pitch } from '../../src/core/types';
import { decideLive, encodeMoves, mirrorTracks, type LivePress } from '../../src/audio/live-mirror';
import { liveSetupFrom } from '../../src/audio/live-setup';

/** A live session on the mirror: `change(held, at)` at call time = live time `at` (s). */
function session(partial: Partial<LiveSettings> = {}) {
  const piece = newPiece({ poolSize: 4, timbre: 'sine', seed: 1 });
  const setup = liveSetupFrom(piece, compile(piece), 0);
  const tracks = mirrorTracks(setup);
  const settings = mergeLiveSettings(DEFAULT_LIVE_SETTINGS, { key: setup.key, ...partial });
  const changes: TakeChange[] = [];
  const appliedAt = new Map<number, number>();
  let press: LivePress | null = null;
  let seq = 0;
  const change = (held: Pitch[], at: number): void => {
    const d = decideLive(press, tracks, setup.voices, held, settings, setup.seed, seq + 1, at, at);
    press = d.next;
    const u = d.update;
    if (d.press === 0 && u.moves.length === 0 && u.level === null) {
      press = null;
      return;
    }
    seq++;
    const t = d.press > 0 ? appliedAt.get(d.press)! : at;
    appliedAt.set(seq, at);
    tracks.apply(
      encodeMoves(u.moves),
      0,
      u.moves.length,
      u.level ? u.level.gain : NaN,
      u.level ? u.level.over : 0,
      t,
      null,
      d.press > 0,
    );
    changes.push({
      press: d.press > 0 ? d.press : seq,
      time: t,
      held,
      settings,
      seed: d.seed,
      update: u,
    });
  };
  let n = 0;
  const moments = (): Moment[] =>
    takeMoments(changes, {
      at: 10,
      liveAt: 0,
      voices: setup.voices.map((v) => v.id),
      newId: () => `m${n++}`,
    });
  return { change, moments, changes };
}

const shape = (ms: Moment[]) =>
  ms.map((m) => {
    if (m.type === 'unison') return `${m.at.toFixed(4)} unison ${m.pitch}`;
    if (m.type === 'chord')
      return `${m.at.toFixed(4)} chord ${m.notes?.kind === 'pitches' ? m.notes.pitches.join(',') : ''}${m.byVoice ? ' byVoice' : ''}`;
    if (m.type === 'level') return `${m.at.toFixed(4)} level ${m.gain}/${m.over}`;
    if (m.type === 'merge') return `${m.at.toFixed(4)} merge ${m.count}`;
    return `${m.at.toFixed(4)} ${m.type}`;
  });

describe('takeMoments (decided as LiveEngine does)', () => {
  it('a key 14.9 ms after the first joins its press; 15.1 ms starts a new one', () => {
    const a = session();
    a.change([60], 1);
    a.change([60, 64], 1.0149);
    a.change([60, 64, 67], 1.5);
    a.change([60, 64, 67, 71], 1.5151);
    expect(shape(a.moments())).toEqual([
      '11.0000 chord 60,60,60,64 byVoice', // from silence: one pitch per live voice (4)
      '11.5000 chord 60,64,67',
      '11.5151 chord 60,64,67,71',
    ]);
  });

  it('release modes: hold writes nothing, fade a level, tonic a unison', () => {
    const hold = session({ release: 'hold' });
    hold.change([62], 1);
    hold.change([65], 2);
    hold.change([], 3);
    expect(shape(hold.moments())).toEqual([
      '11.0000 chord 62,62,62,62 byVoice',
      '12.0000 unison 65',
    ]);

    const fade = session({ release: 'fade' });
    fade.change([62], 1);
    fade.change([], 2);
    const f = fade.moments();
    expect(f.map((m) => m.type)).toEqual(['chord', 'level']);
    expect(f[1]).toMatchObject({ at: 12, gain: 0 });
    // A key after the fade completed: the silent lines merge away, then establish again.
    fade.change([67], 5);
    expect(shape(fade.moments()).slice(2)).toEqual([
      `${(12 + DEFAULT_LIVE_SETTINGS.releaseFade).toFixed(4)} merge 0`, // where the fade ended
      '15.0000 chord 67,67,67,67 byVoice',
    ]);

    const tonic = session({ release: 'tonic' });
    tonic.change([62], 1);
    tonic.change([], 2);
    expect(shape(tonic.moments())).toEqual([
      '11.0000 chord 62,62,62,62 byVoice',
      '12.0000 unison tonic',
    ]);
  });

  it('the glide settings in effect are carried, with the press seed', () => {
    const s = session({ glide: 0.8, stagger: 0.3, order: 'high-first', ease: 'linear' });
    s.change([60], 1);
    s.change([55, 62, 67], 2);
    s.change([64], 3);
    const ms = s.moments();
    for (const m of ms.slice(1)) {
      expect(m.glide).toEqual({
        length: 0.8,
        jitter: 0,
        stagger: 0.3,
        arrive: 'together',
        order: 'high-first',
        ease: 'linear',
      });
    }
    const seeds = s.changes.map((c) => c.seed);
    expect(ms.slice(1).map((m) => (m as { seed?: number }).seed)).toEqual(seeds.slice(1));
  });
});
