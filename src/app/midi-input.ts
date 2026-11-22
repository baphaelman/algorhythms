/**
 * Web MIDI input for live mode (PLAN.md §9 "Inputs"; Chromium and Firefox, feature-detected, no
 * dependency). Every channel is heard (omni):
 * - note on / off with velocity (a note on with velocity 0 is a note off);
 * - CC64 sustain (≥ 64 down), CC1 mod wheel (sets the glide), CC120 / CC123 all notes off;
 * - pitch bend, 14-bit (the sink maps it to ±bendRange semitones).
 * `MidiParser` reads a byte stream (running status, interleaved real-time bytes, SysEx skipped),
 * so it also copes with ports that split or join messages. `MidiInputs` follows a MIDIAccess:
 * the inputs listened to (all or one), connects and disconnects (a vanished device's notes are
 * released).
 */

import type { Pitch } from '../core/types';

/** Where parsed messages go. */
export interface MidiSink {
  noteOn(pitch: Pitch, velocity: number): void;
  noteOff(pitch: Pitch): void;
  sustain(on: boolean): void;
  /** CC1, 0..127. */
  modWheel(value: number): void;
  /** 14-bit pitch bend, 0..16383 (centre 8192). */
  bend(value14: number): void;
  allNotesOff(): void;
}

/** Data bytes each channel message takes, by status high nibble. */
function dataLength(status: number): number {
  const hi = status & 0xf0;
  return hi === 0xc0 || hi === 0xd0 ? 1 : 2;
}

/** A MIDI byte-stream parser with running status. One per port. */
export class MidiParser {
  private status = 0;
  private readonly data: number[] = [];
  private sysex = false;

  /** Feeds bytes; complete messages go to `sink`. */
  feed(bytes: ArrayLike<number>, sink: MidiSink): void {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i] & 0xff;
      if (b >= 0xf8) continue; // real-time: anywhere, no effect on running status
      if (b === 0xf0) {
        this.sysex = true;
        this.status = 0;
        continue;
      }
      if (b === 0xf7) {
        this.sysex = false;
        continue;
      }
      if (b >= 0x80) {
        this.sysex = false;
        this.data.length = 0;
        // System common (F1–F6) cancels running status; its data bytes are ignored.
        this.status = b < 0xf0 ? b : 0;
        continue;
      }
      if (this.sysex || this.status === 0) continue;
      this.data.push(b);
      if (this.data.length < dataLength(this.status)) continue;
      this.dispatch(this.status, this.data[0], this.data[1] ?? 0, sink);
      this.data.length = 0;
    }
  }

  private dispatch(status: number, d1: number, d2: number, sink: MidiSink): void {
    switch (status & 0xf0) {
      case 0x80:
        sink.noteOff(d1);
        return;
      case 0x90:
        if (d2 === 0) sink.noteOff(d1);
        else sink.noteOn(d1, d2 / 127);
        return;
      case 0xb0:
        if (d1 === 64) sink.sustain(d2 >= 64);
        else if (d1 === 1) sink.modWheel(d2);
        else if (d1 === 120 || d1 === 123) sink.allNotesOff();
        return;
      case 0xe0:
        sink.bend((d2 << 7) | d1);
        return;
      default:
        return; // aftertouch, program change: not used
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------------------------

/** What `MidiInputs` uses of a MIDIInput (a fake in tests). */
export interface MidiInputLike {
  id: string;
  name?: string | null;
  manufacturer?: string | null;
  state?: string;
  onmidimessage: ((e: { data: Uint8Array | null }) => void) | null;
}

/** What `MidiInputs` uses of a MIDIAccess. */
export interface MidiAccessLike {
  inputs: { forEach(fn: (input: MidiInputLike, key: string) => void): void };
  onstatechange: ((e: unknown) => void) | null;
}

/** An input shown in the picker. */
export interface MidiDevice {
  id: string;
  name: string;
}

/** Listen to every input, or one by id. */
export const ALL_INPUTS = 'all';

/**
 * The inputs of a MIDIAccess feeding one sink. Each port has its own parser (running status is
 * per port) and its held notes; when a port goes away or stops being listened to, its notes are
 * released (sustain too), so nothing hangs.
 */
export class MidiInputs {
  private selected: string = ALL_INPUTS;
  private readonly ports = new Map<string, { input: MidiInputLike; parser: MidiParser }>();
  private readonly held = new Map<string, Set<Pitch>>();
  private readonly pedal = new Set<string>();

  constructor(
    private readonly access: MidiAccessLike,
    private readonly sink: MidiSink,
    private readonly onChange: (devices: MidiDevice[]) => void = () => undefined,
  ) {
    access.onstatechange = () => this.refresh();
    this.refresh();
  }

  /** The connected inputs. */
  devices(): MidiDevice[] {
    const out: MidiDevice[] = [];
    this.access.inputs.forEach((input) => {
      if (input.state === 'disconnected') return;
      out.push({ id: input.id, name: deviceName(input) });
    });
    return out;
  }

  /** Listens to all inputs or one (by id). */
  select(id: string): void {
    this.selected = id;
    this.refresh();
  }

  get selection(): string {
    return this.selected;
  }

  /** Stops listening and releases every note. */
  close(): void {
    this.access.onstatechange = null;
    for (const id of [...this.ports.keys()]) this.detach(id);
  }

  /** Re-reads the inputs: attaches new ones, detaches gone or deselected ones. */
  refresh(): void {
    const want = new Map<string, MidiInputLike>();
    this.access.inputs.forEach((input) => {
      if (input.state === 'disconnected') return;
      if (this.selected === ALL_INPUTS || this.selected === input.id) want.set(input.id, input);
    });
    for (const id of [...this.ports.keys()]) {
      const port = this.ports.get(id);
      if (!want.has(id) || port?.input !== want.get(id)) this.detach(id);
    }
    for (const [id, input] of want) if (!this.ports.has(id)) this.attach(id, input);
    this.onChange(this.devices());
  }

  private attach(id: string, input: MidiInputLike): void {
    const parser = new MidiParser();
    const held = new Set<Pitch>();
    this.held.set(id, held);
    const sink = this.sink;
    // Per port: notes it holds and its pedal, so a vanished port releases exactly those.
    const portSink: MidiSink = {
      noteOn: (p, v) => {
        held.add(p);
        sink.noteOn(p, v);
      },
      noteOff: (p) => {
        held.delete(p);
        sink.noteOff(p);
      },
      sustain: (on) => {
        if (on) this.pedal.add(id);
        else this.pedal.delete(id);
        sink.sustain(on);
      },
      modWheel: (v) => sink.modWheel(v),
      bend: (v) => sink.bend(v),
      allNotesOff: () => {
        for (const p of held) sink.noteOff(p);
        held.clear();
        sink.allNotesOff();
      },
    };
    input.onmidimessage = (e) => {
      if (e.data) parser.feed(e.data, portSink);
    };
    this.ports.set(id, { input, parser });
  }

  private detach(id: string): void {
    const port = this.ports.get(id);
    if (!port) return;
    if (port.input.onmidimessage) port.input.onmidimessage = null;
    this.ports.delete(id);
    const held = this.held.get(id);
    this.held.delete(id);
    if (held) for (const p of held) this.sink.noteOff(p);
    if (this.pedal.delete(id)) this.sink.sustain(false);
  }
}

function deviceName(input: MidiInputLike): string {
  const name = input.name?.trim() || 'MIDI input';
  const maker = input.manufacturer?.trim();
  return maker && !name.toLowerCase().includes(maker.toLowerCase()) ? `${name} (${maker})` : name;
}

/** Whether this browser has Web MIDI (Safari has not). */
export function hasWebMidi(nav: unknown = globalThis.navigator): boolean {
  return (
    typeof nav === 'object' &&
    nav !== null &&
    typeof (nav as { requestMIDIAccess?: unknown }).requestMIDIAccess === 'function'
  );
}
