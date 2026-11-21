/**
 * M6-c presets (PLAN.md §8.5 "further presets", §15 M6), measured on offline renders, never by
 * ear:
 * - level: RMS on a reference phrase (three lines gliding and arriving) within ±3 dB of the
 *   median of the older presets of the same kind (held, or struck: articulation ≥ 0.5);
 * - clicks: the detector over the phrase (glides, crisp strikes) stays within the worst of the
 *   existing struck presets (pluck, bell);
 * - aliasing: held high notes, power away from the expected components under −50 dB.
 * The transport suite (seek, loop, pause) covers them in clicks.test.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import { DRY_MIX, makeScore, type VoiceSpec } from '../../src/audio/fixtures/scores';
import { renderOffline } from '../../src/audio/offline';
import { BUILTIN_TIMBRES } from '../../src/core/timbres';
import type { Timbre } from '../../src/core/types';
import { BLOCK_FRAMES } from '../../src/dsp/constants';
import { buildWavetables } from '../../src/dsp/wavetable';
import { allFinite, clickScore, RATE, stereoRms } from './helpers';
import { peakNear, powerSpectrum, strayShare } from './spectrum';

vi.setConfig({ testTimeout: 60_000 });

const M6C_PRESETS = ['epiano', 'flute', 'marimba', 'brass'] as const;
const OLD = Object.keys(BUILTIN_TIMBRES).filter(
  (n) => !(M6C_PRESETS as readonly string[]).includes(n),
);
const NYQ = RATE / 2;
const db = (x: number) => 20 * Math.log10(x);
const hz = (p: number) => 440 * Math.pow(2, (p - 69) / 12);

/** Three lines that glide and arrive every 1.5 s or so, over two octaves: 10 s. */
const PHRASE: VoiceSpec[] = [
  { start: 45, moves: [52, 48, 50, 45, 43].map((to, i) => ({ at: 0.8 + 1.7 * i, to, len: 0.6 })) },
  { start: 57, moves: [60, 64, 62, 59, 57].map((to, i) => ({ at: 1.1 + 1.6 * i, to, len: 0.5 })) },
  { start: 69, moves: [72, 67, 74, 71, 76].map((to, i) => ({ at: 0.5 + 1.5 * i, to, len: 0.4 })) },
];
const PHRASE_END = 10;

function phrase(name: string): { left: Float32Array; right: Float32Array } {
  const score = makeScore(
    PHRASE.map((v) => ({ ...v, timbre: name })),
    PHRASE_END,
  );
  const frames = Math.ceil((PHRASE_END * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;
  return renderOffline({ score, mix: DRY_MIX, sampleRate: RATE }, frames);
}

const renders = new Map<string, { left: Float32Array; right: Float32Array }>();
const phraseOf = (name: string) => {
  let r = renders.get(name);
  if (!r) renders.set(name, (r = phrase(name)));
  return r;
};

describe('M6-c presets', () => {
  it('are valid, use an M6 path, and leave the older presets alone', () => {
    for (const n of M6C_PRESETS) {
      const t = BUILTIN_TIMBRES[n];
      expect(t, n).toBeDefined();
      expect(t.fm !== undefined || t.noise !== undefined || t.stretch !== 0, n).toBe(true);
    }
    expect(OLD).toEqual(['sine', 'glass', 'organ', 'reed', 'choir', 'pluck', 'wobble', 'bell']);
  });

  it('sit within ±3 dB RMS of the older presets of their kind on a reference phrase', () => {
    // A strike never rises above the held level of a sustained tone, so struck presets
    // (articulation ≥ 0.5) are quieter by design; each kind is compared with its own.
    const struck = (n: string) => BUILTIN_TIMBRES[n].articulation.amount >= 0.5;
    const level = (n: string) => db(stereoRms(phraseOf(n), 0.5, PHRASE_END - 0.5));
    const median = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    };
    const ref = {
      held: median(OLD.filter((n) => !struck(n)).map(level)),
      struck: median(OLD.filter(struck).map(level)),
    };
    const rel = M6C_PRESETS.map((n) => level(n) - ref[struck(n) ? 'struck' : 'held']);
    const rows = [
      `older medians: held ${ref.held.toFixed(2)}, struck ${ref.struck.toFixed(2)} dBFS`,
    ];
    M6C_PRESETS.forEach((n, i) =>
      rows.push(`${n} ${rel[i] >= 0 ? '+' : ''}${rel[i].toFixed(2)} dB`),
    );
    console.info(`M6-c levels: ${rows.join(', ')}`);
    M6C_PRESETS.forEach((n, i) => expect(Math.abs(rel[i]), n).toBeLessThan(3));
  });

  it('stay click-free over glides and strikes', () => {
    const worst = (n: string) => {
      const r = phraseOf(n);
      expect(allFinite(r.left) && allFinite(r.right), n).toBe(true);
      return Math.max(clickScore(r.left, 480).ratio, clickScore(r.right, 480).ratio);
    };
    const ref = Math.max(worst('pluck'), worst('bell'));
    const rows = [`pluck/bell ${ref.toFixed(3)}`];
    const ws = M6C_PRESETS.map(worst);
    M6C_PRESETS.forEach((n, i) => rows.push(`${n} ${ws[i].toFixed(3)}`));
    console.info(`M6-c click detector: ${rows.join(', ')}`);
    M6C_PRESETS.forEach((n, i) => expect(ws[i], n).toBeLessThanOrEqual(ref));
  });

  it('keep aliasing under −50 dB on held high notes', () => {
    const N = 65536;
    const from = Math.round(0.3 * RATE);
    const rows: string[] = [];
    for (const n of M6C_PRESETS) {
      // Noise is broadband by design, and a strike or vibrato widens each line past the guard.
      const t: Timbre = {
        ...BUILTIN_TIMBRES[n],
        noise: undefined,
        articulation: { amount: 0, attack: 0.01, decay: 0.2 },
        vibrato: { rate: 5, depthCents: 0, delay: 0.5 },
        drift: undefined,
        detuneSpread: 0,
      };
      const ratios = Array.from(buildWavetables(t, RATE).partialRatio);
      for (const p of [96, 102, 108]) {
        const score = makeScore([{ start: p, timbre: 'x' }], 2.5);
        const frames = Math.ceil((2 * RATE) / BLOCK_FRAMES) * BLOCK_FRAMES;
        const x = renderOffline(
          { score, mix: DRY_MIX, timbres: { x: t }, sampleRate: RATE },
          frames,
        ).left;
        const fc = peakNear(x, hz(p), 0.004 * hz(p), RATE, from, 16384).hz;
        // Harmonic timbres: every harmonic below Nyquist; stretched: the partial ratios. FM adds
        // sidebands at k·fm around each.
        const base = t.stretch !== 0 ? ratios : Array.from({ length: 64 }, (_, i) => i + 1);
        const fm = t.fm ? t.fm.ratio * fc : 0;
        const comps: number[] = [];
        for (const r of base) {
          for (let k = t.fm ? -60 : 0; k <= (t.fm ? 60 : 0); k++) {
            const f = Math.abs(r * fc + k * fm);
            if (f < NYQ) comps.push(f);
          }
        }
        const stray = db(Math.sqrt(strayShare(powerSpectrum(x, from, N), comps, RATE)));
        rows.push(`${n} p${p} ${stray.toFixed(1)} dB`);
        expect(stray, `${n} p${p}`).toBeLessThan(-50);
      }
    }
    console.info(`M6-c stray power: ${rows.join(', ')}`);
  });
});
