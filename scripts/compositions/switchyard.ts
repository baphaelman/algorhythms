/**
 * Switchyard: D dorian, 112 bpm. A rhythm machine built from pulses whose patterns have
 * different lengths (4 over 3 plucks, a 10-step random marimba, a 3+3+2 bass, brass stabs), so
 * they phase against the bar. Nothing is re-voiced: one opening chord, then `shift` by scale
 * steps planes all four parts through the mode at once. The marimba solo is a walk inside its
 * random pulse.
 */
import { Kit } from './kit';

export function switchyard(): Record<string, unknown> {
  const s = new Kit('Switchyard', 'sw', 112, { tonic: 'D', scale: 'dorian' }, 112, 4);
  const [Bs, Br, Pl, Mb] = [
    { part: 'Bass' },
    { part: 'Brass' },
    { part: 'Pluck' },
    { part: 'Marimba' },
  ];
  s.voice({
    part: 'Bass',
    timbre: 'organ',
    range: [28, 52],
    gain: 3.9,
    pan: 0,
    sends: { reverb: 0.15 },
  });
  for (const pan of [-0.4, 0, 0.4])
    s.voice({ part: 'Brass', timbre: 'brass', range: [48, 74], gain: 4, pan });
  for (const pan of [-0.6, 0.1, 0.6])
    s.voice({ part: 'Pluck', timbre: 'pluck', range: [57, 86], gain: 4.2, pan });
  for (const pan of [-0.3, 0.3, 0.8])
    s.voice({ part: 'Marimba', timbre: 'marimba', range: [72, 100], gain: 4, pan });
  s.mix.delay = { time: (60 / 112) * 0.75, feedback: 0.35, returnLevel: 0.16 };
  s.mix.sends = { reverb: 0.35, delay: 0.2 };

  // The only voicing in the piece: fourths over D (D G C F A), spread over the four parts
  // (pool order, low to high).
  s.m('chord', 0, {
    notes: { kind: 'pitches', pitches: [38, 55, 60, 65, 69, 74, 79, 84, 89, 93] },
    count: 10,
    byVoice: true,
    label: 'Fourths',
  });
  for (const p of [Bs, Br, Mb]) s.level(0, p, 0, 0);
  s.level(0, Pl, 0.4, 0);
  s.level(0.01, Pl, 1, s.bars(4));

  const pluck = (bar: number, bars: number) =>
    s.pulse(Pl, bar, bars, 0.5, {
      mode: 'up',
      pattern: [1, 0.5, 0.7, 0.5],
      decay: 0.3,
      floor: 0.2,
      strike: true,
    });
  const bass = (bar: number, bars: number) =>
    s.pulse(Bs, bar, bars, 0.5, {
      mode: 'together',
      pattern: [1, 0, 0, 0.8, 0, 0, 0.9, 0],
      decay: 0.22,
      floor: 0.12,
      strike: false,
    });
  const rain = (bar: number, bars: number) =>
    s.pulse(Mb, bar, bars, 0.25, {
      mode: 'random',
      pattern: [1, 0, 0.6, 0, 0, 0.8, 0, 0.5, 0, 0],
      decay: 0.25,
      floor: 0.15,
      strike: true,
    });
  const stabs = (bar: number, bars: number) =>
    s.pulse(Br, bar, bars, 0.5, {
      mode: 'together',
      pattern: [0, 0, 1, 0, 0, 0, 0, 0.7, 0, 0, 0.9, 0, 0, 0, 0, 0],
      decay: 0.3,
      floor: 0.1,
      strike: false,
    });
  // Planing: every two bars the whole voicing steps through the mode. On i, ii and v the
  // fourths stay pentatonic (no semitones), so the line goes i ii i v i ii i v.
  const plane = (bar0: number, deltas: number[]) =>
    deltas.forEach((by, i) =>
      s.m('shift', s.T(bar0 + 2 * (i + 1)), {
        by,
        unit: 'scaleSteps',
        glide: { length: 0.18, stagger: 0, land: true },
      }),
    );

  // Build-up: plucks, then bass, marimba, brass every eight bars.
  pluck(0, 32);
  plane(0, [1, -1, -3, 3, 1, -1, -3]);
  s.m('shift', s.T(16), {
    by: 3,
    unit: 'scaleSteps',
    glide: { length: 0.18, stagger: 0, land: true },
  });
  s.paste(2, 16, 18);
  bass(8, 24);
  s.level(s.T(8), Bs, 1, 0);
  rain(16, 24);
  s.level(s.T(16), Mb, 1, s.bars(2));
  stabs(24, 8);
  s.level(s.T(24), Br, 1, 0);

  // Break (32–39): the plucks turn to bells, the brass swells on a wide chord.
  s.m('shift', s.T(32), {
    by: 3,
    unit: 'scaleSteps',
    glide: { length: 0.18, stagger: 0, land: true },
  });
  s.m('spread', s.T(33), {
    factor: 1.5,
    around: 'median',
    snap: 'scale',
    glide: { length: 3, stagger: 1, order: 'center-out' },
    label: 'Break',
  });
  s.m('timbre', s.T(32), { target: Pl, preset: 'bell', fade: 0.5 });
  s.pulse(Pl, 32, 8, 1, {
    mode: 'down',
    pattern: [1, 0.6, 0.8, 0.6],
    decay: 2,
    floor: 0.1,
    strike: true,
  });
  s.level(s.T(32), Br, 0.08, 0);
  s.level(s.T(32) + 0.01, Br, 0.25, s.bars(6));
  s.level(s.T(32), Bs, 0.15, s.bars(1));
  s.level(s.T(32), Pl, 0.6, 0);
  s.level(s.T(36), Mb, 0, s.bars(3));

  // Up a tone, everything back; the marimba walks inside its random pulse.
  s.m('key', s.T(40), { key: { tonic: 'E', scale: 'dorian' }, label: 'E dorian' });
  // The opening chord, pasted and moved up a tone.
  s.m('chord', s.T(40), {
    notes: { kind: 'pitches', pitches: [40, 57, 62, 67, 71, 76, 81, 86, 91, 95] },
    byVoice: true,
    glide: { length: 0.4, stagger: 0, land: true },
    label: 'E',
  });
  s.m('timbre', s.T(40), { target: Pl, preset: 'pluck', fade: 0.2 });
  s.level(s.T(40), Br, 1, 0.2);
  s.level(s.T(40), Bs, 1, 0.2);
  s.level(s.T(40), Mb, 1.5, 0.5);
  s.level(s.T(40), Pl, 1.1, 0);
  pluck(40, 16);
  bass(40, 16);
  rain(40, 16);
  stabs(40, 16);
  s.m('walk', s.T(40), {
    target: Mb,
    until: s.T(56),
    grid: s.beat / 2,
    density: 0.45,
    steps: [-2, -1, 1, 2],
    stepGlide: 0.03,
    label: 'Solo',
  });
  plane(40, [1, -1, -3, 3, 1, -1, -3]);

  // Out: one last chord, the plucks ring.
  s.m('shift', s.T(56), {
    target: { exceptParts: ['Bass'] }, // the unison below lands the bass
    by: 3,
    unit: 'scaleSteps',
    glide: { length: 0.3, stagger: 0.05, land: true },
    label: 'Home',
  });
  s.m('unison', s.T(56), {
    target: Bs,
    pitch: 40,
    octaves: false,
    glide: { length: 0.3, land: true },
  });
  s.pulse(Pl, 56, 2, 0.5, {
    mode: 'up',
    pattern: [1, 0.7, 0.5, 0.35, 0.25, 0.15],
    decay: 0.8,
    floor: 0,
    strike: true,
  });
  s.level(s.T(56) - 0.45, Br, 0.2, 0.4);
  s.level(s.T(56) - 0.45, Bs, 0.3, 0.4);
  s.level(s.T(56) + 0.5, undefined, 0, s.bars(3));
  s.end = { at: s.T(60), fade: 3 };
  return s.toJson();
}
