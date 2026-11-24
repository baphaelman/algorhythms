/**
 * The built-in flute's breath (PLAN §15 M12, listening notes round 2: "the flute sounds very
 * noisy"): a sustained note's noise-to-tone ratio, low, mid and high, measured offline as the
 * difference between the flute and the same flute without noise (same seed) against the tone.
 * Turned down from −15 dB to about −27 dB: a little breath stays.
 */
import { describe, expect, it } from 'vitest';
import { DRY_MIX, makeScore } from '../../src/audio/fixtures/scores';
import { renderOffline } from '../../src/audio/offline';
import { BUILTIN_TIMBRES } from '../../src/core/timbres';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import { RATE } from './helpers';

function rms(x: Float32Array, a: number, b: number): number {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
}

/** Noise-to-tone ratio (dB) of a held flute note at `pitch`, from 1 s to 3 s. */
function noiseToTone(pitch: number): number {
  const score = makeScore([{ start: pitch, timbre: 'f' }], 4);
  const frames = Math.ceil((3.5 * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;
  const render = (noise: boolean) =>
    renderOffline(
      {
        score,
        mix: DRY_MIX,
        timbres: {
          f: noise ? BUILTIN_TIMBRES.flute : { ...BUILTIN_TIMBRES.flute, noise: undefined },
        },
        sampleRate: RATE,
      },
      frames,
    ).left;
  const withNoise = render(true);
  const tone = render(false);
  const noise = withNoise.map((x, i) => x - tone[i]);
  const a = RATE;
  const b = 3 * RATE;
  return 20 * Math.log10(rms(noise, a, b) / rms(tone, a, b));
}

describe('flute breath', () => {
  it('sits well under the tone in every register, but is still there', () => {
    const rows = [60, 72, 84].map((p) => [p, noiseToTone(p)] as const);
    console.info(
      `flute noise-to-tone: ${rows.map(([p, r]) => `${p} ${r.toFixed(1)} dB`).join(', ')}`,
    );
    for (const [p, r] of rows) {
      expect(r, `${p}`).toBeLessThan(-24);
      expect(r, `${p}`).toBeGreaterThan(-32);
    }
  }, 60_000);
});
