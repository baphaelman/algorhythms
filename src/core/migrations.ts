/**
 * Forward-only file-format migrations (PLAN.md §5).
 *
 * A registry maps a version v to the step that turns a v file into a v + 1 file. Steps run on raw
 * JSON before the schema sees it, one version at a time, until the file reaches PIECE_VERSION.
 * There is no way back: a build never rewrites a file into an older format.
 *
 * When a format change ships, add a step keyed on the old version, and keep every earlier step.
 *
 * - 1 → 2 (M4.5-27, "the start is a moment"): `start` becomes an establishing `chord` at t = 0
 *   (`startChord`). Later additions of optional fields (e.g. `VoiceDef.part`, rev 9) need no step.
 */

import { DEFAULT_POOL_SIZE } from './defaults';
import { PIECE_VERSION, type ChordMoment, type Pitch, type VoiceId } from './types';

/** One step: reads format `from`, returns format `from + 1`. */
export interface MigrationStep {
  /** The version this step reads. */
  from: number;
  /** What the step changes, for the build log and debugging. */
  description: string;
  /**
   * Returns the piece in format `from + 1`. It receives a private copy, so it may mutate and
   * return its argument. It need not set `version`; the runner does.
   */
  migrate(raw: Record<string, unknown>): Record<string, unknown>;
}

/** Steps keyed by the version they read. */
export type MigrationRegistry = ReadonlyMap<number, MigrationStep>;

/** Builds a registry from steps, rejecting two steps for the same version. */
export function migrationRegistry(steps: readonly MigrationStep[]): MigrationRegistry {
  const map = new Map<number, MigrationStep>();
  for (const step of steps) {
    if (map.has(step.from)) throw new Error(`Two migrations read version ${step.from}.`);
    map.set(step.from, step);
  }
  return map;
}

/** Id of the chord that replaces a version 1 `start`: `start0`, or `start1`… if that is taken. */
function freeStartId(used: ReadonlySet<string>): string {
  let n = 0;
  while (used.has(`start${n}`)) n++;
  return `start${n}`;
}

/**
 * The establishing chord at t = 0 that sounds what a version 1 `start` did (schema v2): each voice
 * on its own pitch, held from 0, no glide (compiler/compile.ts `establish`). `pitches` lists the
 * start pitches in `start` order. A start of the first pool voices in pool order with ascending
 * pitches reads as a plain chord; any other gets `byVoice` (pitch i to the i-th voice), plus a
 * `{ voices }` target when the voices are not the first ones in pool order. Null for an empty
 * start (the piece begins silent).
 */
export function startChord(
  pool: readonly VoiceId[],
  start: readonly { voice: VoiceId; pitch: Pitch }[],
  usedIds: ReadonlySet<string> = new Set(),
): ChordMoment | null {
  if (start.length === 0) return null;
  const pitches = start.map((s) => s.pitch);
  const m: ChordMoment = {
    id: freeStartId(usedIds),
    type: 'chord',
    at: 0,
    notes: { kind: 'pitches', pitches },
    voicing: 'even',
    assign: 'ordered',
  };
  const inPool = start.every((s, i) => s.voice === pool[i]);
  if (!inPool) m.target = { voices: start.map((s) => s.voice) };
  if (!inPool || pitches.some((p, i) => i > 0 && p < pitches[i - 1])) m.byVoice = true;
  return m;
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);

/** 1 → 2: `start` becomes the establishing chord at t = 0 (`startChord`), first in `moments`. */
const V1_START_IS_A_MOMENT: MigrationStep = {
  from: 1,
  description: 'start → an establishing chord at t = 0',
  migrate(raw) {
    const start = raw.start ?? [];
    delete raw.start;
    if (!Array.isArray(start)) throw new Error('start: expected a list of { voice, pitch }.');
    // Version 1 filled a missing pool with v1..v12.
    const pool = Array.isArray(raw.voices)
      ? raw.voices.map((v: unknown) => (isRecord(v) ? String(v.id) : ''))
      : Array.from({ length: DEFAULT_POOL_SIZE }, (_, i) => `v${i + 1}`);
    const seen = new Set<string>();
    const list = start.map((s: unknown, i: number) => {
      if (!isRecord(s) || typeof s.voice !== 'string')
        throw new Error(`start[${i}].voice: expected a voice id.`);
      if (typeof s.pitch !== 'number' || !Number.isFinite(s.pitch))
        throw new Error(`start[${i}].pitch: expected a number.`);
      if (!pool.includes(s.voice))
        throw new Error(`start[${i}].voice: '${s.voice}' is not a voice in the pool.`);
      if (seen.has(s.voice)) throw new Error(`start[${i}].voice: '${s.voice}' is started twice.`);
      seen.add(s.voice);
      return { voice: s.voice, pitch: s.pitch };
    });
    const moments: unknown[] = Array.isArray(raw.moments) ? raw.moments : [];
    const ids = new Set<string>();
    for (const m of moments) if (isRecord(m) && typeof m.id === 'string') ids.add(m.id);
    const chord = startChord(pool, list, ids);
    if (chord) raw.moments = [chord, ...moments];
    return raw;
  },
};

/** The shipped migrations. */
export const DEFAULT_MIGRATIONS: MigrationRegistry = migrationRegistry([V1_START_IS_A_MOMENT]);

/** Result of `migratePiece`. */
export type MigrationResult =
  { ok: true; value: Record<string, unknown>; applied: number[] } | { ok: false; error: string };

/**
 * Runs the steps from `raw.version` up to `target` (PIECE_VERSION by default). `raw` must have an
 * integer `version`; it is not modified. Files already at or above `target` are returned as they
 * are (newer files are never migrated down).
 */
export function migratePiece(
  raw: Record<string, unknown>,
  registry: MigrationRegistry = DEFAULT_MIGRATIONS,
  target: number = PIECE_VERSION,
): MigrationResult {
  const start = raw.version;
  if (typeof start !== 'number' || !Number.isInteger(start)) {
    return { ok: false, error: 'version: expected a whole number (the file-format version).' };
  }
  let value = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
  const applied: number[] = [];
  for (let v = start; v < target; v++) {
    const step = registry.get(v);
    if (!step) {
      return {
        ok: false,
        error: `This piece uses file format ${v}, which this version of AlgoRhythms cannot upgrade.`,
      };
    }
    try {
      value = step.migrate(value);
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `Upgrading from file format ${v} failed: ${why}` };
    }
    value.version = v + 1;
    applied.push(v);
  }
  return { ok: true, value, applied };
}
