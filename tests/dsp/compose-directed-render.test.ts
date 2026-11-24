/**
 * Five contrasting directed briefs rendered offline and analysed (PLAN §15 M12, D1): no clipping,
 * sane loudness, no long silences before the end fade, and a bass you can measure where there is
 * a bass part. `COMPOSE_LOG=1` prints the numbers (logged in the build log, "M12 D1").
 */
import { describe, expect, it } from 'vitest';
import { exportFrameCount, renderOffline } from '../../src/audio/offline';
import { compile } from '../../src/core/compiler/compile';
import type { ComposeBrief } from '../../src/core/compose-brief';
import { composeDirectedWithBrief } from '../../src/core/compose-directed';
import { composedPiece } from '../../src/core/generate';
import { measureLoudness } from '../../src/dsp/loudness';

const SR = 48000;

const BRIEFS: [string, ComposeBrief][] = [
  [
    'calm steady',
    {
      seed: 11,
      mood: 'calm',
      length: 60,
      shape: 'steady',
      parts: ['chords', 'bass', 'melody', 'pulse', 'bells'],
    },
  ],
  [
    'driving build',
    {
      seed: 12,
      mood: 'driving',
      length: 120,
      shape: 'build',
      parts: ['chords', 'bass', 'melody', 'pulse', 'bells'],
    },
  ],
  [
    'dreamy arc',
    { seed: 13, mood: 'dreamy', length: 60, shape: 'arc', parts: ['chords', 'melody', 'bells'] },
  ],
  [
    'dark journey',
    {
      seed: 14,
      mood: 'dark',
      length: 120,
      shape: 'journey',
      parts: ['chords', 'bass', 'melody', 'pulse'],
    },
  ],
  [
    'bright pop',
    {
      seed: 15,
      mood: 'bright',
      length: 60,
      shape: 'arc',
      parts: ['chords', 'bass', 'melody', 'bells'],
      start: { kind: 'progression', name: 'I–V–vi–IV' },
    },
  ],
];

/** Two one-pole low-passes (12 dB/octave) at `hz`. */
function lowpass(x: Float32Array, hz: number): Float32Array {
  const a = Math.exp((-2 * Math.PI * hz) / SR);
  const y = new Float32Array(x.length);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < x.length; i++) {
    s1 = (1 - a) * x[i] + a * s1;
    s2 = (1 - a) * s1 + a * s2;
    y[i] = s2;
  }
  return y;
}

describe('directed pieces, rendered', () => {
  for (const [name, brief] of BRIEFS) {
    it(
      name,
      () => {
        const d = composeDirectedWithBrief(brief);
        const p = composedPiece(d.composition);
        const score = compile(p);
        const frames = exportFrameCount(score, p.mix, SR);
        const { left, right } = renderOffline(
          { score, mix: p.mix, timbres: p.timbres, sampleRate: SR },
          frames,
        );
        const loud = measureLoudness({ left, right }, SR);

        // The longest stretch below −50 dBFS (50 ms windows) before the end fade.
        const W = SR / 20;
        const until = Math.min(frames, Math.floor((p.end.at! - p.end.fade) * SR));
        let silence = 0;
        let run = 0;
        for (let i = 0; i + W <= until; i += W) {
          let s = 0;
          for (let j = i; j < i + W; j++) s += left[j] * left[j] + right[j] * right[j];
          if (10 * Math.log10(s / (2 * W) + 1e-20) < -50)
            silence = Math.max(silence, (run += 0.05));
          else run = 0;
        }

        // Bass: the share of energy below 150 Hz while the bass plays.
        const mono = new Float32Array(frames);
        for (let i = 0; i < frames; i++) mono[i] = 0.5 * (left[i] + right[i]);
        const low = lowpass(mono, 150);
        let all = 0;
        let lo = 0;
        for (const s of d.sections) {
          if (!s.parts.includes('bass')) continue;
          for (let i = Math.floor(s.at * SR); i < Math.min(frames, s.end * SR); i++) {
            all += mono[i] * mono[i];
            lo += low[i] * low[i];
          }
        }
        const bassDb = all > 0 ? 10 * Math.log10(lo / all) : -Infinity;

        if (process.env.COMPOSE_LOG)
          console.log(
            `${name} (${p.meta.title}): ${loud.lufs.toFixed(1)} LUFS, peak ${loud.samplePeakDb.toFixed(1)} dBFS, ` +
              `true peak ${loud.truePeakDb.toFixed(1)} dBTP, longest silence ${silence.toFixed(2)} s, ` +
              `bass ${bassDb.toFixed(1)} dB below 150 Hz`,
          );
        expect(loud.samplePeakDb, 'no clipping').toBeLessThanOrEqual(-0.5);
        expect(loud.lufs).toBeGreaterThan(-26);
        expect(loud.lufs).toBeLessThan(-12);
        expect(silence).toBeLessThan(1);
        if (brief.parts!.includes('bass')) expect(bassDb).toBeGreaterThan(-14);
      },
      60_000,
    );
  }
});
