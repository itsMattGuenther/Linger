import { describe, expect, it } from "vitest";
import { opusWebm, PACKET_MS, readClip } from "./webm";

/** An element as read back: its ID, where its body starts and how long it is. */
interface Read {
  id: number;
  start: number;
  size: number;
}

/** Read the elements laid end to end in `bytes[from, to)`, as a Matroska reader would. */
function elements(bytes: Uint8Array, from = 0, to = bytes.length): Read[] {
  const out: Read[] = [];
  let at = from;
  while (at < to) {
    const [id, idLength] = vint(bytes, at, true);
    at += idLength;
    const [size, sizeLength] = vint(bytes, at, false);
    at += sizeLength;
    out.push({ id, start: at, size });
    at += size;
  }
  expect(at, "the elements end where their parent does").toBe(to);
  return out;
}

/** A variable-length integer: an ID keeps its marker bit, a size doesn't. */
function vint(bytes: Uint8Array, at: number, keepMarker: boolean): [number, number] {
  const first = bytes[at] ?? 0;
  let length = 1;
  while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) length += 1;
  let value = keepMarker ? first : first & (0xff >> length);
  for (let n = 1; n < length; n += 1) value = value * 256 + (bytes[at + n] ?? 0);
  return [value, length];
}

function child(bytes: Uint8Array, parent: Read, id: number): Read {
  const found = elements(bytes, parent.start, parent.start + parent.size).find((one) => one.id === id);
  if (!found) throw new Error(`no element ${id.toString(16)}`);
  return found;
}

function uintOf(bytes: Uint8Array, element: Read): number {
  let value = 0;
  for (let n = 0; n < element.size; n += 1) value = value * 256 + (bytes[element.start + n] ?? 0);
  return value;
}

function textOf(bytes: Uint8Array, element: Read): string {
  return new TextDecoder().decode(bytes.slice(element.start, element.start + element.size));
}

/** Packets that are just their own number, so each can be found where it's meant to be. */
function packets(count: number): Uint8Array[] {
  return Array.from({ length: count }, (_, n) => Uint8Array.from([n % 256, Math.floor(n / 256), 0xaa]));
}

describe("a voice message's WebM file (#401)", () => {
  it("says it's WebM, and holds one Segment", () => {
    const file = opusWebm(packets(3), 312);
    const top = elements(file);
    expect(top.map((one) => one.id)).toEqual([0x1a45dfa3, 0x18538067]);
    const [header] = top;
    if (!header) throw new Error("no header");
    expect(textOf(file, child(file, header, 0x4282))).toBe("webm");
  });

  // The server knows a WebM file by its first 256 bytes holding the doc type
  // with a one-byte size, and only in a file longer than that (`infer`).
  it("is a WebM file to the server's sniffer, once it holds half a second", () => {
    const file = opusWebm(packets(25), 312);
    const head = Array.from(file.slice(0, 256));
    const docType = [0x42, 0x82, 0x84, ...new TextEncoder().encode("webm")];
    expect(head.some((_, at) => docType.every((byte, n) => head[at + n] === byte))).toBe(true);
    expect(file.length).toBeGreaterThan(256);
  });

  it("gives its length, and one Opus track that's mono at 48 kHz with Opus's own header", () => {
    const file = opusWebm(packets(150), 312);
    const segment = elements(file)[1];
    if (!segment) throw new Error("no segment");
    const info = child(file, segment, 0x1549a966);
    expect(uintOf(file, child(file, info, 0x2ad7b1))).toBe(1_000_000);
    const duration = child(file, info, 0x4489);
    expect(new DataView(file.buffer, duration.start, 8).getFloat64(0)).toBe(150 * PACKET_MS);

    const track = child(file, child(file, segment, 0x1654ae6b), 0xae);
    expect(textOf(file, child(file, track, 0x86))).toBe("A_OPUS");
    expect(uintOf(file, child(file, track, 0x83))).toBe(2);
    const head = child(file, track, 0x63a2);
    const opus = new DataView(file.buffer, head.start, head.size);
    expect(textOf(file, { ...head, size: 8 })).toBe("OpusHead");
    expect([opus.getUint8(9), opus.getUint16(10, true), opus.getUint32(12, true)]).toEqual([1, 312, 48_000]);
    // The lookahead again, as Matroska says it: in nanoseconds.
    expect(uintOf(file, child(file, track, 0x56aa))).toBe(6_500_000);
  });

  it("puts every packet in order in clusters of five seconds, each timed from its cluster's start, and Cues that point at each cluster", () => {
    const count = 600; // 12 s: clusters at 0, 5 and 10 s
    const file = opusWebm(packets(count), 312);
    const segment = elements(file)[1];
    if (!segment) throw new Error("no segment");
    const inSegment = elements(file, segment.start, segment.start + segment.size);
    const clusters = inSegment.filter((one) => one.id === 0x1f43b675);
    expect(clusters).toHaveLength(3);

    let seen = 0;
    for (const cluster of clusters) {
      const parts = elements(file, cluster.start, cluster.start + cluster.size);
      const startMs = uintOf(file, parts[0] ?? cluster);
      expect(startMs).toBe(seen * PACKET_MS);
      for (const block of parts.slice(1)) {
        expect(block.id).toBe(0xa3);
        const view = new DataView(file.buffer, block.start, block.size);
        expect(view.getUint8(0)).toBe(0x81);
        expect(startMs + view.getInt16(1)).toBe(seen * PACKET_MS);
        expect(view.getUint8(3)).toBe(0x80);
        expect([view.getUint8(4), view.getUint8(5)]).toEqual([seen % 256, Math.floor(seen / 256)]);
        seen += 1;
      }
    }
    expect(seen).toBe(count);

    const cues = elements(file, ...span(inSegment.find((one) => one.id === 0x1c53bb6b)));
    expect(cues.map((point) => uintOf(file, child(file, point, 0xb3)))).toEqual([0, 5_000, 10_000]);
    const positions = cues.map((point) => uintOf(file, child(file, child(file, point, 0xb7), 0xf1)));
    // Counted from the start of the Segment's body, each lands on its cluster's ID.
    for (const [n, position] of positions.entries()) {
      const cluster = clusters[n];
      if (!cluster) throw new Error("no cluster");
      expect(Array.from(file.slice(segment.start + position, segment.start + position + 4))).toEqual([0x1f, 0x43, 0xb6, 0x75]);
      expect(segment.start + position).toBeLessThan(cluster.start);
    }
  });

  it("makes five minutes of voice into a file of the size it should be", () => {
    const fiveMinutes = Array.from({ length: 15_000 }, () => new Uint8Array(80));
    const file = opusWebm(fiveMinutes, 312);
    expect(file.length).toBeGreaterThan(15_000 * 80);
    expect(file.length).toBeLessThan(15_000 * 90);
  });
});

describe("the recorder's answer", () => {
  it("reads the lookahead and each packet", () => {
    const bytes = Uint8Array.from([0x38, 0x01, 2, 0, 9, 8, 1, 0, 7]);
    expect(readClip(bytes)).toEqual({ preSkip: 312, packets: [Uint8Array.from([9, 8]), Uint8Array.from([7])] });
    expect(readClip(Uint8Array.from([0x38, 0x01]))).toEqual({ preSkip: 312, packets: [] });
  });

  it("refuses anything cut short", () => {
    expect(readClip(new Uint8Array())).toBeNull();
    expect(readClip(Uint8Array.from([0x38, 0x01, 3, 0, 9, 8]))).toBeNull();
    expect(readClip(Uint8Array.from([0x38, 0x01, 3]))).toBeNull();
  });
});

function span(element: Read | undefined): [number, number] {
  if (!element) throw new Error("not there");
  return [element.start, element.start + element.size];
}
