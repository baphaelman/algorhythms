// @ts-check
/**
 * Local ESLint plugin enforcing the import boundaries of PLAN.md §14 (see docs/build-log.md).
 *
 * Import specifiers are resolved against the importing file, so the rule judges the layer an
 * import actually lands in (src/<layer>/...), whatever the relative path looks like.
 *
 * - core   imports nothing internal (packages are fine).
 * - dsp    imports only types from core (`import type`), plus values from the pure leaf modules
 *          core/ease and core/segment (deviation (b), recorded in docs/build-log.md).
 * - render imports core.
 * - midi   imports core.
 * - audio  imports core and dsp.
 * - app    imports anything.
 * - core/ease and core/segment are leaves: they import only types, and segment may import ease.
 * - Nothing except app imports from outside src/.
 */

import path from 'node:path';

const SRC = path.resolve(import.meta.dirname, 'src');
const LAYERS = new Set(['core', 'dsp', 'audio', 'render', 'midi', 'app']);

/** Layers each layer may import from (besides itself). */
const ALLOWED = /** @type {Record<string, string[]>} */ ({
  core: [],
  dsp: [],
  render: ['core'],
  midi: ['core'],
  audio: ['core', 'dsp'],
  app: [...LAYERS],
});

/** Core modules the DSP may import by value. */
const DSP_VALUE_IMPORTS = new Set(['core/ease', 'core/segment']);
/** Value imports each core leaf may make. */
const LEAF_VALUE_IMPORTS = /** @type {Record<string, string[]>} */ ({
  'core/ease': [],
  'core/segment': ['core/ease'],
});

/**
 * @param {string} absPath
 * @returns {{ layer: string, key: string } | null} layer and module key like "core/ease"
 */
function locate(absPath) {
  const rel = path.relative(SRC, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  const key = parts
    .join('/')
    .replace(/\.(d\.ts|tsx?|jsx?|mjs|cjs)$/, '')
    .replace(/\/index$/, '');
  return { layer: parts[0] ?? '', key };
}

/** @type {import('eslint').Rule.RuleModule} */
const importBoundaries = {
  meta: {
    type: 'problem',
    docs: { description: 'Enforce the AlgoRhythms layer import boundaries (PLAN.md §14).' },
    schema: [],
    messages: {
      boundary: '`{{from}}` may not import from `{{to}}` (PLAN.md §14 import boundaries).',
      dspValue:
        '`dsp` may import only types from `core`: use `import type`. Values may come only from core/ease and core/segment.',
      leaf: '`{{from}}` is a pure leaf module: it may import only types{{extra}}.',
      outside: '`{{from}}` may not import from outside src/ ({{source}}).',
    },
  },
  create(context) {
    const here = locate(context.filename);
    if (!here || !LAYERS.has(here.layer)) return {};
    const from = here.layer;

    /**
     * @param {import('estree').Node} node
     * @param {unknown} source
     * @param {boolean} typeOnly
     */
    function check(node, source, typeOnly) {
      if (typeof source !== 'string') return;
      if (!source.startsWith('.') && !source.startsWith('/')) return; // a package
      const clean = source.replace(/[?#].*$/, '');
      const target = locate(path.resolve(path.dirname(context.filename), clean));
      if (!target) {
        if (from !== 'app') {
          context.report({ node, messageId: 'outside', data: { from, source } });
        }
        return;
      }
      const to = target.layer;

      if (to === from) {
        const leafAllowed = LEAF_VALUE_IMPORTS[here.key];
        if (leafAllowed && !typeOnly && !leafAllowed.includes(target.key)) {
          const extra = leafAllowed.length ? ` and values from ${leafAllowed.join(', ')}` : '';
          context.report({ node, messageId: 'leaf', data: { from: here.key, extra } });
        }
        return;
      }
      if (from === 'dsp' && to === 'core') {
        if (!typeOnly && !DSP_VALUE_IMPORTS.has(target.key)) {
          context.report({ node, messageId: 'dspValue' });
        }
        return;
      }
      if (!(ALLOWED[from] ?? []).includes(to)) {
        context.report({ node, messageId: 'boundary', data: { from, to } });
      }
    }

    return {
      ImportDeclaration(node) {
        // @ts-expect-error importKind is added by typescript-eslint's parser
        check(node, node.source.value, node.importKind === 'type');
      },
      ExportNamedDeclaration(node) {
        // @ts-expect-error exportKind is added by typescript-eslint's parser
        if (node.source) check(node, node.source.value, node.exportKind === 'type');
      },
      ExportAllDeclaration(node) {
        // @ts-expect-error exportKind is added by typescript-eslint's parser
        check(node, node.source.value, node.exportKind === 'type');
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal') check(node, node.source.value, false);
      },
    };
  },
};

export default {
  meta: { name: 'algorhythms' },
  rules: { 'import-boundaries': importBoundaries },
};
