import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HIGH_BITRATES,
  QUALITY_SCALE,
  estimateVideoBytes,
  etaText,
  videoBitrate,
  videoCodecs,
  videoEta,
  videoSizes,
  videoSupport,
  xcorrLag,
} from '../../../src/app/video-export';
import type { VideoAspect, VideoSize } from '../../../src/render/video';

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
    // 1440p and 4K: H.264 levels 5.0–5.2, VP9 5.0/5.1.
    expect(videoCodecs(2560, 1440, 30)[0]).toBe('avc1.640032');
    expect(videoCodecs(2560, 1440, 60)[0]).toBe('avc1.640033');
    expect(videoCodecs(3840, 2160, 30)[0]).toBe('avc1.640033');
    expect(videoCodecs(3840, 2160, 60)[0]).toBe('avc1.640034');
    expect(videoCodecs(2160, 3840, 60)[0]).toBe('avc1.640034');
    expect(videoCodecs(3840, 2160, 30)[3]).toBe('vp09.00.50.08');
    expect(videoCodecs(3840, 2160, 60)[3]).toBe('vp09.00.51.08');
  });

  it('High is YouTube’s upload rate per size and fps; 9:16 the same, 1:1 by pixels', () => {
    const rate = (size: VideoSize, fps: 30 | 60, aspect: VideoAspect = '16:9') =>
      videoBitrate({ aspect, size, fps }) / 1e6;
    expect([rate('1080', 30), rate('1080', 60)]).toEqual([8, 12]);
    expect([rate('1440', 30), rate('1440', 60)]).toEqual([16, 24]);
    expect([rate('2160', 30), rate('2160', 60)]).toEqual([45, 68]);
    expect(rate('720', 30)).toBeCloseTo(8 * (4 / 9), 5); // 1080p's by pixels, as before M11
    expect(rate('720', 60)).toBeCloseTo(12 * (4 / 9), 5);
    for (const size of Object.keys(HIGH_BITRATES) as VideoSize[]) {
      expect(rate(size, 60, '9:16')).toBe(rate(size, 60));
      expect(rate(size, 30, '1:1')).toBeCloseTo((rate(size, 30) * 9) / 16, 5);
    }
  });

  it('Standard is 0.6× High and Max 1.5×; High is the default', () => {
    expect(QUALITY_SCALE).toEqual({ standard: 0.6, high: 1, max: 1.5 });
    const o = { aspect: '16:9', size: '2160', fps: 60 } as const;
    expect(videoBitrate({ ...o, quality: 'high' })).toBe(videoBitrate(o));
    expect(videoBitrate({ ...o, quality: 'standard' })).toBe(40_800_000);
    expect(videoBitrate({ ...o, quality: 'max' })).toBe(102_000_000);
    expect(estimateVideoBytes(60, { ...o, quality: 'max' })).toBeGreaterThan(
      estimateVideoBytes(60, o),
    );
  });

  it('estimates the time left from frames done and their rate', () => {
    expect(videoEta(5, 100, 2)).toBeUndefined(); // too few frames
    expect(videoEta(50, 100, 0.5)).toBeUndefined(); // too early
    expect(videoEta(25, 100, 10)).toBe(30);
    expect(videoEta(100, 100, 40)).toBe(0);
    expect(etaText(4)).toBe('A few seconds left');
    expect(etaText(44)).toBe('About 40 s left');
    expect(etaText(150)).toBe('About 3 min left');
    expect(etaText(3600 + 25 * 60)).toBe('About 1 h 25 min left');
    expect(etaText(7200)).toBe('About 2 h left');
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

  describe('with WebCodecs (mocked)', () => {
    afterEach(() => vi.unstubAllGlobals());
    /** An encoder that takes H.264 up to `maxLevel`, VP9 if `vp9`, and the given audio. */
    const stub = (o: { maxLevel: number; vp9: boolean; audio: string[] }) => {
      vi.stubGlobal('VideoFrame', class {});
      vi.stubGlobal('OffscreenCanvas', class {});
      vi.stubGlobal('VideoEncoder', {
        isConfigSupported: (c: VideoEncoderConfig) =>
          Promise.resolve({
            supported: c.codec.startsWith('avc1')
              ? parseInt(c.codec.slice(-2), 16) <= o.maxLevel
              : o.vp9,
          }),
      });
      vi.stubGlobal('AudioEncoder', {
        isConfigSupported: (c: AudioEncoderConfig) =>
          Promise.resolve({ supported: o.audio.includes(c.codec) }),
      });
    };

    it('offers the sizes the encoder accepts: 4K needs H.264 5.1+ or VP9', async () => {
      stub({ maxLevel: 0x2a, vp9: false, audio: ['opus'] });
      expect(await videoSizes({ aspect: '16:9', fps: 30 })).toEqual(['720', '1080']);
      stub({ maxLevel: 0x33, vp9: false, audio: ['opus'] });
      expect(await videoSizes({ aspect: '16:9', fps: 30 })).toEqual([
        '720',
        '1080',
        '1440',
        '2160',
      ]);
      expect(await videoSizes({ aspect: '16:9', fps: 60 })).toEqual(['720', '1080', '1440']);
      stub({ maxLevel: 0x2a, vp9: true, audio: ['opus'] });
      expect(await videoSizes({ aspect: '9:16', fps: 60 })).toEqual([
        '720',
        '1080',
        '1440',
        '2160',
      ]);
      const r = await videoSupport({ aspect: '16:9', size: '2160', fps: 60 });
      expect(r).toEqual({ ok: true, video: 'vp09.00.51.08', audio: 'opus', aac: false });
    });

    it('prefers AAC-LC whenever the browser can encode it, else Opus', async () => {
      stub({ maxLevel: 0x34, vp9: true, audio: ['opus', 'mp4a.40.2'] });
      expect(await videoSupport({ aspect: '16:9', size: '1080', fps: 30 })).toEqual({
        ok: true,
        video: 'avc1.640028',
        audio: 'mp4a.40.2',
        aac: true,
      });
      stub({ maxLevel: 0x34, vp9: true, audio: ['opus'] });
      expect(await videoSupport({ aspect: '16:9', size: '1080', fps: 30 })).toMatchObject({
        audio: 'opus',
        aac: false,
      });
      stub({ maxLevel: 0x34, vp9: true, audio: [] });
      expect((await videoSupport({ aspect: '16:9', size: '1080', fps: 30 })).ok).toBe(false);
    });
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
