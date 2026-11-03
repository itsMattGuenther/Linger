// A tag's release is made once, before the builds, and the builds add to it
// by its id (#828). Releasing 0.5.4, the Linux and Windows builds finished in
// the same second; each looked for a draft with the tag's name, found none,
// and made one, so the files and latest.json were split across two drafts.
//
// These read the workflows without a YAML library, as
// workflow-downloads.test.mjs does: a job is a two-space key under `jobs:`,
// and its settings are four spaces in. A job's code is its own lines, every
// script they run (followed into the scripts those run), the repository's
// own actions it uses and the workflows it calls. What it can't read (a
// script that isn't there, a `with:` written on one line, a release action
// it doesn't know) is a problem, named, never a quiet pass
// (docs/testing-strategy.md). The tables below hold every way to write what
// it looks for.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { choose } from "./release-draft.mjs";

const root = new URL("../", import.meta.url);

/** One of the repository's files, or null when it isn't there. */
function repoFile(path) {
  try {
    return readFileSync(new URL(path.replace(/^\.\//, ""), root), "utf8");
  } catch {
    return null;
  }
}

/** A YAML scalar without its quotes. */
const bare = (value) => value.trim().replace(/^(["'])(.*)\1$/, "$2");

/**
 * Code as it runs: comment lines dropped (YAML's and the shell's #,
 * JavaScript's // and /* *​/), and a line continued with a backslash joined
 * to the next.
 */
export function codeText(text) {
  return text
    .split("\n")
    .filter((line) => !/^\s*(#|\/\/|\/?\*)/.test(line))
    .join("\n")
    .replace(/\\\r?\n\s*/g, " ");
}

/** The releases list in an API path: not one release, nor its files. */
const RELEASES = /\/releases(?=$|[\s"'`?])/m;
const lines = (code) => code.split("\n");

/** Each way code can make a release, by what it's called in a problem. */
const MAKES = {
  "gh release create": (code) => /\bgh\s+release\s+(?:create|new)\b/.test(code),
  // gh api sends POST when it's given a field, whether or not it says so.
  "gh api writing to the releases list": (code) =>
    lines(code).some(
      (line) =>
        /\bgh\s+api\b/.test(line) &&
        RELEASES.test(line) &&
        (/\s(?:-i?X|--method)(?:\s*|=)["']?post\b/i.test(line) || /\s(?:-i?[fF]|--field|--raw-field|--input)/.test(line)),
    ),
  "a POST to the releases list": (code) =>
    lines(code).some(
      (line) =>
        /\b(?:curl|wget)\b/.test(line) &&
        RELEASES.test(line) &&
        /\s(?:-X|--request)(?:\s*|=)["']?post\b|\s(?:-d|-F|--data[\w-]*|--json|--form|--post-data)\b/i.test(line),
    ),
  "octokit's createRelease": (code) => /\bcreateRelease\b/.test(code),
  // gh called from JavaScript: the words are an array's strings.
  "gh, from a script's own code": (code) =>
    /["'`]release["'`]\s*,\s*["'`](?:create|new)["'`]/.test(code) ||
    (/["'`](?:--method|-X)["'`]\s*,\s*["'`]post["'`]/i.test(code) && RELEASES.test(code)),
};

/** Each way code can add to or change a release. */
const WRITES = {
  "gh release": (code) => /\bgh\s+release\s+(?:upload|edit|delete|delete-asset)\b/.test(code),
  "gh api": (code) =>
    lines(code).some(
      (line) =>
        /\bgh\s+api\b/.test(line) &&
        /\/releases\//.test(line) &&
        (/\s(?:-i?X|--method)(?:\s*|=)["']?(?:post|patch|put|delete)\b/i.test(line) || /\s(?:-i?[fF]|--field|--raw-field|--input)/.test(line)),
    ),
  "an upload": (code) => /uploads\.github\.com|\buploadReleaseAsset\b|\bupdateRelease\b/.test(code),
  "gh, from a script's own code": (code) => /["'`]release["'`]\s*,\s*["'`](?:upload|edit|delete|delete-asset)["'`]/.test(code),
};

const TAURI_ACTION = /^\s*(?:-\s+)?uses:\s*["']?tauri-apps\/tauri-action@/;

/** Each job in a workflow: its key, and its lines. */
export function jobsOf(text) {
  const all = text.split("\n");
  const start = all.findIndex((line) => /^jobs:\s*(#.*)?$/.test(line));
  if (start < 0) return [];
  const jobs = [];
  for (const line of all.slice(start + 1)) {
    const key = /^ {2}(["']?)([A-Za-z0-9_-]+)\1:\s*(#.*)?$/.exec(line);
    if (key) jobs.push({ name: key[2], lines: [] });
    else if (/^[^\s#]/.test(line)) break;
    else if (jobs.length > 0) jobs.at(-1).lines.push(line);
  }
  return jobs;
}

/**
 * The jobs a job needs: `needs: a`, `needs: [a, b]`, or a list under it,
 * quoted or not. Null when it says `needs:` in some other way.
 */
export function needsOf(job) {
  const at = job.lines.findIndex((line) => /^ {4}needs:/.test(line));
  if (at < 0) return [];
  const rest = job.lines[at].replace(/^ {4}needs:\s*/, "").replace(/\s+#.*$/, "").trim();
  let out = [];
  if (/^\[.*\]$/.test(rest)) out = rest.slice(1, -1).split(",").map(bare).filter(Boolean);
  else if (rest !== "") out = [bare(rest)];
  else {
    for (const line of job.lines.slice(at + 1)) {
      const item = /^ {6}-\s*(\S.*?)\s*(#.*)?$/.exec(line);
      if (!item) break;
      out.push(bare(item[1]));
    }
  }
  return out.length > 0 && out.every((name) => /^[A-Za-z0-9_-]+$/.test(name)) ? out : null;
}

const indent = (line) => line.length - line.trimStart().length;
const blank = (line) => /^\s*(#.*)?$/.test(line);

/**
 * The inputs (`with:`) of each tauri-action step in some lines, by name,
 * unquoted. `unreadable` when `with:` is written on its own line's end.
 */
export function tauriActionSteps(stepLines) {
  const out = [];
  stepLines.forEach((line, at) => {
    if (!TAURI_ACTION.test(line)) return;
    // The step starts at its dash: this line's, or the nearest one above.
    let first = at;
    while (first > 0 && !/^\s*-\s/.test(stepLines[first])) first -= 1;
    const dash = indent(stepLines[first]);
    let last = at + 1;
    while (last < stepLines.length && (blank(stepLines[last]) || indent(stepLines[last]) > dash)) last += 1;
    const step = stepLines.slice(first, last);
    const inputs = new Map();
    const withAt = step.findIndex((text) => /^\s*(?:-\s+)?with:/.test(text));
    if (withAt >= 0 && !/^\s*(?:-\s+)?with:\s*(#.*)?$/.test(step[withAt])) {
      out.push({ inputs, unreadable: true });
      return;
    }
    if (withAt >= 0) {
      const depth = indent(step[withAt]);
      let inner = null;
      for (const text of step.slice(withAt + 1)) {
        if (blank(text)) continue;
        if (indent(text) <= depth) break;
        inner ??= indent(text);
        const input = /^\s*(["']?)([A-Za-z][\w-]*)\1:\s*(.*?)\s*(?:\s#.*)?$/.exec(text);
        if (input && indent(text) === inner) inputs.set(input[2], bare(input[3]));
      }
    }
    out.push({ inputs, unreadable: false });
  });
  return out;
}

/** The scripts some code runs, as paths from the repository (or a working directory). */
function scriptPaths(code) {
  const found = new Set();
  const pattern = /(?:^|[\s"'=(:`])(?:\.\/)?((?:[\w.-]+\/)*scripts\/[\w./-]+?\.(?:sh|bash|mjs|cjs|js|py|ps1))(?=$|[\s"'`);:,])/gm;
  for (const match of code.matchAll(pattern)) found.add(match[1]);
  return [...found];
}

/**
 * What a job's code does to releases: what it makes one with, whether it
 * adds to one, its tauri-action steps, and what it couldn't read. Its code
 * is its lines, every script they run, the repository's own actions and the
 * workflows it calls.
 */
export function releaseWork(job, seen = new Set()) {
  const work = { makes: [], writes: false, tauri: [], unreadable: [] };
  const dirs = job.lines.map((line) => /^\s*(?:-\s+)?working-directory:\s*(\S.*?)\s*$/.exec(line)?.[1]).filter(Boolean).map(bare);
  // Folders a checkout put the repository in (`path:`): a script there is the repository's.
  const checkouts = job.lines.map((line) => /^\s*path:\s*(\S+)\s*$/.exec(line)?.[1]).filter(Boolean).map(bare);
  // `code` is a workflow's, an action's or a shell script's, from `from`'s
  // folder: what it runs is followed. A JavaScript or Python script is read
  // for what it does to releases, but the paths in it aren't followed: they
  // are mostly data. A test is skipped: it checks, and never releases, and
  // its tables name the very commands this looks for.
  const read = (code, where, from = "") => {
    for (const [name, makes] of Object.entries(MAKES)) if (makes(code)) work.makes.push(`${name}${where}`);
    if (Object.values(WRITES).some((writes) => writes(code))) work.writes = true;
    const action = /^\s*(?:-\s+)?uses:\s*["']?([\w.-]+\/[\w./-]+)@/gm;
    for (const [, name] of code.matchAll(action)) {
      if (/release/i.test(name) && name !== "tauri-apps/tauri-action") {
        work.unreadable.push(`uses ${name}${where}, which may make a release: read it, and add it to MAKES or WRITES`);
      }
    }
    for (const path of scriptPaths(code)) {
      if (/\.test\.\w+$|-test\.(?:sh|bash)$/.test(path)) continue;
      const places = [
        path,
        ...dirs.map((dir) => `${dir}/${path}`),
        ...(from ? [`${from}/${path}`] : []),
        ...checkouts.filter((folder) => path.startsWith(`${folder}/`)).map((folder) => path.slice(folder.length + 1)),
      ];
      const found = places.map((place) => new URL(place, root).pathname.slice(new URL(root).pathname.length)).find((place) => repoFile(place) !== null);
      if (found === undefined) {
        work.unreadable.push(`runs ${path}${where}, which isn't there to read`);
        continue;
      }
      if (seen.has(found)) continue;
      seen.add(found);
      const text = codeText(repoFile(found));
      const folder = found.replace(/\/[^/]*$/, "");
      if (/\.(?:sh|bash|ps1)$/.test(found)) read(text, ` (in ${found})`, folder);
      else {
        for (const [name, makes] of Object.entries(MAKES)) if (makes(text)) work.makes.push(`${name} (in ${found})`);
        if (Object.values(WRITES).some((writes) => writes(text))) work.writes = true;
      }
    }
  };
  const own = codeText(job.lines.join("\n"));
  read(own, "");
  for (const step of tauriActionSteps(job.lines)) work.tauri.push(step);
  // The repository's own actions, and workflows called as a job.
  for (const [, path] of own.matchAll(/^\s*(?:-\s+)?uses:\s*["']?(\.\/[\w./-]+?)["']?\s*$/gm)) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (/\.ya?ml$/.test(path)) {
      const text = repoFile(path);
      if (text === null) work.unreadable.push(`calls ${path}, which isn't there to read`);
      for (const called of text === null ? [] : jobsOf(text)) {
        const inner = releaseWork(called, seen);
        work.makes.push(...inner.makes.map((how) => `${how} (in ${path})`));
        work.writes ||= inner.writes || inner.tauri.length > 0;
        work.unreadable.push(...inner.unreadable);
        if (inner.tauri.length > 0) work.makes.push(`tauri-action (in ${path})`);
      }
    } else {
      const text = repoFile(`${path}/action.yml`) ?? repoFile(`${path}/action.yaml`);
      if (text === null) work.unreadable.push(`uses ${path}, which isn't there to read`);
      else if (TAURI_ACTION.test(text) || /tauri-apps\/tauri-action@/.test(text)) work.unreadable.push(`uses tauri-action inside ${path}, where this can't check its inputs`);
      else read(codeText(text), ` (in ${path})`);
    }
  }
  if (work.tauri.length > 0) work.writes = true;
  return work;
}

/** Whether a job's code makes a release: by a command, or by tauri-action with no id to add to. */
function makesOne(work) {
  // A step it can't read is a problem of its own, said once.
  return work.makes.length > 0 || work.tauri.some((step) => !step.unreadable && !step.inputs.has("releaseId"));
}

/** tauri-action's inputs for making a release, or for finding one by its tag. */
const FOR_MAKING = ["tagName", "releaseName", "releaseBody", "releaseDraft", "prerelease", "releaseCommitish", "generateReleaseNotes"];

/**
 * What's wrong in any workflow: what it can't read, a job with a matrix that
 * makes a release (one per build), or a tauri-action step that could make
 * one or write latest.json on its own.
 */
export function releaseProblems(text) {
  const problems = [];
  const jobs = jobsOf(text);
  if (/^jobs:/m.test(text) && jobs.length === 0) problems.push("no jobs read under `jobs:`: is it indented two spaces?");
  for (const job of jobs) {
    const work = releaseWork(job);
    problems.push(...work.unreadable.map((what) => `${job.name}: ${what}`));
    if (/\bmatrix\s*:/.test(codeText(job.lines.join("\n"))) && makesOne(work)) {
      problems.push(`${job.name}: a job with a matrix makes a release (${work.makes.join(", ") || "tauri-action"}), so each build can make its own`);
    }
    for (const { inputs, unreadable } of work.tauri) {
      if (unreadable) {
        problems.push(`${job.name}: tauri-action's \`with:\` is on one line; write each input on its own, so it can be read`);
        continue;
      }
      if (!inputs.has("releaseId")) problems.push(`${job.name}: tauri-action without releaseId makes a release whenever it finds none`);
      for (const key of FOR_MAKING) {
        if (inputs.has(key)) problems.push(`${job.name}: tauri-action's ${key} is for making a release; hand it releaseId alone`);
      }
      if (inputs.get("uploadUpdaterJson")?.toLowerCase() !== "false") {
        problems.push(`${job.name}: tauri-action writing latest.json can leave out another build's platforms; set uploadUpdaterJson: false`);
      }
    }
  }
  return problems;
}

/**
 * What's wrong in release.yml: the `draft` job is the only one that makes a
 * release, and every job that adds to it waits for it, directly or through
 * the jobs it needs, and hands tauri-action its id.
 */
export function draftProblems(text) {
  const problems = [];
  const jobs = jobsOf(text);
  const named = new Map(jobs.map((job) => [job.name, job]));
  const draft = named.get("draft");
  if (!draft) return ["there is no `draft` job to make the release"];
  const draftCode = codeText(draft.lines.join("\n"));
  if (!/\bscripts\/release-draft\.mjs\b/.test(draftCode) || !/^ {6}id:\s*["']?\$\{\{\s*steps\.draft\.outputs\.id\s*\}\}/m.test(draftCode)) {
    problems.push("draft: it makes the release with scripts/release-draft.mjs and hands on its id as outputs.id");
  }
  const work = new Map(jobs.map((job) => [job.name, releaseWork(job)]));
  for (const job of jobs) {
    if (job !== draft && makesOne(work.get(job.name))) problems.push(`${job.name}: only the draft job makes the release`);
    if (needsOf(job) === null) problems.push(`${job.name}: its needs can't be read`);
  }
  const waits = (name, seen = new Set()) => {
    if (seen.has(name)) return false;
    seen.add(name);
    const needs = needsOf(named.get(name) ?? { lines: [] }) ?? [];
    return needs.includes("draft") || needs.some((need) => waits(need, seen));
  };
  for (const job of jobs) {
    const { writes, tauri } = work.get(job.name);
    if (job === draft || !writes) continue;
    if (!waits(job.name)) problems.push(`${job.name}: adds to the release without waiting for the draft job`);
    for (const { inputs } of tauri) {
      if (inputs.get("releaseId") !== "${{ needs.draft.outputs.id }}") {
        problems.push(`${job.name}: tauri-action's releaseId is the draft job's, \${{ needs.draft.outputs.id }}`);
      }
      if (!(needsOf(job) ?? []).includes("draft")) problems.push(`${job.name}: reads needs.draft without needing draft`);
    }
  }
  return problems;
}

const workflows = new URL("../.github/workflows/", import.meta.url);
const read = (name) => readFileSync(new URL(name, workflows), "utf8");

test("no workflow lets a build make a release, or write latest.json on its own (#828)", () => {
  for (const name of readdirSync(workflows).filter((file) => /\.ya?ml$/.test(file))) {
    assert.deepEqual(releaseProblems(read(name)), [], name);
  }
});

test("release.yml makes the draft once, in the draft job, and every job adding to it waits for it (#828)", () => {
  const text = read("release.yml");
  // The jobs are found at all: a file this can't read must not pass.
  assert.deepEqual(
    jobsOf(text).map((job) => job.name),
    ["tests", "preflight", "draft", "bundle", "updater-json", "android"],
  );
  const work = Object.fromEntries(jobsOf(text).map((job) => [job.name, releaseWork(job)]));
  assert.equal(work.bundle.tauri.length, 1, "the build's tauri-action step is found");
  assert.deepEqual(work.draft.makes, ["gh, from a script's own code (in scripts/release-draft.mjs)"], "the draft job is seen making it");
  assert.ok(work["updater-json"].writes && work.android.writes, "the jobs adding to it are seen adding");
  assert.deepEqual(draftProblems(text), []);
});

// Every way to write what the check looks for: made, added to, or neither.
const commands = [
  ["gh release create v1 --draft", "makes"],
  ["gh release new v1", "makes"],
  ["gh  release   create v1", "makes"],
  ['gh release \\\n  create "$TAG"', "makes"],
  ["gh api repos/o/r/releases -f tag_name=v1", "makes"],
  ['gh api "repos/o/r/releases" -F draft=true', "makes"],
  ["gh api -Fdraft=true repos/o/r/releases", "makes"],
  ["gh api -XPOST repos/o/r/releases", "makes"],
  ["gh api --method=post repos/o/r/releases", "makes"],
  ["gh api --method POST repos/o/r/releases --input body.json", "makes"],
  ["gh api \\\n  --method POST \\\n  repos/o/r/releases", "makes"],
  ["curl -X POST https://api.github.com/repos/o/r/releases -d '{}'", "makes"],
  ["curl --request=POST https://api.github.com/repos/o/r/releases", "makes"],
  ["curl -sS -H 'Authorization: x' --json '{\"tag_name\":\"v1\"}' https://api.github.com/repos/o/r/releases", "makes"],
  ["await github.rest.repos.createRelease({ owner, repo, tag_name })", "makes"],
  ['gh(["release", "create", tag])', "makes"],
  ['execFileSync("gh", ["api", "--method", "POST", `repos/${repo}/releases`])', "makes"],
  ["gh release upload v1 a.zip --clobber", "writes"],
  ["gh release edit v1 --draft=false", "writes"],
  ["gh release delete-asset v1 old.zip --yes", "writes"],
  ["gh api -X DELETE repos/o/r/releases/assets/9", "writes"],
  ["curl --data-binary @a.zip https://uploads.github.com/repos/o/r/releases/1/assets?name=a.zip", "writes"],
  ['gh(["release", "upload", tag, file])', "writes"],
  ["gh api repos/o/r/releases?per_page=100 --paginate --jq '.[]'", "neither"],
  ["gh api repos/o/r/releases/123/assets", "neither"],
  ["gh release view v1 --json assets", "neither"],
  ["gh release download v1 --pattern '*.sig'", "neither"],
  ["curl -sS https://api.github.com/repos/o/r/releases", "neither"],
  ["# gh release create v1, a comment, not a command", "neither"],
  ["// gh release create v1, in a script's comment", "neither"],
];

test("every way to make a release, add to one, or neither is told apart (#828)", () => {
  for (const [command, does] of commands) {
    const code = codeText(command);
    const makes = Object.values(MAKES).some((test) => test(code));
    const writes = Object.values(WRITES).some((test) => test(code));
    assert.equal(makes ? "makes" : writes ? "writes" : "neither", does, command);
  }
});

// 0.5.4's release.yml, cut down to what split its release.
const split = `
jobs:
  bundle:
    name: \${{ matrix.label }}
    needs: [preflight, tests]
    strategy:
      matrix:
        include:
          - label: Linux
          - label: Windows
    steps:
      - uses: tauri-apps/tauri-action@1deb371b0cd8bd54025b384f1cd735e725c4060f # v1.0.0
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        with:
          projectPath: client
          tagName: \${{ github.ref_name }}
          releaseName: Linger \${{ github.ref_name }}
          releaseBody: |
            **This is the Linger app**
            releaseId: not an input, a line of the text
          releaseDraft: true
          uploadUpdaterJson: true
  android:
    needs: [preflight, tests, bundle]
    steps:
      - run: gh release upload "$GITHUB_REF_NAME" app.apk --clobber
`;

test("the release.yml that split 0.5.4 fails both checks (#828)", () => {
  const problems = releaseProblems(split);
  assert.ok(problems.some((problem) => /^bundle: a job with a matrix makes a release/.test(problem)), problems.join("\n"));
  assert.ok(problems.some((problem) => /without releaseId/.test(problem)), "the text's own 'releaseId:' isn't taken for the input");
  assert.ok(problems.some((problem) => /tagName/.test(problem)));
  assert.ok(problems.some((problem) => /releaseDraft/.test(problem)));
  assert.ok(problems.some((problem) => /uploadUpdaterJson/.test(problem)));
  assert.deepEqual(draftProblems(split), ["there is no `draft` job to make the release"]);
});

const fixed = `
jobs:
  draft:
    needs: [preflight, tests]
    outputs:
      id: \${{ steps.draft.outputs.id }}
    steps:
      - id: draft
        run: node scripts/release-draft.mjs "$GITHUB_REPOSITORY" "$GITHUB_REF_NAME" >> "$GITHUB_OUTPUT"
  bundle:
    needs: [preflight, tests, draft]
    strategy:
      matrix:
        os: [ubuntu-22.04, windows-latest]
    steps:
      - name: build
        uses: tauri-apps/tauri-action@1deb371b0cd8bd54025b384f1cd735e725c4060f # v1.0.0
        with:
          projectPath: client
          releaseId: \${{ needs.draft.outputs.id }}
          uploadUpdaterJson: false
  android:
    needs:
      - bundle
    steps:
      - run: gh release upload "$GITHUB_REF_NAME" app.apk --clobber
`;

test("a release made once and added to by id passes, however its YAML is quoted (#828)", () => {
  assert.deepEqual(releaseProblems(fixed), []);
  assert.deepEqual(draftProblems(fixed), []);
  assert.deepEqual(needsOf(jobsOf(fixed).find((job) => job.name === "android")), ["bundle"], "a needs list under the key");
  const quoted = fixed
    .replace("needs: [preflight, tests, draft]", `needs: ["preflight", 'tests', "draft"]`)
    .replace("uses: tauri-apps/tauri-action@", 'uses: "tauri-apps/tauri-action@')
    .replace("# v1.0.0", '" # v1.0.0')
    .replace("releaseId: ${{ needs.draft.outputs.id }}", `"releaseId": "\${{ needs.draft.outputs.id }}"`)
    .replace("uploadUpdaterJson: false", "uploadUpdaterJson: 'False'")
    .replace("      - bundle\n", '      - "bundle" # after the builds\n');
  assert.deepEqual(releaseProblems(quoted), []);
  assert.deepEqual(draftProblems(quoted), []);
});

test("a build that makes its own release, or adds to one without waiting for it, fails (#828)", () => {
  const ownRelease = fixed.replace('      - run: gh release upload "$GITHUB_REF_NAME" app.apk', '      - run: gh release create "$GITHUB_REF_NAME" --draft');
  assert.deepEqual(draftProblems(ownRelease), ["android: only the draft job makes the release"]);
  const matrixMakes = fixed.replace("          uploadUpdaterJson: false", "          uploadUpdaterJson: false\n      - run: gh api repos/o/r/releases -f tag_name=v1");
  assert.ok(releaseProblems(matrixMakes).some((problem) => /^bundle: a job with a matrix makes a release \(gh api/.test(problem)));
  const flowMatrix = fixed.replace("    strategy:\n      matrix:\n        os: [ubuntu-22.04, windows-latest]\n", "    strategy: { matrix: { os: [a, b] } }\n");
  assert.ok(releaseProblems(flowMatrix.replace("releaseId: ${{ needs.draft.outputs.id }}", "tagName: v1")).some((problem) => /^bundle: a job with a matrix/.test(problem)));
  const noWait = fixed.replace("    needs:\n      - bundle\n", "    needs: [preflight]\n");
  assert.deepEqual(draftProblems(noWait), ["android: adds to the release without waiting for the draft job"]);
  const byTag = fixed.replace("releaseId: ${{ needs.draft.outputs.id }}", "releaseId: ${{ needs.draft.outputs.id }}\n          tagName: v1");
  assert.deepEqual(releaseProblems(byTag), ["bundle: tauri-action's tagName is for making a release; hand it releaseId alone"]);
  // A comment naming what a job doesn't do is not the job doing it.
  assert.deepEqual(draftProblems(fixed.replace("    steps:\n      - run: gh release upload", "    # never gh release create here\n    steps:\n      - run: gh release upload")), []);
});

test("a script a job runs is read too, and one that makes a release counts (#828)", () => {
  // A real script that makes one, run from a build.
  const viaScript = fixed.replace("          uploadUpdaterJson: false", "          uploadUpdaterJson: false\n      - run: node ./scripts/release-draft.mjs o/r v1");
  assert.ok(releaseProblems(viaScript).some((problem) => /^bundle: a job with a matrix makes a release \(.*in scripts\/release-draft\.mjs/.test(problem)));
  // One that isn't there can't be read, and says so.
  const missing = fixed.replace('run: gh release upload "$GITHUB_REF_NAME" app.apk --clobber', "run: bash scripts/not-a-script.sh");
  assert.deepEqual(releaseProblems(missing), ["android: runs scripts/not-a-script.sh, which isn't there to read"]);
});

test("what it can't read is a problem, never a pass (#828)", () => {
  const oneLine = fixed.replace(
    "        with:\n          projectPath: client\n          releaseId: ${{ needs.draft.outputs.id }}\n          uploadUpdaterJson: false\n",
    "        with: { projectPath: client, releaseId: x, uploadUpdaterJson: false }\n",
  );
  assert.deepEqual(releaseProblems(oneLine), ["bundle: tauri-action's `with:` is on one line; write each input on its own, so it can be read"]);
  const marketplace = fixed.replace('run: gh release upload "$GITHUB_REF_NAME" app.apk --clobber', "uses: softprops/action-gh-release@v2");
  assert.ok(releaseProblems(marketplace).some((problem) => /^android: uses softprops\/action-gh-release, which may make a release/.test(problem)));
  assert.deepEqual(releaseProblems(fixed.replace(/^ {2}/gm, "    ")), ["no jobs read under `jobs:`: is it indented two spaces?"]);
  assert.deepEqual(draftProblems(fixed.replace("    needs:\n      - bundle\n", "    needs: ${{ fromJSON(x) }}\n")), [
    "android: its needs can't be read",
    "android: adds to the release without waiting for the draft job",
  ]);
});

const release = (id, tag, draft) => ({ id, tag_name: tag, draft, html_url: `https://github.com/o/r/releases/${id}` });

test("no release for the tag yet: make one (#828)", () => {
  assert.deepEqual(choose([release(1, "v0.5.3", false)], "v0.5.4"), { make: true });
  assert.deepEqual(choose([], "v0.5.4"), { make: true });
});

test("a run again finds the draft the first run made, and adds to it (#828)", () => {
  assert.deepEqual(choose([release(1, "v0.5.3", false), release(2, "v0.5.4", true)], "v0.5.4"), { id: 2 });
});

test("two releases for the tag stop it rather than picking one, naming both (#828)", () => {
  assert.throws(() => choose([release(2, "v0.5.4", true), release(3, "v0.5.4", true)], "v0.5.4"), /v0\.5\.4 has 2 releases: 2 \(draft\), 3 \(draft\)/);
});

test("a published release isn't added to (#828)", () => {
  assert.throws(() => choose([release(2, "v0.5.4", false)], "v0.5.4"), /published already/);
});
