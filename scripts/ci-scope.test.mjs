import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cfgReach, classify, localPaths, shellModules, shellReach, simulatorFlows } from "./ci-scope.mjs";

const active = (paths) => Object.entries(classify(paths)).filter(([, value]) => value).map(([key]) => key);
for (const paths of [["README.md"], ["docs/testing.md", "LICENSE"], ["docs/screenshots/example.png"]])
  test(`documentation only: ${paths}`, () => assert.deepEqual(active(paths), []));
// Unknown files run everything but the iPhone app in the simulator, which a
// pull request runs only for what that run builds, drives or runs, and a release.
for (const paths of [["unexpected.conf"], ["Cargo.lock"], [".github/workflows/ci.yml"], ["crates/linger-core/src/lib.rs"]])
  test(`conservative fallback: ${paths}`, () => assert.deepEqual(active(paths), ["rust", "s3", "web", "shell", "coturn", "packages", "ios", "relay"]));
test("nothing to compare (the nightly run, a run by hand) runs everything, the simulator too", () => assert.equal(active([]).length, 9));
test("UI changes test both browser and native packages and the iPhone app, not unrelated server jobs", () => {
  assert.deepEqual(active(["client/src/next/styles/app.css"]), ["web", "packages", "ios"]);
});
test("the push relay's own files run its checks and nothing else; the wire types run it too", () => {
  for (const path of ["push-relay/src/index.ts", "push-relay/test/relay.test.ts", "push-relay/wrangler.jsonc",
    "push-relay/package.json", "push-relay/pnpm-lock.yaml"])
    assert.deepEqual(active([path]), ["relay"], path);
  assert(active(["client/src/generated/RelaySend.ts"]).includes("relay"));
  assert(!active(["crates/linger-server/src/main.rs"]).includes("relay"));
});
test("browser assertions alone need no package rebuild", () => {
  assert.deepEqual(active(["client/tests/browser/console.spec.ts"]), ["web"]);
});
test("the iPhone flows and what they run on run only the iPhone check", () => {
  for (const path of ["client/tests/ios/set-up.yaml", "client/tests/ios/seed.js", "scripts/https-front.mjs",
    "scripts/share-window-ready.mjs", "scripts/test-certs.sh"])
    assert.deepEqual(active([path]), ["ios", "simulator"], path);
  // The front's own test runs by name in the rules job, on Linux: it can't change what an iPhone does.
  assert.deepEqual(active(["scripts/https-front.test.mjs"]), []);
});
test("the iPhone check runs for the app's page and shell, and for its own workflow", () => {
  for (const path of ["client/src/next/core/phone.ts", "client/src-tauri/gen/apple/project.yml", "client/package.json",
    ".github/workflows/ios-simulator.yml"])
    assert(active([path]).includes("ios"), path);
  assert(!active(["crates/linger-server/src/main.rs"]).includes("ios"));
});
test("the packaged audio and video checks' own files rebuild only the packages", () => {
  for (const path of ["scripts/linux-audio-check.py", "scripts/video-runtime-probe.js", "scripts/fixtures/tone-h264-aac.mp4",
    "scripts/appimage-ffmpeg.sh", "scripts/appimage-ffmpeg-check.sh", "scripts/appimage-fetch.sh", "scripts/appimage-fetch-test.sh"])
    assert.deepEqual(active([path]), ["packages"], path);
});
test("the startup measurement is run by hand, and only its own tests run for it", () => {
  assert.deepEqual(active(["scripts/startup-time.mjs", "scripts/startup-time.test.mjs"]), []);
  assert.equal(active(["scripts/startup-time.sh"]).length, 8);
});
test("the questions before a pull request and the catch count are run by hand, and only their own tests run for them", () => {
  assert.deepEqual(active(["scripts/pr-questions.mjs", "scripts/pr-questions.test.mjs",
    "scripts/review-catches.mjs", "scripts/review-catches.test.mjs"]), []);
  assert.equal(active(["scripts/pr-questions.sh"]).length, 8);
});
test("the review gate and its hook ship nothing, and start no job of their own (#930)", () => {
  assert.deepEqual(active(["scripts/review-gate.mjs", "scripts/review-gate.test.mjs", ".claude/settings.json"]), []);
  assert.equal(active([".claude/hooks/gate.sh"]).length, 8);
  assert.equal(active(["scripts/review-gate.sh"]).length, 8);
});
// A script's own test that starts no job still runs: by name, in CI's rules
// job and in check.sh, whatever ci-scope skips (#930).
test("every script's own test is run by name in CI and by check.sh (#930)", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const check = readFileSync(join(root, "scripts/check.sh"), "utf8");
  const tests = readdirSync(join(root, "scripts")).filter((name) => name.endsWith(".test.mjs")).map((name) => `scripts/${name}`);
  assert.ok(tests.length > 20, `only ${tests.length} found`);
  for (const file of tests) {
    assert.ok(ci.includes(file), `${file} isn't run in .github/workflows/ci.yml`);
    assert.ok(check.includes(file), `${file} isn't run by scripts/check.sh`);
  }
});
test("the Tauri version check and the iPhone flows' own test run only in the rules job (#835)", () => {
  assert.deepEqual(active(["scripts/tauri-versions.mjs", "scripts/tauri-versions.test.mjs", "scripts/ios-flows.test.mjs", "scripts/ios-plist.test.mjs",
    "scripts/upstream-fixes.mjs", "scripts/upstream-fixes.test.mjs",
    "scripts/android-jni.mjs", "scripts/android-jni.test.mjs", "scripts/fixtures/dexdump-0.5.4.txt", "scripts/android-manifest.test.mjs",
    "scripts/installed-packages.mjs", "scripts/installed-packages.test.mjs",
    "scripts/maestro-driver.test.mjs", "scripts/fixtures/maestro-driver-died.log",
    "scripts/browser-fakes.test.mjs"]), []);
  // The at-rest check and the driver's post-mortem are steps of the
  // simulator's run, so a change to them runs that too; their tests don't.
  assert.deepEqual(active(["scripts/app-at-rest.mjs"]), ["simulator"]);
  assert.deepEqual(active(["scripts/maestro-driver.mjs"]), ["simulator"]);
  assert.deepEqual(active(["client/tests/ios/link-open.yaml"]), ["ios", "simulator"]);
});
test("the bundler's retry and its test start the package check, which runs the test in Git Bash (#916)", () => {
  assert.deepEqual(active(["scripts/bundle-retry.sh"]), ["packages"]);
  assert.deepEqual(active(["scripts/bundle-retry-test.sh"]), ["packages"]);
  assert.equal(active(["scripts/bundle-retry-other.sh"]).length, 8);
});
test("actionlint's script and its test run only in the rules job (#874)", () => {
  assert.deepEqual(active(["scripts/actionlint.sh", "scripts/actionlint-test.sh"]), []);
  assert.equal(active(["scripts/actionlint-other.sh"]).length, 8);
});
test("the Windows hidden-window check runs for the shell, the list window and its own files (#594)", () => {
  for (const path of ["client/src-tauri/src/window.rs", "client/src/next/app/list/ListWindow.tsx",
    "client/scripts/windows-hidden-check.mjs", "client/scripts/windows-window.ps1"])
    assert(active([path]).includes("packages"), path);
});
test("server changes include real storage tests", () => {
  assert.deepEqual(active(["crates/linger-server/src/storage.rs"]), ["rust", "s3"]);
});
test("desktop changes test the separately built shell, packages and the iPhone app", () => {
  assert.deepEqual(active(["client/src-tauri/Cargo.lock"]), ["shell", "packages", "ios"]);
});
test("union retains every affected domain, including deletion side of a rename", () => {
  assert.deepEqual(active(["client/src/next/styles/app.css", "docs/old.css", "deploy/Dockerfile"]),
    ["rust", "s3", "web", "coturn", "packages", "ios"]);
});

// scripts/check.sh --local: a throwaway repository with a main and a branch.
function branchRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), "ci-scope-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: dir });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "a\n");
  writeFileSync(join(dir, "Cargo.toml"), "a\n");
  git("add", "."); git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "topic");
  return { dir, git };
}
test("local: a branch's commits, uncommitted edits and new files all count", (t) => {
  const { dir, git } = branchRepo(t);
  writeFileSync(join(dir, "README.md"), "b\n");
  git("commit", "-q", "-am", "docs");
  writeFileSync(join(dir, "Cargo.toml"), "b\n");
  writeFileSync(join(dir, "new.rs"), "b\n");
  assert.deepEqual(localPaths("main", dir).sort(), ["Cargo.toml", "README.md", "new.rs"]);
});
test("local: main moving on after the branch left it isn't the branch's change", (t) => {
  const { dir, git } = branchRepo(t);
  writeFileSync(join(dir, "docs.md"), "b\n");
  git("add", "."); git("commit", "-q", "-m", "docs");
  git("checkout", "-q", "main");
  writeFileSync(join(dir, "Cargo.toml"), "c\n");
  git("commit", "-q", "-am", "main moved");
  git("checkout", "-q", "topic");
  assert.deepEqual(localPaths("main", dir), ["docs.md"]);
});
test("local: the shell gets a count and one line per domain", (t) => {
  const { dir, git } = branchRepo(t);
  writeFileSync(join(dir, "README.md"), "b\n");
  git("commit", "-q", "-am", "docs");
  const script = fileURLToPath(new URL("./ci-scope.mjs", import.meta.url));
  const out = execFileSync("node", [script, "--local", "main"], { cwd: dir, encoding: "utf8" });
  assert.equal(out, "changed=1\nrust=false\ns3=false\nweb=false\nshell=false\ncoturn=false\npackages=false\nios=false\nsimulator=false\nrelay=false\n");
});
test("local: no base to compare with selects everything", (t) => {
  const { dir } = branchRepo(t);
  const script = fileURLToPath(new URL("./ci-scope.mjs", import.meta.url));
  const out = execFileSync("node", [script, "--local", "no-such-ref"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  assert.match(out, /^changed=0\nrust=true\n/);
  assert.equal(out.match(/=true/g).length, 9);
});

// --- only the checks a change can reach (#914) ---

/** A shell whose `lib.rs` and capability files are these, for `classify` to read. */
const LIB = `//! Tauri shell.

#[cfg(test)]
mod acl;
#[cfg(desktop)]
mod tray;
// Voice is the desktop's: a phone's is in its page.
#[cfg(desktop)]
pub mod voice;
#[cfg(target_os = "linux")]
pub mod desktop_entry;
pub mod gateway;
mod secrets;
#[cfg(any(target_os = "ios", test))]
mod phone_scene;
#[cfg(target_os = "ios")]
mod phone_keyboard;
#[cfg(any(mobile, test))]
mod share_window;
#[cfg(any(desktop, target_os = "ios"))]
mod both_named;
#[cfg(all(desktop, not(test)))]
mod not_read;
#[cfg(desktop)]
#[cfg(feature = "x")]
mod two_cfgs;
#[cfg(desktop)]
mod twice;
#[cfg(mobile)]
mod twice;
#[cfg(desktop)]
#[path = "elsewhere.rs"]
mod moved;
#[cfg(any(
    target_os = "ios",
    test
))]
mod over_lines;
#[cfg(desktop)]
// A comment between the two.
mod commented;
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {}
`;
const shell = (files = {}) => (path) => ({ "client/src-tauri/src/lib.rs": LIB, ...files })[path] ?? null;
const reached = (paths, options = {}) => Object.entries(classify(paths, { read: shell(), ...options })).filter(([, value]) => value).map(([key]) => key);

test("which app builds a module is read from its cfg", () => {
  assert.equal(cfgReach("desktop"), "desktop");
  assert.equal(cfgReach('target_os = "linux"'), "desktop");
  assert.equal(cfgReach('any(target_os = "windows", target_os = "macos")'), "desktop");
  assert.equal(cfgReach("mobile"), "phone");
  assert.equal(cfgReach('target_os = "ios"'), "phone");
  assert.equal(cfgReach('target_os = "android"'), "phone");
  // The phone's module, with tests that run on a computer.
  assert.equal(cfgReach("any(mobile, test)"), "phone");
  assert.equal(cfgReach('any(target_os = "ios", test)'), "phone");
  assert.equal(cfgReach("test"), "tests");
  // Both named, or anything this doesn't read: both's.
  assert.equal(cfgReach('any(desktop, target_os = "ios")'), "both");
  assert.equal(cfgReach("all(desktop, not(test))"), "both");
  assert.equal(cfgReach('feature = "x"'), "both");
  assert.equal(cfgReach("not(desktop)"), "both");
  assert.equal(cfgReach(""), "both");
});

test("the shell's modules are read from lib.rs, and what isn't plain is both's", () => {
  assert.deepEqual(shellModules(LIB), {
    acl: "tests", tray: "desktop", voice: "desktop", desktop_entry: "desktop", gateway: "both", secrets: "both",
    phone_scene: "phone", phone_keyboard: "phone", share_window: "phone", both_named: "both", not_read: "both", two_cfgs: "both",
    // Declared twice, kept in another file, a cfg over several lines, a comment in between: none is read as one app's.
    twice: "both", moved: "both", over_lines: "both", commented: "both",
  });
});

test("the real lib.rs sorts the way the app is built: voice is the desktop's, the scenes are the phone's", () => {
  const real = shellModules(readFileSync(fileURLToPath(new URL("../client/src-tauri/src/lib.rs", import.meta.url)), "utf8"));
  assert.equal(real.voice, "desktop");
  assert.equal(real.tray, "desktop");
  assert.equal(real.phone_scene, "phone");
  assert.equal(real.gateway, "both");
  assert.equal(real.secrets, "both");
  // Every module is one of the four, and each kind is there: a lib.rs written another way would be all "both".
  assert.deepEqual([...new Set(Object.values(real))].sort(), ["both", "desktop", "phone", "tests"]);
});

test("a file only the desktop app builds doesn't start the iPhone run", () => {
  for (const path of ["client/src-tauri/src/tray.rs", "client/src-tauri/src/voice/device.rs", "client/src-tauri/src/voice/cleanup.rs",
    "client/src-tauri/src/desktop_entry.rs", "client/src-tauri/linux/linger.desktop", "client/src-tauri/windows/installer.nsh"])
    assert.deepEqual(reached([path]), ["shell", "packages"], path);
  // A capability file for the desktop's windows.
  const desktop = shell({ "client/src-tauri/capabilities/owner.json": '{"platforms":["linux","macOS","windows"],"windows":["main"]}' });
  assert.deepEqual(reached(["client/src-tauri/capabilities/owner.json"], { read: desktop }), ["shell", "packages"]);
});

test("a file only the phone app builds doesn't start the desktop installers", () => {
  for (const path of ["client/src-tauri/src/phone_scene.rs", "client/src-tauri/src/phone_keyboard.rs", "client/src-tauri/src/share_window.rs",
    "client/src-tauri/gen/apple/project.yml", "client/src-tauri/gen/apple/NotificationService/PushNote.swift",
    "client/src-tauri/Info.ios.plist", "client/src-tauri/tauri.ios.conf.json"])
    assert.deepEqual(reached([path]), ["shell", "ios", "simulator"], path);
  const phone = shell({ "client/src-tauri/capabilities/phone.json": '{"platforms":["android","iOS"]}' });
  assert.deepEqual(reached(["client/src-tauri/capabilities/phone.json"], { read: phone }), ["shell", "ios", "simulator"]);
});

test("the shell's tests alone run only the shell's tests", () => {
  assert.deepEqual(reached(["client/src-tauri/src/acl.rs"]), ["shell"]);
});

test("a file both apps build, or one this can't place, starts both", () => {
  for (const path of ["client/src-tauri/src/lib.rs", "client/src-tauri/src/main.rs", "client/src-tauri/src/gateway.rs", "client/src-tauri/src/secrets.rs",
    "client/src-tauri/Cargo.toml", "client/src-tauri/Cargo.lock", "client/src-tauri/build.rs", "client/src-tauri/tauri.conf.json",
    "client/src-tauri/tests/csp.rs", "client/src-tauri/permissions/autogenerated/voice_join.toml",
    // Android's files aren't sorted by app yet.
    "client/src-tauri/gen/android/app/build.gradle.kts", "client/src-tauri/tauri.android.conf.json",
    // A module lib.rs doesn't declare, one with a cfg naming both, and ones whose cfg isn't read.
    "client/src-tauri/src/brand_new.rs", "client/src-tauri/src/both_named.rs", "client/src-tauri/src/not_read.rs", "client/src-tauri/src/two_cfgs.rs"])
    assert.deepEqual(reached([path]), ["shell", "packages", "ios"], path);
  // A capability file that names both, names nothing, or isn't JSON.
  for (const text of ['{"platforms":["linux","iOS"]}', '{"windows":["main"]}', '{"platforms":[]}', "not json", null]) {
    const read = shell({ "client/src-tauri/capabilities/x.json": text });
    assert.deepEqual(reached(["client/src-tauri/capabilities/x.json"], { read }), ["shell", "packages", "ios"], String(text));
  }
});

// A capability file says which app it's for inside itself, so a change can
// move it from one app to the other (#915's review). What it was counts as
// much as what it is.
test("a capability file moved from one app to the other starts both apps' checks", () => {
  const path = "client/src-tauri/capabilities/share.json";
  const DESKTOP = '{"platforms":["linux","macOS","windows"]}';
  const PHONE = '{"platforms":["android","iOS"]}';
  const moved = (was, now, options = {}) =>
    reached([path], { read: shell({ [path]: now }), before: (asked) => (asked === path ? was : undefined), ...options });
  // Off the phone: it takes something from the phone app, though it reads as the desktop's now.
  assert.deepEqual(moved(PHONE, DESKTOP), ["shell", "packages", "ios", "simulator"]);
  // And onto it.
  assert.deepEqual(moved(DESKTOP, PHONE), ["shell", "packages", "ios", "simulator"]);
  // Changed, and the same app's before and after: that app's checks alone.
  assert.deepEqual(moved(DESKTOP, '{"platforms":["linux","macOS","windows"],"permissions":["x"]}'), ["shell", "packages"]);
  assert.deepEqual(moved(PHONE, '{"platforms":["iOS"]}'), ["shell", "ios", "simulator"]);
  // New in this change (it wasn't there before): what it is now.
  assert.deepEqual(moved(undefined, DESKTOP), ["shell", "packages"]);
  assert.deepEqual(moved(undefined, PHONE), ["shell", "ios", "simulator"]);
  // Deleted by this change, or unreadable either side: both's. The
  // simulator's run only for one that was the phone's.
  assert.deepEqual(moved(PHONE, null), ["shell", "packages", "ios", "simulator"]);
  assert.deepEqual(moved(DESKTOP, null), ["shell", "packages", "ios"]);
  assert.deepEqual(moved(null, DESKTOP), ["shell", "packages", "ios"]);
  assert.deepEqual(moved("not json", DESKTOP), ["shell", "packages", "ios"]);
  // With nothing known of before, what it is now is all there is to go by.
  assert.deepEqual(reached([path], { read: shell({ [path]: DESKTOP }) }), ["shell", "packages"]);
});

test("what can't be read is both's: no lib.rs, or one with nothing this recognises", () => {
  for (const lib of [null, "", "fn main() {}"]) {
    const read = (path) => (path === "client/src-tauri/src/lib.rs" ? lib : null);
    assert.deepEqual(reached(["client/src-tauri/src/tray.rs"], { read }), ["shell", "packages", "ios"], String(lib));
    assert.equal(shellReach("client/src-tauri/src/voice/device.rs", read), "both");
  }
});

test("a desktop-only change and a phone-only change together start both", () => {
  assert.deepEqual(reached(["client/src-tauri/src/tray.rs", "client/src-tauri/src/phone_scene.rs"]), ["shell", "packages", "ios", "simulator"]);
});

test("what the simulator builds, drives or runs starts it; the share window's, TestFlight's and the scripts' tests don't", () => {
  for (const path of ["client/src-tauri/src/phone_scene.rs", "client/src-tauri/gen/apple/project.yml", "client/tests/ios/set-up.yaml",
    "client/tests/ios/subflows/type.yaml", "client/src-tauri/tauri.ios.conf.json", "client/src-tauri/Info.ios.plist",
    // The run itself, and the scripts it runs: a change to those is what it's there to check.
    ".github/workflows/ios-simulator.yml", "scripts/https-front.mjs", "scripts/share-window-ready.mjs", "scripts/test-certs.sh",
    "scripts/app-at-rest.mjs", "scripts/maestro-driver.mjs"])
    assert(reached([path]).includes("simulator"), path);
  for (const path of [".github/workflows/ios.yml", ".github/workflows/share-window.yml", ".github/workflows/nightly.yml",
    "client/tests/share-sender/send.test.ts", "client/tests/share-window-preview/preview.html", "scripts/share-window-shots.sh",
    "scripts/share-sender-test.sh", "scripts/https-front.test.mjs", "scripts/app-at-rest.test.mjs", "scripts/maestro-driver.test.mjs",
    "scripts/fixtures/maestro-driver-died.log", "client/src-tauri/src/tray.rs", "client/src-tauri/src/acl.rs"])
    assert(!reached([path]).includes("simulator"), path);
});

/** A folder outside the repository under test, for GITHUB_OUTPUT: a file inside would be committed by the next `git add .` and count as a change. */
function outside(t) {
  const dir = mkdtempSync(join(tmpdir(), "ci-scope-out-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// As CI runs it: a pull request's two commits, and the answer in GITHUB_OUTPUT.
test("in CI: the page and the shared shell build the iPhone's parts but leave the simulator, and it says so; the phone's own file runs it", (t) => {
  const { dir, git } = branchRepo(t);
  execFileSync("mkdir", ["-p", join(dir, "client/src/next"), join(dir, "client/src-tauri/src")]);
  writeFileSync(join(dir, "client/src-tauri/src/lib.rs"), "#[cfg(desktop)]\nmod tray;\n#[cfg(any(mobile, test))]\nmod phone_scene;\n");
  git("add", "."); git("commit", "-q", "-m", "the shell, on main");
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  writeFileSync(join(dir, "client/src/next/Settings.tsx"), "b\n");
  writeFileSync(join(dir, "client/src-tauri/src/lib.rs"), "#[cfg(desktop)]\nmod tray;\n#[cfg(any(mobile, test))]\nmod phone_scene;\n\npub fn run() {}\n");
  writeFileSync(join(dir, "client/src-tauri/src/tray.rs"), "b\n");
  git("add", "."); git("commit", "-q", "-m", "a page, the tray and lib.rs's code, not its modules");
  const script = fileURLToPath(new URL("./ci-scope.mjs", import.meta.url));
  const run = () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const output = join(outside(t), "output");
    writeFileSync(output, "");
    const env = { ...process.env, GITHUB_EVENT_NAME: "pull_request", BASE_SHA: base, HEAD_SHA: head, GITHUB_OUTPUT: output, CI_SCOPE_ALL: "" };
    const said = execFileSync("node", [script], { cwd: dir, encoding: "utf8", env });
    const out = readFileSync(output, "utf8");
    return { said, ios: /^ios=(.*)$/m.exec(out)?.[1], simulator: /^simulator=(.*)$/m.exec(out)?.[1], packages: /^packages=(.*)$/m.exec(out)?.[1] };
  };
  const shared = run();
  assert.deepEqual([shared.ios, shared.simulator, shared.packages], ["true", "false", "true"]);
  assert.match(shared.said, /The iPhone app in the simulator isn't run: .* gh workflow run ios-simulator\.yml --ref <branch>/);
  // With a file that's the phone's alone, the simulator runs, and nothing says it doesn't.
  writeFileSync(join(dir, "client/src-tauri/src/phone_scene.rs"), "b\n");
  git("add", "."); git("commit", "-q", "-m", "and the phone's scenes");
  const phone = run();
  assert.equal(phone.simulator, "true");
  assert.doesNotMatch(phone.said, /isn't run/);
});

test("in CI: a capability file moved off the phone still runs the iPhone checks, read from both commits", (t) => {
  const { dir, git } = branchRepo(t);
  execFileSync("mkdir", ["-p", join(dir, "client/src-tauri/capabilities")]);
  const file = join(dir, "client/src-tauri/capabilities/share.json");
  writeFileSync(file, '{"platforms":["android","iOS"]}\n');
  writeFileSync(join(dir, "client/src-tauri/capabilities/owner.json"), '{"platforms":["linux","macOS","windows"]}\n');
  git("add", "."); git("commit", "-q", "-m", "a capability for the phone, one for the desktop");
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const script = fileURLToPath(new URL("./ci-scope.mjs", import.meta.url));
  const run = () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const output = join(outside(t), "output");
    writeFileSync(output, "");
    execFileSync("node", [script], { cwd: dir, encoding: "utf8", env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", BASE_SHA: base, HEAD_SHA: head, GITHUB_OUTPUT: output, CI_SCOPE_ALL: "" } });
    const out = readFileSync(output, "utf8");
    return { ios: /^ios=(.*)$/m.exec(out)?.[1], packages: /^packages=(.*)$/m.exec(out)?.[1] };
  };
  // The desktop's file changed, still the desktop's: no iPhone run.
  writeFileSync(join(dir, "client/src-tauri/capabilities/owner.json"), '{"platforms":["linux","macOS","windows"],"permissions":["x"]}\n');
  git("commit", "-q", "-am", "a permission for the desktop");
  assert.deepEqual(run(), { ios: "false", packages: "true" });
  // The phone's file moved to the desktop: the iPhone run too, though it reads as the desktop's now.
  writeFileSync(file, '{"platforms":["linux","macOS","windows"]}\n');
  git("commit", "-q", "-am", "moved off the phone");
  assert.deepEqual(run(), { ios: "true", packages: "true" });
  // A new one for the desktop wasn't there before: the desktop's.
  git("reset", "-q", "--hard", base);
  writeFileSync(join(dir, "client/src-tauri/capabilities/tools.json"), '{"platforms":["linux","macOS","windows"]}\n');
  git("add", "."); git("commit", "-q", "-m", "a new one for the desktop");
  assert.deepEqual(run(), { ios: "false", packages: "true" });
});

// --- the iPhone app in the simulator: what it builds, drives or runs, a release, and the nightly run (#955) ---

test("the simulator's run is left to the nightly run for files both apps build, the server and the wire types", () => {
  for (const path of ["client/src/next/core/phone.ts", "client/src/lib/pageVoice.ts", "client/package.json", "client/src-tauri/src/lib.rs",
    "client/src-tauri/Cargo.toml", "crates/linger-server/src/main.rs", "crates/linger-core/src/lib.rs", "Cargo.toml", "deploy/Dockerfile"]) {
    assert(!reached([path]).includes("simulator"), path);
  }
  // What the phone app reaches still builds its share window and its Rust for the iPhone.
  assert(reached(["client/src-tauri/src/lib.rs"]).includes("ios"));
});

test("a release's pull request runs the simulator: it adds the release's notes", () => {
  const notes = "docs/releases/0.5.6.md";
  const isNew = (asked) => (asked === notes ? undefined : "was there");
  // With the version bumped in the same pull request, or already bumped on main (0.5.5's was).
  assert.deepEqual(reached([notes], { before: isNew }), ["simulator"]);
  const bump = ["Cargo.toml", "Cargo.lock", "client/package.json", "client/src-tauri/Cargo.toml", "client/src-tauri/Cargo.lock",
    "client/src-tauri/tauri.conf.json", "client/src/next/core/release-line.json", "README.md", "TASKS.md"];
  assert(reached([...bump, notes], { before: isNew }).includes("simulator"));
  // Git can't say whether they're new, or there's no earlier commit to ask: it runs.
  assert.deepEqual(reached([notes], { before: () => null }), ["simulator"]);
  assert.deepEqual(reached([notes]), ["simulator"]);
});

test("the next version's bump after the App Store approves isn't a release, nor is fixing a release's notes", () => {
  const bump = ["Cargo.toml", "Cargo.lock", "client/package.json", "client/src-tauri/Cargo.toml", "client/src-tauri/Cargo.lock",
    "client/src-tauri/tauri.conf.json"];
  assert(!reached(bump, { before: () => "was there" }).includes("simulator"));
  // #958: 0.5.5's notes corrected after its release.
  assert.deepEqual(reached(["docs/releases/0.5.5.md", "TASKS.md"], { before: () => "was there" }), []);
  // Only a version's notes: other files under docs/releases aren't a release.
  assert.deepEqual(reached(["docs/releases/README.md", "docs/releases/v0.2.0.md"], { before: () => undefined }), []);
});

test("in CI: a pull request adding a release's notes runs the simulator, one fixing them doesn't, and it says so", (t) => {
  const { dir, git } = branchRepo(t);
  const script = fileURLToPath(new URL("./ci-scope.mjs", import.meta.url));
  const rev = () => execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const run = (base, head) => {
    const output = join(outside(t), "output");
    writeFileSync(output, "");
    const said = execFileSync("node", [script], { cwd: dir, encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", BASE_SHA: base, HEAD_SHA: head, GITHUB_OUTPUT: output, CI_SCOPE_ALL: "" } });
    return { said, simulator: /^simulator=(.*)$/m.exec(readFileSync(output, "utf8"))?.[1] };
  };
  const base = rev();
  execFileSync("mkdir", ["-p", join(dir, "docs/releases")]);
  writeFileSync(join(dir, "docs/releases/9.9.9.md"), "# 9.9.9\n");
  git("add", "."); git("commit", "-q", "-m", "release 9.9.9");
  const release = rev();
  assert.equal(run(base, release).simulator, "true");
  writeFileSync(join(dir, "docs/releases/9.9.9.md"), "# 9.9.9, fixed\n");
  git("commit", "-q", "-am", "fix the notes");
  const fixed = run(release, rev());
  assert.equal(fixed.simulator, "false");
  assert.match(fixed.said, /The iPhone app in the simulator isn't run: .* gh workflow run ios-simulator\.yml --ref <branch>/);
});

test("a phone module's file runs the simulator, deleted or moved to the desktop too; lib.rs, both apps', waits for the nightly run", () => {
  const libPath = "client/src-tauri/src/lib.rs";
  const before = (asked) => (asked === libPath ? LIB : "was there");
  const swap = (from, to) => {
    assert(LIB.includes(from), from);
    return LIB.replace(from, to);
  };
  const runs = (paths, text, options = {}) => reached(paths, { read: shell({ [libPath]: text }), before, ...options }).includes("simulator");
  // phone_scene deleted, with its line in lib.rs: its file was the phone's.
  const withoutScene = swap("#[cfg(any(target_os = \"ios\", test))]\nmod phone_scene;\n", "");
  assert(runs(["client/src-tauri/src/phone_scene.rs", libPath], withoutScene));
  assert(runs(["client/src-tauri/src/phone_scene.rs"], withoutScene));
  // share_window moved to the desktop, with its file changed.
  assert(runs(["client/src-tauri/src/share_window.rs", libPath], swap("#[cfg(any(mobile, test))]\nmod share_window;", "#[cfg(desktop)]\nmod share_window;")));
  // lib.rs alone, however its modules change: both apps', so the nightly run.
  assert(!runs([libPath], swap("pub mod gateway;", "#[cfg(desktop)]\npub mod gateway;")));
  assert(!runs([libPath], `${LIB}\npub fn run() {}\n`));
  // A module both build, or the desktop's, isn't the phone's before or after.
  assert(!runs(["client/src-tauri/src/gateway.rs"], LIB));
  assert(!runs(["client/src-tauri/src/tray.rs"], LIB));
  // Git can't say what lib.rs was, or nothing known of before: what it is now is all there is.
  assert(!reached(["client/src-tauri/src/tray.rs"], { before: () => null }).includes("simulator"));
  assert(reached(["client/src-tauri/src/phone_scene.rs"], { before: () => null }).includes("simulator"));
  assert(!reached(["client/src-tauri/src/phone_scene.rs"], { read: shell({ [libPath]: withoutScene }) }).includes("simulator"));
});

test("a pull request runs the simulator's start flows, but everything, a release and the run's own files run every flow (#971)", () => {
  assert.equal(simulatorFlows([]), "all", "the nightly run and a run by hand");
  for (const path of ["client/src-tauri/gen/apple/LaunchScreen.storyboard", "client/src-tauri/tauri.ios.conf.json", "client/src-tauri/src/phone_save.rs"])
    assert.equal(simulatorFlows([path]), "start", path);
  for (const path of ["client/tests/ios/room.yaml", "client/tests/ios/config.yaml", "client/tests/ios/subflows/type.yaml",
    ".github/workflows/ios-simulator.yml", "scripts/https-front.mjs", "scripts/share-window-ready.mjs", "scripts/test-certs.sh",
    "scripts/app-at-rest.mjs", "scripts/maestro-driver.mjs"])
    assert.equal(simulatorFlows(["client/src-tauri/tauri.ios.conf.json", path]), "all", path);
  // A release's pull request adds its notes: new, every flow; an older one fixed, not.
  assert.equal(simulatorFlows(["docs/releases/0.9.9.md"], { before: () => undefined }), "all");
  assert.equal(simulatorFlows(["client/src-tauri/tauri.ios.conf.json", "docs/releases/0.5.0.md"], { before: () => "old notes" }), "start");
});
