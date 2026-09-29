// Nothing in a production build may be embedded as a `data:` URL that the
// shipped CSP refuses (#318).
//
// Vite embeds small assets in the code as `data:` URLs. The shipped policy
// allows `data:` for images only, so an embedded font or sound is refused in
// every installed app while `pnpm tauri dev`, which serves files, looks fine.
// Both Silkscreen faces went that way for a month. `vite.config.ts` now embeds
// nothing (`assetsInlineLimit: 0`); this reads the build and the policy and
// fails if anything slipped through anyway.
//
// Usage: node scripts/csp-assets.mjs [dist dir] [tauri.conf.json]
//   Defaults: client/dist and client/src-tauri/tauri.conf.json, from the repo.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A policy string as directive → sources, the way a browser splits it. */
export function parseCsp(policy) {
  const directives = new Map();
  for (const part of policy.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

/** Which directive governs an embedded asset of this type, or null for one no policy here covers. */
export function directiveFor(mime) {
  const type = mime.toLowerCase();
  if (type.startsWith("font/") || /^application\/(x-)?font/.test(type)) return "font-src";
  if (type.startsWith("image/")) return "img-src";
  if (type.startsWith("audio/") || type.startsWith("video/")) return "media-src";
  return null;
}

/** Whether the policy lets an asset of this type load from a `data:` URL. */
export function allowsData(directives, mime) {
  const directive = directiveFor(mime);
  if (directive === null) return true;
  const sources = directives.get(directive) ?? directives.get("default-src");
  // No directive and no default-src: nothing restricts it.
  if (sources === undefined) return true;
  return sources.includes("data:");
}

/**
 * Every embedded asset the policy would refuse: { file, mime, count }.
 * `files` is [{ name, text }], the build's CSS, JS and HTML.
 */
export function blockedDataUrls(policy, files) {
  const directives = parseCsp(policy);
  const blocked = [];
  for (const { name, text } of files) {
    const counts = new Map();
    for (const [, mime] of text.matchAll(/data:([a-z]+\/[a-z0-9.+-]+)/gi)) {
      if (!allowsData(directives, mime)) counts.set(mime, (counts.get(mime) ?? 0) + 1);
    }
    for (const [mime, count] of counts) blocked.push({ file: name, mime, count });
  }
  return blocked;
}

function builtFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !/\.(css|js|mjs|html)$/.test(entry.name)) continue;
    const path = join(entry.parentPath ?? entry.path, entry.name);
    files.push({ name: relative(dir, path), text: readFileSync(path, "utf8") });
  }
  return files;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dist = resolve(process.argv[2] ?? join(repo, "client/dist"));
  const conf = resolve(process.argv[3] ?? join(repo, "client/src-tauri/tauri.conf.json"));
  const policy = JSON.parse(readFileSync(conf, "utf8")).app?.security?.csp;
  if (typeof policy !== "string") {
    console.error(`csp-assets: no app.security.csp string in ${conf}`);
    process.exit(1);
  }
  const files = builtFiles(dist);
  if (files.length === 0) {
    console.error(`csp-assets: no built CSS, JS or HTML in ${dist}. Run vite build first.`);
    process.exit(1);
  }
  const blocked = blockedDataUrls(policy, files);
  if (blocked.length > 0) {
    console.error("csp-assets: the build embeds assets the shipped CSP refuses, so installed apps can't load them:");
    for (const { file, mime, count } of blocked) console.error(`  ${file}: ${count} × data:${mime}`);
    console.error("Ship them as files: keep build.assetsInlineLimit at 0 in client/vite.config.ts.");
    process.exit(1);
  }
  console.log(`csp-assets: ${files.length} built files, nothing embedded that the CSP refuses`);
}
