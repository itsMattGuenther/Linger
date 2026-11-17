// The fresh review before a pull request opens or merges (#917): the hook
// stops a command whose commit a review found something in, hands the
// findings over, lets the same commit through the next time, and stops
// rather than guesses at a command it can't read. Claude and gh are stood in
// for; real git repositories are made in a temporary folder.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ACTIONS, NETWORK_MS, REVIEW_MS, WORKTREE_PREFIX, folderOf, parseWords, readCommand, recordName, repoOf, reviewerArgs, reviewerCommand, unquote, verdict } from "./review-gate.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const GATE = fileURLToPath(new URL("./review-gate.mjs", import.meta.url));
const URL_OF = "https://github.com/test/linger.git";

test("reads which pull request, folder and branch a command is about", () => {
  const table = [
    ["create", 'gh pr create --title "a b" --body-file x', { dirs: [], base: null }],
    ["create", "cd /x/y && gh pr create --title t", { dirs: ["/x/y"] }],
    ["create", 'cd "/x/a b"; cd sub && gh pr create', { dirs: ["/x/a b", "sub"] }],
    ["create", "cd ~/p && git push -u origin HEAD && gh pr create -t x", { dirs: ["~/p"] }],
    ["create", "git push && gh pr create", { dirs: [] }],
    ["create", "gh pr create -B release -t x", { base: "release" }],
    ["create", "gh pr create --base=release", { base: "release" }],
    // The body a heredoc writes, brackets and all, needn't be read.
    ["create", "gh pr create --title t --body \"$(cat <<'EOF'\nFixes #1 (one)\n1) two\nEOF\n)\"", { dirs: [] }],
    ["create", "\ngh pr create --title t\n", { dirs: [] }],
    ["create", "GH_REPO=o/r gh pr create", { repo: "o/r" }],
    ["create", "gh pr create -R o/r --title t", { repo: "o/r" }],
    // A flag's name in the body, or in the next command, isn't this command's.
    ["create", 'gh pr create --title t --body "run grep -R foo -B 3 ."', { repo: null, base: null }],
    ["create", "gh pr create -t t && gh issue comment 5 -R o/site --body x", { repo: null }],
    ["create", "gh pr create -B main --title t --body \"$(cat <<'EOF'\nwords\nEOF\n)\"", { base: "main" }],
    ["merge", "gh pr merge 912 --squash --admin", { selector: "912" }],
    ["merge", "gh pr merge https://github.com/o/r/pull/9 --admin", { selector: "https://github.com/o/r/pull/9" }],
    ["merge", "gh pr merge --squash --admin", { selector: null }],
    ["merge", "gh pr merge --squash --admin # after", { selector: null }],
    ["merge", "gh pr merge 912 -R o/r --body-file m.txt", { selector: "912", repo: "o/r" }],
    // A value is read with its flag, so a body or title that looks like a flag is text.
    ["create", "gh pr create --title test --body '--repo=other/project'", { repo: null }],
    ["create", "gh pr create -t '-H x' -b '--base=release'", { base: null }],
    ["create", "gh pr create -Bmain -tTitle", { base: "main" }],
    ["merge", "gh pr merge 5 --subject '--auto' --squash", { selector: "5" }],
    ["merge", "gh pr merge 912 --squash && gh issue comment 5 -R o/site --body x", { selector: "912", repo: null }],
    ["merge", "gh pr merge https://github.com/o/site/pull/5 --squash", { repo: "o/site" }],
    ["merge", "gh pr merge https://github.com/o/r/pull/9 -R O/R", { repo: "o/r" }],
    ["merge", "gh pr merge 5 --repo=o/r", { selector: "5", repo: "o/r" }],
    ["merge", "cd /w && gh pr merge 5 --squash && git pull", { selector: "5", dirs: ["/w"] }],
    // A redirection is the shell's, not one of gh's words (#924).
    ["merge", "gh pr merge 5 --squash --admin 2>&1 | tail -3", { selector: "5" }],
    ["merge", "gh pr merge 5 2>/dev/null", { selector: "5" }],
    ["merge", "gh pr merge 5 >&2 --admin", { selector: "5" }],
    ["merge", "gh pr merge 5 &>log.txt", { selector: "5" }],
    ["merge", "gh pr merge 5 --squash>out.txt 2>&-", { selector: "5" }],
    // As the shell reads it: digits glued to > name what's redirected, not a pull request.
    ["merge", "gh pr merge 5>out.txt", { selector: null }],
    ["merge", "gh pr merge 5 2>&1>out.txt", { selector: "5" }],
    ["merge", "gh pr merge 5 >>log.txt <in.txt 0<&-", { selector: "5" }],
    ["merge", "gh pr merge>log.txt 5", { selector: "5" }],
    ["create", "gh pr create -t x -B release 2>>log.txt", { base: "release" }],
    ["create", "git push -u origin HEAD 2>&1 && gh pr create -t x", { dirs: [] }],
    ["merge", "cd /w 2>/dev/null && gh pr merge 5", { selector: "5", dirs: ["/w"] }],
    ["merge", "cd 2>/dev/null /w && gh pr merge 5", { selector: "5", dirs: ["/w"] }],
    // Before gh and between its words, as the shell allows them.
    ["merge", "gh 2>&1 pr merge 5", { selector: "5" }],
    ["merge", "gh pr 2>/dev/null merge 5", { selector: "5" }],
    ["merge", "2>/dev/null gh pr merge 5", { selector: "5" }],
    ["create", "GH_REPO=o/r >log.txt gh pr create -t x", { repo: "o/r" }],
    // A redirection's target that looks like a setting is a file's name.
    ["create", ">GH_REPO=o/r gh pr create -t x", { repo: null }],
    ["merge", "gh pr merge 5 >| out.txt <> rw.txt <<< x", { selector: "5" }],
    // Glued together, before gh or between its words.
    ["merge", "2>/dev/null>log.txt gh pr merge 5", { selector: "5" }],
    ["merge", "gh 2>a.txt>b.txt pr merge 5", { selector: "5" }],
    ["merge", "gh>log.txt pr>log.txt merge 5", { selector: "5" }],
    // A group of short flags, as gh reads it: each a flag until one takes a value.
    ["merge", "gh pr merge 5 -sR o/r", { selector: "5", repo: "o/r" }],
    ["create", "gh pr create -t x -dB release", { base: "release" }],
    ["create", "gh pr create -t x -dBrelease", { base: "release" }],
    ["create", "gh pr create -t x > out.txt", { base: null }],
    ["create", "gh pr create -t x -B release 2>&1", { base: "release" }],
    ["ready", "gh pr ready", { selector: null }],
    ["ready", "gh pr ready 12", { selector: "12" }],
  ];
  for (const [action, command, want] of table) {
    const read = readCommand(command, action);
    assert.ok(read && !read.fail, `${command} → ${JSON.stringify(read)}`);
    for (const [key, value] of Object.entries(want)) assert.deepEqual(read[key], value, `${command}: ${key}`);
  }
});

test("a command it might be and can't read exactly is stopped, never guessed", () => {
  const table = [
    ["create", "gh pr create --head other"],
    ["create", "gh pr create -H other"],
    ["create", "gh pr create --base a --base b"],
    ["create", "gh pr create --base"],
    ["create", "ls && gh pr create"],
    ["create", "git checkout other && gh pr create"],
    ["create", "cd - && gh pr create"],
    ["create", "cd $HOME/x && gh pr create"],
    ["create", "cd x | gh pr create"],
    ["create", "cd x || gh pr create"],
    ["create", "(cd x && gh pr create)"],
    ["create", "$(echo) gh pr create"],
    ["create", "X=$(pwd) gh pr create"],
    ["create", "/usr/bin/gh pr create"],
    ["create", "command gh pr create"],
    ["create", "echo gh pr create"],
    ["merge", "\"gh\" pr merge 5"],
    ["merge", "gh pr merge --squash 912"],
    // A redirection whose target it can't read is still a word it can't read.
    ["merge", "gh pr merge 5 > $(mktemp)"],
    ["merge", 'gh pr merge 5 2>"$LOG"'],
    // Its digits are never a word, so never a flag's value (#924).
    ["create", 'gh pr create -t x --repo 2>"$LOG" o/r'],
    ["create", 'gh pr create -t x -B 2>"$LOG" release'],
    ["merge", "cd 2>/dev/null && gh pr merge 5"],
    // &> is a redirection, not the command's end, so what follows is read.
    ["merge", 'gh pr merge 5 &>"$LOG" --auto'],
    ["merge", "gh pr merge 5 &>log.txt --auto"],
    // Between gh's words: read, so --auto is seen; or not read, and stopped.
    ["merge", "gh pr 2>/dev/null merge 5 --auto"],
    ["merge", 'gh pr 2>"$X y" merge 5'],
    ["merge", "gh pr \\\n        merge 5"],
    ["merge", "gh pr merge 5 --body-file - <<'EOF'\nwords\nEOF"],
    // A target it can't read after a blank, or with a blank escaped in it.
    ["merge", "gh pr 2> $LOG merge 5 --auto"],
    ["merge", 'gh 2> "$L" pr merge 5'],
    ["merge", "gh pr 2>a\\ b merge 5"],
    // The & of &> doesn't start a command: gh here is true's word, and the
    // words in order are enough to stop it.
    ["merge", "true &>/dev/null gh pr merge 5"],
    // A flag that matters, after a body it can't read and a line continued, or quoted.
    ["create", 'gh pr create -b "$(cat x)" \\\n-B release'],
    ["create", 'gh pr create -b "$(cat x)" "-R" o/r'],
    ["create", "gh pr create -b \"$(cat x)\" --ba''se release"],
    ["create", 'gh pr create -b "$(cat x)" -""B release'],
    ["create", 'gh pr create -b "$(cat x)" -dB release'],
    ["create", "gh pr create -t x -dH other"],
    // A second copy after the one it read, read or not, would go unreviewed.
    ["merge", 'gh pr merge 5 >/dev/null; gh 2>"$L" pr merge 6 --auto'],
    ["merge", 'gh pr merge 5 && "gh" pr merge 6'],
    // Claude Code fired the hook from its own reading, so the words in order
    // are enough: the gate can't tell this from a merge it can't read.
    ["merge", "gh pr create --title merge"],
    ["merge", 'gh pr merge 912 --body "$(cat x)" -R o/r'],
    ["merge", 'gh pr merge 912 -R o/r --body "$(cat x)"'],
    ["merge", 'gh pr merge 5 --body "$(cat message.txt)" --auto --squash'],
    ["create", "gh pr create -Hother"],
    ["create", "gh pr create -t x -Hother"],
    ["merge", "gh pr merge https://github.com/o/r/pull/9 -R a/b"],
    ["create", "gh pr create --title t --body \"$(cat <<'EOF'\nwords\nEOF\n)\" --base release"],
    ["create", 'gh pr create --body "$(cat x)" -H other'],
    // After a body it can't read, a flag's name might be the body's or the command's.
    ["create", "gh pr create -B main --title t --body \"$(cat <<'EOF'\nuse grep -R here\nEOF\n)\""],
    ["merge", 'gh pr merge --subject "a b" 912'],
    ["merge", 'gh pr merge --squash --body "$(cat x)"'],
    ["merge", "gh pr merge $N"],
    ["merge", "gh pr merge 1 && gh pr merge 2"],
    ["merge", "gh pr merge 5 -R a/b --repo c/d"],
    ["merge", "GH_REPO=a/b gh pr merge 5 -R c/d"],
    ["merge", "gh pr merge 5 -R"],
    ["ready", "git status && gh pr ready 3"],
    // A push first would change the pull request after the review.
    ["merge", "git push && gh pr merge 5 --squash"],
    ["ready", "git push origin feat/x && gh pr ready 5"],
    ["merge", "gh pr merge 5 --auto --squash"],
  ];
  for (const [action, command] of table) {
    const read = readCommand(command, action);
    assert.ok(read?.fail, `${command} should be stopped, got ${JSON.stringify(read)}`);
  }
});

test("a long command it can't place comes back, rather than running on", () => {
  // In a process of its own, so a pattern that backtracks without end is
  // stopped and fails here rather than holding up every test after it. The
  // limit is far past the milliseconds it takes, so a busy machine can't fail it.
  const script = `import { readCommand } from ${JSON.stringify(new URL("./review-gate.mjs", import.meta.url).href)};
const longs = ["gh " + "=>".repeat(20_000) + " x", "gh pr " + "2>".repeat(20_000) + " x", ">|A= ".repeat(20_000) + "x", ">&A= ".repeat(20_000) + "x"];
for (const long of longs) if (readCommand(long, "merge") !== null) process.exit(2);`;
  const run = spawnSync(process.execPath, ["--input-type=module"], { input: script, timeout: 60_000 });
  assert.equal(run.status, 0, run.signal ? `still running after a minute (${run.signal})` : String(run.error ?? run.stderr));
});

test("a command that isn't one leaves the gate out", () => {
  for (const [action, command] of [
    ["create", "gh pr view 1"],
    ["create", "gh pr list"],
    ["create", "git status"],
    ["create", "gh pr create --help"],
    ["merge", "gh pr merge -h"],
    ["ready", "gh pr view --json isDraft"],
    // gh2 isn't gh: digits glued to > belong to the word before.
    ["merge", "gh2>a pr merge 5"],
    ["ready", "gh pr ready 12 --undo"],
  ]) assert.equal(readCommand(command, action), null, command);
});

test("each flag is read with its value", () => {
  const { flags, positional } = parseWords(["5", "--subject", "--auto", "-b--repo=x", "--squash", "-A", "me@x"], "merge");
  assert.deepEqual(flags.get("--subject"), ["--auto"]);
  assert.deepEqual(flags.get("--body"), ["--repo=x"]);
  assert.deepEqual(flags.get("--author-email"), ["me@x"]);
  assert.equal(flags.has("--auto"), false);
  assert.equal(flags.has("--repo"), false);
  assert.deepEqual(positional, [{ word: "5", at: 0 }]);
});

test("two base branches never share a record", () => {
  const head = "a".repeat(40);
  const names = ["release/foo", "release_foo", "release%2ffoo", "release%2f;foo", "main"].map((base) => recordName(head, base));
  assert.equal(new Set(names).size, names.length, names.join(" "));
  for (const name of names) assert.match(name, /^[\w.%;-]+$/);
});

test("words come out as the shell hands them over", () => {
  assert.equal(unquote(`"a b"`), "a b");
  assert.equal(unquote(`'a "b"'`), 'a "b"');
  assert.equal(unquote(`a"b c"'d'`), "ab cd");
  assert.equal(unquote(`"a\\"b"`), 'a"b');
});

test("the reviewer's verdict is its last line, and no verdict is findings", () => {
  assert.equal(verdict("(none)\nREVIEW: clean"), "clean");
  assert.equal(verdict("(none)\n\n`REVIEW: clean`\n"), "clean");
  assert.equal(verdict("**REVIEW: Clean**"), "clean");
  assert.equal(verdict("1. x\nREVIEW: findings"), "findings");
  assert.equal(verdict("REVIEW: clean\n1. one more thing"), "findings");
  assert.equal(verdict("nothing said"), "findings");
  assert.equal(verdict(""), "findings");
  // Without the line, only an answer that is nothing at all.
  assert.equal(verdict("```json\n[]\n```"), "clean");
  assert.equal(verdict("(none)"), "clean");
  assert.equal(verdict("[]"), "clean");
  assert.equal(verdict('```json\n[{"file": "a"}]\n```'), "findings");
});

test("a GitHub address names its repository; anything else names none", () => {
  assert.equal(repoOf("https://github.com/itsMattGuenther/Linger.git"), "itsmattguenther/linger");
  assert.equal(repoOf("git@github.com:itsMattGuenther/Linger.git"), "itsmattguenther/linger");
  assert.equal(repoOf("https://github.com/o/r"), "o/r");
  assert.equal(repoOf("git@github-work:o/r.git"), "o/r", "an SSH host alias");
  assert.equal(repoOf("ssh://git@github.com/o/r.git"), "o/r");
  assert.equal(repoOf("ssh://git@github.com:22/o/r"), "o/r");
  assert.equal(repoOf("/tmp/origin.git"), null);
  assert.equal(repoOf("/tmp/a/origin.git"), null);
  assert.equal(repoOf("file:///tmp/a/b.git"), null);
  assert.equal(repoOf(null), null);
});

test("folders follow each cd from where the command starts", () => {
  assert.equal(folderOf("/a", []), "/a");
  assert.equal(folderOf("/a", ["b", "../c"]), "/a/c");
  assert.equal(folderOf("/a", ["/x", "y"]), "/x/y");
  assert.equal(folderOf("/a", ["~/p"], "/home/me"), "/home/me/p");
  assert.equal(folderOf("/a", ["~"], "/home/me"), "/home/me");
});

test("the reviewer only reads, reviews just the commits, and is told the questions", () => {
  const args = reviewerArgs({ level: "high", base: "b".repeat(40), head: "h".repeat(40), questions: "QUESTIONS HERE" });
  assert.equal(args[0], "-p");
  assert.equal(args[1], `/code-review high ${"b".repeat(40)}...${"h".repeat(40)}`);
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
  const tools = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--append-system-prompt"));
  for (const tool of tools) assert.doesNotMatch(tool, /^(?:Edit|Write|NotebookEdit)$|^Bash\((?!git (?:diff|log|show|blame|merge-base|rev-parse|status):)/, tool);
  assert.ok(!tools.includes("Skill"));
  assert.equal(args[args.indexOf("--setting-sources") + 1], "user", "a pull request's .claude/ settings don't load");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.match(args.at(-1), /QUESTIONS HERE/);
  assert.match(args.at(-1), /REVIEW: clean/);
});

test("the reviewer is the Claude that's running only when that is Claude's own program", () => {
  assert.equal(reviewerCommand({ CLAUDE_CODE_EXECPATH: "/opt/claude/2.1/claude" }), "/opt/claude/2.1/claude");
  assert.equal(reviewerCommand({ CLAUDE_CODE_EXECPATH: "C:\\Claude\\claude.exe" }), "C:\\Claude\\claude.exe");
  assert.equal(reviewerCommand({ CLAUDE_CODE_EXECPATH: "/usr/bin/node" }), "claude");
  assert.equal(reviewerCommand({}), "claude");
  assert.equal(reviewerCommand({ LINGER_REVIEWER: "/x/stub", CLAUDE_CODE_EXECPATH: "/opt/claude" }), "/x/stub");
});

test("Claude Code runs the gate before each command it guards, and a gate that fails stops the command", () => {
  const settings = JSON.parse(readFileSync(join(ROOT, ".claude/settings.json"), "utf8"));
  const hooks = settings.hooks.PreToolUse.filter((group) => group.matcher === "Bash").flatMap((group) => group.hooks);
  for (const action of ACTIONS) {
    const mine = hooks.filter((hook) => hook.if === `Bash(gh pr ${action}:*)`);
    assert.equal(mine.length, 1, `one hook for gh pr ${action}`);
    assert.match(mine[0].command, new RegExp(`scripts/review-gate\\.mjs" --hook ${action}$`));
    assert.equal(mine[0].onFailure, "block", `a gate that crashes or runs out of time stops gh pr ${action}`);
    // gh, the pull request's fetch, the base's fetch and the questions each
    // have NETWORK_MS, then the review its own limit; the hook outlasts all.
    assert.ok(mine[0].timeout * 1000 > REVIEW_MS + 4 * NETWORK_MS + 60 * 1000, "the hook outlasts the review and every wait before it");
  }
});

// A repository with its origin on "GitHub" (a bare repository standing in
// through git's insteadOf), a branch with a change, and stand-ins for the
// reviewer and gh that log what they were asked.
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "review-gate-test-"));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
    TMPDIR: join(root, "tmp"),
    LINGER_REVIEWER: join(root, "reviewer.mjs"),
    LINGER_REVIEW_GH: join(root, "gh.mjs"),
    STUB_LOG: join(root, "calls.log"),
  };
  delete env.LINGER_COLD_REVIEW;
  delete env.LINGER_REVIEW_LEVEL;
  delete env.GH_REPO;
  mkdirSync(env.TMPDIR);
  const bare = join(root, "origin.git");
  writeFileSync(env.GIT_CONFIG_GLOBAL, `[url "${bare}"]\n\tinsteadOf = ${URL_OF}\n[commit]\n\tgpgsign = false\n`);
  const run = (cwd, ...args) => execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  run(root, "init", "--quiet", "--bare", "-b", "main", bare);
  const repo = join(root, "repo");
  run(root, "init", "--quiet", "-b", "main", repo);
  run(repo, "remote", "add", "origin", URL_OF);
  const put = (dir, path, text) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (dir, path, text) => {
    put(dir, path, text);
    run(dir, "add", "-A");
    run(dir, "commit", "--quiet", "-m", `change ${path}`);
    return run(dir, "rev-parse", "HEAD");
  };
  put(repo, "scripts/review-gate.mjs", "// the gate, so this repository is gated\n");
  put(repo, "docs/pr-questions.md", readFileSync(join(ROOT, "docs/pr-questions.md"), "utf8"));
  const main = commit(repo, "README.md", "readme\n");
  run(repo, "push", "--quiet", "origin", "main");
  run(repo, "checkout", "--quiet", "-b", "feat/x");
  const head = commit(repo, "client/src/thing.ts", "export const one = 1;\n");

  writeFileSync(env.LINGER_REVIEWER, `#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
appendFileSync(process.env.STUB_LOG, JSON.stringify({ who: "reviewer", cwd: process.cwd(), args: process.argv.slice(2), cold: process.env.LINGER_COLD_REVIEW, sawUncommitted: existsSync("client/src/scratch.ts") }) + "\\n");
const how = process.env.STUB_VERDICT || "findings";
if (how === "fail") { console.error("no luck"); process.exit(1); }
if (how === "garbage") { console.log("not json"); process.exit(0); }
if (how === "error") { console.log(JSON.stringify({ type: "result", is_error: true, subtype: "error_max_turns" })); process.exit(0); }
console.log(JSON.stringify({ type: "result", is_error: false, result: how === "clean" ? "(none)\\nREVIEW: clean" : "1. client/src/thing.ts:1: a stand-in finding.\\nREVIEW: findings" }));
`);
  writeFileSync(env.LINGER_REVIEW_GH, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(process.env.STUB_LOG, JSON.stringify({ who: "gh", args: process.argv.slice(2) }) + "\\n");
if (!process.env.STUB_PR) { console.error("HTTP 401: Bad credentials"); process.exit(1); }
const asked = readFileSync(process.env.STUB_LOG, "utf8").split("\\n").filter((line) => line.includes('"who":"gh"')).length;
console.log(asked > 1 && process.env.STUB_PR_LATER ? process.env.STUB_PR_LATER : process.env.STUB_PR);
`);
  chmodSync(env.LINGER_REVIEWER, 0o755);
  chmodSync(env.LINGER_REVIEW_GH, 0o755);

  const calls = () => (existsSync(env.STUB_LOG) ? readFileSync(env.STUB_LOG, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  const gate = (action, command, { cwd = repo, extra = {}, input } = {}) => {
    const result = spawnSync(process.execPath, [GATE, "--hook", action], {
      input: input ?? JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, cwd }),
      env: { ...env, ...extra },
      encoding: "utf8",
    });
    return { code: result.status, stderr: result.stderr, stdout: result.stdout };
  };
  const markers = (dir = repo) => {
    const folder = join(dir, ".git", "linger-review");
    return existsSync(folder) ? execFileSync("ls", [folder], { encoding: "utf8" }).split("\n").filter(Boolean) : [];
  };
  return { root, repo, env, run, put, commit, main, head, calls, gate, markers, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("findings stop the pull request once and are handed over; the same commit then passes", () => {
  const box = sandbox();
  try {
    const first = box.gate("create", "gh pr create --title t --body b");
    assert.equal(first.code, 2, first.stderr);
    assert.match(first.stderr, /a stand-in finding/);
    assert.match(first.stderr, new RegExp(box.head.slice(0, 10)));
    const [call] = box.calls();
    assert.equal(call.who, "reviewer");
    assert.equal(call.args[1], `/code-review high ${box.main}...${box.head}`);
    assert.equal(call.cold, "1", "the reviewer's own commands don't start another review");
    assert.ok(call.cwd.startsWith(join(box.env.TMPDIR, WORKTREE_PREFIX)), `a clean copy of the commit, not the folder: ${call.cwd}`);
    assert.equal(existsSync(call.cwd), false, "the copy is removed");
    assert.deepEqual(box.markers(), [recordName(box.head, "main")]);

    const again = box.gate("create", "gh pr create --title t --body b");
    assert.equal(again.code, 0, again.stderr);
    assert.equal(box.calls().length, 1, "the same commit isn't reviewed twice");

    const next = box.commit(box.repo, "client/src/thing.ts", "export const one = 2;\n");
    const fixed = box.gate("create", "gh pr create --title t --body b", { extra: { STUB_VERDICT: "clean" } });
    assert.equal(fixed.code, 0, fixed.stderr);
    assert.match(JSON.parse(fixed.stdout).systemMessage, /found nothing/);
    assert.equal(box.calls().length, 2, "a new commit gets a new review");
    assert.equal(box.calls()[1].args[1], `/code-review high ${box.main}...${next}`);
    assert.equal(JSON.parse(readFileSync(join(box.repo, ".git/linger-review", recordName(next, "main")), "utf8")).verdict, "clean");
  } finally {
    box.done();
  }
});

test("a reviewer that fails stops the command and records nothing, so the next try reviews", () => {
  const box = sandbox();
  try {
    for (const how of ["fail", "garbage", "error"]) {
      const result = box.gate("create", "gh pr create -t t", { extra: { STUB_VERDICT: how } });
      assert.equal(result.code, 2, how);
      assert.match(result.stderr, /couldn't run/, how);
      assert.deepEqual(box.markers(), [], how);
    }
    const missing = box.gate("create", "gh pr create -t t", { extra: { LINGER_REVIEWER: join(box.root, "nowhere") } });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /couldn't start/);
    assert.equal(box.gate("create", "gh pr create -t t", { extra: { STUB_VERDICT: "clean" } }).code, 0);
  } finally {
    box.done();
  }
});

test("the folder a cd moves to is the one reviewed", () => {
  const box = sandbox();
  try {
    const result = box.gate("create", "cd repo && gh pr create -t t", { cwd: box.root });
    assert.equal(result.code, 2, result.stderr);
    assert.equal(box.calls()[0].args[1], `/code-review high ${box.main}...${box.head}`);
    const gone = box.gate("create", "cd nowhere && gh pr create -t t", { cwd: box.root });
    assert.equal(gone.code, 2);
    assert.match(gone.stderr, /isn't there/);
  } finally {
    box.done();
  }
});

test("nothing is reviewed for docs only, nothing to review, inside a review, or another repository", () => {
  const box = sandbox();
  try {
    box.run(box.repo, "checkout", "--quiet", "-b", "docs/y", "main");
    box.commit(box.repo, "docs/guide.md", "words\n");
    box.commit(box.repo, "assets/logo.png", "png\n");
    assert.equal(box.gate("create", "gh pr create -t t").code, 0, "docs only");
    box.run(box.repo, "checkout", "--quiet", "main");
    assert.equal(box.gate("create", "gh pr create -t t").code, 0, "nothing on main to review");
    box.run(box.repo, "checkout", "--quiet", "feat/x");
    assert.equal(box.gate("create", "gh pr create -t t", { extra: { LINGER_COLD_REVIEW: "1" } }).code, 0, "inside a review");
    assert.equal(box.gate("merge", "gh pr merge 5 -R someone/else").code, 0, "another repository");
    assert.equal(box.gate("create", "GH_REPO=someone/else gh pr create").code, 0, "another repository by setting");
    const other = join(box.root, "other");
    box.run(box.root, "init", "--quiet", "-b", "main", other);
    box.commit(other, "a.ts", "x\n");
    assert.equal(box.gate("create", "gh pr create", { cwd: other }).code, 0, "a repository without the gate");
    assert.deepEqual(box.calls(), []);
    // The same repository named in full is still gated.
    assert.equal(box.gate("create", "gh pr create -R test/Linger").code, 2);
  } finally {
    box.done();
  }
});

test("a command it can't read, or input that isn't the hook's, is stopped before any review", () => {
  const box = sandbox();
  try {
    const result = box.gate("create", "ls && gh pr create");
    assert.equal(result.code, 2);
    assert.match(result.stderr, /Stopped before review/);
    assert.equal(box.gate("create", "", { input: "not json" }).code, 2);
    assert.deepEqual(box.calls(), []);
  } finally {
    box.done();
  }
});

test("a merge reviews the pull request's own commit in a copy, fetching it if need be, and removes the copy", () => {
  const box = sandbox();
  try {
    box.run(box.repo, "push", "--quiet", "origin", `${box.head}:refs/pull/7/head`);
    // A clone that has never seen the pull request's commit.
    const clone = join(box.root, "clone");
    box.run(box.root, "clone", "--quiet", "--no-local", URL_OF, clone);
    assert.throws(() => box.run(clone, "cat-file", "-e", `${box.head}^{commit}`));
    // A copy a killed run left behind, two and a half hours ago.
    const stale = mkdtempSync(join(box.env.TMPDIR, WORKTREE_PREFIX));
    box.run(clone, "worktree", "add", "--quiet", "--detach", stale, "HEAD");
    const old = (Date.now() - 2.5 * 60 * 60 * 1000) / 1000;
    utimesSync(stale, old, old);

    const pr = JSON.stringify({ number: 7, headRefOid: box.head, baseRefName: "main", state: "OPEN", url: "https://github.com/test/linger/pull/7" });
    const result = box.gate("merge", "gh pr merge 7 --squash --admin", { cwd: clone, extra: { STUB_PR: pr } });
    assert.equal(result.code, 2, result.stderr);
    const [gh, reviewer] = box.calls();
    assert.ok(reviewer, `the reviewer ran: ${result.stderr}`);
    assert.deepEqual(gh.args.slice(0, 3), ["pr", "view", "7"]);
    assert.equal(reviewer.args[1], `/code-review high ${box.main}...${box.head}`);
    assert.ok(reviewer.cwd.startsWith(join(box.env.TMPDIR, WORKTREE_PREFIX)), reviewer.cwd);
    assert.notEqual(reviewer.cwd, stale);
    assert.equal(existsSync(reviewer.cwd), false, "the copy is removed");
    assert.equal(existsSync(stale), false, "the copy a killed run left is cleared");
    assert.equal(box.run(clone, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length, 1);
    assert.deepEqual(box.markers(clone), [recordName(box.head, "main")]);

    assert.equal(box.gate("merge", "gh pr merge 7 --squash --admin", { cwd: clone, extra: { STUB_PR: pr } }).code, 0, "the same commit passes");
  } finally {
    box.done();
  }
});

test("a merge of a pull request that isn't open passes, and gh failing stops it", () => {
  const box = sandbox();
  try {
    const merged = JSON.stringify({ number: 7, headRefOid: box.head, baseRefName: "main", state: "MERGED", url: "https://github.com/test/linger/pull/7" });
    assert.equal(box.gate("merge", "gh pr merge 7", { extra: { STUB_PR: merged } }).code, 0);
    const failed = box.gate("merge", "gh pr merge 7");
    assert.equal(failed.code, 2);
    assert.match(failed.stderr, /gh couldn't say which pull request/);
    const odd = box.gate("merge", "gh pr merge 7", { extra: { STUB_PR: JSON.stringify({ number: 7, headRefOid: "nope", state: "OPEN" }) } });
    assert.equal(odd.code, 2);
    // gh's answer names the repository, so another project's pull request passes.
    const site = JSON.stringify({ number: 7, headRefOid: box.head, baseRefName: "main", state: "OPEN", url: "https://github.com/test/linger-site/pull/7" });
    assert.equal(box.gate("merge", "gh pr merge 7", { extra: { STUB_PR: site } }).code, 0);
    assert.ok(!box.calls().some((call) => call.who === "reviewer"));
  } finally {
    box.done();
  }
});

test("the reviewer is given the questions for the change, and the pull request's own scripts never run", () => {
  const box = sandbox();
  try {
    const ran = join(box.root, "ran");
    box.commit(box.repo, "scripts/pr-questions.mjs", `require("node:fs").writeFileSync(${JSON.stringify(ran)}, "x");\n`);
    assert.equal(box.gate("create", "gh pr create -t t").code, 2);
    const prompt = box.calls()[0].args.at(-1);
    // client/src is the page, so the page's questions, and not the server's alone.
    assert.match(prompt, /Is anything worked out from a room's history/);
    assert.equal(existsSync(ran), false, "the pull request's own script didn't run");
  } finally {
    box.done();
  }
});

test("a review is per base branch, and records past keeping are deleted", () => {
  const box = sandbox();
  try {
    box.run(box.repo, "push", "--quiet", "origin", "main:release");
    const records = join(box.repo, ".git", "linger-review");
    mkdirSync(records, { recursive: true });
    const old = join(records, recordName("0".repeat(40), "main"));
    writeFileSync(old, "{}");
    const then = (Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(old, then, then);
    assert.equal(box.gate("create", "gh pr create -t t").code, 2);
    assert.equal(box.gate("create", "gh pr create -B release -t t").code, 2, "another base is another review");
    assert.equal(box.calls().length, 2);
    assert.equal(existsSync(old), false, "a record forty days old is gone");
  } finally {
    box.done();
  }
});

test("a review level that isn't one stops the command", () => {
  const box = sandbox();
  try {
    const result = box.gate("create", "gh pr create -t t", { extra: { LINGER_REVIEW_LEVEL: "ultra" } });
    assert.equal(result.code, 2);
    assert.match(result.stderr, /LINGER_REVIEW_LEVEL/);
    assert.equal(box.gate("create", "gh pr create -t t", { extra: { LINGER_REVIEW_LEVEL: "low" } }).code, 2);
    assert.match(box.calls()[0].args[1], /^\/code-review low /);
  } finally {
    box.done();
  }
});

test("what's uncommitted in the folder isn't reviewed as the commit", () => {
  const box = sandbox();
  try {
    box.put(box.repo, "client/src/scratch.ts", "not committed\n");
    assert.equal(box.gate("create", "gh pr create -t t").code, 2);
    assert.equal(box.calls()[0].sawUncommitted, false);
  } finally {
    box.done();
  }
});

test("code moved into docs is still reviewed", () => {
  const box = sandbox();
  try {
    // Code that's on main, moved into docs/ on a branch of its own.
    box.run(box.repo, "checkout", "--quiet", "main");
    box.commit(box.repo, "client/src/old.ts", "export const old = 1;\n");
    box.run(box.repo, "push", "--quiet", "origin", "main");
    box.run(box.repo, "checkout", "--quiet", "-b", "feat/move");
    mkdirSync(join(box.repo, "docs"), { recursive: true });
    box.run(box.repo, "mv", "client/src/old.ts", "docs/old.md");
    box.run(box.repo, "commit", "--quiet", "-m", "move");
    assert.equal(box.gate("create", "gh pr create -t t").code, 2);
    assert.equal(box.calls().length, 1);
  } finally {
    box.done();
  }
});

test("from a fork, the pull request's base is upstream's, and naming upstream is still gated", () => {
  const box = sandbox();
  try {
    // The fork's main is a commit behind upstream's; the branch starts from upstream's.
    const fork = join(box.root, "fork.git");
    box.run(box.root, "clone", "--quiet", "--bare", "--no-local", URL_OF, fork);
    const forkUrl = "https://github.com/me/linger.git";
    writeFileSync(box.env.GIT_CONFIG_GLOBAL, readFileSync(box.env.GIT_CONFIG_GLOBAL, "utf8") + `[url "${fork}"]\n\tinsteadOf = ${forkUrl}\n`);
    box.run(box.repo, "checkout", "--quiet", "main");
    const newer = box.commit(box.repo, "client/src/later.ts", "later\n");
    box.run(box.repo, "push", "--quiet", "origin", "main");
    box.run(box.repo, "remote", "rename", "origin", "upstream");
    box.run(box.repo, "remote", "add", "origin", forkUrl);
    box.run(box.repo, "fetch", "--quiet", "origin");
    box.run(box.repo, "checkout", "--quiet", "-b", "feat/fork", newer);
    const head = box.commit(box.repo, "client/src/mine.ts", "mine\n");

    assert.equal(box.gate("create", "gh pr create -R test/linger -t t").code, 2, "naming upstream is this repository");
    assert.equal(box.calls()[0].args[1], `/code-review high ${newer}...${head}`, "only the branch's own commit");
    box.commit(box.repo, "client/src/mine.ts", "mine again\n");
    assert.equal(box.gate("create", "gh pr create -t t").code, 2, "with none named, upstream");
    assert.match(box.calls()[1].args[1], new RegExp(`^/code-review high ${newer}\\.\\.\\.`));
  } finally {
    box.done();
  }
});

test("the questions not read stops the review, rather than reviewing without them", () => {
  const box = sandbox();
  try {
    box.run(box.repo, "rm", "--quiet", "docs/pr-questions.md");
    box.commit(box.repo, "client/src/thing.ts", "export const one = 3;\n");
    const result = box.gate("create", "gh pr create -t t");
    assert.equal(result.code, 2);
    assert.match(result.stderr, /questions couldn't be read/);
    assert.equal(box.calls().length, 0);
    assert.deepEqual(box.markers(), []);
  } finally {
    box.done();
  }
});

test("a pull request pushed to during its review isn't merged", () => {
  const box = sandbox();
  try {
    box.run(box.repo, "push", "--quiet", "origin", `${box.head}:refs/pull/7/head`);
    const pr = (head) => JSON.stringify({ number: 7, headRefOid: head, baseRefName: "main", state: "OPEN", url: "https://github.com/test/linger/pull/7" });
    const moved = box.gate("merge", "gh pr merge 7 --squash", { extra: { STUB_VERDICT: "clean", STUB_PR: pr(box.head), STUB_PR_LATER: pr("b".repeat(40)) } });
    assert.equal(moved.code, 2, moved.stderr);
    assert.match(moved.stderr, /changed during the review/);
    // Reviewed and unchanged, it goes through.
    const same = box.gate("merge", "gh pr merge 7 --squash", { extra: { STUB_PR: pr(box.head) } });
    assert.equal(same.code, 0, same.stderr);
  } finally {
    box.done();
  }
});
