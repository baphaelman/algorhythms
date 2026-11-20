/**
 * A small Standard MIDI File parser and reconstructor, independent of the writer, used to prove the
 * exporter: it rebuilds each track's notes, pitch bends (with the declared bend range) and CC11.
 */

export interface RawEvent {
  tick: number;
  /** 'meta' or the channel message name. */
  type: 'noteOn' | 'noteOff' | 'cc' | 'bend' | 'meta';
  ch: number;
  /** noteOn/off: note; cc: controller; bend: 14-bit value; meta: type byte. */
  a: number;
  /** noteOn/off: velocity; cc: value. */
  b: number;
  data?: number[];
}

export interface ParsedSmf {
  format: number;
  ppq: number;
  trackCount: number;
  tracks: RawEvent[][];
  /** Declared MTrk lengths matched their contents and the file had no trailing bytes. */
  chunksOk: boolean;
}

function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

export function parseSmf(bytes: Uint8Array): ParsedSmf {
  const tag = (o: number): string => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (tag(0) !== 'MThd' || u32(bytes, 4) !== 6) throw new Error('bad header');
  const format = (bytes[8] << 8) | bytes[9];
  const trackCount = (bytes[10] << 8) | bytes[11];
  const ppq = (bytes[12] << 8) | bytes[13];
  let o = 14;
  let chunksOk = true;
  const tracks: RawEvent[][] = [];
  for (let k = 0; k < trackCount; k++) {
    if (tag(o) !== 'MTrk') throw new Error('bad track tag');
    const len = u32(bytes, o + 4);
    const end = o + 8 + len;
    if (end > bytes.length) throw new Error('track overruns file');
    let p = o + 8;
    let tick = 0;
    const ev: RawEvent[] = [];
    let sawEnd = false;
    const vlq = (): number => {
      let v = 0;
      for (let i = 0; i < 4; i++) {
        const b = bytes[p++];
        v = (v << 7) | (b & 0x7f);
        if (!(b & 0x80)) return v;
      }
      throw new Error('VLQ too long');
    };
    while (p < end) {
      tick += vlq();
      const st = bytes[p++];
      if (st < 0x80) throw new Error('running status is not expected');
      if (st === 0xff) {
        const type = bytes[p++];
        const n = vlq();
        const data = Array.from(bytes.subarray(p, p + n));
        p += n;
        ev.push({ tick, type: 'meta', ch: 0, a: type, b: 0, data });
        if (type === 0x2f) sawEnd = true;
        continue;
      }
      const ch = st & 0x0f;
      const hi = st & 0xf0;
      if (hi === 0xc0 || hi === 0xd0) {
        p += 1;
        continue;
      }
      const d1 = bytes[p++];
      const d2 = bytes[p++];
      if (hi === 0x90 && d2 > 0) ev.push({ tick, type: 'noteOn', ch, a: d1, b: d2 });
      else if (hi === 0x80 || hi === 0x90) ev.push({ tick, type: 'noteOff', ch, a: d1, b: d2 });
      else if (hi === 0xb0) ev.push({ tick, type: 'cc', ch, a: d1, b: d2 });
      else if (hi === 0xe0) ev.push({ tick, type: 'bend', ch, a: d1 | (d2 << 7), b: 0 });
      else throw new Error(`unsupported status ${st.toString(16)}`);
    }
    if (p !== end || !sawEnd || ev[ev.length - 1].a !== 0x2f) chunksOk = false;
    tracks.push(ev);
    o = end;
  }
  if (o !== bytes.length) chunksOk = false;
  return { format, ppq, trackCount, tracks, chunksOk };
}

/** Microseconds per quarter from the first tempo event. */
export function tempoOf(track: RawEvent[]): number {
  const t = track.find((e) => e.type === 'meta' && e.a === 0x51);
  if (!t?.data) throw new Error('no tempo');
  return (t.data[0] << 16) | (t.data[1] << 8) | t.data[2];
}

export function trackName(track: RawEvent[]): string | undefined {
  const t = track.find((e) => e.type === 'meta' && e.a === 0x03);
  return t?.data ? String.fromCharCode(...t.data) : undefined;
}

export interface ParsedNote {
  ch: number;
  note: number;
  on: number;
  off: number;
  /** Bend range (semitones) in force when the note struck. */
  range: number;
  /** Bend values (14-bit): the value in force at note-on, then each bend event up to the note-off. */
  bends: { tick: number; value: number }[];
}

export interface RpnLog {
  ch: number;
  rpn: number;
  msb: number;
  lsb: number | undefined;
  /** The sequence ended with RPN null (101 = 127, 100 = 127). */
  closed: boolean;
}

export interface TrackTrace {
  notes: ParsedNote[];
  rpns: RpnLog[];
  /** CC11 events (all channels) in order. */
  cc11: { tick: number; value: number }[];
  /** Bend events before the first note-on of their channel are legal; this counts bend events by kind of order check. */
  orderViolations: number;
  /** Sequences of controller numbers sent at tick 0, for well-formedness checks. */
  setupCcs: number[];
}

/** Rebuilds notes, bends, bend range (RPN 0) and CC11 from one track's events. */
export function reconstruct(events: RawEvent[]): TrackTrace {
  const notes: ParsedNote[] = [];
  const rpns: RpnLog[] = [];
  const cc11: { tick: number; value: number }[] = [];
  const setupCcs: number[] = [];
  const range = new Array<number>(16).fill(2);
  const bend = new Array<number>(16).fill(8192);
  const sel = new Array<{ msb: number; lsb: number }>(16).fill({ msb: 127, lsb: 127 });
  const open = new Map<string, ParsedNote>();
  const lastBendTick = new Array<number>(16).fill(-1);
  let pending: RpnLog | null = null;
  let orderViolations = 0;
  const lastOffTick = new Array<number>(16).fill(-1);
  for (const e of events) {
    if (e.type === 'cc') {
      if (e.tick === 0) setupCcs.push(e.a);
      if (e.a === 101) sel[e.ch] = { ...sel[e.ch], msb: e.b };
      else if (e.a === 100) sel[e.ch] = { ...sel[e.ch], lsb: e.b };
      else if (e.a === 6 || e.a === 38) {
        const s = sel[e.ch];
        if (s.msb === 0 && s.lsb === 0) {
          if (e.a === 6) range[e.ch] = e.b + (range[e.ch] % 1);
          else range[e.ch] = Math.floor(range[e.ch]) + e.b / 100;
        }
        if (e.a === 6) {
          pending = { ch: e.ch, rpn: s.lsb, msb: e.b, lsb: undefined, closed: false };
          rpns.push(pending);
        } else if (pending) pending.lsb = e.b;
      } else if (e.a === 11) cc11.push({ tick: e.tick, value: e.b });
      if ((e.a === 101 || e.a === 100) && e.b === 127 && sel[e.ch].msb === 127) {
        if (sel[e.ch].lsb === 127 && pending) pending.closed = true;
      }
    } else if (e.type === 'bend') {
      bend[e.ch] = e.a;
      lastBendTick[e.ch] = e.tick;
      const n = [...open.values()].find((x) => x.ch === e.ch);
      if (n) n.bends.push({ tick: e.tick, value: e.a });
    } else if (e.type === 'noteOn') {
      // A bend must precede the note-on at the same tick.
      if (lastBendTick[e.ch] !== e.tick) orderViolations++;
      if (lastOffTick[e.ch] === e.tick && lastBendTick[e.ch] < lastOffTick[e.ch]) orderViolations++;
      const n: ParsedNote = {
        ch: e.ch,
        note: e.a,
        on: e.tick,
        off: -1,
        range: range[e.ch],
        bends: [{ tick: e.tick, value: bend[e.ch] }],
      };
      open.set(`${e.ch}:${e.a}`, n);
      notes.push(n);
    } else if (e.type === 'noteOff') {
      const n = open.get(`${e.ch}:${e.a}`);
      if (!n) throw new Error('note-off without note-on');
      n.off = e.tick;
      open.delete(`${e.ch}:${e.a}`);
      lastOffTick[e.ch] = e.tick;
    }
  }
  if (open.size > 0) throw new Error('hanging notes');
  return { notes, rpns, cc11, orderViolations, setupCcs };
}

/** Pitch (semitones) of a note at fractional tick `t`: its number plus the linearly interpolated bend. */
export function notePitch(n: ParsedNote, t: number): number {
  const b = n.bends;
  let v: number;
  if (t >= b[b.length - 1].tick) v = b[b.length - 1].value;
  else if (t <= b[0].tick) v = b[0].value;
  else {
    // Last bend event at or before t (binary search), then interpolate towards the next.
    let lo = 0;
    let hi = b.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (b[mid].tick <= t) lo = mid;
      else hi = mid;
    }
    const span = b[lo + 1].tick - b[lo].tick;
    const f = span > 0 ? (t - b[lo].tick) / span : 1;
    v = b[lo].value + (b[lo + 1].value - b[lo].value) * f;
  }
  return n.note + ((v - 8192) / 8192) * n.range;
}

/** Pitch of a track at fractional tick t, or null when no note sounds. Later notes win at a boundary. */
export function trackPitch(notes: ParsedNote[], t: number): number | null {
  let found: ParsedNote | null = null;
  for (const n of notes) if (t >= n.on && t <= n.off) found = n;
  return found ? notePitch(found, t) : null;
}

/** CC11 value (0..127) in force at tick t, by step hold. */
export function cc11At(cc: { tick: number; value: number }[], t: number): number {
  let lo = 0;
  let hi = cc.length - 1;
  let k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cc[mid].tick <= t) {
      k = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return k < 0 ? 0 : cc[k].value;
}
