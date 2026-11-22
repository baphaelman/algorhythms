// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import algorhythms from './eslint.boundaries.js';

/**
 * PLAN.md §7.11: core/ must give identical results on every engine, so it may use only
 * + − × ÷, Math.sqrt/floor/round/abs/min/max and integer operations. These Math members are not
 * guaranteed to be correctly rounded (or are random), so they are banned there. Use core/ease.ts
 * (sinPi, cosPi, exp2) or core/math.ts instead.
 */
const NON_PORTABLE_MATH = [
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'sinh',
  'cosh',
  'tanh',
  'asinh',
  'acosh',
  'atanh',
  'pow',
  'exp',
  'expm1',
  'log',
  'log2',
  'log10',
  'log1p',
  'cbrt',
  'hypot',
  'random',
].map((property) => ({
  object: 'Math',
  property,
  message:
    property === 'random'
      ? 'No Math.random in core/ (§7.7): use the counter-based RNG.'
      : `Math.${property} is not portable across engines (§7.11): use core/ease.ts or core/math.ts.`,
}));

/** §8.10: no wall-clock time or unseeded randomness in core/ or dsp/. */
const NO_CLOCK = [
  { name: 'Date', message: 'No Date in core/ or dsp/ (§8.10): pieces are deterministic.' },
  {
    name: 'performance',
    message: 'No wall-clock time in core/ or dsp/ (§8.10). Benchmarks belong in tests/.',
  },
];

export default defineConfig(
  {
    ignores: [
      'dist/',
      'dist-*/',
      '.claude/',
      'coverage/',
      'playwright-report/',
      'test-results/',
      'blob-report/',
      'prototype/',
      'gallery/',
      'renders/',
      'node_modules/',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
    rules: {
      '@typescript-eslint/no-import-type-side-effects': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { algorhythms },
    rules: { 'algorhythms/import-boundaries': 'error' },
  },
  {
    files: ['src/**/*.worklet.ts'],
    languageOptions: { globals: globals.audioWorklet },
  },
  {
    files: ['tests/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'Literal[value=/^\\/(private\\/)?tmp\\//], TemplateElement[value.raw=/^\\/(private\\/)?tmp\\//]',
          message:
            'No hard-coded /tmp paths in tests: use testInfo.outputPath() or ALGORHYTHMS_SHOTS_DIR.',
        },
      ],
    },
  },
  {
    files: ['src/core/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-properties': ['error', ...NON_PORTABLE_MATH],
      'no-restricted-globals': ['error', ...NO_CLOCK],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "BinaryExpression[operator='**']:not([right.type='Literal'][right.raw=/^[0-9]+$/])",
          message: '`**` with a non-integer-literal exponent is not portable in core/ (§7.11).',
        },
        {
          selector: "AssignmentExpression[operator='**=']",
          message: '`**=` is not portable in core/ (§7.11).',
        },
      ],
    },
  },
  {
    files: ['src/dsp/**/*.{ts,tsx}'],
    rules: {
      // Renders must be bit-identical across platforms (V8's Math.exp differs between arm64 and
      // x64): the same ban as core/, with dsp/pmath.ts as the replacement.
      'no-restricted-properties': [
        'error',
        ...NON_PORTABLE_MATH.map((r) =>
          r.property === 'random'
            ? {
                ...r,
                message:
                  'No Math.random in dsp/ (§8.10): use a seeded PRNG keyed by voice and seed.',
              }
            : {
                ...r,
                message: `Math.${r.property} is not portable across platforms: use dsp/pmath.ts.`,
              },
        ),
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "BinaryExpression[operator='**']:not([right.type='Literal'][right.raw=/^[0-9]+$/])",
          message: '`**` with a non-integer-literal exponent is not portable: use dsp/pmath.ts.',
        },
        {
          selector: "AssignmentExpression[operator='**=']",
          message: '`**=` is not portable: use dsp/pmath.ts.',
        },
      ],
      'no-restricted-globals': ['error', ...NO_CLOCK],
    },
  },
  {
    files: ['src/app/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
  },
  {
    files: ['*.{js,ts}', 'tests/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  prettier,
);
