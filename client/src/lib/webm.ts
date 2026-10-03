/**
 * A voice message's file (#401): Opus packets, as Linger's recorder makes
 * them, put into a WebM file that every engine Linger runs in plays —
 * Chromium and WebView2, WebKitGTK through GStreamer, and Safari's WebKit.
 *
 * WebM is Matroska with fewer choices: a header saying what the file is
 * (EBML), then one Segment holding the file's Info (its length), its Tracks
 * (one, Opus, mono), its Cues (where each Cluster starts, so a player can
 * seek without reading the whole file) and the Clusters, each a few seconds
 * of packets as SimpleBlocks. Every size is known before it's written, so
 * the file is made in one go, in memory: five minutes of voice is about a
 * megabyte.
 *
 * Matroska numbers everything as EBML: an element is its ID, its size as a
 * variable-length integer, then its body. Sizes are written as short as they
 * go: the server's sniffer knows a WebM file by its doc type with a one-byte
 * size (`infer`'s `is_webm`), and would turn a longer one away.
 * https://www.matroska.org/technical/elements.html
 * https://www.matroska.org/technical/codec_specs.html (A_OPUS)
 */

/** The recorder's packets are 20 ms of sound each, at 48 kHz. */
export const PACKET_MS = 20;
const SAMPLE_RATE = 48_000;
/** A cluster's blocks are timed from its start in a signed 16-bit count of milliseconds; 5 s keeps far inside it. */
const CLUSTER_MS = 5_000;
/** How far back a decoder starts to settle after a seek, as Opus asks (80 ms, in nanoseconds). */
const SEEK_PRE_ROLL_NS = 80_000_000;

/** An element: its ID's bytes, then its size, then its body. */
function element(id: number, body: Uint8Array): Uint8Array {
  return concat([idBytes(id), sizeBytes(body.length), body]);
}

function idBytes(id: number): Uint8Array {
  const bytes: number[] = [];
  for (let rest = id; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Uint8Array.from(bytes);
}

/** A size as an EBML variable-length integer: as few bytes as hold it, with all ones (unknown) never used. */
function sizeBytes(size: number): Uint8Array {
  let length = 1;
  while (size >= 2 ** (7 * length) - 1) length += 1;
  const out = new Uint8Array(length);
  let rest = size;
  for (let at = length - 1; at >= 0; at -= 1) {
    out[at] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  out[0] = (out[0] ?? 0) | (0x80 >> (length - 1));
  return out;
}

/** An unsigned integer element, in as few bytes as hold it, or in `width` bytes whatever it says. */
function uint(id: number, value: number, width?: number): Uint8Array {
  let length = width ?? 1;
  if (width === undefined) while (value >= 2 ** (8 * length)) length += 1;
  const body = new Uint8Array(length);
  let rest = value;
  for (let at = length - 1; at >= 0; at -= 1) {
    body[at] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  return element(id, body);
}

function float(id: number, value: number): Uint8Array {
  const body = new Uint8Array(8);
  new DataView(body.buffer).setFloat64(0, value);
  return element(id, body);
}

function text(id: number, value: string): Uint8Array {
  return element(id, new TextEncoder().encode(value));
}

function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Opus's own header, which Matroska carries as the track's CodecPrivate
 * (RFC 7845 §5.1): version 1, one channel, how many samples to drop from the
 * start (the encoder's lookahead), the rate the sound was recorded at, no
 * gain, and the plain mono/stereo channel mapping.
 */
function opusHead(preSkip: number): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode("OpusHead"), 0);
  const view = new DataView(head.buffer);
  view.setUint8(8, 1);
  view.setUint8(9, 1);
  view.setUint16(10, preSkip, true);
  view.setUint32(12, SAMPLE_RATE, true);
  view.setInt16(16, 0, true);
  view.setUint8(18, 0);
  return head;
}

/** One packet in a cluster: track 1, its time from the cluster's start, and every packet is a keyframe. */
function simpleBlock(packet: Uint8Array, offsetMs: number): Uint8Array {
  const header = new Uint8Array(4);
  header[0] = 0x81;
  new DataView(header.buffer).setInt16(1, offsetMs);
  header[3] = 0x80;
  return element(0xa3, concat([header, packet]));
}

/**
 * The whole file, from the recorder's packets in order. `preSkip` is the
 * encoder's lookahead in samples at 48 kHz: the decoder drops that much from
 * the start, so the clip starts where you started talking.
 */
export function opusWebm(packets: readonly Uint8Array[], preSkip: number): Uint8Array<ArrayBuffer> {
  const durationMs = packets.length * PACKET_MS;
  const header = element(
    0x1a45dfa3,
    concat([uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), text(0x4282, "webm"), uint(0x4287, 4), uint(0x4285, 2)]),
  );
  const info = element(0x1549a966, concat([uint(0x2ad7b1, 1_000_000), text(0x4d80, "Linger"), text(0x5741, "Linger"), float(0x4489, durationMs)]));
  const tracks = element(
    0x1654ae6b,
    element(
      0xae,
      concat([
        uint(0xd7, 1),
        uint(0x73c5, 1),
        uint(0x83, 2),
        text(0x86, "A_OPUS"),
        element(0x63a2, opusHead(preSkip)),
        uint(0x56aa, Math.round((preSkip / SAMPLE_RATE) * 1e9)),
        uint(0x56bb, SEEK_PRE_ROLL_NS),
        element(0xe1, concat([float(0xb5, SAMPLE_RATE), uint(0x9f, 1)])),
      ]),
    ),
  );

  const perCluster = CLUSTER_MS / PACKET_MS;
  const clusters: { atMs: number; bytes: Uint8Array }[] = [];
  for (let first = 0; first < packets.length; first += perCluster) {
    const atMs = first * PACKET_MS;
    const blocks = packets.slice(first, first + perCluster).map((packet, index) => simpleBlock(packet, index * PACKET_MS));
    clusters.push({ atMs, bytes: element(0x1f43b675, concat([uint(0xe7, atMs), ...blocks])) });
  }

  // The Cues go before the Clusters, so a player finds them without a
  // SeekHead. Each says where its Cluster starts, counted from the start of
  // the Segment's body. Their numbers are written eight bytes long, so their
  // size is known before the places they point at are.
  const cuePoint = (atMs: number, position: number) => element(0xbb, concat([uint(0xb3, atMs, 8), element(0xb7, concat([uint(0xf7, 1), uint(0xf1, position, 8)]))]));
  const cuesSize = element(0x1c53bb6b, concat(clusters.map(() => cuePoint(0, 0)))).length;
  let position = info.length + tracks.length + cuesSize;
  const points: Uint8Array[] = [];
  for (const cluster of clusters) {
    points.push(cuePoint(cluster.atMs, position));
    position += cluster.bytes.length;
  }
  const cues = element(0x1c53bb6b, concat(points));

  const segment = element(0x18538067, concat([info, tracks, cues, ...clusters.map((cluster) => cluster.bytes)]));
  return concat([header, segment]);
}

/**
 * The recorder's answer (`clip_stop`, src-tauri/src/clip.rs): the encoder's
 * lookahead as two bytes, then each packet as its length in two bytes and
 * its bytes, all little-endian. Null for anything that isn't that shape.
 */
export function readClip(bytes: Uint8Array): { preSkip: number; packets: Uint8Array[] } | null {
  if (bytes.length < 2) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const preSkip = view.getUint16(0, true);
  const packets: Uint8Array[] = [];
  let at = 2;
  while (at < bytes.length) {
    if (at + 2 > bytes.length) return null;
    const length = view.getUint16(at, true);
    at += 2;
    if (at + length > bytes.length) return null;
    packets.push(bytes.slice(at, at + length));
    at += length;
  }
  return { preSkip, packets };
}
