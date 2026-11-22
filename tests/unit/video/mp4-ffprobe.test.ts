/**
 * Real streams through the muxer, checked by ffprobe/ffmpeg: ffmpeg encodes a test pattern and a
 * tone into MP4, the samples are read back out (tests/unit/video/boxes.ts) and re-muxed, and the
 * result must probe and decode like the source. Skipped without ffmpeg (CI may not have it).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  memorySink,
  Mp4Muxer,
  type Mp4AudioConfig,
  type Mp4Chunk,
  type Mp4VideoConfig,
} from '../../../src/video/mp4';
import { body, tracks, type TrackInfo } from './boxes';

const has = (cmd: string) => {
  try {
    execFileSync(cmd, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const FFMPEG = has('ffmpeg') && has('ffprobe');
const dir = FFMPEG ? mkdtempSync(join(tmpdir(), 'algorhythms-mp4-')) : '';
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

interface Probe {
  streams: {
    codec_type: string;
    codec_name: string;
    duration: string;
    nb_read_frames: string;
    start_time: string;
  }[];
  format: { duration: string };
}
const probe = (file: string): Probe =>
  JSON.parse(
    run('ffprobe', [
      '-v',
      'error',
      '-count_frames',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      file,
    ]),
  ) as Probe;

/** Per-frame hashes of the decoded streams (timestamps dropped). */
const frameHashes = (file: string) =>
  run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'framemd5', '-'])
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const c = l.split(',').map((x) => x.trim());
      return `${c[0]} ${c[4]} ${c[5]}`; // stream, size, hash
    });

function chunksOf(file: Uint8Array, t: TrackInfo, shift: number): Mp4Chunk[] {
  return t.samples.map((s, i) => ({
    data: file.slice(s.offset, s.offset + s.size),
    timestamp: Math.round(((s.cts - shift) * 1e6) / t.timescale),
    duration: Math.round(
      (((t.samples[i + 1]?.dts ?? t.mediaDuration) - s.dts) * 1e6) / t.timescale,
    ),
    key: s.key,
  }));
}

/** The AudioSpecificConfig in an esds body (ES_Descriptor > DecoderConfig > DecoderSpecificInfo). */
function asc(esds: Uint8Array): Uint8Array {
  let at = 4;
  const desc = () => {
    const tag = esds[at++];
    let len = 0;
    for (let b = 0x80; b & 0x80;) len = (len << 7) | ((b = esds[at++]) & 0x7f);
    return { tag, len };
  };
  expect(desc().tag).toBe(3);
  at += 3; // ES_ID, flags
  expect(desc().tag).toBe(4);
  at += 13;
  const d = desc();
  expect(d.tag).toBe(5);
  return esds.slice(at, at + d.len);
}

async function remux(src: string, layout: 'streaming' | 'faststart'): Promise<string> {
  const file = new Uint8Array(readFileSync(src));
  const [vt, at] = ['vide', 'soun'].map((h) => tracks(file).find((t) => t.handler === h)!);
  const child = (t: TrackInfo, type: string) =>
    body(
      file,
      t.entry.children.find((b) => b.type === type)!,
    );

  const video: Mp4VideoConfig =
    vt.entry.type === 'avc1'
      ? {
          codec: 'avc1.64000d',
          width: vt.width,
          height: vt.height,
          frameRate: 30,
          description: child(vt, 'avcC'),
        }
      : (() => {
          const c = child(vt, 'vpcC');
          const p = (n: number) => String(n).padStart(2, '0');
          return {
            codec: `vp09.${p(c[4])}.${p(c[5])}.${p(c[6] >> 4)}`,
            width: vt.width,
            height: vt.height,
            frameRate: 30,
          };
        })();
  const priming = at.edits.at(-1)?.mediaTime ?? 0;
  let audio: Mp4AudioConfig;
  if (at.entry.type === 'mp4a') {
    const esds = child(at, 'esds');
    audio = {
      codec: 'mp4a.40.2',
      sampleRate: 48000,
      numberOfChannels: 2,
      description: asc(esds),
      primingSamples: priming,
    };
  } else {
    const d = child(at, 'dOps');
    const head = new Uint8Array(19);
    head.set([...'OpusHead'].map((c) => c.charCodeAt(0)));
    const v = new DataView(head.buffer);
    head[8] = 1;
    head[9] = d[1];
    v.setUint16(10, (d[2] << 8) | d[3], true);
    v.setUint32(12, 48000, true);
    audio = { codec: 'opus', sampleRate: 48000, numberOfChannels: d[1], description: head };
  }

  const sink = memorySink();
  const m = new Mp4Muxer({ layout, sink, video, audio });
  const vs = chunksOf(file, vt, vt.edits.at(-1)?.mediaTime ?? 0).map((c) => ({ c, v: true }));
  const as = chunksOf(file, at, 0).map((c) => ({ c, v: false }));
  // Interleave by decode order, as two encoders' callbacks would.
  let i = 0;
  let j = 0;
  while (i < vs.length || j < as.length) {
    if (j >= as.length || (i < vs.length && i / 30 <= as[j].c.timestamp / 1e6))
      void m.addVideoChunk(vs[i++].c);
    else void m.addAudioChunk(as[j++].c);
  }
  await m.finish();
  const out = join(dir, `${src.split('/').at(-1)}.${layout}.mp4`);
  writeFileSync(out, sink.bytes());
  return out;
}

const SOURCES = {
  'h264 + aac': ['-c:v', 'libx264', '-bf', '0', '-g', '30', '-c:a', 'aac'],
  'h264 (B-frames) + aac': ['-c:v', 'libx264', '-bf', '3', '-g', '30', '-c:a', 'aac'],
  'vp9 + opus': [
    '-c:v',
    'libvpx-vp9',
    '-deadline',
    'realtime',
    '-cpu-used',
    '8',
    '-g',
    '30',
    '-c:a',
    'libopus',
  ],
};

describe.skipIf(!FFMPEG)('mp4 muxer vs ffprobe', () => {
  describe.each(Object.entries(SOURCES))('%s', (name, codecArgs) => {
    const src = join(dir, `${name.replace(/\W+/g, '-')}.mp4`);
    let made = false;
    it.each(['streaming', 'faststart'] as const)(
      '%s probes and decodes like the source',
      async (layout) => {
        // prettier-ignore
        if (!made) run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-pix_fmt', 'yuv420p', ...codecArgs, '-ac', '2', '-b:a', '96k', src]);
        made = true;
        const out = await remux(src, layout);
        const a = probe(src);
        const b = probe(out);
        for (const type of ['video', 'audio']) {
          const sa = a.streams.find((s) => s.codec_type === type)!;
          const sb = b.streams.find((s) => s.codec_type === type)!;
          expect(sb.codec_name).toBe(sa.codec_name);
          expect(sb.nb_read_frames).toBe(sa.nb_read_frames);
          expect(Math.abs(Number(sb.duration) - Number(sa.duration))).toBeLessThan(1 / 30);
          expect(Math.abs(Number(sb.start_time) - Number(sa.start_time))).toBeLessThan(0.002);
        }
        expect(Math.abs(Number(b.format.duration) - 2)).toBeLessThan(1 / 30);
        expect(frameHashes(out)).toEqual(frameHashes(src));
      },
    );
  });
});
