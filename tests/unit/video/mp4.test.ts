import { describe, expect, it } from 'vitest';
import {
  aacConfig,
  memorySink,
  Mp4Muxer,
  vpcCFields,
  type Mp4Chunk,
  type Mp4Options,
} from '../../../src/video/mp4';
import { body, movieInfo, one, parseBoxes, tracks, type TrackInfo } from './boxes';

/** Chunk bytes that name their track and index, with varied sizes. */
function payload(tag: number, i: number): Uint8Array {
  const b = new Uint8Array(20 + ((i * 37) % 300));
  b[0] = tag;
  b[1] = i >> 8;
  b[2] = i & 0xff;
  return b;
}

const FPS = 30;
const SECONDS = 2;
const videoChunks = (): Mp4Chunk[] =>
  Array.from({ length: FPS * SECONDS }, (_, i) => ({
    data: payload(0x56, i),
    timestamp: Math.round((i * 1e6) / FPS),
    duration: Math.round(1e6 / FPS),
    key: i % 30 === 0,
  }));
/** 20 ms Opus-like frames (960 samples at 48 kHz). */
const audioChunks = (n = SECONDS * 50): Mp4Chunk[] =>
  Array.from({ length: n }, (_, i) => ({
    data: payload(0x41, i),
    timestamp: i * 20000,
    duration: 20000,
    key: true,
  }));

const OPUS_HEAD = (preSkip: number) => {
  const b = new Uint8Array(19);
  b.set([...'OpusHead'].map((c) => c.charCodeAt(0)));
  b[8] = 1;
  b[9] = 2;
  new DataView(b.buffer).setUint16(10, preSkip, true);
  new DataView(b.buffer).setUint32(12, 48000, true);
  return b;
};

/** Feeds video and audio interleaved the way two encoders might (audio running a bit ahead). */
async function mux(
  opts: Partial<Mp4Options>,
  v: Mp4Chunk[] | null = videoChunks(),
  a: Mp4Chunk[] | null = audioChunks(),
  order: 'mixed' | 'audio-first' | 'video-first' = 'mixed',
): Promise<Uint8Array> {
  const sink = memorySink();
  const m = new Mp4Muxer({
    layout: 'streaming',
    sink,
    video: v ? { codec: 'vp09.00.10.08', width: 320, height: 240, frameRate: FPS } : undefined,
    audio: a
      ? { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, description: OPUS_HEAD(0) }
      : undefined,
    ...opts,
  });
  const ev: { t: number; f: () => Promise<void> }[] = [];
  const at = (ts: number, isAudio: boolean) =>
    order === 'mixed'
      ? ts - (isAudio ? 1e5 : 0)
      : ts + (isAudio === (order === 'video-first') ? 1e9 : 0);
  v?.forEach((c) => ev.push({ t: at(c.timestamp, false), f: () => m.addVideoChunk(c) }));
  a?.forEach((c) => ev.push({ t: at(c.timestamp, true), f: () => m.addAudioChunk(c) }));
  ev.sort((x, y) => x.t - y.t);
  for (const e of ev) await e.f();
  await m.finish();
  return sink.bytes();
}

const types = (f: Uint8Array) => parseBoxes(f).map((b) => b.type);
const tag = (f: Uint8Array, s: { offset: number }) => [
  f[s.offset],
  (f[s.offset + 1] << 8) | f[s.offset + 2],
];
const video = (f: Uint8Array) => tracks(f).find((t) => t.handler === 'vide')!;
const audio = (f: Uint8Array) => tracks(f).find((t) => t.handler === 'soun')!;

function checkSamples(f: Uint8Array, t: TrackInfo, code: number, chunks: Mp4Chunk[]): void {
  expect(t.samples.length).toBe(chunks.length);
  t.samples.forEach((s, i) => {
    expect(tag(f, s)).toEqual([code, i]);
    expect(s.size).toBe(chunks[i].data.length);
    expect(s.key).toBe(chunks[i].key);
  });
}

describe.each(['streaming', 'faststart'] as const)('%s layout', (layout) => {
  it('writes the boxes in order, with every sample at its bytes', async () => {
    const f = await mux({ layout });
    expect(types(f)).toEqual(
      layout === 'streaming' ? ['ftyp', 'mdat', 'moov'] : ['ftyp', 'moov', 'mdat'],
    );
    const mdat = parseBoxes(f).find((b) => b.type === 'mdat')!;
    expect(mdat.header).toBe(layout === 'streaming' ? 16 : 8);
    const v = video(f);
    const a = audio(f);
    checkSamples(f, v, 0x56, videoChunks());
    checkSamples(f, a, 0x41, audioChunks());
    // Every byte of the mdat payload belongs to exactly one sample.
    const total = [...v.samples, ...a.samples].reduce((n, s) => n + s.size, 0);
    expect(total).toBe(mdat.size - mdat.header);
    for (const s of [...v.samples, ...a.samples]) {
      expect(s.offset).toBeGreaterThanOrEqual(mdat.start + mdat.header);
      expect(s.offset + s.size).toBeLessThanOrEqual(mdat.start + mdat.size);
    }
    expect(v.co64).toBe(false);
  });

  it('has the right timescales, durations and key frames', async () => {
    const f = await mux({ layout });
    const v = video(f);
    const a = audio(f);
    expect(v.timescale).toBe(30000);
    expect(a.timescale).toBe(48000);
    expect(v.samples.map((s) => s.dts)).toEqual(videoChunks().map((_, i) => i * 1000));
    expect(v.samples.every((s) => s.cts === s.dts)).toBe(true);
    expect(v.mediaDuration).toBe(60 * 1000);
    expect(a.mediaDuration).toBe(100 * 960);
    expect(v.tkhdDuration).toBe(2000);
    expect(a.tkhdDuration).toBe(2000);
    expect(movieInfo(f)).toEqual({ timescale: 1000, duration: 2000 });
    expect(v.edits).toEqual([]);
    expect(v.width).toBe(320);
    expect(v.height).toBe(240);
    const stss = body(f, one(parseBoxes(f), 'moov/trak/mdia/minf/stbl/stss'));
    expect(new DataView(stss.buffer, stss.byteOffset).getUint32(4)).toBe(2);
    expect(v.samples.filter((s) => s.key).length).toBe(2);
  });

  it('interleaves runs of about 0.5 s by time', async () => {
    for (const order of ['mixed', 'audio-first', 'video-first'] as const) {
      const f = await mux({ layout }, undefined, undefined, order);
      const v = video(f);
      const a = audio(f);
      const runs = [
        ...v.chunkOffsets.map((o) => ({
          o,
          t: v.samples.find((s) => s.offset === o)!.dts / v.timescale,
        })),
        ...a.chunkOffsets.map((o) => ({
          o,
          t: a.samples.find((s) => s.offset === o)!.dts / a.timescale,
        })),
      ].sort((x, y) => x.o - y.o);
      expect(v.chunkOffsets.length).toBe(4);
      expect(a.chunkOffsets.length).toBe(4);
      // Run start times in file order never go back by more than a run.
      for (let i = 1; i < runs.length; i++) expect(runs[i].t).toBeGreaterThan(runs[i - 1].t - 0.51);
      expect(runs.map((r) => r.t)).toEqual([0, 0, 0.5, 0.5, 1, 1, 1.5, 1.5]);
    }
  });

  it('uses co64 (and a 64-bit mdat size) past the threshold', async () => {
    const f = await mux({ layout, largeThreshold: 1000 });
    const v = video(f);
    const a = audio(f);
    expect(v.co64).toBe(true);
    expect(a.co64).toBe(true);
    expect(parseBoxes(f).find((b) => b.type === 'mdat')!.header).toBe(16);
    checkSamples(f, v, 0x56, videoChunks());
    checkSamples(f, a, 0x41, audioChunks());
  });
});

describe('Mp4Muxer', () => {
  it('writes the same tables in both layouts', async () => {
    const s = await mux({ layout: 'streaming' });
    const q = await mux({ layout: 'faststart' });
    const strip = (t: TrackInfo) => ({
      ...t,
      entry: null,
      chunkOffsets: null,
      samples: t.samples.map((x) => ({ ...x, offset: 0 })),
    });
    expect(tracks(s).map(strip)).toEqual(tracks(q).map(strip));
  });

  it('flushes without waiting once the buffer is full', async () => {
    const sink = memorySink();
    const m = new Mp4Muxer({
      layout: 'streaming',
      sink,
      video: { codec: 'vp9', width: 64, height: 64, frameRate: FPS },
      audio: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 },
      maxBufferBytes: 2000,
    });
    for (const c of videoChunks()) await m.addVideoChunk(c);
    expect(sink.size).toBeGreaterThan(5000); // audio hasn't started: video is written anyway
    for (const c of audioChunks()) await m.addAudioChunk(c);
    await m.finish();
    const f = sink.bytes();
    checkSamples(f, video(f), 0x56, videoChunks());
    checkSamples(f, audio(f), 0x41, audioChunks());
  });

  it('writes ctts and an edit list for reordered (B-frame) video', async () => {
    // Decode order I P B B P B B …: presentation 0 3 1 2 6 4 5 …
    const pres = [0, 3, 1, 2, 6, 4, 5, 9, 7, 8];
    const v = pres.map((p, i) => ({
      data: payload(0x56, i),
      timestamp: Math.round((p * 1e6) / FPS),
      duration: Math.round(1e6 / FPS),
      key: i === 0,
    }));
    const sink = memorySink();
    const m = new Mp4Muxer({
      layout: 'faststart',
      sink,
      video: {
        codec: 'avc1.64001f',
        width: 64,
        height: 64,
        frameRate: FPS,
        description: new Uint8Array(7),
      },
    });
    for (const c of v) await m.addVideoChunk(c); // decode order
    await m.finish();
    const f = sink.bytes();
    const t = video(f);
    checkSamples(f, t, 0x56, v);
    expect(t.samples.map((s) => s.dts)).toEqual(pres.map((_, i) => i * 1000));
    // The B-frame decoded 3rd is shown 2nd: decoding starts one frame early.
    expect(t.edits).toEqual([{ duration: 333, mediaTime: 1000 }]);
    // Presented order after the edit = the original times.
    expect(t.samples.map((s) => (s.cts - t.edits[0].mediaTime) / 1000)).toEqual(pres);
  });

  it('skips Opus pre-skip with an edit list and writes it to dOps', async () => {
    const sink = memorySink();
    const m = new Mp4Muxer({
      layout: 'faststart',
      sink,
      audio: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, description: OPUS_HEAD(312) },
    });
    for (const c of audioChunks()) await m.addAudioChunk(c);
    await m.finish();
    const f = sink.bytes();
    const a = audio(f);
    expect(a.entry.type).toBe('Opus');
    expect(a.edits).toEqual([{ duration: 1994, mediaTime: 312 }]); // 2 s − 6.5 ms
    const dOps = body(
      f,
      a.entry.children.find((b) => b.type === 'dOps')!,
    );
    expect([...dOps.subarray(0, 4)]).toEqual([0, 2, 312 >> 8, 312 & 0xff]);
    expect(new DataView(dOps.buffer, dOps.byteOffset).getUint32(4)).toBe(48000);
  });

  it("lays audio out contiguously whatever the encoder's timestamps (Firefox's Opus)", async () => {
    // Firefox shifts Opus timestamps back by the pre-skip (6.5 ms) and clamps the first to 0.
    const shifted = audioChunks().map((c) => ({
      ...c,
      timestamp: Math.max(0, c.timestamp - 6500),
    }));
    expect(shifted[1].timestamp).toBe(13500);
    const sink = memorySink();
    const m = new Mp4Muxer({
      layout: 'faststart',
      sink,
      audio: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2, description: OPUS_HEAD(312) },
    });
    for (const c of shifted) await m.addAudioChunk(c);
    await m.finish();
    const a = audio(sink.bytes());
    expect(a.samples.map((s) => s.dts)).toEqual(shifted.map((_, i) => i * 960));
    expect(a.edits).toEqual([{ duration: 1994, mediaTime: 312 }]);
  });

  it('writes AAC with esds, priming and a late start', async () => {
    const sink = memorySink();
    const m = new Mp4Muxer({
      layout: 'streaming',
      sink,
      video: { codec: 'avc1.640028', width: 1920, height: 1080, frameRate: 30 },
      audio: { codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, primingSamples: 1024 },
    });
    const avcC = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe0, 0]);
    const v = videoChunks().map((c) => ({ ...c, timestamp: c.timestamp + 100000 }));
    for (const [i, c] of v.entries())
      await m.addVideoChunk(c, i ? undefined : { decoderConfig: { description: avcC } });
    for (let i = 0; i < 96; i++) {
      await m.addAudioChunk({
        data: payload(0x41, i),
        timestamp: Math.round((i * 1024 * 1e6) / 48000),
        duration: 21333,
        key: true,
      });
    }
    await m.finish();
    const f = sink.bytes();
    const vt = video(f);
    const at = audio(f);
    expect(vt.entry.type).toBe('avc1');
    expect([...body(f, vt.entry.children[0])]).toEqual([...avcC]);
    expect(vt.edits).toEqual([
      { duration: 100, mediaTime: -1 },
      { duration: 2000, mediaTime: 0 },
    ]);
    expect(vt.tkhdDuration).toBe(2100);
    expect(at.edits).toEqual([
      { duration: Math.round(((96 - 1) * 1024 * 1000) / 48000), mediaTime: 1024 },
    ]);
    const esds = body(f, at.entry.children[0]);
    expect(at.entry.children[0].type).toBe('esds');
    // …DecoderSpecificInfo (tag 5, 4-byte length 2) then the AudioSpecificConfig.
    const asc = aacConfig('mp4a.40.2', 48000, 2);
    expect([...asc]).toEqual([0x11, 0x90]);
    const i = esds.findIndex((b, k) => b === 5 && esds[k + 4] === 2);
    expect([...esds.subarray(i + 5, i + 7)]).toEqual([...asc]);
    const ftyp = body(f, parseBoxes(f)[0]);
    expect(String.fromCharCode(...ftyp.subarray(8))).toContain('avc1');
  });

  it('needs avcC for H.264', async () => {
    const m = new Mp4Muxer({
      layout: 'faststart',
      sink: memorySink(),
      video: { codec: 'avc1.42001f', width: 2, height: 2 },
    });
    await m.addVideoChunk({ data: payload(1, 0), timestamp: 0, duration: 1000, key: true });
    await expect(m.finish()).rejects.toThrow(/avcC/);
  });

  it('rejects unknown codecs and empty tracks', async () => {
    expect(
      () =>
        new Mp4Muxer({
          layout: 'faststart',
          sink: memorySink(),
          video: { codec: 'av01.0', width: 2, height: 2 },
        }),
    ).toThrow(/unsupported/);
    const m = new Mp4Muxer({
      layout: 'faststart',
      sink: memorySink(),
      audio: { codec: 'opus', sampleRate: 48000, numberOfChannels: 1 },
    });
    await expect(m.finish()).rejects.toThrow(/no chunks/);
  });

  it('builds vpcC fields from the codec string', () => {
    expect(vpcCFields('vp09.00.10.08')).toEqual([0, 10, 8, 1, 1, 1, 1, 0]);
    expect(vpcCFields('vp09.02.41.10.01.09.16.09.01')).toEqual([2, 41, 10, 1, 9, 16, 9, 1]);
    expect(vpcCFields('vp9')).toEqual([0, 40, 8, 1, 1, 1, 1, 0]);
  });

  it('awaits an async sink in order', async () => {
    const got: { len: number; pos?: number }[] = [];
    const sink = {
      async write(b: Uint8Array, pos?: number) {
        await new Promise((r) => setTimeout(r, 0));
        got.push({ len: b.length, pos });
      },
    };
    const m = new Mp4Muxer({
      layout: 'streaming',
      sink,
      audio: { codec: 'opus', sampleRate: 48000, numberOfChannels: 2 },
    });
    for (const c of audioChunks()) void m.addAudioChunk(c);
    await m.finish();
    expect(got.at(-1)).toEqual({ len: 8, pos: 28 + 8 }); // the mdat size patch is last
    expect(got.slice(0, -1).every((g) => g.pos === undefined)).toBe(true);
  });
});

describe('memorySink', () => {
  it('patches positioned writes across parts', () => {
    const s = memorySink();
    s.write(new Uint8Array([1, 2, 3]));
    s.write(new Uint8Array([4, 5]));
    s.write(new Uint8Array([9, 9]), 2);
    expect([...s.bytes()]).toEqual([1, 2, 9, 9, 5]);
    expect(() => s.write(new Uint8Array(4), 3)).toThrow();
  });
});
