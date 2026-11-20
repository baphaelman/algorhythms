import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT_FORM, type ExportForm } from '../../../src/app/export-options';
import { estimateExport, runMidi, type ExportSource } from '../../../src/app/export-run';
import { compile } from '../../../src/core/compiler/compile';
import { generate } from '../../../src/core/generate';

const form = (over: Partial<ExportForm> = {}): ExportForm => ({ ...DEFAULT_EXPORT_FORM, ...over });

function source(voices: number): ExportSource {
  const piece = generate(11, { mode: 'dorian', voices, length: 100 });
  return {
    piece: { ...piece, meta: { ...piece.meta, title: 'Test: piece' } },
    compiled: compile(piece),
  };
}

const head = async (b: Blob, n: number): Promise<number[]> => [
  ...new Uint8Array(await b.slice(0, n).arrayBuffer()),
];

describe('estimateExport', () => {
  const src = source(4);

  it('WAV size follows the bit depth and rate', () => {
    const f32 = estimateExport(src, form({ format: 'wav', bitDepth: 32 }))!;
    const f16 = estimateExport(src, form({ format: 'wav', bitDepth: 16 }))!;
    const r44 = estimateExport(src, form({ format: 'wav', bitDepth: 32, sampleRate: 44100 }))!;
    expect(f32.bytes).toBeGreaterThan(f16.bytes * 1.9);
    expect(f32.bytes).toBeGreaterThan(r44.bytes);
    expect(f32.files).toBe(1);
    expect(f32.large).toBe(false);
  });

  it('stems size counts every file and shrinks with mono', () => {
    const stereo = estimateExport(src, form({ format: 'stems' }))!;
    const mono = estimateExport(src, form({ format: 'stems', mono: true }))!;
    expect(stereo.files).toBeGreaterThanOrEqual(src.piece.voices.length);
    expect(mono.bytes).toBeLessThan(stereo.bytes);
    expect(stereo.large).toBe(false);
  });

  it('flags a large stems export', () => {
    const long = generate(3, { mode: 'dorian', voices: 32, length: 900 });
    const big = estimateExport(
      { piece: long, compiled: compile(long) },
      form({ format: 'stems', bitDepth: 32 }),
    )!;
    expect(big.bytes).toBeGreaterThan(1e9);
    expect(big.large).toBe(true);
  });

  it('has no estimate for MIDI', () => {
    expect(estimateExport(src, form({ format: 'midi' }))).toBeNull();
  });
});

describe('runMidi', () => {
  it('makes one .mid named after the title', async () => {
    const out = runMidi(source(4), form({ format: 'midi' }));
    expect(out.name).toBe('Test-piece.mid');
    expect(out.files).toBe(1);
    expect(out.blob!.size).toBe(out.bytes);
    expect(String.fromCharCode(...(await head(out.blob!, 4)))).toBe('MThd');
  });

  it('names the other layouts', () => {
    expect(runMidi(source(3), form({ format: 'midi', midiMode: 'notesOnly' })).name).toBe(
      'Test-piece-notes.mid',
    );
    expect(runMidi(source(3), form({ format: 'midi', midiMode: 'mpe' })).name).toBe(
      'Test-piece-mpe.mid',
    );
  });

  it('zips several MPE files together', async () => {
    const out = runMidi(source(20), form({ format: 'midi', midiMode: 'mpe' }));
    expect(out.files).toBe(2);
    expect(out.name).toBe('Test-piece-midi.zip');
    expect(await head(out.blob!, 2)).toEqual([0x50, 0x4b]);
  });
});
