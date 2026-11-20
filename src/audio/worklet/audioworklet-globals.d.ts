/**
 * Globals of the AudioWorkletGlobalScope, for files named *.worklet.ts (see tsconfig.worklet.json).
 * TypeScript ships no AudioWorklet lib, and the DOM lib would wrongly offer window and document,
 * so this declares the small surface the worklet uses. Extend it as needed.
 */

/** Sample rate of the owning context, in Hz. */
declare const sampleRate: number;
/** Context time of the current render quantum, in seconds. */
declare const currentTime: number;
/** Frame index of the current render quantum. */
declare const currentFrame: number;

interface MessageEvent<T = unknown> {
  readonly data: T;
}

interface MessagePort {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
  start(): void;
  close(): void;
}

interface AudioWorkletNodeOptions {
  numberOfInputs?: number;
  numberOfOutputs?: number;
  outputChannelCount?: number[];
  parameterData?: Record<string, number>;
  processorOptions?: unknown;
}

interface AudioParamDescriptor {
  name: string;
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
  automationRate?: 'a-rate' | 'k-rate';
}

declare abstract class AudioWorkletProcessor {
  /** The processor's end of the node's MessagePort. */
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  /** Renders one 128-frame quantum; return true to stay alive. */
  abstract process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: (new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor) & {
    parameterDescriptors?: AudioParamDescriptor[];
  },
): void;

declare const console: {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
