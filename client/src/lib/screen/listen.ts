import { invoke } from "@tauri-apps/api/core";
import { readSound } from "./frames";
import { desktopShell } from "./sound";

/**
 * Playing a watched screen's sound (SPEC §4.20, PROTOCOL §8, #736).
 *
 * - **In a desktop app** each packet goes to the shell, which decodes it and
 *   plays it in the call, through the Speakers picked in Settings, mixed over
 *   the voices the way Linger's own sounds are (#250,
 *   `src-tauri/src/screen_sound.rs`). Watching is being in voice, so there is
 *   always a call to play it in.
 * - **On a phone** the web engine plays it: WebCodecs' `AudioDecoder` turns
 *   each packet back into sound, and Web Audio plays it, where the engine
 *   has both. Where it hasn't, there's no sound, and the screen says so.
 *
 * Either way it plays a little behind, `CUSHION_S`, so packets coming
 * unevenly play evenly, and sound that would put it further behind than
 * `MOST_S` is dropped rather than played late.
 */

/** How far behind the sound starts, in seconds. */
const CUSHION_S = 0.08;
/** The most it falls behind before sound is dropped rather than played late. */
const MOST_S = 0.16;

/** What the web engine decodes: Opus, 48 kHz, two channels. */
export const SOUND_DECODER: AudioDecoderConfig = { codec: "opus", sampleRate: 48_000, numberOfChannels: 2 };

export interface SoundPlayer {
  /** One packet as it came on the watch socket. */
  play(packet: ArrayBuffer): void;
  /** 0 to 1. */
  volume(volume: number): void;
  /** Stop, letting go of what's waiting to play. */
  stop(): void;
}

let pagePlays: Promise<boolean> | null = null;

/** Whether this app can play a screen's sound: a desktop app's shell always can; elsewhere the engine's WebCodecs must take Opus. Asked once. */
export function playsSound(): Promise<boolean> {
  if (desktopShell()) return Promise.resolve(true);
  pagePlays ??= (async () => {
    if (typeof globalThis.AudioDecoder !== "function" || typeof globalThis.EncodedAudioChunk !== "function" || audioContext() === null) return false;
    try {
      return (await AudioDecoder.isConfigSupported(SOUND_DECODER)).supported === true;
    } catch {
      return false;
    }
  })();
  return pagePlays;
}

/** For tests: ask again. */
export function forgetPlays(): void {
  pagePlays = null;
}

/** A player for a screen's sound on `server`: the shell's in a desktop app, the page's elsewhere. */
export function soundPlayer(server: string, volume: number): SoundPlayer {
  return desktopShell() ? shellPlayer(server, volume) : new PagePlayer(volume);
}

/** What the page has played, for tests: packets started, and dropped for coming late. */
export const heard = { played: 0, dropped: 0 };

function shellPlayer(server: string, volume: number): SoundPlayer {
  void invoke("screen_sound_volume", { baseUrl: server, volume }).catch(() => undefined);
  return {
    play: (packet) => {
      heard.played += 1;
      void invoke("screen_sound_play", new Uint8Array(packet), { headers: { "linger-server": server } }).catch(() => undefined);
    },
    volume: (to) => void invoke("screen_sound_volume", { baseUrl: server, volume: to }).catch(() => undefined),
    stop: () => void invoke("screen_sound_end", { baseUrl: server }).catch(() => undefined),
  };
}

function audioContext(): (new () => AudioContext) | null {
  if (typeof window === "undefined") return null;
  if (typeof window.AudioContext === "function") return window.AudioContext;
  const webkit = (window as unknown as { webkitAudioContext?: new () => AudioContext }).webkitAudioContext;
  return typeof webkit === "function" ? webkit : null;
}

/** The page's own player: WebCodecs to decode, Web Audio to play. */
class PagePlayer implements SoundPlayer {
  #context: AudioContext | null = null;
  #gain: GainNode | null = null;
  #decoder: AudioDecoder | null = null;
  /** When, on the context's clock, the next sound starts. */
  #next = 0;
  #level: number;
  #done = false;

  constructor(volume: number) {
    this.#level = volume;
    const Context = audioContext();
    if (!Context) return;
    try {
      this.#context = new Context();
      this.#gain = this.#context.createGain();
      this.#gain.gain.value = volume;
      this.#gain.connect(this.#context.destination);
      this.#decoder = new AudioDecoder({ output: (data) => this.#out(data), error: () => this.#broken() });
      this.#decoder.configure(SOUND_DECODER);
    } catch {
      this.stop();
    }
  }

  play(packet: ArrayBuffer): void {
    const sound = readSound(packet);
    const decoder = this.#decoder;
    if (!sound || !decoder || decoder.state !== "configured" || this.#done) return;
    // A context the engine held back until a press starts with the sound.
    if (this.#context?.state === "suspended") void this.#context.resume().catch(() => undefined);
    try {
      decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: sound.micros, data: sound.data }));
    } catch {
      this.#broken();
    }
  }

  /** One packet's sound, decoded: played after the last, or dropped if that's too late. */
  #out(data: AudioData): void {
    const context = this.#context;
    const gain = this.#gain;
    if (this.#done || !context || !gain) {
      data.close();
      return;
    }
    try {
      const frames = data.numberOfFrames;
      const buffer = context.createBuffer(2, frames, data.sampleRate);
      for (let channel = 0; channel < 2; channel += 1) {
        const plane = new Float32Array(frames);
        data.copyTo(plane, { planeIndex: Math.min(channel, data.numberOfChannels - 1), format: "f32-planar" });
        buffer.copyToChannel(plane, channel);
      }
      const now = context.currentTime;
      const ahead = this.#next - now;
      if (ahead < 0.005) this.#next = now + CUSHION_S;
      else if (ahead > MOST_S) {
        heard.dropped += 1;
        return;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.start(this.#next);
      this.#next += buffer.duration;
      heard.played += 1;
    } catch {
      // An engine that can't hand the sound over: nothing plays.
    } finally {
      data.close();
    }
  }

  /** The decoder broke: start a new one with the next packet. */
  #broken(): void {
    if (this.#done) return;
    try {
      if (this.#decoder && this.#decoder.state !== "closed") this.#decoder.close();
      this.#decoder = new AudioDecoder({ output: (data) => this.#out(data), error: () => this.stop() });
      this.#decoder.configure(SOUND_DECODER);
    } catch {
      this.stop();
    }
  }

  volume(volume: number): void {
    this.#level = volume;
    if (this.#gain) this.#gain.gain.value = this.#level;
  }

  stop(): void {
    if (this.#done) return;
    this.#done = true;
    try {
      if (this.#decoder && this.#decoder.state !== "closed") this.#decoder.close();
    } catch {
      // Already gone.
    }
    this.#decoder = null;
    const context = this.#context;
    this.#context = null;
    this.#gain = null;
    void context?.close().catch(() => undefined);
  }
}
