/**
 * Voice in the page, for the phone app (#429, SPEC §4.15).
 *
 * On a computer, voice lives in Rust (`src-tauri/src/voice/`), and the page
 * only says join and leave. A phone has no Rust voice: its web engine has
 * WebRTC built in, with the phone's own echo cancelling, noise suppression
 * and level control, which is what makes a phone on speaker usable at all.
 * So on the phone the same calls in `ipc.ts` land here, and this does what
 * the Rust engine does, in the same order and by the same rules (PROTOCOL,
 * "Voice forwarding"):
 *
 * - The server makes every offer; this end only answers, on one connection.
 *   The one m-line the offer's `tracks` doesn't name is the microphone's;
 *   every other is somebody's voice coming in, named by `mid`.
 * - An offer with a different ICE username fragment is from a connection the
 *   server started afresh, and is answered on a new connection (#656).
 * - The connection is started afresh by `voiceRestarts.ts`'s rules.
 * - Mute and deafen are local and told to the room in a `voice.join`.
 * - Who's talking is judged at the same level as on a computer
 *   (`voice/level.rs`), with the same 300 ms hangover.
 *
 * It raises the same four events the Rust engine does (`voice:peer`,
 * `voice:audio`, `voice:microphone`, `voice:speaking`), so the store and the
 * screens don't know which engine they're talking to.
 */
import type { ClientFrame } from "../generated/ClientFrame";
import type { IceServer } from "../generated/IceServer";
import type { RoomId } from "../generated/RoomId";
import type { VoiceControls } from "../generated/VoiceControls";
import type { VoiceTrack } from "../generated/VoiceTrack";
import { type RestartEvent, Restarts } from "./voiceRestarts";

/** The events the engine raises, as the Rust engine names them (`voice_commands.rs`). */
export type PageVoiceEvent = "voice:peer" | "voice:audio" | "voice:microphone" | "voice:speaking";

/** Where the engine's frames go, and where its events go. */
export interface PageVoiceWire {
  /** One frame to the server's gateway connection: a join, an answer, a restart or a leave. */
  send(server: string, frame: ClientFrame): Promise<unknown>;
  /** One of the four events, with the payload the Rust engine would give it. */
  emit(event: PageVoiceEvent, payload: Record<string, unknown>): void;
}

/** The parts of the browser the engine uses, so a test can hand it stand-ins. */
export interface PageVoiceWorld {
  getMicrophone(): Promise<MediaStream>;
  connect(config: RTCConfiguration): RTCPeerConnection;
  /** Something that plays one person's voice, at a volume of 0 to 1. */
  player(): Player;
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

/** Plays one incoming voice. */
export interface Player {
  play(stream: MediaStream): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  stop(): void;
}

/**
 * How loud a frame must be to count as talking: the Rust engine's 500 RMS on
 * 16-bit samples (`voice/level.rs`), as the 0 to 1 level WebRTC reports.
 */
export const TALKING_LEVEL = 500 / 32767;

/** How long somebody stays "talking" after their last loud moment. */
export const HANGOVER_MS = 300;

/** How often who's talking is looked at. */
const LISTEN_EVERY_MS = 100;

/** The microphone, cleaned up the way a call wants it. */
export const MICROPHONE: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};

/** The browser's own pieces: the phone's microphone, a real connection, an `<audio>` per voice. */
export function browserWorld(): PageVoiceWorld {
  return {
    getMicrophone: () => navigator.mediaDevices.getUserMedia({ audio: MICROPHONE, video: false }),
    connect: (config) => new RTCPeerConnection(config),
    player: () => audioPlayer(),
    now: () => performance.now(),
    setTimeout: (run, ms) => window.setTimeout(run, ms),
    clearTimeout: (timer) => window.clearTimeout(timer as number),
  };
}

/**
 * One voice, played by an `<audio>` element: the path WebRTC's own echo
 * cancelling hears, and the one the phone routes as a call. A volume above
 * 100% isn't something an element can do, so the phone's ceiling is 100%.
 */
function audioPlayer(): Player {
  const audio = document.createElement("audio");
  audio.autoplay = true;
  audio.dataset.voice = "";
  audio.hidden = true;
  document.body.append(audio);
  return {
    play(stream) {
      audio.srcObject = stream;
      void audio.play().catch(() => undefined);
    },
    setVolume(volume) {
      audio.volume = Math.max(0, Math.min(1, volume));
    },
    setMuted(muted) {
      audio.muted = muted;
    },
    stop() {
      audio.srcObject = null;
      audio.remove();
    },
  };
}

/** Why the microphone wouldn't open, in the words `voiceStartProblem` (`voice.ts`) reads. */
export function microphoneProblem(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "permission denied for the microphone";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "no input device";
  if (name === "NotReadableError" || name === "AbortError") return "the microphone is in use";
  return error instanceof Error && error.message !== "" ? error.message : String(error);
}

/** The ICE username fragment an SDP gives (RFC 8839 §5.4): each connection the server starts has its own. */
export function iceUfrag(sdp: string): string | null {
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith("a=ice-ufrag:")) return line.slice("a=ice-ufrag:".length).trim();
  }
  return null;
}

/** Every m-line's mid, in order. */
export function mids(sdp: string): string[] {
  return sdp
    .split(/\r?\n/)
    .filter((line) => line.startsWith("a=mid:"))
    .map((line) => line.slice("a=mid:".length).trim());
}

/** The microphone's m-line: the one the offer's `tracks` doesn't name (PROTOCOL, "Voice forwarding"). */
export function microphoneMid(sdp: string, tracks: readonly VoiceTrack[]): string | null {
  const named = new Set(tracks.map((track) => track.mid));
  return mids(sdp).find((mid) => !named.has(mid)) ?? null;
}

/**
 * The offer, with Opus asked to stop sending in silence on the microphone's
 * m-line (`usedtx=1`, RFC 7587 §6.1). The desktop engine sends nothing while
 * nobody talks (#197), and a room of fifty is quiet because of it; a
 * browser's WebRTC sends silence unless the far end says it would rather not,
 * and this is where it says so.
 */
export function withQuietSilence(sdp: string, mid: string): string {
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const sections = sdp.split(/\r?\n(?=m=)/);
  return sections
    .map((section) => {
      const lines = section.split(/\r?\n/);
      if (!lines.includes(`a=mid:${mid}`)) return section;
      const opus = lines.map((line) => /^a=rtpmap:(\d+) opus\/48000/i.exec(line)?.[1]).find((pt) => pt !== undefined);
      if (opus === undefined) return section;
      const fmtp = lines.findIndex((line) => line.startsWith(`a=fmtp:${opus} `));
      if (fmtp === -1) {
        const rtpmap = lines.findIndex((line) => line.startsWith(`a=rtpmap:${opus} `));
        lines.splice(rtpmap + 1, 0, `a=fmtp:${opus} usedtx=1`);
      } else if (!/usedtx=/.test(lines[fmtp]!)) {
        lines[fmtp] = `${lines[fmtp]!};usedtx=1`;
      }
      return lines.join(eol);
    })
    .join(eol);
}

/** One person's "talking" mark, on and off as the Rust engine's gate does it. */
export class Gate {
  private on = false;
  private lastLoud: number | null = null;

  /** A level at `now`; answers the change, if there was one. */
  update(level: number, now: number): boolean | null {
    if (level >= TALKING_LEVEL) {
      this.lastLoud = now;
      if (this.on) return null;
      this.on = true;
      return true;
    }
    if (!this.on) return null;
    if (this.lastLoud !== null && now - this.lastLoud < HANGOVER_MS) return null;
    this.on = false;
    return false;
  }

  get isOn(): boolean {
    return this.on;
  }
}

/** What one incoming m-line last looked like, to tell a voice that stopped from one still going. */
interface Heard {
  packets: number;
  at: number;
}

/** One server's call. */
class Call {
  room: RoomId | null = null;
  me = "";
  controls: VoiceControls = { muted: false, deafened: false };
  ice: IceServer[] = [];
  mic: MediaStream | null = null;
  conn: RTCPeerConnection | null = null;
  /** Whose voice each receiving m-line carries, from the latest offer. */
  tracks = new Map<string, string>();
  players = new Map<string, Player>();
  /** How loud each person plays, by session id. */
  volumes = new Map<string, number>();
  /** The room's quality from the latest offer, in bits a second; null for the encoder's own. */
  bits: number | null = null;
  restarts = new Restarts();
  wake: unknown = null;
  listening: unknown = null;
  /** Talking marks: `""` is you. */
  gates = new Map<string, Gate>();
  /** Which person each gate is for, by mid: a reused m-line starts the next person fresh. */
  gateFor = new Map<string, string>();
  heard = new Map<string, Heard>();
}

/**
 * The phone's voice engine: one call per server, at most one of them in a
 * room. Mirrors the Rust engine's commands one for one; `ipc.ts` routes them
 * here on the phone.
 */
export class PageVoice {
  private readonly calls = new Map<string, Call>();

  constructor(
    private readonly wire: PageVoiceWire,
    private readonly world: PageVoiceWorld = browserWorld(),
  ) {}

  private call(server: string): Call {
    let call = this.calls.get(server);
    if (!call) {
      call = new Call();
      this.calls.set(server, call);
    }
    return call;
  }

  /**
   * Join voice in a room: open the microphone, then ask. The connection is
   * built when the server's offer arrives. Rejects with words
   * `voiceStartProblem` reads when the microphone won't open, and then
   * nothing was joined.
   */
  async join(server: string, sessionId: string, roomId: RoomId, ice: IceServer[]): Promise<void> {
    const call = this.call(server);
    if (call.room !== null) this.hangUp(server, call, "closed");
    let mic: MediaStream;
    try {
      mic = await this.world.getMicrophone();
    } catch (error) {
      throw new Error(microphoneProblem(error));
    }
    call.me = sessionId;
    call.ice = ice;
    call.mic = mic;
    call.room = roomId;
    call.bits = null;
    call.restarts = new Restarts();
    this.applyControls(call);
    for (const track of mic.getAudioTracks()) {
      // The microphone went away mid-call: another app took it, or the
      // permission was taken back. Said, as the Rust engine says it.
      track.addEventListener("ended", () => {
        if (this.calls.get(server)?.mic === mic) this.wire.emit("voice:audio", { server, state: "stopped" });
      });
    }
    this.wire.emit("voice:audio", { server, state: "sending" });
    this.listen(server, call);
    await this.wire.send(server, { op: "voice.join", d: { room_id: roomId, controls: call.controls, forwarding: true } });
  }

  /** Leave, and close everything whether or not the server answers. */
  async leave(server: string): Promise<void> {
    const call = this.calls.get(server);
    const sending = this.wire.send(server, { op: "voice.leave" }).catch(() => undefined);
    if (call) this.hangUp(server, call, "closed");
    await sending;
  }

  /**
   * Mute and deafen: yours, local, and told to the room (SPEC §4.14). Set
   * before a join too, which carries them.
   */
  async setControls(server: string, controls: VoiceControls): Promise<void> {
    const call = this.call(server);
    // Deafened is muted too, as the Rust engine's `normalized` has it.
    const next = { muted: controls.muted || controls.deafened, deafened: controls.deafened };
    const changed = next.muted !== call.controls.muted || next.deafened !== call.controls.deafened;
    call.controls = next;
    this.applyControls(call);
    if (changed && call.room !== null) {
      await this.wire.send(server, { op: "voice.join", d: { room_id: call.room, controls: next, forwarding: true } });
    }
  }

  /** How loud one person (a session id) plays: 0 to 1 here (see `audioPlayer`). */
  setVolume(server: string, peer: string, volume: number): void {
    const call = this.call(server);
    call.volumes.set(peer, volume);
    for (const [mid, session] of call.tracks) {
      if (session === peer) call.players.get(mid)?.setVolume(volume);
    }
  }

  /** The gateway came back and resumed while in voice: the plainest sign the network changed (#656). */
  gatewayResumed(server: string): void {
    const call = this.calls.get(server);
    if (call?.room != null) this.steer(server, call, "gateway-resumed");
  }

  /** The forwarding server's offer: answer it, on the one connection (PROTOCOL, "Voice forwarding"). */
  async offer(server: string, sdp: string, tracks: VoiceTrack[], bitrate: number | null): Promise<void> {
    const call = this.calls.get(server);
    if (!call || call.room === null || call.mic === null) return;
    call.bits = bitrate;
    const named = new Map(tracks.map((track) => [track.mid, track.session_id]));
    const still = new Set(named.values());
    for (const session of call.tracks.values()) {
      if (!still.has(session)) this.wire.emit("voice:peer", { server, peer: session, state: "closed" });
    }
    call.tracks = named;
    this.applyVolumes(call);

    // From a connection the server started afresh: ours is closed, and the
    // offer gets a new one (#656).
    if (call.conn !== null) {
      const current = call.conn.remoteDescription?.sdp;
      if (current !== undefined && iceUfrag(current) !== iceUfrag(sdp)) {
        this.closeConnection(server, call);
        for (const track of tracks) this.wire.emit("voice:peer", { server, peer: track.session_id, state: "connecting" });
      }
    }
    const fresh = call.conn === null;
    const conn = call.conn ?? this.open(server, call);
    const mic = microphoneMid(sdp, tracks);
    await conn.setRemoteDescription({ type: "offer", sdp: mic === null ? sdp : withQuietSilence(sdp, mic) });
    if (call.conn !== conn) return;
    for (const transceiver of conn.getTransceivers()) {
      if (transceiver.mid === null || transceiver.currentDirection === "stopped") continue;
      if (transceiver.mid === mic) {
        transceiver.direction = "sendonly";
        const track = call.mic.getAudioTracks()[0] ?? null;
        if (transceiver.sender.track !== track) await transceiver.sender.replaceTrack(track);
      } else {
        transceiver.direction = "recvonly";
      }
    }
    const answer = await conn.createAnswer();
    await conn.setLocalDescription(answer);
    if (call.conn !== conn) return;
    await this.applyBits(call);
    await this.wire.send(server, { op: "voice.answer", d: { sdp: conn.localDescription?.sdp ?? answer.sdp ?? "" } });
    // A new connection answered is the server's reply to a restart, or to
    // the join: the one in flight is over (#656).
    if (fresh) this.steer(server, call, "answered");
    if (conn.connectionState === "connected") {
      for (const track of tracks) this.wire.emit("voice:peer", { server, peer: track.session_id, state: "connected" });
    }
  }

  /** Whether this server's call is in a room: for tests, and the app's background rules. */
  inVoice(server: string): boolean {
    return this.calls.get(server)?.room != null;
  }

  private open(server: string, call: Call): RTCPeerConnection {
    const conn = this.world.connect({
      iceServers: call.ice.map((ice) => ({
        urls: ice.urls,
        ...(ice.username === null ? {} : { username: ice.username }),
        ...(ice.credential === null ? {} : { credential: ice.credential }),
      })),
    });
    call.conn = conn;
    conn.addEventListener("track", (event) => {
      const mid = event.transceiver.mid;
      if (mid === null || call.conn !== conn) return;
      call.players.get(mid)?.stop();
      const player = this.world.player();
      player.setMuted(call.controls.deafened);
      player.play(event.streams[0] ?? new MediaStream([event.track]));
      call.players.set(mid, player);
      this.applyVolumes(call);
    });
    conn.addEventListener("connectionstatechange", () => {
      if (call.conn !== conn) return;
      const state = conn.connectionState;
      for (const session of call.tracks.values()) this.wire.emit("voice:peer", { server, peer: session, state });
      const event: RestartEvent | null =
        state === "connected" ? "connected" : state === "disconnected" ? "disconnected" : state === "failed" ? "failed" : null;
      if (event !== null) this.steer(server, call, event);
    });
    return conn;
  }

  /** Mute and deafen, applied: the microphone sends silence, and nobody plays. */
  private applyControls(call: Call) {
    for (const track of call.mic?.getAudioTracks() ?? []) track.enabled = !call.controls.muted;
    for (const player of call.players.values()) player.setMuted(call.controls.deafened);
  }

  private applyVolumes(call: Call) {
    for (const [mid, player] of call.players) {
      const session = call.tracks.get(mid);
      player.setVolume(session === undefined ? 1 : (call.volumes.get(session) ?? 1));
    }
  }

  /** The room's quality, from its offer (#431); left to the encoder when it says nothing. */
  private async applyBits(call: Call) {
    const sender = call.conn?.getSenders().find((one) => one.track !== null);
    if (!sender) return;
    const parameters = sender.getParameters();
    const encoding = parameters.encodings?.[0];
    if (!encoding) return;
    if (call.bits === null) delete encoding.maxBitrate;
    else encoding.maxBitrate = call.bits;
    await sender.setParameters(parameters).catch(() => undefined);
  }

  /** Hand the restart rules something that happened, and act on what they say. */
  private steer(server: string, call: Call, event: RestartEvent) {
    const plan = call.restarts.on(event, this.world.now());
    if (call.wake !== null) this.world.clearTimeout(call.wake);
    call.wake = null;
    if (plan.restart) this.restart(server, call);
    if (plan.wake !== null) {
      call.wake = this.world.setTimeout(() => {
        call.wake = null;
        if (this.calls.get(server) === call && call.room !== null) this.steer(server, call, "tick");
      }, Math.max(0, plan.wake - this.world.now()));
    }
  }

  /** Close the connection, forget whose voice it carried, and ask the server for a new offer. */
  private restart(server: string, call: Call) {
    if (call.room === null) return;
    this.closeConnection(server, call);
    for (const session of call.tracks.values()) this.wire.emit("voice:peer", { server, peer: session, state: "connecting" });
    call.tracks = new Map();
    void this.wire.send(server, { op: "voice.restart" }).catch(() => undefined);
  }

  /** Close the connection and stop every voice it carried; their marks go out. Yours stays. */
  private closeConnection(server: string, call: Call) {
    call.conn?.close();
    call.conn = null;
    for (const player of call.players.values()) player.stop();
    call.players.clear();
    for (const [key, gate] of call.gates) {
      if (key !== "" && gate.isOn) this.wire.emit("voice:speaking", { server, peer: call.gateFor.get(key) ?? null, speaking: false });
    }
    const yours = call.gates.get("");
    call.gates = yours === undefined ? new Map() : new Map([["", yours]]);
    call.gateFor.clear();
    call.heard.clear();
  }

  /** End the call here: the microphone off, every voice gone, every mark out. */
  private hangUp(server: string, call: Call, state: string) {
    this.closeConnection(server, call);
    if (call.gates.get("")?.isOn) this.wire.emit("voice:speaking", { server, peer: null, speaking: false });
    call.gates.clear();
    for (const session of call.tracks.values()) this.wire.emit("voice:peer", { server, peer: session, state });
    call.tracks = new Map();
    for (const track of call.mic?.getTracks() ?? []) track.stop();
    call.mic = null;
    call.room = null;
    if (call.wake !== null) this.world.clearTimeout(call.wake);
    call.wake = null;
    if (call.listening !== null) this.world.clearTimeout(call.listening);
    call.listening = null;
  }

  /**
   * Who's talking, looked at every tenth of a second: each incoming voice's
   * level as WebRTC heard it, and yours as it's sent. Somebody who stops
   * talking stops sending (#197), so a voice that has brought no packet for
   * the hangover counts as quiet.
   */
  private listen(server: string, call: Call) {
    const look = async () => {
      if (this.calls.get(server) !== call || call.room === null) return;
      const now = this.world.now();
      const stats = await call.conn?.getStats().catch(() => null);
      const levels = new Map<string, number>();
      let mine = 0;
      stats?.forEach((report: { type?: string; kind?: string; mid?: string; audioLevel?: number; packetsReceived?: number }) => {
        if (report.type === "media-source" && report.kind === "audio") mine = report.audioLevel ?? 0;
        if (report.type === "inbound-rtp" && report.kind === "audio" && report.mid !== undefined) {
          const before = call.heard.get(report.mid);
          const packets = report.packetsReceived ?? 0;
          const moving = before === undefined || packets !== before.packets;
          if (moving) call.heard.set(report.mid, { packets, at: now });
          const fresh = moving || (before !== undefined && now - before.at < HANGOVER_MS);
          levels.set(report.mid, fresh ? (report.audioLevel ?? 0) : 0);
        }
      });
      this.mark(server, call, "", null, call.controls.muted ? 0 : mine, now);
      for (const [mid, session] of call.tracks) this.mark(server, call, mid, session, levels.get(mid) ?? 0, now);
      if (this.calls.get(server) === call && call.room !== null) {
        call.listening = this.world.setTimeout(() => void look(), LISTEN_EVERY_MS);
      }
    };
    call.listening = this.world.setTimeout(() => void look(), LISTEN_EVERY_MS);
  }

  /** One mark's level; a reused m-line puts the last person's mark out first. */
  private mark(server: string, call: Call, key: string, session: string | null, level: number, now: number) {
    if (session !== null && call.gateFor.get(key) !== session) {
      const previous = call.gateFor.get(key);
      const gate = call.gates.get(key);
      if (previous !== undefined && gate?.isOn) this.wire.emit("voice:speaking", { server, peer: previous, speaking: false });
      call.gates.set(key, new Gate());
      call.gateFor.set(key, session);
    }
    let gate = call.gates.get(key);
    if (!gate) {
      gate = new Gate();
      call.gates.set(key, gate);
    }
    const change = gate.update(level, now);
    if (change !== null) this.wire.emit("voice:speaking", { server, peer: session, speaking: change });
  }
}
