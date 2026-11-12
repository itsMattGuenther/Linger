// What the Android release build must keep for Rust and Kotlin to find each
// other by name (#834): read from dexdump's real output (0.5.4's release
// APK, which dropped VoiceCallService.update), every crossing in the repo
// listed with a keep rule, and the script run on an app with stand-ins for
// unzip and dexdump.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CROSSINGS, PROGUARD, dexMethods, keptClasses, missing, rustNamedClasses } from "./android-jni.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./android-jni.mjs", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");
/** The four classes the crossings are in, cut from 0.5.4's release APK (`dexdump classes*.dex`). */
const RELEASED = read("scripts/fixtures/dexdump-0.5.4.txt");
/**
 * The same, with `update` where a release build that kept it has it, and the
 * crossings added since 0.5.4 (PushBridge, #830): a build that kept
 * everything Rust calls today.
 */
const KEPT = RELEASED.replace(
  /(Class descriptor\s*: 'Lio\/github\/itsmattguenther\/linger\/VoiceCallService;'[\s\S]*?Direct methods\s*-\n)/,
  "$1    #9              : (in Lio/github/itsmattguenther/linger/VoiceCallService;)\n      name          : 'update'\n      type          : '(Landroid/content/Context;Ljava/lang/String;ZZ)V'\n      access        : 0x0019 (PUBLIC STATIC FINAL)\n",
) + `Class #9            -
  Class descriptor  : 'Lio/github/itsmattguenther/linger/PushBridge;'
  Direct methods    -
    #0              : (in Lio/github/itsmattguenther/linger/PushBridge;)
      name          : 'answer'
      type          : '(Landroid/content/Context;Ljava/lang/String;)Ljava/lang/String;'
      access        : 0x0019 (PUBLIC STATIC FINAL)
  Virtual methods   -
`;
/** What Rust crossed by when 0.5.4 was built: the call bar only. */
const AT_054 = CROSSINGS.filter((each) => each.class === "io.github.itsmattguenther.linger.VoiceCallService");

test("0.5.4's release build dropped the call bar's update, and kept the Keystore's", () => {
  const classes = dexMethods(RELEASED);
  assert.deepEqual([...classes.keys()].sort(), [
    "io.crates.keyring.Keyring", "io.crates.keyring.Keyring$Companion",
    "io.github.itsmattguenther.linger.VoiceCallService", "io.github.itsmattguenther.linger.VoiceCallService$Companion",
  ]);
  assert(classes.get("io.crates.keyring.Keyring$Companion").has("initializeNdkContext (Landroid/content/Context;)V"));
  assert(classes.get("io.github.itsmattguenther.linger.VoiceCallService").has("onStartCommand (Landroid/content/Intent;II)I"));
  assert(![...classes.get("io.github.itsmattguenther.linger.VoiceCallService")].some((method) => method.startsWith("d ")),
    "a field (d) isn't read as a method");
  assert.deepEqual(missing(classes, AT_054).map((each) => each.method), ["update"]);
});

test("a build that keeps update is missing nothing", () => {
  assert.deepEqual(missing(dexMethods(KEPT)), []);
});

test("update with another type, or in another class, isn't the one Rust calls", () => {
  assert.deepEqual(missing(dexMethods(KEPT.replace("(Landroid/content/Context;Ljava/lang/String;ZZ)V", "(Landroid/content/Context;)V"))).map((each) => each.method), ["update"]);
  assert.deepEqual(missing(dexMethods(KEPT.replace("Class descriptor  : 'Lio/github/itsmattguenther/linger/VoiceCallService;'", "Class descriptor  : 'La/b;'"))).map((each) => each.method), ["update"]);
});

test("what it can't read as dexdump's output fails, rather than reading as nothing kept", () => {
  assert.throws(() => dexMethods(""), /no class in it/);
  assert.throws(() => dexMethods("PK\u0003\u0004 not text"), /no class in it/);
  assert.throws(() => dexMethods("  Class descriptor  : 'La/B;'\n  Direct methods    -\n      name          : 'x'\n  Virtual methods   -\n"), /the method x has no type/);
});

test("every class Rust names is a crossing, with a keep rule", () => {
  const rust = readdirSync(join(ROOT, "client/src-tauri/src"), { recursive: true })
    .filter((path) => path.endsWith(".rs"))
    .map((path) => read(join("client/src-tauri/src", path)))
    .join("\n");
  const named = rustNamedClasses(rust);
  assert(named.has("io.github.itsmattguenther.linger.VoiceCallService"), "phone_call.rs names the call bar's class");
  const crossing = new Set(CROSSINGS.map((each) => each.class.replace(/\$Companion$/, "")));
  assert.deepEqual([...named].filter((name) => !crossing.has(name.replace(/\$Companion$/, ""))), [], "add these to CROSSINGS in scripts/android-jni.mjs");
  const kept = keptClasses(read(PROGUARD));
  assert.deepEqual(CROSSINGS.filter((each) => !kept.has(each.class) || !kept.has(each.class.replace(/\$Companion$/, ""))).map((each) => each.class), [],
    `a keep rule in ${PROGUARD} for the class and its outer class`);
});

test("every external fun in Linger's own Kotlin is a crossing", () => {
  const kotlin = execFileSync("git", ["ls-files", "client/src-tauri/gen/android/app/src/main/java"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter((path) => path.endsWith(".kt"));
  const external = kotlin.flatMap((path) => [...read(path).matchAll(/\bexternal\s+fun\s+(\w+)/g)].map((match) => `${path} ${match[1]}`));
  assert(kotlin.length > 0, "Linger's own Kotlin, to read");
  assert.deepEqual(external.filter((each) => !CROSSINGS.some((crossing) => each === `${crossing.from} ${crossing.method}`)), [],
    "add these to CROSSINGS in scripts/android-jni.mjs, with a keep rule");
});

// From Tauri 2.12 (#850) tao sets up the Android context Rust uses (ndk_context)
// as the app opens. MainActivity also set it up, for the Keystore, and
// ndk-context answers a second setup by panicking, so the app aborted the
// moment it opened. Nothing but tao may set it up.
test("nothing but tao sets up Rust's Android context", () => {
  const tracked = execFileSync("git", ["ls-files", "client/src-tauri/gen/android/app/src/main/java", "client/src-tauri/src"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter((path) => /\.(kt|java|rs)$/.test(path));
  assert(tracked.some((path) => path.endsWith("MainActivity.kt")), "MainActivity, to read");
  const setting = tracked.filter((path) => /initializeNdkContext|initialize_android_context/.test(read(path)));
  assert.deepEqual(setting, [], "tao sets up ndk_context in WryActivity's onCreate; a second setup aborts the app");
});

test("only a rule that keeps a class whole counts, and one it can't read fails, naming the line", () => {
  assert.deepEqual([...keptClasses("# a note\n-keep class a.B { *; }\n-keep interface a.I { *; }\n-keepattributes SourceFile\n")], ["a.B", "a.I"]);
  // #846's review: these let the class or its members be renamed, and a
  // name Rust and Kotlin cross by needs both kept.
  for (const weaker of ["-keepclassmembers class a.C { *; }", "-keepnames class a.C", "-keep,allowobfuscation class a.C { *; }",
    "-keep,allowshrinking,allowobfuscation class a.C { *; }", "-keepclasseswithmembers class a.C { native <methods>; }", "-keep class a.C { public void f(); }"]) {
    let kept;
    try { kept = keptClasses(`${weaker}\n`); } catch { kept = null; }
    assert(!kept || !kept.has("a.C"), `${weaker} doesn't keep a.C whole`);
  }
  assert.throws(() => keptClasses("-keep class a.B\n"), /:1: can't read "-keep class a\.B"/);
  assert.throws(() => keptClasses("-keepattributes SourceFile\n-keep,allowobfuscation class a.B {\n *;\n}\n"), /:2: can't read/);
});

test("rust names are found dotted and slashed, and nothing else is", () => {
  assert.deepEqual([...rustNamedClasses(`
    env.new_string("io.github.itsmattguenther.linger.VoiceCallService")
    env.find_class("io/crates/keyring/Keyring")
    const APP_GROUP: &str = "group.io.github.itsmattguenther.linger";
    "android/os/VibrationEffect"
  `)], ["io.github.itsmattguenther.linger.VoiceCallService", "io.crates.keyring.Keyring"]);
});

// The script on an app: stand-ins for unzip (it writes two classes.dex files)
// and dexdump (it prints a fixture for each), on PATH and in DEXDUMP.
function standIns(t, dump) {
  const dir = mkdtempSync(join(tmpdir(), "android-jni-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(dir, "tmp"));
  writeFileSync(join(dir, "dump.txt"), dump);
  writeFileSync(join(dir, "bin/unzip"), `#!/bin/sh
out=""; while [ $# -gt 0 ]; do [ "$1" = -d ] && out="$2"; shift; done
mkdir -p "$out" && echo a > "$out/classes.dex" && echo b > "$out/classes2.dex"
`);
  writeFileSync(join(dir, "bin/dexdump"), `#!/bin/sh
case "$1" in */classes.dex) cat "${join(dir, "dump.txt")}";; *) echo "Class #1 -"; echo "  Class descriptor  : 'La/Other;'";; esac
`);
  for (const name of ["unzip", "dexdump"]) chmodSync(join(dir, "bin", name), 0o755);
  writeFileSync(join(dir, "app.apk"), "PK");
  const run = () => spawnSync("node", [SCRIPT, join(dir, "app.apk")], {
    encoding: "utf8", env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, DEXDUMP: join(dir, "bin/dexdump"), TMPDIR: join(dir, "tmp") },
  });
  run.leftBehind = () => readdirSync(join(dir, "tmp"));
  return run;
}

test("run: a release app that dropped update fails, naming it and who needs it, and leaves nothing behind", (t) => {
  const run = standIns(t, RELEASED);
  const out = run();
  assert.equal(out.status, 1, out.stdout);
  // #846's review: process.exit skipped the cleanup on a failure.
  assert.deepEqual(run.leftBehind(), []);
  assert.match(out.stderr, /dropped io\.github\.itsmattguenther\.linger\.VoiceCallService\.update \(Landroid\/content\/Context;Ljava\/lang\/String;ZZ\)V, which client\/src-tauri\/src\/phone_call\.rs needs/);
});

test("run: one that kept everything passes, reading every classes.dex", (t) => {
  const run = standIns(t, KEPT);
  const out = run();
  assert.equal(out.status, 0, out.stderr);
  assert.deepEqual(run.leftBehind(), []);
  assert.match(out.stdout, new RegExp(`keeps all ${CROSSINGS.length} names Rust and Kotlin cross by`));
});

// The table repeats the method each crossing's file names; if that file moved
// to another method, the release check would still look for the old one.
test("each crossing's own file names its method, and Rust's its type too", () => {
  for (const crossing of CROSSINGS) {
    const text = read(crossing.from);
    if (crossing.from.endsWith(".rs")) {
      assert(text.includes(`"${crossing.method}"`), `${crossing.from} calls ${crossing.method}`);
      assert(text.includes(`"${crossing.type}"`), `${crossing.from} calls it with ${crossing.type}`);
    } else {
      assert.match(text, new RegExp(`\\bexternal\\s+fun\\s+${crossing.method}\\b`), `${crossing.from} declares ${crossing.method}`);
    }
  }
});
