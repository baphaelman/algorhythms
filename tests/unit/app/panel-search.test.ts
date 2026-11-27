import { describe, expect, it } from 'vitest';
import {
  matchText,
  searchTree,
  searchWords,
  wordStarts,
  type SearchTree,
} from '../../../src/app/panel-search';

const leaf = (text: string, keywords?: string): SearchTree => ({ text, keywords, children: [] });
const group = (text: string, ...children: SearchTree[]): SearchTree => ({ text, children });

describe('panel search: words', () => {
  it('splits and folds the query', () => {
    expect(searchWords('  Glow  VIG ')).toEqual(['glow', 'vig']);
    expect(searchWords('   ')).toEqual([]);
    expect(searchWords('Editor’s')).toEqual(["editor's"]);
  });

  it('finds word starts after anything that is not a letter or digit', () => {
    expect(wordStarts('Fade in')).toEqual([0, 5]);
    expect(wordStarts('Lead-in · 2.5 s')).toEqual([0, 5, 10, 12, 14]);
    expect(wordStarts('440 Hz')).toEqual([0, 4]);
  });
});

describe('panel search: matching a label', () => {
  it('matches word starts, case-insensitively', () => {
    expect(matchText(['gl'], 'Glow').ranges).toEqual([[0, 2]]);
    expect(matchText(['gl'], 'Angle').hits.size).toBe(0);
    expect(matchText(['in'], 'Fade in').ranges).toEqual([[5, 7]]);
    expect(matchText(['hz'], 'Hz labels').ranges).toEqual([[0, 2]]);
  });

  it('finds every occurrence and merges overlaps', () => {
    expect(matchText(['l'], 'Line labels').ranges).toEqual([
      [0, 1],
      [5, 6],
    ]);
    expect(matchText(['fra', 'frame'], 'Frame rate').ranges).toEqual([[0, 5]]);
  });

  it('matches a word with a hyphen from a word start', () => {
    expect(matchText(['lead-in'], 'Lead-in').ranges).toEqual([[0, 7]]);
    expect(matchText(['d-in'], 'Lead-in').hits.size).toBe(0);
  });

  it('folds typographic apostrophes', () => {
    expect(matchText(["piece's"], 'Piece’s pitch range').ranges).toEqual([[0, 7]]);
  });

  it('lets a word that starts with a symbol match anywhere', () => {
    expect(matchText(['%'], 'Glow 40 %').ranges).toEqual([[8, 9]]);
  });
});

describe('panel search: the tree', () => {
  const look = group(
    'Look',
    leaf('Glow', 'bloom'),
    leaf('Vignette'),
    group('HUD · 6 readouts', leaf('Key'), leaf('Tempo')),
  );
  const tree = [leaf('Frame rate 24 30 60', 'fps'), look];

  it('shows everything for a blank query', () => {
    const [fps, l] = searchTree(tree, ' ');
    expect(fps.shown && l.shown && l.children.every((c) => c.shown)).toBe(true);
    expect(fps.matched).toBe(false);
  });

  it('shows only matches and the groups that hold them', () => {
    const [fps, l] = searchTree(tree, 'glo');
    expect(fps.shown).toBe(false);
    expect(l.shown).toBe(true);
    expect(l.matched).toBe(false);
    expect(l.children.map((c) => c.shown)).toEqual([true, false, false]);
    expect(l.children[0].ranges).toEqual([[0, 3]]);
  });

  it('finds a setting by a keyword, without highlighting it', () => {
    const [fps] = searchTree(tree, 'fps');
    expect(fps.matched).toBe(true);
    expect(fps.ranges).toEqual([]);
    expect(searchTree(tree, 'bloom')[1].children[0].matched).toBe(true);
  });

  it('needs every word, in the setting or its groups', () => {
    expect(searchTree(tree, 'frame 60')[0].matched).toBe(true);
    expect(searchTree(tree, 'frame 50')[0].shown).toBe(false);
    // "hud" in the group, "tempo" in the setting.
    const hud = searchTree(tree, 'hud tempo')[1].children[2];
    expect(hud.matched).toBe(false);
    expect(hud.children.map((c) => c.matched)).toEqual([false, true]);
  });

  it('shows a matched group whole', () => {
    const hud = searchTree(tree, 'readouts')[1].children[2];
    expect(hud.matched).toBe(true);
    expect(hud.children.every((c) => c.shown && !c.matched)).toBe(true);
    expect(searchTree(tree, 'look')[1].children.every((c) => c.shown)).toBe(true);
  });

  it('shows nothing when nothing matches', () => {
    expect(searchTree(tree, 'zzz').some((r) => r.shown)).toBe(false);
  });
});
