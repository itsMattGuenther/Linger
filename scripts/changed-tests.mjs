// The browser tests a branch added or edited, as `file:line` locations for
// Playwright, so they can be run many times over before they land (L-31,
// docs/testing-strategy.md). A test that fails one run in ten fails here, on
// the PR that wrote it, rather than at random on somebody else's.
//
// Usage: node scripts/changed-tests.mjs <base> [head]
//   With a head, the commits between them (CI). Without, the working tree
//   against the merge-base, new files included (scripts/check.sh).
// Prints one location per line, relative to client/. Nothing when no spec
// changed.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SPEC = /^client\/tests\/browser\/.+\.spec\.ts$/;

// The new-side lines each spec's diff touches. A deletion touches the lines
// either side of it: removing an assertion changes the test around it.
export function touchedLines(diff) {
  const files = new Map();
  let current = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      current = SPEC.test(path) ? path : null;
      if (current && !files.has(current)) files.set(current, new Set());
      continue;
    }
    const hunk = current && /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    const lines = files.get(current);
    if (count === 0) { lines.add(start); lines.add(start + 1); }
    for (let n = start; n < start + count; n++) lines.add(n);
  }
  return files;
}

// Which tests those lines belong to, given every test's start line in the
// file. A line before the first test (imports, helpers, file-wide hooks)
// selects the whole file. Otherwise the test it sits in, and the next one,
// in case the line is a describe block's hook just above it.
export function selectTests(testLines, touched) {
  const starts = [...new Set(testLines)].sort((a, b) => a - b);
  if (!starts.length || !touched.size) return [];
  const chosen = new Set();
  for (const line of touched) {
    if (line < starts[0]) return starts;
    let i = starts.length - 1;
    while (starts[i] > line) i--;
    chosen.add(starts[i]);
    if (i + 1 < starts.length) chosen.add(starts[i + 1]);
  }
  return [...chosen].sort((a, b) => a - b);
}

function listTests(root, files) {
  const out = execFileSync("pnpm", ["exec", "playwright", "test", "--list", "--reporter=json",
    "--project=chromium", ...files.map((file) => file.replace(/^client\//, ""))],
  { cwd: resolve(root, "client"), encoding: "utf8", maxBuffer: 64 << 20 });
  const starts = new Map();
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const file = `client/tests/browser/${spec.file}`;
      if (!starts.has(file)) starts.set(file, []);
      starts.get(file).push(spec.line);
    }
    (suite.suites ?? []).forEach(walk);
  };
  JSON.parse(out).suites.forEach(walk);
  return starts;
}

export function changedTests(base, head, root = REPO) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
  const start = git("merge-base", base, head ?? "HEAD").trim();
  // --no-prefix: plain paths whatever anybody's diff.mnemonicPrefix says.
  let diff = git("diff", "--no-renames", "--no-prefix", "-U0", start, ...(head ? [head] : []),
    "--", "client/tests/browser");
  if (!head) {
    for (const path of git("ls-files", "--others", "--exclude-standard", "-z", "--", "client/tests/browser")
      .split("\0").filter((path) => SPEC.test(path)))
      diff += `\n+++ ${path}\n@@ -0,0 +1,100000 @@\n`;
  }
  const touched = touchedLines(diff);
  if (!touched.size) return [];
  const starts = listTests(root, [...touched.keys()]);
  return [...touched].flatMap(([file, lines]) =>
    selectTests(starts.get(file) ?? [], lines).map((line) => `${file.replace(/^client\//, "")}:${line}`));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [base, head] = process.argv.slice(2);
  if (!base) { console.error("usage: node scripts/changed-tests.mjs <base> [head]"); process.exit(2); }
  for (const location of changedTests(base, head)) console.log(location);
}
