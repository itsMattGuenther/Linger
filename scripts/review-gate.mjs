#!/usr/bin/env node
// A fresh review before a pull request opens or merges (#917).
//
// The agent that writes a change also writes its tests and answers
// docs/pr-questions.md, so all three share its blind spots, and most of what
// Greptile caught was exactly that (docs/review-catches.md). A reviewer that
// reads the change cold, without the plan behind it, finds much of it first.
// Claude Code's hook (.claude/settings.json) calls this before `gh pr create`,
// `gh pr ready` and `gh pr merge`, and it runs `/code-review` in a separate
// Claude process on the commits being proposed or merged, with the questions
// docs/pr-questions.md asks of them. Nobody has to remember to start it.
//
//   node scripts/review-gate.mjs --hook create|ready|merge   the hook: its JSON on stdin
//   node scripts/review-gate.mjs                             review this branch now
//   node scripts/review-gate.mjs <number>                    review pull request <number> now
//
// Each commit is reviewed once. With findings, the hook stops the command and
// hands them to the agent, and the same commit passes the next time: the agent
// fixes what's real and answers what isn't. A new commit gets a new review.
// Docs-only changes aren't reviewed. A command the gate can't read is stopped,
// never guessed at, with the plain form to use instead.
//
// LINGER_REVIEW_LEVEL picks /code-review's level (default high). Tests stand
// in for Claude and gh with LINGER_REVIEWER and LINGER_REVIEW_GH.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { partsOf } from "./pr-questions.mjs";

export const ACTIONS = ["create", "ready", "merge"];
export const LEVELS = ["low", "medium", "high", "xhigh", "max"];
export const DEFAULT_LEVEL = "high";

/** Long enough for /code-review at high on a 5,000-line change; the hook's own limit is 40 minutes. */
export const REVIEW_MS = 25 * 60 * 1000;
export const NETWORK_MS = 2 * 60 * 1000;
/** A temporary copy older than this was left by a run that was killed. */
const STALE_MS = 2 * 60 * 60 * 1000;
export const WORKTREE_PREFIX = "linger-review-";
const MOST_QUESTIONS = 20_000;
/** A review's record is kept this long, then deleted, so the folder doesn't grow for ever. */
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const HERE = dirname(fileURLToPath(import.meta.url));

/** What the reviewer may do: read the code and the history, never change either. */
export const REVIEWER_TOOLS = [
  "Read", "Grep", "Glob", "Agent",
  "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git blame:*)",
  "Bash(git merge-base:*)", "Bash(git rev-parse:*)", "Bash(git status:*)",
];

// A shell word the gate can read: plain characters and quoted pieces, with no
// variable, substitution, glob or redirection in it. Anything else isn't
// matched, so a command that needs one where the gate looks is stopped.
const PIECE = String.raw`(?:"(?:[^"\\$\x60]|\\[\\"$\x60])*"|'[^']*'|[^\s;&|<>()"'$\x60\\*?\[\]{}#])`;
const WORD = `(?:${PIECE}+)`;
const ASSIGN = String.raw`[A-Za-z_]\w*=(?:${WORD})?`;
// What ends one command: ; | ) a newline, or an & that doesn't start `&>`.
const SEPARATOR = String.raw`[;|)\n]|&(?!>)`;
// Where a word ends, as in the shell: a blank, a separator, the end, or a
// redirection glued to it (`--squash>out`, `x&>log`).
const AFTER = String.raw`(?=$|[ \t<>&]|${SEPARATOR})`;
// A redirection, operators longest first, and what it reads or writes: the
// shell's, not one of gh's words (#924). One whose target the gate can't read
// (a substitution, a variable) doesn't match, so the command is stopped.
const REDIR = String.raw`(?:\d*(?:>>|>&|>\||>|<<<|<&|<>|<)|&>>|&>)[ \t]*${WORD}${AFTER}`;
// Where a redirection starts, read or not, so its digits (`2>`) are never a word.
const NOT_REDIR = String.raw`(?!\d*[<>])`;
// Where a command starts: the start, or after ; newline ( or a | or & that
// isn't part of a redirection (`>|`, `>&`, `<&`, `&>`).
const START = String.raw`(^|[;\n(]|(?<![<>])\||(?<![<>])&(?!>))[ \t]*`;
// Before gh, among the settings, and between gh, pr and the action, the shell
// allows redirections too (`2>/dev/null gh pr 2>&1 merge 5`), glued together or
// not; they're passed over. A redirection's target that looks like a setting
// (`>GH_REPO=o/r` writes a file of that name) is never one: FRONT says which.
const FRONT = String.raw`(?:(${ASSIGN})[ \t]+|${REDIR}[ \t]*)`;
const GAP = String.raw`(?:(?:[ \t]+|(?=[<>&]))${REDIR})*[ \t]+`;
const GH = (action) => new RegExp(`${START}((?:${FRONT})*)gh${GAP}pr${GAP}${action}${AFTER}`, "g");
// What may come before the command on its line: changes of folder and a push.
// Either may have redirections (`2>/dev/null`), and their digits are never its words.
const STEP = new RegExp(String.raw`^\s*(?:cd(?:[ \t]+${REDIR})*[ \t]+${NOT_REDIR}(${WORD})${AFTER}(?:[ \t]*${REDIR})*|git[ \t]+push${AFTER}(?:[ \t]*${REDIR}|[ \t]+${NOT_REDIR}${WORD}${AFTER})*)[ \t]*(?:&&|;|\n)`);
// What's in front of gh, one setting or redirection at a time, as GH matched it.
const IN_FRONT = new RegExp(FRONT, "y");
const TOKEN = new RegExp(String.raw`^[ \t]*${NOT_REDIR}(${WORD})${AFTER}`);
// Where the command ends: a separator, the end, or a comment (a # that starts a word).
// `&>` is a redirection, not an end.
const END = new RegExp(String.raw`^(?:[ \t]*(?:$|${SEPARATOR})|[ \t]+#)`);
const REDIRECT = new RegExp(String.raw`^[ \t]*${REDIR}`);

/** gh's flags that take a value, for each command: the long name, and its short one if it has one. */
const VALUED = {
  create: { "--title": "-t", "--body": "-b", "--body-file": "-F", "--base": "-B", "--head": "-H", "--assignee": "-a", "--label": "-l", "--milestone": "-m", "--project": "-p", "--reviewer": "-r", "--repo": "-R", "--template": "-T", "--recover": null },
  merge: { "--author-email": "-A", "--body": "-b", "--body-file": "-F", "--subject": "-t", "--match-head-commit": null, "--repo": "-R" },
  ready: { "--repo": "-R" },
};

/**
 * A command's flags and the words that aren't flags, each flag read with its
 * value (`--x y`, `--x=y`, `-x y`, `-xy`), so a value is never taken for a
 * flag: a body that says `--repo=x` is a body. Flags by their long names.
 */
export function parseWords(words, action) {
  const long = VALUED[action];
  const short = Object.fromEntries(Object.entries(long).filter(([, letter]) => letter).map(([name, letter]) => [letter, name]));
  const flags = new Map();
  const positional = [];
  const add = (name, value) => flags.set(name, [...(flags.get(name) ?? []), value]);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word.startsWith("--") && word.length > 2) {
      const eq = word.indexOf("=");
      const name = eq > 0 ? word.slice(0, eq) : word;
      if (Object.hasOwn(long, name)) add(name, eq > 0 ? word.slice(eq + 1) : (words[(i += 1)] ?? ""));
      else add(name, null);
    } else if (word.startsWith("-") && word.length > 1) {
      // A group of short flags (`-dB main`), as gh reads it: each letter is
      // a flag until one takes a value, which is the rest of the group or the
      // next word.
      for (let at = 1; at < word.length; at += 1) {
        const letter = `-${word[at]}`;
        if (short[letter]) {
          add(short[letter], at + 1 < word.length ? word.slice(at + 1) : (words[(i += 1)] ?? ""));
          break;
        }
        add(letter, null);
      }
    } else {
      positional.push({ word, at: i });
    }
  }
  return { flags, positional };
}

/** A word as the shell hands it over: quotes taken off, escapes in double quotes undone. */
export function unquote(word) {
  let out = "";
  for (const piece of word.match(new RegExp(PIECE, "g")) ?? []) {
    if (piece.startsWith('"')) out += piece.slice(1, -1).replace(/\\([\\"$\x60])/g, "$1");
    else if (piece.startsWith("'")) out += piece.slice(1, -1);
    else out += piece;
  }
  return out;
}

const stop = (why) => ({ fail: why });

/**
 * Whether `words` come in this order in `command`, each a word of its own,
 * anywhere. The gate's fallback when it can't place the command exactly:
 * Claude Code fired the hook from its own reading, so with the words there
 * in order it might be the command, however it's spelled (`command gh`, a
 * path, quotes, a redirection the gate can't read between them, a line
 * continued). One pass left to right, so no command makes it slow.
 */
function inOrder(command, words) {
  let from = 0;
  for (const word of words) {
    const found = new RegExp(String.raw`\b${word}\b`, "g");
    found.lastIndex = from;
    const hit = found.exec(command);
    if (!hit) return false;
    from = hit.index + word.length;
  }
  return true;
}

/**
 * What a command asks of `gh pr <action>`: the folders it changes to first,
 * which pull request (`selector`, for ready and merge), the base branch (for
 * create) and another repository if it names one. Null when it doesn't run
 * that command at all; `{ fail }` with why when it might and the gate can't
 * tell exactly how, because guessing would let a change through unreviewed.
 */
export function readCommand(command, action) {
  if (!ACTIONS.includes(action)) throw new Error(`unknown action ${action}`);
  const matches = [...command.matchAll(GH(action))];
  if (!matches.length) {
    // Claude Code's own reading of the command chose this hook, so the three
    // words in order in any other form are a command the gate can't place.
    // Without them it isn't one at all.
    if (inOrder(command, ["gh", "pr", action])) {
      return stop(`it couldn't find \`gh pr ${action}\` where a command starts`);
    }
    return null;
  }
  if (matches.length > 1) return stop(`it runs \`gh pr ${action}\` more than once`);
  const [match] = matches;
  const [, separator, assignments = ""] = match;
  const at = match.index + match[0].length;

  // Before it: only `cd <folder> &&` and `git push … &&`, so the gate knows
  // which folder, and so which branch, the command runs in.
  const dirs = [];
  let pushes = false;
  let rest = command.slice(0, match.index) + separator;
  for (let step = STEP.exec(rest); step; step = STEP.exec(rest)) {
    if (step[1] === undefined) pushes = true;
    else {
      const dir = unquote(step[1]);
      if (dir === "-" || dir === "") return stop("it changes folder with `cd -`");
      dirs.push(dir);
    }
    rest = rest.slice(step[0].length);
  }
  rest = rest.replace(/[\s;&|(]+$/, "");
  if (rest.trim()) return stop(`something runs before \`gh pr ${action}\` that the gate doesn't read (\`${rest.trim().slice(0, 60)}\`)`);

  const env = {};
  // GH matched it as FRONT items, so it reads back whole, one at a time.
  IN_FRONT.lastIndex = 0;
  for (let item = IN_FRONT.exec(assignments); item; item = IN_FRONT.exec(assignments)) {
    const [, assignment] = item;
    if (assignment === undefined) continue;
    const eq = assignment.indexOf("=");
    env[assignment.slice(0, eq)] = unquote(assignment.slice(eq + 1));
  }

  // After it: the words of this one command, up to where it ends or a word
  // the gate can't read.
  let after = command.slice(at);
  const words = [];
  let readable = true;
  for (;;) {
    const redirection = REDIRECT.exec(after);
    if (redirection) {
      after = after.slice(redirection[0].length);
      continue;
    }
    if (END.test(after)) break;
    const token = TOKEN.exec(after);
    if (!token) { readable = false; break; }
    words.push(unquote(token[1]));
    after = after.slice(token[0].length);
  }
  const { flags, positional } = parseWords(words, action);
  if (flags.has("--help") || flags.has("-h")) return null;
  // Back to a draft takes a pull request away from review; nothing to gate.
  if (action === "ready" && flags.has("--undo")) return null;

  // The flags that change what's reviewed are read from this command's own
  // words, never from a body's text or the next command. A merge or ready
  // is read whole: after a word the gate can't read, `--auto` or another
  // pull request could hide. A create may make its body with `$(…)`, but a
  // flag that matters after it might be the command's or the body's, so it
  // stops rather than guess.
  if (!readable && action !== "create") return stop(`a word after \`gh pr ${action}\` can't be read; run it with plain words, the body in --body-file`);
  // After any non-word character (a blank, a line continued), with quotes and
  // escapes taken out as the shell does (`--ba''se`, `-""B`), and in a group
  // of short flags (`-dB`).
  if (!readable && /(?:^|[^\w-])-(?:-(?:repo|head|base)|[A-Za-z]*[RHB])/.test(after.replace(/["'\\]/g, ""))) {
    return stop("`--repo`, `--head` or `--base` may come after a word it can't read; put them first, or the body in --body-file");
  }
  const repos = new Set(flags.get("--repo") ?? []);
  if (env.GH_REPO !== undefined) repos.add(env.GH_REPO);
  if (repos.has("") || repos.size > 1) return stop("which repository it's for can't be read");
  const read = { action, dirs, selector: null, base: null, repo: [...repos][0] ?? null };
  if (action === "create") {
    // The gate reviews the branch the folder is on, so a pull request from
    // another branch is stopped rather than reviewed as the wrong one.
    if (flags.has("--head")) return stop("it names a branch with `--head`");
    const bases = new Set(flags.get("--base") ?? []);
    if (bases.has("")) return stop("its `--base` can't be read");
    if (bases.size > 1) return stop("it names more than one `--base`");
    read.base = [...bases][0] ?? null;
    return read;
  }

  // Ready and merge: a push first would change the pull request after the
  // gate looked at it, and --auto merges whatever is pushed later, so the
  // commit reviewed wouldn't be the commit merged.
  if (pushes) return stop(`a push before \`gh pr ${action}\` would change the pull request after the review; push first, on its own`);
  if (action === "merge" && flags.has("--auto")) return stop("`--auto` merges commits pushed after the review");

  // The pull request, if named, is the first word after the command. Named
  // anywhere else, the gate can't be sure which word it is.
  if (positional.length > 1 || (positional.length === 1 && positional[0].at !== 0)) {
    return stop(`the pull request isn't the first word after \`gh pr ${action}\``);
  }
  read.selector = positional[0]?.word ?? null;
  // A pull request's address names its repository too.
  const named = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d+/i.exec(read.selector ?? "");
  if (named) {
    if (read.repo && normalRepo(read.repo) !== normalRepo(named[1])) return stop("its pull request's address and `--repo` name different repositories");
    read.repo = named[1];
  }
  return read;
}

/** owner/name as gh takes it (`owner/name`, `github.com/owner/name`, an address), lowercased. */
const normalRepo = (repo) => repo.toLowerCase().replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");

/**
 * The reviewer's last line says whether it found anything. Without that
 * line, only an answer that is nothing but `(none)` or an empty list of
 * findings is clean; anything else is read as findings.
 */
export function verdict(text) {
  const all = String(text ?? "").trim();
  const last = all.split("\n").pop() ?? "";
  const said = /^\W*REVIEW:\s*(clean|findings)\W*$/i.exec(last.trim());
  if (said) return said[1].toLowerCase() === "clean" ? "clean" : "findings";
  const bare = all.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  return bare === "[]" || bare === "(none)" ? "clean" : "findings";
}

/** The owner/name a GitHub remote address names, or null. */
export function repoOf(url) {
  // The last two parts of the path, whatever the host: an SSH alias
  // (`git@github-work:owner/name`) names the same repository. A local path
  // names none.
  const match = /^(?:[\w+.-]+:\/\/[^/]+\/|[^/\s@:]+@[^/\s:]+:|[^/\s:]+:(?!\/\/))(?:[^\s]*\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url ?? "");
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/** What the reviewer is told besides `/code-review`'s own recipe. */
export function instructions({ base, head, questions }) {
  return [
    `You are reviewing a change to this repository before it is proposed or merged, for an agent that will fix what you find. The change is the commits ${base}...${head}; review only what they change.`,
    "Besides your own review, check the change against the project's questions below, which come from mistakes earlier reviews caught. Where the change fails one, that is a finding.",
    "End your final message with one line on its own: `REVIEW: clean` if you report no findings, or `REVIEW: findings` if you report any.",
    questions ? `\n${questions}` : "",
  ].join("\n");
}

export function reviewerArgs({ level, base, head, questions }) {
  return [
    "-p", `/code-review ${level} ${base}...${head}`,
    "--output-format", "json",
    "--no-session-persistence",
    // The user's own settings only, and no MCP servers: a pull request's
    // .claude/ mustn't add hooks, permissions or servers to its own review.
    "--setting-sources", "user",
    "--strict-mcp-config",
    "--permission-mode", "dontAsk",
    "--allowedTools", ...REVIEWER_TOOLS,
    "--append-system-prompt", instructions({ base, head, questions }),
  ];
}

const short = (sha) => sha.slice(0, 10);

function git(cwd, args, options = {}) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

/** Git's output, or null when it fails. Output can be empty on success: ask `gitOk` whether it worked. */
function tryGit(cwd, args, options) {
  try { return git(cwd, args, options); } catch { return null; }
}

const gitOk = (cwd, args, options) => tryGit(cwd, args, options) !== null;

/** The folder a command runs in: the hook's, then each `cd` in turn, as the shell would. */
export function folderOf(cwd, dirs, home = process.env.HOME ?? "") {
  return dirs.reduce((dir, next) => {
    const expanded = next === "~" ? home : next.startsWith("~/") ? join(home, next.slice(2)) : next;
    return isAbsolute(expanded) ? expanded : resolve(dir, expanded);
  }, cwd);
}

/**
 * Each remote and the GitHub repository it names. The addresses as
 * configured: `remote get-url` hands back what an insteadOf rewrites one
 * to, which needn't name the repository.
 */
function remotesOf(top) {
  const lines = (tryGit(top, ["config", "--get-regexp", String.raw`^remote\..*\.url$`]) ?? "").split("\n").filter(Boolean);
  return lines.map((line) => {
    const [key, url] = line.split(/\s+/, 2);
    return { name: key.slice("remote.".length, -".url".length), repo: repoOf(url) };
  });
}

/**
 * The change to review: its folder's repository, the remote its pull
 * request goes to, the head commit, the base branch and the pull request's
 * number when there is one. Null when there's nothing for this gate here:
 * another repository, or a pull request already merged or closed.
 */
function target(read, cwd) {
  const dir = folderOf(cwd, read.dirs);
  if (!existsSync(dir)) throw new Error(`the folder it runs in, ${dir}, isn't there`);
  const top = tryGit(dir, ["rev-parse", "--show-toplevel"]);
  if (!top) return null;
  // The gate is this repository's rule: a repository that doesn't carry it isn't gated.
  if (!existsSync(join(top, "scripts", "review-gate.mjs"))) return null;
  // This project is any repository a remote names, or one of the same name
  // (a fork of it, or it from a fork). Another project isn't gated.
  const remotes = remotesOf(top);
  const ours = (repo) => remotes.some((each) => each.repo && (each.repo === repo || each.repo.split("/")[1] === repo.split("/")[1]));
  // Where the pull request's commits are fetched from: the remote that names
  // its repository, or else the repository's address.
  const sourceOf = (repo) => remotes.find((each) => each.repo === repo)?.name ?? `https://github.com/${repo}.git`;
  if (read.action === "create") {
    const head = git(top, ["rev-parse", "HEAD"]);
    let source;
    if (read.repo) {
      const repo = normalRepo(read.repo);
      if (!ours(repo)) return null;
      source = sourceOf(repo);
    } else {
      // With none named, upstream if there is one, as from a fork, else origin.
      source = remotes.some((each) => each.name === "upstream") ? "upstream" : "origin";
    }
    return { top, source, head, base: read.base ?? "main", number: null };
  }
  if (read.repo && !ours(normalRepo(read.repo))) return null;
  const pr = viewPr(read, top);
  if (!/^[0-9a-f]{40}$/.test(pr.headRefOid ?? "") || !Number.isInteger(pr.number)) throw new Error("gh's answer about the pull request can't be read");
  // The repository from gh's own answer, so it's the one gh will act on,
  // whatever its default or the remotes' names.
  const named = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d+/i.exec(pr.url ?? "");
  if (!named) throw new Error("gh's answer doesn't say which repository the pull request is in");
  const repo = normalRepo(named[1]);
  if (!ours(repo)) return null;
  if (pr.state && pr.state !== "OPEN") return null;
  const source = sourceOf(repo);
  if (!gitOk(top, ["cat-file", "-e", `${pr.headRefOid}^{commit}`])) {
    tryGit(top, ["fetch", "--quiet", source, `refs/pull/${pr.number}/head`], { timeout: NETWORK_MS });
    if (!gitOk(top, ["cat-file", "-e", `${pr.headRefOid}^{commit}`])) throw new Error(`couldn't fetch pull request ${pr.number}'s commit ${short(pr.headRefOid)} from ${source}`);
  }
  return { top, source, head: pr.headRefOid, base: pr.baseRefName || "main", number: pr.number };
}

/** What gh says of the pull request a ready or merge is about. */
function viewPr(read, top) {
  const gh = process.env.LINGER_REVIEW_GH || "gh";
  const args = ["pr", "view", ...(read.selector ? [read.selector] : []), ...(read.repo ? ["--repo", read.repo] : []), "--json", "number,headRefOid,baseRefName,state,url"];
  try {
    return JSON.parse(execFileSync(gh, args, { cwd: top, encoding: "utf8", timeout: NETWORK_MS, stdio: ["ignore", "pipe", "pipe"] }));
  } catch (error) {
    throw new Error(`gh couldn't say which pull request this is (${String(error.stderr || error.message).trim().split("\n")[0]})`);
  }
}

/**
 * A review's record: one per head commit and base branch, since another
 * base is another change. Each character a file name might not hold is
 * spelled out (`%2f;`), `%` too, so two names never share a record.
 */
export function recordName(head, base) {
  return `${head}-${base.replace(/[^\w.-]/g, (character) => `%${character.codePointAt(0).toString(16)};`)}.json`;
}

function markerPath(top, head, base) {
  const common = git(top, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return join(common, "linger-review", recordName(head, base));
}

function saveMarker(path, record) {
  mkdirSync(join(path, ".."), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(temp, path);
}

/** A path as git lists it: real (a Mac's /var is /private/var) and with / between its parts. */
const plain = (path) => {
  let real = path;
  try { real = realpathSync(path); } catch { /* gone */ }
  return real.replace(/\\/g, "/");
};

/** Copies a killed run left behind, which its own clean-up never reached, and records past keeping. */
function clearStale(top, records) {
  const temp = `${plain(tmpdir()).replace(/\/+$/, "")}/`;
  const list = tryGit(top, ["worktree", "list", "--porcelain"]) ?? "";
  for (const line of list.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const path = line.slice("worktree ".length);
    if (!basename(path).startsWith(WORKTREE_PREFIX) || !plain(path).startsWith(temp)) continue;
    let old = true;
    try { old = Date.now() - statSync(path).mtimeMs > STALE_MS; } catch { /* gone: prune takes it */ }
    if (old) tryGit(top, ["worktree", "remove", "--force", path]);
  }
  tryGit(top, ["worktree", "prune"]);
  let names = [];
  try { names = readdirSync(records); } catch { /* none yet */ }
  for (const name of names) {
    try {
      if (Date.now() - statSync(join(records, name)).mtimeMs > KEEP_MS) rmSync(join(records, name), { force: true });
    } catch { /* gone meanwhile */ }
  }
}

/**
 * The questions docs/pr-questions.md asks of this change. The script is the
 * gate's own, run on the copy: a pull request's own scripts are never run,
 * since merging somebody's pull request mustn't run their code first.
 */
function questionsFor(dir, base) {
  const script = join(HERE, "pr-questions.mjs");
  let out;
  try {
    out = execFileSync(process.execPath, [script, base], { cwd: dir, encoding: "utf8", timeout: NETWORK_MS, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    // A review without them would look like one with them: stop instead.
    throw new Error(`the project's questions couldn't be read (${String(error.stderr || error.message).trim().split("\n").pop()})`);
  }
  return out.length > MOST_QUESTIONS ? `${out.slice(0, MOST_QUESTIONS)}\n…` : out;
}

/**
 * The program that reviews: the Claude that's running, when it's Claude's
 * own program (installed through npm, CLAUDE_CODE_EXECPATH can be node), or
 * `claude`. Tests stand in for it with LINGER_REVIEWER.
 */
export function reviewerCommand(env = process.env) {
  const running = env.CLAUDE_CODE_EXECPATH;
  const name = running?.split(/[\\/]/).pop() ?? "";
  return env.LINGER_REVIEWER || (/^claude(?:\.exe)?$/i.test(name) ? running : "claude");
}

/** Runs the reviewer in `dir` and hands back its words, or throws why it couldn't. */
function runReviewer(dir, { level, base, head, questions }) {
  const command = reviewerCommand();
  const result = spawnSync(command, reviewerArgs({ level, base, head, questions }), {
    cwd: dir,
    encoding: "utf8",
    timeout: REVIEW_MS,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, LINGER_COLD_REVIEW: "1" },
  });
  if (result.error) throw new Error(result.error.code === "ETIMEDOUT" ? `it didn't finish in ${REVIEW_MS / 60000} minutes` : `\`${command}\` couldn't start (${result.error.message})`);
  if (result.status !== 0) throw new Error(`it stopped with status ${result.status}${result.stderr ? `: ${result.stderr.trim().split("\n").pop()}` : ""}`);
  let answer;
  try { answer = JSON.parse(result.stdout); } catch { throw new Error("its answer wasn't the JSON it was asked for"); }
  if (answer.is_error || typeof answer.result !== "string") throw new Error(`it reported an error (${answer.subtype ?? "no result"})`);
  return answer.result;
}

/**
 * Reviews `found` once per head commit. Answers `{ ran: false, why }` when
 * there was nothing to review or it was reviewed before, and
 * `{ ran: true, verdict, text, head, base }` after a review.
 */
export function review(found, { level = DEFAULT_LEVEL } = {}) {
  const marker = markerPath(found.top, found.head, found.base);
  if (existsSync(marker)) return { ran: false, why: "reviewed before", marker };
  // The base branch as it is where the pull request goes, fetched if it's
  // newer than what's here; offline, the last fetched copy of it.
  const listed = (tryGit(found.top, ["ls-remote", found.source, `refs/heads/${found.base}`], { timeout: NETWORK_MS }) ?? "").split(/\s/)[0];
  let baseRef = null;
  if (/^[0-9a-f]{40}$/.test(listed)) {
    if (!gitOk(found.top, ["cat-file", "-e", `${listed}^{commit}`])) tryGit(found.top, ["fetch", "--quiet", found.source, `refs/heads/${found.base}`], { timeout: NETWORK_MS });
    if (gitOk(found.top, ["cat-file", "-e", `${listed}^{commit}`])) baseRef = listed;
  }
  baseRef ??= [`${found.source}/${found.base}`, found.base].find((ref) => gitOk(found.top, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]));
  if (!baseRef) throw new Error(`couldn't find ${found.base} on ${found.source}`);
  const base = tryGit(found.top, ["merge-base", baseRef, found.head]);
  if (!base) throw new Error(`couldn't find where ${short(found.head)} left ${found.base}`);
  if (base === found.head) return { ran: false, why: "nothing to review" };
  // Each side of a rename, as ci-scope reads them: code moved into docs/
  // is still a code change.
  const paths = git(found.top, ["diff", "--name-only", "--no-renames", base, found.head]).split("\n").filter(Boolean);
  if (paths.every((path) => partsOf(path).length === 0)) return { ran: false, why: "docs only" };

  // Always a clean copy of the commit, never the folder: what's uncommitted
  // there isn't in the pull request, and mustn't be reviewed as if it were.
  let copy = null;
  try {
    clearStale(found.top, dirname(marker));
    copy = mkdtempSync(join(tmpdir(), WORKTREE_PREFIX));
    git(found.top, ["worktree", "add", "--quiet", "--detach", copy, found.head]);
    const text = runReviewer(copy, { level, base, head: found.head, questions: questionsFor(copy, base) });
    const said = verdict(text);
    saveMarker(marker, { head: found.head, base, level, verdict: said, at: new Date().toISOString(), text });
    return { ran: true, verdict: said, text, head: found.head, base };
  } finally {
    if (copy) {
      tryGit(found.top, ["worktree", "remove", "--force", copy]);
      rmSync(copy, { recursive: true, force: true });
      tryGit(found.top, ["worktree", "prune"]);
    }
  }
}

function levelFromEnv() {
  const level = process.env.LINGER_REVIEW_LEVEL || DEFAULT_LEVEL;
  if (!LEVELS.includes(level)) throw new Error(`LINGER_REVIEW_LEVEL is ${level}; it can be ${LEVELS.join(", ")}`);
  return level;
}

const VERB = { create: "opens", ready: "is marked ready", merge: "merges" };

/** The hook: reads Claude Code's JSON, and answers 0 to let the command run or 2 with why to stop it. */
export function hook(action, input) {
  if (process.env.LINGER_COLD_REVIEW) return { code: 0 };
  const command = input?.tool_input?.command;
  if (typeof command !== "string") return { code: 0 };
  const read = readCommand(command, action);
  if (read === null) return { code: 0 };
  if (read.fail) {
    return {
      code: 2,
      message: `Stopped before review: ${read.fail}. A fresh review runs before a pull request ${VERB[action]} (#917, AGENTS.md), and the gate stops a command it can't read rather than guess. Run it as a command of its own: \`gh pr ${action}${action === "create" ? "" : " <number>"} …\`, with only \`cd <folder> &&\` or \`git push … &&\` in front.`,
    };
  }
  let found;
  let done;
  try {
    found = target(read, input.cwd ?? process.cwd());
    if (!found) return { code: 0 };
    done = review(found, { level: levelFromEnv() });
  } catch (error) {
    return {
      code: 2,
      message: `Stopped: the fresh review that runs before a pull request ${VERB[action]} couldn't run: ${error.message}. Nothing was reviewed. Try again; if it keeps failing, tell the person you're working for. \`node scripts/review-gate.mjs\` runs it by hand.`,
    };
  }
  if (!done.ran || done.verdict === "clean") {
    // A review takes minutes, and a push meanwhile would merge a commit it
    // never saw. Asked again now, the gap is the moment before gh runs.
    if (done.ran && found.number !== null) {
      let now;
      try { now = viewPr(read, found.top).headRefOid; } catch (error) {
        return { code: 2, message: `Stopped: after the review, ${error.message}. Run the command again.` };
      }
      if (now !== found.head) {
        return { code: 2, message: `Stopped: pull request ${found.number} changed during the review (${short(found.head)} was reviewed; it's at ${short(String(now))} now). Run the command again to review what's there.` };
      }
    }
    return done.ran ? { code: 0, note: `A fresh review of ${short(done.head)} found nothing.` } : { code: 0 };
  }
  return {
    code: 2,
    message: [
      `Stopped: a fresh review of ${short(done.head)} (the changes since ${short(done.base)}) found something before this pull request ${VERB[action]}.`,
      "Fix what's real and run the command again: a new commit gets a new review. This commit passes as it is, so a finding you judge wrong doesn't hold you up; say why in the pull request. Its Tests section says what the review found and what you did.",
      "",
      done.text.trim(),
    ].join("\n"),
  };
}

function main(argv) {
  if (argv[0] === "--hook") {
    const action = argv[1];
    if (!ACTIONS.includes(action)) {
      process.stderr.write(`review-gate: --hook takes ${ACTIONS.join(", ")}\n`);
      process.exitCode = 2;
      return;
    }
    let input;
    try { input = JSON.parse(readFileSync(0, "utf8")); } catch {
      process.stderr.write("review-gate: the hook's input wasn't JSON, so the command was stopped.\n");
      process.exitCode = 2;
      return;
    }
    const answer = hook(action, input);
    if (answer.message) process.stderr.write(`${answer.message}\n`);
    if (answer.note) process.stdout.write(`${JSON.stringify({ systemMessage: answer.note })}\n`);
    process.exitCode = answer.code;
    return;
  }

  // By hand: this branch, or a pull request by number.
  const selector = argv[0];
  if (selector !== undefined && !/^\d+$/.test(selector)) {
    process.stderr.write("usage: node scripts/review-gate.mjs [<pull request number>]\n");
    process.exitCode = 2;
    return;
  }
  const read = selector ? { action: "merge", dirs: [], selector, base: null, repo: null } : { action: "create", dirs: [], selector: null, base: null, repo: null };
  const found = target(read, process.cwd());
  if (!found) {
    console.log("Nothing to review here: not this repository, or the pull request isn't open.");
    return;
  }
  const done = review(found, { level: levelFromEnv() });
  if (!done.ran) {
    console.log(done.why === "reviewed before" ? `${short(found.head)} was reviewed before:\n\n${JSON.parse(readFileSync(done.marker, "utf8")).text}` : `Nothing to review: ${done.why}.`);
    return;
  }
  console.log(done.text.trim());
  process.exitCode = done.verdict === "clean" ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`review-gate: ${error.message}\n`);
    process.exitCode = 2;
  }
}
