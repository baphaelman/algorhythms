/**
 * The bundled example pieces (CC0). PLAN.md §11.1. Three groups in the menu, in this order:
 * - Songs: examples/songs/*.algorhythms.json, pieces meant as music;
 * - Experiments: examples/experiments/*.algorhythms.json, pieces that try an idea;
 * - Originals: examples/*.algorhythms.json, the first handmade examples.
 */

const originals = import.meta.glob('../../examples/*.algorhythms.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

const songs = import.meta.glob('../../examples/songs/*.algorhythms.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

const experiments = import.meta.glob('../../examples/experiments/*.algorhythms.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

/** Which menu group an example belongs to. */
export type ExampleGroup = 'songs' | 'experiments' | 'originals';

/** One bundled example, not yet parsed (parse with `parsePiece`). */
export interface Example {
  /** File stem, e.g. `tidewater-hymn`. */
  id: string;
  /** `meta.title`. */
  title: string;
  /** Number of voices in the pool. */
  voices: number;
  group: ExampleGroup;
  json: unknown;
}

function describe(path: string, json: unknown, group: ExampleGroup): Example {
  const id = path.replace(/^.*\//, '').replace(/\.algorhythms\.json$/, '');
  const obj = (json ?? {}) as { meta?: { title?: unknown }; voices?: unknown[] };
  return {
    id,
    title: typeof obj.meta?.title === 'string' ? obj.meta.title : id,
    voices: Array.isArray(obj.voices) ? obj.voices.length : 0,
    group,
    json,
  };
}

/** Pieces pinned to the top of their group (they sit in Experiments), in this order (owner, 2026-11-23). */
export const PINNED: readonly string[] = ['crease', 'night-sleeper'];

function pinRank(id: string): number {
  const i = PINNED.indexOf(id);
  return i < 0 ? PINNED.length : i;
}

function list(modules: Record<string, unknown>, group: ExampleGroup): Example[] {
  return Object.entries(modules)
    .map(([path, json]) => describe(path, json, group))
    .sort((a, b) => pinRank(a.id) - pinRank(b.id) || a.title.localeCompare(b.title));
}

/** The original examples, sorted by title. */
export const ORIGINALS: readonly Example[] = list(originals, 'originals');

/** The songs, sorted by title. */
export const SONGS: readonly Example[] = list(songs, 'songs');

/** The experiments: the pinned ones first, then by title. */
export const EXPERIMENTS: readonly Example[] = list(experiments, 'experiments');

/** Every example in menu order: songs, experiments, originals. */
export const EXAMPLES: readonly Example[] = [...SONGS, ...EXPERIMENTS, ...ORIGINALS];

/** The example `/` opens with (loaded, not playing). Owner, 2026-11-20: Kite Day. */
export const FEATURED_ID = 'kite-day';

/** The example named by `?example=<id>` in the page URL, if any. */
function requestedId(): string | null {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('example');
  } catch {
    return null;
  }
}

/**
 * The example `/` opens with: `?example=<id>` when it names one (a link to a song; the e2e specs
 * use it to keep their fixture), else the featured example, else the first one.
 */
export function featuredExample(): Example {
  const want = requestedId();
  const hit =
    (want !== null ? EXAMPLES.find((e) => e.id === want) : undefined) ??
    EXAMPLES.find((e) => e.id === FEATURED_ID) ??
    EXAMPLES[0];
  if (!hit) throw new Error('No example pieces are bundled.');
  return hit;
}
