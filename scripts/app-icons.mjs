#!/usr/bin/env node
// Every app icon, made from the door with its light on (#961) by the
// project's pinned Tauri CLI, which handles each platform's formats and sizes.
//
// - The computer apps (Windows, Linux, macOS): the door on its night ground,
//   in a rounded square.
// - Android: a launcher icon per look in scripts/app-icon-looks.mjs, each in
//   layers (a ground, the door, and the one-color door Android paints in the
//   wallpaper's colors when themed icons are on), and a flat one for Android
//   7, which has no layers. The manifest turns one look's entry on.
// - The iPhone: an icon set per look, the first with the Dark and Tinted
//   versions iOS shows when the person picks those for their Home Screen.
// - The page: a small picture of each look for the picker in Settings.
//
// "The original" is the pixel porch the app had before (#691): the round
// artwork on Android, the square one on the iPhone and in the picker.
//
// Usage: node scripts/app-icons.mjs [--check]
//   --check verifies the committed icons without changing them.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { deflateSync, inflateSync } from "node:zlib";

import { LOOKS } from "./app-icon-looks.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORCH = join(ROOT, "assets/logo/Linger Pixel Porch Icon Set FINAL.png");
const PORCH_SQUARE = join(ROOT, "assets/logo/Linger Pixel Porch Icon Square.png");
const TAURI = join(ROOT, "client/node_modules/@tauri-apps/cli/tauri.js");
const ICONS = join(ROOT, "client/src-tauri/icons");
const DESKTOP_ICONS = ["32x32.png", "128x128.png", "128x128@2x.png", "icon.png", "icon.ico", "icon.icns"];
const ANDROID_RES = join(ROOT, "client/src-tauri/gen/android/app/src/main/res");
const DENSITIES = ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"];
const IOS_ASSETS = join(ROOT, "client/src-tauri/gen/apple/Assets.xcassets");
const PREVIEWS = join(ROOT, "client/src/next/app/settings/app-icons");
// What the porch icons left behind: the iPhone's icon in every size (Xcode
// makes them from one now) and Android's ground as a color (a layer now).
const LEFT_OVER = [
  ...["20x20", "29x29", "40x40"].flatMap((size) => ["@1x", "@2x", "@2x-1", "@3x"].map((scale) => `AppIcon-${size}${scale}.png`)),
  "AppIcon-60x60@2x.png",
  "AppIcon-60x60@3x.png",
  "AppIcon-76x76@1x.png",
  "AppIcon-76x76@2x.png",
  "AppIcon-83.5x83.5@2x.png",
  "AppIcon-512@2x.png",
].map((name) => join(IOS_ASSETS, "AppIcon.appiconset", name)).concat([join(ANDROID_RES, "values/ic_launcher_background.xml")]);

// The artwork. The door is assets/logo/linger-door.svg, drawn in a 24-unit
// box; `box` is that box's height on a 1024 canvas, centered.
const NIGHT = "#131a28";
const COLOR = { outline: "#2ec5f2", fill: "#2a3550", window: "#ffc674", knob: "#f3b55c", step: "#f3b55c" };
const line = (c) => ({ outline: c, fill: "none", window: c, knob: c, step: c });
const ART = {
  door: { ground: "night", glow: 0.3, door: COLOR },
  "after-dark": { ground: "#08090c", glow: 0.21, door: COLOR },
  "porch-light": { ground: "#0b0b0d", door: line("#f3b55c") },
  daylight: { ground: "#dbe2f5", door: line("#2b3a67") },
  dusk: { ground: "#2b3a67", door: line("#dbe2f5") },
  original: { ground: NIGHT, porch: true },
};
// On a phone's own icon the door fills a little over half; Android shows
// only the middle two-thirds of its layers, so its door is drawn smaller.
const FULL_BOX = 573.4;
const LAYER_BOX = 341;

// The door's four shapes, read from the logo so the icons can't drift from it.
const LOGO = readFileSync(join(ROOT, "assets/logo/linger-door.svg"), "utf8");
const [FRAME, GLASS] = [...LOGO.matchAll(/<path d="([^"]+)"/g)].map((match) => match[1]);
const FRAME_STROKE = LOGO.match(/stroke-width="([^"]+)"/)?.[1];
const KNOB = LOGO.match(/<circle cx="([^"]+)" cy="([^"]+)" r="([^"]+)"/);
const STEP = LOGO.match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)" rx="([^"]+)"/);
if (!FRAME || !GLASS || !FRAME_STROKE || !KNOB || !STEP) throw new Error("assets/logo/linger-door.svg isn't the door's four shapes");

function door(c, box) {
  const s = box / 24;
  const x = 512 - 12 * s;
  const y = 512 - 0.515 * box;
  return (
    `<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) scale(${s.toFixed(4)})">` +
    `<path d="${FRAME}" fill="${c.fill}" stroke="${c.outline}" stroke-width="${FRAME_STROKE}" stroke-linejoin="round"/>` +
    `<path d="${GLASS}" fill="${c.window}"/>` +
    `<circle cx="${KNOB[1]}" cy="${KNOB[2]}" r="${KNOB[3]}" fill="${c.knob}"/>` +
    `<rect x="${STEP[1]}" y="${STEP[2]}" width="${STEP[3]}" height="${STEP[4]}" rx="${STEP[5]}" fill="${c.step}"/></g>`
  );
}

/** The window's glow behind the door, at `strength`. */
function glow(strength) {
  return (
    `<defs><radialGradient id="glow" cx="512" cy="460.8" r="430" gradientUnits="userSpaceOnUse">` +
    `<stop offset="0" stop-color="#ffc674" stop-opacity="${strength}"/><stop offset="1" stop-color="#ffc674" stop-opacity="0"/>` +
    `</radialGradient></defs><rect width="1024" height="1024" fill="url(#glow)"/>`
  );
}

function ground(art) {
  const base =
    art.ground === "night"
      ? `<defs><linearGradient id="night" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1a2440"/><stop offset="1" stop-color="#0a101d"/></linearGradient></defs><rect width="1024" height="1024" fill="url(#night)"/>`
      : `<rect width="1024" height="1024" fill="${art.ground}"/>`;
  return base + (art.glow ? glow(art.glow) : "");
}

const svg = (inner) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${inner}</svg>\n`;

/** A PNG inside an SVG the size of its longer side: padded to a square, never stretched. */
function wrapped(path) {
  const data = readFileSync(path);
  if (!data.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error(`The artwork must be a PNG: ${path}`);
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  const side = Math.max(width, height);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${side}" height="${side}" viewBox="0 0 ${side} ${side}">` +
    `<image x="${Math.floor((side - width) / 2)}" y="${Math.floor((side - height) / 2)}" width="${width}" height="${height}" ` +
    `xlink:href="data:image/png;base64,${data.toString("base64")}"/></svg>\n`
  );
}

/** Each look's pictures: the whole icon, and Android's ground and door layers. */
function artwork(look) {
  const art = ART[look.id];
  if (art.porch) return { full: wrapped(PORCH_SQUARE), flat: wrapped(PORCH), ground: svg(ground(art)), layer: wrapped(PORCH) };
  return { full: svg(ground(art) + door(art.door, FULL_BOX)), flat: null, ground: svg(ground(art)), layer: svg(door(art.door, LAYER_BOX)) };
}
// Android's themed icon, for every look: the one-color door, painted by Android.
const MONOCHROME = svg(door(line("#ffffff"), LAYER_BOX));
// The iPhone's Dark version has no ground, so the system's dark one shows
// through, and the Tinted one is gray, which iOS colors.
const IPHONE_DARK = svg(glow(0.18) + door(COLOR, FULL_BOX));
const IPHONE_TINTED = svg(door(line("#ffffff"), FULL_BOX));
const DESKTOP = svg(
  `<defs><clipPath id="tile"><rect x="32" y="32" width="960" height="960" rx="200"/></clipPath></defs>` +
    `<g clip-path="url(#tile)">${ground(ART.door)}</g>${door(COLOR, FULL_BOX * 0.94)}`,
);

const PNG_SIGNATURE = Buffer.from("\x89PNG\r\n\x1a\n", "latin1");

/** An 8-bit, non-interlaced RGB or RGBA PNG's pixels, rows end to end. */
function readPng(path) {
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

/** A PNG of these pixels: RGB (3 channels) or RGBA (4). */
function png(width, height, channels, pixels) {
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
function comparable(path) {
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

function same(a, b) {
  const left = comparable(a);
  const right = comparable(b);
  return left.length === right.length && left.every((chunk, i) => chunk.equals(right[i]));
}

const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });
const work = mkdtempSync(join(tmpdir(), "linger-icons-"));
let made = 0;

/**
 * Runs the Tauri CLI on `pictures` (file name → SVG) in a folder of its own,
 * with `input` the manifest or picture to start from, and returns where it
 * wrote.
 */
function tauri(name, pictures, input, args = []) {
  const folder = join(work, name);
  mkdirSync(folder, { recursive: true });
  for (const [file, text] of Object.entries(pictures)) writeFileSync(join(folder, file), text);
  const output = join(folder, "out");
  execFileSync(process.execPath, [TAURI, "icon", join(folder, input), "--output", output, ...args], { cwd: join(ROOT, "client"), stdio: "inherit" });
  return output;
}

/** Copies a file the CLI made over the committed one, or checks they match. */
function keep(from, to, what) {
  made++;
  if (values.check) {
    if (!existsSync(to) || !same(from, to)) throw new Error(`${what} differs from the approved artwork: ${to.slice(ROOT.length + 1)}`);
  } else if (!existsSync(to) || !same(from, to)) {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

/** Writes text the script made, or checks the committed copy matches. */
function keepText(text, to, what) {
  const from = join(work, `text-${made}`);
  writeFileSync(from, text);
  keep(from, to, what);
}

/**
 * Writes a picture by its pixels, RGB when it has nothing see-through and
 * `opaque` asks for it (the App Store refuses an app icon with an alpha
 * channel), or checks the committed one has the same pixels: zlib versions
 * may pack the same picture differently.
 */
function keepPixels(from, to, what, { opaque, ground = NIGHT } = {}) {
  made++;
  const picture = readPng(from);
  const channels = opaque ? 3 : picture.channels;
  const pixels = opaque ? overBackground(picture, ground) : picture.pixels;
  if (!values.check) {
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, png(picture.width, picture.height, channels, pixels));
    return;
  }
  if (!existsSync(to)) throw new Error(`${what} is missing: ${to.slice(ROOT.length + 1)}`);
  const committed = readPng(to);
  if (opaque && committed.channels !== 3) throw new Error(`${what} has an alpha channel, which the App Store refuses: ${to.slice(ROOT.length + 1)}`);
  if (committed.width !== picture.width || committed.channels !== channels || !committed.pixels.equals(pixels)) {
    throw new Error(`${what} differs from the approved artwork: ${to.slice(ROOT.length + 1)}`);
  }
}

/** An asset catalog icon set: one 1024 picture, and the Dark and Tinted ones when it has them. */
function iconSet(name, variants) {
  const images = [{ filename: `${name}.png`, idiom: "universal", platform: "ios", size: "1024x1024" }];
  for (const variant of variants) {
    images.push({
      appearances: [{ appearance: "luminosity", value: variant.toLowerCase() }],
      filename: `${name}-${variant}.png`,
      idiom: "universal",
      platform: "ios",
      size: "1024x1024",
    });
  }
  return `${JSON.stringify({ images, info: { author: "xcode", version: 1 } }, null, 2)}\n`;
}

try {
  // The porch's square version has to be a square with nothing see-through
  // in it: padded or see-through, the iPhone would show a ground around it
  // (#691).
  const square = readPng(PORCH_SQUARE);
  const opaque = !square.keyed && (square.channels === 3 || square.pixels.every((value, i) => i % 4 !== 3 || value === 255));
  if (square.width !== square.height || !opaque) throw new Error(`The porch's square artwork must be square and opaque: ${PORCH_SQUARE}`);

  // The computer apps.
  const desktop = tauri("desktop", { "icon.svg": DESKTOP }, "icon.svg");
  for (const name of DESKTOP_ICONS) keep(join(desktop, name), join(ICONS, name), "Desktop icon");

  for (const look of LOOKS) {
    const art = artwork(look);
    const under = ART[look.id].ground === "night" ? NIGHT : ART[look.id].ground;
    const res = look.android;
    // Android's layers. The CLI names them `ic_launcher_*`, renamed for the
    // other looks; every look uses the door's one-color layer.
    const manifest = { default: "full.svg", bg_color: under, android_bg: "ground.svg", android_fg: "layer.svg", android_fg_scale: 100, android_monochrome: "mono.svg" };
    const layers = tauri(
      `${look.id}-layers`,
      { "full.svg": art.full, "ground.svg": art.ground, "layer.svg": art.layer, "mono.svg": MONOCHROME, "icon.json": JSON.stringify(manifest) },
      "icon.json",
    );
    // Android 7's flat icons, from the whole icon: made from the layers, the
    // CLI blows the door up past their edges.
    const flat = tauri(`${look.id}-flat`, { "flat.svg": art.flat ?? art.full, "icon.json": JSON.stringify({ default: "flat.svg", bg_color: under }) }, "icon.json");
    for (const density of DENSITIES) {
      const from = (output, name) => join(output, "android", `mipmap-${density}`, name);
      const to = (name) => join(ANDROID_RES, `mipmap-${density}`, name);
      keep(from(layers, "ic_launcher_background.png"), to(`${res}_background.png`), "Android icon");
      keep(from(layers, "ic_launcher_foreground.png"), to(`${res}_foreground.png`), "Android icon");
      keep(from(flat, "ic_launcher.png"), to(`${res}.png`), "Android icon");
      if (look.id === "door") {
        keep(from(layers, "ic_launcher_monochrome.png"), to("ic_launcher_monochrome.png"), "Android icon");
        keep(from(flat, "ic_launcher_round.png"), to("ic_launcher_round.png"), "Android icon");
      }
    }
    const xml = readFileSync(join(layers, "android/mipmap-anydpi-v26/ic_launcher.xml"), "utf8")
      .replace("@mipmap/ic_launcher_foreground", `@mipmap/${res}_foreground`)
      .replace("@mipmap/ic_launcher_background", `@mipmap/${res}_background`);
    keepText(xml, join(ANDROID_RES, "mipmap-anydpi-v26", `${res}.xml`), "Android icon");

    // The iPhone's icon set, and the picker's picture.
    const sizes = tauri(`${look.id}-sizes`, { "full.svg": art.full }, "full.svg", ["--png", "1024", "--png", "144"]);
    const set = join(IOS_ASSETS, `${look.ios}.appiconset`);
    keepPixels(join(sizes, "1024x1024.png"), join(set, `${look.ios}.png`), "iPhone icon", { opaque: true, ground: under });
    keepPixels(join(sizes, "144x144.png"), join(PREVIEWS, `${look.id}.png`), "Picker picture", { opaque: true, ground: under });
    keepText(iconSet(look.ios, look.id === "door" ? ["Dark", "Tinted"] : []), join(set, "Contents.json"), "iPhone icon set");
  }

  // The door's Dark and Tinted versions keep what's see-through.
  const dark = tauri("iphone-dark", { "dark.svg": IPHONE_DARK }, "dark.svg", ["--png", "1024"]);
  keepPixels(join(dark, "1024x1024.png"), join(IOS_ASSETS, "AppIcon.appiconset", "AppIcon-Dark.png"), "iPhone icon");
  const tinted = tauri("iphone-tinted", { "tinted.svg": IPHONE_TINTED }, "tinted.svg", ["--png", "1024"]);
  keepPixels(join(tinted, "1024x1024.png"), join(IOS_ASSETS, "AppIcon.appiconset", "AppIcon-Tinted.png"), "iPhone icon");

  for (const path of LEFT_OVER) {
    if (!existsSync(path)) continue;
    if (values.check) throw new Error(`Left over from the porch icons: ${path.slice(ROOT.length + 1)}`);
    rmSync(path);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (!process.exitCode) {
  console.log(`${values.check ? "Verified" : "Updated"} ${made} icon files for ${LOOKS.length} looks, from the door (scripts/app-icon-looks.mjs).`);
}
