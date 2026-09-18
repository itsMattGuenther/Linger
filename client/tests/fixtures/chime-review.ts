/** Offline samples use the real synthesizer without opening an audio device. */
import { scheduleChime } from "../../src/lib/chimes";
import type { SoundCue } from "../../src/lib/sound";

const cues: readonly SoundCue[] = [
  "voice-join",
  "voice-leave",
  "voice-move",
  "peer-join",
  "peer-leave",
  "mute",
  "unmute",
  "deafen",
  "undeafen",
  "dm",
  "room",
  "knock",
];

export async function renderChimeSamples() {
  const results = [];
  for (const cue of cues) {
    const context = new OfflineAudioContext(1, 32_000, 32_000);
    scheduleChime(context, cue, 0.04);
    const buffer = await context.startRendering();
    results.push({
      cue,
      rate: buffer.sampleRate,
      samples: Array.from(buffer.getChannelData(0)),
    });
  }
  return results;
}
