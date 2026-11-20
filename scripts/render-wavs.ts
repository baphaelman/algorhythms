// Renders listening WAVs (24-bit, 48 kHz) into renders/: `pnpm render:wavs`.
// Launched by scripts/render-wavs.mjs.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { renderOffline, exportFrameCount } from '../src/audio/offline';
import { WavEncoder, wavHeader } from '../src/audio/wav';
import { compile } from '../src/core/compiler/compile';
import { generate, type GenerateMode } from '../src/core/generate';
import { parsePiece } from '../src/core/schema';
import type { Piece } from '../src/core/types';

const SAMPLE_RATE = 48000;
const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = join(root, 'renders');
mkdirSync(outDir, { recursive: true });

const modes: GenerateMode[] = ['dorian', 'aeolian', 'lydian', 'pentatonic', 'dorian'];
const pieces: { name: string; make: () => Piece }[] = [];
modes.forEach((mode, i) =>
  pieces.push({ name: `gen-${i + 1}-${mode}`, make: () => generate(i + 1, { mode }) }),
);
const exDir = join(root, 'examples');
for (const f of readdirSync(exDir)
  .filter((n) => n.endsWith('.algorhythms.json'))
  .sort()) {
  pieces.push({
    name: `example-${basename(f, '.algorhythms.json')}`,
    make: () => {
      const r = parsePiece(JSON.parse(readFileSync(join(exDir, f), 'utf8')));
      if (!r.ok) throw new Error(`parse failed: ${r.errors.join('; ')}`);
      return r.piece;
    },
  });
}

for (const { name, make } of pieces) {
  try {
    const piece = make();
    const score = compile(piece);
    const input = { score, mix: piece.mix, timbres: piece.timbres, sampleRate: SAMPLE_RATE };
    const frames = exportFrameCount(score, piece.mix, SAMPLE_RATE);
    const { left, right } = renderOffline(input, frames);
    let peak = 0;
    for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    const format = { sampleRate: SAMPLE_RATE, bitDepth: 24, channels: 2 } as const;
    const enc = new WavEncoder(format, score.seed);
    const file = join(outDir, `${name}.wav`);
    writeFileSync(
      file,
      Buffer.concat([wavHeader(format, frames), enc.encode(left, right, frames)]),
    );
    const db = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
    process.stdout.write(
      `${file}  ${(frames / SAMPLE_RATE).toFixed(1)} s  peak ${db.toFixed(2)} dBFS\n`,
    );
  } catch (e) {
    process.stdout.write(`SKIPPED ${name}: ${e instanceof Error ? e.message : String(e)}\n`);
  }
}
