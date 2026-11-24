/**
 * Little Round: F major, 88 bpm. One six-bar tune (three phrases over F Dm B♭ C), typed once and
 * pasted onto three parts two bars apart, so the phrases sound together as harmony. Each voice
 * is born out of the line below it and swoops up to its first note. An organ bass loops.
 */
import { Kit } from './kit';

export function littleRound(): Record<string, unknown> {
  const s = new Kit('Little Round', 'lr', 88, { tonic: 'F', scale: 'major' }, 88, 4);
  const B = { part: 'Bass' };
  const R = [{ part: 'Flute' }, { part: 'Reed' }, { part: 'Piano' }];
  s.voice({
    part: 'Bass',
    timbre: 'organ',
    range: [29, 50],
    gain: 0.55,
    pan: 0,
    sends: { reverb: 0.25 },
  });
  s.voice({ part: 'Flute', timbre: 'flute', range: [62, 86], gain: 0.9, pan: -0.45 });
  s.voice({ part: 'Reed', timbre: 'reed', range: [62, 86], gain: 1.1, pan: 0.45 });
  s.voice({ part: 'Piano', timbre: 'epiano', range: [62, 86], gain: 1.5, pan: 0 });
  s.mix.reverb = { size: 0.8, decay: 3.8, damping: 0.4, preDelay: 0.02, returnLevel: 0.38 };

  const A = 'C5 2, D5 2, F5 2, E5 2';
  const Bp = 'A4 1, C5 1, F4 1, A4 1, Bb4 1, D5 1, G4 1, C5 1';
  const C =
    'F5 0.5, G5 0.5, A5 0.5, C6 0.5, A5 0.5, F5 0.5, D5 0.5, F5 0.5, ' +
    'Bb5 0.5, A5 0.5, F5 0.5, D5 0.5, E5 0.5, G5 0.5, C6 0.5, G5 0.5';
  const tune = `${A}, ${Bp}, ${C}`;
  const glide = { glide: { length: 0.08 } };

  // Bass: two bars typed four times, pasted every eight bars.
  s.m('unison', 0, { target: B, pitch: 41, octaves: false, label: 'Bass' });
  s.level(0, B, 0, 0);
  s.level(0.01, B, 0.6, s.bars(1));
  s.level(s.T(6), B, 0.85, s.bars(2));
  const loop = 'F2 2, D2 2, Bb1 2, C2 2';
  for (const bar of [0, 8, 16, 24])
    s.say(B, bar, [loop, loop, loop, loop].join(', '), { glide: { length: 0.15 } });
  s.say(B, 32, 'F2 8', { glide: { length: 0.3 } });

  // The round: each voice is born from the line below and swoops to C5, then sings the tune
  // over and over (one tune pasted), two bars after the voice before it.
  const entry = [2, 4, 6];
  R.forEach((part, i) => {
    s.m('chord', s.T(entry[i]), {
      target: part,
      notes: { kind: 'pitches', pitches: [72] },
      count: 1,
      glide: { length: 0.7, land: true },
      label: i === 0 ? 'Round' : undefined,
    });
    for (let bar = entry[i]; bar + 6 <= 32; bar += 6) s.say(part, bar, tune, glide);
  });
  // The third time round is the loudest.
  s.level(s.T(14), undefined, 1.2, s.bars(2));
  s.level(s.T(24), undefined, 1, s.bars(4));
  // The ending: each voice stops where it is in the tune, on a note of F.
  s.say(R[1], 32 - 4, `${A}, ${Bp}`, glide);
  s.say(R[2], 32 - 2, A, glide);
  s.say(R[0], 32, 'F5 8', glide);
  s.say(R[1], 32, 'A4 8', glide);
  s.say(R[2], 32, 'C5 8', glide);
  s.level(s.T(32), undefined, 0, s.bars(3));
  s.end = { at: s.T(35), fade: 2 };
  // One colour per voice, so the three entries of the tune read as a braid.
  const colors = ['#6f7f8f', '#d9822b', '#3d8fd1', '#c2457a'];
  const j = s.toJson() as { voices: { color?: string }[]; view: { colors: string } };
  j.voices.forEach((v, i) => (v.color = colors[i]));
  j.view.colors = 'custom';
  return j;
}

/** Which examples folder build.mjs writes this piece into. */
export const kind = 'song' as const;
