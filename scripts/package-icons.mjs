#!/usr/bin/env node
// Check packaged icons, not just the source assets. Uses only Node's own modules.
//
// Pass an extracted Linux package root or a Windows executable (app or installer).
// PE resources are inspected as data; this script never runs the supplied program.
//
// Usage: node scripts/package-icons.mjs [--pe FILE]... [--icon ICO] [--linux-root DIR]

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ICONS = join(ROOT, "client/src-tauri/icons");

function check(ok, message) {
  if (!ok) throw new Error(message);
}

/** Each image an ICO file holds, as bytes. */
function icoImages(data) {
  check(data.readUInt16LE(0) === 0 && data.readUInt16LE(2) === 1 && data.readUInt16LE(4) > 0, "Not an ICO file");
  return Array.from({ length: data.readUInt16LE(4) }, (_, index) => {
    const entry = 6 + index * 16 + 8;
    const size = data.readUInt32LE(entry);
    const offset = data.readUInt32LE(entry + 4);
    return data.subarray(offset, offset + size);
  });
}

/** Resolve the PE resource tree and return only RT_ICON image bytes. */
function peIcons(data) {
  check(data.toString("latin1", 0, 2) === "MZ", "Not a Windows executable");
  const pe = data.readUInt32LE(0x3c);
  check(data.toString("latin1", pe, pe + 4) === "PE\0\0", "Missing PE header");
  const count = data.readUInt16LE(pe + 6);
  const optionalSize = data.readUInt16LE(pe + 20);
  const optional = pe + 24;
  const magic = data.readUInt16LE(optional);
  check(magic === 0x10b || magic === 0x20b, "Unknown PE format");
  const directories = optional + (magic === 0x20b ? 112 : 96);
  const resourceRva = data.readUInt32LE(directories + 16);
  const sections = Array.from({ length: count }, (_, index) => {
    const at = optional + optionalSize + index * 40 + 8;
    return { virtualSize: data.readUInt32LE(at), address: data.readUInt32LE(at + 4), rawSize: data.readUInt32LE(at + 8), offset: data.readUInt32LE(at + 12) };
  });
  const locate = (rva) => {
    const section = sections.find((one) => one.address <= rva && rva < one.address + Math.max(one.virtualSize, one.rawSize));
    check(section, "Resource outside PE sections");
    return section.offset + rva - section.address;
  };
  const base = locate(resourceRva);
  const walk = (relative, depth = 0, resourceType = null) => {
    check(depth <= 3, "Unexpected resource tree depth");
    const directory = base + relative;
    const entries = data.readUInt16LE(directory + 12) + data.readUInt16LE(directory + 14);
    const found = [];
    for (let index = 0; index < entries; index++) {
      const name = data.readUInt32LE(directory + 16 + index * 8);
      const child = data.readUInt32LE(directory + 16 + index * 8 + 4);
      const kind = depth === 0 ? name : resourceType;
      if (kind !== 3) continue; // RT_ICON
      if (child & 0x80000000) {
        found.push(...walk(child & 0x7fffffff, depth + 1, kind));
      } else {
        const start = locate(data.readUInt32LE(base + child));
        found.push(data.subarray(start, start + data.readUInt32LE(base + child + 4)));
      }
    }
    return found;
  };
  return walk(0);
}

function checkPe(path, icon) {
  const actual = peIcons(readFileSync(path));
  const expected = icoImages(readFileSync(icon));
  check(actual.length > 0, `No icon resources: ${basename(path)}`);
  check(
    expected.every((image) => actual.some((one) => one.equals(image))),
    `Wrong or missing porch icon: ${basename(path)}`,
  );
  console.log(`PASS ${basename(path)}: all ${expected.length} approved ICO images embedded`);
}

/** A .desktop file's [Desktop Entry] keys and values. */
function desktopEntry(path) {
  const entry = new Map();
  let section = null;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (line.startsWith("[") && line.endsWith("]")) section = line.slice(1, -1);
    else if (section === "Desktop Entry" && line.includes("=")) {
      const at = line.indexOf("=");
      entry.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
    }
  }
  return entry;
}

function checkLinux(root) {
  let desktop = join(root, "usr/share/applications/Linger.desktop");
  if (!existsSync(desktop)) desktop = join(root, "usr/share/applications/linger-client.desktop");
  const entry = desktopEntry(desktop);
  check(entry.get("Name") === "Linger", "Launcher product name must be capitalized");
  check(entry.get("Exec") === "linger-client", "Launcher does not start the packaged binary");
  check(entry.get("Icon") === "linger-client", "Launcher icon identity changed");
  check(entry.get("StartupWMClass") === "linger-client", "X11 launcher identity changed");
  for (const [size, name] of [[32, "32x32.png"], [128, "128x128.png"], [256, "128x128@2x.png"]]) {
    let installed = join(root, `usr/share/icons/hicolor/${size}x${size}/apps/linger-client.png`);
    // Current Tauri names the @2x PNG's scale directory this way.
    if (size === 256 && !existsSync(installed)) installed = join(root, "usr/share/icons/hicolor/256x256@2/apps/linger-client.png");
    check(existsSync(installed) && readFileSync(installed).equals(readFileSync(join(ICONS, name))), `Wrong ${size}px Linux icon`);
  }
  const program = join(root, "usr/bin/linger-client");
  check(existsSync(program) && statSync(program).isFile(), "Packaged program missing");
  console.log("PASS Linux package: launcher identity and all three installed porch icons");
}

const { values } = parseArgs({
  options: {
    pe: { type: "string", multiple: true, default: [] },
    icon: { type: "string", default: join(ICONS, "icon.ico") },
    "linux-root": { type: "string" },
  },
});
if (values.pe.length === 0 && values["linux-root"] === undefined) {
  console.error("usage: node scripts/package-icons.mjs [--pe FILE]... [--icon ICO] [--linux-root DIR]\nsupply --pe or --linux-root");
  process.exit(2);
}
try {
  for (const path of values.pe) checkPe(path, values.icon);
  if (values["linux-root"] !== undefined) checkLinux(values["linux-root"]);
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
