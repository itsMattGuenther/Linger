// Real catches per pull request, week by week (#829), from the record
// (docs/review-catches.md) and the history of main. The questions in
// docs/pr-questions.md are there to make this number fall; if it doesn't,
// they aren't working.
//
// Usage: node scripts/review-catches.mjs [ref]
//   ref is the history the pull requests are dated by: default origin/main,
//   else main.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { heading, knownParts, listReader, underline, wrap } from "./pr-questions.mjs";

/** The record's section for comments that were wrong, which aren't catches. */
export const WRONG = "Comments that were wrong";

const LEAD = /^\*\*#(\d+)(?: \((\d+) catches\))?:/;

/**
 * Every entry in the record: the gap it's under, the pull request it names
 * first, and how many catches it holds (one, unless its lead says
 * `(<n> catches)`). An entry that doesn't start that way fails, naming the
 * line, rather than going uncounted.
 */
export function parseRecord(text, file = "docs/review-catches.md") {
  const gaps = [];
  const catches = [];
  const wrong = [];
  let gap = null;
  let list = null;
  text.split("\n").forEach((line, i) => {
    if (underline(line)) throw new Error(`${file}:${i + 1}: write headings with #s, not a line of = or -`);
    const head = heading(line);
    if (head?.level === 2) {
      gap = head.text;
      if (gap !== WRONG) gaps.push(gap);
      list = listReader((words) => /^\*\*#\d/.test(words));
      return;
    }
    if (gap === null) return;
    const read = list(line);
    if (read?.fail) throw new Error(`${file}:${i + 1}: ${read.fail}`);
    if (read?.entry === undefined) return;
    const lead = LEAD.exec(read.entry);
    if (!lead) throw new Error(`${file}:${i + 1}: an entry starts "- **#<pull request>:" or "- **#<pull request> (<n> catches):"`);
    const count = lead[2] === undefined ? 1 : Number(lead[2]);
    if (lead[2] !== undefined && count < 2) throw new Error(`${file}:${i + 1}: an entry with one catch says no count`);
    (gap === WRONG ? wrong : catches).push({ pr: Number(lead[1]), count, gap, line: i + 1 });
  });
  return { gaps, catches, wrong };
}

/**
 * The pull requests merged into `ref`, newest first: number, the day it
 * merged, and the files it changed. A squash merge names its pull request
 * last, `… (#820) (#822)`; a merge commit says "Merge pull request #N".
 */
export function mergedHistory(ref, cwd = process.cwd()) {
  const out = execFileSync("git", ["-c", "core.quotePath=false", "log", "--first-parent", "--diff-merges=first-parent",
    "--no-renames", "--name-only", "--format=%x00%cs%x09%s", ref], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const merged = [];
  for (const chunk of out.split("\0").slice(1)) {
    const [head, ...rest] = chunk.split("\n");
    const [date, subject] = head.split("\t");
    const pr = /\(#(\d+)\)\s*$/.exec(subject) ?? /^Merge pull request #(\d+) /.exec(subject);
    if (pr) merged.push({ pr: Number(pr[1]), date, paths: rest.filter(Boolean) });
  }
  return merged;
}

/** The Monday of a `YYYY-MM-DD` day's week, the same way. */
export function weekOf(day) {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

/**
 * Catches per pull request, by the week each merged, from the day the first
 * one in the record merged (nothing was recorded before it) to `today`'s
 * week. A pull request counts when it changed more than docs (one Greptile
 * reviews, since it skips `docs/…` branches), or drew a catch.
 */
export function tally({ catches, wrong }, merged, today) {
  const when = new Map(merged.map((each) => [each.pr, each]));
  const drew = new Map();
  for (const entry of catches) drew.set(entry.pr, (drew.get(entry.pr) ?? 0) + entry.count);
  const dated = [...drew.keys()].filter((pr) => when.has(pr));
  const missing = [...drew.keys()].filter((pr) => !when.has(pr)).sort((a, b) => a - b);
  const prs = dated.map((pr) => ({ pr, date: when.get(pr).date, catches: drew.get(pr) }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.pr - b.pr);
  const weeks = [];
  if (prs.length) {
    const last = weekOf([today, ...merged.map((each) => each.date)].sort().at(-1));
    for (let week = weekOf(prs[0].date); week <= last; week = weekOf(next(week, 7))) weeks.push({ week, merged: 0, catches: 0 });
    const byWeek = new Map(weeks.map((row) => [row.week, row]));
    for (const each of merged) {
      if (each.date < prs[0].date) continue;
      const row = byWeek.get(weekOf(each.date));
      const code = each.paths.some((path) => (knownParts(path) ?? ["unknown"]).length);
      if (!row || !(code || drew.has(each.pr))) continue;
      row.merged++;
      row.catches += drew.get(each.pr) ?? 0;
    }
  }
  return { weeks, prs, missing, wrong: wrong.reduce((sum, entry) => sum + entry.count, 0) };
}

const next = (day, days) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/** The tally as a table by week, then the pull requests that drew catches. */
export function format({ weeks, prs, missing, wrong }, ref) {
  if (!prs.length) return `No pull request in the record is in ${ref}'s history.`;
  const lines = [
    wrap(`Real catches per pull request (docs/review-catches.md), by the week each merged into ${ref}, `
      + `from ${prs[0].date}, when the record starts. A pull request counts when it changed more than docs, `
      + "or drew a catch. If catches per pull request don't fall, the questions in docs/pr-questions.md "
      + "aren't working.", ""),
    "",
    "week of     merged  catches  per PR",
    ...weeks.map(({ week, merged, catches }) =>
      `${week}  ${String(merged).padStart(6)}  ${String(catches).padStart(7)}  ${(merged ? (catches / merged).toFixed(2) : "-").padStart(6)}`),
    "",
    "Pull requests that drew catches:",
    ...prs.map(({ date, pr, catches }) => `  ${date}  #${pr}  ${catches}`),
  ];
  if (missing.length) lines.push(`Not in ${ref}'s history, so not counted: ${missing.map((pr) => `#${pr}`).join(", ")}.`);
  lines.push(`Comments that were wrong: ${wrong}.`);
  return lines.join("\n");
}

function run(argv) {
  const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const root = git(["rev-parse", "--show-toplevel"], process.cwd());
  const exists = (ref) => { try { git(["rev-parse", "-q", "--verify", `${ref}^{commit}`], root); return true; } catch { return false; } };
  const ref = argv[0] ?? ["origin/main", "main"].find(exists) ?? "HEAD";
  const record = parseRecord(readFileSync(join(root, "docs/review-catches.md"), "utf8"));
  console.log(format(tally(record, mergedHistory(ref, root), new Date().toISOString().slice(0, 10)), ref));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run(process.argv.slice(2));
