/**
 * Tide Pools: D minor pentatonic, 96 bpm. Almost no written notes: walks improvise the mallet
 * lines, a random pulse makes rain on a held chord, and a slow choir pad changes chords under
 * them with the default glide. Pad chords use only the scale's five notes, so no walk step
 * can rub against them. Timbre moments turn the mallets into bells and then into flutes.
 */
import { Kit } from './kit';

export function tidePools(): Record<string, unknown> {
  const s = new Kit('Tide Pools', 'tp', 731, { tonic: 'D', scale: 'pentatonic-minor' }, 96, 4);
  const [Ml, P] = [{ part: 'Mallets' }, { part: 'Pad' }];
  for (const pan of [0, -0.5, 0.5, -0.25, 0.25, -0.7])
    s.voice({ part: 'Mallets', timbre: 'marimba', range: [50, 88], gain: 1.4, pan });
  for (const pan of [-0.3, 0, 0.3])
    s.voice({
      part: 'Pad',
      timbre: 'choir',
      range: [48, 69],
      gain: 0.55,
      pan,
      sends: { reverb: 0.7 },
    });
  s.mix.delay = { time: 0.3125 * 3, feedback: 0.35, returnLevel: 0.2 };
  s.mix.reverb = { size: 0.85, decay: 4.5, damping: 0.5, preDelay: 0.03, returnLevel: 0.4 };

  const walk = (bar: number, bars: number, f: Record<string, unknown>, label?: string) =>
    s.m('walk', s.T(bar), {
      target: Ml,
      until: s.T(bar + bars),
      grid: s.beat / 2,
      density: 0.5,
      steps: [-1, 1, -2, 2],
      stepGlide: 0.04,
      ...f,
      label,
    });
  const pad = (bar: number, symbol: string, label?: string) =>
    s.chord(P, bar, symbol, { voicing: 'nearest', register: [50, 67], label });

  // One mallet line improvises; it splits into three, then five.
  s.m('unison', 0, { target: Ml, pitch: 62, octaves: false, label: 'One line' });
  s.level(0, Ml, 0.45, 0);
  walk(0, 4, { density: 0.6 });
  s.level(s.T(4), Ml, 0.75, s.bars(2));
  s.m('split', s.T(4), {
    target: Ml,
    count: 3,
    notes: { kind: 'chord', symbol: 'Dm7' },
    voicing: 'even',
    glide: { length: 0.4, stagger: 0.3 },
  });
  walk(4, 6, { density: 0.45 });
  // The pad grows out of the lowest mallet (default 3 s glide, staggered).
  s.chord(P, 8, 'Dm7', { count: 3, voicing: 'close', register: [50, 67], label: 'Pad' });
  s.m('split', s.T(10), {
    target: Ml,
    count: 5,
    voicing: 'even',
    glide: { length: 0.5, stagger: 0.4 },
  });
  walk(10, 10, { density: 0.35, bass: { leap: [5, 7] } }, 'Five');
  s.level(s.T(10), Ml, 0.95, s.bars(2));
  pad(12, 'F6');
  pad(16, 'Csus2');
  pad(18, 'Gsus4');

  // Rain: the mallets hold an open Dm7(add11) and a random pulse picks one note per sixteenth.
  s.chord(Ml, 20, 'Dm7add11', {
    count: 6,
    voicing: 'even',
    register: [62, 88],
    glide: { length: 0.6, stagger: 0.5 },
    label: 'Rain',
  });
  s.pulse(Ml, 20, 8, 0.25, {
    mode: 'random',
    pattern: [1, 0.35, 0.6, 0, 0.8, 0.3, 0, 0.5],
    decay: 0.35,
    floor: 0.02,
    strike: true,
  });
  s.level(s.T(20), Ml, 1.9, s.bars(1));
  pad(20, 'F6');
  pad(24, 'Csus2');
  pad(26, 'Gsus4');

  // Up a fourth: shift everything, move the key, the mallets become bells.
  s.m('key', s.T(28), { key: { tonic: 'G', scale: 'pentatonic-minor' }, label: 'Up a fourth' });
  s.m('shift', s.T(28), {
    by: 5,
    unit: 'semitones',
    glide: { length: 2, stagger: 0.6, order: 'low-first' },
  });
  s.m('timbre', s.T(28), { target: Ml, preset: 'bell', fade: 3 });
  s.m('merge', s.T(28), { target: Ml, count: 4, which: 'inner', fade: 1 });
  s.level(s.T(28), Ml, 0.55, s.bars(2));
  walk(30, 10, { density: 0.4, steps: [-2, -1, 1, 2, 3] }, 'Bells');
  pad(32, 'Bb6');
  pad(36, 'Gm7');

  // Home: back down, marimba again, then flutes that glide slowly; everything closes on D.
  s.m('key', s.T(40), { key: { tonic: 'D', scale: 'pentatonic-minor' }, label: 'Home' });
  s.m('shift', s.T(40), {
    by: -5,
    unit: 'semitones',
    glide: { length: 3, stagger: 0.8, order: 'high-first' },
  });
  s.m('timbre', s.T(40), { target: Ml, preset: 'marimba', fade: 2 });
  s.level(s.T(40), Ml, 1, s.bars(2)); // the bells were turned down
  walk(42, 6, { density: 0.5 });
  pad(42, 'Dm7');
  pad(46, 'F6');
  s.m('timbre', s.T(48), { target: Ml, preset: 'flute', fade: 4, label: 'Flutes' });
  s.level(s.T(48), Ml, 0.4, 4);
  walk(48, 8, { grid: s.beat, density: 0.4, stepGlide: 0.35 });
  pad(50, 'Csus2');
  pad(54, 'Dm7');
  s.m('unison', s.T(56), {
    target: undefined,
    pitch: 'tonic',
    octaves: true,
    glide: { length: 6, stagger: 2, order: 'outside-in' },
    label: 'D',
  });
  s.end = { at: s.T(62), fade: 5 };
  return s.toJson();
}
