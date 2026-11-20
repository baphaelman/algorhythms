/**
 * Streaming store-mode ZIP writer with ZIP64 (PLAN.md §12 "Stems: exact sums and memory").
 *
 * Why in-house: fflate's streaming `Zip` + `ZipPassThrough` writes 32-bit sizes only. Past 4 GiB
 * it silently truncates them (measured in M3c: a 4.13 GiB entry came out with size = true size
 * mod 2^32 and no ZIP64 records), so the archive is corrupt. Store mode needs no compression code,
 * so this writer is small.
 *
 * Every entry's size is known before its data is written (a WAV's length follows from its frame
 * count), but its CRC-32 is not, so entries use data descriptors (flag bit 3). An entry, the
 * central directory offset, or the entry count that no longer fits in 32 (16) bits is written
 * with ZIP64 extra fields; the end of the archive gets the ZIP64 end-of-central-directory record
 * and locator when any central-directory field overflows. Small archives are plain ZIPs that every
 * tool opens.
 *
 * Output goes to an async `sink`, one piece at a time, so a caller can stream it to disk and apply
 * backpressure by awaiting. Nothing but the central directory (~50 bytes per entry) is kept.
 */

/** Receives the archive's bytes in order. May return a promise (backpressure). */
export type ZipSink = (chunk: Uint8Array<ArrayBuffer>) => void | Promise<void>;

/** Options. */
export interface ZipOptions {
  /**
   * Values at or above this switch a size/offset to ZIP64 (default 0xFFFFFFFF, the format's own
   * limit). Tests lower it to exercise every ZIP64 path on small data.
   */
  zip64Threshold?: number;
  /** Modification time stamped on every entry (default: 2000-01-01, so output is reproducible). */
  mtime?: Date;
}

const MAX32 = 0xffffffff;
const MAX16 = 0xffff;

// ---------------------------------------------------------------------------------------------
// CRC-32 (IEEE), slicing-by-4
// ---------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256 * 4);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  for (let n = 0; n < 256; n++) {
    let c = t[n];
    for (let k = 1; k < 4; k++) {
      c = t[c & 0xff] ^ (c >>> 8);
      t[k * 256 + n] = c;
    }
  }
  return t;
})();

/** Updates a running CRC-32 (start with 0) with `data`. */
export function crc32(data: Uint8Array, crc = 0): number {
  const t = CRC_TABLE;
  let c = ~crc;
  let i = 0;
  const n = data.length;
  const end4 = n - (n & 3);
  for (; i < end4; i += 4) {
    c ^= data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
    c =
      t[768 + (c & 0xff)] ^
      t[512 + ((c >>> 8) & 0xff)] ^
      t[256 + ((c >>> 16) & 0xff)] ^
      t[c >>> 24];
  }
  for (; i < n; i++) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

// ---------------------------------------------------------------------------------------------
// Sizes (exact, for estimates)
// ---------------------------------------------------------------------------------------------

const encoder = new TextEncoder();

/** One entry as far as sizing goes. */
export interface ZipEntrySpec {
  name: string;
  /** Uncompressed (= stored) size in bytes. */
  size: number;
}

function layout(
  entries: readonly ZipEntrySpec[],
  opts: ZipOptions,
): { size: number; zip64: boolean } {
  const limit = opts.zip64Threshold ?? MAX32;
  let offset = 0;
  let cdSize = 0;
  let zip64 = false;
  for (const e of entries) {
    const nameLen = encoder.encode(e.name).length;
    const big = e.size >= limit;
    const bigOffset = offset >= limit;
    if (big || bigOffset) zip64 = true;
    offset += 30 + nameLen + (big ? 20 : 0) + e.size + (big ? 24 : 16);
    cdSize += 46 + nameLen + centralExtraLength(big, bigOffset);
  }
  const end = needsZip64End(entries.length, offset, cdSize, limit);
  return { size: offset + cdSize + (end ? 56 + 20 : 0) + 22, zip64: zip64 || end };
}

/** The exact byte length of an archive holding these entries, in order. */
export function zipSize(entries: readonly ZipEntrySpec[], opts: ZipOptions = {}): number {
  return layout(entries, opts).size;
}

/** Whether an archive with these entries uses any ZIP64 record. */
export function zipNeedsZip64(entries: readonly ZipEntrySpec[], opts: ZipOptions = {}): boolean {
  return layout(entries, opts).zip64;
}

function centralExtraLength(bigSize: boolean, bigOffset: boolean): number {
  const fields = (bigSize ? 2 : 0) + (bigOffset ? 1 : 0);
  return fields === 0 ? 0 : 4 + fields * 8;
}

function needsZip64End(count: number, cdOffset: number, cdSize: number, limit: number): boolean {
  return count >= MAX16 || cdOffset >= limit || cdSize >= limit;
}

// ---------------------------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------------------------

interface CentralRecord {
  nameBytes: Uint8Array;
  crc: number;
  size: number;
  offset: number;
  big: boolean;
}

/** DOS date/time: 2000-01-01 00:00:00 unless given. */
function dosTime(d: Date | undefined): { time: number; date: number } {
  if (!d) return { time: 0, date: (20 << 9) | (1 << 5) | 1 };
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

function u64(v: DataView, o: number, n: number): void {
  v.setUint32(o, n % 0x100000000, true);
  v.setUint32(o + 4, Math.floor(n / 0x100000000), true);
}

/**
 * Writes one archive: `begin(name, size)`, `write(chunk)`… until `size` bytes, `end()`; repeat;
 * then `finish()`. Calls must be awaited (they await the sink).
 */
export class ZipWriter {
  private readonly sink: ZipSink;
  private readonly limit: number;
  private readonly stamp: { time: number; date: number };
  private readonly records: CentralRecord[] = [];
  private offset = 0;
  private open: { rec: CentralRecord; written: number; crc: number } | null = null;
  private finished = false;

  constructor(sink: ZipSink, opts: ZipOptions = {}) {
    this.sink = sink;
    this.limit = opts.zip64Threshold ?? MAX32;
    this.stamp = dosTime(opts.mtime);
  }

  /** Bytes emitted so far. */
  get bytesWritten(): number {
    return this.offset;
  }

  private async emit(chunk: Uint8Array<ArrayBuffer>): Promise<void> {
    this.offset += chunk.byteLength;
    await this.sink(chunk);
  }

  /** Starts an entry of exactly `size` bytes. */
  async begin(name: string, size: number): Promise<void> {
    if (this.finished) throw new Error('zip: already finished');
    if (this.open) throw new Error('zip: previous entry not ended');
    const nameBytes = encoder.encode(name);
    const big = size >= this.limit;
    const head = new Uint8Array(30 + nameBytes.length + (big ? 20 : 0));
    const v = new DataView(head.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, big ? 45 : 20, true); // version needed
    v.setUint16(6, 0x0808, true); // bit 3: data descriptor; bit 11: UTF-8 names
    v.setUint16(8, 0, true); // method: store
    v.setUint16(10, this.stamp.time, true);
    v.setUint16(12, this.stamp.date, true);
    // crc and sizes follow in the data descriptor
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, big ? 20 : 0, true);
    if (big) {
      v.setUint32(18, MAX32, true);
      v.setUint32(22, MAX32, true);
    }
    head.set(nameBytes, 30);
    if (big) {
      const o = 30 + nameBytes.length;
      v.setUint16(o, 0x0001, true);
      v.setUint16(o + 2, 16, true);
      u64(v, o + 4, size);
      u64(v, o + 12, size);
    }
    const rec: CentralRecord = { nameBytes, crc: 0, size, offset: this.offset, big };
    this.open = { rec, written: 0, crc: 0 };
    await this.emit(head);
  }

  /** Appends data to the open entry. The chunk is passed to the sink as is (not copied). */
  async write(chunk: Uint8Array<ArrayBuffer>): Promise<void> {
    const o = this.open;
    if (!o) throw new Error('zip: no open entry');
    o.written += chunk.byteLength;
    if (o.written > o.rec.size) throw new Error(`zip: entry ${nameOf(o.rec)} longer than declared`);
    o.crc = crc32(chunk, o.crc);
    await this.emit(chunk);
  }

  /** Ends the open entry with its data descriptor. */
  async end(): Promise<void> {
    const o = this.open;
    if (!o) throw new Error('zip: no open entry');
    if (o.written !== o.rec.size) {
      throw new Error(`zip: entry ${nameOf(o.rec)} has ${o.written} of ${o.rec.size} bytes`);
    }
    o.rec.crc = o.crc;
    this.records.push(o.rec);
    this.open = null;
    const big = o.rec.big;
    const d = new Uint8Array(big ? 24 : 16);
    const v = new DataView(d.buffer);
    v.setUint32(0, 0x08074b50, true);
    v.setUint32(4, o.crc, true);
    if (big) {
      u64(v, 8, o.rec.size);
      u64(v, 16, o.rec.size);
    } else {
      v.setUint32(8, o.rec.size, true);
      v.setUint32(12, o.rec.size, true);
    }
    await this.emit(d);
  }

  /** Writes the central directory and end records. Total archive length is `bytesWritten`. */
  async finish(): Promise<void> {
    if (this.open) throw new Error('zip: entry still open');
    if (this.finished) throw new Error('zip: already finished');
    this.finished = true;
    const cdStart = this.offset;
    let cdSize = 0;
    for (const r of this.records) {
      const bigOffset = r.offset >= this.limit;
      const extra = centralExtraLength(r.big, bigOffset);
      const rec = new Uint8Array(46 + r.nameBytes.length + extra);
      const v = new DataView(rec.buffer);
      const zip64 = r.big || bigOffset;
      v.setUint32(0, 0x02014b50, true);
      v.setUint16(4, zip64 ? 45 : 20, true); // version made by (MS-DOS)
      v.setUint16(6, zip64 ? 45 : 20, true);
      v.setUint16(8, 0x0800, true);
      v.setUint16(10, 0, true);
      v.setUint16(12, this.stamp.time, true);
      v.setUint16(14, this.stamp.date, true);
      v.setUint32(16, r.crc, true);
      v.setUint32(20, r.big ? MAX32 : r.size, true);
      v.setUint32(24, r.big ? MAX32 : r.size, true);
      v.setUint16(28, r.nameBytes.length, true);
      v.setUint16(30, extra, true);
      v.setUint32(42, bigOffset ? MAX32 : r.offset, true);
      rec.set(r.nameBytes, 46);
      if (extra > 0) {
        let o = 46 + r.nameBytes.length;
        v.setUint16(o, 0x0001, true);
        v.setUint16(o + 2, extra - 4, true);
        o += 4;
        if (r.big) {
          u64(v, o, r.size);
          u64(v, o + 8, r.size);
          o += 16;
        }
        if (bigOffset) u64(v, o, r.offset);
      }
      cdSize += rec.byteLength;
      await this.emit(rec);
    }
    const count = this.records.length;
    const zip64End = needsZip64End(count, cdStart, cdSize, this.limit);
    if (zip64End) {
      const z = new Uint8Array(56 + 20);
      const v = new DataView(z.buffer);
      v.setUint32(0, 0x06064b50, true);
      u64(v, 4, 44); // size of the rest of this record
      v.setUint16(12, 45, true);
      v.setUint16(14, 45, true);
      v.setUint32(16, 0, true);
      v.setUint32(20, 0, true);
      u64(v, 24, count);
      u64(v, 32, count);
      u64(v, 40, cdSize);
      u64(v, 48, cdStart);
      v.setUint32(56, 0x07064b50, true); // locator
      v.setUint32(60, 0, true);
      u64(v, 64, cdStart + cdSize);
      v.setUint32(72, 1, true);
      await this.emit(z);
    }
    const e = new Uint8Array(22);
    const v = new DataView(e.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, Math.min(count, MAX16), true);
    v.setUint16(10, Math.min(count, MAX16), true);
    v.setUint32(12, cdSize >= this.limit ? MAX32 : cdSize, true);
    v.setUint32(16, cdStart >= this.limit ? MAX32 : cdStart, true);
    await this.emit(e);
  }
}

function nameOf(rec: CentralRecord): string {
  return new TextDecoder().decode(rec.nameBytes);
}
