/**
 * "Notes", not "voices", in UI text (PLAN.md §11.3 revision 7). Sweeps the string literals and
 * JSX text under src/app for the word "voice"/"voices". User-facing text is JSX text, the values
 * of user-facing JSX attributes, and any string with a space in it (labels, notices, tooltips).
 * Identifiers, test ids, CSS classes and file-format field names have no space and are skipped.
 * Text that names a file-format field may keep the word (build log, M4.5-24): list it below.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const APP = join(ROOT, 'src/app');
const WORD = /\bvoices?\b/i;
const UI_ATTRS = new Set([
  'aria-label',
  'aria-description',
  'title',
  'placeholder',
  'alt',
  'label',
  'legend',
  'hint',
]);

/** `file: text` pairs allowed to say "voice" (they name file-format fields). */
const ALLOW: string[] = [];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** The user-facing texts of one source file. */
function texts(path: string): string[] {
  const src = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  /** The JSX attribute this literal is the value of (not inside a handler), if any. */
  const attrOf = (n: ts.Node): string | null => {
    for (let a = n.parent; a; a = a.parent) {
      if (ts.isJsxAttribute(a)) return a.name.getText(src);
      if (ts.isFunctionLike(a) || ts.isStatement(a)) return null;
    }
    return null;
  };
  const isUiAttr = (n: ts.Node): boolean => UI_ATTRS.has(attrOf(n) ?? '');
  /** Values of attributes such as className, id or data-testid are not shown. */
  const isCodeAttr = (n: ts.Node): boolean => {
    const a = attrOf(n);
    return a !== null && !UI_ATTRS.has(a);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isLiteralTypeNode(n)) return;
    if (ts.isJsxText(n)) {
      const t = n.getText(src).trim();
      if (t) out.push(t);
    } else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (isUiAttr(n) || (/\s/.test(n.text) && !isCodeAttr(n))) out.push(n.text);
    } else if (ts.isTemplateExpression(n)) {
      const t = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join('…');
      if (isUiAttr(n) || (/\s/.test(t) && !isCodeAttr(n))) out.push(t);
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return out;
}

describe('UI text says "notes", not "voices"', () => {
  it('no user-facing string under src/app uses the word', () => {
    const hits: string[] = [];
    for (const f of files(APP)) {
      const rel = relative(ROOT, f);
      for (const t of texts(f)) if (WORD.test(t)) hits.push(`${rel}: ${t}`);
    }
    expect(hits.filter((h) => !ALLOW.includes(h))).toEqual([]);
  });

  it('the sweep sees UI text (sanity)', () => {
    const all = files(APP).flatMap(texts);
    expect(all.some((t) => /\bnotes?\b/i.test(t))).toBe(true);
    expect(all.length).toBeGreaterThan(200);
  });
});
