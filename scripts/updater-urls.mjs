#!/usr/bin/env node
// Points latest.json at ordinary download links (#597).
//
// latest.json is the file every installed copy reads to find an update
// (tauri.conf.json's updater endpoint). tauri-action 1.0 writes each
// platform's `url` as a GitHub API link
// (https://api.github.com/repos/<repo>/releases/assets/<id>), which GitHub
// allows 60 unauthenticated requests an hour per address: a household or a
// LAN with several copies behind one connection could see updates fail. The
// normal download link (https://github.com/<repo>/releases/download/<tag>/
// <file>) has no such limit, and is what 0.x wrote. This rewrites every API
// link to it, using the release's own asset list to turn an asset id into its
// file name, and fails if any `url` would be left anywhere else.
//
// It also checks the desktop files are named as before: 1.0 labels each
// upload with its file name, and the website, the Arch package job
// (arch-repo.yml) and docs/releasing.md all find the files by name.
//
// And it sets `notes` to the release's one line about what's in it (#772),
// from client/src/next/core/release-line.json, which the release pull
// request fills in. Installed copies show that line beside "Linger 0.5.4 is
// out". tauri-action writes the release's whole install section there, which
// is no use to them, so a release without its line gets no notes at all.
//
// Usage: node scripts/updater-urls.mjs <latest.json> <assets.json> <repo> <tag> [<release-line.json>]
//   assets.json is `gh release view <tag> --json assets,isDraft,publishedAt`.
//   The file is rewritten in place.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * latest.json with every platform's url as a normal download link. Throws,
 * naming the platform, for a url that is neither an API link to one of the
 * release's assets nor already the right download link.
 */
export function rewrite(latest, assets, repo, tag) {
  const named = new Map(assets.map((asset) => [asset.apiUrl, asset.name]));
  const names = new Set(assets.map((asset) => asset.name));
  const download = `https://github.com/${repo}/releases/download/${tag}/`;
  const platforms = {};
  for (const [platform, entry] of Object.entries(latest.platforms ?? {})) {
    const url = String(entry.url ?? "");
    let name = named.get(url);
    if (name === undefined && url.startsWith(download)) name = decodeURIComponent(url.slice(download.length));
    if (name === undefined || !names.has(name)) {
      throw new Error(`${platform}: ${url || "no url"} isn't one of ${tag}'s files`);
    }
    platforms[platform] = { ...entry, url: download + encodeURIComponent(name) };
  }
  if (Object.keys(platforms).length === 0) throw new Error("latest.json lists no platforms");
  const out = { ...latest, platforms };
  if (JSON.stringify(out).includes("api.github.com")) throw new Error("an api.github.com link is left in latest.json");
  return out;
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
 * tauri-action dates it when it's built, which can be days before it's
 * published; a copy that looked in the minute between publishing and
 * `updater-date.yml` would have found it a day old already. If that job never
 * runs, nothing installs by itself, and Restart now still works.
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
 * that day is the head start of whoever presses Restart now. tauri-action
 * dates it at build time, which can be hours before the release goes out.
 */
export function publishedAt(latest, at) {
  if (Number.isNaN(Date.parse(at))) throw new Error(`not a date: ${at}`);
  return { ...latest, pub_date: at };
}

/** The desktop files a release carries, by name, as 0.4.10's were. */
export function expectedFiles(tag) {
  const version = tag.replace(/^v/, "");
  const bundles = [
    `Linger_${version}_x64-setup.exe`,
    `Linger_${version}_x64_en-US.msi`,
    `Linger_${version}_amd64.AppImage`,
    `Linger_${version}_amd64.deb`,
    `Linger-${version}-1.x86_64.rpm`,
  ];
  return [...bundles.flatMap((name) => [name, `${name}.sig`]), "latest.json"];
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
  const [file, assetsFile, repo, tag, lineFile] = process.argv.slice(2);
  if (!file || !assetsFile || !repo || !tag) {
    console.error("usage: updater-urls.mjs <latest.json> <assets.json> <repo> <tag> [<release-line.json>]");
    process.exit(2);
  }
  const latest = JSON.parse(readFileSync(file, "utf8"));
  const release = JSON.parse(readFileSync(assetsFile, "utf8"));
  const { assets } = release;
  const missing = missingFiles(assets, tag);
  if (missing.length > 0) {
    console.error(`${tag} is missing, or names differently: ${missing.join(", ")}`);
    process.exit(1);
  }
  // Dated by the release: not yet, while it's a draft (updater-date.yml
  // dates it when it's published), or when it was, on a run after that.
  let out = datedFor(rewrite(latest, assets, repo, tag), release);
  if (lineFile) {
    out = withLine(out, JSON.parse(readFileSync(lineFile, "utf8")), tag);
    // Said in the job's summary, so a release with no line is noticed.
    if (out.notes === "") console.log(`::warning::${lineFile} has no line for ${tag}: installed copies show none (docs/releasing.md)`);
    else console.log(`notes: ${out.notes}`);
  }
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  for (const [platform, entry] of Object.entries(out.platforms)) console.log(`${platform}: ${entry.url}`);
}
