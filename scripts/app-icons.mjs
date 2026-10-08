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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "assets/logo/Linger Pixel Porch Icon Set FINAL.png");
const ICONS = join(ROOT, "client/src-tauri/icons");
const DESKTOP_ICONS = ["32x32.png", "128x128.png", "128x128@2x.png", "icon.png", "icon.ico", "icon.icns"];
// The phone app's launcher icons (SPEC §4.15), into the Android project. An
// Android icon is the artwork over a background the phone cuts to its own
// shape; the background is the window's color (--night-2, styles/tokens.css),
// not Tauri's white, so the dark porch doesn't sit in a white disc.
const ANDROID_RES = join(ROOT, "client/src-tauri/gen/android/app/src/main/res");
const ANDROID_BACKGROUND = "#131a28";
const ANDROID_ICONS = [
  ...["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"].flatMap((density) =>
    ["ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"].map((name) => `mipmap-${density}/${name}`),
  ),
  "mipmap-anydpi-v26/ic_launcher.xml",
  "values/ic_launcher_background.xml",
];

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
  writeFileSync(manifest, `{"default": "porch.svg", "bg_color": "${ANDROID_BACKGROUND}"}\n`);
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
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
if (!process.exitCode) {
  console.log(`${values.check ? "Verified" : "Updated"} ${DESKTOP_ICONS.length} desktop and ${ANDROID_ICONS.length} Android icons from Linger Pixel Porch Icon Set FINAL.png.`);
}
