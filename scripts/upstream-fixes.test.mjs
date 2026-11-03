// Whether a fix Linger pins has come out upstream (#836): each standing of the
// pull request, the release that has it found by version (not by name), and
// the script run with a stand-in `gh` that opens an issue once, and only when
// there's something to do.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { issueFor, standing } from "./upstream-fixes.mjs";

const SCRIPT = fileURLToPath(new URL("./upstream-fixes.mjs", import.meta.url));
const REV = "10e79e36ab73ac7f631b5c97783d99130414073d";
const pin = { name: "tao", git: "https://github.com/itsMattGuenther/tao", rev: REV, upstream: "tauri-apps/tao#1376" };
const URL_1376 = "https://github.com/tauri-apps/tao/pull/1376";

/** A stand-in for GitHub's API: the pull request, the tags, and which tags have the merge. */
function github({ state = "open", merged = false, tags = [], has = [] }) {
  return (path) => {
    if (path === "repos/tauri-apps/tao/pulls/1376")
      return { state, html_url: URL_1376, merged_at: merged ? "2026-11-20T00:00:00Z" : null, merge_commit_sha: merged ? "m".repeat(40) : null };
    if (path === "repos/tauri-apps/tao/tags?per_page=100") return tags.map((name) => ({ name, commit: { sha: `sha-${name}` } }));
    const compare = /^repos\/tauri-apps\/tao\/compare\/m+\.\.\.sha-(.+)$/.exec(path);
    if (compare) return { status: has.includes(compare[1]) ? "ahead" : "behind" };
    throw new Error(`no stand-in answer for ${path}`);
  };
}

test("an open pull request is waiting, and one closed without merging is closed", () => {
  assert.equal(standing(pin, github({ state: "open" })).state, "waiting");
  assert.equal(standing(pin, github({ state: "closed" })).state, "closed");
});

test("a merged fix no release has yet is merged; the oldest release that has it is named", () => {
  const tags = ["tauri-v2.13.0", "tao-v0.37", "tao-v0.37.2", "tao-v0.37.10", "tao-v0.37.9", "tao-v0.37.3"];
  assert.equal(standing(pin, github({ state: "closed", merged: true, tags, has: [] })).state, "merged");
  // As text, 0.37.9 sorts after 0.37.10; by version it comes before.
  const released = standing(pin, github({ state: "closed", merged: true, tags, has: ["tao-v0.37.10", "tao-v0.37.9"] }));
  assert.deepEqual([released.state, released.tag], ["released", "tao-v0.37.9"]);
  assert.equal(standing(pin, github({ state: "closed", merged: true, tags, has: ["tao-v0.37.10", "tao-v0.37.9", "tao-v0.37.3"] })).tag, "tao-v0.37.3");
});

test("an answer it can't read fails, rather than reading as waiting", () => {
  assert.throws(() => standing(pin, () => ({})), /has no state/);
  assert.throws(() => standing(pin, (path) => (path.includes("/pulls/") ? { state: "closed", merged_at: "x", merge_commit_sha: "m" } : { message: "Not Found" })), /tags aren't a list/);
});

test("only a released or a closed fix calls for an issue, and it says what to do", () => {
  assert.equal(issueFor({ pin, url: URL_1376, state: "waiting" }), null);
  assert.equal(issueFor({ pin, url: URL_1376, state: "merged" }), null);
  const released = issueFor({ pin, url: URL_1376, state: "released", tag: "tao-v0.37.3" });
  assert.equal(released.title, "Switch tao back to its own release: tauri-apps/tao#1376 is in tao-v0.37.3");
  assert.match(released.body, /cargo update -p tao/);
  assert.match(released.body, /link-closed/);
  assert.match(issueFor({ pin, url: URL_1376, state: "closed" }).title, /was closed without merging: tauri-apps\/tao#1376/);
});

// The script itself, in a throwaway repository, with a stand-in `gh` on PATH
// that answers from a scenario file and writes down every call.
const STAND_IN = `#!/usr/bin/env node
const fs = require("fs");
const scenario = JSON.parse(fs.readFileSync(process.env.SCENARIO, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + "\\n");
if (args[0] === "api") {
  const answer = scenario.api[args[1]] ?? (args[1].includes("/compare/") ? { status: "behind" } : null);
  if (answer === null) { console.error("no answer for " + args[1]); process.exit(1); }
  console.log(JSON.stringify(answer));
} else if (args[0] === "issue" && args[1] === "list") console.log(JSON.stringify(scenario.open ?? []));
else if (args[0] === "issue" && args[1] === "create") console.log("https://github.com/x/y/issues/9");
else { console.error("unexpected gh " + args.join(" ")); process.exit(1); }
`;
const PINNED = `[package]
name = "linger-client"

# upstream: tauri-apps/tao#1376
[patch.crates-io]
tao = { git = "https://github.com/itsMattGuenther/tao", rev = "${REV}" }
`;

function repo(t, cargoToml, scenario) {
  const dir = mkdtempSync(join(tmpdir(), "upstream-fixes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, "client/src-tauri"), { recursive: true });
  writeFileSync(join(dir, "client/src-tauri/Cargo.toml"), cargoToml);
  mkdirSync(join(dir, "bin"));
  writeFileSync(join(dir, "bin/gh"), STAND_IN);
  chmodSync(join(dir, "bin/gh"), 0o755);
  writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
  const run = () => spawnSync("node", [SCRIPT], {
    cwd: dir, encoding: "utf8",
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, SCENARIO: join(dir, "scenario.json"), CALLS: join(dir, "calls"), LINGER_ASSIGNEE: "someone" },
  });
  const calls = () => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []);
  return { run, calls };
}

const RELEASED = {
  api: {
    "repos/tauri-apps/tao/pulls/1376": { state: "closed", html_url: URL_1376, merged_at: "2026-11-20T00:00:00Z", merge_commit_sha: "m".repeat(40) },
    "repos/tauri-apps/tao/tags?per_page=100": [{ name: "tao-v0.37.3", commit: { sha: "s3" } }, { name: "tao-v0.37.2", commit: { sha: "s2" } }],
    [`repos/tauri-apps/tao/compare/${"m".repeat(40)}...s3`]: { status: "ahead" },
  },
};

test("run: a released fix opens one issue, for the person named, labelled", (t) => {
  const { run, calls } = repo(t, PINNED, RELEASED);
  const out = run();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^tao: tauri-apps\/tao#1376 is released in tao-v0\.37\.3\.$/m);
  const create = calls().find((args) => args[0] === "issue" && args[1] === "create");
  assert(create, JSON.stringify(calls()));
  assert.equal(create[create.indexOf("--title") + 1], "Switch tao back to its own release: tauri-apps/tao#1376 is in tao-v0.37.3");
  assert.equal(create[create.indexOf("--label") + 1], "dependencies");
  assert.equal(create[create.indexOf("--assignee") + 1], "someone");
});

test("run: with its issue open already, it opens no second one", (t) => {
  const { run, calls } = repo(t, PINNED, { ...RELEASED, open: [{ title: "Switch tao back to its own release: tauri-apps/tao#1376 is in tao-v0.37.3" }] });
  const out = run();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Its issue is open already/);
  assert(!calls().some((args) => args[1] === "create"));
});

test("run: a fix still waiting opens nothing, and nothing pinned asks nothing", (t) => {
  const waiting = repo(t, PINNED, { api: { "repos/tauri-apps/tao/pulls/1376": { state: "open", html_url: URL_1376, merged_at: null } } });
  const out = waiting.run();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^tao: tauri-apps\/tao#1376 is waiting\.$/m);
  assert(!waiting.calls().some((args) => args[0] === "issue"));
  const none = repo(t, "[package]\nname = \"linger-client\"\n", { api: {} });
  assert.equal(none.run().stdout, "Nothing is pinned.\n");
  assert.deepEqual(none.calls(), []);
});

test("run: GitHub failing fails the run, so the nightly job shows it", (t) => {
  const { run } = repo(t, PINNED, { api: {} });
  assert.notEqual(run().status, 0);
});
