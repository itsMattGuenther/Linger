#!/usr/bin/env node
// Which label a new issue gets, from its body (.github/workflows/issue-labels.yml).
//
// An issue filed with `gh issue create --label bug` by somebody without write
// access to the repository arrives with no label: GitHub drops labels on new
// issues from anybody who can't triage, silently. That is every friend's
// coding agent following the linger-report skill (#479). The issue forms label
// their own issues; this labels the rest, with the repository's own token.
//
// Two ways to know, in order:
//
// 1. The marker the linger-report skill puts first in a body, which GitHub
//    doesn't show: `<!-- linger-report: bug -->` or `<!-- linger-report: idea -->`.
// 2. The shape of the body, for anything filed before the marker or without
//    the skill: a bug has a "What happened" heading and a "Steps to reproduce"
//    or "Expected" one (the skill's reporting.md, and the bug form's fields); an
//    idea has "The idea" (the idea form's field).
//
// Anything else gets nothing, and waits for a person.
//
// Usage: ISSUE_BODY="..." node scripts/issue-label.mjs
//   Prints `bug`, `enhancement`, or nothing.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MARKER = /<!--\s*linger-report:\s*(bug|idea)\s*-->/i;

/** The headings in a body, `##` or `###`, lower case and without trailing marks. */
function headings(body) {
  return body
    .split(/\r?\n/)
    .map((line) => /^#{2,3}\s+(.+?)\s*#*\s*$/.exec(line)?.[1])
    .filter((heading) => heading !== undefined)
    .map((heading) => heading.toLowerCase().replace(/[:.]+$/, ""));
}

/** The label for an issue with this body, or null to leave it to a person. */
export function labelFor(body) {
  const text = body ?? "";
  const marked = MARKER.exec(text);
  if (marked) return marked[1].toLowerCase() === "bug" ? "bug" : "enhancement";
  const seen = new Set(headings(text));
  const has = (...names) => names.some((name) => seen.has(name));
  if (has("what happened") && has("steps to reproduce", "expected", "what you expected")) return "bug";
  if (has("the idea")) return "enhancement";
  return null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const label = labelFor(process.env.ISSUE_BODY);
  if (label) process.stdout.write(`${label}\n`);
}
