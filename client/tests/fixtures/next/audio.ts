/**
 * A stand-in for a window's audio device, so a spec can tell which sound a
 * window played, and that it played it, without anything reaching the
 * speakers. The real player (`src/lib/sound.ts`) runs unchanged: its mute,
 * its switches and its checks all apply. Only the device at the end is fake.
 *
 * Every sound started is written down as `sound:<cue>`. The player hands
 * the device a rendered buffer, not a name, so the cue is found by comparing
 * the buffer with each cue rendered here the same way (`lib/chimes.ts`).
 *
 * As in the app (`src/next/main.tsx`), the device opens on the first pointer
 * or key in the window; until then there is none, and nothing plays.
 */
import { CHIMES, renderChime } from "../../../src/lib/chimes";
import { type SoundCue, unlockAudio } from "../../../src/lib/sound";

/** Low, so rendering every cue here is quick; any rate the renderer takes will do. */
const RATE = 8_000;
const CUES = [...Object.keys(CHIMES), "knock"] as SoundCue[];

export function hearSounds(note: (what: string) => void): void {
  const rendered = Promise.all(CUES.map(async (cue) => ({ cue, samples: (await renderChime(cue, RATE)).getChannelData(0) })));
  const nameOf = (buffer: AudioBuffer, known: { cue: SoundCue; samples: Float32Array }[]): string => {
    const samples = buffer.getChannelData(0);
    const found = known.find(
      (one) => one.samples.length === samples.length && one.samples.every((value, index) => Math.abs(value - (samples[index] ?? 0)) < 1e-6),
    );
    return found?.cue ?? "unknown";
  };

  class Device {
    state: AudioContextState = "suspended";
    readonly sampleRate = RATE;
    readonly destination = {};
    resume(): Promise<void> {
      this.state = "running";
      return Promise.resolve();
    }
    createBufferSource() {
      const source = {
        buffer: null as AudioBuffer | null,
        onended: null as (() => void) | null,
        connect: () => undefined,
        disconnect: () => undefined,
        start: () => {
          const buffer = source.buffer;
          if (buffer) void rendered.then((known) => note(`sound:${nameOf(buffer, known)}`));
        },
      };
      return source;
    }
  }
  window.AudioContext = Device as unknown as typeof AudioContext;

  window.addEventListener("pointerdown", () => unlockAudio());
  window.addEventListener("keydown", () => unlockAudio());
}
