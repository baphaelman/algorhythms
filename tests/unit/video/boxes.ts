/** A small ISO BMFF reader for the muxer's tests: the box tree and each track's samples. */

export interface Box {
  type: string;
  /** Offset of the box in the file. */
  start: number;
  size: number;
  /** Header length (8, or 16 with a 64-bit size). */
  header: number;
  children: Box[];
}

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts', 'udta']);
/** Bytes of fixed fields before a sample entry's child boxes. */
const ENTRY_FIELDS: Record<string, number> = { avc1: 78, vp09: 78, mp4a: 28, Opus: 28 };

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(...b.subarray(at, at + 4));

export function parseBoxes(b: Uint8Array, start = 0, end = b.length): Box[] {
  const v = view(b);
  const out: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let size = v.getUint32(at);
    const type = fourcc(b, at + 4);
    let header = 8;
    if (size === 1) {
      size = Number(v.getBigUint64(at + 8));
      header = 16;
    } else if (size === 0) size = end - at;
    if (size < header || at + size > end) throw new Error(`bad box ${type} at ${at}`);
    const box: Box = { type, start: at, size, header, children: [] };
    if (CONTAINERS.has(type)) box.children = parseBoxes(b, at + header, at + size);
    if (type === 'stsd') box.children = parseBoxes(b, at + header + 8, at + size);
    if (type in ENTRY_FIELDS) {
      box.children = parseBoxes(b, at + header + ENTRY_FIELDS[type], at + size);
    }
    out.push(box);
    at += size;
  }
  if (at !== end) throw new Error(`trailing bytes at ${at}`);
  return out;
}

/** All boxes at a path like 'moov/trak/mdia'. */
export function find(boxes: Box[], path: string): Box[] {
  const parts = path.split('/');
  let level = boxes;
  for (let i = 0; i < parts.length - 1; i++) {
    level = level.filter((x) => x.type === parts[i]).flatMap((x) => x.children);
  }
  return level.filter((x) => x.type === parts[parts.length - 1]);
}

export function one(boxes: Box[], path: string): Box {
  const f = find(boxes, path);
  if (f.length !== 1) throw new Error(`${path}: ${f.length} boxes`);
  return f[0];
}

/** Body of a box (after the header; for full boxes, version/flags are its first 4 bytes). */
export function body(b: Uint8Array, box: Box): Uint8Array {
  return b.subarray(box.start + box.header, box.start + box.size);
}

export interface Sample {
  offset: number;
  size: number;
  dts: number;
  cts: number;
  key: boolean;
}

export interface TrackInfo {
  handler: string;
  id: number;
  timescale: number;
  mediaDuration: number;
  tkhdDuration: number;
  width: number;
  height: number;
  entry: Box;
  edits: { duration: number; mediaTime: number }[];
  co64: boolean;
  chunkOffsets: number[];
  samples: Sample[];
}

function u(b: Uint8Array, at: number, v1: boolean): [number, number] {
  const d = view(b);
  return v1 ? [Number(d.getBigUint64(at)), at + 8] : [d.getUint32(at), at + 4];
}

export function movieInfo(file: Uint8Array): { timescale: number; duration: number } {
  const b = body(file, one(parseBoxes(file), 'moov/mvhd'));
  const v1 = b[0] === 1;
  const ts = view(b).getUint32(v1 ? 20 : 12);
  const [duration] = u(b, v1 ? 24 : 16, v1);
  return { timescale: ts, duration };
}

export function tracks(file: Uint8Array): TrackInfo[] {
  return find(parseBoxes(file), 'moov/trak').map((trak) => readTrack(file, trak));
}

function readTrack(file: Uint8Array, trak: Box): TrackInfo {
  const k = trak.children;
  const get = (p: string) => body(file, one(k, p));
  const has = (p: string) => find(k, p).length > 0;

  const tkhd = get('tkhd');
  const t1 = tkhd[0] === 1;
  const id = view(tkhd).getUint32(t1 ? 20 : 12);
  const [tkhdDuration] = u(tkhd, t1 ? 28 : 20, t1);
  const wh = tkhd.length - 8;
  const width = view(tkhd).getUint32(wh) / 65536;
  const height = view(tkhd).getUint32(wh + 4) / 65536;

  const mdhd = get('mdia/mdhd');
  const m1 = mdhd[0] === 1;
  const timescale = view(mdhd).getUint32(m1 ? 20 : 12);
  const [mediaDuration] = u(mdhd, m1 ? 24 : 16, m1);
  const handler = fourcc(get('mdia/hdlr'), 8);

  const edits: TrackInfo['edits'] = [];
  if (has('edts')) {
    const e = get('edts/elst');
    const e1 = e[0] === 1;
    const n = view(e).getUint32(4);
    let at = 8;
    for (let i = 0; i < n; i++) {
      const [duration, a1] = u(e, at, e1);
      const mediaTime = e1 ? Number(view(e).getBigInt64(a1)) : view(e).getInt32(a1);
      edits.push({ duration, mediaTime });
      at = a1 + (e1 ? 8 : 4) + 4;
    }
  }

  const stbl = 'mdia/minf/stbl';
  const entry = one(k, `${stbl}/stsd`).children[0];
  const runs = (p: string) => {
    const x = get(p);
    const out: [number, number][] = [];
    for (let i = 0; i < view(x).getUint32(4); i++) {
      out.push([view(x).getUint32(8 + i * 8), view(x).getUint32(12 + i * 8)]);
    }
    return out;
  };
  const stsz = get(`${stbl}/stsz`);
  const n = view(stsz).getUint32(8);
  const fixed = view(stsz).getUint32(4);
  const sizes = Array.from({ length: n }, (_, i) => fixed || view(stsz).getUint32(12 + i * 4));
  const co64 = has(`${stbl}/co64`);
  const co = get(`${stbl}/${co64 ? 'co64' : 'stco'}`);
  const chunkOffsets = Array.from({ length: view(co).getUint32(4) }, (_, i) =>
    co64 ? Number(view(co).getBigUint64(8 + i * 8)) : view(co).getUint32(8 + i * 4),
  );
  const stscRaw = get(`${stbl}/stsc`);
  const stsc = Array.from({ length: view(stscRaw).getUint32(4) }, (_, i) => ({
    first: view(stscRaw).getUint32(8 + i * 12),
    count: view(stscRaw).getUint32(12 + i * 12),
  }));
  let sync: Set<number> | null = null;
  if (has(`${stbl}/stss`)) {
    const s = get(`${stbl}/stss`);
    sync = new Set(
      Array.from({ length: view(s).getUint32(4) }, (_, i) => view(s).getUint32(8 + i * 4)),
    );
  }
  const deltas = runs(`${stbl}/stts`).flatMap(([c, d]) => Array<number>(c).fill(d));
  const offs = has(`${stbl}/ctts`)
    ? runs(`${stbl}/ctts`).flatMap(([c, d]) => Array<number>(c).fill(d))
    : Array<number>(n).fill(0);

  const samples: Sample[] = [];
  let s = 0;
  let dts = 0;
  chunkOffsets.forEach((off, ci) => {
    let per = 0;
    for (const e of stsc) if (e.first <= ci + 1) per = e.count;
    for (let j = 0; j < per && s < n; j++, s++) {
      samples.push({
        offset: off,
        size: sizes[s],
        dts,
        cts: dts + offs[s],
        key: !sync || sync.has(s + 1),
      });
      off += sizes[s];
      dts += deltas[s];
    }
  });
  if (samples.length !== n || deltas.length !== n) throw new Error('sample tables disagree');
  return {
    handler,
    id,
    timescale,
    mediaDuration,
    tkhdDuration,
    width,
    height,
    entry,
    edits,
    co64,
    chunkOffsets,
    samples,
  };
}
