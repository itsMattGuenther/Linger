#!/usr/bin/env node
// Makes the release's latest.json, once, after every desktop build has added
// its files (#828).
//
// latest.json is the file every installed copy reads to find an update
// (tauri.conf.json's updater endpoint). tauri-action used to write it: each
// build read the file from the release, added its own platforms and put it
// back. Two builds finishing at the same moment each read it before the other
// had put it back, and the second one's copy left the first one's platforms
// out. Nothing said so: the copies on those platforms just never heard of the
// update. So the builds only add their files and signatures now, and this
// writes the whole file from them. It fails, naming the platform, when a file
// or its signature is missing.
//
// Each link is the normal download link
// (https://github.com/<repo>/releases/download/<tag>/<file>), as 0.x wrote
// them. tauri-action 1.0 wrote GitHub API links, which GitHub allows 60
// unauthenticated requests an hour per address: a household or a LAN with
// several copies behind one connection could see updates fail (#597).
//
// It also checks the desktop files are named as before: the website, the Arch
// package job (arch-repo.yml) and docs/releasing.md all find them by name.
//
// And it sets `notes` to the release's one line about what's in it (#772),
// from client/src/next/core/release-line.json, which the release pull
// request fills in. Installed copies show that line beside "Linger 0.5.4 is
// out". A release without its line gets no notes at all.
//
// Usage: node scripts/updater-urls.mjs <latest.json> <assets.json> <signatures> <repo> <tag> [<release-line.json>]
//   latest.json is written. assets.json is `gh release view <tag> --json
//   assets,isDraft,publishedAt`, and signatures a directory holding the
//   release's .sig files.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Each platform an installed copy looks itself up by in latest.json, and the
 * file it installs, as tauri-action 1.0 wrote them up to 0.5.4. A copy asks
 * for its own kind first (`windows-x86_64-nsis` for one the setup.exe
 * installed) and the bare platform after; the bare Windows one is the .msi,
 * tauri-action's default.
 */
export function platformFiles(tag) {
  const version = tag.replace(/^v/, "");
  const appImage = `Linger_${version}_amd64.AppImage`;
  const msi = `Linger_${version}_x64_en-US.msi`;
  return {
    "linux-x86_64": appImage,
    "linux-x86_64-appimage": appImage,
    "linux-x86_64-deb": `Linger_${version}_amd64.deb`,
    "linux-x86_64-rpm": `Linger-${version}-1.x86_64.rpm`,
    "windows-x86_64": msi,
    "windows-x86_64-msi": msi,
    "windows-x86_64-nsis": `Linger_${version}_x64-setup.exe`,
  };
}

/**
 * latest.json for every platform, from the release's files and their
 * signatures (`{ "<file>.sig": "<its text>" }`). Not dated and with no notes
 * yet: `datedFor` and `withLine` do those. Throws, naming the platform, when
 * its file or its signature isn't there.
 */
export function built(tag, repo, assets, signatures) {
  const names = new Set(assets.map((asset) => asset.name));
  const download = `https://github.com/${repo}/releases/download/${tag}/`;
  const platforms = {};
  for (const [platform, file] of Object.entries(platformFiles(tag))) {
    if (!names.has(file)) throw new Error(`${platform}: ${tag} hasn't got ${file}`);
    const signature = String(signatures[`${file}.sig`] ?? "").trim();
    if (signature === "" || !names.has(`${file}.sig`)) throw new Error(`${platform}: ${tag} hasn't got ${file}.sig`);
    platforms[platform] = { signature, url: download + encodeURIComponent(file) };
  }
  return { version: tag.replace(/^v/, ""), notes: "", pub_date: NOT_PUBLISHED, platforms };
}

/**
 * latest.json with `notes` set to this release's one line (#772), or empty
 * when the line names another version or none: a line left over from the
 * release before says nothing true about this one.
 */
export function withLine(latest, said, tag) {
  const version = tag.replace(/^v/, "");
  const line = typeof said?.line === "string" ? said.line.trim() : "";
  const ours = said?.version === version && line !== "" && !/[\r\n]/.test(line);
  return { ...latest, notes: ours ? line : "" };
}

/**
 * The date latest.json carries until the release is published: a day nobody
 * reaches, so no copy counts its day's wait from the build (#794 review).
 * Built, it can be days before it's published; a copy that looked in the
 * minute between publishing and `updater-date.yml` would have found it a day
 * old already. If that job never runs, nothing installs by itself, and
 * Restart now still works.
 */
export const NOT_PUBLISHED = "2999-01-01T00:00:00Z";

/** latest.json saying it isn't published yet (`NOT_PUBLISHED`). */
export function undated(latest) {
  return { ...latest, pub_date: NOT_PUBLISHED };
}

/**
 * latest.json dated by the release's own state: when it was published, or
 * not published yet while it's a draft. Running this job again after
 * publishing (a re-run, or after a desktop job is re-run) must not undate a
 * published release: nothing would date it again, and no copy would install
 * it by itself (#794 review). `release` is `gh release view --json
 * isDraft,publishedAt`.
 */
export function datedFor(latest, release) {
  const published = release?.isDraft === false && typeof release.publishedAt === "string" && release.publishedAt !== "";
  return published ? publishedAt(latest, release.publishedAt) : undated(latest);
}

/**
 * latest.json dated when the release was published (#772), not when it was
 * built: copies install a release by themselves only once it's a day old, and
 * that day is the head start of whoever presses Restart now.
 */
export function publishedAt(latest, at) {
  if (Number.isNaN(Date.parse(at))) throw new Error(`not a date: ${at}`);
  return { ...latest, pub_date: at };
}

/**
 * The desktop files the builds add to a release, by name, as 0.4.10's were.
 * latest.json isn't one: this writes it, after them.
 */
export function expectedFiles(tag) {
  const version = tag.replace(/^v/, "");
  const bundles = [
    `Linger_${version}_x64-setup.exe`,
    `Linger_${version}_x64_en-US.msi`,
    `Linger_${version}_amd64.AppImage`,
    `Linger_${version}_amd64.deb`,
    `Linger-${version}-1.x86_64.rpm`,
  ];
  return bundles.flatMap((name) => [name, `${name}.sig`]);
}

/** The expected files this release hasn't got. */
export function missingFiles(assets, tag) {
  const names = new Set(assets.map((asset) => asset.name));
  return expectedFiles(tag).filter((name) => !names.has(name));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href && process.argv[2] === "--published") {
  // updater-urls.mjs --published <latest.json> <when>: dated at publishing (#772).
  const [file, at] = process.argv.slice(3);
  if (!file || !at) {
    console.error("usage: updater-urls.mjs --published <latest.json> <when>");
    process.exit(2);
  }
  const out = publishedAt(JSON.parse(readFileSync(file, "utf8")), at);
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`pub_date: ${out.pub_date}`);
} else if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [file, assetsFile, signatureDir, repo, tag, lineFile] = process.argv.slice(2);
  if (!file || !assetsFile || !signatureDir || !repo || !tag) {
    console.error("usage: updater-urls.mjs <latest.json> <assets.json> <signatures> <repo> <tag> [<release-line.json>]");
    process.exit(2);
  }
  const release = JSON.parse(readFileSync(assetsFile, "utf8"));
  const { assets } = release;
  const missing = missingFiles(assets, tag);
  if (missing.length > 0) {
    console.error(`${tag} is missing, or names differently: ${missing.join(", ")}`);
    process.exit(1);
  }
  const signatures = {};
  for (const name of expectedFiles(tag).filter((name) => name.endsWith(".sig"))) {
    signatures[name] = readFileSync(join(signatureDir, name), "utf8");
  }
  // Dated by the release: not yet, while it's a draft (updater-date.yml
  // dates it when it's published), or when it was, on a run after that.
  let out = datedFor(built(tag, repo, assets, signatures), release);
  if (lineFile) {
    out = withLine(out, JSON.parse(readFileSync(lineFile, "utf8")), tag);
    // Said in the job's summary, so a release with no line is noticed.
    if (out.notes === "") console.log(`::warning::${lineFile} has no line for ${tag}: installed copies show none (docs/releasing.md)`);
    else console.log(`notes: ${out.notes}`);
  }
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  for (const [platform, entry] of Object.entries(out.platforms)) console.log(`${platform}: ${entry.url}`);
}
