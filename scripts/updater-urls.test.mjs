import assert from "node:assert/strict";
import { test } from "node:test";
import { expectedFiles, missingFiles, rewrite } from "./updater-urls.mjs";

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
