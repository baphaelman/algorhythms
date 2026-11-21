/**
 * Porch Light: a pop song, G major, 84 bpm. Written as one would in the editor: Roman-numeral
 * chords (so the last chorus follows the key change by itself), one pulse per section for the
 * electric-piano arpeggio, the melody and bass typed into tunes, choruses pasted.
 */
import { Kit } from './kit';

export function porchLight(): Record<string, unknown> {
  const s = new Kit('Porch Light', 'pl', 2024, { tonic: 'G', scale: 'pentatonic-major' }, 84, 4);
  const [K, B, M, S] = [{ part: 'Keys' }, { part: 'Bass' }, { part: 'Melody' }, { part: 'Bells' }];
  for (const pan of [-0.45, -0.15, 0.15, 0.45])
    s.voice({ part: 'Keys', timbre: 'epiano', range: [52, 72], gain: 2.6, pan });
  s.voice({ part: 'Bass', timbre: 'organ', range: [33, 52], gain: 0.7, pan: 0 });
  s.voice({ part: 'Melody', timbre: 'flute', range: [62, 88], gain: 1.5, pan: 0.05 });
  for (const pan of [-0.6, 0, 0.6])
    s.voice({ part: 'Bells', timbre: 'bell', range: [84, 100], gain: 0.65, pan });
  s.mix.delay = { time: (60 / 84) * 0.75, feedback: 0.3, returnLevel: 0.15 };

  const keys = {
    voicing: 'close',
    register: [55, 71],
    glide: { length: 0.25, stagger: 0.04, land: true },
  };
  const arp = (bar: number, bars: number, label?: string) =>
    s.pulse(
      K,
      bar,
      bars,
      0.5,
      {
        mode: 'updown',
        pattern: [1, 0.55, 0.75, 0.55, 0.85, 0.55, 0.75, 0.55],
        decay: 0.6,
        floor: 0.3,
        strike: true,
      },
      label,
    );
  const ripple = (bar: number, bars: number, label?: string) =>
    s.pulse(
      K,
      bar,
      bars,
      0.25,
      {
        mode: 'up',
        pattern: [1, 0.5, 0.7, 0.5],
        decay: 0.4,
        floor: 0.25,
        strike: true,
      },
      label,
    );
  const bass = { glide: { length: 0.12, land: true } };
  const flute = { glide: { length: 0.09 } };

  // Intro (bars 0–3): the arpeggio alone, then the bass.
  s.chord(K, 0, 'I', { count: 4, voicing: 'close', register: [55, 71], label: 'Intro' });
  s.level(0, K, 0, 0);
  s.level(0.01, K, 0.9, s.bars(2));
  s.prog(K, 1, 'iii vi IV', keys);
  arp(0, 4);
  // Later parts are born out of a sounding line: the bass dives out of the keys.
  const enter = (t: typeof B, bar: number, pitches: number[], length: number, beat = 0) =>
    s.m('chord', s.T(bar, beat), {
      target: t,
      notes: { kind: 'pitches', pitches },
      count: pitches.length,
      glide: { length, stagger: 0.15, land: true },
    });
  enter(B, 2, [40], 1.2);
  s.say(B, 2, 'E2 4, C3 4', bass);

  // Verse (4–11).
  s.prog(K, 4, 'I iii vi IV I iii IV', keys, 4);
  s.chord(K, 11, 'Vsus4', keys);
  s.chord(K, 11, 'V', keys, 2);
  arp(4, 8, 'Verse');
  s.level(s.T(4), undefined, 0.8, s.bars(1));
  enter(M, 4, [74], 0.8);
  s.say(
    B,
    4,
    'G2 2, D3 2, B2 2, F#2 2, E2 2, B2 2, C3 2, G2 2, ' +
      'G2 2, D3 2, B2 2, F#2 2, C3 2, E3 2, D3 4',
    bass,
  );
  s.say(
    M,
    4,
    'D5 1.5, B4 0.5, D5 1, E5 1, F#5 2, D5 1, B4 1, G5 1.5, F#5 0.5, E5 1, B4 1, ' +
      'E5 2, D5 1, C5 1, D5 1.5, B4 0.5, D5 1, G5 1, F#5 1.5, E5 0.5, D5 2, ' +
      'C5 1, E5 1, G5 1.5, E5 0.5, G5 2, F#5 2',
    flute,
  );

  // Chorus (12–19): the ripple, higher tune.
  s.prog(K, 12, 'IV V iii vi IV V I', keys);
  ripple(12, 8, 'Chorus');
  s.level(s.T(12) - 1, undefined, 1, 1);
  s.say(
    B,
    12,
    'C3 2, G2 2, D3 2, A2 2, B2 2, F#2 2, E2 2, B2 2, ' +
      'C3 2, G2 2, D3 2, A2 2, G2 4, D3 2, B2 2',
    bass,
  );
  s.say(
    M,
    12,
    'G5 1, A5 1, B5 2, A5 1.5, G5 0.5, F#5 1, D5 1, F#5 2, E5 1, F#5 1, ' +
      'B5 2, A5 1, G5 1, G5 1, A5 1, B5 1.5, D6 0.5, C6 1, B5 1, A5 2, B5 1, A5 1, G5 6',
    flute,
  );

  // Verse 2 and chorus 2: pasted; bells walk over chorus 2.
  s.paste(4, 20, 20);
  // Edit the pasted chorus level: a part joining makes every line a little quieter.
  const lift = s.moments.find(
    (m) => m.type === 'level' && m.at === Math.round((s.T(28) - 1) * 1e3) / 1e3,
  );
  if (lift) lift.gain = 1.2;
  enter(S, 28, [86, 91, 95], 1.5);
  s.level(s.T(28), S, 0, 0);
  s.level(s.T(28) + 0.01, S, 0.8, s.bars(1));
  s.m('walk', s.T(28), {
    target: S,
    until: s.T(36),
    grid: s.beat / 2,
    density: 0.3,
    steps: [-1, 1, -2, 2],
    stepGlide: 0.05,
    label: 'Bells',
  });
  s.level(s.T(35), S, 0, s.bars(1));

  // Bridge (36–39): borrowed chords, long flute notes.
  s.prog(K, 36, 'bVII IV bVI VI', keys);
  arp(36, 4, 'Bridge');
  s.say(B, 36, 'F2 4, C3 4, Eb3 4, E3 2, B2 2', bass);
  s.say(M, 36, 'F5 4, E5 4, Eb5 4, E5 2, G#5 2', flute);

  // Last chorus (40–47) up a tone: the key moment carries the numerals; tunes moved by hand
  // (the editor's "Move them to A?").
  s.m('key', s.T(40), { key: { tonic: 'A', scale: 'pentatonic-major' }, label: 'Lift' });
  s.prog(K, 40, 'IV V iii vi IV V I', keys);
  ripple(40, 8);
  s.say(
    B,
    40,
    'D3 2, A2 2, E3 2, B2 2, C#3 2, G#2 2, F#2 2, C#3 2, ' +
      'D3 2, A2 2, E3 2, B2 2, A2 4, E3 2, C#3 2',
    bass,
  );
  s.say(
    M,
    40,
    'A5 1, B5 1, C#6 2, B5 1.5, A5 0.5, G#5 1, E5 1, G#5 2, F#5 1, G#5 1, ' +
      'C#6 2, B5 1, A5 1, A5 1, B5 1, C#6 1.5, E6 0.5, D6 1, C#6 1, B5 2, C#6 1, B5 1, A5 6',
    flute,
  );
  s.m('chord', s.T(40), {
    target: S,
    notes: { kind: 'pitches', pitches: [88, 93, 97] },
    glide: { length: 0.5, stagger: 0.1 },
  });
  s.level(s.T(40) - 2, { rank: [0, 5] }, 1.45, 2); // all but the bells
  s.level(s.T(40), S, 0.9, s.bars(1));
  s.m('walk', s.T(40), {
    target: S,
    until: s.T(48),
    grid: s.beat / 2,
    density: 0.35,
    steps: [-1, 1, -2, 2],
    stepGlide: 0.05,
  });

  // Outro (48–51): plagal, the arpeggio thins out.
  s.prog(K, 48, 'IV I IV I', keys);
  arp(48, 3, 'Outro');
  s.level(s.T(48), undefined, 0.9, s.bars(2));
  s.say(B, 48, 'D3 4, A2 4, D3 4, A2 4', bass);
  s.say(M, 48, 'F#5 4, E5 4, F#5 2, B5 2, A5 4', flute);
  s.level(s.T(47), S, 0, s.bars(2));
  s.end = { at: s.T(52), fade: 4 };
  return s.toJson();
}
