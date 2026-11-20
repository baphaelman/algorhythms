/**
 * Runs the prototype's own `compose()` (prototype/glissando-score.html) in Node, for the M1
 * acceptance test "generate() produces the same section sequence and the same active-voice count
 * per section as the prototype's compose()".
 *
 * The `<engine>` block is extracted from the HTML at test time, so the reference is the
 * prototype itself, not a copy. Two small instrumentation edits record, per section, the active
 * voice count after every `retarget` call and at the section's end.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/** One prototype section as recorded. */
export interface PrototypeSection {
  name: string;
  /** Section start time (prototype timings; not comparable with generate()'s). */
  t: number;
  /** Active voices after each retarget in this section. */
  retargets: number[];
  /** Active voices when the section ends. */
  end: number;
}

type Compose = (
  seed: number,
  mode: string,
) => {
  sections: { name: string; t: number; retargets: number[]; startActive: number }[];
  voices: { born: number }[];
};

let cached: Compose | null = null;

function loadCompose(): Compose {
  if (cached) return cached;
  const html = readFileSync(
    fileURLToPath(new URL('../../../prototype/glissando-score.html', import.meta.url)),
    'utf8',
  );
  const start = html.indexOf('// <engine>');
  const end = html.indexOf('// </engine>');
  if (start < 0 || end < 0) throw new Error('prototype <engine> block not found');
  let src = html.slice(start, end);

  const markLine = 'const mark = (name, t) => sections.push({ name, t });';
  const retargetLine = 'function retarget(t, targets, o) {';
  if (!src.includes(markLine) || !src.includes(retargetLine)) {
    throw new Error('prototype compose() changed; update tests/unit/core/prototype-compose.ts');
  }
  // Rename the original first, so the wrapper inserted below keeps the name `retarget`.
  src = src.replace(retargetLine, 'function retarget0(t, targets, o) {');
  src = src.replace(
    markLine,
    [
      'const activeCount = () => voices.filter(v => v.born < Infinity).length;',
      'const mark = (name, t) => sections.push({ name, t, retargets: [], startActive: activeCount() });',
      'function retarget(t, targets, o) {',
      '  retarget0(t, targets, o);',
      '  sections[sections.length - 1].retargets.push(activeCount());',
      '}',
    ].join('\n'),
  );
  cached = vm.runInNewContext(`${src}\n;compose`) as Compose;
  return cached;
}

/** The prototype's sections for a seed and mode ('dorian', 'aeolian', 'lydian' or 'penta'). */
export function prototypeSections(seed: number, mode: string): PrototypeSection[] {
  const score = loadCompose()(seed, mode);
  const final = score.voices.filter((v) => v.born < Infinity).length;
  return score.sections.map((s, i) => ({
    name: s.name,
    t: s.t,
    retargets: s.retargets,
    end: i + 1 < score.sections.length ? score.sections[i + 1].startActive : final,
  }));
}
