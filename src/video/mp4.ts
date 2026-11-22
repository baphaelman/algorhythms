/**
 * A small MP4 (ISO BMFF) muxer for video export (PLAN.md §12 "Video export", §15 M8): one video
 * track (H.264 `avc1` + avcC, or VP9 `vp09` + vpcC) and one audio track (AAC `mp4a` + esds, or
 * Opus `Opus` + dOps), fed with encoded chunks as WebCodecs produces them. Pure: no DOM, no
 * WebCodecs types at runtime.
 *
 * Layouts:
 * - `streaming`: ftyp, mdat (64-bit size placeholder), runs as they become ready, moov at the end,
 *   then the mdat size patched with one positioned write (the last write). For File System Access
 *   writables, which accept `{ type: 'write', position, data }`.
 * - `faststart`: ftyp, moov, mdat. Chunk bytes are kept by reference until `finish`, which writes
 *   ftyp + moov + mdat header as one array and then each chunk's own bytes (no giant copy).
 *
 * Runs: chunks are written in runs of about `runSeconds` per track, the earliest-starting run
 * first, and a run waits for the other track to reach its end (so players read forward), unless
 * the buffered bytes pass `maxBufferBytes`.
 *
 * Timing:
 * - Timescales: video `frameRate × 1000` (or 90000 without a frame rate), audio = sample rate
 *   (48000 for Opus).
 * - Video: each timestamp is rounded to ticks on its own, so rounding never drifts. Decode times
 *   are the sorted presentation times (assumes chunks come in decode order, as WebCodecs gives
 *   them). Without reordering (no B-frames) that is the identity and no ctts is written; with
 *   reordering, ctts (v0) holds the offsets and the edit list removes the delay. Sample durations
 *   are decode-time deltas; the last sample takes the latest presented chunk's duration.
 * - Audio is taken as contiguous: sample i starts at the first chunk's timestamp plus the
 *   durations before it (AAC-LC: 1024 samples each). Encoders disagree on timestamps: Chromium's
 *   Opus chunks start at the input's timestamps, Firefox's are shifted back by the pre-skip with
 *   the first clamped to 0; both bitstreams carry the same priming.
 * - Edit list (written only when needed): presentation time of a sample = (pts − priming) / ts.
 *   A track starting later than 0 gets an empty edit; priming (and anything before t = 0) is cut
 *   by `media_time`. `primingSamples` defaults to the OpusHead pre-skip for Opus (also written to
 *   dOps, as ffmpeg does) and to 0 for AAC (pass the encoder's delay if known).
 */

/** Receives the file's bytes in order; `position` is given only for the final mdat-size patch. */
export interface Mp4Sink {
  write(bytes: Uint8Array, position?: number): void | Promise<void>;
}

/** One encoded chunk. The muxer keeps `data` by reference: don't reuse its buffer. */
export interface Mp4Chunk {
  data: Uint8Array;
  /** Presentation timestamp, µs. */
  timestamp: number;
  /** µs. */
  duration?: number | null;
  key: boolean;
}

type Bytes = ArrayBufferLike | ArrayBufferView;

/** The parts of WebCodecs' `EncodedVideoChunkMetadata.decoderConfig` / audio's that matter. */
export interface Mp4DecoderConfig {
  codec?: string;
  description?: Bytes;
  codedWidth?: number;
  codedHeight?: number;
  sampleRate?: number;
  numberOfChannels?: number;
  /** WebCodecs' VideoColorSpaceInit; written to vpcC (VP9). */
  colorSpace?: Mp4ColorSpace;
}

/** As WebCodecs' VideoColorSpaceInit. */
export interface Mp4ColorSpace {
  primaries?: string | null;
  transfer?: string | null;
  matrix?: string | null;
  fullRange?: boolean | null;
}

export interface Mp4VideoConfig {
  /** WebCodecs codec string: `avc1.*` / `avc3.*` or `vp09.*` (`vp9` for defaults). */
  codec: string;
  width: number;
  height: number;
  /** avcC for H.264 (required by `finish`; may arrive with the first chunk's metadata). */
  description?: Bytes;
  frameRate?: number;
  /** Overrides the default timescale. */
  timescale?: number;
}

export interface Mp4AudioConfig {
  /** `mp4a.40.*` (AAC) or `opus`. */
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  /** AudioSpecificConfig (AAC) or OpusHead (Opus). Built from the fields when missing. */
  description?: Bytes;
  /** Leading decoded samples to drop (see the header). */
  primingSamples?: number;
}

export interface Mp4Options {
  layout: 'streaming' | 'faststart';
  sink: Mp4Sink;
  video?: Mp4VideoConfig;
  audio?: Mp4AudioConfig;
  /** Target run length per track (default 0.5 s). */
  runSeconds?: number;
  /** Buffered bytes past which runs are written without waiting (default 32 MiB). */
  maxBufferBytes?: number;
  /** mvhd/tkhd/elst timescale (default 1000). */
  movieTimescale?: number;
  /**
   * Offsets above this use co64, and (faststart) an mdat this large gets a 64-bit size. Default
   * 0xFFFFFFFF; tests lower it to exercise the 64-bit paths on small files.
   */
  largeThreshold?: number;
}

const U32 = 0xffffffff;
const I32 = 0x7fffffff;

// ---------------------------------------------------------------------------------------------
// Byte writer
// ---------------------------------------------------------------------------------------------

class Writer {
  buf = new Uint8Array(1024);
  len = 0;

  private room(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  u8(v: number): void {
    this.room(1);
    this.buf[this.len++] = v & 0xff;
  }
  u16(v: number): void {
    this.u8(v >>> 8);
    this.u8(v);
  }
  u24(v: number): void {
    this.u8(v >>> 16);
    this.u16(v & 0xffff);
  }
  u32(v: number): void {
    this.u16((v >>> 16) & 0xffff);
    this.u16(v & 0xffff);
  }
  /** Up to 2^53. */
  u64(v: number): void {
    this.u32(Math.floor(v / 0x100000000));
    this.u32(v >>> 0);
  }
  i16(v: number): void {
    this.u16(v & 0xffff);
  }
  i32(v: number): void {
    this.u32(v >>> 0);
  }
  bytes(b: Uint8Array): void {
    this.room(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  zeros(n: number): void {
    for (let i = 0; i < n; i++) this.u8(0);
  }
  fourcc(s: string): void {
    for (let i = 0; i < 4; i++) this.u8(s.charCodeAt(i));
  }
  box(type: string, body: () => void): void {
    const start = this.len;
    this.u32(0);
    this.fourcc(type);
    body();
    const size = this.len - start;
    this.buf[start] = size >>> 24;
    this.buf[start + 1] = size >>> 16;
    this.buf[start + 2] = size >>> 8;
    this.buf[start + 3] = size;
  }
  full(type: string, version: number, flags: number, body: () => void): void {
    this.box(type, () => {
      this.u8(version);
      this.u24(flags);
      body();
    });
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

function toBytes(b: Bytes): Uint8Array {
  return ArrayBuffer.isView(b)
    ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice()
    : new Uint8Array(b).slice();
}

/**
 * Repairs an avcC record as Firefox's H.264 encoder emits it (seen in 2026-11): every SPS/PPS
 * starts with its NAL header byte twice (`67 67 64 …`, `68 68 …`, lengths counting both) and the
 * reserved bits are 0, so ffmpeg (and players reading the avcC) misparse the SPS. Detected by
 * the SPS's profile_idc reading 0x67 (no such profile). Anything else is returned unchanged.
 */
export function normalizeAvcC(b: Uint8Array): Uint8Array {
  if (b.length < 7 || b[0] !== 1) return b;
  const nSps = b[5] & 0x1f;
  if (nSps === 0 || b.length < 9) return b;
  const first = b.subarray(8, 8 + ((b[6] << 8) | b[7]));
  if (first.length < 2 || first[0] !== 0x67 || first[1] !== 0x67) return b;
  const out: number[] = [1, b[1], b[2], b[3], 0xfc | (b[4] & 3), 0xe0 | nSps];
  let at = 6;
  const copy = (count: number, header: number): boolean => {
    for (let i = 0; i < count; i++) {
      if (at + 2 > b.length) return false;
      const len = (b[at] << 8) | b[at + 1];
      const nal = b.subarray(at + 2, at + 2 + len);
      if (nal.length !== len) return false;
      const doubled = len >= 2 && nal[0] === header && nal[1] === header;
      const fixed = doubled ? nal.subarray(1) : nal;
      out.push(fixed.length >> 8, fixed.length & 0xff, ...fixed);
      at += 2 + len;
    }
    return true;
  };
  if (!copy(nSps, 0x67)) return b;
  if (at >= b.length) return b;
  const nPps = b[at++];
  out.push(nPps);
  if (!copy(nPps, 0x68)) return b;
  for (; at < b.length; at++) out.push(b[at]); // High-profile extension, as given
  return new Uint8Array(out);
}

const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];

// ---------------------------------------------------------------------------------------------
// Codecs
// ---------------------------------------------------------------------------------------------

type VideoKind = 'avc' | 'vp9';
type AudioKind = 'aac' | 'opus';

function videoKind(codec: string): VideoKind {
  if (/^avc[13](\.|$)/.test(codec)) return 'avc';
  if (/^vp09(\.|$)/.test(codec) || codec === 'vp9') return 'vp9';
  throw new Error(`mp4: unsupported video codec ${codec}`);
}

function audioKind(codec: string): AudioKind {
  if (/^mp4a\.40(\.|$)/.test(codec) || codec === 'aac') return 'aac';
  if (codec === 'opus') return 'opus';
  throw new Error(`mp4: unsupported audio codec ${codec}`);
}

const PRIMARIES: Record<string, number> = {
  bt709: 1,
  bt470bg: 5,
  smpte170m: 6,
  bt2020: 9,
  smpte432: 12,
};
const TRANSFERS: Record<string, number> = {
  bt709: 1,
  smpte170m: 6,
  linear: 8,
  'iec61966-2-1': 13,
  pq: 16,
  hlg: 18,
};
const MATRICES: Record<string, number> = {
  rgb: 0,
  bt709: 1,
  bt470bg: 5,
  smpte170m: 6,
  'bt2020-ncl': 9,
};

/**
 * vpcC fields with the colour of the encoder's output (`colorSpace`) over the codec string's
 * (Chromium's VP9 is full range with the sRGB transfer, which the codec string doesn't say).
 */
export function vpcCWithColour(codec: string, cs?: Mp4ColorSpace | null): number[] {
  const f = vpcCFields(codec);
  if (!cs) return f;
  const p = cs.primaries ? PRIMARIES[cs.primaries] : undefined;
  const t = cs.transfer ? TRANSFERS[cs.transfer] : undefined;
  const m = cs.matrix ? MATRICES[cs.matrix] : undefined;
  if (p !== undefined) f[4] = p;
  if (t !== undefined) f[5] = t;
  if (m !== undefined) f[6] = m;
  if (typeof cs.fullRange === 'boolean') f[7] = cs.fullRange ? 1 : 0;
  return f;
}

/** vpcC (v1) fields from `vp09.PP.LL.DD[.CC.cp.tc.mc.FF]`; defaults as the VP9 codec string spec. */
export function vpcCFields(codec: string): number[] {
  const p = codec.split('.').slice(1).map(Number);
  const d = [0, 40, 8, 1, 1, 1, 1, 0];
  return d.map((v, i) => (Number.isFinite(p[i]) ? p[i] : v));
}

const AAC_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000,
];

/** AudioSpecificConfig for AAC-LC (or the object type in `mp4a.40.N`). */
export function aacConfig(codec: string, sampleRate: number, channels: number): Uint8Array {
  const aot = Number(codec.split('.')[2]) || 2;
  const fi = AAC_RATES.indexOf(sampleRate);
  if (fi < 0) throw new Error(`mp4: no AAC frequency index for ${sampleRate} Hz`);
  return new Uint8Array([(aot << 3) | (fi >> 1), ((fi & 1) << 7) | ((channels & 15) << 3)]);
}

interface OpusHead {
  channels: number;
  preSkip: number;
  inputRate: number;
  gain: number;
  family: number;
  /** StreamCount, CoupledCount, ChannelMapping[] (family ≠ 0). */
  mapping: Uint8Array;
}

/** Reads an OpusHead (RFC 7845 §5.1; little-endian). */
export function parseOpusHead(b: Uint8Array): OpusHead {
  const magic = String.fromCharCode(...b.subarray(0, 8));
  if (magic !== 'OpusHead' || b.length < 19) throw new Error('mp4: bad OpusHead');
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    channels: b[9],
    preSkip: v.getUint16(10, true),
    inputRate: v.getUint32(12, true),
    gain: v.getInt16(16, true),
    family: b[18],
    mapping: b.slice(19, 21 + b[9]),
  };
}

// ---------------------------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------------------------

class Track {
  readonly sizes: number[] = [];
  /** Presentation ticks in decode order. */
  readonly pts: number[] = [];
  /** Duration ticks (−1 = unknown). */
  readonly durs: number[] = [];
  readonly keys: boolean[] = [];
  readonly chunkOffsets: number[] = [];
  readonly chunkCounts: number[] = [];
  pending: Mp4Chunk[] = [];
  receivedEndUs = -Infinity;
  bytes = 0;
  description: Uint8Array | null = null;
  colorSpace: Mp4ColorSpace | null = null;

  constructor(
    readonly kind: 'video' | 'audio',
    readonly id: number,
    readonly timescale: number,
  ) {}

  ticks(us: number): number {
    return Math.round((us * this.timescale) / 1e6);
  }
}

/** Per-track tables derived at `finish`. */
interface Timing {
  /** Decode-time deltas (stts), one per sample. */
  deltas: number[];
  /** Composition offsets (ctts), or null when all zero. */
  offsets: number[] | null;
  /** Sum of deltas: the media duration. */
  mediaDuration: number;
  /** Edit list entries in movie ticks / media ticks, or null. */
  edits: { duration: number; mediaTime: number }[] | null;
  /** tkhd duration, movie ticks. */
  duration: number;
}

// ---------------------------------------------------------------------------------------------
// Muxer
// ---------------------------------------------------------------------------------------------

export class Mp4Muxer {
  private readonly sink: Mp4Sink;
  private readonly layout: 'streaming' | 'faststart';
  private readonly video: (Mp4VideoConfig & { kind: VideoKind }) | null;
  private readonly audio: (Mp4AudioConfig & { kind: AudioKind }) | null;
  private readonly vt: Track | null;
  private readonly at: Track | null;
  private readonly tracks: Track[];
  private readonly runUs: number;
  private readonly maxBuffer: number;
  private readonly movieTs: number;
  private readonly large: number;
  private readonly ftyp: Uint8Array;
  private queue: Promise<void> = Promise.resolve();
  /** streaming: absolute file position; faststart: position within the mdat payload. */
  private pos = 0;
  private pendingBytes = 0;
  /** faststart: chunk bytes in mdat order. */
  private readonly parts: Uint8Array[] = [];
  private finished = false;

  constructor(opts: Mp4Options) {
    if (!opts.video && !opts.audio) throw new Error('mp4: no tracks');
    this.sink = opts.sink;
    this.layout = opts.layout;
    this.runUs = (opts.runSeconds ?? 0.5) * 1e6;
    this.maxBuffer = opts.maxBufferBytes ?? 32 * 1024 * 1024;
    this.movieTs = opts.movieTimescale ?? 1000;
    this.large = opts.largeThreshold ?? U32;
    this.video = opts.video ? { ...opts.video, kind: videoKind(opts.video.codec) } : null;
    this.audio = opts.audio ? { ...opts.audio, kind: audioKind(opts.audio.codec) } : null;
    this.vt = this.video
      ? new Track(
          'video',
          1,
          this.video.timescale ??
            (this.video.frameRate ? Math.round(this.video.frameRate * 1000) : 90000),
        )
      : null;
    this.at = this.audio
      ? new Track(
          'audio',
          this.video ? 2 : 1,
          this.audio.kind === 'opus' ? 48000 : this.audio.sampleRate,
        )
      : null;
    if (this.vt && this.video?.description) this.vt.description = this.avcc(this.video.description);
    if (this.at && this.audio?.description) this.at.description = toBytes(this.audio.description);
    this.tracks = [this.vt, this.at].filter((t): t is Track => t !== null);

    const w = new Writer();
    w.box('ftyp', () => {
      w.fourcc('isom');
      w.u32(0x200);
      for (const b of ['isom', 'iso2', ...(this.video?.kind === 'avc' ? ['avc1'] : []), 'mp41'])
        w.fourcc(b);
    });
    this.ftyp = w.done();
    if (this.layout === 'streaming') {
      const head = new Uint8Array(this.ftyp.length + 16);
      head.set(this.ftyp);
      const v = new DataView(head.buffer);
      v.setUint32(this.ftyp.length, 1);
      head.set([0x6d, 0x64, 0x61, 0x74], this.ftyp.length + 4); // 'mdat', largesize patched later
      this.emit(head);
      this.pos = head.length;
    }
  }

  private avcc(d: Bytes): Uint8Array {
    const b = toBytes(d);
    return this.video?.kind === 'avc' ? normalizeAvcC(b) : b;
  }

  /** Adds a video chunk; `meta` is WebCodecs' output metadata (its decoderConfig, if any). */
  addVideoChunk(chunk: Mp4Chunk, meta?: { decoderConfig?: Mp4DecoderConfig }): Promise<void> {
    if (!this.vt || !this.video) throw new Error('mp4: no video track');
    const dc = meta?.decoderConfig;
    if (dc?.description) this.vt.description = this.avcc(dc.description);
    if (dc?.colorSpace) this.vt.colorSpace = dc.colorSpace;
    if (dc?.codec && videoKind(dc.codec) === this.video.kind) this.video.codec = dc.codec;
    return this.add(this.vt, chunk);
  }

  /** Adds an audio chunk; `meta` as for video. */
  addAudioChunk(chunk: Mp4Chunk, meta?: { decoderConfig?: Mp4DecoderConfig }): Promise<void> {
    if (!this.at || !this.audio) throw new Error('mp4: no audio track');
    const dc = meta?.decoderConfig;
    if (dc?.description) this.at.description = toBytes(dc.description);
    return this.add(this.at, chunk);
  }

  /** Writes what is left and the moov; resolves when the sink has taken every byte. */
  async finish(): Promise<void> {
    if (this.finished) throw new Error('mp4: already finished');
    for (const t of this.tracks) {
      if (t.sizes.length === 0) throw new Error(`mp4: the ${t.kind} track has no chunks`);
    }
    this.flush(true);
    this.finished = true;
    const timings = new Map(this.tracks.map((t) => [t, this.timing(t)]));
    if (this.layout === 'streaming') {
      const mdatSize = this.pos - this.ftyp.length;
      const co64 = this.tracks.some((t) => t.chunkOffsets.some((o) => o > this.large));
      this.emit(this.moov(timings, co64, 0));
      const patch = new Uint8Array(8);
      new DataView(patch.buffer).setBigUint64(0, BigInt(mdatSize));
      this.emit(patch, this.ftyp.length + 8);
    } else {
      const payload = this.pos;
      const hdr = payload + 8 > this.large ? 16 : 8;
      const maxRel = this.tracks.reduce((m, t) => Math.max(m, t.chunkOffsets.at(-1)!), 0);
      let co64 = false;
      let size = this.moov(timings, false, 0).length;
      if (this.ftyp.length + size + hdr + maxRel > this.large) {
        co64 = true;
        size = this.moov(timings, true, 0).length;
      }
      const base = this.ftyp.length + size + hdr;
      const moov = this.moov(timings, co64, base);
      const head = new Uint8Array(base);
      head.set(this.ftyp);
      head.set(moov, this.ftyp.length);
      const v = new DataView(head.buffer, this.ftyp.length + moov.length);
      if (hdr === 16) {
        v.setUint32(0, 1);
        v.setBigUint64(8, BigInt(payload + 16));
      } else {
        v.setUint32(0, payload + 8);
      }
      head.set([0x6d, 0x64, 0x61, 0x74], this.ftyp.length + moov.length + 4);
      this.emit(head);
      for (const p of this.parts) this.emit(p);
      this.parts.length = 0;
    }
    await this.queue;
  }

  // -------------------------------------------------------------------------------------------

  private emit(bytes: Uint8Array, position?: number): Promise<void> {
    const sink = this.sink;
    this.queue = this.queue.then(() =>
      position === undefined ? sink.write(bytes) : sink.write(bytes, position),
    );
    return this.queue;
  }

  private add(t: Track, c: Mp4Chunk): Promise<void> {
    if (this.finished) throw new Error('mp4: already finished');
    t.sizes.push(c.data.length);
    t.pts.push(t.ticks(c.timestamp));
    let dur = -1;
    if (t.kind === 'audio') {
      if (this.audio?.kind === 'aac' && /^mp4a\.40\.2$|^aac$/.test(this.audio.codec)) dur = 1024;
      else if (c.duration != null) dur = Math.round((c.duration * t.timescale) / 1e6);
    } else if (c.duration != null) {
      dur = t.ticks(c.timestamp + c.duration) - t.ticks(c.timestamp);
    }
    t.durs.push(dur);
    if (t.kind === 'video') t.keys.push(c.key);
    t.receivedEndUs = Math.max(t.receivedEndUs, c.timestamp + (c.duration ?? 0));
    t.pending.push(c);
    t.bytes += c.data.length;
    this.pendingBytes += c.data.length;
    this.flush(false);
    return this.queue;
  }

  /** Writes every run that is ready (all of them when `final`). */
  private flush(final: boolean): void {
    for (;;) {
      let x: Track | null = null;
      for (const t of this.tracks) {
        if (t.pending.length && (!x || t.pending[0].timestamp < x.pending[0].timestamp)) x = t;
      }
      if (!x) return;
      const end = x.pending[0].timestamp + this.runUs;
      let n = 1;
      while (n < x.pending.length && x.pending[n].timestamp < end) n++;
      if (!final && this.pendingBytes < this.maxBuffer) {
        if (n === x.pending.length) return; // the run may grow
        if (this.tracks.some((y) => y !== x && y.receivedEndUs < end)) return; // the other lags
      }
      this.writeRun(x, n);
    }
  }

  private writeRun(t: Track, n: number): void {
    const run = t.pending.splice(0, n);
    let bytes = 0;
    for (const c of run) bytes += c.data.length;
    this.pendingBytes -= bytes;
    t.chunkOffsets.push(this.pos);
    t.chunkCounts.push(n);
    this.pos += bytes;
    if (this.layout === 'faststart') {
      for (const c of run) this.parts.push(c.data);
    } else if (n === 1) {
      this.emit(run[0].data);
    } else {
      const out = new Uint8Array(bytes);
      let o = 0;
      for (const c of run) {
        out.set(c.data, o);
        o += c.data.length;
      }
      this.emit(out);
    }
  }

  private timing(t: Track): Timing {
    const n = t.pts.length;
    if (t.kind === 'audio') {
      // Contiguous: each sample starts where the one before ends.
      for (let i = 1; i < n; i++) {
        const d = t.durs[i - 1] >= 0 ? t.durs[i - 1] : t.pts[i] - t.pts[i - 1];
        t.pts[i] = t.pts[i - 1] + d;
      }
    }
    const sorted = [...t.pts].sort((a, b) => a - b);
    let delay = 0;
    for (let i = 0; i < n; i++) delay = Math.max(delay, sorted[i] - t.pts[i]);
    let lastPresented = 0;
    for (let i = 1; i < n; i++) if (t.pts[i] >= t.pts[lastPresented]) lastPresented = i;
    const deltas: number[] = [];
    for (let i = 0; i + 1 < n; i++) deltas.push(sorted[i + 1] - sorted[i]);
    const fallback =
      t.kind === 'video' && this.video?.frameRate
        ? Math.round(t.timescale / this.video.frameRate)
        : 1;
    const lastDur = t.durs[lastPresented];
    deltas.push(lastDur >= 0 ? lastDur : n > 1 ? deltas[n - 2] : fallback);
    let offsets: number[] | null = null;
    if (delay > 0 || t.pts.some((p, i) => p !== sorted[i])) {
      offsets = t.pts.map((p, i) => p - sorted[i] + delay);
    }
    let mediaDuration = 0;
    for (const d of deltas) mediaDuration += d;

    // Edit list: media pts m shows at (m − delay + p_min − priming) / timescale.
    const priming = t.kind === 'audio' ? this.primingTicks() : 0;
    const pMin = sorted[0];
    const toMovie = (ticks: number) => Math.round((ticks * this.movieTs) / t.timescale);
    let empty = 0;
    let mediaTime = delay + priming - pMin;
    if (mediaTime < delay) {
      empty = toMovie(pMin - priming);
      mediaTime = delay;
    }
    const shown = toMovie(Math.max(0, delay + mediaDuration - mediaTime));
    let edits: Timing['edits'] = null;
    if (empty > 0 || mediaTime > 0) {
      edits = [];
      if (empty > 0) edits.push({ duration: empty, mediaTime: -1 });
      edits.push({ duration: shown, mediaTime });
    }
    return { deltas, offsets, mediaDuration, edits, duration: empty + shown };
  }

  private primingTicks(): number {
    const a = this.audio;
    if (!a) return 0;
    if (a.primingSamples !== undefined) {
      return Math.round((a.primingSamples * (this.at?.timescale ?? a.sampleRate)) / a.sampleRate);
    }
    if (a.kind === 'opus' && this.at?.description)
      return parseOpusHead(this.at.description).preSkip;
    return 0;
  }

  // -------------------------------------------------------------------------------------------
  // moov
  // -------------------------------------------------------------------------------------------

  private moov(timings: Map<Track, Timing>, co64: boolean, base: number): Uint8Array {
    const w = new Writer();
    const duration = Math.max(...this.tracks.map((t) => timings.get(t)!.duration));
    w.box('moov', () => {
      const v1 = duration > U32 ? 1 : 0;
      w.full('mvhd', v1, 0, () => {
        this.times(w, v1);
        w.u32(this.movieTs);
        if (v1) w.u64(duration);
        else w.u32(duration);
        w.u32(0x10000);
        w.u16(0x100);
        w.zeros(10);
        for (const m of MATRIX) w.u32(m);
        w.zeros(24);
        w.u32(this.tracks.length + 1);
      });
      for (const t of this.tracks) this.trak(w, t, timings.get(t)!, co64, base);
    });
    return w.done();
  }

  private times(w: Writer, v1: number): void {
    w.zeros(v1 ? 16 : 8); // creation and modification times: 0 (reproducible output)
  }

  private trak(w: Writer, t: Track, tm: Timing, co64: boolean, base: number): void {
    const video = t.kind === 'video';
    w.box('trak', () => {
      const v1 = tm.duration > U32 ? 1 : 0;
      w.full('tkhd', v1, 3, () => {
        this.times(w, v1);
        w.u32(t.id);
        w.u32(0);
        if (v1) w.u64(tm.duration);
        else w.u32(tm.duration);
        w.zeros(8);
        w.u16(0); // layer
        w.u16(0); // alternate group
        w.u16(video ? 0 : 0x100);
        w.u16(0);
        for (const m of MATRIX) w.u32(m);
        w.u32(video ? (this.video!.width & 0xffff) * 0x10000 : 0);
        w.u32(video ? (this.video!.height & 0xffff) * 0x10000 : 0);
      });
      if (tm.edits) {
        const edits = tm.edits;
        const e1 = edits.some((e) => e.duration > U32 || e.mediaTime > I32) ? 1 : 0;
        w.box('edts', () =>
          w.full('elst', e1, 0, () => {
            w.u32(edits.length);
            for (const e of edits) {
              if (e1) {
                w.u64(e.duration);
                if (e.mediaTime < 0) {
                  w.u32(U32);
                  w.u32(U32);
                } else w.u64(e.mediaTime);
              } else {
                w.u32(e.duration);
                w.i32(e.mediaTime);
              }
              w.u16(1);
              w.u16(0);
            }
          }),
        );
      }
      w.box('mdia', () => {
        const m1 = tm.mediaDuration > U32 ? 1 : 0;
        w.full('mdhd', m1, 0, () => {
          this.times(w, m1);
          w.u32(t.timescale);
          if (m1) w.u64(tm.mediaDuration);
          else w.u32(tm.mediaDuration);
          w.u16(0x55c4); // 'und'
          w.u16(0);
        });
        w.full('hdlr', 0, 0, () => {
          w.u32(0);
          w.fourcc(video ? 'vide' : 'soun');
          w.zeros(12);
          for (const ch of video ? 'VideoHandler' : 'SoundHandler') w.u8(ch.charCodeAt(0));
          w.u8(0);
        });
        w.box('minf', () => {
          if (video) w.full('vmhd', 0, 1, () => w.zeros(8));
          else w.full('smhd', 0, 0, () => w.zeros(4));
          w.box('dinf', () =>
            w.full('dref', 0, 0, () => {
              w.u32(1);
              w.full('url ', 0, 1, () => {});
            }),
          );
          w.box('stbl', () => this.stbl(w, t, tm, co64, base));
        });
      });
    });
  }

  private stbl(w: Writer, t: Track, tm: Timing, co64: boolean, base: number): void {
    w.full('stsd', 0, 0, () => {
      w.u32(1);
      if (t.kind === 'video') this.videoEntry(w, t);
      else this.audioEntry(w, t, tm);
    });
    w.full('stts', 0, 0, () => runLength(w, tm.deltas));
    if (tm.offsets) {
      const offsets = tm.offsets;
      w.full('ctts', 0, 0, () => runLength(w, offsets));
    }
    if (t.kind === 'video' && t.keys.some((k) => !k)) {
      w.full('stss', 0, 0, () => {
        const sync: number[] = [];
        t.keys.forEach((k, i) => k && sync.push(i + 1));
        w.u32(sync.length);
        for (const s of sync) w.u32(s);
      });
    }
    w.full('stsc', 0, 0, () => {
      const entries: [number, number][] = [];
      t.chunkCounts.forEach((c, i) => {
        if (!entries.length || entries[entries.length - 1][1] !== c) entries.push([i + 1, c]);
      });
      w.u32(entries.length);
      for (const [first, count] of entries) {
        w.u32(first);
        w.u32(count);
        w.u32(1);
      }
    });
    w.full('stsz', 0, 0, () => {
      w.u32(0);
      w.u32(t.sizes.length);
      for (const s of t.sizes) w.u32(s);
    });
    w.full(co64 ? 'co64' : 'stco', 0, 0, () => {
      w.u32(t.chunkOffsets.length);
      for (const o of t.chunkOffsets) {
        if (co64) w.u64(o + base);
        else w.u32(o + base);
      }
    });
  }

  private videoEntry(w: Writer, t: Track): void {
    const v = this.video!;
    w.box(v.kind === 'avc' ? 'avc1' : 'vp09', () => {
      w.zeros(6);
      w.u16(1); // data reference index
      w.zeros(16);
      w.u16(v.width);
      w.u16(v.height);
      w.u32(0x480000);
      w.u32(0x480000);
      w.u32(0);
      w.u16(1); // frame count
      w.zeros(32); // compressor name
      w.u16(0x18);
      w.i16(-1);
      if (v.kind === 'avc') {
        if (!t.description) throw new Error('mp4: H.264 needs the avcC description');
        const d = t.description;
        w.box('avcC', () => w.bytes(d));
      } else {
        const [profile, level, depth, chroma, prim, transfer, matrix, full] = vpcCWithColour(
          v.codec,
          t.colorSpace,
        );
        w.full('vpcC', 1, 0, () => {
          w.u8(profile);
          w.u8(level);
          w.u8((depth << 4) | (chroma << 1) | (full & 1));
          w.u8(prim);
          w.u8(transfer);
          w.u8(matrix);
          w.u16(0);
        });
      }
    });
  }

  private audioEntry(w: Writer, t: Track, tm: Timing): void {
    const a = this.audio!;
    const opus = a.kind === 'opus';
    w.box(opus ? 'Opus' : 'mp4a', () => {
      w.zeros(6);
      w.u16(1);
      w.zeros(8);
      w.u16(a.numberOfChannels);
      w.u16(16);
      w.zeros(4);
      w.u32((opus ? 48000 : a.sampleRate) * 0x10000);
      if (opus) {
        const h = t.description ? parseOpusHead(t.description) : null;
        w.box('dOps', () => {
          w.u8(0);
          w.u8(h?.channels ?? a.numberOfChannels);
          w.u16(h?.preSkip ?? this.primingTicks());
          w.u32(h?.inputRate ?? a.sampleRate);
          w.i16(h?.gain ?? 0);
          w.u8(h?.family ?? 0);
          if (h && h.family !== 0) w.bytes(h.mapping);
        });
      } else {
        const asc = t.description ?? aacConfig(a.codec, a.sampleRate, a.numberOfChannels);
        const seconds = tm.mediaDuration / t.timescale;
        const avg = seconds > 0 ? Math.round((t.bytes * 8) / seconds) : 0;
        w.full('esds', 0, 0, () => {
          descriptor(w, 3, () => {
            w.u16(t.id);
            w.u8(0);
            descriptor(w, 4, () => {
              w.u8(0x40); // MPEG-4 audio
              w.u8(0x15); // audio stream
              w.u24(t.sizes.reduce((m, x) => Math.max(m, x), 0));
              w.u32(Math.max(avg, peakBitrate(t)));
              w.u32(avg);
              descriptor(w, 5, () => w.bytes(asc));
            });
            descriptor(w, 6, () => w.u8(2));
          });
        });
      }
    });
  }
}

/** An MPEG-4 descriptor with a 4-byte size, as ffmpeg writes it. */
function descriptor(w: Writer, tag: number, body: () => void): void {
  w.u8(tag);
  const at = w.len;
  w.u32(0);
  body();
  const n = w.len - at - 4;
  w.buf[at] = 0x80 | ((n >>> 21) & 0x7f);
  w.buf[at + 1] = 0x80 | ((n >>> 14) & 0x7f);
  w.buf[at + 2] = 0x80 | ((n >>> 7) & 0x7f);
  w.buf[at + 3] = n & 0x7f;
}

/** Largest bytes in any whole second of presentation time, × 8. */
function peakBitrate(t: Track): number {
  const per = new Map<number, number>();
  t.pts.forEach((p, i) => {
    const s = Math.floor(p / t.timescale);
    per.set(s, (per.get(s) ?? 0) + t.sizes[i]);
  });
  return Math.max(0, ...per.values()) * 8;
}

/** stts / ctts body: (count, value) runs. */
function runLength(w: Writer, values: number[]): void {
  const runs: [number, number][] = [];
  for (const v of values) {
    const last = runs[runs.length - 1];
    if (last && last[1] === v) last[0]++;
    else runs.push([1, v]);
  }
  w.u32(runs.length);
  for (const [count, v] of runs) {
    w.u32(count);
    w.u32(v);
  }
}

// ---------------------------------------------------------------------------------------------
// Helpers for callers
// ---------------------------------------------------------------------------------------------

/** Converts a WebCodecs EncodedVideoChunk / EncodedAudioChunk (copying its bytes). */
export function chunkFrom(c: {
  type: string;
  timestamp: number;
  duration: number | null;
  byteLength: number;
  copyTo(dest: Uint8Array): void;
}): Mp4Chunk {
  const data = new Uint8Array(c.byteLength);
  c.copyTo(data);
  return { data, timestamp: c.timestamp, duration: c.duration, key: c.type === 'key' };
}

/** An in-memory sink: `parts` (in order, e.g. for a Blob) with positioned writes patched in. */
export function memorySink(): Mp4Sink & { parts: Uint8Array[]; size: number; bytes(): Uint8Array } {
  const s = {
    parts: [] as Uint8Array[],
    size: 0,
    write(bytes: Uint8Array, position?: number): void {
      if (position === undefined || position === s.size) {
        s.parts.push(bytes);
        s.size += bytes.length;
        return;
      }
      if (position + bytes.length > s.size) throw new Error('memorySink: write past the end');
      let at = 0;
      for (const p of s.parts) {
        const from = Math.max(position, at);
        const to = Math.min(position + bytes.length, at + p.length);
        if (from < to) p.set(bytes.subarray(from - position, to - position), from - at);
        at += p.length;
      }
    },
    bytes(): Uint8Array {
      const out = new Uint8Array(s.size);
      let at = 0;
      for (const p of s.parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    },
  };
  return s;
}
