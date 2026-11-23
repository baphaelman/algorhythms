/**
 * Live @latency gate (live.spec.ts): tells an audio-clock stall from a late note. Pure, so
 * `tests/unit/live-stall.test.ts` checks it on CI's logged notes.
 */

/** One note attempt's measurements (ms), as live.spec logs them. */
export interface NoteTiming {
  postMs: number;
  planMs: number;
  engineMs: number;
  callbackMs: number;
  slipMs: number;
  totalMs: number;
  deviceMs: number;
  frame: number;
  receivedFrame: number;
}

/** Gate: total − device ≤ this (§15 M7). */
export const BEYOND_LIMIT_MS = 10;
/** Our code's cost a stalled note may carry: main thread plus delivery past the next callback. */
export const STALL_OWN_MS = 3;
/** Lateness the clock slip may leave unexplained (timer and clock rounding: WebKit's is 1 ms). */
export const STALL_SLACK_MS = 2;
/** Replays per note, and stalled notes per run before the runner's clock counts as unreliable. */
export const MAX_REPLAYS = 2;
export const MAX_STALLED_NOTES = 3;

export const beyondMs = (r: NoteTiming): number => r.totalMs - r.deviceMs;

/** Our code's share of the delay: main thread (post, plan) and delivery past the next callback. */
export const ownMs = (r: NoteTiming): number =>
  r.postMs + r.planMs + Math.max(0, r.engineMs - r.callbackMs);

/**
 * True when a note fails the heard gate only because the audio clock stalled: it is late beyond
 * the limit, the clock slip (wall − context time since the call) accounts for all of that
 * lateness but STALL_SLACK_MS, our code took ≤ STALL_OWN_MS, and the worklet applied it on the
 * first block after it arrived. Such a note is replayed; anything else late fails at once.
 */
export function isAudioStall(r: NoteTiming): boolean {
  const beyond = beyondMs(r);
  return (
    beyond > BEYOND_LIMIT_MS &&
    r.slipMs >= beyond - STALL_SLACK_MS &&
    ownMs(r) <= STALL_OWN_MS &&
    r.frame === r.receivedFrame
  );
}
