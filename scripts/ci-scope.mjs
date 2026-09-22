// Classify the full PR, not just its last commit. Unknown paths fail open.
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
    else if (/^scripts\/(.*audio.*|.*icon.*|windows-update-check\.ps1)$/.test(path)) add("packages");
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let paths = [];
  if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
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
