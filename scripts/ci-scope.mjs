// Classify the full PR, not just its last commit. Unknown paths fail open.
// CI uses this to pick its jobs; scripts/check.sh uses `--local` to pick the
// same checks on a laptop (docs/testing-strategy.md).
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// `ios` is the iPhone app in the simulator (ios-simulator.yml): the app's
// shell and page, and the flows and helpers that drive it. `relay` is the
// push relay's Worker (push-relay/, #887), which reads the wire types too.
const domains = ["rust", "s3", "web", "shell", "coturn", "packages", "ios", "relay"];

// Only the checks a change can reach run on its pull request (#914). Most of
// the app is shared by the desktop app and the phone app, but not all of it,
// and the checks that are one app's own are the slow ones: the desktop
// installers, and the iPhone app in the simulator, which is 40 minutes on a
// Mac for every push.
//
// The shell says which app builds each of its modules, in `lib.rs`
// (`#[cfg(desktop)] mod tray;`), and each capability file says which
// platforms it's for. So a file is the desktop's, the phone's or both's by
// what the code says, not by a list kept here that would fall behind. A file
// that says nothing, or can't be read, is both's.

/** The label that says a pull request can't change what the phone app does. */
export const DESKTOP_ONLY = "desktop-only";

const SHELL = "client/src-tauri/";
const DESKTOP_SYSTEMS = ["linux", "windows", "macos"];
const DESKTOP_PLATFORMS = ["linux", "macOS", "windows"];
const PHONE_PLATFORMS = ["iOS", "android"];
const CAPABILITY = /^capabilities\/[^/]+\.json$/;

const fromDisk = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/**
 * Which app builds what a `#[cfg(...)]` guards: "desktop", "phone", "tests"
 * (only the shell's own tests), or "both" for anything this can't tell.
 */
export function cfgReach(cfg) {
  const terms = cfg
    .replace(/^any\((.*)\)$/s, "$1")
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean);
  if (!terms.length || /\b(?:all|not)\(/.test(cfg)) return "both";
  const kinds = new Set(
    terms.map((term) => {
      if (term === "test") return "tests";
      if (term === "desktop") return "desktop";
      if (term === "mobile") return "phone";
      const system = /^target_os = "(\w+)"$/.exec(term)?.[1];
      if (system && DESKTOP_SYSTEMS.includes(system)) return "desktop";
      if (system === "ios" || system === "android") return "phone";
      return "both";
    }),
  );
  if (kinds.has("both") || (kinds.has("desktop") && kinds.has("phone"))) return "both";
  // "Phone, and the tests" is the phone's module, with tests that run here.
  if (kinds.has("phone")) return "phone";
  if (kinds.has("desktop")) return "desktop";
  return "tests";
}

/** The shell's modules, each with which app builds it, from `lib.rs`: `{ tray: "desktop", gateway: "both" }`. */
export function shellModules(lib) {
  const found = {};
  const declared = /((?:^[ \t]*#\[[^\n]*\]\n)*)^[ \t]*(?:pub(?:\([^)]*\))? )?mod (\w+);/gm;
  for (const [, attributes, name] of lib.matchAll(declared)) {
    const cfgs = [...attributes.matchAll(/^[ \t]*#\[cfg\((.*)\)\]$/gm)].map((line) => line[1]);
    // Two `cfg`s on one module, or some other attribute carrying one: not read, so both's.
    const reach = cfgs.length === 0 ? "both" : cfgs.length === 1 && !/cfg_attr/.test(attributes) ? cfgReach(cfgs[0]) : "both";
    // Declared twice (once for each app, say, each with its own file): both's.
    found[name] = name in found || /#\[path\b/.test(attributes) ? "both" : reach;
  }
  return found;
}

/** Which platforms a capability file is for, from its text: "desktop", "phone", or "both" for anything else. */
function capabilityReach(text) {
  let platforms = null;
  try {
    platforms = JSON.parse(text ?? "null")?.platforms;
  } catch {
    // Not JSON: not read, so both's.
  }
  if (!Array.isArray(platforms) || !platforms.length) return "both";
  if (platforms.every((platform) => DESKTOP_PLATFORMS.includes(platform))) return "desktop";
  if (platforms.every((platform) => PHONE_PLATFORMS.includes(platform))) return "phone";
  return "both";
}

/**
 * Which app a capability file was for and is for now, as two answers. A
 * capability file carries its own platforms, so a change can move it from
 * one app to the other, and what it was matters as much as what it is:
 * moved off the phone, it takes something from the phone app. `before`
 * hands back the file's text as it was before the change, `undefined` when
 * it wasn't there, or null when that can't be told.
 */
function capabilityReaches(path, read, before) {
  const now = capabilityReach(read(path));
  if (!before) return [now];
  const was = before(path);
  return was === undefined ? [now] : [now, capabilityReach(was)];
}

/**
 * Which app a file of the shell reaches: "desktop", "phone", "tests" or
 * "both". `read` hands back a file's text, or null; `before`, the same as
 * it was before the change (`capabilityReaches`). A file that was one app's
 * and is now the other's is both's.
 */
export function shellReach(path, read = fromDisk, before = null) {
  const inside = path.slice(SHELL.length);
  if (/^(linux|windows)\//.test(inside)) return "desktop";
  // The iPhone's own project and settings. The shell's tests read some of
  // it (the notification extension's Swift, in `phone_push.rs`), so they
  // run for it too. Android's stay both's: what checks them isn't sorted
  // by app yet.
  if (/^(gen\/apple\/|Info\.ios\.plist$|tauri\.ios\.conf\.json$)/.test(inside)) return "phone";
  if (CAPABILITY.test(inside)) {
    const reaches = new Set(capabilityReaches(path, read, before));
    return reaches.size === 1 ? [...reaches][0] : "both";
  }
  // `src/tray.rs` and `src/voice/device.rs` are the modules `tray` and `voice`.
  // Which app builds a module is said in lib.rs, not in the module's file,
  // so moving one between the apps is a change to lib.rs, which is both's.
  const module = /^src\/(\w+)(?:\.rs$|\/)/.exec(inside)?.[1];
  if (!module || module === "lib" || module === "main") return "both";
  const lib = read(`${SHELL}src/lib.rs`);
  return (lib === null ? {} : shellModules(lib))[module] ?? "both";
}

/**
 * Whether a file is the phone app's alone, which a `desktop-only` label
 * can't be true of: its flows and what they run on, the workflows that
 * build and run it, and what only the phone app builds.
 */
function phonesOwn(path, read, before) {
  if (/^client\/tests\/(ios|share-sender|share-window-preview)\//.test(path)) return true;
  if (/^\.github\/workflows\/(ios[\w-]*|share-window)\.yml$/.test(path)) return true;
  if (/^scripts\/(https-front(\.test)?\.mjs|share-window-ready\.mjs|test-certs\.sh|app-at-rest(\.test)?\.mjs|share-window-shots\.sh|share-sender-test\.sh)$/.test(path)) return true;
  if (!path.startsWith(SHELL)) return false;
  // The phone's now, or the phone's before this change moved it.
  if (CAPABILITY.test(path.slice(SHELL.length))) return capabilityReaches(path, read, before).includes("phone");
  return shellReach(path, read) === "phone";
}

/**
 * The checks a change sets off. `labels` are the pull request's: with
 * `desktop-only`, the iPhone run is left out, unless a file that is the
 * phone app's alone changed, which the label can't be true of. `read` hands
 * back a file's text as it is now, and `before` as it was before the change
 * (`beforeAt`); without `before`, only what a file is now is known.
 */
export function classify(paths, { labels = [], read = fromDisk, before = null } = {}) {
  const selected = new Set();
  const add = (...names) => names.forEach((name) => selected.add(name));
  if (!paths.length) add(...domains);
  for (const path of paths) {
    if (path.startsWith("docs/") || path.endsWith(".md") || path === "LICENSE") continue;
    // Checks and tools that ship nothing (docs/performance.md,
    // docs/pr-questions.md, docs/testing-strategy.md): the rules job runs
    // them and their tests on every change. The review gate is one, with
    // its hook in .claude/settings.json (#917, #930); ci.yml's rules job
    // runs its tests by name.
    if (path === ".claude/settings.json") continue;
    if (/^scripts\/(startup-time|pr-questions|review-catches|review-gate|tauri-versions|ios-flows|ios-plist|upstream-fixes|android-jni|installed-packages|maestro-driver|app-at-rest|browser-fakes)(\.test)?\.mjs$|^scripts\/fixtures\/(dexdump-[\w.]+\.txt|maestro-[\w-]+\.log)$|^scripts\/actionlint(-test)?\.sh$/.test(path)) continue;
    if (path.startsWith("crates/linger-core/") || path.startsWith("client/src/generated/")) add(...domains);
    else if (path.startsWith("crates/linger-server/")) add("rust", "s3");
    else if (path.startsWith(SHELL)) {
      // The shell's own tests run for any of it; the installers for what
      // the desktop app builds, the iPhone run for what the phone app does.
      const reach = shellReach(path, read, before);
      add("shell");
      if (reach === "desktop" || reach === "both") add("packages");
      if (reach === "phone" || reach === "both") add("ios");
    }
    else if (path.startsWith("client/tests/browser/")) add("web");
    else if (path.startsWith("client/tests/ios/")) add("ios");
    else if (/^scripts\/(https-front(\.test)?\.mjs|share-window-ready\.mjs|test-certs\.sh)$/.test(path)) add("ios");
    else if (path.startsWith("client/")) add("web", "packages", "ios");
    else if (path.startsWith("assets/logo/")) add("web", "packages");
    else if (/^scripts\/(.*audio.*|.*icon.*|windows-update-check\.ps1|video-runtime-probe\.js|fixtures\/tone-h264-aac\.mp4|appimage-.*|bundle-retry(-test)?\.sh)$/.test(path)) add("packages");
    else if (path.startsWith("deploy/")) add("rust", "s3", "coturn");
    else if (path.startsWith("push-relay/")) add("relay");
    else add(...domains);
  }
  if (labels.includes(DESKTOP_ONLY) && paths.length && !paths.some((path) => phonesOwn(path, read, before))) selected.delete("ios");
  return Object.fromEntries(domains.map((name) => [name, selected.has(name)]));
}

/** The pull request's labels, from `PR_LABELS` as the workflows set it: a JSON list of names. Nothing readable is no labels. */
export function labelsFrom(value) {
  try {
    const labels = JSON.parse(value || "[]");
    return Array.isArray(labels) ? labels.filter((label) => typeof label === "string") : [];
  } catch {
    return [];
  }
}

/** The commit a change is measured from: where the branch left `base`, for a pull request. */
export function startOf(base, head, pullRequest, cwd = process.cwd()) {
  return pullRequest ? execFileSync("git", ["merge-base", base, head], { cwd, encoding: "utf8" }).trim() : base;
}

export function changedPaths(base, head, pullRequest) {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const start = startOf(base, head, pullRequest);
  // No rename detection: removing source by moving it into docs still tests source.
  return git("diff", "--no-renames", "--name-only", "-z", start, head).split("\0").filter(Boolean);
}

/**
 * A reader of files as they were at `start`, for `classify`'s `before`: a
 * file's text, `undefined` when it wasn't there then, or null when Git
 * can't say (which reads as both apps').
 */
export function beforeAt(start, cwd = process.cwd()) {
  return (path) => {
    const quiet = { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
    try {
      return execFileSync("git", ["show", `${start}:${path}`], quiet);
    } catch {
      try {
        // The commit is there and the file isn't in it: it's new.
        execFileSync("git", ["cat-file", "-e", `${start}^{commit}`], quiet);
        return execFileSync("git", ["ls-tree", "--name-only", start, "--", path], quiet).trim() === "" ? undefined : null;
      } catch {
        return null;
      }
    }
  };
}

// What a branch on a laptop has changed since it left `base`: its commits,
// plus edits not committed yet and new files not added yet, so a check run
// before committing sees what CI will.
export function localPaths(base, cwd = process.cwd()) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const start = git("merge-base", base, "HEAD").trim();
  const split = (out) => out.split("\0").filter(Boolean);
  return [...new Set([
    ...split(git("diff", "--no-renames", "--name-only", "-z", start)),
    ...split(git("ls-files", "--others", "--exclude-standard", "-z")),
  ])];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--local") {
    // One `name=true|false` line per domain, and `changed=<count>`, for the
    // shell. No comparison (no base, or nothing changed) selects everything.
    let paths = [];
    let before = null;
    try {
      paths = localPaths(process.argv[3] || "origin/main");
      before = beforeAt(startOf(process.argv[3] || "origin/main", "HEAD", true));
    } catch {
      console.error(`Can't compare with ${process.argv[3] || "origin/main"}; checking everything.`);
    }
    const scope = classify(paths, { before });
    console.log([`changed=${paths.length}`, ...Object.entries(scope).map(([key, value]) => `${key}=${value}`)].join("\n"));
  } else {
    // A manual run, or a caller asking for everything (a release, the
    // nightly run: CI_SCOPE_ALL), checks every domain.
    let paths = [];
    let before = null;
    if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" && process.env.CI_SCOPE_ALL !== "true") {
      try {
        const pullRequest = process.env.GITHUB_EVENT_NAME === "pull_request";
        paths = changedPaths(process.env.BASE_SHA, process.env.HEAD_SHA, pullRequest);
        before = beforeAt(startOf(process.env.BASE_SHA, process.env.HEAD_SHA, pullRequest));
      } catch { console.log("Comparison unavailable; selecting every test domain."); }
    }
    const labels = labelsFrom(process.env.PR_LABELS);
    const scope = classify(paths, { labels, before });
    console.log(JSON.stringify({ paths, labels, scope }, null, 2));
    if (labels.includes(DESKTOP_ONLY) && paths.length)
      console.log(scope.ios ? `The ${DESKTOP_ONLY} label is ignored: this changes files that are the phone app's alone.` : `Labelled ${DESKTOP_ONLY}: the iPhone app in the simulator isn't run. The nightly run on main still runs it.`);
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(scope).map(([key, value]) => `${key}=${value}\n`).join(""));
  }
}
