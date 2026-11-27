/**
 * Search in an editor's side panel (owner, 2026-11-27): a box pinned at the panel's top filters
 * its settings as you type; ⌘F (Ctrl+F elsewhere) focuses the open editor's box, Escape clears
 * it, a second Escape lets go. The term is per editor, not stored, cleared on switching editors.
 *
 * Settings are tagged, not listed, so a reorganised panel needs no changes here:
 * - `data-search` (value: optional keywords) marks a setting or a group; a `fieldset` with a
 *   `legend` and a `details` with a `summary` are groups without it. Its label is its text, or
 *   its `[data-search-label]` parts, or (a group) its legend or summary; `small`, `output`,
 *   `select` and `[data-search-skip]` are left out; `data-search-off` makes a fieldset part of
 *   the setting around it.
 * - A setting's parts hide and show with it, their text counts as its label: the siblings after
 *   it tagged `data-search-part`, or, after a `label` or `span` setting (a label / control grid
 *   row), the untagged siblings up to the next setting.
 * - `data-search-reveal="<id>"` on a collapsed section's panel: with a match inside, it opens
 *   while searching (`useSearchReveal`); closed `<details>` open on their own.
 * - `data-search-ignore` stays as it is (headers, footers).
 */

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { create } from 'zustand';
import { useExportSurface, type ExportSurface } from '../export-surface';
import { searchTree, type SearchResult, type SearchTree } from '../panel-search';
import './panel-search.css';

/** The search terms by panel, and the collapsed sections each opens. */
export const usePanelSearch = create<{
  query: Readonly<Record<string, string>>;
  reveal: Readonly<Record<string, readonly string[]>>;
}>()(() => ({ query: {}, reveal: {} }));

const editorOf = (s: ExportSurface | null) => (s === 'poster' || s === 'video' ? s : 'music');

// Switching editors clears every term.
useExportSurface.subscribe((s, prev) => {
  if (editorOf(s.surface) !== editorOf(prev.surface))
    usePanelSearch.setState({ query: {}, reveal: {} });
});

const setQuery = (scope: string, q: string) =>
  usePanelSearch.setState((s) => ({ query: { ...s.query, [scope]: q } }));

const Scope = createContext<string | null>(null);

/** The panel's search is on (its collapsed sections render their contents to be searched). */
export function useSearching(): boolean {
  const scope = useContext(Scope);
  return usePanelSearch((s) => scope !== null && (s.query[scope] ?? '').trim() !== '');
}

/** A collapsed section's open state while searching: open when a match is inside. */
export function useSearchReveal(id: string, open: boolean): boolean {
  const scope = useContext(Scope);
  const shown = usePanelSearch((s) => scope !== null && (s.reveal[scope] ?? []).includes(id));
  return open || shown;
}

// ---- the DOM pass ------------------------------------------------------------------------------

const HIDDEN = 'data-search-hidden';
const OPENED = 'data-search-opened';
const SKIP = 'small, output, select, textarea, [data-search-skip], [aria-hidden="true"], .sr-only';

interface DomNode {
  el: HTMLElement;
  parts: HTMLElement[];
  /** The label's text nodes, and where each starts in `text`. */
  texts: { node: Text; at: number }[];
  text: string;
  keywords: string;
  children: DomNode[];
}

function isNode(el: Element): boolean {
  if (el.hasAttribute('data-search')) return true;
  if (el.hasAttribute('data-search-off')) return false;
  if (el.tagName === 'FIELDSET') return el.querySelector(':scope > legend') !== null;
  if (el.tagName === 'DETAILS') return el.querySelector(':scope > summary') !== null;
  return false;
}

/** The nearest search node above `el` inside `root`, or null. */
function ownerOf(el: Element, root: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== root; p = p.parentElement) if (isNode(p)) return p;
  return null;
}

function labelRoots(n: HTMLElement, all: HTMLElement[], root: HTMLElement): HTMLElement[] {
  const parts = all.filter((p) => !p.matches(SKIP));
  const marked = [...n.querySelectorAll<HTMLElement>('[data-search-label]')].filter(
    (l) => ownerOf(l, root) === n,
  );
  if (marked.length > 0) return [...marked, ...parts];
  const head = n.querySelector<HTMLElement>(':scope > legend, :scope > summary');
  return [head ?? n, ...parts];
}

function collectText(n: HTMLElement, roots: HTMLElement[]): Pick<DomNode, 'texts' | 'text'> {
  const texts: { node: Text; at: number }[] = [];
  let text = '';
  for (const r of roots) {
    const walk = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (x) => {
        if (x instanceof Element)
          return x !== n && (isNode(x) || x.matches(SKIP))
            ? NodeFilter.FILTER_REJECT
            : NodeFilter.FILTER_SKIP;
        return (x as Text).data.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      if (text) text += ' ';
      texts.push({ node: t as Text, at: text.length });
      text += (t as Text).data;
    }
  }
  return { texts, text };
}

/** The scope's settings as a tree, in document order. */
function buildTree(root: HTMLElement): DomNode[] {
  const top: DomNode[] = [];
  const byEl = new Map<Element, DomNode>();
  for (const el of root.querySelectorAll<HTMLElement>('*')) {
    if (!isNode(el) || el.closest('[data-search-ignore]')) continue;
    const parts = partsOf(el);
    const node: DomNode = {
      el,
      parts,
      ...collectText(el, labelRoots(el, parts, root)),
      keywords: el.getAttribute('data-search') ?? '',
      children: [],
    };
    byEl.set(el, node);
    const owner = ownerOf(el, root);
    // A part's settings belong to the setting it follows.
    const part = el.closest('[data-search-part]');
    const host = part && root.contains(part) ? partOwner(part, byEl) : undefined;
    const parent = (owner && byEl.get(owner)) ?? host;
    (parent ? parent.children : top).push(node);
  }
  return top;
}

/** A part: tagged, or (after a label or span setting) untagged and holding no settings. */
function isPart(el: Element, inline: boolean): boolean {
  if (el.hasAttribute('data-search-part')) return true;
  if (!inline || isNode(el) || el.hasAttribute('data-search-ignore')) return false;
  return ![...el.querySelectorAll('*')].some(isNode);
}

const inlineNode = (el: Element) => el.tagName === 'LABEL' || el.tagName === 'SPAN';

function partsOf(el: HTMLElement): HTMLElement[] {
  const parts: HTMLElement[] = [];
  const inline = inlineNode(el);
  for (let s = el.nextElementSibling; s && isPart(s, inline); s = s.nextElementSibling)
    parts.push(s as HTMLElement);
  return parts;
}

function partOwner(part: Element, byEl: Map<Element, DomNode>): DomNode | undefined {
  for (let s = part.previousElementSibling; s; s = s.previousElementSibling) {
    const n = byEl.get(s);
    if (n) return n.parts.includes(part as HTMLElement) ? n : undefined;
  }
  return undefined;
}

const toTree = (n: DomNode): SearchTree => ({
  text: n.text,
  keywords: n.keywords,
  children: n.children.map(toTree),
});

function rangeOf(n: DomNode, [a, b]: readonly [number, number]): Range | null {
  const at = (off: number, end: boolean) => {
    for (let i = n.texts.length - 1; i >= 0; i--) {
      const t = n.texts[i];
      if (end ? off > t.at : off >= t.at)
        return { node: t.node, off: Math.min(off - t.at, t.node.data.length) };
    }
    return null;
  };
  const s = at(a, false);
  const e = at(b, true);
  if (!s || !e) return null;
  const r = document.createRange();
  r.setStart(s.node, s.off);
  r.setEnd(e.node, e.off);
  return r;
}

const highlights = new Map<string, Range[]>();

function paintHighlights(): void {
  const reg = (globalThis.CSS as { highlights?: Map<string, unknown> } | undefined)?.highlights;
  const H = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!reg || !H) return;
  const all = [...highlights.values()].flat();
  if (all.length === 0) reg.delete('panel-search');
  else reg.set('panel-search', new H(...all));
}

/** Shows every setting again and closes what the search opened. */
function clearScope(root: HTMLElement): void {
  for (const el of root.querySelectorAll(`[${HIDDEN}]`)) el.removeAttribute(HIDDEN);
  for (const el of root.querySelectorAll<HTMLDetailsElement>(`details[${OPENED}]`)) {
    el.removeAttribute(OPENED);
    el.open = false;
  }
}

/**
 * Filters the scope: hides what doesn't match, opens sections holding a match, highlights the
 * matched words. Returns how many settings show and the sections to reveal.
 */
function applySearch(root: HTMLElement, query: string): { count: number; reveal: string[] } {
  const nodes = buildTree(root);
  const results = searchTree(nodes.map(toTree), query);
  const keep = new Set<Element>();
  const whole = new Set<Element>();
  const ranges: Range[] = [];
  const reveal = new Set<string>();
  const open = new Set<HTMLDetailsElement>();
  let count = 0;
  const up = (el: Element | null) => {
    for (let p = el; p && p !== root && !keep.has(p); p = p.parentElement) keep.add(p);
  };
  const visit = (n: DomNode, r: SearchResult, inWhole: boolean) => {
    if (!r.shown) return;
    for (const x of r.ranges) {
      const range = rangeOf(n, x);
      if (range) ranges.push(range);
    }
    if (r.matched) {
      count++;
      // Collapsed sections around it open.
      for (let p = n.el.parentElement; p && p !== root; p = p.parentElement) {
        const id = p.getAttribute('data-search-reveal');
        if (id) reveal.add(id);
        if (p instanceof HTMLDetailsElement && !n.el.closest('summary')) open.add(p);
      }
    }
    if (!inWhole) {
      up(n.el);
      for (const p of n.parts) up(p);
      if (r.matched) {
        whole.add(n.el);
        for (const p of n.parts) whole.add(p);
      } else {
        // A group shown for what it holds keeps its heading.
        for (const l of labelRoots(n.el, [], root)) {
          up(l);
          if (l !== n.el) whole.add(l);
        }
      }
    }
    n.children.forEach((c, i) => visit(c, r.children[i], inWhole || r.matched));
  };
  nodes.forEach((n, i) => visit(n, results[i], false));

  const hide = (el: Element) => {
    for (const c of el.children) {
      if (c.hasAttribute('data-search-ignore')) continue;
      if (whole.has(c)) {
        c.removeAttribute(HIDDEN);
        for (const h of c.querySelectorAll(`[${HIDDEN}]`)) h.removeAttribute(HIDDEN);
      } else if (keep.has(c)) {
        c.removeAttribute(HIDDEN);
        hide(c);
      } else if (!c.hasAttribute(HIDDEN)) c.setAttribute(HIDDEN, '');
    }
  };
  hide(root);
  for (const d of root.querySelectorAll<HTMLDetailsElement>(`details[${OPENED}]`)) {
    if (open.has(d)) continue;
    d.removeAttribute(OPENED);
    d.open = false;
  }
  for (const d of open) {
    if (d.open) continue;
    d.setAttribute(OPENED, '');
    d.open = true;
  }
  highlights.set(root.id || 'scope', ranges);
  return { count, reveal: [...reveal].sort() };
}

// ---- ⌘F ---------------------------------------------------------------------------------------

interface Box {
  input: HTMLInputElement;
  priority: number;
}

const boxes: Box[] = [];

const usable = (el: HTMLElement) =>
  el.isConnected && el.closest('[inert]') === null && el.getClientRects().length > 0;

function onFindKey(e: KeyboardEvent): void {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  if (e.key.toLowerCase() !== 'f' || e.altKey || e.shiftKey) return;
  if (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey) return;
  if (document.querySelector('dialog[open]')) return;
  // The box of the panel that's open: the later of the highest priority.
  let best: Box | null = null;
  for (const b of boxes) if (usable(b.input) && (!best || b.priority >= best.priority)) best = b;
  if (!best) return;
  e.preventDefault();
  e.stopPropagation();
  best.input.focus();
  best.input.select();
}

function register(b: Box): () => void {
  if (boxes.length === 0) document.addEventListener('keydown', onFindKey, true);
  boxes.push(b);
  return () => {
    boxes.splice(boxes.indexOf(b), 1);
    if (boxes.length === 0) document.removeEventListener('keydown', onFindKey, true);
  };
}

// ---- the box ----------------------------------------------------------------------------------

/**
 * The search box over a panel's settings (`children`, laid out as if the box weren't there:
 * the scope wrapper is `display: contents`). `priority` picks the box ⌘F focuses when several
 * panels show (a drawer over the inspector).
 */
export function PanelSearch({
  scope,
  label,
  priority = 0,
  children,
}: {
  /** The panel's id: its term and test ids (`panel-search-<scope>`). */
  scope: string;
  /** What's searched, for the box's name ("Video options"). */
  label: string;
  priority?: number;
  children: ReactNode;
}) {
  const query = usePanelSearch((s) => s.query[scope] ?? '');
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [count, setCount] = useState<number | null>(null);
  const active = query.trim() !== '';

  useEffect(() => register({ input: input.current!, priority }), [priority]);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    if (!active) {
      clearScope(el);
      highlights.delete(el.id);
      paintHighlights();
      if ((usePanelSearch.getState().reveal[scope] ?? []).length > 0)
        usePanelSearch.setState((s) => ({ reveal: { ...s.reveal, [scope]: [] } }));
      return;
    }
    const run = () => {
      const r = applySearch(el, query);
      paintHighlights();
      setCount(r.count);
      const was = usePanelSearch.getState().reveal[scope] ?? [];
      if (was.join('\n') !== r.reveal.join('\n'))
        usePanelSearch.setState((s) => ({ reveal: { ...s.reveal, [scope]: r.reveal } }));
    };
    run();
    // What renders later (a section opening, another selection) is filtered too.
    let frame = 0;
    const mo = new MutationObserver(() => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          run();
        });
    });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      mo.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [active, query, scope]);

  // Leaving (another editor, the panel closing): everything shows again.
  useEffect(() => {
    const el = root.current;
    return () => {
      if (el) {
        clearScope(el);
        highlights.delete(el.id);
        paintHighlights();
      }
    };
  }, []);

  const clear = () => setQuery(scope, '');

  return (
    <Scope.Provider value={scope}>
      <div className="panel-search" role="search" data-search-ignore>
        <input
          ref={input}
          type="search"
          placeholder="Search settings"
          aria-label={`Search ${label}`}
          autoComplete="off"
          spellCheck={false}
          value={query}
          data-testid={`panel-search-${scope}`}
          onChange={(e) => setQuery(scope, e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            if (query !== '') clear();
            else e.currentTarget.blur();
          }}
        />
        {query !== '' && (
          <button
            type="button"
            className="panel-search-x"
            aria-label="Clear the search"
            title="Clear the search"
            data-testid={`panel-search-${scope}-x`}
            onClick={() => {
              clear();
              input.current?.focus();
            }}
          >
            ×
          </button>
        )}
      </div>
      {active && count === 0 && (
        <p
          className="panel-search-none"
          data-search-ignore
          data-testid={`panel-search-${scope}-none`}
        >
          No settings match “{query.trim()}”
          <button
            type="button"
            onClick={() => {
              clear();
              input.current?.focus();
            }}
          >
            Clear
          </button>
        </p>
      )}
      <div className="panel-search-scope" id={`${id}-scope`} ref={root} data-search-scope={scope}>
        {children}
      </div>
    </Scope.Provider>
  );
}
