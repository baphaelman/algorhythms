import { describe, expect, it } from 'vitest';
import { normalizeAvcC, vpcCWithColour } from '../../../src/video/mp4';

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));

describe('normalizeAvcC', () => {
  it("repairs Firefox's doubled NAL headers and reserved bits", () => {
    // As Firefox's VideoEncoder emitted it for 1280×720 High 3.1.
    const firefox = hex(
      '0164001f03010019676764001facd9405005ba10000003001001e84800f18319600100066868ebecb22c',
    );
    const fixed = normalizeAvcC(firefox);
    expect([...fixed]).toEqual([
      ...hex('0164001fffe1001867'),
      ...hex('64001facd9405005ba10000003001001e84800f1831960'),
      ...hex('01000568ebecb22c'),
    ]);
  });

  it('leaves well-formed records alone', () => {
    const chromium = hex(
      '01640c1fffe1001367640c1fac18d00a00b74dc0434041e1108d4001000468ce3c80fdf8f800',
    );
    expect(normalizeAvcC(chromium)).toBe(chromium);
    const short = hex('0164');
    expect(normalizeAvcC(short)).toBe(short);
  });
});

describe('vpcCWithColour', () => {
  it("takes the encoder's colour over the codec string's defaults", () => {
    // Chromium's VP9 from a canvas: full range, BT.709 matrix and primaries, sRGB transfer.
    const cs = { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'bt709', fullRange: true };
    expect(vpcCWithColour('vp09.00.31.08', cs)).toEqual([0, 31, 8, 1, 1, 13, 1, 1]);
    expect(vpcCWithColour('vp09.00.31.08', null)).toEqual([0, 31, 8, 1, 1, 1, 1, 0]);
    expect(vpcCWithColour('vp09.00.31.08', { matrix: 'unknown-x' })).toEqual([
      0, 31, 8, 1, 1, 1, 1, 0,
    ]);
  });
});
