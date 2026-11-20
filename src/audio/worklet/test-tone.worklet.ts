/**
 * M0 AudioWorklet: plays the dsp/ test tone. Loaded by URL via `audioWorklet.addModule` (see
 * src/audio/test-tone.ts for how the URL is produced in dev and production).
 */

import { TestTone } from '../../dsp/test-tone';
import {
  TEST_TONE_PROCESSOR,
  type TestToneOptions,
  type TestToneStopMessage,
} from './test-tone-protocol';

class TestToneProcessor extends AudioWorkletProcessor {
  private readonly tone: TestTone;

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    const o = (options?.processorOptions ?? {}) as TestToneOptions;
    this.tone = new TestTone(sampleRate, o.frequency ?? 440, o.amplitude ?? 0.2);
    this.tone.fadeTo(1, o.fadeIn ?? 0.01);
    this.port.onmessage = (event: MessageEvent) => {
      const msg = event.data as TestToneStopMessage;
      if (msg.type === 'stop') this.tone.fadeTo(0, msg.fade);
    };
  }

  override process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (out === undefined || out.length === 0) return true;
    const first = out[0];
    this.tone.render(first, first.length);
    for (let c = 1; c < out.length; c++) out[c].set(first);
    return true;
  }
}

registerProcessor(TEST_TONE_PROCESSOR, TestToneProcessor);
