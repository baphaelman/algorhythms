// Writes examples/compositions/*.algorhythms.json from the generators here (docs/composing.md §1):
// `node scripts/compositions/build.mjs`. Vite's module runner loads the TypeScript. Numbers are
// stored canonical (core/canonical.ts), as the app's loader rounds them, so files round-trip.
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { URL, fileURLToPath } from 'node:url';
import { format, resolveConfig } from 'prettier';
import { runnerImport } from 'vite';

const root = fileURLToPath(new URL('../..', import.meta.url));
const load = async (f) =>
  (await runnerImport(fileURLToPath(new URL(f, import.meta.url)), { root, logLevel: 'error' }))
    .module;
const { canonicalPiece } = await load('../../src/core/canonical.ts');
const songs = {
  'harbour-song': (await load('./harbour-song.ts')).harbourSong,
  'night-ferry': (await load('./night-ferry.ts')).nightFerry,
  'kite-day': (await load('./kite-day.ts')).kiteDay,
  'porch-light': (await load('./porch-light.ts')).porchLight,
  'tide-pools': (await load('./tide-pools.ts')).tidePools,
  interference: (await load('./interference.ts')).interference,
  switchyard: (await load('./switchyard.ts')).switchyard,
  'little-round': (await load('./little-round.ts')).littleRound,
};
for (const [name, make] of Object.entries(songs)) {
  const file = fileURLToPath(
    new URL(`../../examples/compositions/${name}.algorhythms.json`, import.meta.url),
  );
  const options = { ...(await resolveConfig(file)), filepath: file };
  writeFileSync(file, await format(JSON.stringify(canonicalPiece(make())), options));
  process.stdout.write(`Wrote ${file}\n`);
}
