// Listening links (M12): composes contrasting briefs plus an all-Surprise one, and prints a share
// link to the live site for each, with the brief in words: `pnpm compose:links`.
// Launched by scripts/compose-links.mjs.

import { decodeShareLink, encodeShareLink } from '../src/app/share';
import { canonicalPiece } from '../src/core/canonical';
import {
  MOOD_LABEL,
  PART_LABEL,
  SHAPE_LABEL,
  SPEED_LABEL,
  type ComposeBrief,
} from '../src/core/compose-brief';
import { composeDirectedPiece } from '../src/core/compose-directed';
import { jsonEqual, parsePiece } from '../src/core/schema';

const SITE = 'https://baphaelman.github.io/algorhythms/';
const LIMIT = 2000;
const NOTE = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

const briefs: ComposeBrief[] = [
  { seed: 101, mood: 'calm', length: 120, shape: 'steady', parts: ['chords', 'melody', 'bells'] },
  { seed: 202, mood: 'driving', length: 180, shape: 'build' },
  {
    seed: 303,
    mood: 'dreamy',
    length: 120,
    shape: 'arc',
    start: { kind: 'progression', name: 'I–V–vi–iii–IV–I–IV–V' },
  },
  {
    seed: 404,
    mood: 'dark',
    length: 180,
    shape: 'journey',
    speed: 'slow',
    parts: ['chords', 'bass', 'pulse'],
  },
  {
    seed: 505,
    mood: 'bright',
    length: 60,
    shape: 'arc',
    start: { kind: 'progression', name: 'I–V–vi–IV' },
    key: { tonic: 2, mode: 'major' },
    tempo: 112,
  },
  { seed: 606 },
];

function words(b: ComposeBrief): string {
  const s = (x: string | undefined) => x ?? 'Surprise me';
  const start =
    b.start === undefined
      ? 'Surprise me'
      : b.start.kind === 'progression'
        ? b.start.name
        : b.start.kind;
  return [
    `Mood ${s(b.mood && MOOD_LABEL[b.mood])}`,
    `Length ${b.length ? `${b.length / 60} min` : 'Surprise me'}`,
    `Shape ${s(b.shape && SHAPE_LABEL[b.shape])}`,
    `Speed ${s(b.speed && SPEED_LABEL[b.speed])}`,
    `Parts ${b.parts ? b.parts.map((p) => PART_LABEL[p]).join(' + ') : 'Surprise me'}`,
    `Start from ${start}`,
    ...(b.key ? [`Key ${NOTE[b.key.tonic]} ${b.key.mode}`] : []),
    ...(b.tempo ? [`Tempo ${b.tempo}`] : []),
    `seed ${b.seed}`,
  ].join(' · ');
}

for (const b of briefs) {
  const piece = canonicalPiece(composeDirectedPiece(b));
  const link = await encodeShareLink(piece, SITE);
  // The link opens this exact piece.
  const back = parsePiece(await decodeShareLink(link));
  if (!back.ok || !jsonEqual(back.piece.moments, piece.moments))
    throw new Error(`${piece.meta.title}: the link does not round-trip`);
  const over = link.length > LIMIT ? ` OVER ${LIMIT}` : '';
  console.log(`${piece.meta.title}: ${words(b)} (${link.length} chars${over})\n${link}\n`);
}
