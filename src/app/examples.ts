/**
 * The bundled example pieces (CC0). PLAN.md §11.1. Two groups in the menu:
 * - Originals: examples/*.algorhythms.json, the first handmade examples;
 * - Compositions: examples/compositions/*.algorhythms.json, songs written with the instrument.
 */

const originals = import.meta.glob('../../examples/*.algorhythms.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

const compositions = import.meta.glob('../../examples/compositions/*.algorhythms.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

/** Which menu group an example belongs to. */
export type ExampleGroup = 'originals' | 'compositions';

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

/** Compositions pinned to the top of their group, in this order (owner, 2026-11-23). */
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

/** The compositions: the pinned ones first, then by title. */
export const COMPOSITIONS: readonly Example[] = list(compositions, 'compositions');

/** Every example: originals first, then compositions. */
export const EXAMPLES: readonly Example[] = [...ORIGINALS, ...COMPOSITIONS];

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
