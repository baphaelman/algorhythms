/**
 * Search in the editors' side panels (owner, 2026-11-27): the matching, DOM-free. A query is
 * words; each must start a word of a setting's label (or one of its keywords), case-insensitive
 * ("gl" finds Glow, not "angle"). Settings form a tree (groups hold settings): a node whose own
 * label and its groups' labels hold every word matches, and shows whole; a group shows when
 * something in it does.
 */

/** A setting or a group of them: its visible label, extra keywords, what it holds. */
export interface SearchTree {
  text: string;
  /** Words that find it but aren't shown ("brightness" for Exposure). */
  keywords?: string;
  children: readonly SearchTree[];
}

export interface SearchResult {
  /** Shown: it matches, sits in a match, or holds one. */
  shown: boolean;
  /** Every word found in its own label and keywords plus its groups' (it shows whole). */
  matched: boolean;
  /** The query words in its label, as [start, end) offsets into `text`. */
  ranges: readonly (readonly [number, number])[];
  children: readonly SearchResult[];
}

/** Case and apostrophe folding; keeps the length, so offsets map back to the text. */
function fold(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch === '’' || ch === '‘' ? "'" : ch.toLowerCase();
    out += c.length === ch.length ? c : ch;
  }
  return out;
}

const WORD = /[\p{L}\p{N}]/u;

/** The query's words, folded; none for a blank query. */
export function searchWords(query: string): string[] {
  return fold(query).split(/\s+/).filter(Boolean);
}

/** Where words start in `text` (a letter or digit after anything else). */
export function wordStarts(text: string): number[] {
  const out: number[] = [];
  let prev = false;
  let i = 0;
  for (const ch of text) {
    const w = WORD.test(ch);
    if (w && !prev) out.push(i);
    prev = w;
    i += ch.length;
  }
  return out;
}

/**
 * Which words start a word of `text` (by index into `words`), and where: every occurrence, merged
 * where they overlap. A word that starts with a symbol may match anywhere.
 */
export function matchText(
  words: readonly string[],
  text: string,
): { hits: ReadonlySet<number>; ranges: [number, number][] } {
  const hits = new Set<number>();
  const found: [number, number][] = [];
  if (words.length === 0 || text === '') return { hits, ranges: found };
  const t = fold(text);
  const starts = wordStarts(text);
  words.forEach((w, i) => {
    const at = WORD.test(w[0]) ? starts : [...t.matchAll(/./gsu)].map((m) => m.index);
    for (const s of at) {
      if (t.startsWith(w, s)) {
        hits.add(i);
        found.push([s, s + w.length]);
      }
    }
  });
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const ranges: [number, number][] = [];
  for (const r of found) {
    const last = ranges[ranges.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else ranges.push([r[0], r[1]]);
  }
  return { hits, ranges };
}

function evalNode(
  n: SearchTree,
  words: readonly string[],
  inherited: readonly boolean[],
  whole: boolean,
): SearchResult {
  const own = matchText(words, n.text);
  const keys = n.keywords ? matchText(words, n.keywords).hits : new Set<number>();
  const covered = words.map((_, i) => inherited[i] || own.hits.has(i) || keys.has(i));
  const matched = !whole && (own.hits.size > 0 || keys.size > 0) && covered.every(Boolean);
  const children = n.children.map((c) => evalNode(c, words, covered, whole || matched));
  return {
    shown: whole || matched || children.some((c) => c.shown),
    matched,
    ranges: own.ranges,
    children,
  };
}

/** Evaluates a panel's settings against a query; a blank query shows everything. */
export function searchTree(nodes: readonly SearchTree[], query: string): SearchResult[] {
  const words = searchWords(query);
  const none = words.map(() => false);
  return nodes.map((n) => evalNode(n, words, none, words.length === 0));
}
