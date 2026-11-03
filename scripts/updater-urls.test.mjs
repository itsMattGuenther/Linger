import assert from "node:assert/strict";
import { test } from "node:test";
import { built, datedFor, expectedFiles, missingFiles, NOT_PUBLISHED, platformFiles, publishedAt, undated, withLine } from "./updater-urls.mjs";

const repo = "itsMattGuenther/Linger";
const tag = "v0.4.11";
const download = (name) => `https://github.com/${repo}/releases/download/${tag}/${name}`;
const files = expectedFiles(tag).map((name) => ({ name, apiUrl: `https://api.github.com/repos/${repo}/releases/assets/1` }));
const signatures = Object.fromEntries(expectedFiles(tag).filter((name) => name.endsWith(".sig")).map((name) => [name, `signed ${name}`]));

test("every platform installed copies ask for is there, as 0.5.4's latest.json had them (#828)", () => {
  // 0.5.4's published latest.json, each platform's file.
  assert.deepEqual(platformFiles("v0.5.4"), {
    "windows-x86_64": "Linger_0.5.4_x64_en-US.msi",
    "windows-x86_64-msi": "Linger_0.5.4_x64_en-US.msi",
    "windows-x86_64-nsis": "Linger_0.5.4_x64-setup.exe",
    "linux-x86_64": "Linger_0.5.4_amd64.AppImage",
    "linux-x86_64-appimage": "Linger_0.5.4_amd64.AppImage",
    "linux-x86_64-deb": "Linger_0.5.4_amd64.deb",
    "linux-x86_64-rpm": "Linger-0.5.4-1.x86_64.rpm",
  });
});

test("latest.json is made from the release's files and their signatures, with normal download links (#828, #597)", () => {
  const out = built(tag, repo, files, signatures);
  assert.equal(out.version, "0.4.11");
  assert.equal(Object.keys(out.platforms).length, 7);
  assert.deepEqual(out.platforms["windows-x86_64-nsis"], {
    signature: "signed Linger_0.4.11_x64-setup.exe.sig",
    url: download("Linger_0.4.11_x64-setup.exe"),
  });
  assert.equal(out.platforms["linux-x86_64-rpm"].url, download("Linger-0.4.11-1.x86_64.rpm"));
  assert.ok(!JSON.stringify(out).includes("api.github.com"), "no API link, which GitHub allows 60 times an hour (#597)");
  assert.equal(out.pub_date, NOT_PUBLISHED, "not dated until datedFor says so");
  // A .sig file's line ending isn't part of the signature.
  assert.equal(built(tag, repo, files, { ...signatures, "Linger_0.4.11_amd64.deb.sig": "abc==\n" }).platforms["linux-x86_64-deb"].signature, "abc==");
});

test("a platform whose file or signature is missing fails, naming it, rather than leaving copies without the update (#828)", () => {
  const noDeb = files.filter((file) => file.name !== "Linger_0.4.11_amd64.deb");
  assert.throws(() => built(tag, repo, noDeb, signatures), /^Error: linux-x86_64-deb: v0\.4\.11 hasn't got Linger_0\.4\.11_amd64\.deb$/);
  const { "Linger_0.4.11_x64-setup.exe.sig": _, ...noExeSignature } = signatures;
  assert.throws(() => built(tag, repo, files, noExeSignature), /windows-x86_64-nsis/);
  assert.throws(() => built(tag, repo, files, { ...signatures, "Linger_0.4.11_x64_en-US.msi.sig": " " }), /windows-x86_64: /);
  const noMsiSigFile = files.filter((file) => file.name !== "Linger_0.4.11_x64_en-US.msi.sig");
  assert.throws(() => built(tag, repo, noMsiSigFile, signatures), /windows-x86_64: .*msi\.sig/, "a signature not on the release isn't one copies can check");
});

test("the desktop files keep the names the site, the Arch job and the docs look for", () => {
  const names = expectedFiles("v0.4.10");
  assert.equal(names.length, 10, "five bundles and their signatures; latest.json is written after");
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

test("the feed is dated by the release: not yet as a draft, and never undated once it's out (#794 review)", () => {
  const latest = { version: "0.4.11", pub_date: "2026-10-27T21:49:05.872Z", platforms: {} };
  assert.equal(datedFor(latest, { isDraft: true, publishedAt: null }).pub_date, NOT_PUBLISHED);
  // Run again after publishing: it keeps the publishing date, which nothing else would put back.
  assert.equal(datedFor(latest, { isDraft: false, publishedAt: "2026-10-28T09:00:00Z" }).pub_date, "2026-10-28T09:00:00Z");
  // Anything it can't read is taken as not published: nothing installs by itself early.
  assert.equal(datedFor(latest, {}).pub_date, NOT_PUBLISHED);
  assert.equal(datedFor(latest, null).pub_date, NOT_PUBLISHED);
});
