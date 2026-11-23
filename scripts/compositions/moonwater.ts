/**
 * Moonwater: E minor, 6/8 (156 eighths a minute). A flute lead over a four-voice marimba
 * arpeggio (one `together` pulse per voice, order 0 1 2 3 2 1) and an organ bass. Form: intro 4,
 * A 8, A′ 8, B 8, A′ 8, outro 4 (40 bars, 1′32″). Ported from the gallery piece.
 */
import { type Note, Song, start } from './song';

export function moonwater(): Record<string, unknown> {
  const s = new Song('Moonwater', 'mw', 2611, { tonic: 'E', scale: 'minor' }, 156, 6);
  const [M, C, B] = ['Melody', 'Marimba', 'Bass'];
  const flute = { reverb: 0.5, delay: 0.22 };
  s.voice({ part: M, timbre: 'flute', range: [62, 90], gain: 1.6, pan: 0.05, sends: flute });
  const mallets = { reverb: 0.4, delay: 0.12 };
  const arp = [-0.35, -0.12, 0.12, 0.35].map((pan) =>
    s.voice({ part: C, timbre: 'marimba', range: [45, 74], gain: 3.2, pan, sends: mallets }),
  );
  const organ = { reverb: 0.2, delay: 0 };
  s.voice({ part: B, timbre: 'organ', range: [28, 53], gain: 1.0, pan: 0, sends: organ });
  s.mix.delay = { time: 1.1538, feedback: 0.25, returnLevel: 0.14 };
  s.mix.reverb = { size: 0.8, decay: 4, damping: 0.45, preDelay: 0.02, returnLevel: 0.36 };

  // Voicings (voice-led, four notes in 50–67) and the bass roots.
  // prettier-ignore
  const V: Record<string, [number[], number]> = {
    Em: [[52, 59, 64, 67], 40], C: [[52, 60, 64, 67], 36], G: [[50, 59, 62, 67], 43],
    D: [[50, 57, 62, 66], 38], Am: [[52, 57, 60, 64], 45], B7: [[51, 57, 63, 66], 35],
    Bm: [[50, 59, 62, 66], 35], Cmaj7: [[52, 59, 64, 67], 36], Em9: [[52, 59, 64, 66], 40],
  };
  start(s, [71, ...V.Em[0], 40]);
  s.lastChord.set(C, V.Em[0]);

  const intro = ['Em', 'Em', 'C', 'C'];
  const A = ['Em', 'C', 'G', 'D', 'Em', 'C', 'Am', 'B7'];
  const A2 = ['Em', 'C', 'G', 'D', 'C', 'Am', 'B7', 'Em'];
  const Bs = ['C', 'D', 'Bm', 'Em', 'Am', 'D', 'G', 'B7'];
  const outro = ['Cmaj7', 'Cmaj7', 'Em9', 'Em9'];
  const all = [...intro, ...A, ...A2, ...Bs, ...A2, ...outro];

  const glide = { length: 0.25, stagger: 0.05, jitter: 0.2, ease: 'smoothstep' };
  s.chords(
    C,
    0,
    all.map((n): [number[], number] => [V[n][0], 6]),
    glide,
  );
  // Bass: the root held through the verses; root and fifth rocking in the B section and after.
  const bass = all.map((n, i): Note[] => {
    const r = V[n][1];
    return i >= 20 && i < 36
      ? [
          [r, 3],
          [r + 7, 3],
        ]
      : [[r, 6]];
  });
  s.tune(B, 0, bass.flat(), { length: 0.25, ease: 'smoothstep' }, 0.1);

  // The arpeggio: per bar, voices low → high 0 1 2 3 2 1, accented on 1 and 4.
  const ORDER = [0, 1, 2, 3, 2, 1];
  const ACC = [1, 0.5, 0.7, 0.85, 0.6, 0.5];
  arp.forEach((v, i) => {
    const pattern = ORDER.map((o, k) => (o === i ? ACC[k] : 0));
    const p = { pattern, decay: 0.5, floor: 0.06, mode: 'together' };
    s.pulse({ voices: [v] }, 0, 39, 1, p, i ? undefined : 'Arpeggio');
  });

  const melA =
    '71:3 67:2 69:1 | 71:2 72:1 76:3 | 74:3 71:2 67:1 | 69:6 | ' +
    '71:3 67:2 69:1 | 71:2 72:1 79:3 | 76:2 74:1 72:2 71:1 | 69:2 71:1 75:3';
  const melA2 =
    '76:3 74:2 71:1 | 72:3 76:3 | 74:2 71:1 67:3 | 69:3 66:3 | ' +
    '67:2 69:1 72:3 | 76:3 72:2 69:1 | 66:2 69:1 71:3 | 64:6';
  const melB =
    '79:3 76:2 79:1 | 81:3 78:3 | 79:2 78:1 74:3 | 76:6 | ' +
    '81:3 84:2 83:1 | 81:2 78:1 74:3 | 79:3 83:3 | 81:3 78:2 75:1';
  const melOut = '71:6 | 67:3 69:3 | 71:12';
  const mel = { length: 0.09, ease: 'smoothstep' };

  // Levels: everything but the marimba waits; the lead enters at bar 4.
  s.level(0, { part: M }, 0, 0);
  s.level(0, { part: B }, 0, 0);
  s.level(0, { part: C }, 0.75, 0, 'Intro');
  s.level(s.T(2), { part: B }, 0.55, 4);
  let lead = 0.8;
  const breathe = (bar: number): void => {
    const t = s.T(bar) - 0.28;
    s.level(t, { part: M }, lead * 0.35, 0.22);
    s.level(t + 0.3, { part: M }, lead, 0.08);
  };
  s.level(s.T(4) - 0.05, { part: M }, lead, 0.05, 'A');
  s.tune(M, 4, `${melA} | ${melA2}`, mel, 0.04);
  [8, 12, 16].forEach(breathe);
  // B: lifts.
  lead = 0.95;
  s.level(s.T(20), { part: M }, lead, 1.5, 'B');
  s.level(s.T(20), { part: C }, 1, 0.02);
  s.level(s.T(20), { part: B }, 0.7, 1.5);
  s.tune(M, 20, melB, mel, 0.04);
  [24, 28].forEach(breathe);
  // A′ again, a little softer, then the outro.
  lead = 0.85;
  s.level(s.T(28), { part: M }, lead, 1, 'A′');
  s.level(s.T(28), { part: C }, 0.8, 0.02);
  s.tune(M, 28, melA2, mel, 0.04);
  [32, 36].forEach(breathe);
  s.tune(M, 36, melOut, { length: 0.14, ease: 'smoothstep' }, 0.04, 'Outro');
  s.level(s.T(37), undefined, 0, s.T(40) - s.T(37));
  s.end = { at: s.T(40), fade: 1 };
  return s.toJson();
}
