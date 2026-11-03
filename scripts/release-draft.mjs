#!/usr/bin/env node
// Makes the one draft release a tag's jobs add to, or finds the one an
// earlier run of the same tag made, and prints `id=<its id>` for
// $GITHUB_OUTPUT (#828).
//
// It runs once, in release.yml's `draft` job, before any build. The builds
// are handed the id and never look a release up by its tag: given a tag and
// no id, tauri-action makes a release whenever it finds none, and releasing
// 0.5.4 the Linux and Windows builds finished in the same second, each found
// none, and each made one. The files were split across two drafts, and the
// updater's latest.json across both.
//
// More than one release for the tag stops it rather than picking one: picking
// is how a split release goes unnoticed. A published one stops it too, as
// tauri-action 1.0 did: a run must not add to a release people already have.
//
// Usage: node scripts/release-draft.mjs <owner/repo> <tag>
//   with GH_TOKEN, and the draft's name and text in TITLE and BODY. It makes
//   the draft with them only when there isn't one: a run again keeps the
//   text somebody has edited since.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * What to do, given the repository's releases (as GitHub's API lists them):
 * `{ make: true }` when none has this tag, `{ id }` when one draft has it.
 * Throws when it's published, or when more than one has it.
 */
export function choose(releases, tag) {
  const ours = releases.filter((release) => release.tag_name === tag);
  if (ours.length === 0) return { make: true };
  if (ours.length > 1) {
    const which = ours.map((release) => `${release.id}${release.draft ? " (draft)" : ""}`).join(", ");
    throw new Error(`${tag} has ${ours.length} releases: ${which}. Keep the one with every file, delete the rest, then run again`);
  }
  const [only] = ours;
  if (only.draft !== true) throw new Error(`${tag} is published already, and a run doesn't change a published release: ${only.html_url}`);
  return { id: only.id };
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [repo, tag] = process.argv.slice(2);
  const { TITLE: title, BODY: body } = process.env;
  if (!repo || !tag || !title || !body) {
    console.error("usage: TITLE=… BODY=… release-draft.mjs <owner/repo> <tag>");
    process.exit(2);
  }
  try {
    // The tag must be on GitHub already: a release for a missing tag would
    // make it, on publishing, from whatever main is then.
    try {
      gh(["api", `repos/${repo}/git/ref/tags/${tag}`, "--jq", ".ref"]);
    } catch {
      throw new Error(`${tag} isn't a tag on GitHub, so there's nothing to release`);
    }
    // Drafts are in this list (the token can push), not in the by-tag lookup.
    const listed = gh(["api", "--paginate", `repos/${repo}/releases?per_page=100`, "--jq", ".[] | {id, tag_name, draft, html_url}"]);
    const releases = listed === "" ? [] : listed.split("\n").map((line) => JSON.parse(line));
    let { id } = choose(releases, tag);
    if (id === undefined) {
      const made = gh([
        "api", "--method", "POST", `repos/${repo}/releases`,
        "-f", `tag_name=${tag}`, "-f", `name=${title}`, "-f", `body=${body}`,
        "-F", "draft=true", "-F", "prerelease=false", "--jq", ".id",
      ]);
      id = Number(made);
      console.error(`made a draft for ${tag}: ${id}`);
    } else {
      console.error(`${tag}'s draft is there already, from an earlier run: ${id}`);
    }
    if (!Number.isInteger(id) || id <= 0) throw new Error(`not a release id: ${id}`);
    console.log(`id=${id}`);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
