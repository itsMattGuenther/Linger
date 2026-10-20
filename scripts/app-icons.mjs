#!/usr/bin/env node
// Package the approved porch artwork using the project's pinned Tauri CLI.
//
// The source is slightly rectangular. An SVG container adds transparent padding
// at integer pixel coordinates, preserving the original PNG without cropping or
// stretching it. Tauri handles platform formats and size conversion.
//
// Usage: node scripts/app-icons.mjs [--check]
//   --check verifies the committed icons without changing them.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { deflateSync, inflateSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "assets/logo/Linger Pixel Porch Icon Set FINAL.png");
const ICONS = join(ROOT, "client/src-tauri/icons");
const DESKTOP_ICONS = ["32x32.png", "128x128.png", "128x128@2x.png", "icon.png", "icon.ico", "icon.icns"];
// The phone app's launcher icons (SPEC §4.15), into the Android project. An
// Android icon is the artwork over a background the phone cuts to its own
// shape; the background is the window's color (--night-2, styles/tokens.css),
// not Tauri's white, so the dark porch doesn't sit in a white disc. The
// iPhone's icons sit on the same background.
const ANDROID_RES = join(ROOT, "client/src-tauri/gen/android/app/src/main/res");
const PHONE_BACKGROUND = "#131a28";
const ANDROID_ICONS = [
  ...["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"].flatMap((density) =>
    ["ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"].map((name) => `mipmap-${density}/${name}`),
  ),
  "mipmap-anydpi-v26/ic_launcher.xml",
  "values/ic_launcher_background.xml",
];
// The iPhone's, into its Xcode project. The App Store refuses an icon with an
// alpha channel, even one with nothing see-through in it, and Tauri writes
// them with one, so each is laid over the background and written without.
const IOS_ICONS_DIR = join(ROOT, "client/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset");
const IOS_ICONS = [
  ...["20x20", "29x29", "40x40"].flatMap((size) => ["@1x", "@2x", "@2x-1", "@3x"].map((scale) => `AppIcon-${size}${scale}.png`)),
  "AppIcon-60x60@2x.png",
  "AppIcon-60x60@3x.png",
  "AppIcon-76x76@1x.png",
  "AppIcon-76x76@2x.png",
  "AppIcon-83.5x83.5@2x.png",
  "AppIcon-512@2x.png",
];

const PNG_SIGNATURE = Buffer.from("\x89PNG\r\n\x1a\n", "latin1");

/** An 8-bit, non-interlaced RGB or RGBA PNG's pixels, rows end to end. */
function readPng(path) {
  const data = readFileSync(path);
  if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`${path} isn't a PNG`);
  let width = 0;
  let height = 0;
  let channels = 0;
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
    }
    offset += 12 + size;
  }
  const filtered = inflateSync(Buffer.concat(compressed));
  const stride = width * channels;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (stride + 1)];
    const line = filtered.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = pixels.subarray(y * stride, (y + 1) * stride);
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
  return { width, height, channels, pixels };
}

/** Pixels laid over `background`, as RGB with no alpha channel. */
function overBackground({ width, height, channels, pixels }, background) {
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

/** An RGB PNG of these pixels. */
function rgbPng(width, height, rgb) {
  const stride = width * 3;
  const filtered = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) rgb.copy(filtered, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
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
  header[9] = 2;
  return Buffer.concat([PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(filtered, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** A file as it should compare: what differs between two good builds is left out. */
function comparable(path) {
  const data = readFileSync(path);
  // A Windows checkout may turn the Android XML's line endings into CRLF.
  if (extname(path) === ".xml") return [Buffer.from(data.toString("latin1").replaceAll("\r\n", "\n"), "latin1")];
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

function same(a, b) {
  const left = comparable(a);
  const right = comparable(b);
  return left.length === right.length && left.every((chunk, i) => chunk.equals(right[i]));
}

const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });
const data = readFileSync(SOURCE);
if (!data.subarray(0, 8).equals(Buffer.from("\x89PNG\r\n\x1a\n", "latin1")) || data.toString("latin1", 12, 16) !== "IHDR") {
  console.error("The approved artwork must be a PNG.");
  process.exit(1);
}
const width = data.readUInt32BE(16);
const height = data.readUInt32BE(20);
const side = Math.max(width, height);
const x = Math.floor((side - width) / 2);
const y = Math.floor((side - height) / 2);

const work = mkdtempSync(join(tmpdir(), "linger-icons-"));
try {
  writeFileSync(
    join(work, "porch.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
      `xmlns:xlink="http://www.w3.org/1999/xlink" ` +
      `width="${side}" height="${side}" viewBox="0 0 ${side} ${side}">` +
      `<image x="${x}" y="${y}" width="${width}" height="${height}" ` +
      `xlink:href="data:image/png;base64,${data.toString("base64")}"/></svg>\n`,
  );
  const manifest = join(work, "icon.json");
  writeFileSync(manifest, `{"default": "porch.svg", "bg_color": "${PHONE_BACKGROUND}"}\n`);
  const output = join(work, "icons");
  execFileSync(process.execPath, [join(ROOT, "client/node_modules/@tauri-apps/cli/tauri.js"), "icon", manifest, "--output", output], {
    cwd: join(ROOT, "client"),
    stdio: "inherit",
  });
  // Mobile and store-specific assets are not part of the desktop bundle.
  for (const name of DESKTOP_ICONS) {
    if (!values.check) copyFileSync(join(output, name), join(ICONS, name));
    else if (!same(join(output, name), join(ICONS, name))) throw new Error(`Icon differs from the approved artwork: ${name}`);
  }
  for (const name of ANDROID_ICONS) {
    if (!values.check) {
      mkdirSync(dirname(join(ANDROID_RES, name)), { recursive: true });
      copyFileSync(join(output, "android", name), join(ANDROID_RES, name));
    } else if (!same(join(output, "android", name), join(ANDROID_RES, name))) {
      throw new Error(`Android icon differs from the approved artwork: ${name}`);
    }
  }
  // Compared by their pixels: zlib versions may pack the same picture
  // differently.
  for (const name of IOS_ICONS) {
    const made = readPng(join(output, "ios", name));
    const flat = overBackground(made, PHONE_BACKGROUND);
    if (!values.check) {
      writeFileSync(join(IOS_ICONS_DIR, name), rgbPng(made.width, made.height, flat));
      continue;
    }
    const committed = readPng(join(IOS_ICONS_DIR, name));
    if (committed.channels !== 3) throw new Error(`iPhone icon has an alpha channel, which the App Store refuses: ${name}`);
    if (committed.width !== made.width || !committed.pixels.equals(flat)) throw new Error(`iPhone icon differs from the approved artwork: ${name}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (!process.exitCode) {
  console.log(
    `${values.check ? "Verified" : "Updated"} ${DESKTOP_ICONS.length} desktop, ${ANDROID_ICONS.length} Android and ${IOS_ICONS.length} iPhone icons from Linger Pixel Porch Icon Set FINAL.png.`,
  );
}
