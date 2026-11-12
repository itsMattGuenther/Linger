// The questions to ask of a change before opening its pull request
// (docs/pr-questions.md, #829). Only the ones for the parts of the project
// the branch changed are printed, so nobody reads the whole list, and a
// session that isn't opening a pull request reads none of it.
//
// Usage: node scripts/pr-questions.mjs [--all] [base-ref]
//   What the branch changed since it left base-ref (default origin/main,
//   else main): its commits, uncommitted edits and new files, as
//   scripts/check.sh reads them. --all prints every question; so does a
//   branch with nothing to compare with.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localPaths } from "./ci-scope.mjs";

export const PARTS = ["page", "shell", "phone", "server", "ci", "deploy", "tests"];

/** The most a question's explanation may run to, so a change's questions stay a short read. */
export const MOST = 420;

/** The section listing the kinds a check covers, which aren't asked. */
export const CHECKED = "Kinds a check covers";

const NONE = /^(?:docs|assets)\/|\.md$|^LICENSE$|\.(?:png|jpe?g|gif|webp|svg|ico|icns|woff2?|ttf|otf)$/i;
const TEST = /(?:^|\/)(?:tests|fixtures)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|\.test\.py$|-test\.sh$/;
const PHONE_NAME = /phone|share[-_]?window/i;

/**
 * The parts of the project a changed file is in, or null when nothing here
 * knows its path. Docs, pictures and fonts are in none: nothing in them can
 * run twice or go offline. A test is in `tests` as well as its own part.
 */
export function knownParts(path) {
  if (NONE.test(path)) return [];
  const parts = new Set();
  const add = (...names) => names.forEach((name) => parts.add(name));
  if (/^crates\/linger-core\/|^client\/src\/generated\//.test(path)) add("server", "page");
  else if (/^crates\/|^Cargo\.(?:toml|lock)$|^\.cargo\//.test(path)) add("server");
  else if (/^client\/src-tauri\/gen\/(?:apple|android)\//.test(path)) add("phone");
  else if (/^client\/src-tauri\/(?:tauri\.(?:ios|android)\.conf\.json|Info\.ios\.plist|android-release-cert\.sha256)$/.test(path)) add("phone");
  else if (path.startsWith("client/src-tauri/")) add("shell");
  else if (/^client\/tests\/(?:ios|share-sender|share-window-preview)\//.test(path)) add("phone");
  else if (path.startsWith("client/scripts/")) add("ci");
  else if (path.startsWith("client/")) add("page");
  else if (/^(?:scripts|\.github|packaging|agents)\/|^\.git(?:ignore|attributes)$/.test(path)) add("ci");
  else if (path.startsWith("deploy/")) add("deploy");
  else if (path.startsWith("push-relay/")) add("server");
  else return null;
  // Page and shell files that only the phones run are named for them.
  if (/^client\/(?:src|src-tauri|tests)\//.test(path) && PHONE_NAME.test(path.slice(path.lastIndexOf("/") + 1))) add("phone");
  if (TEST.test(path)) add("tests");
  return PARTS.filter((part) => parts.has(part));
}

/** A path nothing knows is in every part: better every question than none. */
export const partsOf = (path) => knownParts(path) ?? [...PARTS];

/** The parts a change is in, and the questions for them, in the list's order. */
export function questionsFor(paths, questions) {
  const touched = new Set(paths.flatMap(partsOf));
  return {
    parts: PARTS.filter((part) => touched.has(part)),
    asked: questions.filter((question) => question.for.some((part) => touched.has(part))),
  };
}

/**
 * A Markdown heading's level and words, in each way one is written with #s:
 * up to three spaces before it, and closing #s after it. Null for a line
 * that isn't one, such as `#794) …`: a heading's #s are followed by a space.
 */
export function heading(line) {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
  return match ? { level: match[1].length, text: (match[2] ?? "").trim() } : null;
}

/**
 * Reads a list of entries one line at a time, so that every list item is
 * an entry, part of the entry above it, or a failure: there is no path
 * that passes one over (#833's review). It answers `{ entry }` for a new
 * entry, `{ more }` for a line of the entry above, `{ fail }` with why, or
 * null for anything else (a blank line, a paragraph).
 *
 * An item at the start of its line, or one space in, is an entry, whatever
 * its marker (`-`, `*`, `+`, `1.`, `1)`). Two or three spaces in, Markdown
 * makes an item a new entry or a point under the one above depending on
 * what's around it, so rather than guess, one that `looksLikeEntry` fails,
 * and so does any with no entry above it. Indented lines and items under an
 * entry are part of it; a paragraph at the start of a line ends the list.
 * A leading tab counts as four spaces. Make one reader for each section.
 */
export function listReader(looksLikeEntry) {
  let open = false;
  return (raw) => {
    const line = raw.replace(/^[ \t]+/, (space) => space.replace(/\t/g, "    "));
    if (!line.trim()) return null;
    const indent = line.length - line.trimStart().length;
    const item = /^ *(?:[-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/.exec(line);
    if (!item) {
      if (indent === 0) open = false;
      return open ? { more: line.trim() } : null;
    }
    const text = (item[1] ?? "").trim();
    if (indent <= 1) {
      open = true;
      return { entry: text };
    }
    if (looksLikeEntry(text)) return { fail: "an entry starts at the start of its line; indented, it can read as a point under the one above" };
    if (indent <= 3 && !open) return { fail: "a list item here is an entry, at the start of its line" };
    return open ? { more: text } : null;
  };
}

/**
 * A line of only =s or -s, which under words makes them a heading. These
 * docs write headings with #s, so one fails rather than being read as words.
 */
export const underline = (line) => /^ {0,3}(?:=+|-{2,})[ \t]*$/.test(line);

/**
 * Reads docs/pr-questions.md: each `###` under "## Questions" is a question,
 * followed by `For:` (its parts) and `Gaps:` (the record's gap headings it
 * covers), then what to look for. Anything it can't read fails, naming the
 * line, rather than being passed over (docs/testing-strategy.md).
 */
export function parseQuestions(text, file = "docs/pr-questions.md") {
  const lines = text.split("\n");
  const fail = (index, why) => { throw new Error(`${file}:${index + 1}: ${why}`); };
  const questions = [];
  const checked = [];
  let section = null;
  let list = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const head = heading(line);
    if (underline(line)) fail(i, "write headings with #s, not a line of = or -");
    if (head?.level === 2) {
      section = head.text;
      list = listReader((words) => words.startsWith("**"));
      continue;
    }
    if (head?.level === 3) {
      if (section !== "Questions") fail(i, `a question outside "## Questions"`);
      const question = head.text;
      if (!question.endsWith("?")) fail(i, `a question ends with a question mark: ${question}`);
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      const forLine = /^For: (.+)$/.exec(lines[j] ?? "");
      if (!forLine) fail(j, `"For: <part>, <part>" comes after the question`);
      const gapsLine = /^Gaps: (.+)$/.exec(lines[j + 1] ?? "");
      if (!gapsLine) fail(j + 1, `"Gaps: <gap>; <gap>" comes after "For:"`);
      const parts = forLine[1].split(",").map((part) => part.trim());
      for (const part of parts) if (!PARTS.includes(part)) fail(j, `no part is called "${part}"`);
      const gaps = gapsLine[1].split(";").map((gap) => gap.trim()).filter(Boolean);
      questions.push({ question, for: parts, gaps, body: [], line: i + 1 });
      i = j + 1;
      continue;
    }
    if (section === "Questions") {
      if (head) fail(i, "only ### headings here, one for each question");
      if (!line.trim()) continue;
      if (!questions.length) fail(i, "words before the first question");
      questions.at(-1).body.push(line.trim());
    } else if (section === CHECKED) {
      const read = list(line);
      if (read?.fail) fail(i, read.fail);
      if (read?.entry !== undefined) {
        const entry = /^\*\*(.+?)\*\*: (.+)$/.exec(read.entry);
        if (!entry) fail(i, `a kind a check covers is "- **<gap>**: <the check>"`);
        checked.push({ gap: entry[1].trim(), text: entry[2], line: i + 1 });
      } else if (read?.more !== undefined) checked.at(-1).text += ` ${read.more}`;
    }
  }
  if (!questions.length) fail(0, `no questions under "## Questions"`);
  for (const question of questions) if (!question.body.length) fail(question.line - 1, `"${question.question}" says nothing about what to look for`);
  return {
    questions: questions.map((question) => ({ ...question, body: question.body.join(" ") })),
    checked: checked.map(({ gap, text, line }) => {
      const check = /`([^`]+)`/.exec(text);
      if (!check) fail(line - 1, `"${gap}" names its check in backticks`);
      return { gap, check: check[1], line };
    }),
  };
}

/** Words wrapped to `width` columns, each line after `indent`. */
export function wrap(text, indent, width = 80) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && indent.length + line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.map((each) => indent + each).join("\n");
}

/** The questions, numbered, each with what to look for beneath it. */
export function format(asked) {
  const width = String(asked.length).length + 2;
  const pad = " ".repeat(width);
  return asked.map((question, i) =>
    `${`${i + 1}.`.padEnd(width)}${wrap(question.question, pad).slice(width)}\n${wrap(question.body, pad)}`).join("\n\n");
}

const ASK = "Answer each of these for this change before opening its pull request, and say what you checked in the pull request's Tests section, in a line or two:";

function run(argv) {
  const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const root = git(["rev-parse", "--show-toplevel"], process.cwd());
  const { questions } = parseQuestions(readFileSync(join(root, "docs/pr-questions.md"), "utf8"));
  const everything = (why) => console.log(`${why}\n${wrap(ASK, "")}\n\n${format(questions)}`);
  if (argv.includes("--all")) return everything("Every question.");
  const exists = (ref) => { try { git(["rev-parse", "-q", "--verify", `${ref}^{commit}`], root); return true; } catch { return false; } };
  const base = argv.find((arg) => !arg.startsWith("--")) ?? ["origin/main", "main"].find(exists);
  // Only a base that isn't there means "ask everything"; git failing any
  // other way fails the script.
  if (!base || !exists(base)) return everything(`Can't compare with ${base ?? "origin/main or main"}, so here is every question.`);
  const paths = localPaths(base, root);
  const files = `${paths.length} file${paths.length === 1 ? "" : "s"}`;
  if (!paths.length) return console.log(`Nothing changed since ${base}, so there's nothing to ask.`);
  const { parts, asked } = questionsFor(paths, questions);
  if (!asked.length) return console.log(`${files} changed since ${base}, none of them code, so there's nothing to ask.`);
  console.log(`${files} changed since ${base}, in: ${parts.join(", ")}.\n${wrap(ASK, "")}\n\n${format(asked)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run(process.argv.slice(2));
