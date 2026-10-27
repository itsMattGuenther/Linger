import type { ScreenCodec } from "../../generated/ScreenCodec";

/**
 * A screen frame on the screen socket (PROTOCOL §8 "Screen sharing", #360):
 * a 12-byte header, then one encoded frame as WebCodecs made it. The server
 * reads the format and the key-frame flag and passes the rest on as it came.
 *
 * | byte | what |
 * |---|---|
 * | 0 | version, 1 |
 * | 1 | format: 1 VP8, 2 H.264 (Annex B) |
 * | 2 | flags: bit 0 on a key frame |
 * | 3 | 0 |
 * | 4–11 | when it was captured, microseconds, big-endian |
 */
export const FRAME_VERSION = 1;
export const FRAME_HEADER_BYTES = 12;
/**
 * The biggest frame the server passes on, header included
 * (`MAX_SCREEN_FRAME_BYTES`); it drops one over it. A sharing app doesn't
 * send one, and makes the next a key frame, the frames after it having
 * nothing to build on.
 */
export const MAX_FRAME_BYTES = 1024 * 1024;

const CODEC_BYTE: Readonly<Record<ScreenCodec, number>> = { vp8: 1, avc1: 2 };

function codecOf(byte: number): ScreenCodec | null {
  if (byte === 1) return "vp8";
  if (byte === 2) return "avc1";
  return null;
}

/** One frame read off the socket. */
export interface ScreenFrame {
  codec: ScreenCodec;
  key: boolean;
  /** When it was captured, in microseconds on the sharer's clock. */
  micros: number;
  data: Uint8Array;
}

/** A frame ready to send: the header, then `data`. */
export function packFrame(codec: ScreenCodec, key: boolean, micros: number, data: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + data.byteLength);
  const view = new DataView(buffer);
  view.setUint8(0, FRAME_VERSION);
  view.setUint8(1, CODEC_BYTE[codec]);
  view.setUint8(2, key ? 1 : 0);
  view.setUint8(3, 0);
  view.setBigUint64(4, BigInt(Math.max(0, Math.floor(micros))));
  new Uint8Array(buffer, FRAME_HEADER_BYTES).set(data);
  return buffer;
}

/**
 * A packet of the computer's sound (PROTOCOL §8, "The computer's sound",
 * #736): a header the size of a frame's whose first byte is 2, which no
 * frame has, so a server or an app that knows only frames drops it.
 *
 * | byte | what |
 * |---|---|
 * | 0 | 2, a sound packet |
 * | 1 | format: 1 Opus, 48 kHz, two channels, 20 ms |
 * | 2, 3 | 0 |
 * | 4–11 | when it was captured, microseconds on the share's frames' clock, big-endian |
 */
export const SOUND_KIND = 2;
const SOUND_OPUS = 1;

/** One sound packet read off the socket. */
export interface SoundPacket {
  micros: number;
  /** The Opus packet. */
  data: Uint8Array;
}

/** Whether a binary message is a sound packet, by its first byte. */
export function isSound(buffer: ArrayBuffer): boolean {
  return buffer.byteLength > FRAME_HEADER_BYTES && new DataView(buffer).getUint8(0) === SOUND_KIND;
}

/** Read a sound packet, or null for anything that isn't one this app knows. */
export function readSound(buffer: ArrayBuffer): SoundPacket | null {
  if (!isSound(buffer)) return null;
  const view = new DataView(buffer);
  if (view.getUint8(1) !== SOUND_OPUS) return null;
  return { micros: Number(view.getBigUint64(4)), data: new Uint8Array(buffer, FRAME_HEADER_BYTES) };
}

/** A sound packet ready to send: the header, then the Opus packet. */
export function packSound(micros: number, data: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + data.byteLength);
  const view = new DataView(buffer);
  view.setUint8(0, SOUND_KIND);
  view.setUint8(1, SOUND_OPUS);
  view.setBigUint64(4, BigInt(Math.max(0, Math.floor(micros))));
  new Uint8Array(buffer, FRAME_HEADER_BYTES).set(data);
  return buffer;
}

/** Read a frame, or null for anything that isn't one this app knows. */
export function readFrame(buffer: ArrayBuffer): ScreenFrame | null {
  if (buffer.byteLength <= FRAME_HEADER_BYTES) return null;
  const view = new DataView(buffer);
  if (view.getUint8(0) !== FRAME_VERSION) return null;
  const codec = codecOf(view.getUint8(1));
  if (codec === null) return null;
  return {
    codec,
    key: (view.getUint8(2) & 1) === 1,
    micros: Number(view.getBigUint64(4)),
    data: new Uint8Array(buffer, FRAME_HEADER_BYTES),
  };
}
