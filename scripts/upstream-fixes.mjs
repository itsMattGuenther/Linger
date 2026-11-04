// Whether a fix Linger pins from its own copy has come out upstream (#836).
// client/src-tauri/Cargo.toml takes a crate from Linger's copy
// (`[patch.crates-io]`) while a fix waits upstream, and names the pull
// request it waits for (`# upstream: owner/repo#N`, read by
// `patches` in scripts/tauri-versions.mjs). The nightly run asks GitHub about
// each: once the fix is in a release, or the pull request is closed without
// it, an issue says so, so the copy is dropped the day it can be, and nobody
// has to remember to look.
//
// Usage: node scripts/upstream-fixes.mjs   (in the repository; needs `gh`)
//   GH_TOKEN, GH_REPO: as gh reads them. LINGER_ASSIGNEE: who the issue is for.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CARGO_TOML, patches } from "./tauri-versions.mjs";

/** GitHub's REST API through gh, as JSON: `one` for an answer, `all` for every page of a list. */
const github = {
  one: (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" })),
  all: (path) => JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", path], { encoding: "utf8" })),
};

/**
 * Where a pin's fix stands: "waiting" (not merged), "merged" (no release
 * has it yet), "released" (in `tag`), or "closed" (closed without merging).
 * Release tags are the crate's own (`tao-v0.37.3`), every page of them:
 * GitHub lists tags by name, not by date. A tag has the fix when GitHub's
 * comparison from the merge to the tag is ahead or identical, and each one
 * is asked: a release from an older line can have it while a newer one,
 * cut from another branch, doesn't (#850's review). The oldest by version
 * that has it is the one named. A fix carried to another branch as a copy
 * of its commits is a different commit, which this can't see.
 */
export function standing(pin, gh = github) {
  const [repo, number] = pin.upstream.split("#");
  const pr = gh.one(`repos/${repo}/pulls/${number}`);
  if (typeof pr?.state !== "string") throw new Error(`${pin.upstream}: GitHub's answer has no state`);
  if (!pr.merged_at) return { pin, url: pr.html_url, state: pr.state === "closed" ? "closed" : "waiting" };
  const pages = gh.all(`repos/${repo}/tags?per_page=100`);
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error(`${repo}: GitHub's tags aren't a list of pages`);
  // By version, not by name: as text, 0.37.9 sorts after 0.37.10.
  const version = (tag) => new RegExp(`^${pin.name}-v(\\d+)\\.(\\d+)\\.(\\d+)$`).exec(tag.name)?.slice(1).map(Number);
  const own = pages.flat().filter(version).sort((a, b) => {
    const [x, y] = [version(a), version(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  const found = own.find((tag) => {
    const { status } = gh.one(`repos/${repo}/compare/${pr.merge_commit_sha}...${tag.commit.sha}`);
    return status === "ahead" || status === "identical";
  });
  return found ? { pin, url: pr.html_url, state: "released", tag: found.name } : { pin, url: pr.html_url, state: "merged" };
}

/** The issue a standing calls for, or null while there's nothing to do. */
export function issueFor({ pin, url, state, tag }) {
  if (state === "released") {
    return {
      title: `Switch ${pin.name} back to its own release: ${pin.upstream} is in ${tag}`,
      body: `Linger builds ${pin.name} from its own copy (${pin.git} at ${pin.rev.slice(0, 8)}) until ${url} comes out, and it has, in \`${tag}\`.

1. Check the Tauri version Linger uses accepts \`${tag}\`. If it doesn't, this waits for a Tauri release that does.
2. Delete the pin and its comment from \`client/src-tauri/Cargo.toml\`, and run \`cargo update -p ${pin.name}\` in \`client/src-tauri\`.
3. The iPhone simulator's \`link-closed\` flow, and \`scripts/tauri-versions.mjs\`, prove the release does what the copy did.

Opened by the nightly run (\`scripts/upstream-fixes.mjs\`).`,
    };
  }
  if (state === "closed") {
    return {
      title: `The fix Linger pins for ${pin.name} was closed without merging: ${pin.upstream}`,
      body: `Linger builds ${pin.name} from its own copy (${pin.git} at ${pin.rev.slice(0, 8)}) until ${url} comes out, and it was closed without merging. Find what replaced it, and point the pin's \`# upstream:\` line in \`client/src-tauri/Cargo.toml\` at that.

Opened by the nightly run (\`scripts/upstream-fixes.mjs\`).`,
    };
  }
  return null;
}

function run() {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const pins = patches(readFileSync(join(root, CARGO_TOML), "utf8"));
  if (!pins.length) return console.log("Nothing is pinned.");
  for (const pin of pins) {
    const now = standing(pin);
    console.log(`${pin.name}: ${pin.upstream} is ${now.state}${now.tag ? ` in ${now.tag}` : ""}.`);
    const issue = issueFor(now);
    if (!issue) continue;
    const open = JSON.parse(execFileSync("gh", ["issue", "list", "--state", "open", "--search", `"${issue.title}" in:title`, "--json", "title"], { encoding: "utf8" }));
    if (open.some((each) => each.title === issue.title)) {
      console.log(`  Its issue is open already: ${issue.title}`);
      continue;
    }
    const assignee = process.env.LINGER_ASSIGNEE ? ["--assignee", process.env.LINGER_ASSIGNEE] : [];
    execFileSync("gh", ["issue", "create", "--title", issue.title, "--body", issue.body, "--label", "dependencies", ...assignee], { stdio: "inherit" });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
