/**
 * The microphone, read for a voice message where the web view has no track
 * processor to hand the page its sound (#687): the iPhone's WebKit has one
 * for video only. An audio worklet runs on the engine's own sound thread,
 * so it hears every sample however busy the page is.
 *
 * It averages the channels into one and posts 20 ms at a time to the page
 * (`recorders.ts`), as the Opus encoder takes it, rather than the 128-frame
 * slices the engine hands it, 375 times a second at 48 kHz.
 *
 * Its own file, built on its own (`?worker&url`): a worklet is loaded by
 * address, and the shipped CSP lets scripts come only from the app itself.
 */

// The worklet's own world, which TypeScript's DOM types don't describe.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: new () => AudioWorkletProcessor): void;

/** The name `recorders.ts` makes its node by. */
const NAME = "linger-mic";
/** 20 ms of sound: one Opus packet's worth. */
const FRAMES = Math.round(sampleRate / 50);

class MicReader extends AudioWorkletProcessor {
  private held = new Float32Array(FRAMES);
  private filled = 0;

  process(inputs: Float32Array[][]): boolean {
    // Nothing comes in until the microphone is connected, and after it goes.
    const channels = inputs[0] ?? [];
    const frames = channels[0]?.length ?? 0;
    for (let i = 0; i < frames; i += 1) {
      let sum = 0;
      for (const channel of channels) sum += channel[i] ?? 0;
      this.held[this.filled] = sum / channels.length;
      this.filled += 1;
      if (this.filled === FRAMES) {
        this.port.postMessage(this.held, [this.held.buffer]);
        this.held = new Float32Array(FRAMES);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor(NAME, MicReader);

export {};
