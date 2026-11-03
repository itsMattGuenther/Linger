// What the Android app's release build must keep for Rust and Kotlin to find
// each other by name (#834). The release build shrinks the app's Kotlin
// (R8): it renames or removes what nothing in Kotlin seems to use, and a
// method only Rust calls, or one Rust answers, looks unused to it. 0.5.4
// shipped without VoiceCallService.update, which Rust calls to show the call
// bar, so the call bar never showed in a release build.
//
// Each crossing is listed here, with a keep rule in
// client/src-tauri/gen/android/app/proguard-rules.pro. The tests check every
// class Rust names, and every `external fun` in Linger's own Kotlin, is
// listed and has a rule; desktop.yml builds a release app and runs this on
// it, so a rule that doesn't hold fails there too. Tauri's and wry's own
// crossings (their generated Kotlin and proguard-tauri.pro) are theirs.
//
// Usage: node scripts/android-jni.mjs <app.apk>
//   Needs `unzip`, and `dexdump` from the Android SDK's build-tools (found
//   under ANDROID_HOME or ANDROID_SDK_ROOT, or named by DEXDUMP).
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROGUARD = "client/src-tauri/gen/android/app/proguard-rules.pro";

/** Every name that crosses between Rust and Linger's own Kotlin. */
export const CROSSINGS = [
  {
    // Rust calls it (phone_call.rs): the call bar while in voice (#429).
    class: "io.github.itsmattguenther.linger.VoiceCallService",
    method: "update",
    type: "(Landroid/content/Context;Ljava/lang/String;ZZ)V",
    from: "client/src-tauri/src/phone_call.rs",
  },
  {
    // Kotlin calls it, and Rust answers by its name: an `external fun`, the
    // Android Keystore that keeps sign-ins (secrets.rs, T-1604).
    class: "io.crates.keyring.Keyring$Companion",
    method: "initializeNdkContext",
    type: "(Landroid/content/Context;)V",
    from: "client/src-tauri/gen/android/app/src/main/java/io/crates/keyring/Keyring.kt",
  },
];

/**
 * The methods in `dexdump` output, as class name → "name type" for each.
 * Output with no class in it, or a method with no type, fails rather than
 * reading as an app that has nothing.
 */
export function dexMethods(text) {
  const classes = new Map();
  let current = null;
  let inMethods = false;
  let name = null;
  text.split("\n").forEach((line, i) => {
    const descriptor = /^\s*Class descriptor\s*:\s*'L([^;']+);'/.exec(line);
    if (descriptor) {
      current = descriptor[1].replaceAll("/", ".");
      classes.set(current, classes.get(current) ?? new Set());
      inMethods = false;
      name = null;
      return;
    }
    const section = /^\s{2}(Static fields|Instance fields|Direct methods|Virtual methods)\s/.exec(line);
    if (section) {
      if (name) throw new Error(`dexdump, line ${i + 1}: the method ${name} has no type`);
      inMethods = section[1].endsWith("methods");
      return;
    }
    if (!current || !inMethods) return;
    const named = /^\s+name\s*:\s*'([^']*)'/.exec(line);
    if (named) {
      if (name) throw new Error(`dexdump, line ${i + 1}: the method ${name} has no type`);
      name = named[1];
      return;
    }
    const typed = /^\s+type\s*:\s*'([^']*)'/.exec(line);
    if (typed && name) {
      classes.get(current).add(`${name} ${typed[1]}`);
      name = null;
    }
  });
  if (name) throw new Error(`dexdump: the method ${name} has no type`);
  if (!classes.size) throw new Error("dexdump: no class in it; is this dexdump's output?");
  return classes;
}

/** Each crossing the app's code doesn't have, by its class, name and type. */
export function missing(classes, crossings = CROSSINGS) {
  return crossings.filter(({ class: name, method, type }) => !classes.get(name)?.has(`${method} ${type}`));
}

/** The class names Rust code names in its strings, as Java's dotted names. */
export function rustNamedClasses(text) {
  const found = new Set();
  for (const match of text.matchAll(/"(io[./](?:github[./]itsmattguenther[./]linger|crates)[./][\w$./]+)"/g))
    found.add(match[1].replaceAll("/", "."));
  return found;
}

/** The classes `-keep class <name> { ... }` rules keep, whole or in part. */
export function keptClasses(text) {
  const found = new Set();
  text.split("\n").forEach((line, i) => {
    const rule = /^\s*-keep\S*\s+(?:class|interface)\s+([\w.$]+)\s*\{.*\}\s*$/.exec(line);
    if (rule) found.add(rule[1]);
    else if (/^\s*-keep/.test(line)) throw new Error(`${PROGUARD}:${i + 1}: can't read ${JSON.stringify(line.trim())}`);
  });
  return found;
}

/** dexdump, from DEXDUMP, or the newest build-tools under the SDK. */
function dexdump() {
  if (process.env.DEXDUMP) return process.env.DEXDUMP;
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  const tools = sdk && join(sdk, "build-tools");
  const newest = tools && existsSync(tools)
    ? readdirSync(tools).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1)
    : null;
  if (!newest) throw new Error("no dexdump: set ANDROID_HOME, or DEXDUMP");
  return join(tools, newest, "dexdump");
}

function run([apk]) {
  if (!apk) throw new Error("usage: node scripts/android-jni.mjs <app.apk>");
  const work = mkdtempSync(join(tmpdir(), "android-jni-"));
  try {
    execFileSync("unzip", ["-q", "-o", apk, "classes*.dex", "-d", work]);
    const dexes = readdirSync(work).filter((name) => /^classes\d*\.dex$/.test(name)).sort();
    if (!dexes.length) throw new Error(`${apk}: no classes.dex in it`);
    const text = dexes.map((dex) => execFileSync(dexdump(), [join(work, dex)], { encoding: "utf8", maxBuffer: 1 << 30 })).join("\n");
    const gone = missing(dexMethods(text));
    if (gone.length) {
      for (const each of gone) console.error(`${apk}: the release build dropped ${each.class}.${each.method} ${each.type}, which ${each.from} needs`);
      process.exit(1);
    }
    console.log(`${apk} keeps all ${CROSSINGS.length} names Rust and Kotlin cross by.`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run(process.argv.slice(2));
