// Every file the living docs name exists (#770). A file renamed or deleted
// leaves every doc that names it pointing at nothing, and a contributor
// following them loses an afternoon (AGENTS.md, "The README"). #767 nearly
// merged a rule naming a test that only another pull request added.
//
// A name is a repository path in inline code, a fenced block or a link:
// one that starts with a top-level directory (`scripts/check.sh`,
// `client/src/lib/`), or a link relative to the doc it's in. A command's
// `cd client &&` puts what follows under `client/`, and a span that is one
// path may hold spaces (`assets/logo/Linger Pixel Porch Icon Set FINAL.png`).
// Globs and placeholders (`*.spec.ts`, `<name>`, `$VAR`, `…`) aren't names,
// and nor is what a build makes (`target/`, `dist/`, `node_modules/`). A file
// that only exists at an older commit or on another branch is named in git's
// own notation, `218cc2b:scripts/desktop-check.py`, and isn't checked. Left out: the
// records of the past (`docs/tasks/`, `docs/decisions.md`,
// `docs/review-catches.md`, `docs/releases/`), which name files that existed
// then, on purpose.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * The top-level directories a path in the docs can start with. Written out,
 * not read from what's there: a directory renamed or deleted whole must leave
 * its names failing, not unread (#771's review). A test below fails when a new
 * one isn't added here.
 */
const TOP = [".cargo", ".github", "agents", "assets", "client", "crates", "deploy", "docs", "packaging", "scripts"];

/** What a build or a run makes, never in the repository. */
const MADE = /(?:^|\/)(?:target|dist|node_modules|test-results|playwright-report|gen)\//;

/** A link's optional title, after its target: "t", 't' or (t). */
const TITLE = String.raw`(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?`;
const INLINE = new RegExp(String.raw`\]\(\s*(?:<([^>]*)>|([^)\s<]+))${TITLE}\s*\)`, "g");
const REFERENCE = /^ {0,3}\[[^\]]+\]:\s*(?:<([^>]*)>|(\S+))?/;
const ON_NEXT_LINE = /^\s*(?:<([^>]*)>|(\S+))/;
const ATTRIBUTE = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

/**
 * Every link target on a Markdown line, in every form it can take (#771's
 * review found the forms one at a time, so here is the table): an inline
 * link or image, plain or in angle brackets (which may hold spaces), with or
 * without a title; a reference's definition, its target on the line or the
 * next; and an HTML tag's src or href, quoted either way or not at all.
 */
export function linkTargets(line, next = "") {
  const found = [];
  for (const match of line.matchAll(INLINE)) found.push(match[1] ?? match[2] ?? "");
  const reference = REFERENCE.exec(line);
  if (reference) {
    const target = reference[1] ?? reference[2];
    if (target !== undefined) found.push(target);
    else {
      const below = ON_NEXT_LINE.exec(next);
      if (below) found.push(below[1] ?? below[2] ?? "");
    }
  }
  for (const match of line.matchAll(ATTRIBUTE)) found.push(match[1] ?? match[2] ?? match[3] ?? "");
  return found;
}

/**
 * The repository paths a doc names, each with its line: from inline code, fenced
 * blocks and links. `from` is the doc's own path, for its relative links;
 * `exists` says whether a span with spaces is one file's name.
 */
export function namedPaths(text, from = "README.md", top = TOP, exists = (path) => existsSync(join(ROOT, path))) {
  const names = [];
  const lines = text.split("\n");
  let fenced = false;
  const clean = (raw) => raw.replace(/^[("'[]+/, "").replace(/[)"'\],;:.]+$/, "").replace(/:\d+(?:-\d+)?$/, "").replace(/#.*$/, "");
  for (const [at, line] of lines.entries()) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    // A fenced line is a command run from the root, its comment left off.
    const pieces = fenced ? [line.replace(/(^|\s)#.*$/, "")] : [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
    for (const piece of pieces) {
      // Where what follows runs from, after a `cd` in the same command: "" for
      // the root, null once a `cd` goes somewhere this can't follow.
      let base = "";
      const add = (token) => {
        if (!token.includes("/") || /[*?{}<>$…~]|\.\.\./.test(token) || MADE.test(token)) return;
        if (!top.includes(token.split("/")[0] ?? "") || base === null) return;
        names.push({ line: at + 1, path: base === "" ? token : normalize(join(base, token)) });
      };
      // A span that is one file's name, spaces and all: one that's there, or
      // one with no command in it that ends in an extension, there or not, so
      // a missing one is named whole (#771's review). A command with an
      // argument (`scripts/x.sh verify`) is read word by word.
      const whole = clean(piece.trim());
      const first = whole.split(/\s/)[0] ?? "";
      const oneName =
        exists(whole) ||
        (!exists(first) && !/\s-|&&|\||;|=|\[/.test(whole) && /\.[A-Za-z0-9]{1,6}$/.test(whole));
      if (!fenced && /\s/.test(whole) && top.includes(whole.split("/")[0] ?? "") && oneName) {
        add(whole);
        continue;
      }
      const tokens = piece.split(/[\s=]+/);
      for (const [index, raw] of tokens.entries()) {
        if (raw === "cd") {
          const to = tokens[index + 1] ?? "";
          base = /^[\w.][\w./-]*$/.test(to) && (top.includes(to.split("/")[0] ?? "") || to.startsWith("..")) ? normalize(join(base ?? "", to)) : null;
          if (base === ".") base = "";
          continue;
        }
        if (tokens[index - 1] !== "cd") add(clean(raw));
      }
    }
    if (fenced) continue;
    for (const raw of linkTargets(line, lines[at + 1] ?? "")) {
      let target = raw;
      try {
        target = decodeURI(raw);
      } catch {
        // A stray % isn't an escape: the name as written.
      }
      target = target.replace(/#.*$/, "");
      if (target === "" || /^[a-z][a-z0-9+.-]*:/i.test(target) || /[*<>$]/.test(target)) continue;
      const path = normalize(join(dirname(from), target));
      if (!path.startsWith("..")) names.push({ line: at + 1, path });
    }
  }
  return names;
}

/** The living docs: what people and agents read to work on Linger today. */
function livingDocs() {
  const docs = ["README.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md", "QWEN.md", "CONTRIBUTING.md", "SPEC.md", "ARCHITECTURE.md", "PROTOCOL.md", "TASKS.md"];
  const past = ["docs/decisions.md", "docs/review-catches.md"];
  const walk = (dir) =>
    readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return ["docs/tasks", "docs/releases"].includes(path) ? [] : walk(path);
      return entry.name.endsWith(".md") && !past.includes(path) ? [path] : [];
    });
  return [...docs.filter((doc) => existsSync(join(ROOT, doc))), ...walk("docs"), ...walk("agents")];
}

test("names are found in code, fenced blocks and links; globs, placeholders and what a build makes are not names", () => {
  const top = ["scripts", "client", "docs", ".github"];
  const text = [
    "Run `scripts/check.sh --all`, then `cd client && pnpm check`.",
    "See [the guide](development.md#build) and [CI](../.github/workflows/ci.yml).",
    "Tests live in `client/tests/browser/*.spec.ts` and `client/src/lib/rows.ts:41`.",
    "Not these: `client/src-tauri/target/debug/linger-client`, `scripts/<name>.sh`, `$ROOT/scripts/x.sh`, https://example.com/scripts/x.",
    "```",
    "node scripts/linux-next-check.mjs PROGRAM --output DIR",
    "cd client && node scripts/emoji-data.mjs",
    "scripts/check.sh   # see docs/testing-strategy.md",
    "```",
    "The artwork is `docs/Linger Pixel Porch.png`, and the old walk-through is at `218cc2b:scripts/desktop-check.py`.",
    "Then `scripts/android-signing.sh verify-bundle`.",
  ].join("\n");
  const exists = (path) => path === "docs/Linger Pixel Porch.png";
  assert.deepEqual(namedPaths(text, "docs/x.md", top, exists), [
    { line: 1, path: "scripts/check.sh" },
    { line: 2, path: "docs/development.md" },
    { line: 2, path: ".github/workflows/ci.yml" },
    { line: 3, path: "client/src/lib/rows.ts" },
    { line: 6, path: "scripts/linux-next-check.mjs" },
    { line: 7, path: "client/scripts/emoji-data.mjs" },
    { line: 8, path: "scripts/check.sh" },
    { line: 10, path: "docs/Linger Pixel Porch.png" },
    { line: 11, path: "scripts/android-signing.sh" },
  ]);
});

test("a name under a directory that's gone, a missing name with spaces, and angle-bracket, reference and HTML links are read whole", () => {
  const text = [
    "The old art was in `assets/old/Porch Icon FINAL.png`; the sounds were in `sounds/knock.ogg`.",
    "See [the art](<assets/logo/Old Porch Icon.png>) and [the guide](<../docs/gone guide.md>).",
    "Run `scripts/android-signing.sh verify-bundle` after.",
    '<p align="center"><img src="../assets/logo/old-logo.svg" alt="Linger"> <a href="../LICENSE">license</a> <a href="#top">top</a></p>',
    "[guide]: <old guide.md>",
  ].join("\n");
  // Nothing in this text exists; `sounds/` isn't a directory the repository has.
  const exists = () => false;
  assert.deepEqual(namedPaths(text, "docs/x.md", ["assets", "docs", "scripts", "sounds"], exists), [
    { line: 1, path: "assets/old/Porch Icon FINAL.png" },
    { line: 1, path: "sounds/knock.ogg" },
    { line: 2, path: "docs/assets/logo/Old Porch Icon.png" },
    { line: 2, path: "docs/gone guide.md" },
    { line: 3, path: "scripts/android-signing.sh" },
    { line: 4, path: "assets/logo/old-logo.svg" },
    { line: 4, path: "LICENSE" },
    { line: 5, path: "docs/old guide.md" },
  ]);
});

test("every form a Markdown or HTML link takes is read", () => {
  const table = [
    ["[a](docs/a.md)", ["docs/a.md"]],
    ["![a](docs/a.png)", ["docs/a.png"]],
    ["[a](<docs/a b.md>)", ["docs/a b.md"]],
    ['[a](docs/a.md "A title")', ["docs/a.md"]],
    ["[a](docs/a.md 'A title')", ["docs/a.md"]],
    ["[a](docs/a.md (A title))", ["docs/a.md"]],
    ['[a](<docs/a b.md> "A title")', ["docs/a b.md"]],
    ["[a]: docs/a.md", ["docs/a.md"]],
    ['[a]: <docs/a b.md> "A title"', ["docs/a b.md"]],
    ['<img src="docs/a.png">', ["docs/a.png"]],
    ["<img src='docs/a.png'>", ["docs/a.png"]],
    ["<a href=docs/a.md>a</a>", ["docs/a.md"]],
    ['<img alt="a" SRC = "docs/a.png">', ["docs/a.png"]],
  ];
  for (const [line, want] of table) assert.deepEqual(linkTargets(line), want, line);
  // A reference's target on the line below it.
  assert.deepEqual(linkTargets("[a]:", "    <docs/a b.md>"), ["docs/a b.md"]);
  assert.deepEqual(linkTargets("[a]:", "   docs/a.md 'A title'"), ["docs/a.md"]);
});

test("every top-level directory is one a name can start with", () => {
  // The directories git keeps: not a local server's data/, an editor's
  // .vscode/ or anything else the repository ignores (#771's review).
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((path) => path.includes("/"))
    .map((path) => path.slice(0, path.indexOf("/")));
  assert.deepEqual([...new Set(tracked)].filter((dir) => !TOP.includes(dir)), [], "add the new directory to TOP");
});

test("the living docs are all read", () => {
  // A reader that finds nothing passes everything; these are known to be there.
  const docs = livingDocs();
  for (const doc of ["README.md", "AGENTS.md", "docs/testing-strategy.md", "docs/design/system.md", "agents/skills/linger-contribute/SKILL.md"])
    assert.ok(docs.includes(doc), `${doc} not read`);
  assert.ok(!docs.some((doc) => doc.startsWith("docs/tasks/")), "the task archives are records of the past");
  assert.ok(namedPaths(readFileSync(join(ROOT, "AGENTS.md"), "utf8"), "AGENTS.md").length > 10, "AGENTS.md names files");
});

test("every file the living docs name exists", () => {
  const missing = livingDocs().flatMap((doc) =>
    namedPaths(readFileSync(join(ROOT, doc), "utf8"), doc)
      .filter(({ path }) => !existsSync(join(ROOT, path)))
      .map(({ line, path }) => `${doc}:${line}: ${relative(".", path)}`),
  );
  assert.deepEqual(missing, []);
});
