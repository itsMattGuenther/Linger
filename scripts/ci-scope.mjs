// Classify the full PR, not just its last commit. Unknown paths fail open.
// CI uses this to pick its jobs; scripts/check.sh uses `--local` to pick the
// same checks on a laptop (docs/testing-strategy.md).
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const domains = ["rust", "s3", "web", "shell", "coturn", "packages"];
export function classify(paths) {
  const selected = new Set();
  const add = (...names) => names.forEach((name) => selected.add(name));
  if (!paths.length) add(...domains);
  for (const path of paths) {
    if (path.startsWith("docs/") || path.endsWith(".md") || path === "LICENSE") continue;
    if (path.startsWith("crates/linger-core/") || path.startsWith("client/src/generated/")) add(...domains);
    else if (path.startsWith("crates/linger-server/")) add("rust", "s3");
    else if (path.startsWith("client/src-tauri/")) add("shell", "packages");
    else if (path.startsWith("client/tests/browser/")) add("web");
    else if (path.startsWith("client/")) add("web", "packages");
    else if (path.startsWith("assets/logo/")) add("web", "packages");
    else if (/^scripts\/(.*audio.*|.*icon.*|windows-update-check\.ps1|video-runtime-probe\.js|fixtures\/tone-h264-aac\.mp4)$/.test(path)) add("packages");
    else if (path.startsWith("deploy/")) add("rust", "s3", "coturn");
    else add(...domains);
  }
  return Object.fromEntries(domains.map((name) => [name, selected.has(name)]));
}

export function changedPaths(base, head, pullRequest) {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const start = pullRequest ? git("merge-base", base, head) : base;
  // No rename detection: removing source by moving it into docs still tests source.
  return git("diff", "--no-renames", "--name-only", "-z", start, head).split("\0").filter(Boolean);
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
    try {
      paths = localPaths(process.argv[3] || "origin/main");
    } catch {
      console.error(`Can't compare with ${process.argv[3] || "origin/main"}; checking everything.`);
    }
    const scope = classify(paths);
    console.log([`changed=${paths.length}`, ...Object.entries(scope).map(([key, value]) => `${key}=${value}`)].join("\n"));
  } else {
    // A manual run, or a caller asking for everything (a release, the
    // nightly run: CI_SCOPE_ALL), checks every domain.
    let paths = [];
    if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" && process.env.CI_SCOPE_ALL !== "true") {
      try {
        paths = changedPaths(process.env.BASE_SHA, process.env.HEAD_SHA,
          process.env.GITHUB_EVENT_NAME === "pull_request");
      } catch { console.log("Comparison unavailable; selecting every test domain."); }
    }
    const scope = classify(paths);
    console.log(JSON.stringify({ paths, scope }, null, 2));
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(scope).map(([key, value]) => `${key}=${value}\n`).join(""));
  }
}
