/**
 * Timbre preset files (PLAN.md §11.3 Sound drawer, §15 M6 "preset files round-trip"): one timbre
 * with its name, as JSON with a format marker, usually named `*.algorhythms-timbre.json`.
 *
 * `timbre` follows the schema of a `Piece.timbres` entry (TimbreSchema): defaults fill missing
 * fields and unknown fields are kept, so a valid timbre survives save → load exactly.
 */

import { z } from 'zod';
import { TimbreSchema } from './schema';
import type { Timbre } from './types';

export const TIMBRE_PRESET_FORMAT = 'algorhythms-timbre';
export const TIMBRE_PRESET_VERSION = 1;
/** File-name suffix for preset files. */
export const TIMBRE_PRESET_SUFFIX = '.algorhythms-timbre.json';

export interface TimbrePresetFile {
  format: typeof TIMBRE_PRESET_FORMAT;
  version: number;
  name: string;
  timbre: Timbre;
}

export const TimbrePresetSchema = z.looseObject({
  format: z.literal(TIMBRE_PRESET_FORMAT),
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(64),
  timbre: TimbreSchema,
});

export type TimbrePresetResult =
  { ok: true; name: string; timbre: Timbre; warnings: string[] } | { ok: false; errors: string[] };

/** The file text for a preset: stable key order (as given), two-space indent, final newline. */
export function serializeTimbrePreset(name: string, timbre: Timbre): string {
  const file: TimbrePresetFile = {
    format: TIMBRE_PRESET_FORMAT,
    version: TIMBRE_PRESET_VERSION,
    name,
    timbre,
  };
  return JSON.stringify(file, null, 2) + '\n';
}

/** Reads a preset file (text or parsed JSON); never throws. */
export function parseTimbrePreset(input: unknown): TimbrePresetResult {
  let json = input;
  if (typeof input === 'string') {
    try {
      json = JSON.parse(input);
    } catch (e) {
      return { ok: false, errors: [`Not JSON: ${e instanceof Error ? e.message : String(e)}`] };
    }
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { ok: false, errors: ['Not a timbre preset (expected a JSON object).'] };
  }
  const format = (json as { format?: unknown }).format;
  if (format !== TIMBRE_PRESET_FORMAT) {
    return {
      ok: false,
      errors: [
        format === 'algorhythms'
          ? 'This is a piece, not a timbre preset (open it from the menu).'
          : `Not a timbre preset: "format" must be "${TIMBRE_PRESET_FORMAT}".`,
      ],
    };
  }
  const r = TimbrePresetSchema.safeParse(json);
  if (!r.success) {
    return {
      ok: false,
      errors: r.error.issues.map((i) => `${i.path.join('.') || '(file)'}: ${i.message}`),
    };
  }
  const warnings =
    r.data.version > TIMBRE_PRESET_VERSION
      ? [`Made by a newer version (preset format ${r.data.version}); some settings may be ignored.`]
      : [];
  return { ok: true, name: r.data.name, timbre: r.data.timbre as Timbre, warnings };
}

/** A file name for a preset: the name with unsafe characters replaced, plus the suffix. */
export function timbrePresetFileName(name: string): string {
  const safe = [...name.trim()]
    .map((ch) => (ch < ' ' || '\\/:*?"<>|'.includes(ch) ? '-' : ch))
    .join('')
    .replace(/-+/g, '-')
    .slice(0, 64);
  return `${safe || 'timbre'}${TIMBRE_PRESET_SUFFIX}`;
}
