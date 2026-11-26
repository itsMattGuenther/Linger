// The app icon's looks (#961) are listed in seven places that number or name
// them: a look crosses from the page to Rust by name and from Rust to the
// phone by its place in the list, so one list out of order would put the
// wrong icon on somebody's home screen. Each is checked against
// scripts/app-icon-looks.mjs here.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { LOOKS } from "./app-icon-looks.mjs";
import { alike, compare, png, PNG_SIGNATURE } from "./app-icons-png.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const strings = (text) => [...text.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
/** The quoted strings between `start` and the `end` after it. */
function listIn(path, start, end) {
  const text = read(path);
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `${path} has no ${start}`);
  return strings(text.slice(from + start.length, text.indexOf(end, from + start.length)));
}

test("the door is first, and every look has its own names", () => {
  assert.equal(LOOKS[0].id, "door");
  assert.equal(LOOKS[0].ios, "AppIcon");
  assert.equal(LOOKS[0].android, "ic_launcher");
  for (const key of ["id", "name", "ios", "android", "alias"]) {
    assert.equal(new Set(LOOKS.map((look) => look[key])).size, LOOKS.length, `${key} repeats`);
  }
});

test("Rust takes the same names, in the same order", () => {
  assert.deepEqual(listIn("client/src-tauri/src/phone_icon.rs", "const LOOKS: [&str; 6] = [", "];"), LOOKS.map((look) => look.id));
});

test("the iPhone's Swift numbers the same icon sets", () => {
  assert.deepEqual(listIn("client/src-tauri/gen/apple/linger-client_iOS/AppIcon.swift", "static let sets = [", "]"), LOOKS.map((look) => look.ios));
});

test("Android's Kotlin numbers the same launcher entries", () => {
  const text = read("client/src-tauri/gen/android/app/src/main/java/io/github/itsmattguenther/linger/AppIcon.kt");
  const from = text.indexOf("val ENTRIES = listOf(");
  assert.deepEqual(strings(text.slice(from, text.indexOf(")", from))), LOOKS.map((look) => look.alias));
});

test("the manifest has an entry per look, with its icon, and only the door's first on", () => {
  const manifest = read("client/src-tauri/gen/android/app/src/main/AndroidManifest.xml");
  const entries = [...manifest.matchAll(/<activity-alias([\s\S]*?)<\/activity-alias>/g)].map((match) => match[1]);
  // And the door's second entry, last: the way back to it once its first is off.
  assert.equal(entries.length, LOOKS.length + 1);
  const again = entries.at(-1);
  assert.match(again, /android:name="\.IconDoorAgain"/);
  assert.match(again, /android:icon="@mipmap\/ic_launcher"/);
  assert.match(again, /android:enabled="false"/);
  LOOKS.forEach((look, at) => {
    const entry = entries[at];
    assert.match(entry, new RegExp(`android:name="\\.${look.alias}"`));
    assert.match(entry, /android:targetActivity="\.MainActivity"/);
    assert.match(entry, new RegExp(`android:icon="@mipmap/${look.android}"`));
    assert.match(entry, new RegExp(`android:enabled="${at === 0}"`));
    assert.match(entry, /android\.intent\.category\.LAUNCHER/);
  });
  // The launcher opens the app through an entry; MainActivity itself isn't one.
  const main = manifest.slice(manifest.indexOf('android:name=".MainActivity"'), manifest.indexOf("</activity>"));
  assert.doesNotMatch(main, /android\.intent\.category\.LAUNCHER"/);
});

test("each look's Android icon is in layers, with the door's one-color layer for themed icons", () => {
  for (const look of LOOKS) {
    const xml = read(`client/src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26/${look.android}.xml`);
    assert.match(xml, new RegExp(`@mipmap/${look.android}_foreground`));
    assert.match(xml, new RegExp(`@mipmap/${look.android}_background`));
    assert.match(xml, /<monochrome android:drawable="@mipmap\/ic_launcher_monochrome"\/>/);
  }
});

test("the iPhone project carries every look but the door as an alternate icon", () => {
  const alternates = LOOKS.slice(1).map((look) => look.ios).join(" ");
  const project = read("client/src-tauri/gen/apple/linger-client.xcodeproj/project.pbxproj");
  const settings = [...project.matchAll(/ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = "([^"]*)";/g)].map((match) => match[1]);
  assert.deepEqual(settings, [alternates, alternates], "the debug and release builds both");
  assert.match(read("client/src-tauri/gen/apple/project.yml"), new RegExp(`ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES: ${alternates}\\n`));
  for (const look of LOOKS) {
    const set = JSON.parse(read(`client/src-tauri/gen/apple/Assets.xcassets/${look.ios}.appiconset/Contents.json`));
    assert.equal(set.images[0].filename, `${look.ios}.png`);
  }
  // The app's own icon has the looks iOS asks for: Dark and Tinted.
  const own = JSON.parse(read("client/src-tauri/gen/apple/Assets.xcassets/AppIcon.appiconset/Contents.json"));
  assert.deepEqual(
    own.images.map((image) => image.appearances?.[0]?.value ?? "any"),
    ["any", "dark", "tinted"],
  );
});

test("the page offers the same looks, by the same names, with a picture each", () => {
  const page = read("client/src/next/core/appIcon.ts");
  const offered = [...page.matchAll(/\{ id: "([^"]+)", name: "([^"]+)" \}/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(offered, LOOKS.map((look) => [look.id, look.name]));
  for (const look of LOOKS) assert.ok(existsSync(join(ROOT, `client/src/next/app/settings/app-icons/${look.id}.png`)), look.id);
});

test("the icon check allows another machine's two steps, and no more (#961)", () => {
  const picture = (values, extra = {}) => ({ width: 2, height: 1, channels: 3, keyed: false, pixels: Buffer.from(values), ...extra });
  const committed = picture([10, 20, 30, 40, 50, 60]);
  assert.equal(compare(picture([10, 20, 30, 40, 50, 60]), committed).same, true);
  assert.equal(compare(picture([12, 18, 30, 41, 50, 60]), committed).same, true, "two steps is another machine");
  const three = compare(picture([13, 20, 30, 40, 50, 60]), committed);
  assert.equal(three.same, false, "three steps is a change");
  assert.match(three.how, /1 of 6 values differ, by up to 3/);
  assert.equal(compare(picture([11, 20, 30, 40, 50, 60]), committed, 0).same, false, "making them is exact");
  const keyed = compare(picture([10, 20, 30, 40, 50, 60], { keyed: true }), committed);
  assert.equal(keyed.same, false);
  assert.match(keyed.how, /committed 2x1, 3 channels, made 2x1, 3 channels, keyed transparency/);
  assert.equal(compare(picture([10, 20, 30, 40, 50, 60, 70, 80], { channels: 4 }), committed).same, false);
});

test("a committed PNG the check can't read isn't the same, and doesn't stop it (#961)", () => {
  const folder = mkdtempSync(join(tmpdir(), "linger-icon-test-"));
  try {
    const made = join(folder, "made.png");
    const committed = join(folder, "committed.png");
    writeFileSync(made, png(1, 1, 3, Buffer.from([1, 2, 3])));
    // A palette PNG, as an optimizer might save one: color type 3.
    const palette = Buffer.from(png(1, 1, 3, Buffer.from([1, 2, 3])));
    palette[PNG_SIGNATURE.length + 8 + 9] = 3;
    writeFileSync(committed, palette);
    const there = alike(made, committed);
    assert.equal(there.same, false);
    assert.notEqual(there.how, "");
    writeFileSync(committed, png(1, 1, 3, Buffer.from([2, 3, 4])));
    assert.equal(alike(made, committed).same, true);
    assert.equal(alike(made, committed, 0).same, false);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
