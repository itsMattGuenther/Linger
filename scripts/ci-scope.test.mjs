import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { classify, localPaths } from "./ci-scope.mjs";

const active = (paths) => Object.entries(classify(paths)).filter(([, value]) => value).map(([key]) => key);
for (const paths of [["README.md"], ["docs/testing.md", "LICENSE"], ["docs/screenshots/example.png"]])
  test(`documentation only: ${paths}`, () => assert.deepEqual(active(paths), []));
for (const paths of [[], ["unexpected.conf"], ["Cargo.lock"], [".github/workflows/ci.yml"], ["crates/linger-core/src/lib.rs"]])
  test(`conservative fallback: ${paths}`, () => assert.equal(active(paths).length, 6));
test("UI changes test both browser and native packages, not unrelated server jobs", () => {
  assert.deepEqual(active(["client/src/next/styles/app.css"]), ["web", "packages"]);
});
test("browser assertions alone need no package rebuild", () => {
  assert.deepEqual(active(["client/tests/browser/console.spec.ts"]), ["web"]);
});
test("the packaged audio and video checks' own files rebuild only the packages", () => {
  for (const path of ["scripts/linux-audio-check.py", "scripts/video-runtime-probe.js", "scripts/fixtures/tone-h264-aac.mp4",
    "scripts/appimage-ffmpeg.sh", "scripts/appimage-ffmpeg-check.sh"])
    assert.deepEqual(active([path]), ["packages"], path);
});
test("server changes include real storage tests", () => {
  assert.deepEqual(active(["crates/linger-server/src/storage.rs"]), ["rust", "s3"]);
});
test("desktop changes test the separately built shell and packages", () => {
  assert.deepEqual(active(["client/src-tauri/Cargo.lock"]), ["shell", "packages"]);
});
test("union retains every affected domain, including deletion side of a rename", () => {
  assert.deepEqual(active(["client/src/next/styles/app.css", "docs/old.css", "deploy/Dockerfile"]),
    ["rust", "s3", "web", "coturn", "packages"]);
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
  assert.equal(out, "changed=1\nrust=false\ns3=false\nweb=false\nshell=false\ncoturn=false\npackages=false\n");
});
test("local: no base to compare with selects everything", (t) => {
  const { dir } = branchRepo(t);
  const script = fileURLToPath(new URL("./ci-scope.mjs", import.meta.url));
  const out = execFileSync("node", [script, "--local", "no-such-ref"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  assert.match(out, /^changed=0\nrust=true\n/);
  assert.equal(out.match(/=true/g).length, 6);
});
