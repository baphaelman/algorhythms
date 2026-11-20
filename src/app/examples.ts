/** The bundled example pieces (examples/*.algorhythms.json, CC0). PLAN.md §11.1. */

const modules = import.meta.glob('../../examples/*.algorhythms.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>;

/** One bundled example, not yet parsed (parse with `parsePiece`). */
export interface Example {
  /** File stem, e.g. `tidewater-hymn`. */
  id: string;
  /** `meta.title`. */
  title: string;
  /** Number of voices in the pool. */
  voices: number;
  json: unknown;
}

function describe(path: string, json: unknown): Example {
  const id = path.replace(/^.*\//, '').replace(/\.algorhythms\.json$/, '');
  const obj = (json ?? {}) as { meta?: { title?: unknown }; voices?: unknown[] };
  return {
    id,
    title: typeof obj.meta?.title === 'string' ? obj.meta.title : id,
    voices: Array.isArray(obj.voices) ? obj.voices.length : 0,
    json,
  };
}

/** All examples, sorted by title. */
export const EXAMPLES: readonly Example[] = Object.entries(modules)
  .map(([path, json]) => describe(path, json))
  .sort((a, b) => a.title.localeCompare(b.title));

/** The example `/` opens with (loaded, not playing). */
export const FEATURED_ID = 'tidewater-hymn';

/** The featured example (falls back to the first one). */
export function featuredExample(): Example {
  const hit = EXAMPLES.find((e) => e.id === FEATURED_ID) ?? EXAMPLES[0];
  if (!hit) throw new Error('No example pieces are bundled.');
  return hit;
}
