/**
 * The in-house store-mode ZIP writer (src/audio/zip.ts): CRC-32, exact sizes, and ZIP64 records
 * (exercised on small data with a lowered threshold, and read back by fflate's unzip and Python's
 * zipfile, two independent readers).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { crc32, ZipWriter, zipNeedsZip64, zipSize, type ZipOptions } from '../../../src/audio/zip';

function pattern(n: number, seed: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    out[i] = x >>> 24;
  }
  return out;
}

async function build(
  files: { name: string; data: Uint8Array<ArrayBuffer>; pieces?: number }[],
  opts: ZipOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const zip = new ZipWriter((c) => void parts.push(c), opts);
  for (const f of files) {
    await zip.begin(f.name, f.data.length);
    const step = Math.max(1, Math.ceil(f.data.length / (f.pieces ?? 1)));
    for (let o = 0; o < f.data.length; o += step) await zip.write(f.data.slice(o, o + step));
    await zip.end();
  }
  await zip.finish();
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  expect(out.length).toBe(zip.bytesWritten);
  return out;
}

describe('crc32', () => {
  it('matches zlib for every length and chunking', () => {
    for (const n of [0, 1, 2, 3, 4, 5, 7, 8, 63, 64, 65, 1000, 4097]) {
      const d = pattern(n, n + 1);
      expect(crc32(d)).toBe(zlibCrc32(d));
      const k = Math.floor(n / 3);
      expect(crc32(d.subarray(k), crc32(d.subarray(0, k)))).toBe(zlibCrc32(d));
    }
  });
});

describe('ZipWriter', () => {
  const files = [
    { name: 'a.wav', data: pattern(5000, 1), pieces: 7 },
    { name: 'empty.bin', data: pattern(0, 2) },
    { name: 'sub/ünï.wav', data: pattern(333, 3) },
  ];

  it('writes a plain zip fflate reads back, with the predicted size', async () => {
    const zip = await build(files);
    const specs = files.map((f) => ({ name: f.name, size: f.data.length }));
    expect(zip.length).toBe(zipSize(specs));
    expect(zipNeedsZip64(specs)).toBe(false);
    const back = unzipSync(zip);
    expect(Object.keys(back)).toEqual(files.map((f) => f.name));
    for (const f of files) expect(Buffer.from(back[f.name]).equals(Buffer.from(f.data))).toBe(true);
    // no ZIP64 end record
    expect(Buffer.from(zip).indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBe(-1);
  });

  it('rejects entries that are shorter or longer than declared', async () => {
    const zip = new ZipWriter(() => undefined);
    await zip.begin('x', 10);
    await zip.write(new Uint8Array(4));
    await expect(zip.end()).rejects.toThrow(/4 of 10/);
    const zip2 = new ZipWriter(() => undefined);
    await zip2.begin('x', 3);
    await expect(zip2.write(new Uint8Array(4))).rejects.toThrow(/longer/);
  });

  it('awaits the sink (backpressure)', async () => {
    let busy = false;
    const zip = new ZipWriter(async () => {
      expect(busy).toBe(false);
      busy = true;
      await new Promise((r) => setTimeout(r, 1));
      busy = false;
    });
    await zip.begin('x', 8);
    await zip.write(new Uint8Array(8));
    await zip.end();
    await zip.finish();
  });

  describe('ZIP64 (threshold lowered to 400 bytes so small data takes every path)', () => {
    const opts = { zip64Threshold: 400 };
    const big = [
      { name: 'small.bin', data: pattern(100, 4) },
      { name: 'big.bin', data: pattern(1000, 5), pieces: 3 }, // entry size past the threshold
      { name: 'after.bin', data: pattern(50, 6) }, // offset past the threshold
    ];

    it('writes ZIP64 entry, offset and end records that two readers accept', async () => {
      const zip = await build(big, opts);
      const specs = big.map((f) => ({ name: f.name, size: f.data.length }));
      expect(zipNeedsZip64(specs, opts)).toBe(true);
      expect(zip.length).toBe(zipSize(specs, opts));
      const buf = Buffer.from(zip);
      expect(buf.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBeGreaterThan(0); // ZIP64 EOCD
      expect(buf.indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]))).toBeGreaterThan(0); // locator

      const back = unzipSync(zip);
      for (const f of big) expect(Buffer.from(back[f.name]).equals(Buffer.from(f.data))).toBe(true);

      // Python's zipfile checks every CRC and reads the ZIP64 records itself.
      const dir = mkdtempSync(join(tmpdir(), 'zip64-'));
      const path = join(dir, 'z.zip');
      writeFileSync(path, zip);
      try {
        const out = execFileSync(
          'python3',
          [
            '-I',
            '-c',
            'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip());print(sum(i.file_size for i in z.infolist()))',
            path,
          ],
          { encoding: 'utf8' },
        );
        expect(out.trim().split('\n')).toEqual(['None', String(100 + 1000 + 50)]);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // no python3: fflate alone
      }
    });

    it('uses the ZIP64 end records for more than 65535 entries', async () => {
      const many = Array.from({ length: 65_540 }, (_, i) => ({
        name: `e${i}`,
        data: new Uint8Array(0),
      }));
      const zip = await build(many);
      expect(Buffer.from(zip).indexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]))).toBeGreaterThan(0);
      expect(Object.keys(unzipSync(zip))).toHaveLength(65_540);
    });
  });
});
