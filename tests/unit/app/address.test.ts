import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newPiece } from '../../../src/core/defaults';
import type { Piece } from '../../../src/core/types';
import {
  ADDRESS_KEY,
  AddressBar,
  ownRecord,
  parseAddress,
  readRecord,
  writeRecord,
  type AddressRecord,
} from '../../../src/app/address-rules';

const known = (id: string) => id === 'kite-day' || id === 'crease';

describe('parseAddress', () => {
  it('reads example ids, share payloads and nothing', () => {
    expect(parseAddress('#kite-day', known)).toEqual({ kind: 'example', id: 'kite-day' });
    expect(parseAddress('crease', known)).toEqual({ kind: 'example', id: 'crease' });
    expect(parseAddress('#p=2.abc', known)).toEqual({ kind: 'share', payload: '2.abc' });
    expect(parseAddress('#no-such-piece', known)).toEqual({ kind: 'none' });
    expect(parseAddress('#Kite-Day', known)).toEqual({ kind: 'none' });
    expect(parseAddress('', known)).toEqual({ kind: 'none' });
    expect(parseAddress('#p=', known)).toEqual({ kind: 'none' });
  });
});

describe('the per-tab record', () => {
  it('round-trips and survives bad storage', () => {
    const m = new Map<string, string>();
    const s = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    };
    expect(readRecord(s)).toBeNull();
    writeRecord(s, { hash: '#p=x', entry: 'e1' });
    expect(readRecord(s)).toEqual({ hash: '#p=x', entry: 'e1' });
    m.set(ADDRESS_KEY, '{oops');
    expect(readRecord(s)).toBeNull();
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    };
    expect(readRecord(throwing)).toBeNull();
    expect(() => writeRecord(throwing, { hash: '#a', entry: null })).not.toThrow();
    expect(readRecord(undefined)).toBeNull();
  });

  it('matches only this tab’s own URL', () => {
    const rec = { hash: '#p=x', entry: 'e1' };
    expect(ownRecord('#p=x', rec)).toBe(rec);
    expect(ownRecord('#p=y', rec)).toBeNull();
    expect(ownRecord('', { hash: '', entry: null })).toBeNull();
    expect(ownRecord('#p=x', null)).toBeNull();
  });
});

describe('AddressBar', () => {
  let hash: string;
  let writes: string[];
  let records: AddressRecord[];
  let encodes: Piece[];
  let bar: AddressBar;

  beforeEach(() => {
    vi.useFakeTimers();
    hash = '';
    writes = [];
    records = [];
    encodes = [];
    bar = new AddressBar({
      encode: (p) => {
        encodes.push(p);
        return Promise.resolve(`2.${p.meta.title}`);
      },
      write: (h) => {
        hash = h;
        writes.push(h);
      },
      current: () => hash,
      remember: (r) => void records.push(r),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      idle: (fn) => void setTimeout(fn, 0),
    });
  });
  afterEach(() => vi.useRealTimers());

  const piece = (title: string): Piece => ({
    ...newPiece({ seed: 1 }),
    meta: { ...newPiece({ seed: 1 }).meta, title },
  });

  it('an unedited example reads #<id> at once; its first edit turns it into #p=', async () => {
    bar.loaded(piece('Kite Day'), { example: 'kite-day', entry: null });
    expect(hash).toBe('#kite-day');
    expect(encodes).toHaveLength(0);
    bar.edited(piece('Kite Day 2'), 'e1');
    await vi.advanceTimersByTimeAsync(399);
    expect(hash).toBe('#kite-day');
    await vi.advanceTimersByTimeAsync(10);
    expect(hash).toBe('#p=2.Kite Day 2');
    expect(records.at(-1)).toEqual({ hash: '#p=2.Kite Day 2', entry: 'e1' });
  });

  it('a drag (an edit every frame) encodes once, after the last edit', async () => {
    bar.loaded(piece('A'), { example: 'crease', entry: null });
    for (let i = 0; i < 120; i++) {
      bar.edited(piece(`A${i}`), 'e1');
      await vi.advanceTimersByTimeAsync(16);
    }
    expect(encodes).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(encodes.map((p) => p.meta.title)).toEqual(['A119']);
    expect(writes).toEqual(['#crease', '#p=2.A119']);
  });

  it('other loads encode at idle, without the debounce; a newer load wins', async () => {
    bar.loaded(piece('Gen'), { entry: 'g1' });
    bar.loaded(piece('Gen 2'), { entry: 'g2' });
    await vi.advanceTimersByTimeAsync(1);
    expect(encodes.map((p) => p.meta.title)).toEqual(['Gen 2']);
    expect(hash).toBe('#p=2.Gen 2');
    expect(records.at(-1)).toEqual({ hash: '#p=2.Gen 2', entry: 'g2' });
  });

  it('a stale encode never overwrites a newer piece', async () => {
    bar.edited(piece('Old'), null);
    await vi.advanceTimersByTimeAsync(400); // timer fired, idle pending
    bar.loaded(piece('Ex'), { example: 'kite-day', entry: null });
    await vi.advanceTimersByTimeAsync(10);
    expect(hash).toBe('#kite-day');
  });

  it('a piece opened from the URL keeps that URL and is not re-encoded', async () => {
    hash = '#p=shared';
    bar.loaded(piece('S'), { fromUrl: true, entry: null });
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toEqual([]);
    expect(encodes).toEqual([]);
    expect(bar.isOwn('#p=shared')).toBe(true);
    expect(records).toEqual([{ hash: '#p=shared', entry: null }]);
    // The entry it gets later is remembered for a reload.
    bar.entryChanged('e9');
    expect(records.at(-1)).toEqual({ hash: '#p=shared', entry: 'e9' });
  });

  it('only its own fragment is ignored on hashchange', () => {
    bar.loaded(piece('Kite Day'), { example: 'kite-day', entry: null });
    expect(bar.isOwn('#kite-day')).toBe(true);
    expect(bar.isOwn('#crease')).toBe(false);
  });
});
