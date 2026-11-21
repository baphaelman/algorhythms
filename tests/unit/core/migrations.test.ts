/** Unit tests for core/migrations.ts (PLAN.md §5: forward-only, keyed on version). */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MIGRATIONS,
  migratePiece,
  migrationRegistry,
  type MigrationStep,
} from '../../../src/core/migrations';
import { PIECE_VERSION } from '../../../src/core/types';

/** A fake format 0: the title lived at the top level and voices were called "pool". */
const V0_TO_V1: MigrationStep = {
  from: 0,
  description: 'move title into meta; rename pool to voices',
  migrate: (raw) => {
    const { title, pool, ...rest } = raw;
    return { ...rest, meta: { title }, voices: pool };
  },
};

/** A fake format 2 for chain tests: renames `seed` to `pieceSeed`. */
const V1_TO_V2: MigrationStep = {
  from: 1,
  description: 'rename seed',
  migrate: (raw) => {
    raw.pieceSeed = raw.seed;
    delete raw.seed;
    return raw;
  },
};

describe('migratePiece', () => {
  it('ships one step, 1 → 2 (migration-v2.test.ts)', () => {
    expect(PIECE_VERSION).toBe(2);
    expect([...DEFAULT_MIGRATIONS.keys()]).toEqual([1]);
  });

  it('runs a v0 → v1 step and sets the version', () => {
    const raw = { format: 'algorhythms', version: 0, title: 'Old', pool: [{ id: 'v1' }], keep: 1 };
    const r = migratePiece(raw, migrationRegistry([V0_TO_V1]), 1);
    expect(r).toEqual({
      ok: true,
      applied: [0],
      value: {
        format: 'algorhythms',
        version: 1,
        keep: 1,
        meta: { title: 'Old' },
        voices: [{ id: 'v1' }],
      },
    });
  });

  it('chains steps one version at a time, only forward', () => {
    const registry = migrationRegistry([V1_TO_V2, V0_TO_V1]);
    const r = migratePiece({ version: 0, title: 't', pool: [], seed: 9 }, registry, 2);
    expect(r.ok && r.applied).toEqual([0, 1]);
    expect(r.ok && r.value).toEqual({ version: 2, meta: { title: 't' }, voices: [], pieceSeed: 9 });
    // Already current, or newer: nothing runs.
    expect(migratePiece({ version: 2 }, registry, 2)).toEqual({
      ok: true,
      value: { version: 2 },
      applied: [],
    });
    expect(migratePiece({ version: 5 }, registry, 2)).toEqual({
      ok: true,
      value: { version: 5 },
      applied: [],
    });
  });

  it('does not mutate its input', () => {
    const raw = { version: 1, seed: 3 };
    migratePiece(raw, migrationRegistry([V1_TO_V2]), 2);
    expect(raw).toEqual({ version: 1, seed: 3 });
  });

  it('reports a missing step or a failing step', () => {
    expect(migratePiece({ version: 0 }, DEFAULT_MIGRATIONS)).toEqual({
      ok: false,
      error: 'This piece uses file format 0, which this version of AlgoRhythms cannot upgrade.',
    });
    const broken: MigrationStep = {
      from: 0,
      description: 'throws',
      migrate: () => {
        throw new Error('bad data');
      },
    };
    expect(migratePiece({ version: 0 }, migrationRegistry([broken]))).toEqual({
      ok: false,
      error: 'Upgrading from file format 0 failed: bad data',
    });
    expect(migratePiece({ version: 'x' }).ok).toBe(false);
  });

  it('rejects two steps for the same version', () => {
    expect(() => migrationRegistry([V0_TO_V1, { ...V0_TO_V1 }])).toThrow(/version 0/);
  });
});
