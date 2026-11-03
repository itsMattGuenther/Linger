// The questions before a pull request (docs/pr-questions.md, #829): every
// kind of catch in the record has a question or a check, a change gets only
// the questions for its parts, and the list stays short to read.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CHECKED, MOST, PARTS, format, heading, knownParts, listItem, parseQuestions, partsOf, questionsFor, underline, wrap }
  from "./pr-questions.mjs";
import { WRONG, parseRecord } from "./review-catches.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./pr-questions.mjs", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const doc = read("docs/pr-questions.md");
const { questions, checked } = parseQuestions(doc);
const record = parseRecord(read("docs/review-catches.md"));

test("every gap in the record has a question or a check", () => {
  const covered = new Set([...questions.flatMap((question) => question.gaps), ...checked.map((kind) => kind.gap)]);
  assert.deepEqual(record.gaps.filter((gap) => !covered.has(gap)), []);
  assert(!record.gaps.includes(WRONG), "a wrong comment isn't a gap");
});

test("every gap a question or a check names is a heading in the record", () => {
  const named = [...questions.flatMap((question) => question.gaps), ...checked.map((kind) => kind.gap)];
  assert.deepEqual(named.filter((gap) => !record.gaps.includes(gap)), []);
});

test("a kind a check covers names a check that exists, and isn't asked as well", () => {
  assert(checked.length, `"## ${CHECKED}" lists at least one`);
  for (const kind of checked) assert(existsSync(join(ROOT, kind.check)), `${kind.gap}: ${kind.check} isn't there`);
  const asked = new Set(questions.flatMap((question) => question.gaps));
  assert.deepEqual(checked.filter((kind) => asked.has(kind.gap)).map((kind) => kind.gap), []);
});

test("each question is short to read, so a change's questions stay cheap", () => {
  for (const question of questions) {
    assert(question.body.length <= MOST, `"${question.question}" runs to ${question.body.length} characters, over ${MOST}`);
    assert(question.question.length <= 120, `"${question.question}" is a long question`);
  }
});

test("the parts the doc lists are the script's, and each has a question", () => {
  const section = doc.split(/^## /m).find((part) => part.startsWith("Parts\n"));
  const listed = [...section.matchAll(/^- `([a-z]+)`:/gm)].map((match) => match[1]);
  assert.deepEqual(listed, PARTS);
  for (const part of PARTS) assert(questions.some((question) => question.for.includes(part)), `nothing asks about ${part}`);
});

test("each changed file goes into the parts it's in", () => {
  const table = {
    "crates/linger-server/src/gateway.rs": ["server"],
    "crates/linger-server/tests/resume.rs": ["server", "tests"],
    "crates/linger-sfu/src/lib.rs": ["server"],
    "crates/linger-core/src/lib.rs": ["page", "server"],
    "client/src/generated/Message.ts": ["page", "server"],
    "Cargo.lock": ["server"],
    ".cargo/config.toml": ["server"],
    "client/src/next/app/list/ListWindow.tsx": ["page"],
    "client/src/lib/api.test.ts": ["page", "tests"],
    "client/package.json": ["page"],
    "client/tests/browser/next-chat.spec.ts": ["page", "tests"],
    "client/tests/fixtures/server.ts": ["page", "tests"],
    "client/src/next/core/phone.ts": ["page", "phone"],
    "client/src/next/core/shareWindow.test.ts": ["page", "phone", "tests"],
    "client/src/next/app/list/useShareWindow.ts": ["page", "phone"],
    "client/tests/browser/next-phone-voice.spec.ts": ["page", "phone", "tests"],
    "client/src-tauri/src/updates.rs": ["shell"],
    "client/src-tauri/gen/schemas/desktop-schema.json": ["shell"],
    "client/src-tauri/src/share_window.rs": ["shell", "phone"],
    "client/src-tauri/src/phone_backup.rs": ["shell", "phone"],
    "client/src-tauri/capabilities/phone.json": ["shell", "phone"],
    "client/src-tauri/tests/secrets.rs": ["shell", "tests"],
    "client/src-tauri/gen/apple/ShareExtension/ShareList.swift": ["phone"],
    "client/src-tauri/gen/android/app/build.gradle.kts": ["phone"],
    "client/src-tauri/tauri.ios.conf.json": ["phone"],
    "client/src-tauri/Info.ios.plist": ["phone"],
    "client/tests/ios/set-up.yaml": ["phone", "tests"],
    "client/tests/share-sender/ShareSenderTests.swift": ["phone", "tests"],
    "client/scripts/windows-next-check.mjs": ["ci"],
    "client/scripts/webview2-wait.test.mjs": ["ci", "tests"],
    "scripts/check.sh": ["ci"],
    "scripts/apt-install-test.sh": ["ci", "tests"],
    "scripts/linux-audio-check.test.py": ["ci", "tests"],
    "scripts/fixtures/tone-h264-aac.mp4": ["ci", "tests"],
    ".github/workflows/ci.yml": ["ci"],
    "packaging/arch/PKGBUILD": ["ci"],
    "agents/link-skills.sh": ["ci"],
    ".gitignore": ["ci"],
    "deploy/update.sh": ["deploy"],
  };
  for (const [path, parts] of Object.entries(table)) assert.deepEqual(knownParts(path), parts, path);
});

test("docs, pictures and fonts are in no part", () => {
  for (const path of ["docs/testing-strategy.md", "README.md", "AGENTS.md", "agents/skills/linger-contribute/SKILL.md",
    "client/tests/ios/README.md", "LICENSE", "assets/logo/Linger Pixel Porch Icon Set FINAL.png", "assets/fonts/OFL-inter.txt",
    "client/src/fonts/inter-0.woff2", "client/src-tauri/icons/icon.png", "client/src-tauri/icons/icon.icns",
    "client/src/next/kit/icon.SVG"])
    assert.deepEqual(knownParts(path), [], path);
});

test("a file nothing knows is in every part, and every file the repository tracks is known", () => {
  assert.equal(knownParts("somewhere-new/thing.rs"), null);
  assert.deepEqual(partsOf("somewhere-new/thing.rs"), PARTS);
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
  assert(tracked.length > 100);
  assert.deepEqual(tracked.filter((path) => knownParts(path) === null), [], "add these to knownParts in scripts/pr-questions.mjs");
});

const sample = [
  { question: "Server?", for: ["server"], gaps: [], body: "s" },
  { question: "Page?", for: ["page"], gaps: [], body: "p" },
  { question: "Either?", for: ["page", "server"], gaps: [], body: "e" },
  { question: "Test?", for: ["tests"], gaps: [], body: "t" },
];
const asked = (paths, list = sample) => questionsFor(paths, list).asked.map((question) => question.question);

test("a change gets only the questions for its parts, in the list's order", () => {
  assert.deepEqual(asked(["crates/linger-server/src/gateway.rs"]), ["Server?", "Either?"]);
  assert.deepEqual(asked(["client/src/next/app/list/ListWindow.tsx"]), ["Page?", "Either?"]);
  assert.deepEqual(asked(["crates/linger-server/tests/resume.rs"]), ["Server?", "Either?", "Test?"]);
  assert.deepEqual(asked(["client/src/next/app/list/ListWindow.tsx", "crates/linger-server/src/gateway.rs"]),
    ["Server?", "Page?", "Either?"]);
  assert.deepEqual(questionsFor(["crates/linger-server/src/gateway.rs", "docs/x.md"], sample).parts, ["server"]);
});

test("docs get no questions, and a file nothing knows gets all of them", () => {
  assert.deepEqual(asked(["docs/testing-strategy.md", "README.md"]), []);
  assert.deepEqual(asked(["somewhere-new/thing.rs"]), sample.map((question) => question.question));
});

test("a server change gets fewer of the real questions than the whole list", () => {
  const server = asked(["crates/linger-server/src/gateway.rs"], questions);
  assert(server.length > 0 && server.length < questions.length / 2, `${server.length} of ${questions.length}`);
});

const page = (questionsText, extra = "") => `# Before

## Questions

${questionsText}
${extra}`;
const one = "### Is it?\n\nFor: page\nGaps: Two at once\n\nLook.\n";

test("the list is read in every form it's written", () => {
  const read = parseQuestions(page(`### First?

For: page, server
Gaps: Two at once; A fallback wider than the case it's for

One paragraph,
over two lines.

#794) starts a line with an issue number, which isn't a heading.

### Second?
For: tests
Gaps: Files left behind
Right under its heading.
`, `## ${CHECKED}

These have a check.

- **Docs naming a file that isn't there**: \`scripts/doc-paths.test.mjs\`
  fails on it.
- **Another**: written over
  two lines, \`scripts/check.sh\`.
`));
  assert.deepEqual(read.questions.map(({ question, for: parts, gaps, body }) => ({ question, parts, gaps, body })), [
    { question: "First?", parts: ["page", "server"], gaps: ["Two at once", "A fallback wider than the case it's for"],
      body: "One paragraph, over two lines. #794) starts a line with an issue number, which isn't a heading." },
    { question: "Second?", parts: ["tests"], gaps: ["Files left behind"], body: "Right under its heading." },
  ]);
  assert.deepEqual(read.checked.map(({ gap, check }) => ({ gap, check })), [
    { gap: "Docs naming a file that isn't there", check: "scripts/doc-paths.test.mjs" },
    { gap: "Another", check: "scripts/check.sh" },
  ]);
});

test("headings and list items are read in every form Markdown writes them", () => {
  const headings = {
    "## Questions": { level: 2, text: "Questions" },
    "   ## Indented three": { level: 2, text: "Indented three" },
    "## Closed ##": { level: 2, text: "Closed" },
    "### Is it? #": { level: 3, text: "Is it?" },
    "##\tTabbed": { level: 2, text: "Tabbed" },
    "## C#": { level: 2, text: "C#" },
    "##": { level: 2, text: "" },
    "###### Six": { level: 6, text: "Six" },
    "####### Seven isn't one": null,
    "    ## Four spaces is code": null,
    "#794) an issue number": null,
    "##No space": null,
    "Words with ## in them": null,
  };
  for (const [line, expected] of Object.entries(headings)) assert.deepEqual(heading(line), expected, line);
  const items = {
    "- dash": "dash", "* star": "star", "+ plus": "plus", "1. one": "one", "12) twelve": "twelve",
    " - one space": "one space", "-\ttab": "tab",
    "  - nested": null, "--- rule": null, "**bold** words": null, "-no space": null, "2026 was a year": null,
  };
  for (const [line, expected] of Object.entries(items)) assert.equal(listItem(line), expected, line);
  for (const line of ["===", "=", "---", "   -----", "-- "]) assert(underline(line), line);
  for (const line of ["- a", "-", "= a", "a ---"]) assert(!underline(line), line);
  const read = parseQuestions(`# Before ##

  ## Questions ##

   ### Indented, closed? ###

For: page
Gaps: Two at once

Look.

## ${CHECKED}

* **Star**: \`scripts/check.sh\`
1. **Numbered**: \`scripts/doc-paths.test.mjs\`,
   over two lines.
`);
  assert.deepEqual(read.questions.map((question) => question.question), ["Indented, closed?"]);
  assert.deepEqual(read.checked.map((kind) => [kind.gap, kind.check]),
    [["Star", "scripts/check.sh"], ["Numbered", "scripts/doc-paths.test.mjs"]]);
});

test("what the list can't read fails, naming the line, rather than being passed over", () => {
  const cases = [
    [page(one, "## Parts\n\n### Out here?\n"), /:\d+: a question outside "## Questions"/],
    [page("### Is it?\n\nGaps: Two at once\n\nLook.\n"), /:\d+: "For: <part>, <part>" comes after the question/],
    [page("### Is it?\n\nFor: page\n\nLook.\n"), /:\d+: "Gaps: <gap>; <gap>" comes after "For:"/],
    [page("### Is it?\nGaps: Two at once\nFor: page\n\nLook.\n"), /"For: <part>, <part>"/],
    [page("### Is it?\n\nFor: page, phones\nGaps: Two at once\n\nLook.\n"), /no part is called "phones"/],
    [page("### Is it\n\nFor: page\nGaps: Two at once\n\nLook.\n"), /ends with a question mark/],
    [page(`${one}\n#### A smaller heading\n`), /only ### headings here/],
    [page(`${one}\n# A bigger one\n`), /only ### headings here/],
    [page(`${one}\nAn underlined heading?\n---\n`), /write headings with #s/],
    [page(one, `## ${CHECKED}\n\n* Docs naming a file: scripts/doc-paths.test.mjs\n`), /is "- \*\*<gap>\*\*: <the check>"/],
    [page("Words first.\n\n" + one), /words before the first question/],
    [page("### Is it?\n\nFor: page\nGaps: Two at once\n\n### Next?\n\nFor: page\nGaps: x\n\nLook.\n"), /"Is it\?" says nothing/],
    [page(one, `## ${CHECKED}\n\n- Docs naming a file: scripts/doc-paths.test.mjs\n`), /is "- \*\*<gap>\*\*: <the check>"/],
    [page(one, `## ${CHECKED}\n\n- **Docs naming a file**: a check, unnamed\n`), /names its check in backticks/],
    ["# Nothing\n\n## Questions\n", /no questions under "## Questions"/],
  ];
  for (const [text, error] of cases) assert.throws(() => parseQuestions(text), error, text);
});

test("questions are numbered and wrapped to 80 columns, lined up past nine", () => {
  const long = { question: `${"Is this a rather long question ".repeat(4)}?`, body: "word ".repeat(60), for: ["page"], gaps: [] };
  const out = format(Array.from({ length: 10 }, () => long));
  assert(out.split("\n").every((line) => line.length <= 80), out);
  assert.match(out, /^1\.  Is this/);
  assert.match(out, /\n10\. Is this/);
  assert.match(out, /\n    word word/);
  assert.equal(wrap("a b", "  "), "  a b");
});

// The script itself, in a throwaway repository with a main and a branch.
function branchRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), "pr-questions-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args], { cwd: dir });
  const write = (path, text) => { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), text); };
  git("init", "-q", "-b", "main");
  write("docs/pr-questions.md", doc);
  write("README.md", "a\n");
  write("crates/linger-server/src/lib.rs", "a\n");
  git("add", "."); git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "topic");
  const run = (...args) => spawnSync("node", [SCRIPT, ...args], { cwd: dir, encoding: "utf8" });
  return { dir, git, write, run };
}
const every = format(questions);

test("run: a branch's server change prints the server's questions and no others", (t) => {
  const { git, write, run } = branchRepo(t);
  write("crates/linger-server/src/lib.rs", "b\n");
  git("commit", "-q", "-am", "server");
  write("README.md", "b\n");
  const out = run();
  assert.equal(out.status, 0, out.stderr);
  const expected = format(questionsFor(["crates/linger-server/src/lib.rs"], questions).asked);
  assert(out.stdout.startsWith("2 files changed since main, in: server.\n"), out.stdout);
  assert(out.stdout.endsWith(`\n\n${expected}\n`), out.stdout);
});

test("run: from a folder inside the repository, new files count", (t) => {
  const { dir, write, run } = branchRepo(t);
  write("client/src/next/new.ts", "b\n");
  const out = spawnSync("node", [SCRIPT, "main"], { cwd: join(dir, "crates"), encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /^1 file changed since main, in: page\.\n/);
  assert.equal(run("main").stdout, out.stdout);
});

test("run: docs alone, or nothing, have nothing to ask", (t) => {
  const { write, run } = branchRepo(t);
  assert.equal(run().stdout, "Nothing changed since main, so there's nothing to ask.\n");
  write("docs/new.md", "b\n");
  assert.equal(run().stdout, "1 file changed since main, none of them code, so there's nothing to ask.\n");
});

test("run: --all, or no base to compare with, prints every question", (t) => {
  const { write, run } = branchRepo(t);
  write("crates/linger-server/src/lib.rs", "b\n");
  const all = run("--all");
  assert.equal(all.status, 0, all.stderr);
  assert(all.stdout.startsWith("Every question.\n") && all.stdout.endsWith(`\n\n${every}\n`), all.stdout);
  const lost = run("no-such-ref");
  assert.equal(lost.status, 0, lost.stderr);
  assert(lost.stdout.startsWith("Can't compare with no-such-ref, so here is every question.\n"), lost.stdout);
  assert(lost.stdout.endsWith(`\n\n${every}\n`));
});

test("run: git failing any other way fails the script, rather than asking everything", (t) => {
  const { git, write, run } = branchRepo(t);
  git("checkout", "-q", "--orphan", "unrelated");
  write("client/src/next/new.ts", "b\n");
  git("add", "."); git("commit", "-q", "-m", "no history shared with main");
  const out = run("main");
  assert.notEqual(out.status, 0, out.stdout);
  assert.doesNotMatch(out.stdout, /every question/);
});

test("run: a list it can't read fails, and says where", (t) => {
  const { write, run } = branchRepo(t);
  write("docs/pr-questions.md", doc.replace("For: page\n", "For: pages\n"));
  const out = run("--all");
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /docs\/pr-questions\.md:\d+: no part is called "pages"/);
});
