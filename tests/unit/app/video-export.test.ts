import { describe, expect, it } from 'vitest';
import {
  estimateVideoBytes,
  videoBitrate,
  videoCodecs,
  videoSupport,
  xcorrLag,
} from '../../../src/app/video-export';

describe('video export settings', () => {
  it('picks H.264 levels and VP9 levels that fit the size and rate', () => {
    expect(videoCodecs(1280, 720, 30)).toEqual([
      'avc1.64001f',
      'avc1.4d001f',
      'avc1.42001f',
      'vp09.00.31.08',
    ]);
    expect(videoCodecs(1920, 1080, 30)[0]).toBe('avc1.640028');
    expect(videoCodecs(1080, 1920, 30)[0]).toBe('avc1.640028');
    expect(videoCodecs(1080, 1080, 30)[0]).toBe('avc1.640020'); // 4624 MBs × 30: level 3.2
    expect(videoCodecs(1920, 1080, 60)[0]).toBe('avc1.64002a');
    expect(videoCodecs(1280, 720, 60)[0]).toBe('avc1.640020');
    expect(videoCodecs(1920, 1080, 30)[3]).toBe('vp09.00.40.08');
    expect(videoCodecs(1920, 1080, 60)[3]).toBe('vp09.00.41.08');
  });

  it('scales the bitrate with pixels and fps; the estimate covers both streams', () => {
    expect(videoBitrate({ aspect: '16:9', size: '1080', fps: 30 })).toBe(8_000_000);
    expect(videoBitrate({ aspect: '16:9', size: '1080', fps: 60 })).toBe(12_000_000);
    expect(videoBitrate({ aspect: '1:1', size: '1080', fps: 30 })).toBe(4_500_000);
    expect(videoBitrate({ aspect: '16:9', size: '720', fps: 30 })).toBeCloseTo(3_555_556, -1);
    const mb = estimateVideoBytes(180, { aspect: '16:9', size: '1080', fps: 30 }) / 1e6;
    expect(mb).toBeGreaterThan(180); // 8.192 Mb/s × 180 s = 184 MB
    expect(mb).toBeLessThan(190);
  });

  it('explains when WebCodecs is missing', async () => {
    const r = await videoSupport({ aspect: '16:9', size: '1080', fps: 30 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/video encoder/);
  });

  it('finds the lag between two signals', () => {
    const a = new Float32Array(2000);
    let s = 1;
    for (let i = 0; i < a.length; i++) {
      s = (s * 1103515245 + 12345) >>> 0;
      a[i] = (s >>> 8) / 0x800000 - 1;
    }
    for (const lag of [-37, 0, 312]) {
      const b = new Float32Array(2400);
      for (let i = 0; i < a.length; i++) if (i + lag >= 0 && i + lag < b.length) b[i + lag] = a[i];
      expect(xcorrLag(a, b, -100, 400)).toBe(lag);
    }
  });
});
