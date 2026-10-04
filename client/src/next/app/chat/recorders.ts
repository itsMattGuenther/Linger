import { invoke } from "@tauri-apps/api/core";
import { readClip } from "../../../lib/webm";
import { tauriBus } from "../../core/bus";

/**
 * What records a voice message (#401), on each app. Both hand back the same
 * thing: Opus packets of 20 ms each and the encoder's lookahead, which the
 * page puts in the same WebM file (`lib/webm.ts`), so a message recorded on a
 * phone plays wherever one recorded on a computer does.
 *
 * - **A computer:** the desktop shell records (src-tauri/src/clip.rs), from
 *   the microphone voice opens, in the device's own format (#398).
 * - **The phone:** the page records, with the web view's own microphone and
 *   its WebCodecs encoder. The shell has no audio code on a phone (SPEC
 *   §4.15), and Android asks the person for the microphone the first time,
 *   through the web view.
 */

/** A recording: its packets, in order, and how many samples the decoder drops at the start. */
export interface Recording {
  preSkip: number;
  packets: Uint8Array[];
}

/** What a recorder tells the panel while it records. */
export interface RecorderEvents {
  /** How loud you are, from 0 to 1, about 25 times a second. */
  level: (level: number) => void;
  /** It stopped by itself: at five minutes, or the microphone went away. */
  ended: (why: "full" | "lost") => void;
}

export interface Recorder {
  /** Start recording. Rejects with the reason, in words the voice strip's rules read (`voiceStartProblem`). */
  start: () => Promise<void>;
  /** Stop, and hand the recording back; null when there's nothing readable. */
  stop: () => Promise<Recording | null>;
  /** Stop and throw it away. */
  cancel: () => void;
  /** Let go of everything it listens to. */
  dispose: () => void;
}

/** 20 ms of sound per packet, so five minutes is this many. */
const LONGEST_PACKETS = 15_000;
/** As the desktop's encoder: 64 kbit/s, Discord's default for a voice (#401). */
const BITS_PER_SECOND = 64_000;
/** libopus's lookahead at 48 kHz, for an encoder that doesn't say its own. */
const USUAL_PRE_SKIP = 312;
/** How often the lines hear how loud you are, as on the desktop. */
const LEVEL_EVERY_MS = 40;

/**
 * The desktop shell's recorder (src-tauri/src/clip.rs), through its commands
 * and events. `input` is the microphone Settings picked, by name, or null for
 * the computer's default, read as each recording starts.
 */
export function shellRecorder(events: RecorderEvents, input: () => string | null): Recorder {
  const bus = tauriBus();
  const stops: Array<() => void> = [];
  let gone = false;
  const hold = (unlisten: () => void) => {
    if (gone) unlisten();
    else stops.push(unlisten);
  };
  void bus.listen<number>("clip:level", (level) => events.level(level)).then(hold);
  void bus.listen("clip:full", () => events.ended("full")).then(hold);
  void bus.listen("clip:lost", () => events.ended("lost")).then(hold);
  return {
    start: async () => {
      await invoke("clip_start", { input: input() });
    },
    stop: async () => readClip(new Uint8Array(await invoke<ArrayBuffer>("clip_stop"))),
    cancel: () => void invoke("clip_cancel").catch(() => undefined),
    dispose: () => {
      gone = true;
      for (const stop of stops) stop();
    },
  };
}

// --- the phone's ------------------------------------------------------------

/** Chromium's track processor: a microphone's sound as a stream of `AudioData`. Not in TypeScript's own DOM types. */
interface TrackProcessor {
  readable: ReadableStream<AudioData>;
}
type TrackProcessorClass = new (init: { track: MediaStreamTrack }) => TrackProcessor;

function trackProcessor(): TrackProcessorClass | null {
  const found: unknown = Reflect.get(globalThis, "MediaStreamTrackProcessor");
  return typeof found === "function" ? (found as TrackProcessorClass) : null;
}

/** Whether this engine can record in the page: a microphone, a way to read it, and an Opus encoder. */
export function canRecordInPage(): boolean {
  return typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia !== undefined && typeof AudioEncoder !== "undefined" && trackProcessor() !== null;
}

/** A refusal from the web view, in the words `voiceStartProblem` reads. */
function inWords(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") return "permission denied for the microphone";
    if (error.name === "NotFoundError" || error.name === "OverconstrainedError") return "no input device available";
    if (error.name === "NotReadableError") return "the microphone is busy: in use by another app";
  }
  return error instanceof Error ? error.message : String(error);
}

/** One channel, whatever came in: the channels averaged, as 32-bit floats. */
function mono(data: AudioData): Float32Array<ArrayBuffer> {
  const frames = data.numberOfFrames;
  const out = new Float32Array(frames);
  const plane = new Float32Array(frames);
  for (let channel = 0; channel < data.numberOfChannels; channel += 1) {
    data.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
    for (let i = 0; i < frames; i += 1) out[i] = (out[i] ?? 0) + (plane[i] ?? 0) / data.numberOfChannels;
  }
  return out;
}

/** How loud, from 0 to 1, as the desktop measures it: the square root of the RMS. */
function loudness(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.min(1, Math.sqrt(Math.sqrt(sum / samples.length)));
}

/** The decoder's lookahead from Opus's own header, which the encoder hands over as its description. */
function preSkipOf(description: AllowSharedBufferSource | undefined): number | null {
  if (description === undefined) return null;
  const bytes = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description);
  if (bytes.length < 12 || new TextDecoder().decode(bytes.slice(0, 8)) !== "OpusHead") return null;
  return (bytes[10] ?? 0) | ((bytes[11] ?? 0) << 8);
}

/** The phone's recorder: the web view's microphone, encoded as Opus by WebCodecs. */
export function pageRecorder(events: RecorderEvents): Recorder {
  let stream: MediaStream | null = null;
  let encoder: AudioEncoder | null = null;
  let reading: Promise<void> | null = null;
  let packets: Uint8Array[] = [];
  let preSkip = USUAL_PRE_SKIP;
  let stopped = false;
  let loudest = 0;
  let heardAt = 0;

  const release = () => {
    stopped = true;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
  };

  const read = async (reader: ReadableStreamDefaultReader<AudioData>) => {
    for (;;) {
      const next = await reader.read().catch(() => ({ done: true, value: undefined }) as const);
      if (next.done || next.value === undefined) {
        // The microphone went away (unplugged, or taken), not stopped by us.
        if (!stopped) events.ended("lost");
        return;
      }
      const data = next.value;
      if (stopped) {
        data.close();
        continue;
      }
      if (encoder === null) {
        encoder = new AudioEncoder({
          output: (chunk, meta) => {
            const found = preSkipOf(meta?.decoderConfig?.description);
            if (found !== null) preSkip = found;
            const packet = new Uint8Array(chunk.byteLength);
            chunk.copyTo(packet);
            packets.push(packet);
            if (packets.length === LONGEST_PACKETS && !stopped) {
              release();
              events.ended("full");
            }
          },
          error: () => {
            if (!stopped) events.ended("lost");
          },
        });
        encoder.configure({ codec: "opus", sampleRate: data.sampleRate, numberOfChannels: 1, bitrate: BITS_PER_SECOND, opus: { frameDuration: 20_000 } });
      }
      const samples = mono(data);
      const single = new AudioData({ format: "f32", sampleRate: data.sampleRate, numberOfFrames: data.numberOfFrames, numberOfChannels: 1, timestamp: data.timestamp, data: samples });
      data.close();
      encoder.encode(single);
      single.close();
      loudest = Math.max(loudest, loudness(samples));
      const now = performance.now();
      if (now - heardAt >= LEVEL_EVERY_MS) {
        events.level(loudest);
        loudest = 0;
        heardAt = now;
      }
    }
  };

  return {
    start: async () => {
      packets = [];
      preSkip = USUAL_PRE_SKIP;
      stopped = false;
      encoder = null;
      const Processor = trackProcessor();
      if (Processor === null) throw new Error("Voice messages need a newer phone.");
      try {
        // A phone's own clean-up for a voice: its echo cancelling, noise
        // suppression and level, which a speakerphone mic needs.
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch (error: unknown) {
        throw new Error(inWords(error));
      }
      const [track] = stream.getAudioTracks();
      if (!track) throw new Error("no input device available");
      reading = read(new Processor({ track }).readable.getReader());
    },
    stop: async () => {
      release();
      await reading;
      const held = encoder as AudioEncoder | null;
      if (held !== null && held.state === "configured") await held.flush().catch(() => undefined);
      held?.close();
      encoder = null;
      return { preSkip, packets };
    },
    cancel: () => {
      release();
      const held = encoder as AudioEncoder | null;
      if (held !== null && held.state !== "closed") held.close();
      encoder = null;
      packets = [];
    },
    dispose: () => {
      release();
    },
  };
}
