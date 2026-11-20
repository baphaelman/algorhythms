/** Byte-level checks of the in-house SMF writer. */

import { describe, expect, it } from 'vitest';
import { SmfTrack, VLQ_MAX, vlq, writeSmf } from '../../../src/midi/smf';

const hex = (b: ArrayLike<number>): string =>
  Array.from(b as number[], (x) => x.toString(16).padStart(2, '0')).join(' ');

describe('vlq', () => {
  it.each([
    [0, '00'],
    [0x40, '40'],
    [0x7f, '7f'],
    [0x80, '81 00'],
    [0x2000, 'c0 00'],
    [0x3fff, 'ff 7f'],
    [0x4000, '81 80 00'],
    [0x1fffff, 'ff ff 7f'],
    [0x200000, '81 80 80 00'],
    [VLQ_MAX, 'ff ff ff 7f'],
  ])('encodes %i as %s', (n, bytes) => {
    expect(hex(vlq(n))).toBe(bytes);
  });

  it('rejects values it cannot hold', () => {
    expect(() => vlq(-1)).toThrow(RangeError);
    expect(() => vlq(VLQ_MAX + 1)).toThrow(RangeError);
    expect(() => vlq(1.5)).toThrow(RangeError);
  });
});

describe('SmfTrack and writeSmf', () => {
  it('writes exact bytes for a small Type 1 file, with chunk lengths', () => {
    const t = new SmfTrack();
    t.name(0, 'A');
    t.tempo(0, 500000);
    t.noteOn(0, 0, 60, 100);
    t.noteOff(480, 0, 60);
    const chunk = t.finish();
    expect(hex(chunk)).toBe(
      [
        '4d 54 72 6b 00 00 00 19', // MTrk, 25 bytes
        '00 ff 03 01 41', // name "A"
        '00 ff 51 03 07 a1 20', // tempo 500000 µs
        '00 90 3c 64', // note-on, explicit status
        '83 60 80 3c 00', // delta 480, note-off, explicit status
        '00 ff 2f 00', // end of track
      ].join(' '),
    );
    const file = writeSmf(960, [chunk, chunk]);
    expect(hex(file.subarray(0, 14))).toBe('4d 54 68 64 00 00 00 06 00 01 00 02 03 c0');
    expect(file.length).toBe(14 + 2 * chunk.length);
    expect(hex(file.subarray(14, 22))).toBe('4d 54 72 6b 00 00 00 19');
  });

  it('never uses running status: repeated messages repeat their status byte', () => {
    const t = new SmfTrack();
    t.controlChange(0, 2, 11, 5);
    t.controlChange(0, 2, 11, 6);
    t.pitchBend(10, 2, 8192);
    const c = t.finish(10);
    expect(hex(c.subarray(8))).toBe('00 b2 0b 05 00 b2 0b 06 0a e2 00 40 00 ff 2f 00');
  });

  it('pads end-of-track to the requested tick and rejects out-of-order events', () => {
    const t = new SmfTrack();
    t.noteOn(5, 0, 60, 1);
    expect(() => t.noteOff(4, 0, 60)).toThrow(RangeError);
    expect(hex(t.finish(1000).subarray(-5))).toBe('87 63 ff 2f 00');
  });

  it('grows past its initial buffer', () => {
    const t = new SmfTrack();
    for (let i = 0; i < 1000; i++) t.pitchBend(i, 0, i);
    const c = t.finish();
    const len = new DataView(c.buffer, c.byteOffset).getUint32(4);
    expect(len).toBe(c.length - 8);
    expect(len).toBe(1000 * 4 + 4); // 1000 × (delta + 3 bytes) + end of track
  });
});
