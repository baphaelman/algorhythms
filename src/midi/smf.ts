/**
 * A small Standard MIDI File writer (PLAN.md §12): Type 1, explicit status bytes (running status
 * off), variable-length quantities, and the meta events the exporter needs (tempo, track name,
 * end of track). Pure and allocation-light; it returns a `Uint8Array`.
 */

/** Largest value a variable-length quantity can hold (four 7-bit groups). */
export const VLQ_MAX = 0x0fffffff;

/** Encodes `n` (0..VLQ_MAX) as a variable-length quantity, most significant group first. */
export function vlq(n: number): number[] {
  if (!Number.isInteger(n) || n < 0 || n > VLQ_MAX) {
    throw new RangeError(`VLQ out of range: ${n}`);
  }
  const out = [n & 0x7f];
  for (let v = n >>> 7; v > 0; v >>>= 7) out.unshift((v & 0x7f) | 0x80);
  return out;
}

/** One track under construction; events are appended at non-decreasing absolute ticks. */
export class SmfTrack {
  private buf = new Uint8Array(256);
  private len = 0;
  private lastTick = 0;
  private ended = false;

  /** Tick of the most recently added event. */
  get tick(): number {
    return this.lastTick;
  }

  private put(b: number): void {
    if (this.len === this.buf.length) {
      const bigger = new Uint8Array(this.buf.length * 2);
      bigger.set(this.buf);
      this.buf = bigger;
    }
    this.buf[this.len++] = b;
  }

  private delta(tick: number): void {
    if (this.ended) throw new Error('track already ended');
    if (!Number.isInteger(tick) || tick < this.lastTick) {
      throw new RangeError(`event tick ${tick} is not an integer at or after ${this.lastTick}`);
    }
    for (const b of vlq(tick - this.lastTick)) this.put(b);
    this.lastTick = tick;
  }

  /** A channel message: `status` is the high nibble (0x80..0xE0), `channel` 0..15. */
  channel(tick: number, status: number, channel: number, d1: number, d2?: number): void {
    this.delta(tick);
    this.put(status | (channel & 0x0f));
    this.put(d1 & 0x7f);
    if (d2 !== undefined) this.put(d2 & 0x7f);
  }

  noteOn(tick: number, channel: number, note: number, velocity: number): void {
    this.channel(tick, 0x90, channel, note, velocity);
  }

  noteOff(tick: number, channel: number, note: number): void {
    this.channel(tick, 0x80, channel, note, 0);
  }

  controlChange(tick: number, channel: number, controller: number, value: number): void {
    this.channel(tick, 0xb0, channel, controller, value);
  }

  /** `value` is the 14-bit bend, 0..16383, centre 8192. */
  pitchBend(tick: number, channel: number, value: number): void {
    this.channel(tick, 0xe0, channel, value & 0x7f, (value >> 7) & 0x7f);
  }

  /** A meta event `FF type len data`. */
  meta(tick: number, type: number, data: ArrayLike<number>): void {
    this.delta(tick);
    this.put(0xff);
    this.put(type & 0x7f);
    for (const b of vlq(data.length)) this.put(b);
    for (let i = 0; i < data.length; i++) this.put(data[i] & 0xff);
  }

  /** Tempo in microseconds per quarter note (a 3-byte value). */
  tempo(tick: number, microsPerQuarter: number): void {
    this.meta(tick, 0x51, [
      (microsPerQuarter >> 16) & 0xff,
      (microsPerQuarter >> 8) & 0xff,
      microsPerQuarter & 0xff,
    ]);
  }

  /** Track name, UTF-8. */
  name(tick: number, text: string): void {
    this.meta(tick, 0x03, new TextEncoder().encode(text));
  }

  /** Appends end-of-track at `tick` (≥ the last event) and returns the `MTrk` chunk. */
  finish(tick: number = this.lastTick): Uint8Array {
    this.meta(Math.max(tick, this.lastTick), 0x2f, []);
    this.ended = true;
    const out = new Uint8Array(8 + this.len);
    out.set([0x4d, 0x54, 0x72, 0x6b]); // "MTrk"
    new DataView(out.buffer).setUint32(4, this.len);
    out.set(this.buf.subarray(0, this.len), 8);
    return out;
  }
}

/** Assembles a Type 1 file from finished `MTrk` chunks; `ppq` is ticks per quarter note. */
export function writeSmf(ppq: number, trackChunks: Uint8Array[]): Uint8Array {
  if (!Number.isInteger(ppq) || ppq < 1 || ppq > 0x7fff) throw new RangeError(`bad ppq ${ppq}`);
  let size = 14;
  for (const c of trackChunks) size += c.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([0x4d, 0x54, 0x68, 0x64]); // "MThd"
  view.setUint32(4, 6);
  view.setUint16(8, 1); // format 1
  view.setUint16(10, trackChunks.length);
  view.setUint16(12, ppq);
  let o = 14;
  for (const c of trackChunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
