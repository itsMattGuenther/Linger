import assert from "node:assert/strict";
import { test } from "node:test";
import { expectedFiles, missingFiles, NOT_PUBLISHED, publishedAt, rewrite, undated, withLine } from "./updater-urls.mjs";

const repo = "itsMattGuenther/Linger";
const tag = "v0.4.11";
const api = (id) => `https://api.github.com/repos/${repo}/releases/assets/${id}`;
const assets = [
  { apiUrl: api(1), name: "Linger_0.4.11_x64-setup.exe" },
  { apiUrl: api(2), name: "Linger_0.4.11_x64_en-US.msi" },
  { apiUrl: api(3), name: "Linger_0.4.11_amd64.AppImage" },
  { apiUrl: api(4), name: "latest.json" },
];
const entry = (url) => ({ signature: "sig", url });

test("tauri-action 1.0's API links become normal download links (#597)", () => {
  const out = rewrite(
    { version: "0.4.11", notes: "n", pub_date: "d", platforms: { "windows-x86_64-nsis": entry(api(1)), "linux-x86_64": entry(api(3)) } },
    assets,
    repo,
    tag,
  );
  assert.deepEqual(out.platforms, {
    "windows-x86_64-nsis": entry(`https://github.com/${repo}/releases/download/${tag}/Linger_0.4.11_x64-setup.exe`),
    "linux-x86_64": entry(`https://github.com/${repo}/releases/download/${tag}/Linger_0.4.11_amd64.AppImage`),
  });
  assert.equal(out.version, "0.4.11", "the rest of the file is kept");
  assert.equal(out.platforms["linux-x86_64"].signature, "sig");
});

test("links that are already right stay as they are, as 0.x wrote them", () => {
  const url = `https://github.com/${repo}/releases/download/${tag}/Linger_0.4.11_x64_en-US.msi`;
  assert.equal(rewrite({ platforms: { "windows-x86_64": entry(url) } }, assets, repo, tag).platforms["windows-x86_64"].url, url);
});

test("a link to a file this release hasn't got fails, naming the platform", () => {
  assert.throws(() => rewrite({ platforms: { "linux-x86_64-deb": entry(api(99)) } }, assets, repo, tag), /linux-x86_64-deb/);
  assert.throws(
    () => rewrite({ platforms: { "linux-x86_64": entry(`https://github.com/${repo}/releases/download/v0.4.10/Linger_0.4.11_amd64.AppImage`) } }, assets, repo, tag),
    /linux-x86_64/,
    "another release's link",
  );
  assert.throws(() => rewrite({ platforms: { "linux-x86_64": { signature: "s" } } }, assets, repo, tag), /no url/);
});

test("an empty latest.json fails rather than shipping no update", () => {
  assert.throws(() => rewrite({ platforms: {} }, assets, repo, tag), /no platforms/);
});

test("no api.github.com link is left anywhere in the file", () => {
  assert.throws(
    () => rewrite({ notes: `see ${api(1)}`, platforms: { "linux-x86_64": entry(api(3)) } }, assets, repo, tag),
    /api\.github\.com/,
  );
});

test("the desktop files keep the names the site, the Arch job and the docs look for", () => {
  const names = expectedFiles("v0.4.10");
  assert.equal(names.length, 11, "five bundles, five signatures, latest.json");
  // v0.4.10's release, less its Android file, which isn't tauri-action's.
  const released = [
    "latest.json",
    "Linger-0.4.10-1.x86_64.rpm",
    "Linger-0.4.10-1.x86_64.rpm.sig",
    "Linger_0.4.10_amd64.AppImage",
    "Linger_0.4.10_amd64.AppImage.sig",
    "Linger_0.4.10_amd64.deb",
    "Linger_0.4.10_amd64.deb.sig",
    "Linger_0.4.10_x64-setup.exe",
    "Linger_0.4.10_x64-setup.exe.sig",
    "Linger_0.4.10_x64_en-US.msi",
    "Linger_0.4.10_x64_en-US.msi.sig",
  ];
  assert.deepEqual(missingFiles(released.map((name) => ({ name })), "v0.4.10"), []);
  assert.deepEqual(
    missingFiles(released.filter((name) => !name.endsWith(".deb")).map((name) => ({ name })), "v0.4.10"),
    ["Linger_0.4.10_amd64.deb"],
  );
});

test("the notes become this release's one line, and nothing else (#772)", () => {
  const latest = { version: "0.4.11", notes: "**This is the Linger app**\n\nIt is not the server.", platforms: {} };
  assert.equal(withLine(latest, { version: "0.4.11", line: " Screen sharing, and fixes for voice. " }, tag).notes, "Screen sharing, and fixes for voice.");
  // Left over from the release before: says nothing true about this one.
  assert.equal(withLine(latest, { version: "0.4.10", line: "Fixes for voice." }, tag).notes, "");
  // None written: no notes, never tauri-action's install section.
  assert.equal(withLine(latest, { version: "0.4.11", line: "" }, tag).notes, "");
  assert.equal(withLine(latest, { version: "0.4.11", line: "two\nlines" }, tag).notes, "");
  assert.equal(withLine(latest, null, tag).notes, "");
  // Everything else is left as it was.
  assert.deepEqual(withLine(latest, { version: "0.4.11", line: "x" }, tag), { ...latest, notes: "x" });
});

test("the line's file is where the job reads it, and well formed (#772)", async () => {
  const { readFileSync } = await import("node:fs");
  const said = JSON.parse(readFileSync(new URL("../client/src/next/core/release-line.json", import.meta.url), "utf8"));
  assert.equal(typeof said.version, "string");
  assert.equal(typeof said.line, "string");
});

test("the feed is dated when the release went out, not when it was built (#772)", () => {
  const latest = { version: "0.4.11", pub_date: "2026-10-27T21:49:05.872Z", platforms: {} };
  assert.deepEqual(publishedAt(latest, "2026-10-28T09:00:00Z"), { ...latest, pub_date: "2026-10-28T09:00:00Z" });
  assert.throws(() => publishedAt(latest, "soon"), /not a date/);
});

test("until it's published, the feed says it isn't, so no copy counts its day from the build (#794 review)", () => {
  const latest = { version: "0.4.11", pub_date: "2026-10-27T21:49:05.872Z", platforms: {} };
  assert.deepEqual(undated(latest), { ...latest, pub_date: NOT_PUBLISHED });
  assert.ok(Date.parse(NOT_PUBLISHED) > Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
});
