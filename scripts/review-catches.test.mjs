// The count of real catches per pull request (#829): read from the record,
// dated by main's history, and grouped by week, so we can see whether it
// falls.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WRONG, format, mergedHistory, parseRecord, tally, weekOf } from "./review-catches.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./review-catches.mjs", import.meta.url));

const RECORD = `# What reviews caught

- An intro bullet, before any gap, isn't an entry.

## Gap one

Words about the gap.

- **#5: one catch.** Over
  two lines - with a dash.
- **#6 (3 catches): three in one.**

## Gap two

- **#5: a second catch on #5.**

## ${WRONG}

- **#7: a comment that was wrong.**
`;

test("each entry is a catch, or as many as its lead says, under its gap", () => {
  const { gaps, catches, wrong } = parseRecord(RECORD);
  assert.deepEqual(gaps, ["Gap one", "Gap two"]);
  assert.deepEqual(catches.map(({ pr, count, gap }) => ({ pr, count, gap })), [
    { pr: 5, count: 1, gap: "Gap one" },
    { pr: 6, count: 3, gap: "Gap one" },
    { pr: 5, count: 1, gap: "Gap two" },
  ]);
  assert.deepEqual(wrong.map(({ pr, count }) => ({ pr, count })), [{ pr: 7, count: 1 }]);
});

test("entries and gaps are read in every form Markdown writes them", () => {
  const { gaps, catches } = parseRecord(`# Title

   ## Indented gap ##

* **#1: a star.**
+ **#2: a plus.**
1. **#3 (2 catches): numbered.**
2) **#4: numbered another way.**
 - **#5: one space in.**
  - A nested point under #5, part of its entry.
  1. Another, numbered.
`);
  assert.deepEqual(gaps, ["Indented gap"]);
  assert.deepEqual(catches.map(({ pr, count }) => [pr, count]), [[1, 1], [2, 1], [3, 2], [4, 1], [5, 1]]);
});

test("an entry it can't count fails, naming the line, rather than going uncounted", () => {
  const cases = [
    ["## Gap\n\n- A catch with no pull request.\n", /:3: an entry starts "- \*\*#<pull request>:"/],
    ["## Gap\n\n- **#5 (two catches): a.**\n", /:3: an entry starts/],
    ["## Gap\n\n- **#5 (1 catches): a.**\n", /:3: an entry with one catch says no count/],
    ["## Gap\n\n- **PR #5: a.**\n", /:3: an entry starts/],
    [`## ${WRONG}\n\n- Wrong, but which?\n`, /:3: an entry starts/],
    ["## Gap\n\n* A star with no pull request.\n", /:3: an entry starts/],
    ["## Gap\n\n3. **A number, but not a pull request.**\n", /:3: an entry starts/],
    ["## Gap\n\n- **#5: a.**\n\nAn underlined gap\n---\n\n- **#6: b.**\n", /:6: write headings with #s/],
  ];
  for (const [text, error] of cases) assert.throws(() => parseRecord(text), error, text);
});

test("the real record reads, and every gap in it has a catch", () => {
  const { gaps, catches } = parseRecord(readFileSync(join(ROOT, "docs/review-catches.md"), "utf8"));
  assert(gaps.length > 10, `${gaps.length} gaps`);
  for (const gap of gaps) assert(catches.some((entry) => entry.gap === gap), `"${gap}" has no catch`);
});

test("a week starts on its Monday", () => {
  assert.equal(weekOf("2026-11-02"), "2026-11-02");
  assert.equal(weekOf("2026-11-03"), "2026-11-02");
  assert.equal(weekOf("2026-11-08"), "2026-11-02");
  assert.equal(weekOf("2026-11-09"), "2026-11-09");
  assert.equal(weekOf("2027-01-01"), "2026-12-28");
  assert.equal(weekOf("2028-03-01"), "2028-02-28");
});

const at = (day) => ({ GIT_AUTHOR_DATE: `${day}T12:00:00Z`, GIT_COMMITTER_DATE: `${day}T12:00:00Z`, TZ: "UTC" });

/** A throwaway repository whose main has the pull requests the tests need. */
function historyRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), "review-catches-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (env, ...args) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { cwd: dir, env: { ...process.env, ...env } });
  const write = (path, text = "x\n") => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  const commit = (day, subject, ...paths) => { paths.forEach((path) => write(path, `${subject}\n`)); git(at(day), "add", "."); git(at(day), "commit", "-q", "-m", subject); };
  git({}, "init", "-q", "-b", "main");
  commit("2026-10-20", "base, no pull request", "README.md");
  commit("2026-10-27", "feat: a (#3)", "client/src/a.ts", "client/src/café.ts");
  commit("2026-10-28", "docs: b (#4)", "docs/b.md");
  commit("2026-11-03", "fix: c, for issue #2 (#2) (#5)", "scripts/x.sh", "assets/logo/A Picture.png");
  git({}, "checkout", "-q", "-b", "topic");
  commit("2026-11-03", "on the branch", "deploy/x.sh");
  git({}, "checkout", "-q", "main");
  git(at("2026-11-04"), "merge", "-q", "--no-ff", "-m", "Merge pull request #6 from me/topic", "topic");
  commit("2026-11-05", "a commit that mentions (#9) in the middle", "client/src/b.ts");
  return { dir, write, commit };
}

test("main's history gives each pull request's number, the day it merged, and its files", (t) => {
  const { dir } = historyRepo(t);
  assert.deepEqual(mergedHistory("main", dir), [
    { pr: 6, date: "2026-11-04", paths: ["deploy/x.sh"] },
    { pr: 5, date: "2026-11-03", paths: ["assets/logo/A Picture.png", "scripts/x.sh"] },
    { pr: 4, date: "2026-10-28", paths: ["docs/b.md"] },
    { pr: 3, date: "2026-10-27", paths: ["client/src/a.ts", "client/src/café.ts"] },
  ]);
});

const merged = [
  { pr: 2, date: "2026-10-26", paths: ["client/src/x.ts"] },
  { pr: 3, date: "2026-10-27", paths: ["client/src/a.ts"] },
  { pr: 4, date: "2026-10-28", paths: ["docs/b.md"] },
  { pr: 7, date: "2026-10-29", paths: ["docs/c.md", "README.md"] },
  { pr: 8, date: "2026-10-30", paths: ["somewhere-new/thing"] },
  { pr: 5, date: "2026-11-03", paths: ["scripts/x.sh"] },
];
const record = {
  catches: [{ pr: 3, count: 1 }, { pr: 5, count: 2 }, { pr: 7, count: 1 }, { pr: 5, count: 1 }, { pr: 9, count: 1 }],
  wrong: [{ pr: 10, count: 1 }, { pr: 11, count: 2 }],
};

test("catches per pull request by week, from the first catch, counting what changed code or drew one", () => {
  const result = tally(record, merged, "2026-11-17");
  assert.deepEqual(result.weeks, [
    // #2 merged before the first catch; #4 changed docs only and drew none.
    { week: "2026-10-26", merged: 3, catches: 2 },
    { week: "2026-11-02", merged: 1, catches: 3 },
    { week: "2026-11-09", merged: 0, catches: 0 },
    { week: "2026-11-16", merged: 0, catches: 0 },
  ]);
  assert.deepEqual(result.prs, [
    { pr: 3, date: "2026-10-27", catches: 1 },
    { pr: 7, date: "2026-10-29", catches: 1 },
    { pr: 5, date: "2026-11-03", catches: 3 },
  ]);
  assert.deepEqual(result.missing, [9]);
  assert.equal(result.wrong, 3);
});

test("the table runs to the latest of today and the last merge", () => {
  assert.deepEqual(tally(record, merged, "2026-10-01").weeks.map((row) => row.week), ["2026-10-26", "2026-11-02"]);
});

test("the count reads as a table, then the pull requests, then what's left out", () => {
  const out = format(tally(record, merged, "2026-11-10"), "main");
  assert(out.split("\n").every((line) => line.length <= 80), out);
  assert.match(out, /by the week each merged\ninto main, from 2026-10-27, when the record starts\./);
  assert.match(out, /\nweek of {5}merged {2}catches {2}per PR\n2026-10-26 {7}3 {8}2 {4}0\.67\n2026-11-02 {7}1 {8}3 {4}3\.00\n2026-11-09 {7}0 {8}0 {7}-\n/);
  assert.match(out, /\nPull requests that drew catches:\n {2}2026-10-27 {2}#3 {2}1\n {2}2026-10-29 {2}#7 {2}1\n {2}2026-11-03 {2}#5 {2}3\n/);
  assert.match(out, /\nNot in main's history, so not counted: #9\.\nComments that were wrong: 3\.$/);
  assert.equal(format(tally({ catches: [{ pr: 9, count: 1 }], wrong: [] }, merged, "2026-11-10"), "main"),
    "No pull request in the record is in main's history.");
});

test("run: counts the record against the repository's main", (t) => {
  const { dir, write } = historyRepo(t);
  write("docs/review-catches.md", RECORD.replace("#6 (3 catches)", "#3 (3 catches)"));
  const out = spawnSync("node", [SCRIPT], { cwd: join(dir, "client"), encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /\n {2}2026-11-03 {2}#5 {2}2\n/);
  assert.match(out.stdout, /\n {2}2026-10-27 {2}#3 {2}3\n/);
  assert.match(out.stdout, /\nComments that were wrong: 1\.\n$/);
  assert.match(out.stdout, /^Real catches per pull request \(docs\/review-catches\.md\), by the week each merged\ninto main,/);
});

test("run: a record it can't read fails, and says where", (t) => {
  const { dir, write } = historyRepo(t);
  write("docs/review-catches.md", "## Gap\n\n- **#5 (one catch): a.**\n");
  const out = spawnSync("node", [SCRIPT, "main"], { cwd: dir, encoding: "utf8" });
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /docs\/review-catches\.md:3: an entry starts/);
});
