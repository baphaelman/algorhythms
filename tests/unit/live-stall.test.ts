import { describe, expect, it } from 'vitest';
import { isAudioStall, ownMs, type NoteTiming } from '../e2e/live-stall';

/** A WebKit (macOS CI) note: 128-frame callback at 48 kHz, outputLatency 0, so device = callback. */
const note = (
  f: Partial<NoteTiming> & { beyond: number; slip: number; post?: number; engine?: number },
): NoteTiming => {
  const callbackMs = f.callbackMs ?? 2.7;
  return {
    postMs: f.post ?? 0,
    planMs: f.planMs ?? 0,
    engineMs: f.engine ?? 0,
    callbackMs,
    slipMs: f.slip,
    deviceMs: callbackMs,
    totalMs: f.beyond + callbackMs,
    frame: f.frame ?? 100,
    receivedFrame: f.receivedFrame ?? 100,
  };
};

describe('live @latency stall classifier', () => {
  it('CI v65/v66 stalled notes are stalls', () => {
    // #11 p52: post 1.00 plan 0.00 applied 716.0 slip 713.3 engine 0.0 beyond 707.7 ms
    expect(isAudioStall(note({ post: 1, slip: 713.3, beyond: 707.7 }))).toBe(true);
    // #9 p60: post 0.00 plan 0.00 applied 64.0 slip 61.3 engine 0.0 beyond 56.7 ms
    expect(isAudioStall(note({ slip: 61.3, beyond: 56.7 }))).toBe(true);
  });

  it('a stall whose message waited one callback is still a stall', () => {
    expect(isAudioStall(note({ post: 1, engine: 2.7, slip: 40, beyond: 41 }))).toBe(true);
    expect(ownMs(note({ post: 1, engine: 2.7, slip: 0, beyond: 0 }))).toBeCloseTo(1);
  });

  it('a note within the gate is never replayed, whatever its slip', () => {
    expect(isAudioStall(note({ post: 1, slip: 1.2, beyond: -4 }))).toBe(false);
    expect(isAudioStall(note({ slip: 30, beyond: 10 }))).toBe(false);
  });

  it('a note late because of our code fails at once', () => {
    // Main thread: post or plan.
    expect(isAudioStall(note({ post: 4, slip: 60, beyond: 60 }))).toBe(false);
    expect(isAudioStall(note({ planMs: 3.5, slip: 60, beyond: 60 }))).toBe(false);
    // Delivery to the worklet beyond the next callback.
    expect(isAudioStall(note({ engine: 8, slip: 60, beyond: 60 }))).toBe(false);
    // Applied after the first block it arrived for.
    expect(isAudioStall(note({ slip: 60, beyond: 60, frame: 228 }))).toBe(false);
  });

  it('a slip that explains only part of the lateness is not a stall', () => {
    expect(isAudioStall(note({ slip: 5, beyond: 60 }))).toBe(false);
    expect(isAudioStall(note({ slip: 57.9, beyond: 60 }))).toBe(false);
    expect(isAudioStall(note({ slip: 58, beyond: 60 }))).toBe(true);
  });
});
