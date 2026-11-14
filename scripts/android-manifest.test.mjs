// Every permission Linger's own Kotlin asks Android for is in the app's
// manifest (#842). Asked for without being declared, Android answers "no"
// at once, shows nothing, and the feature quietly never works: Android 17's
// local network permission, asked so a server at home can be reached, was
// one line away from that.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = "client/src-tauri/gen/android/app/src/main/AndroidManifest.xml";

const read = (path) => readFileSync(join(ROOT, path), "utf8");

/**
 * The permissions a manifest declares, by their short names: `uses-permission`
 * and its `-sdk-23` form, the name anywhere among the attributes. A
 * commented-out one isn't declared.
 */
export function declared(manifest) {
  const names = new Set();
  for (const match of manifest.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<uses-permission(?:-sdk-23)?\b[^>]*?\bandroid:name\s*=\s*"android\.permission\.(\w+)"/g)) {
    names.add(match[1]);
  }
  return names;
}

/**
 * The permissions Kotlin checks or asks for, as `Manifest.permission.NAME`
 * or written out as `"android.permission.NAME"`.
 */
export function used(kotlin) {
  const named = [...kotlin.matchAll(/\bManifest\.permission\.(\w+)/g), ...kotlin.matchAll(/"android\.permission\.(\w+)"/g)];
  return new Set(named.map((match) => match[1]));
}

test("a commented-out permission isn't declared, and each way of writing one is read", () => {
  assert.deepEqual([...declared(`
    <uses-permission android:name="android.permission.INTERNET" />
    <!-- <uses-permission android:name="android.permission.CAMERA" /> -->
    <!--
      <uses-permission android:name="android.permission.READ_CONTACTS" />
    -->
    <uses-permission
        android:name="android.permission.ACCESS_LOCAL_NETWORK" />
    <uses-permission android:maxSdkVersion="32" android:name = "android.permission.READ_EXTERNAL_STORAGE" />
    <uses-permission-sdk-23 android:name="android.permission.CAMERA" />
    <uses-permission android:name="com.example.permission.OTHER" />
  `)], ["INTERNET", "ACCESS_LOCAL_NETWORK", "READ_EXTERNAL_STORAGE", "CAMERA"]);
  assert.deepEqual([...used(`
    checkSelfPermission(c, Manifest.permission.RECORD_AUDIO)
    arrayOf(android.Manifest.permission.POST_NOTIFICATIONS)
    requestPermissions(arrayOf("android.permission.CAMERA"), 1)
  `)], ["RECORD_AUDIO", "POST_NOTIFICATIONS", "CAMERA"]);
});

test("every permission Linger's Kotlin asks for is in the manifest", () => {
  const kotlin = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "client/src-tauri/gen/android/app/src/main/java"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter((path) => path.endsWith(".kt"));
  assert(kotlin.length > 0, "Linger's own Kotlin, to read");
  const inManifest = declared(read(MANIFEST));
  assert(inManifest.has("INTERNET"), `${MANIFEST}, read as declaring INTERNET`);
  const missing = kotlin.flatMap((path) => [...used(read(path))].filter((name) => !inManifest.has(name)).map((name) => `${path}: ${name}`));
  assert.deepEqual(missing, [], `declare these in ${MANIFEST}`);
  // The ones this was written for, so a change in how Kotlin names them
  // can't leave it checking nothing.
  for (const name of ["ACCESS_LOCAL_NETWORK", "POST_NOTIFICATIONS", "RECORD_AUDIO"]) {
    assert(kotlin.some((path) => used(read(path)).has(name)), `Kotlin asks for ${name}`);
  }
});
