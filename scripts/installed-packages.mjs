// Whether client/node_modules was installed from client/pnpm-lock.yaml (#852).
// scripts/check.sh tests with the packages already installed and never
// installs any, so after the lockfile changes (a pull, a branch switched to)
// it tests the old ones, and fails, or passes, somewhere that doesn't say
// why: after Tauri 2.12 (#850) the icon check said "Icon differs", because
// it draws the icons with the installed CLI, still 2.11. CI installs afresh
// every time and never sees it.
//
// pnpm keeps a copy of the lockfile it installed from, in
// node_modules/.pnpm/lock.yaml; an install from this lockfile leaves the two
// the same, byte for byte.
//
// Usage: node scripts/installed-packages.mjs [client-dir]   (default client)
//   Exits 1, saying to run `pnpm install`, when they differ or nothing is installed.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * "installed" when `dir`'s node_modules came from its pnpm-lock.yaml,
 * "stale" when from another, "missing" when nothing is installed. A
 * directory with no lockfile is a mistake in how this was called, and fails.
 */
export function installed(dir) {
  const lock = join(dir, "pnpm-lock.yaml");
  if (!existsSync(lock)) throw new Error(`${lock} isn't there`);
  const copy = join(dir, "node_modules/.pnpm/lock.yaml");
  if (!existsSync(copy)) return "missing";
  return readFileSync(copy).equals(readFileSync(lock)) ? "installed" : "stale";
}

function run() {
  const dir = process.argv[2] ?? "client";
  const state = installed(dir);
  if (state === "installed") return;
  const why = state === "missing" ? "has nothing installed" : "was installed from another pnpm-lock.yaml";
  console.error(`${join(dir, "node_modules")} ${why}, so the checks would test other packages than the lockfile's: run \`pnpm install\` in ${dir}/ first.`);
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
