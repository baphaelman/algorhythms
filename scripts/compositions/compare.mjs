// Compares the compositions with an earlier version: `node scripts/compositions/compare.mjs
// <old-dir> <out-dir> [song|all] [variant]`. See compare.ts; WAVs go to <out-dir>.
import { mkdirSync } from 'node:fs';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { runnerImport } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));
const load = async (f) =>
  (await runnerImport(fileURLToPath(new URL(f, import.meta.url)), { root, logLevel: 'error' }))
    .module;
const { compareSong } = await load('./compare.ts');
const [oldDir, outDir, only, variant] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const newDir = fileURLToPath(new URL('../../examples/compositions', import.meta.url));

const bars = (bpm, meter, list) =>
  list.map(([name, a, b, step]) => ({
    name,
    from: (a * meter * 60) / bpm,
    to: (b * meter * 60) / bpm,
    step: step && (step * 60) / bpm,
  }));
const songs = {
  'harbour-song': {
    gen: './harbour-song.ts',
    fn: 'harbourSong',
    shift: 0.5,
    chordLag: 0.65,
    parts: ['Melody', 'Chords', 'Chords', 'Chords', 'Chords', 'Bass', 'Sparkle', 'Sparkle'],
    sections: bars(72, 4, [
      ['intro+A', 0, 10],
      ["A'", 10, 19],
      ['B (pulse)', 19, 28, 0.5],
      ["A'' (pulse)", 28, 36, 0.5],
      ['coda', 36, 41],
    ]),
  },
  'night-ferry': {
    gen: './night-ferry.ts',
    fn: 'nightFerry',
    shift: 0.4,
    chordLag: 0.22,
    parts: ['Melody', 'Chords', 'Chords', 'Chords', 'Chords', 'Chords', 'Bass'],
    sections: bars(168, 6, [
      ['intro', 0, 4, 1],
      ['verse', 4, 20, 1],
      ['chorus', 20, 36, 1],
      ['verse 2', 36, 44, 1],
      ['chorus 2', 44, 60, 1],
      ['outro', 60, 66, 1],
    ]),
  },
  'kite-day': {
    gen: './kite-day.ts',
    fn: 'kiteDay',
    shift: 0.3,
    chordLag: 0.55,
    parts: [
      'Melody',
      'Chords',
      'Chords',
      'Chords',
      'Chords',
      'Bass',
      'Sparkle',
      'Sparkle',
      'Sparkle',
    ],
    sections: bars(100, 4, [
      ['intro+A', 0, 12],
      ['B', 12, 20],
      ["A' (pulse)", 20, 28, 1],
      ["B' (pulse)", 28, 36, 1],
      ['outro', 36, 41],
    ]),
  },
};
for (const [name, c] of Object.entries(songs)) {
  if (only && only !== 'all' && only !== name) continue;
  // A variant, e.g. `decay=0.6,strike=1,arp=pluck`: the generator's options, rendered in memory.
  let extra;
  if (variant) {
    const opts = Object.fromEntries(
      variant.split(',').map((kv) => {
        const [k, v] = kv.split('=');
        return [k, k === 'arp' ? v : k === 'strike' ? v === '1' : Number(v)];
      }),
    );
    const make = (await load(c.gen))[c.fn];
    const { parsePiece } = await load('../../src/core/schema.ts');
    extra = { tag: variant.replace(/[=,]/g, '-'), piece: parsePiece(make(opts)).piece };
  }
  process.stdout.write(
    (await compareSong(
      name,
      oldDir,
      newDir,
      outDir,
      c.shift,
      c.parts,
      c.sections,
      extra,
      c.chordLag,
    )) + '\n',
  );
}
