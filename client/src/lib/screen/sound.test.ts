import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The page's half of a share's sound (#736, PROTOCOL §8 "The computer's
// sound"): what a share sends and when, and what a watcher asks for and
// does with what comes. The shell's half is `src-tauri/src/screen_sound.rs`;
// Tauri's calls, the screen socket and the web engine's decoders are stood
// in for here.
const shell = vi.hoisted(() => ({
  tauri: true,
  /** Whether this Windows has process loopback, as the shell says. */
  captures: true,
  calls: [] as { command: string; args: unknown; options?: unknown }[],
  channels: new Map<string, { onmessage: (message: unknown) => void }>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => shell.tauri,
  invoke: (command: string, args?: unknown, options?: unknown) => {
    shell.calls.push({ command, args, options });
    if (command === "screen_sound_available") return Promise.resolve(shell.captures);
    if (command === "screen_watch_available") return Promise.resolve(true);
    if (command === "screen_sound_start") {
      if (!shell.captures) return Promise.reject("no-sound");
      const given = args as Partial<Record<string, { onmessage: (message: unknown) => void }>>;
      if (given.sounds) shell.channels.set("sounds", given.sounds);
      if (given.says) shell.channels.set("soundSays", given.says);
    }
    if (command === "screen_share_start") {
      const given = args as Partial<Record<string, { onmessage: (message: unknown) => void }>>;
      if (given.frames) shell.channels.set("frames", given.frames);
    }
    return Promise.resolve(undefined);
  },
  Channel: class {
    constructor(readonly onmessage: (message: unknown) => void) {}
  },
}));

/** A screen socket, as the page sees one: what it sent, and a way to answer. */
class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static made: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  bufferedAmount = 0;
  binaryType = "blob";
  sent: unknown[] = [];
  #listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeSocket.made.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void, options?: { once?: boolean }): void {
    const once = options?.once === true;
    const wrapped = once
      ? (event: unknown) => {
          this.removeEventListener(type, wrapped);
          listener(event);
        }
      : listener;
    const set = this.#listeners.get(type) ?? new Set();
    set.add(wrapped);
    this.#listeners.set(type, set);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  #emit(type: string, event: unknown): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(event);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.#emit("close", { code });
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.#emit("open", {});
  }

  hear(data: unknown): void {
    this.#emit("message", { data: typeof data === "string" || data instanceof ArrayBuffer ? data : JSON.stringify(data) });
  }

  /** The text it sent, read. */
  said(): { op: string; [key: string]: unknown }[] {
    return this.sent.filter((data): data is string => typeof data === "string").map((text) => JSON.parse(text) as { op: string });
  }

  /** The binary messages it sent. */
  binary(): ArrayBuffer[] {
    return this.sent.filter((data): data is ArrayBuffer => data instanceof ArrayBuffer);
  }
}

const LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const SERVER = "https://porch.example";

const stores = new Map<string, string>();
const storage = {
  getItem: (key: string) => stores.get(key) ?? null,
  setItem: (key: string, value: string) => void stores.set(key, value),
  removeItem: (key: string) => void stores.delete(key),
};

function stubPage(search = ""): void {
  vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval, location: { search } });
  vi.stubGlobal("navigator", { userAgent: LINUX });
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("requestAnimationFrame", (draw: () => void) => setTimeout(draw, 0));
  vi.stubGlobal("cancelAnimationFrame", (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));
}

beforeEach(() => {
  shell.tauri = true;
  shell.captures = true;
  shell.calls = [];
  shell.channels.clear();
  stores.clear();
  FakeSocket.made = [];
  stubPage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function load() {
  const { AuthedApi } = await import("../api");
  const frames = await import("./frames");
  const share = await import("./share");
  const watch = await import("./watch");
  const sound = await import("./sound");
  const listen = await import("./listen");
  const api = new AuthedApi(SERVER, { accessToken: "token", expiresAt: Date.now() + 3_600_000, refreshToken: null, renew: async () => undefined, replace: async () => false });
  return { api, frames, share, watch, sound, listen };
}

/** Let everything waiting run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await new Promise((done) => setTimeout(done, 0));
}

function sounds(): { onmessage: (message: unknown) => void } {
  const channel = shell.channels.get("sounds");
  if (!channel) throw new Error("the sound wasn't started");
  return channel;
}

describe("a share's sound, sent", () => {
  it("says it carries sound, and sends it only once the server says somebody wants it", async () => {
    const { api, frames, share } = await load();
    await share.startSharing({ server: SERVER, api, sessionId: "s", fps: 30, sound: true });
    await settle();
    expect(shell.calls.map((call) => call.command)).toContain("screen_sound_start");
    const socket = FakeSocket.made[0];
    if (!socket) throw new Error("no socket");
    socket.open();
    await settle();
    expect(socket.said()[0]).toMatchObject({ op: "share", sound: true });
    expect(share.currentShare()).toMatchObject({ sound: "on" });
    // A frame, so the frames' clock is known.
    shell.channels.get("frames")?.onmessage(frames.packFrame("vp8", true, 5_000_000, new Uint8Array([1, 2, 3])));
    const packet = () => frames.packSound(123, new Uint8Array([9, 9, 9]));
    // Nobody wants it yet: nothing goes, though the shell captures.
    socket.hear({ op: "want", codecs: ["vp8"] });
    sounds().onmessage(packet());
    expect(socket.binary().filter(frames.isSound)).toHaveLength(0);
    // Somebody does: it goes, stamped on the frames' clock.
    socket.hear({ op: "want", codecs: ["vp8"], sound: true });
    sounds().onmessage(packet());
    sounds().onmessage(frames.packSound(20_123, new Uint8Array([8])));
    const sent = socket.binary().filter(frames.isSound);
    expect(sent).toHaveLength(2);
    const [first, second] = sent.map((one) => frames.readSound(one));
    expect(first?.data).toEqual(new Uint8Array([9, 9, 9]));
    expect(first?.micros).toBeGreaterThanOrEqual(5_000_000);
    // The second 20 ms after the first, as the shell stamped them.
    expect((second?.micros ?? 0) - (first?.micros ?? 0)).toBe(20_000);
    // Nobody any more: it stops.
    socket.hear({ op: "want", codecs: ["vp8"] });
    sounds().onmessage(packet());
    expect(socket.binary().filter(frames.isSound)).toHaveLength(2);
    // A line to the server that's behind gets no sound.
    socket.hear({ op: "want", codecs: ["vp8"], sound: true });
    socket.bufferedAmount = 5_000_000;
    sounds().onmessage(packet());
    expect(socket.binary().filter(frames.isSound)).toHaveLength(2);
    share.stopSharing();
    expect(shell.calls.map((call) => call.command)).toContain("screen_sound_stop");
  });

  it("with the switch off, captures nothing, says nothing, and sends none even when asked", async () => {
    const { api, frames, share } = await load();
    await share.startSharing({ server: SERVER, api, sessionId: "s", fps: 30 });
    await settle();
    expect(shell.calls.map((call) => call.command)).not.toContain("screen_sound_start");
    const socket = FakeSocket.made[0];
    if (!socket) throw new Error("no socket");
    socket.open();
    await settle();
    // The hello is exactly as it was before sound.
    expect(Object.keys(socket.said()[0] ?? {}).sort()).toEqual(["encode", "fps", "op", "session_id", "token"]);
    expect(share.currentShare()?.sound).toBeUndefined();
    socket.hear({ op: "want", codecs: ["vp8"], sound: true });
    expect(socket.binary().filter(frames.isSound)).toHaveLength(0);
    share.stopSharing();
  });

  it("goes ahead without the sound when it can't be captured, and says so", async () => {
    shell.captures = false;
    const { api, share } = await load();
    await share.startSharing({ server: SERVER, api, sessionId: "s", fps: 30, sound: true });
    await settle();
    const socket = FakeSocket.made[0];
    if (!socket) throw new Error("no socket");
    socket.open();
    await settle();
    expect(socket.said()[0]?.sound).toBeUndefined();
    expect(share.currentShare()).toMatchObject({ status: "starting", sound: "failed" });
    share.stopSharing();
  });

  it("is offered only where the shell can capture it: never on a phone or in a browser", async () => {
    const { sound } = await load();
    expect(sound.capturesSound()).toBeNull();
    await settle();
    expect(sound.capturesSound()).toBe(true);
    sound.forgetCaptures();
    shell.captures = false;
    sound.capturesSound();
    await settle();
    expect(sound.capturesSound()).toBe(false);
    sound.forgetCaptures();
    stubPage("?shell=phone");
    expect(sound.capturesSound()).toBe(false);
    shell.tauri = false;
    stubPage();
    expect(sound.capturesSound()).toBe(false);
  });
});

/** Stand-ins for the web engine's video decoding, so a watch can start. */
function stubVideo(): void {
  class Decoder {
    static isConfigSupported = async () => ({ supported: true });
    state = "unconfigured";
    decodeQueueSize = 0;
    configure() {
      this.state = "configured";
    }
    decode() {}
    close() {
      this.state = "closed";
    }
  }
  vi.stubGlobal("VideoDecoder", Decoder);
  vi.stubGlobal("VideoEncoder", Decoder);
  vi.stubGlobal("EncodedVideoChunk", class {});
}

describe("a share's sound, heard", () => {
  it("is asked for, and each packet handed to the shell to play in the call", async () => {
    stubVideo();
    const { api, frames, watch } = await load();
    await watch.startWatching({ server: SERVER, api, sessionId: "w", target: "s", place: "room", who: "jules" });
    await settle();
    const socket = FakeSocket.made[0];
    if (!socket) throw new Error("no socket");
    socket.open();
    await settle();
    expect(socket.said()[0]).toMatchObject({ op: "watch", sound: true });
    socket.hear({ op: "showing", target: "s", codec: "vp8", sound: true });
    expect(watch.currentWatch()).toMatchObject({ sound: true });
    const packet = frames.packSound(40_000, new Uint8Array([7, 7]));
    socket.hear(packet);
    const plays = () => shell.calls.filter((call) => call.command === "screen_sound_play");
    expect(plays()).toHaveLength(1);
    expect(plays()[0]?.args).toEqual(new Uint8Array(packet));
    expect(plays()[0]?.options).toEqual({ headers: { "linger-server": SERVER } });
    // A frame isn't sound.
    socket.hear(frames.packFrame("vp8", true, 1, new Uint8Array([1])));
    expect(plays()).toHaveLength(1);
    watch.stopWatching();
    expect(shell.calls.map((call) => call.command)).toContain("screen_sound_end");
  });

  it("stops when its button is turned off, and the server is told so nothing more is sent", async () => {
    stubVideo();
    const { api, frames, watch, sound } = await load();
    await watch.startWatching({ server: SERVER, api, sessionId: "w", target: "s", place: "room", who: "jules" });
    await settle();
    const socket = FakeSocket.made[0];
    if (!socket) throw new Error("no socket");
    socket.open();
    await settle();
    socket.hear({ op: "showing", target: "s", codec: "vp8", sound: true });
    sound.setWatchSoundOn(false);
    expect(socket.said().at(-1)).toEqual({ op: "sound", on: false });
    expect(shell.calls.map((call) => call.command)).toContain("screen_sound_end");
    socket.hear(frames.packSound(40_000, new Uint8Array([7])));
    expect(shell.calls.filter((call) => call.command === "screen_sound_play")).toHaveLength(0);
    // Kept for next time: the next watch doesn't ask.
    watch.stopWatching();
    expect(sound.watchSoundOn()).toBe(false);
    await watch.startWatching({ server: SERVER, api, sessionId: "w", target: "s", place: "room", who: "jules" });
    await settle();
    const again = FakeSocket.made[1];
    again?.open();
    await settle();
    expect(again?.said()[0]?.sound).toBeUndefined();
    sound.setWatchSoundOn(true);
    expect(again?.said().at(-1)).toEqual({ op: "sound", on: true });
    watch.stopWatching();
  });

  it("plays nothing of a share without sound, and says nothing of sound for it", async () => {
    stubVideo();
    const { api, frames, watch } = await load();
    await watch.startWatching({ server: SERVER, api, sessionId: "w", target: "s", place: "room", who: "jules" });
    await settle();
    const socket = FakeSocket.made[0];
    socket?.open();
    await settle();
    socket?.hear({ op: "showing", target: "s", codec: "vp8" });
    expect(watch.currentWatch()?.sound).toBeUndefined();
    socket?.hear(frames.packSound(40_000, new Uint8Array([7])));
    expect(shell.calls.filter((call) => call.command === "screen_sound_play")).toHaveLength(0);
    watch.stopWatching();
  });

  it("on a phone, is decoded by the page's own decoder, or isn't asked for where there's none", async () => {
    stubVideo();
    shell.tauri = false;
    stubPage("?shell=phone");
    const decoded: { timestamp: number }[] = [];
    class AudioDecoderStub {
      static isConfigSupported = async (config: { codec: string }) => ({ supported: config.codec === "opus" });
      state = "unconfigured";
      configure() {
        this.state = "configured";
      }
      decode(chunk: { timestamp: number }) {
        decoded.push(chunk);
      }
      close() {
        this.state = "closed";
      }
    }
    class Chunk {
      timestamp: number;
      constructor(init: { timestamp: number }) {
        this.timestamp = init.timestamp;
      }
    }
    class Context {
      state = "running";
      currentTime = 0;
      destination = {};
      createGain() {
        return { gain: { value: 1 }, connect: () => undefined };
      }
      close() {
        return Promise.resolve();
      }
    }
    vi.stubGlobal("AudioDecoder", AudioDecoderStub);
    vi.stubGlobal("EncodedAudioChunk", Chunk);
    vi.stubGlobal("window", { setTimeout, clearTimeout, setInterval, clearInterval, location: { search: "?shell=phone" }, AudioContext: Context });
    const { api, frames, watch } = await load();
    await watch.startWatching({ server: SERVER, api, sessionId: "w", target: "s", place: "room", who: "jules" });
    await settle();
    const socket = FakeSocket.made[0];
    socket?.open();
    await settle();
    expect(socket?.said()[0]).toMatchObject({ op: "watch", sound: true });
    socket?.hear({ op: "showing", target: "s", codec: "vp8", sound: true });
    socket?.hear(frames.packSound(60_000, new Uint8Array([7])));
    expect(decoded.map((chunk) => chunk.timestamp)).toEqual([60_000]);
    expect(shell.calls.filter((call) => call.command === "screen_sound_play")).toHaveLength(0);
    watch.stopWatching();

    // An engine with no Opus decoder: no sound asked for, and its screen says it can't play it.
    vi.resetModules();
    vi.stubGlobal("AudioDecoder", undefined);
    const fresh = await load();
    await fresh.watch.startWatching({ server: SERVER, api: fresh.api, sessionId: "w", target: "s", place: "room", who: "jules" });
    await settle();
    const plain = FakeSocket.made[1];
    plain?.open();
    await settle();
    expect(plain?.said()[0]?.sound).toBeUndefined();
    plain?.hear({ op: "showing", target: "s", codec: "vp8", sound: true });
    expect(fresh.watch.currentWatch()).toMatchObject({ sound: "unplayable" });
    fresh.watch.stopWatching();
  });
});

describe("a sound packet on the wire", () => {
  it("round-trips, and is never read as a frame, nor a frame as sound", async () => {
    const { frames } = await load();
    const packet = frames.packSound(9_876_543, new Uint8Array([1, 2, 3]));
    expect(new Uint8Array(packet).slice(0, 4)).toEqual(new Uint8Array([2, 1, 0, 0]));
    expect(frames.readSound(packet)).toEqual({ micros: 9_876_543, data: new Uint8Array([1, 2, 3]) });
    expect(frames.readFrame(packet)).toBeNull();
    const frame = frames.packFrame("vp8", true, 5, new Uint8Array([4]));
    expect(frames.isSound(frame)).toBe(false);
    expect(frames.readSound(frame)).toBeNull();
    // A header and nothing after it is neither.
    expect(frames.readSound(packet.slice(0, frames.FRAME_HEADER_BYTES))).toBeNull();
  });
});
