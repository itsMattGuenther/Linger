// scripts/installed-packages.mjs (#852): check.sh stops on packages installed
// from another lockfile, or none, rather than testing them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { installed } from "./installed-packages.mjs";

const SCRIPT = fileURLToPath(new URL("./installed-packages.mjs", import.meta.url));
const LOCK = "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    devDependencies:\n      '@tauri-apps/cli':\n        specifier: ^2.12.4\n        version: 2.12.4\n";

/** A client folder with this lockfile and, if given, the copy pnpm kept when it installed. */
function client(t, copy) {
  const dir = mkdtempSync(join(tmpdir(), "installed-packages-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "pnpm-lock.yaml"), LOCK);
  if (copy !== undefined) {
    mkdirSync(join(dir, "node_modules/.pnpm"), { recursive: true });
    writeFileSync(join(dir, "node_modules/.pnpm/lock.yaml"), copy);
  }
  return dir;
}

test("packages installed from this lockfile pass, and ones from another, or none, don't", (t) => {
  assert.equal(installed(client(t, LOCK)), "installed");
  // What a pull of Tauri 2.12 left behind: the copy still says 2.11.
  assert.equal(installed(client(t, LOCK.replaceAll("2.12.4", "2.11.4"))), "stale");
  assert.equal(installed(client(t, LOCK + "\n")), "stale", "byte for byte");
  assert.equal(installed(client(t)), "missing");
  assert.throws(() => installed(join(tmpdir(), "no-such-client-dir")), /pnpm-lock\.yaml isn't there/);
});

test("run: it says to run pnpm install, and fails, unless the packages match", (t) => {
  const ok = spawnSync(process.execPath, [SCRIPT, client(t, LOCK)], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stderr, "");
  for (const [copy, said] of [[LOCK.replace("2.12.4", "2.11.4"), /was installed from another pnpm-lock\.yaml/], [undefined, /has nothing installed/]]) {
    const dir = client(t, copy);
    const out = spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
    assert.equal(out.status, 1);
    assert.match(out.stderr, said);
    assert.match(out.stderr, new RegExp(`run \`pnpm install\` in ${dir.replaceAll("/", "\\/")}/ first`));
  }
});

test("this repository's own client, as installed here, is checked the same way", () => {
  // Only that it reads: whether this checkout is installed isn't the test's business.
  assert.ok(["installed", "stale", "missing"].includes(installed(fileURLToPath(new URL("../client", import.meta.url)))));
});
