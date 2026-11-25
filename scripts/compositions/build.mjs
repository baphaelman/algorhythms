// Writes examples/{songs,experiments}/*.algorhythms.json from the generators here (docs/composing.md §1);
// each generator exports `kind` ('song' | 'experiment'), which picks the folder:
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
const FOLDERS = { song: 'songs', experiment: 'experiments' };
const piece = async (f, fn) => {
  const m = await load(f);
  return { make: m[fn], folder: FOLDERS[m.kind] };
};
const pieces = {
  'harbour-song': await piece('./harbour-song.ts', 'harbourSong'),
  'night-ferry': await piece('./night-ferry.ts', 'nightFerry'),
  'kite-day': await piece('./kite-day.ts', 'kiteDay'),
  'porch-light': await piece('./porch-light.ts', 'porchLight'),
  'tide-pools': await piece('./tide-pools.ts', 'tidePools'),
  interference: await piece('./interference.ts', 'interference'),
  switchyard: await piece('./switchyard.ts', 'switchyard'),
  'little-round': await piece('./little-round.ts', 'littleRound'),
  moonwater: await piece('./moonwater.ts', 'moonwater'),
  'sunday-lane': await piece('./sunday-lane.ts', 'sundayLane'),
  'night-sleeper': await piece('./night-sleeper.ts', 'nightSleeper'),
  crease: await piece('./crease.ts', 'crease'),
  'late-bloom': await piece('./late-bloom.ts', 'lateBloom'),
};
for (const [name, { make, folder }] of Object.entries(pieces)) {
  const file = fileURLToPath(
    new URL(`../../examples/${folder}/${name}.algorhythms.json`, import.meta.url),
  );
  const options = { ...(await resolveConfig(file)), filepath: file };
  writeFileSync(file, await format(JSON.stringify(canonicalPiece(make())), options));
  process.stdout.write(`Wrote ${file}\n`);
}
