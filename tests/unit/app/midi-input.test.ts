/** Web MIDI input (PLAN.md §9 "Inputs", M7-b): parsing, and a fake MIDIAccess's ports. */

import { describe, expect, it } from 'vitest';
import { LiveInputHub } from '../../../src/app/live-input';
import {
  ALL_INPUTS,
  hasWebMidi,
  MidiInputs,
  MidiParser,
  type MidiAccessLike,
  type MidiInputLike,
  type MidiSink,
} from '../../../src/app/midi-input';
import { bendFromMidi, glideFromModWheel } from '../../../src/core/live';

type Ev = [string, ...number[]] | [string, boolean];

function recorder(): MidiSink & { events: Ev[] } {
  const events: Ev[] = [];
  return {
    events,
    noteOn: (p, v) => events.push(['on', p, v]),
    noteOff: (p) => events.push(['off', p]),
    sustain: (on) => events.push(['sustain', on]),
    modWheel: (v) => events.push(['mod', v]),
    bend: (v) => events.push(['bend', v]),
    allNotesOff: () => events.push(['all']),
  };
}

const parse = (bytes: number[]): Ev[] => {
  const sink = recorder();
  new MidiParser().feed(bytes, sink);
  return sink.events;
};

describe('MIDI parsing', () => {
  it('note on with velocity, note off, and note on with velocity 0 as off', () => {
    expect(parse([0x90, 60, 127, 0x80, 60, 64, 0x93, 62, 64, 0x93, 62, 0])).toEqual([
      ['on', 60, 1],
      ['off', 60],
      ['on', 62, 64 / 127],
      ['off', 62],
    ]);
  });

  it('running status: data bytes reuse the last status', () => {
    expect(parse([0x90, 60, 100, 64, 100, 60, 0, 64, 0])).toEqual([
      ['on', 60, 100 / 127],
      ['on', 64, 100 / 127],
      ['off', 60],
      ['off', 64],
    ]);
    // Split across feeds (a port may cut messages anywhere).
    const sink = recorder();
    const p = new MidiParser();
    p.feed([0x90, 60], sink);
    p.feed([90, 67], sink);
    p.feed([90], sink);
    expect(sink.events).toEqual([
      ['on', 60, 90 / 127],
      ['on', 67, 90 / 127],
    ]);
  });

  it('real-time bytes interleave without breaking a message or running status', () => {
    expect(parse([0x90, 0xf8, 60, 0xfe, 100, 0xf8, 62, 100])).toEqual([
      ['on', 60, 100 / 127],
      ['on', 62, 100 / 127],
    ]);
  });

  it('SysEx and system common messages are skipped and cancel running status', () => {
    expect(parse([0x90, 60, 100, 0xf0, 0x7e, 0x01, 0x02, 0xf7, 62, 100])).toEqual([
      ['on', 60, 100 / 127],
    ]);
    expect(parse([0x90, 60, 100, 0xf3, 5, 62, 100, 0x90, 64, 100])).toEqual([
      ['on', 60, 100 / 127],
      ['on', 64, 100 / 127],
    ]);
  });

  it('CC64 sustain (≥ 64 down), CC1 mod wheel, CC120/123 all notes off', () => {
    expect(
      parse([0xb0, 64, 127, 0xb0, 64, 63, 0xb0, 64, 64, 0xb0, 64, 0, 0xb0, 1, 0, 1, 127]),
    ).toEqual([
      ['sustain', true],
      ['sustain', false],
      ['sustain', true],
      ['sustain', false],
      ['mod', 0],
      ['mod', 127],
    ]);
    expect(parse([0xb5, 123, 0, 0xb0, 120, 0, 0xb0, 7, 100])).toEqual([['all'], ['all']]);
  });

  it('pitch bend is 14-bit (LSB first); its ±2 semitone mapping', () => {
    expect(parse([0xe0, 0, 64, 0xe0, 0, 0, 0xe0, 127, 127])).toEqual([
      ['bend', 8192],
      ['bend', 0],
      ['bend', 16383],
    ]);
    expect(bendFromMidi(8192)).toBe(0);
    expect(bendFromMidi(0)).toBe(-2);
    expect(bendFromMidi(16383)).toBe(2);
    expect(bendFromMidi(8192 + 4096)).toBeCloseTo(1, 3);
  });

  it('the mod wheel spans the glide range', () => {
    expect(glideFromModWheel(0)).toBeCloseTo(0.02, 9);
    expect(glideFromModWheel(127)).toBeCloseTo(4, 9);
  });

  it('program change and aftertouch are ignored (one and two data bytes)', () => {
    expect(parse([0xc0, 5, 0xd0, 60, 0xa0, 60, 30, 0x90, 60, 1])).toEqual([['on', 60, 1 / 127]]);
  });
});

/** A fake MIDIAccess with ports that can connect and disconnect. */
class FakeAccess implements MidiAccessLike {
  readonly map = new Map<string, MidiInputLike>();
  onstatechange: ((e: unknown) => void) | null = null;
  inputs = { forEach: (fn: (i: MidiInputLike, k: string) => void) => this.map.forEach(fn) };
  plug(id: string, name: string): MidiInputLike {
    const input: MidiInputLike = { id, name, state: 'connected', onmidimessage: null };
    this.map.set(id, input);
    this.onstatechange?.({ port: input });
    return input;
  }
  unplug(id: string): void {
    const input = this.map.get(id);
    if (!input) return;
    input.state = 'disconnected';
    this.onstatechange?.({ port: input });
    this.map.delete(id);
  }
}

const send = (input: MidiInputLike, bytes: number[]): void =>
  input.onmidimessage?.({ data: Uint8Array.from(bytes) });

describe('MIDI inputs (fake MIDIAccess)', () => {
  it('listens to every input, and follows connects', () => {
    const access = new FakeAccess();
    const a = access.plug('a', 'Keys');
    const sink = recorder();
    let devices: { id: string; name: string }[] = [];
    new MidiInputs(access, sink, (d) => (devices = d));
    expect(devices).toEqual([{ id: 'a', name: 'Keys' }]);
    send(a, [0x90, 60, 127]);
    const b = access.plug('b', 'Pads');
    expect(devices.map((d) => d.id)).toEqual(['a', 'b']);
    send(b, [0x90, 64, 127]);
    expect(sink.events).toEqual([
      ['on', 60, 1],
      ['on', 64, 1],
    ]);
  });

  it('a disconnected device releases its notes and its pedal', () => {
    const access = new FakeAccess();
    const a = access.plug('a', 'Keys');
    const b = access.plug('b', 'Pads');
    const sink = recorder();
    let devices: { id: string }[] = [];
    new MidiInputs(access, sink, (d) => (devices = d));
    send(a, [0x90, 60, 100, 62, 100, 0xb0, 64, 127]);
    send(b, [0x90, 70, 100]);
    sink.events.length = 0;
    access.unplug('a');
    expect(devices.map((d) => d.id)).toEqual(['b']);
    expect(sink.events).toEqual([
      ['off', 60],
      ['off', 62],
      ['sustain', false],
    ]);
    expect(a.onmidimessage).toBeNull();
  });

  it('selecting one input stops (and releases) the others; close releases all', () => {
    const access = new FakeAccess();
    const a = access.plug('a', 'Keys');
    const b = access.plug('b', 'Pads');
    const sink = recorder();
    const m = new MidiInputs(access, sink);
    send(b, [0x90, 70, 100]);
    m.select('a');
    expect(m.selection).toBe('a');
    expect(sink.events.at(-1)).toEqual(['off', 70]);
    sink.events.length = 0;
    send(b, [0x90, 71, 100]);
    send(a, [0x90, 60, 100]);
    expect(sink.events).toEqual([['on', 60, 100 / 127]]);
    m.select(ALL_INPUTS);
    send(b, [0x90, 71, 100]);
    expect(sink.events.at(-1)).toEqual(['on', 71, 100 / 127]);
    sink.events.length = 0;
    m.close();
    expect(sink.events).toEqual([
      ['off', 60],
      ['off', 71],
    ]);
    expect(access.onstatechange).toBeNull();
  });

  it('all notes off releases that port’s notes', () => {
    const access = new FakeAccess();
    const a = access.plug('a', 'Keys');
    const sink = recorder();
    new MidiInputs(access, sink);
    send(a, [0x90, 60, 100, 64, 100]);
    sink.events.length = 0;
    send(a, [0xb0, 123, 0]);
    expect(sink.events).toEqual([['off', 60], ['off', 64], ['all']]);
  });

  it('feature detection', () => {
    expect(hasWebMidi({ requestMIDIAccess: () => Promise.resolve() })).toBe(true);
    expect(hasWebMidi({})).toBe(false);
    expect(hasWebMidi(undefined)).toBe(false);
  });
});

describe('live input hub', () => {
  function fakeLive(active = true) {
    const calls: Ev[] = [];
    return {
      calls,
      active,
      noteOn: (p: number, v = 1) => calls.push(['on', p, v]),
      noteOff: (p: number) => calls.push(['off', p]),
    };
  }

  it('one note on and off per pitch whatever the sources; repeats ignored', () => {
    const live = fakeLive();
    const hub = new LiveInputHub(live);
    hub.down('keys', 60);
    hub.down('keys', 60);
    hub.down('midi', 60, 0.5);
    hub.up('keys', 60);
    expect(live.calls).toEqual([['on', 60, 1]]);
    hub.up('midi', 60);
    expect(live.calls).toEqual([
      ['on', 60, 1],
      ['off', 60],
    ]);
    hub.up('midi', 60);
    expect(live.calls).toHaveLength(2);
  });

  it('release(source) lets go of that source only; held is the union', () => {
    const live = fakeLive();
    const hub = new LiveInputHub(live);
    hub.down('keys', 60);
    hub.down('keys', 64);
    hub.down('ruler', 67);
    expect(hub.held).toEqual([60, 64, 67]);
    hub.release('keys');
    expect(hub.held).toEqual([67]);
    expect(hub.holds(67, 'ruler')).toBe(true);
    expect(hub.holds(67, 'keys')).toBe(false);
  });

  it('notes pressed while live mode starts are sent once it runs', () => {
    const live = fakeLive(false);
    const hub = new LiveInputHub(live);
    hub.down('keys', 60);
    hub.down('midi', 60, 0.3);
    hub.down('midi', 64, 0.3);
    expect(live.calls).toEqual([]);
    live.active = true;
    hub.resync();
    expect(live.calls).toEqual([
      ['on', 60, 1],
      ['on', 64, 0.3],
    ]);
  });
});
