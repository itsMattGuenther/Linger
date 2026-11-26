// Reading, writing and comparing the app icons' PNGs, for scripts/app-icons.mjs
// (#961) and its test, which can load this without making every icon.
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

export const PNG_SIGNATURE = Buffer.from("\x89PNG\r\n\x1a\n", "latin1");

/** An 8-bit, non-interlaced RGB or RGBA PNG's pixels, rows end to end. */
export function readPng(path) {
  const data = readFileSync(path);
  if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${path} isn't a PNG`);
  let width = 0;
  let height = 0;
  let channels = 0;
  // A tRNS chunk makes some of an RGB picture's pixels see-through.
  let keyed = false;
  const compressed = [];
  for (let offset = 8; offset < data.length; ) {
    const size = data.readUInt32BE(offset);
    const type = data.toString("latin1", offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + size);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      channels = { 2: 3, 6: 4 }[body[9]] ?? 0;
      if (body[8] !== 8 || channels === 0 || body[12] !== 0) throw new Error(`${path} isn't 8-bit, non-interlaced RGB or RGBA`);
    } else if (type === "IDAT") {
      compressed.push(body);
    } else if (type === "tRNS") {
      keyed = true;
    }
    offset += 12 + size;
  }
  const filtered = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (stride + 1)];
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const line = filtered.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const above = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? row[i - channels] : 0;
      const up = above[i];
      const upLeft = i >= channels ? above[i - channels] : 0;
      let predicted = 0;
      if (filter === 1) predicted = left;
      else if (filter === 2) predicted = up;
      else if (filter === 3) predicted = (left + up) >> 1;
      else if (filter === 4) {
        const guess = left + up - upLeft;
        const [toLeft, toUp, toUpLeft] = [Math.abs(guess - left), Math.abs(guess - up), Math.abs(guess - upLeft)];
        predicted = toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
      } else if (filter !== 0) throw new Error(`${path} has an unknown row filter ${filter}`);
      row[i] = (line[i] + predicted) & 0xff;
    }
  }
  return { width, height, channels, pixels, keyed };
}

/** Pixels laid over `background`, as RGB with no alpha channel. */
export function overBackground({ width, height, channels, pixels }, background) {
  const under = [1, 3, 5].map((at) => parseInt(background.slice(at, at + 2), 16));
  const rgb = Buffer.alloc(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const alpha = channels === 4 ? pixels[pixel * 4 + 3] : 255;
    for (let c = 0; c < 3; c++) {
      rgb[pixel * 3 + c] = Math.round((pixels[pixel * channels + c] * alpha + under[c] * (255 - alpha)) / 255);
    }
  }
  return rgb;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A PNG of these pixels: RGB (3 channels) or RGBA (4). */
export function png(width, height, channels, pixels) {
  const stride = width * channels;
  const filtered = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) pixels.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const chunk = (type, body) => {
    const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
    const out = Buffer.alloc(8 + body.length + 4);
    out.writeUInt32BE(body.length, 0);
    typed.copy(out, 4);
    out.writeUInt32BE(crc32(typed), 8 + body.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(filtered, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** A file as it should compare: what differs between two good builds is left out. */
export function comparable(path) {
  const data = readFileSync(path);
  // A Windows checkout may turn text files' line endings into CRLF.
  if ([".xml", ".json"].includes(extname(path))) return [Buffer.from(data.toString("latin1").replaceAll("\r\n", "\n"), "latin1")];
  if (extname(path) !== ".icns") return [data];
  // The ICNS writer iterates a map; chunk order is not stable or meaningful.
  if (data.toString("latin1", 0, 4) !== "icns" || data.readUInt32BE(4) !== data.length) throw new Error(`${path} isn't an ICNS file`);
  const chunks = [];
  for (let offset = 8; offset < data.length; ) {
    const size = data.readUInt32BE(offset + 4);
    if (size < 8 || offset + size > data.length) throw new Error(`${path} has a broken chunk at ${offset}`);
    chunks.push(data.subarray(offset, offset + size));
    offset += size;
  }
  return chunks.sort(Buffer.compare);
}

export function same(a, b) {
  const left = comparable(a);
  const right = comparable(b);
  return left.length === right.length && left.every((chunk, i) => chunk.equals(right[i]));
}

/**
 * How far apart another machine's Tauri CLI draws the vector artwork: its
 * edges come out a step or two apart, and zlib packs the same picture
 * differently. `--check` allows this much; making the icons doesn't.
 */
export const SLACK = 2;

/**
 * Whether the picture `mine` matches `theirs`, the committed one: the same
 * shape, and each value within `slack` of the other's. Says how they differ,
 * for the error.
 */
export function compare(mine, theirs, slack = SLACK) {
  const shape = (picture) => `${picture.width}x${picture.height}, ${picture.channels} channels${picture.keyed ? ", keyed transparency" : ""}`;
  if (mine.width !== theirs.width || mine.height !== theirs.height || mine.channels !== theirs.channels || Boolean(mine.keyed) !== Boolean(theirs.keyed)) {
    return { same: false, how: ` (committed ${shape(theirs)}, made ${shape(mine)})` };
  }
  let off = 0;
  let most = 0;
  for (let i = 0; i < mine.pixels.length; i++) {
    const by = Math.abs(mine.pixels[i] - theirs.pixels[i]);
    if (by > 0) off++;
    if (by > most) most = by;
  }
  return { same: most <= slack, how: ` (${off} of ${mine.pixels.length} values differ, by up to ${most})` };
}

/**
 * Whether the file the CLI `made` matches the `committed` one: a PNG by its
 * pixels (`compare`), anything else byte for byte. A committed PNG this
 * can't read (palette, grayscale, interlaced) isn't the same.
 */
export function alike(made, committed, slack = SLACK) {
  if (extname(made) !== ".png") return { same: same(made, committed), how: "" };
  try {
    return compare(readPng(made), readPng(committed), slack);
  } catch (error) {
    return { same: false, how: ` (${error instanceof Error ? error.message : error})` };
  }
}
