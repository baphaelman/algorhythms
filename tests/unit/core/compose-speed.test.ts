/**
 * Speed (PLAN §15 M12 "Speed"): the pace of change, not the tempo or the figures. Over 50 seeds
 * per mood, Slow holds chords longer, glides and fades for longer and has longer sections than
 * Medium, and Medium than Fast; the round-2 mood rules hold at every speed; the form stays an
 * intro, sections and an outro at every length.
 */
import { describe, expect, it } from 'vitest';
import {
  MOODS,
  SPEEDS,
  resolveBrief,
  type ComposeLength,
  type Mood,
  type Speed,
} from '../../../src/core/compose-brief';
import { PART_NAME, composeDirectedWithBrief } from '../../../src/core/compose-directed';
import { composedPiece } from '../../../src/core/generate';
import { arpShare, mean, paceOf, quickest, type PaceOfChange } from './compose-metrics';

const N = 50;
const SLOW: readonly Mood[] = ['dark', 'calm', 'dreamy'];
const BOUNCY = new Set(['pluck', 'marimba', 'epiano']);

describe('Speed (PLAN M12)', { timeout: 180_000 }, () => {
  it('orders chord, transition and section lengths Slow > Medium > Fast in every mood; the mood rules hold', () => {
    for (const mood of MOODS) {
      const by = new Map<Speed, PaceOfChange[]>();
      for (const speed of SPEEDS) {
        const list: PaceOfChange[] = [];
        for (let seed = 1; seed <= N; seed++) {
          const d = composeDirectedWithBrief({ seed, mood, speed });
          const p = composedPiece(d.composition);
          const what = `${speed} ${p.meta.title}`;
          list.push(paceOf(d, p));
          // Round 2: figures and sounds stay with the mood.
          const beat = 60 / p.view.gridBpm!;
          expect(arpShare(p), what).toBeLessThanOrEqual(1 / 3);
          expect(
            p.voices.some((v) => v.timbre === 'wobble'),
            what,
          ).toBe(false);
          if (mood === 'dark') expect(p.view.gridBpm!, what).toBeLessThanOrEqual(80);
          if (SLOW.includes(mood)) {
            expect(quickest(p), what).toBeGreaterThanOrEqual(beat / 2 - 1e-3);
            for (const v of p.voices)
              if (v.part === PART_NAME.chords || v.part === PART_NAME.pulse)
                expect(BOUNCY.has(v.timbre), `${what} ${v.part} ${v.timbre}`).toBe(false);
          }
        }
        by.set(speed, list);
      }
      for (const k of ['chord', 'glide', 'fade', 'section'] as const) {
        const [s, m, f] = SPEEDS.map((sp) => mean(by.get(sp)!.map((x) => x[k])));
        expect(s, `${mood} ${k}: slow ${s} > medium ${m}`).toBeGreaterThan(m);
        expect(m, `${mood} ${k}: medium ${m} > fast ${f}`).toBeGreaterThan(f);
      }
    }
  });

  it('is not the tempo: the same seed and mood keeps its tempo, key and sounds at every speed', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const [a, b, c] = SPEEDS.map((speed) => resolveBrief({ seed, mood: 'dark', speed }));
      for (const x of [b, c]) {
        expect(x.tempo).toBe(a.tempo);
        expect(x.key).toEqual(a.key);
        expect(x.sounds).toEqual(a.sounds);
      }
      expect(a.speed).toBeLessThan(b.speed);
      expect(b.speed).toBeLessThan(c.speed);
    }
  });

  it('Surprise draws it from the mood: Dark and Dreamy lean slow, Driving fast', () => {
    const avg = (mood: Mood) =>
      mean(Array.from({ length: N }, (_, i) => resolveBrief({ seed: i + 1, mood }).speed));
    expect(avg('dark')).toBeLessThan(avg('calm'));
    expect(avg('dreamy')).toBeLessThan(avg('calm'));
    expect(avg('calm')).toBeLessThan(avg('bright'));
    expect(avg('bright')).toBeLessThan(avg('driving'));
    // A continuous range, not three points.
    const all = new Set(Array.from({ length: N }, (_, i) => resolveBrief({ seed: i + 1 }).speed));
    expect(all.size).toBeGreaterThan(40);
  });

  it('keeps the length and the form (intro, sections, outro) at every length and speed', () => {
    for (const length of [60, 120, 180, 300] as ComposeLength[]) {
      for (const speed of [...SPEEDS, undefined]) {
        for (const mood of ['dark', 'driving'] as const) {
          for (let seed = 1; seed <= 4; seed++) {
            const d = composeDirectedWithBrief({ seed, mood, length, ...(speed ? { speed } : {}) });
            const what = `${length} ${speed} ${mood} ${seed}`;
            const names = d.sections.map((s) => s.name);
            expect(names[0], what).toBe('Intro');
            expect(names[names.length - 1], what).toBe('Outro');
            expect(names.length, what).toBeGreaterThanOrEqual(3);
            const end = d.sections[d.sections.length - 1].end;
            expect(Math.abs(end - length) / length, what).toBeLessThanOrEqual(0.05);
            // No outro longer than the longest body section.
            const bar = (60 / d.resolved.tempo) * d.resolved.meter;
            const outro = d.sections[d.sections.length - 1];
            const body = d.sections.slice(1, -1).map((s) => s.end - s.at);
            expect(outro.end - outro.at, what).toBeLessThanOrEqual(
              Math.max(...body, 8 * bar) + 1e-3,
            );
          }
        }
      }
    }
  });
});
