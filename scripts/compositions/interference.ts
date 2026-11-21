/**
 * Interference: an experiment with almost no notes. Twelve lines, each in its own part so they
 * never merge, start a few cents apart around A3 and beat against each other. Spread moments
 * (snap off) widen the detuning into a microtonal cluster; `shift` by 0 scale steps snaps it into
 * the key, and a chord appears. Diatonic shifts plane it, a slow walk stirs it, spread 0
 * gathers it back to one note, and the beating returns.
 */
import { Kit } from './kit';

export function interference(): Record<string, unknown> {
  const s = new Kit('Interference', 'if', 4242, { tonic: 'A', scale: 'dorian' }, 60, 4);
  const pans = [-0.8, 0.8, -0.6, 0.6, -0.4, 0.4, -0.2, 0.2, -0.1, 0.1, 0, 0];
  pans.forEach((pan, i) =>
    s.voice({ part: `L${i + 1}`, timbre: 'sine', range: [33, 93], gain: 0.5, pan }),
  );
  s.mix.reverb = { size: 0.9, decay: 6, damping: 0.55, preDelay: 0.04, returnLevel: 0.45 };
  s.mix.sends = { reverb: 0.55, delay: 0.1 };
  s.mix.delay = { time: 0.75, feedback: 0.4, returnLevel: 0.1 };

  // A few cents apart: 1–2 beats a second at 220 Hz.
  const cents = [0, 7, -6, 12, -13, 18, -17, 4, -3, 24, -22, 1];
  const near = cents.map((c) => 57 + c / 100);
  const all = undefined;
  const g = (length: number, stagger = 0, order = 'random', ease = 'smootherstep') => ({
    glide: { length, stagger, order, ease, jitter: 0.1 },
  });

  s.m('chord', 0, {
    notes: { kind: 'pitches', pitches: near },
    count: 12,
    byVoice: true,
    label: 'Beating',
  });
  s.level(0, all, 0, 0);
  s.level(0.01, all, 1, 10);
  s.m('spread', 16, { factor: 4, around: 'mean', snap: 'none', ...g(12, 2), label: 'Faster' });
  s.m('spread', 32, { factor: 7, around: 'mean', snap: 'none', ...g(12, 3, 'center-out') });
  s.m('timbre', 34, { preset: 'glass', fade: 10 });
  // The cluster spans about a seventh; snapping to A dorian makes a chord of scale tones.
  s.m('shift', 48, { by: 0, unit: 'scaleSteps', ...g(2.5, 1.5, 'random'), label: 'Snap' });
  s.m('spread', 56, {
    factor: 3,
    around: 'median',
    snap: 'scale',
    ...g(9, 2.5, 'center-out'),
    label: 'Open',
  });
  s.m('timbre', 56, { preset: 'choir', fade: 8 });
  // Planing: the whole shape moves through the mode.
  s.m('shift', 70, { by: 1, unit: 'scaleSteps', ...g(3, 1.2, 'low-first') });
  s.m('shift', 78, { by: 1, unit: 'scaleSteps', ...g(3, 1.2, 'low-first') });
  s.m('shift', 86, { by: -3, unit: 'scaleSteps', ...g(4, 1.6, 'high-first') });
  s.m('timbre', 92, { target: { rank: [0, 3] }, preset: 'brass', fade: 6 });
  s.m('walk', 94, {
    until: 122,
    grid: 2,
    density: 0.35,
    steps: [-1, 1],
    stepGlide: 1.6,
    label: 'Stir',
  });
  s.m('timbre', 120, { preset: 'sine', fade: 10 });
  s.m('spread', 124, {
    factor: 0,
    around: 'mean',
    snap: 'none',
    ...g(14, 4, 'outside-in'),
    label: 'Gather',
  });
  s.m('chord', 144, {
    notes: { kind: 'pitches', pitches: near.map((p) => 57 + (p - 57) / 2) },
    byVoice: true,
    ...g(6, 0),
  });
  s.level(150, all, 0, 14);
  s.end = { at: 166, fade: 2 };
  return s.toJson();
}
