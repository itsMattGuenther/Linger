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
// Usage: node scripts/updater-urls.mjs <latest.json> <assets.json> <repo> <tag>
//   assets.json is `gh release view <tag> --json assets`. The file is
//   rewritten in place.

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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [file, assetsFile, repo, tag] = process.argv.slice(2);
  if (!file || !assetsFile || !repo || !tag) {
    console.error("usage: updater-urls.mjs <latest.json> <assets.json> <repo> <tag>");
    process.exit(2);
  }
  const latest = JSON.parse(readFileSync(file, "utf8"));
  const { assets } = JSON.parse(readFileSync(assetsFile, "utf8"));
  const missing = missingFiles(assets, tag);
  if (missing.length > 0) {
    console.error(`${tag} is missing, or names differently: ${missing.join(", ")}`);
    process.exit(1);
  }
  const out = rewrite(latest, assets, repo, tag);
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  for (const [platform, entry] of Object.entries(out.platforms)) console.log(`${platform}: ${entry.url}`);
}
