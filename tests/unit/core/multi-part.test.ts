/**
 * PLAN rev 10 (§11.3 Parts): `{ parts }` and `{ exceptParts }` targets in every moment type that
 * resolves a selector, the silence fold, diagnostics, the palette check, the schema and the
 * incremental compile.
 */
import { describe, expect, it } from 'vitest';
import { compile } from '../../../src/core/compiler/compile';
import { createIncrementalCompiler } from '../../../src/core/compiler/incremental';
import { momentEffectAt } from '../../../src/core/effect';
import { inPartScope, partScope, renamePartIn, scopeName } from '../../../src/core/parts';
import { pitchAt } from '../../../src/core/query';
import { parsePiece } from '../../../src/core/schema';
import type { CompiledScore, Piece, VoiceSelector } from '../../../src/core/types';
import { piece, type MomentInput } from './compiler-fixtures';

const GLIDE = { length: 1, jitter: 0, stagger: 0, ease: 'smootherstep' as const };

/** v1, v2 Bass; v3–v5 Chords; v6 Melody; v7 unassigned (all sounding); v8 unassigned, v9 Melody silent. */
const PARTS = ['Bass', 'Bass', 'Chords', 'Chords', 'Chords', 'Melody', '', '', 'Melody'];
const START = [36, 43, 55, 59, 64, 72, 84];

function parted(moments: MomentInput[], start = START): Piece {
  const p = piece({ pool: 9, start, glide: GLIDE, end: { at: 20, fade: 1 }, moments });
  p.voices.forEach((v, i) => {
    if (PARTS[i] !== '') v.part = PARTS[i];
  });
  return p;
}

/** Pool indices whose compiled voice differs from the piece without the moment. */
function changed(s: CompiledScore, base: CompiledScore): number[] {
  return s.voices.flatMap((v, i) =>
    JSON.stringify(v) === JSON.stringify(base.voices[i]) ? [] : [i],
  );
}

const inScope = (sel: VoiceSelector, v: number): boolean => inPartScope(partScope(sel), PARTS[v]);

const SELECTORS: [string, VoiceSelector][] = [
  ['parts', { parts: ['Chords', 'Melody'] }],
  ['exceptParts', { exceptParts: ['Chords'] }],
];

const MOMENTS: [string, MomentInput][] = [
  ['shift', { type: 'shift', at: 1, by: 2, unit: 'semitones' }],
  [
    'chord',
    {
      type: 'chord',
      at: 1,
      notes: { kind: 'chord', symbol: 'F' },
      voicing: 'even',
      assign: 'ordered',
    },
  ],
  ['unison', { type: 'unison', at: 1, pitch: 60, octaves: true }],
  ['spread', { type: 'spread', at: 1, factor: 1.5, around: 'median', snap: 'none' }],
  ['level', { type: 'level', at: 1, gain: 0.3, over: 1 }],
  [
    'pulse',
    {
      type: 'pulse',
      at: 1,
      until: 5,
      step: 0.5,
      pattern: [1, 0.5],
      decay: 0.3,
      floor: 0.2,
      mode: 'together',
    },
  ],
  [
    'walk',
    {
      type: 'walk',
      at: 1,
      until: 12,
      grid: 0.5,
      density: 1,
      steps: [-1, 1],
      stepGlide: 0.2,
    },
  ],
  ['split', { type: 'split', at: 1, count: 5, voicing: 'even' }],
  ['merge', { type: 'merge', at: 1, count: 2, which: 'top', fade: 0.5 }],
  [
    'tune',
    {
      type: 'tune',
      at: 1,
      notes: [
        { pitch: 70, len: 1 },
        { pitch: 74, len: 1 },
      ],
    },
  ],
  ['timbre', { type: 'timbre', at: 1, preset: 'bell', fade: 0 }],
];

describe('multi-part targets: every moment type moves only voices in scope', () => {
  const base = compile(parted([]));
  for (const [type, m] of MOMENTS) {
    for (const [form, sel] of SELECTORS) {
      it(`${type} on { ${form} }`, () => {
        const s = compile(parted([{ ...m, target: sel } as MomentInput]));
        expect(s.diagnostics.filter((d) => d.level === 'error' || d.level === 'warn')).toEqual([]);
        const vs = changed(s, base);
        expect(vs.length).toBeGreaterThan(0);
        for (const v of vs) expect(inScope(sel, v), `${type}: v${v + 1} changed`).toBe(true);
      });
    }
  }

  it('{ exceptParts } includes voices with no part', () => {
    const s = compile(parted([{ ...MOMENTS[0][1], target: { exceptParts: ['Bass', 'Chords'] } }]));
    expect(changed(s, base)).toEqual([5, 6]);
  });

  it('{ parts } covers each listed part', () => {
    const s = compile(parted([{ ...MOMENTS[0][1], target: { parts: ['Bass', 'Melody'] } }]));
    expect(changed(s, base)).toEqual([0, 1, 5]);
  });

  it('a timbre change also picks silent voices in scope', () => {
    const t = (sel: VoiceSelector): number[] =>
      compile(parted([{ ...MOMENTS[10][1], target: sel } as MomentInput])).voices.flatMap((v, i) =>
        (v.timbre ?? []).some((c) => c.preset === 'bell') ? [i] : [],
      );
    expect(t({ parts: ['Melody', 'Bass'] })).toEqual([0, 1, 5, 8]);
    expect(t({ exceptParts: ['Bass', 'Chords'] })).toEqual([5, 6, 7, 8]);
  });
});

describe('multi-part targets: diagnostics', () => {
  it('an unknown name warns once per name; the known ones still resolve', () => {
    const s = compile(
      parted([{ ...MOMENTS[0][1], target: { parts: ['Melody', 'Lead'] } } as MomentInput]),
    );
    const d = s.diagnostics.filter((x) => x.code === 'unknown-part');
    expect(d.map((x) => x.message)).toEqual(["The target names no part 'Lead'."]);
    expect(pitchAt(s.voices[5], 10)).toBe(74);
  });

  it('a silent scope says how to bring it in', () => {
    const p = parted(
      [{ type: 'shift', at: 1, by: 2, unit: 'semitones', target: { parts: ['Melody'] } }],
      [36, 43],
    );
    p.moments[1].target = { parts: ['Melody', 'Chords'] };
    const d = compile(p).diagnostics.find((x) => x.code === 'no-effect');
    expect(d?.level).toBe('warn');
    expect(d?.message).toMatch(/the parts 'Melody' and 'Chords' are silent here; bring them in/);
  });

  it('scope names', () => {
    expect(scopeName({ names: ['A'], except: false })).toBe("the part 'A'");
    expect(scopeName({ names: ['A', 'B', 'C'], except: false })).toBe("the parts 'A', 'B' and 'C'");
    expect(scopeName({ names: ['A'], except: true })).toBe("the parts outside 'A'");
    expect(scopeName({ names: [''], except: false })).toBe('the unassigned part');
  });
});

describe('multi-part targets: entering from silence', () => {
  it('a chord on { parts } of silent parts brings them in from their dormant voices', () => {
    // Only Bass sounds; Chords and Melody come in at 4.
    const s = compile(
      parted(
        [
          {
            type: 'chord',
            at: 4,
            notes: { kind: 'chord', symbol: 'C' },
            voicing: 'even',
            assign: 'ordered',
            target: { parts: ['Chords', 'Melody'] },
          },
        ],
        [36, 43],
      ),
    );
    expect(s.diagnostics.filter((d) => d.momentId === 'm0')).toEqual([]);
    const born = s.voices.flatMap((v, i) => (v.lives.some((l) => l.born === 4) ? [i] : []));
    expect(born.length).toBeGreaterThan(0);
    for (const v of born) expect(['Chords', 'Melody']).toContain(PARTS[v]);
    for (const v of born) expect(s.voices[v].lives[0].fadeIn).toBe(0.5);
  });

  it('a tune on { exceptParts } enters on a dormant voice outside them', () => {
    const s = compile(
      parted(
        [
          {
            type: 'tune',
            at: 4,
            notes: [{ pitch: 72, len: 1 }],
            target: { exceptParts: ['Bass'] },
          },
        ],
        [36, 43],
      ),
    );
    expect(s.diagnostics.filter((d) => d.momentId === 'm0')).toEqual([]);
    const born = s.voices.flatMap((v, i) => (v.lives.some((l) => l.born === 4) ? [i] : []));
    expect(born).toHaveLength(1);
    expect(PARTS[born[0]]).not.toBe('Bass');
  });
});

describe('multi-part targets: palette, schema, incremental', () => {
  it('momentEffectAt reads the scope', () => {
    const p = parted([]);
    const s = compile(p);
    const merge = (target: VoiceSelector) =>
      momentEffectAt(p, s, {
        id: 'x',
        type: 'merge',
        at: 5,
        count: 1,
        which: 'top',
        fade: 0.5,
        target,
      }).effect;
    expect(merge({ parts: ['Melody'] })).toBe(false);
    expect(merge({ parts: ['Melody', 'Bass'] })).toBe(true);
    expect(merge({ exceptParts: ['Bass', 'Chords'] })).toBe(true);
  });

  it('the schema takes non-empty lists of names only', () => {
    const ok = (target: unknown): boolean => {
      const p = parted([]);
      (p.moments[0] as { target?: unknown }).target = target;
      return parsePiece(JSON.parse(JSON.stringify(p))).ok;
    };
    expect(ok({ parts: ['A', 'B'] })).toBe(true);
    expect(ok({ exceptParts: ['A'] })).toBe(true);
    expect(ok({ parts: [] })).toBe(false);
    expect(ok({ exceptParts: [] })).toBe(false);
    expect(ok({ parts: [1] })).toBe(false);
    const p = parted([{ ...MOMENTS[0][1], target: { exceptParts: ['Bass'] } }]);
    const r = parsePiece(JSON.parse(JSON.stringify(p)));
    expect(r.ok && r.piece.moments[1].target).toEqual({ exceptParts: ['Bass'] });
  });

  it('renamePartIn renames inside every form', () => {
    expect(renamePartIn({ part: 'A' }, 'A', 'Z')).toEqual({ part: 'Z' });
    expect(renamePartIn({ parts: ['A', 'B'] }, 'A', 'Z')).toEqual({ parts: ['Z', 'B'] });
    expect(renamePartIn({ exceptParts: ['B', 'A'] }, 'A', 'Z')).toEqual({
      exceptParts: ['B', 'Z'],
    });
    const same = { parts: ['B'] };
    expect(renamePartIn(same, 'A', 'Z')).toBe(same);
    expect(renamePartIn('all', 'A', 'Z')).toBe('all');
  });

  it('incremental compile equals the full compile across edits', () => {
    const p = parted([
      { type: 'shift', at: 2, by: 3, unit: 'semitones', target: { parts: ['Melody', 'Bass'] } },
      { type: 'level', at: 4, gain: 0.5, over: 1, target: { exceptParts: ['Melody'] } },
    ]);
    const inc = createIncrementalCompiler();
    expect(inc.compile(p)).toEqual(compile(p));
    const q = structuredClone(p);
    q.moments[1].target = { exceptParts: ['Chords'] };
    expect(inc.compile(q)).toEqual(compile(q));
    const r = structuredClone(q);
    r.voices[6].part = 'Chords';
    expect(inc.compile(r)).toEqual(compile(r));
  });
});
