/**
 * Names and messages shared by the test-tone worklet and its main-thread loader. This file must
 * stay environment-neutral: it is imported from both the main thread and the AudioWorklet.
 */

/** Name the processor is registered under. */
export const TEST_TONE_PROCESSOR = 'algorhythms-test-tone';

/** `processorOptions` of the AudioWorkletNode. */
export interface TestToneOptions {
  /** Tone frequency in Hz. @default 440 */
  frequency?: number;
  /** Peak amplitude. @default 0.2 */
  amplitude?: number;
  /** Fade-in length in seconds. @default 0.01 */
  fadeIn?: number;
}

/** Main thread → worklet: fade out over `fade` seconds. */
export interface TestToneStopMessage {
  type: 'stop';
  fade: number;
}
