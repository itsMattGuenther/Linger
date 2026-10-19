/**
 * A stand-in for the server's voice forwarding (#197), for the phone's voice
 * engine (#429, `src/lib/pageVoice.ts`): a real `RTCPeerConnection` in the
 * same page, shaped as the server shapes its side (PROTOCOL, "Voice
 * forwarding"). It makes every offer: one m-line for the phone's microphone,
 * first, then one per person, each carrying a tone; it takes the phone's
 * answer, and a `voice.restart` gets an offer from a fresh connection, with
 * a username fragment of its own. Real DTLS, real ICE, real RTP, all inside
 * one browser, so the engine is proven against the real thing rather than a
 * description of it. What it can't prove is a real network: that is the
 * phone's own check.
 */
import type { VoiceTrack } from "../../../src/generated/VoiceTrack";

/** The `voice.offer` the server sends, as the fixture hands it to the page. */
export interface VoiceOffer {
  op: "voice.offer";
  d: { sdp: string; tracks: VoiceTrack[]; bitrate?: number };
}

/**
 * The browser's own audio, taken before the fixture puts its stand-in for a
 * window's sound device in its place (`audio.ts`): tones need a real one.
 */
const RealAudioContext = window.AudioContext;

/** A real audio context, whatever the fixture's sounds use. */
export function realAudio(): AudioContext {
  return new RealAudioContext();
}

/** Somebody in the room, and how loud their tone is: 0 is somebody in voice saying nothing. */
export interface Voice {
  session: string;
  loudness: number;
}

/** What the fake heard from the phone's microphone so far. */
export interface Received {
  packets: number;
  level: number;
}

/** A tone at `loudness`, as a stream an m-line can carry. */
function tone(audio: AudioContext, hz: number, loudness: number): MediaStream {
  const oscillator = audio.createOscillator();
  oscillator.frequency.value = hz;
  const gain = audio.createGain();
  gain.gain.value = loudness;
  const out = audio.createMediaStreamDestination();
  oscillator.connect(gain).connect(out);
  oscillator.start();
  return out.stream;
}

/** The phone's microphone, as the fixture hands it over: a tone, unless it's told to be quiet. */
export function fakeMicrophone(audio: AudioContext, loudness: number): MediaStream {
  return tone(audio, 330, loudness);
}

export class FakeSfu {
  private conn: RTCPeerConnection | null = null;
  private readonly audio = realAudio();

  constructor(
    private readonly offerFrame: (frame: VoiceOffer) => void,
    private readonly voices: Voice[],
    private readonly bitrate: number | null = null,
  ) {}

  /** Offer the phone a connection: on its join, or a restart. A new connection each time, as the server starts one. */
  async offer(): Promise<void> {
    this.conn?.close();
    const conn = new RTCPeerConnection();
    this.conn = conn;
    await this.audio.resume().catch(() => undefined);
    conn.addTransceiver("audio", { direction: "recvonly" });
    const theirs = this.voices.map((voice, n) => {
      const stream = tone(this.audio, 440 + n * 110, voice.loudness);
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error("no tone");
      return { voice, transceiver: conn.addTransceiver(track, { direction: "sendonly", streams: [stream] }) };
    });
    await conn.setLocalDescription(await conn.createOffer());
    // The server's offer carries its one host candidate, and the phone sends
    // none back: it learns where the phone is from the phone's own checks.
    await new Promise<void>((done) => {
      if (conn.iceGatheringState === "complete") return done();
      conn.addEventListener("icegatheringstatechange", () => conn.iceGatheringState === "complete" && done());
    });
    if (this.conn !== conn) return;
    this.offerFrame({
      op: "voice.offer",
      d: {
        sdp: conn.localDescription?.sdp ?? "",
        tracks: theirs.map(({ voice, transceiver }) => ({ mid: transceiver.mid ?? "", session_id: voice.session })),
        ...(this.bitrate === null ? {} : { bitrate: this.bitrate }),
      },
    });
  }

  /** The phone's answer to the latest offer. */
  async answer(sdp: string): Promise<void> {
    await this.conn?.setRemoteDescription({ type: "answer", sdp });
  }

  /** The phone left: its connection goes. */
  close(): void {
    this.conn?.close();
    this.conn = null;
  }

  /**
   * The network under the call went away: the connection here stops, and
   * no offer follows until the phone asks for one.
   */
  drop(): void {
    this.close();
  }

  /**
   * What has come in on the microphone's m-line so far: packets, and the
   * loudness the latest one said it was (the `ssrc-audio-level` header
   * extension), which is what the server ranks a room's voices by (#197).
   */
  async received(): Promise<Received> {
    const stats = await this.conn?.getStats();
    let packets = 0;
    stats?.forEach((report: { type?: string; kind?: string; packetsReceived?: number }) => {
      if (report.type === "inbound-rtp" && report.kind === "audio") packets += report.packetsReceived ?? 0;
    });
    const mic = this.conn?.getTransceivers()[0]?.receiver;
    const level = Math.max(0, ...(mic?.getSynchronizationSources() ?? []).map((source) => source.audioLevel ?? 0));
    return { packets, level };
  }

  /** Whether the connection here is up. */
  get state(): RTCPeerConnectionState | "none" {
    return this.conn?.connectionState ?? "none";
  }
}
