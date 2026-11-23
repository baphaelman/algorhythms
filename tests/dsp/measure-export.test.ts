/**
 * The Export dialog's Loudness display (PLAN.md §12 "Ready for YouTube" → Display): the
 * measure-only render (`measureExport`) sees exactly what a normalised export measures first.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compile } from '../../src/core/compiler/compile';
import { parsePiece } from '../../src/core/schema';
import { measureExport, wavExportChunks } from '../../src/audio/wav-export';
import type { NormalizeReport } from '../../src/dsp/loudness';

function load(file: string) {
  const p = parsePiece(JSON.parse(readFileSync(`examples/${file}.algorhythms.json`, 'utf8')));
  if (!p.ok) throw new Error(p.errors.join('; '));
  return p.piece;
}

describe('measureExport', () => {
  it('equals the input measurement of a normalised export (span and fades included)', () => {
    const piece = load('compositions/kite-day');
    const input = { score: compile(piece), mix: piece.mix, timbres: piece.timbres };
    const span = { start: 12, end: 16 };
    let report: NormalizeReport | undefined;
    for (const _ of wavExportChunks(
      input,
      { sampleRate: 48000, bitDepth: 32, span, loudness: -14 },
      undefined,
      (r) => (report = r),
    ));
    const progress: number[] = [];
    const m = measureExport(input, { sampleRate: 48000, span }, (f) => progress.push(f));
    expect(report).toBeDefined();
    expect(m).toEqual(report!.input);
    expect(m.lufs).toBeLessThan(-10);
    expect(m.lufs).toBeGreaterThan(-40);
    expect(progress.at(-1)).toBe(1);
  });
});
