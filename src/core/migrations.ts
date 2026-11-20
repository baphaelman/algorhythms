/**
 * Forward-only file-format migrations (PLAN.md §5).
 *
 * A registry maps a version v to the step that turns a v file into a v + 1 file. Steps run on raw
 * JSON before the schema sees it, one version at a time, until the file reaches PIECE_VERSION.
 * There is no way back: a build never rewrites a file into an older format.
 *
 * Version 1 is the first format, so the registry is empty for now. When a format change ships,
 * add a step keyed on the old version, and keep every earlier step.
 */

import { PIECE_VERSION } from './types';

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

/** The shipped migrations: none yet, since version 1 is the first file format. */
export const DEFAULT_MIGRATIONS: MigrationRegistry = migrationRegistry([]);

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
