/**
 * A stand-in for a window's audio device, so a spec can tell which sound a
 * window played, and that it played it, without anything reaching the
 * speakers. The real player (`src/lib/sound.ts`) runs unchanged: its mute,
 * its switches and its checks all apply. Only the device at the end is fake.
 *
 * Every sound started is written down as `sound:<cue>`. The player hands
 * the device a rendered buffer, not a name, so the cue is found by comparing
 * the buffer with each cue rendered here the same way (`lib/chimes.ts`).
 * That takes a while, so `sound:` lines can land after what came next; a
 * fixture that needs to know whether a sound had started by some moment asks
 * `started()`, which counts each one the instant it starts.
 *
 * The shell answers nothing to `sound_play` here, so every sound takes the
 * page's own way, as one the shell couldn't play does in the app: the player
 * opens a device for it, with or without a click, and closes it again once
 * the window has been quiet for a while (#531).
 */
import { CHIMES, renderChime } from "../../../src/lib/chimes";
import { type SoundCue, unlockAudioOnGesture } from "../../../src/lib/sound";

/** Low, so rendering every cue here is quick; any rate the renderer takes will do. */
const RATE = 8_000;
const CUES = [...Object.keys(CHIMES), "knock"] as SoundCue[];

/** What the stand-in heard, read at once rather than once named. */
export interface Heard {
  /** How many sounds have started so far, counted as each starts, before its cue is known. */
  started: () => number;
}

export function hearSounds(note: (what: string) => void): Heard {
  let started = 0;
  const rendered = Promise.all(CUES.map(async (cue) => ({ cue, samples: (await renderChime(cue, RATE)).getChannelData(0) })));
  const nameOf = (buffer: AudioBuffer, known: { cue: SoundCue; samples: Float32Array }[]): string => {
    const samples = buffer.getChannelData(0);
    const found = known.find(
      (one) => one.samples.length === samples.length && one.samples.every((value, index) => Math.abs(value - (samples[index] ?? 0)) < 1e-6),
    );
    return found?.cue ?? "unknown";
  };

  const Real = window.AudioContext;
  class Device {
    constructor(options?: AudioContextOptions) {
      // Asked for a rate, it's the voice message recorder reading the
      // microphone on an iPhone (app/chat/recorders.ts, #687), not a sound
      // being played: that gets a real one. The player asks for none.
      if (options?.sampleRate !== undefined) return new Real(options) as unknown as Device;
    }
    state: AudioContextState = "suspended";
    readonly sampleRate = RATE;
    readonly destination = {};
    resume(): Promise<void> {
      this.state = "running";
      return Promise.resolve();
    }
    close(): Promise<void> {
      this.state = "closed";
      return Promise.resolve();
    }
    createBufferSource() {
      const source = {
        buffer: null as AudioBuffer | null,
        onended: null as (() => void) | null,
        connect: () => undefined,
        disconnect: () => undefined,
        start: () => {
          started += 1;
          const buffer = source.buffer;
          if (buffer) void rendered.then((known) => note(`sound:${nameOf(buffer, known)}`));
        },
      };
      return source;
    }
  }
  window.AudioContext = Device as unknown as typeof AudioContext;

  unlockAudioOnGesture(window);
  return { started: () => started };
}
