import { strFromU8, unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newPiece } from '../../../src/core/defaults';
import { serializePiece } from '../../../src/core/schema';
import type { Piece } from '../../../src/core/types';
import { Autosaver } from '../../../src/app/persist/autosave';
import {
  evictsAfterAWeek,
  fileState,
  libraryZip,
  memoryLibrary,
  pieceFileName,
  zipNames,
  type Library,
  type LibraryEntry,
} from '../../../src/app/persist/library';

const piece = (title: string): Piece => newPiece({ seed: 1, title });

function setup(lib: Library = memoryLibrary()) {
  let t = 1000;
  let n = 0;
  const firstSave = vi.fn();
  const writeFile = vi.fn((_: LibraryEntry) => Promise.resolve());
  const saver = new Autosaver({
    library: lib,
    serialize: (p) => serializePiece(p),
    now: () => ++t,
    newId: () => `id${++n}`,
    onFirstSave: firstSave,
    writeFile,
  });
  return { lib, saver, firstSave, writeFile };
}

describe('autosave (§11.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('saves an opened example or file only once it is edited', async () => {
    const { lib, saver } = setup();
    saver.loaded(piece('Example'), 'other');
    await vi.advanceTimersByTimeAsync(2000);
    expect(await lib.list()).toEqual([]);
    expect(saver.current).toBeNull();

    saver.edited(piece('Example edited'));
    expect(saver.current).toBe('id1');
    await vi.advanceTimersByTimeAsync(2000);
    const [e] = await lib.list();
    expect(e.id).toBe('id1');
    expect(e.title).toBe('Example edited');
    expect(JSON.parse(e.json).meta.title).toBe('Example edited');
  });

  it('saves Generate and New pieces straight away', async () => {
    const { lib, saver } = setup();
    saver.loaded(piece('Generated'), 'generated');
    saver.loaded(piece('New'), 'new'); // flushes the first
    await vi.advanceTimersByTimeAsync(600);
    expect((await lib.list()).map((e) => e.title).sort()).toEqual(['Generated', 'New']);
  });

  it('debounces by 500 ms and keeps one entry across edits', async () => {
    const { lib, saver } = setup();
    const put = vi.spyOn(lib, 'put');
    saver.loaded(piece('A'), 'other');
    for (let i = 0; i < 5; i++) {
      saver.edited(piece(`A${i}`));
      await vi.advanceTimersByTimeAsync(300);
    }
    expect(put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(put).toHaveBeenCalledTimes(1);
    expect((await lib.list()).map((e) => e.title)).toEqual(['A4']);
    saver.edited(piece('A5'));
    await vi.advanceTimersByTimeAsync(500);
    const all = await lib.list();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('A5');
    expect(all[0].updated).toBeGreaterThan(all[0].created);
  });

  it('reopening an entry keeps editing that entry', async () => {
    const { lib, saver } = setup();
    saver.loaded(piece('First'), 'new');
    await saver.flush();
    saver.loaded(piece('Other'), 'other');
    saver.edited(piece('Other edited'));
    await saver.flush();
    saver.loaded(piece('First'), 'library', 'id1');
    saver.edited(piece('First again'));
    await saver.flush();
    const all = await lib.list();
    expect(all.map((e) => [e.id, e.title])).toEqual([
      ['id1', 'First again'],
      ['id2', 'Other edited'],
    ]);
  });

  it('a load flushes the previous piece’s pending edit to its own entry', async () => {
    const { lib, saver } = setup();
    saver.loaded(piece('X'), 'other');
    saver.edited(piece('X edited'));
    saver.loaded(piece('Y'), 'other');
    await saver.flush();
    expect((await lib.list()).map((e) => e.title)).toEqual(['X edited']);
  });

  it('requests persistent storage once, on the first save', async () => {
    const { saver, firstSave } = setup();
    saver.loaded(piece('A'), 'new');
    await saver.flush();
    saver.edited(piece('B'));
    await saver.flush();
    expect(firstSave).toHaveBeenCalledTimes(1);
  });

  it('a deleted entry is not recreated; the next edit starts a new one', async () => {
    const { lib, saver } = setup();
    saver.loaded(piece('A'), 'new');
    await saver.flush();
    saver.edited(piece('A2'));
    saver.forget('id1');
    await lib.delete('id1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await lib.list()).toEqual([]);
    saver.edited(piece('A3'));
    await saver.flush();
    expect((await lib.list()).map((e) => e.id)).toEqual(['id2']);
  });

  it('adopt saves now and keeps file state; linked entries are written to their file', async () => {
    const { lib, saver, writeFile } = setup();
    saver.loaded(piece('Ex'), 'other');
    const id = await saver.adopt(piece('Ex'));
    const e = (await lib.get(id))!;
    const file = { name: 'ex.algorhythms.json', createWritable: vi.fn() };
    await lib.put({ ...e, file, fileSavedAt: 5 });
    saver.edited(piece('Ex 2'));
    await saver.flush();
    const after = (await lib.get(id))!;
    expect(after.file).toBe(file);
    expect(after.fileSavedAt).toBe(5);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile.mock.calls[0][0].title).toBe('Ex 2');
  });
});

describe('library helpers', () => {
  const entry = (p: Partial<LibraryEntry>): LibraryEntry => ({
    id: 'a',
    title: 'T',
    created: 1,
    updated: 10,
    json: '{}',
    ...p,
  });

  it('file state marker', () => {
    expect(fileState(entry({}))).toBe('none');
    expect(fileState(entry({ fileSavedAt: 10 }))).toBe('saved');
    expect(fileState(entry({ fileSavedAt: 9 }))).toBe('changed');
    expect(
      fileState(entry({ file: { name: 'f', createWritable: () => Promise.reject(new Error()) } })),
    ).toBe('linked');
  });

  it('file names', () => {
    expect(pieceFileName('Dorian / Night')).toBe('Dorian-Night.algorhythms.json');
    expect(zipNames(['A', 'a', 'B', 'A', ''])).toEqual([
      'A.algorhythms.json',
      'a-2.algorhythms.json',
      'B.algorhythms.json',
      'A-3.algorhythms.json',
      'piece.algorhythms.json',
    ]);
  });

  it('zips every entry as .algorhythms.json', async () => {
    const entries = [
      entry({ id: '1', title: 'One', json: serializePiece(piece('One')) }),
      entry({ id: '2', title: 'One', json: serializePiece(piece('One')) }),
      entry({ id: '3', title: 'Two', json: serializePiece(piece('Two')) }),
    ];
    const files = unzipSync(await libraryZip(entries));
    expect(Object.keys(files).sort()).toEqual([
      'One-2.algorhythms.json',
      'One.algorhythms.json',
      'Two.algorhythms.json',
    ]);
    expect(JSON.parse(strFromU8(files['Two.algorhythms.json'])).meta.title).toBe('Two');
  });

  it('memory library lists most recent first', async () => {
    const lib = memoryLibrary();
    await lib.put(entry({ id: 'old', updated: 1 }));
    await lib.put(entry({ id: 'new', updated: 2 }));
    expect((await lib.list()).map((e) => e.id)).toEqual(['new', 'old']);
    await lib.delete('new');
    expect(await lib.get('new')).toBeUndefined();
  });

  it('Safari eviction note', () => {
    const safari =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
    const chrome =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    const firefox =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0';
    expect(evictsAfterAWeek({ userAgent: safari })).toBe(true);
    expect(evictsAfterAWeek({ userAgent: chrome })).toBe(false);
    expect(evictsAfterAWeek({ userAgent: firefox })).toBe(false);
    expect(evictsAfterAWeek({ userAgent: chrome, platform: 'MacIntel', maxTouchPoints: 5 })).toBe(
      true,
    );
  });
});
