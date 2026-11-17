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

// What this guards, and what it doesn't. The gate catches an agent's
// accidental unreviewed change: a `gh pr create`, `ready` or `merge` in any
// form an agent writes is read exactly or stopped, and text that might be
// one is stopped rather than guessed. It is not a sandbox against a command
// built to get past it from the same shell (a name redefined as a function,
// text stored and run later, quoting games inside arithmetic): whoever can
// write those can as easily edit .claude/settings.json. That the commit
// merged is the commit reviewed is #932's to bind, not this reader's.
//
// The command is read as bash reads it (#925): one pass over its text, left
// to right, that knows quotes, escapes, line continuations, comments,
// operators, redirections and here-documents, and opens each substitution
// (`$(…)`, backticks, `<(…)`) to read the commands inside it. Each word comes
// out as the program it's handed to sees it, with whether the gate can know
// it: a variable, a substitution or a glob it can't follow is marked, never
// guessed. Regular expressions modelling the shell missed a new spelling in
// every review of #924; a reader that tracks quotes can't.

/** Stands where a word has something the gate can't follow; no argument can hold it. */
const UNKNOWN = "\u0000";
/** What ends an unquoted word. */
const METACHARS = new Set([" ", "\t", "\n", ";", "&", "|", "(", ")", "<", ">"]);
/** Redirection operators, longest first, so `>>` is never read as `>` twice. */
const REDIRECTIONS = ["<<<", "<<-", "&>>", "<<", "<>", "<&", ">>", ">&", ">|", "&>", "<", ">"];
/** Control operators, longest first. `&&` is checked before `&>`. */
const OPERATORS = ["&&", "||", ";;", "|&", ";", "|", "&", "(", ")", "\n"];
/** Words that open or continue a compound command, before the command they lead to. */
const LEADING = new Set(["!", "{", "do", "then", "else", "elif", "if", "while", "until", "time", "coproc"]);
/** ANSI-C escapes in `$'…'`. */
const C_ESCAPES = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };

class Unreadable extends Error {}

/**
 * A command's tokens: words (`{ word }`), operators (`{ op }`) and
 * redirections (`{ redirect, target, fd, body }`: `fd` the stream's number
 * if one is given, `body` a here-document's text). A word is `{ text, known,
 * single, quoted, raw, inner }`: `text` as the program sees it, with UNKNOWN
 * where the gate can't follow it; `known` when it has nothing it can't
 * follow; `single` when it is one argument whatever it holds (an expansion
 * only inside double quotes, and no glob or brace); `quoted` when any of it
 * was quoted or escaped; `raw` as it was written; `inner` the commands of
 * the substitutions in it, each a token list of its own. Throws Unreadable on text bash would refuse
 * (an unclosed quote or substitution, a redirection with no target).
 */
export function tokenize(source) {
  budget.left = PAIRING;
  budget.exotic = false;
  return readTokens({ source, at: 0 }, null);
}

function readTokens(reader, closer) {
  const { source } = reader;
  const tokens = [];
  const heredocs = [];
  let depth = 0;
  for (;;) {
    while (source[reader.at] === " " || source[reader.at] === "\t" || (source[reader.at] === "\\" && source[reader.at + 1] === "\n")) {
      reader.at += source[reader.at] === "\\" ? 2 : 1;
    }
    if (reader.at >= source.length) {
      if (closer) throw new Unreadable("a substitution isn't closed");
      readHeredocs(reader, heredocs);
      return tokens;
    }
    if (source[reader.at] === "#") {
      while (reader.at < source.length && source[reader.at] !== "\n") reader.at += 1;
      continue;
    }
    // `((…))` where a command starts: arithmetic, read as one word, its own
    // `<<` a shift, not a here-document.
    const before = tokens[tokens.length - 1];
    const startsCommand = !before || "op" in before || ("word" in before && before.word.known && !before.word.quoted && (LEADING.has(before.word.text) || before.word.text === "for"));
    const shape = startsCommand && source.startsWith("((", reader.at) ? closing(source, reader.at) : null;
    if (startsCommand && source.startsWith("((", reader.at) && !shape) throw new Unreadable("a `((` isn't closed");
    if (shape?.together) {
      budget.exotic = true;
      const body = source.slice(reader.at + 2, shape.end - 1);
      reader.at = shape.end + 1;
      tokens.push({ word: { text: UNKNOWN, known: false, single: true, quoted: false, inner: /\$\(|`/.test(body) ? substitutionsIn(body) : [], raw: "((" + body + "))" } });
      continue;
    }
    // `<(…)` and `>(…)`: a process substitution, a word of its own.
    if (source.startsWith("<(", reader.at) || source.startsWith(">(", reader.at)) {
      tokens.push({ word: readWord(reader) });
      continue;
    }
    // A redirection: an all-digit word glued to < or > names the stream.
    const stream = /^\d+(?=[<>])/.exec(source.slice(reader.at, reader.at + 12));
    const opAt = reader.at + (stream ? stream[0].length : 0);
    const redirect = source.startsWith("&&", reader.at) ? undefined : REDIRECTIONS.find((op) => source.startsWith(op, opAt));
    if (redirect) {
      reader.at = opAt + redirect.length;
      while (source[reader.at] === " " || source[reader.at] === "\t") reader.at += 1;
      const substitution = source.startsWith("<(", reader.at) || source.startsWith(">(", reader.at);
      if (reader.at >= source.length || (METACHARS.has(source[reader.at]) && !substitution)) throw new Unreadable(`\`${redirect}\` has nothing to read or write`);
      const target = readWord(reader);
      const token = { redirect, target, fd: stream ? stream[0] : null };
      tokens.push(token);
      // A here-document's end is its word with quotes taken off, never expanded.
      if (redirect === "<<" || redirect === "<<-") heredocs.push({ end: target.known ? target.text : target.raw.replace(/["'\\]/g, ""), quoted: /["'\\]/.test(target.raw), tabs: redirect === "<<-", token });
      continue;
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, reader.at));
    if (op) {
      reader.at += op.length;
      if (op === ")" && closer === ")" && depth === 0) {
        // Its here-documents not ended inside it are empty, as bash leaves
        // them: the lines after the substitution are commands, not their text.
        for (const heredoc of heredocs.splice(0)) heredoc.token.body = "";
        return tokens;
      }
      if (op === "(") depth += 1;
      if (op === ")") depth = Math.max(0, depth - 1);
      tokens.push({ op });
      if (op === "\n") readHeredocs(reader, heredocs);
      continue;
    }
    const word = readWord(reader);
    // A case's patterns end in `)`, which bash tells from the substitution's
    // own end by its grammar; inside one, the gate doesn't try, and stops.
    // Only a case where a command starts: `case` as an argument is a word.
    if (closer && startsCommand && word.known && !word.quoted && word.text === "case") throw new Unreadable("a `case` inside a substitution");
    tokens.push({ word });
  }
}

/** Whether a line ends in a backslash that isn't itself escaped: an odd number of them. */
function continues(line) {
  let count = 0;
  while (count < line.length && line[line.length - 1 - count] === "\\") count += 1;
  return count % 2 === 1;
}

/** The bodies of the here-documents opened on the line just ended: data, not commands. */
function readHeredocs(reader, heredocs) {
  const { source } = reader;
  for (const heredoc of heredocs.splice(0)) {
    const body = [];
    heredoc.token.bodyFrom = reader.at;
    for (;;) {
      if (reader.at >= source.length) break;
      const newline = source.indexOf("\n", reader.at);
      let line = source.slice(reader.at, newline < 0 ? source.length : newline);
      reader.at = newline < 0 ? source.length : newline + 1;
      // Unquoted, a line ending in a backslash goes on into the next, and
      // bash compares the joined line with the end word: `EO\` then `F` ends it.
      // Each piece is looked at once, and joined at the end, so a body of
      // many continued lines costs its length, not its length squared.
      // Only a backslash a line break follows goes on.
      if (!heredoc.quoted && newline >= 0 && continues(line)) {
        const pieces = [line.slice(0, -1)];
        while (reader.at < source.length) {
          const next = source.indexOf("\n", reader.at);
          const piece = source.slice(reader.at, next < 0 ? source.length : next);
          reader.at = next < 0 ? source.length : next + 1;
          if (next < 0 || !continues(piece)) {
            pieces.push(piece);
            break;
          }
          pieces.push(piece.slice(0, -1));
        }
        line = pieces.join("");
      }
      if ((heredoc.tabs ? line.replace(/^\t+/, "") : line) === heredoc.end) break;
      body.push(line);
    }
    heredoc.token.body = body.join("\n");
    heredoc.token.bodyTo = reader.at;
    // Unquoted, its body is expanded: a substitution in it runs.
    if (!heredoc.quoted) heredoc.token.target.inner.push(...substitutionsIn(heredoc.token.body));
  }
}

/**
 * The commands of the substitutions in text read as the inside of a
 * double-quoted string (a here-document's body, a `${…}`'s). Text it
 * can't read throws, so the command is stopped rather than passed.
 */
function substitutionsIn(text) {
  const reader = { source: text, at: 0 };
  const word = { text: "", known: true, single: true, quoted: true, inner: [] };
  while (reader.at < text.length) {
    const char = text[reader.at];
    if (char === "\\") reader.at += 2;
    else if ((char === "$" || char === "`") && readExpansion(reader, word, true)) continue;
    else reader.at += 1;
  }
  return word.inner;
}

/** A double-quoted string at the reader, into `word`: its text, and the substitutions in it. */
function readDoubleQuoted(reader, word) {
  const { source } = reader;
  reader.at += 1;
  word.quoted = true;
  for (;;) {
    if (reader.at >= source.length) throw new Unreadable('a `"` isn\'t closed');
    const inside = source[reader.at];
    if (inside === '"') {
      reader.at += 1;
      return;
    }
    if (inside === "\\") {
      const next = source[reader.at + 1];
      if (next === "\n") reader.at += 2;
      else if (next === "$" || next === "`" || next === '"' || next === "\\") {
        word.text += next;
        reader.at += 2;
      } else {
        word.text += "\\";
        reader.at += 1;
      }
      continue;
    }
    if ((inside === "$" || inside === "`") && readExpansion(reader, word, true)) continue;
    word.text += inside;
    reader.at += 1;
  }
}

/** Marks where a word holds something the gate can't follow, and whether it stays one argument. */
function markUnknown(word, single) {
  word.text += UNKNOWN;
  word.known = false;
  if (!single) word.single = false;
}

/** One word, from where it starts to the first unquoted metacharacter. */
function readWord(reader) {
  const { source } = reader;
  const word = { text: "", known: true, single: true, quoted: false, inner: [] };
  const unknown = (single) => markUnknown(word, single);
  const start = reader.at;
  while (reader.at < source.length) {
    const char = source[reader.at];
    if (METACHARS.has(char)) {
      // `<(…)` and `>(…)` at the start of a word: a process substitution.
      if ((char === "<" || char === ">") && reader.at === start && source[reader.at + 1] === "(") {
        budget.exotic = true;
        reader.at += 2;
        word.inner.push(readTokens(reader, ")"));
        unknown(true);
        continue;
      }
      break;
    }
    if (char === "\\") {
      if (source[reader.at + 1] === "\n") reader.at += 2;
      else {
        if (reader.at + 1 >= source.length) throw new Unreadable("a `\\` escapes nothing");
        word.text += source[reader.at + 1];
        word.quoted = true;
        reader.at += 2;
      }
      continue;
    }
    if (char === "'") {
      const end = source.indexOf("'", reader.at + 1);
      if (end < 0) throw new Unreadable("a `'` isn't closed");
      word.text += source.slice(reader.at + 1, end);
      word.quoted = true;
      reader.at = end + 1;
      continue;
    }
    if (char === '"') {
      readDoubleQuoted(reader, word);
      continue;
    }
    if (char === "$" && source[reader.at + 1] === "'") {
      budget.exotic = true;
      reader.at += 2;
      word.quoted = true;
      word.text += readAnsiC(reader);
      continue;
    }
    if (char === "$" && source[reader.at + 1] === '"') {
      // A string for translation: read as a double-quoted one.
      budget.exotic = true;
      reader.at += 1;
      continue;
    }
    if (char === "$" || char === "`") {
      if (readExpansion(reader, word, false)) continue;
    }
    // Globs and braces expand to file names or several words.
    if (char === "*" || char === "?" || char === "[" || ((char === "{" || char === "}") && !(reader.at === start && METACHARS_OR_END(source, reader.at + 1)))) {
      word.text += char;
      word.known = false;
      word.single = false;
      reader.at += 1;
      continue;
    }
    word.text += char;
    reader.at += 1;
  }
  word.raw = source.slice(start, reader.at);
  word.from = start;
  word.to = reader.at;
  return word;
}

const METACHARS_OR_END = (source, at) => at >= source.length || METACHARS.has(source[at]);

/**
 * A `$` or backtick expansion at the reader: substitutions are read for
 * the commands in them. False when the `$` is only a `$`.
 */
function readExpansion(reader, word, quoted) {
  const { source } = reader;
  const char = source[reader.at];
  // Inside double quotes an expansion stays one argument, but for `$@` and `${a[@]}`.
  const unknown = (several = false) => markUnknown(word, quoted && !several);
  if (char === "`") {
    budget.exotic = true;
    let end = reader.at + 1;
    let inner = "";
    for (; end < source.length && source[end] !== "`"; end += 1) {
      if (source[end] === "\\" && (source[end + 1] === "`" || source[end + 1] === "\\" || source[end + 1] === "$")) end += 1;
      inner += source[end];
    }
    if (end >= source.length) throw new Unreadable("a backtick isn't closed");
    reader.at = end + 1;
    word.inner.push(readTokens({ source: inner, at: 0 }, null));
    unknown();
    return true;
  }
  const next = source[reader.at + 1];
  if (next === "[") {
    budget.exotic = true;
    const end = source.indexOf("]", reader.at + 2);
    if (end < 0) throw new Unreadable("a `$[` isn't closed");
    const body = source.slice(reader.at + 2, end);
    if (/\$\(|`/.test(body)) word.inner.push(...substitutionsIn(body));
    reader.at = end + 1;
    unknown();
    return true;
  }
  const shape = next === "(" && source[reader.at + 2] === "(" ? closing(source, reader.at + 1) : null;
  if (next === "(" && source[reader.at + 2] === "(" && !shape) throw new Unreadable("a `$((` isn't closed");
  if (shape?.together) {
    // Arithmetic: a number, read for the commands it could hold all the same.
    budget.exotic = true;
    const { end } = shape;
    const body = source.slice(reader.at + 3, end - 1);
    if (/\$\(|`/.test(body)) word.inner.push(...substitutionsIn(body));
    reader.at = end + 1;
    unknown();
    return true;
  }
  if (next === "(") {
    reader.at += 2;
    word.inner.push(readTokens(reader, ")"));
    unknown();
    return true;
  }
  if (next === "{") {
    // Its own substitutions, quotes and braces, read in place: a `}` inside
    // a `$(…)` or a quote doesn't close it.
    budget.exotic = true;
    reader.at += 2;
    const bodyStart = reader.at;
    let depth = 1;
    const scratch = { text: "", known: true, single: true, quoted: true, inner: word.inner };
    while (depth > 0) {
      if (reader.at >= source.length) throw new Unreadable("a `${` isn't closed");
      const at = source[reader.at];
      if (at === "\\") reader.at += 2;
      else if ((at === "$" || at === "`") && readExpansion(reader, scratch, true)) continue;
      else if (at === "'" && !quoted) {
        const end = source.indexOf("'", reader.at + 1);
        if (end < 0) throw new Unreadable("a `'` isn't closed");
        reader.at = end + 1;
      } else if (at === '"') readDoubleQuoted(reader, scratch);
      else {
        // Bash closes `${` at the first `}`: only a nested `${` opens another.
        if (at === "{" && source[reader.at - 1] === "$") depth += 1;
        if (at === "}") depth -= 1;
        reader.at += 1;
      }
    }
    // Several words only for `[@]`, `$@` and `!prefix@`: `${x:-me@example.com}` is one.
    unknown(/^@|\[@\]|^![A-Za-z_]\w*@$/.test(source.slice(bodyStart, reader.at - 1)));
    return true;
  }
  if (next !== undefined && /[A-Za-z0-9_@*#?$!-]/.test(next)) {
    if (next === "@") {
      reader.at += 2;
      unknown(true);
      return true;
    }
    reader.at += 2;
    if (/[A-Za-z_]/.test(next)) while (reader.at < source.length && /\w/.test(source[reader.at])) reader.at += 1;
    unknown();
    return true;
  }
  return false;
}

/**
 * Where the parentheses opened at `open` close, and whether the pair inside
 * closes right beside them (`))`): arithmetic when it does, and otherwise
 * a subshell inside one, `( (…) )`.
 */
function closing(source, open) {
  const end = closeOf(source, open);
  if (end < 0) return null;
  return { end, together: source[open + 1] === "(" && closeOf(source, open + 1) === end - 1 };
}

/**
 * Where the `(` at `open` closes, as bash pairs them: a `)` inside quotes,
 * after a backslash or in a comment doesn't count. Read forward from the
 * `(`, which sits where the reader is, outside any quote. A text whose
 * pairing would take too long (thousands of nested parentheses) is one the
 * gate can't read, so the fallback answers for it.
 */
function closeOf(source, open) {
  let depth = 0;
  for (let at = open; at < source.length; at += 1) {
    budget.left -= 1;
    if (budget.left < 0) throw new Unreadable("its parentheses are too many to pair");
    const past = at === open ? at : pastQuoted(source, at);
    if (past !== at) {
      budget.left -= past - at;
      at = past;
    } else if (source[at] === "(") depth += 1;
    else if (source[at] === ")" && (depth -= 1) === 0) return at;
  }
  return -1;
}

/** How much pairing one reading of a command may do. */
const budget = { left: 0, exotic: false };
const PAIRING = 4_000_000;

/** If a quote, an escape or a comment starts at `at`, where it ends; otherwise `at`. */
function pastQuoted(source, at) {
  const char = source[at];
  if (char === "\\") return Math.min(at + 1, source.length - 1);
  if (char === "'" && source[at - 1] === "$") {
    // `$'…'`: a backslash escapes the next character, `\'` included.
    let end = at + 1;
    while (end < source.length && source[end] !== "'") end += source[end] === "\\" ? 2 : 1;
    return Math.min(end, source.length - 1);
  }
  if (char === "'") {
    const end = source.indexOf("'", at + 1);
    return end < 0 ? source.length - 1 : end;
  }
  if (char === '"') {
    let end = at + 1;
    while (end < source.length && source[end] !== '"') end += source[end] === "\\" ? 2 : 1;
    return Math.min(end, source.length - 1);
  }
  if (char === "#" && (at === 0 || /[\s;&|()<>]/.test(source[at - 1]))) {
    const end = source.indexOf("\n", at);
    return end < 0 ? source.length - 1 : end - 1;
  }
  return at;
}


/** The text of `$'…'`, its escapes undone, the reader past its closing quote. */
function readAnsiC(reader) {
  const { source } = reader;
  let text = "";
  for (;;) {
    if (reader.at >= source.length) throw new Unreadable("a `$'` isn't closed");
    const char = source[reader.at];
    if (char === "'") {
      reader.at += 1;
      return text;
    }
    if (char !== "\\") {
      text += char;
      reader.at += 1;
      continue;
    }
    const next = source[reader.at + 1];
    if (next in C_ESCAPES) {
      text += C_ESCAPES[next];
      reader.at += 2;
    } else if (next === "u" || next === "U") {
      const hex = new RegExp(`^[0-9a-fA-F]{1,${next === "u" ? 4 : 8}}`).exec(source.slice(reader.at + 2));
      text += hex ? String.fromCodePoint(Math.min(parseInt(hex[0], 16), 0x10ffff)) : "\\" + next;
      reader.at += 2 + (hex ? hex[0].length : 0);
    } else if (next === "c" && reader.at + 2 < source.length && source[reader.at + 2] !== "'") {
      text += String.fromCharCode(source.charCodeAt(reader.at + 2) & 0x1f);
      reader.at += 3;
    } else if (next === "x") {
      const hex = /^[0-9a-fA-F]{1,2}/.exec(source.slice(reader.at + 2));
      text += hex ? String.fromCharCode(parseInt(hex[0], 16)) : "\\x";
      reader.at += 2 + (hex ? hex[0].length : 0);
    } else if (/[0-7]/.test(next ?? "")) {
      const octal = /^[0-7]{1,3}/.exec(source.slice(reader.at + 1))[0];
      text += String.fromCharCode(parseInt(octal, 8));
      reader.at += 1 + octal.length;
    } else {
      text += "\\" + (next ?? "");
      reader.at += 2;
    }
  }
}

/** A command's words, settings and redirection targets: everywhere a substitution can sit. */
const wordsOf = (command) => [...command.words, ...command.settings, ...command.redirects.map((token) => token.target)];

/** Each token list's commands, worked out once. */
const listed = new WeakMap();

/**
 * The simple commands in a token list, each with its words, its settings
 * (`NAME=value` in front), its redirections, the compound-command words led
 * in with (`do`, `if`, `!`), and the operator after it.
 */
function commandsOf(tokens) {
  if (listed.has(tokens)) return listed.get(tokens);
  const commands = [];
  listed.set(tokens, commands);
  let current = { words: [], settings: [], redirects: [], leading: [], after: null };
  const close = (op) => {
    current.after = op;
    commands.push(current);
    current = { words: [], settings: [], redirects: [], leading: [], after: null };
  };
  const empty = () => !current.words.length && !current.settings.length && !current.redirects.length && !current.leading.length;
  for (const token of tokens) {
    // A new line after `&&`, `||` or `|` carries the command on.
    if ("op" in token && token.op === "\n" && empty() && ["&&", "||", "|", "|&"].includes(commands[commands.length - 1]?.after)) continue;
    if ("op" in token) close(token.op);
    else if ("redirect" in token) current.redirects.push(token);
    else {
      const { word } = token;
      if (!current.words.length && word.known && LEADING.has(word.text) && !word.quoted) current.leading.push(word.text);
      else if (!current.words.length && /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/.test(word.raw)) current.settings.push(word);
      else current.words.push(word);
    }
  }
  close(null);
  return commands;
}

/** Whether a word is gh itself: its plain name, found on the PATH. A path (`./gh`, `/usr/bin/gh`) may be any program, so it's a maybe. */
const isGh = (word) => word.known && /^gh(?:\.exe)?$/.test(word.text);
/** Whether a word could be gh: gh however it's spelled, or one the gate can't read. */
const mayBeGh = (word) => !word.known || /(?:^|[/\\])gh(?:\.exe)?$/i.test(word.text);
/** The words that close a compound command. */
const CLOSERS = ["done", "fi", "esac", "}"];
/** Words of a compound command's own, which run no program. */
const LOOP = new Set([...LEADING, ...CLOSERS, "for", "select", "case", "in"]);

/** Programs that run nothing they're given, and change nothing but the screen. */
const INERT = new Set(["echo", "printf", "true", "false", ":", "jq", "grep", "egrep", "fgrep", "wc", "head", "tail", "cut", "tr", "ls", "cat", "test", "sleep", "date", "pwd", "basename", "dirname", "realpath", "stat", "diff", "cmp", "comm", "column", "nl", "fold", "file", "which", "type", "id", "whoami", "hostname", "uname", "mktemp"]);
/**
 * git's subcommands whose words are data, never run: not `config` (its
 * aliases run), nor those that take a program to run or a file to write
 * (`fetch`/`pull`/`push`/`ls-remote` `--upload-pack`, `grep -O`, `log`/
 * `show`/`diff` `--output`).
 */
const GIT_DATA = new Set(["commit", "status", "tag", "branch", "add", "rm", "mv", "restore", "switch", "checkout", "merge-base", "rev-parse", "rev-list", "describe", "ls-files", "remote", "blame", "stash", "worktree"]);
/** git's subcommands that change nothing a pull request depends on: no branch, remote or push. */
const GIT_READS = new Set(["status", "merge-base", "rev-parse", "rev-list", "describe", "ls-files", "blame"]);
/** gh's commands whose words are data: a list of those known, as an alias or extension can be anything. */
const GH_DATA = new Set(["pr", "issue", "label", "search", "status", "browse"]);
/** gh's commands that only read, by command and subcommand (`*` for all of them). */
const GH_READS = { pr: ["view", "list", "checks", "diff", "status"], issue: ["view", "list", "status"], run: ["view", "list", "watch"], workflow: ["view", "list"], release: ["view", "list"], label: ["list"], search: ["*"], status: ["*"], browse: ["*"] };

/**
 * Whether a redirection writes a file: `>`, `>>`, `&>` and the like to
 * anything but /dev/null, whatever the stream, and `>&` to a file or to a
 * stream past stdout and stderr (one `exec` may have opened on a file).
 */
const writesFile = (token) => {
  if ([">", ">>", ">|", "&>", "&>>", "<>"].includes(token.redirect)) return !(token.target.known && token.target.text === "/dev/null");
  return token.redirect === ">&" && !/^(?:[12]|-)$/.test(token.target.text);
};

/** A command's program by its plain name, and its first two words after it. */
function programOf(command) {
  const [name, first, second] = command.words;
  if (!name?.known) return null;
  // By its plain name, found on the PATH: `./tools/git` may be anything.
  if (/[/\\]/.test(name.text)) return null;
  return { name, program: name.text, first: first?.known ? first.text : null, second: second?.known ? second.text : null };
}

/**
 * Whether a command's words are data: a program that runs nothing it's
 * given and writes no file (a file it writes could be run next). Its text
 * then never counts as a command (`pipelineText`).
 */
function inert(command) {
  const known = programOf(command);
  if (!known || command.redirects.some(writesFile)) return false;
  const { name, program, first } = known;
  if (program === "printf" && command.words.some((word) => !word.known || word.text.startsWith("-v"))) return false;
  // Escapes (`\x67h`, echo -e) may spell the command where the words don't.
  if ((program === "printf" || program === "echo") && command.words.some((word) => word.text.includes("\\"))) return false;
  return INERT.has(program) || (program === "git" && GIT_DATA.has(first)) || (isGh(name) && GH_DATA.has(first));
}

/**
 * Whether a command only reads: nothing it does can change a pull request,
 * a branch, a remote or a file. What runs inside a merge's substitutions or
 * beside it must be (#932 will bind the merge to the reviewed commit too).
 */
function readsOnly(command) {
  // Writing a file through a redirection is a change, whatever the command.
  if (command.redirects.some(writesFile)) return false;
  // A setting in front can make it run something (GIT_EXTERNAL_DIFF, GIT_PAGER).
  if (command.settings.length) return false;
  if (!command.words.length) return true;
  const [word] = command.words;
  if (command.words.length === 1 && word.known && !word.quoted && CLOSERS.includes(word.text)) return true;
  if (word.known && ["read", "wait"].includes(word.text) && command.words.every((each) => each.known)) return true;
  // Loop syntax runs no program: its words are a list (`for f in a b`).
  if (word.known && !word.quoted && ["for", "select", "case"].includes(word.text)) return true;
  // Into .git, a file is a branch, a ref or a hook.
  if (command.words.some((each) => /(?:^|\/)\.git(?:\/|$)/.test(each.text))) return false;
  const known = programOf(command);
  if (!known) return false;
  const { name, program, first, second } = known;
  // Writing no file, these change nothing (printf -v sets only a shell variable).
  if (INERT.has(program)) return true;
  // tee writes the files it's named, a log, not a pull request or a branch.
  if (program === "tee") return command.words.every((word) => word.known);
  if (program === "git") return GIT_READS.has(first) || (["log", "show", "diff"].includes(first) && command.words.every((word) => word.known && !/^--(?:output|ext-diff|textconv)/.test(word.text)));
  const reads = Object.hasOwn(GH_READS, first) ? GH_READS[first] : [];
  return isGh(name) && (reads.includes("*") || reads.includes(second));
}

/**
 * Whether a simple command runs `gh pr <action>`: "exact" when its own
 * first words are those and the gate can read them; "maybe" when gh (or a
 * word that could be gh), then `pr`, then the action are among its words
 * in that order, which stops it; null otherwise. A word the gate can't read
 * stands for the next one only right after the one before it, and a quoted
 * string is one word, so text that only names the command isn't. Text a
 * program may run is the pipeline's to answer (`pipelineText`).
 */
function classify(command, action) {
  const { words } = command;
  if (!words.length) return null;
  const [name] = words;
  if (isGh(name) && words[1]?.known && words[1].text === "pr" && words[2]?.known && words[2].text === action) return "exact";
  const wanted = [mayBeGh, (word) => word.known && word.text === "pr", (word) => word.known && word.text === action];
  let stage = 0;
  let last = -1;
  // At least one of the three is the word itself: `cp "$a" "$b" "$c"` isn't
  // a merge, while `$G pr merge` and `gh pr $X` may be.
  let named = false;
  // After a word that may be several (`$X` unquoted), a later one may be
  // any of the rest: `X="gh pr"; $X merge 5`.
  let several = false;
  for (let at = 0; at < words.length && stage < 3; at += 1) {
    const word = words[at];
    // For gh, anywhere (`sudo $G pr …`); for pr and the action, right after the one before.
    const standsIn = !word.known && (stage === 0 || at === last + 1 || several);
    const skip = several && word.known ? [1, 2].find((later) => later > stage && wanted[later](word)) : undefined;
    const is = word.known && wanted[stage](word);
    if (is || skip !== undefined || standsIn) {
      named ||= is || skip !== undefined;
      stage = skip !== undefined ? skip + 1 : stage + 1;
      last = at;
      if (!word.known && !word.single) several = true;
    }
  }
  return stage === 3 && named ? "maybe" : null;
}

/**
 * The text a pipeline may run: every word, setting, here-string and
 * here-document of its commands, but the reviewed command's own words and
 * the words of a pipeline whose programs are all inert. Text is code unless
 * the gate knows otherwise, so a program it doesn't know (node, python, a
 * script) can't carry the command past it.
 */
function pipelineText(pipeline, target, trusting = true) {
  const live = !trusting || pipeline.some((command) => !inert(command));
  const parts = [];
  for (const command of pipeline) {
    parts.push(...command.settings.map((word) => word.text));
    // A setting's substitution runs whatever the pipeline is.
    if (command !== target) for (const setting of command.settings) for (const inner of setting.inner) parts.push(allText(inner));
    if (!live || command === target) continue;
    parts.push(...textOf(command));
    // What its own substitutions produce is its input too (`rg --pre=bash x <(echo …)`).
    for (const word of wordsOf(command)) for (const inner of word.inner) parts.push(allText(inner));
  }
  return parts.join(" ");
}

/** A command's words and what its redirections feed it: here-strings and here-documents. */
const textOf = (command) => [...command.words.map((word) => word.text), ...command.redirects.map((token) => (token.redirect === "<<<" ? token.target.text : (token.body ?? "")))];

const texts = new WeakMap();

/** Every setting, word, here-string and here-document in a token list and the substitutions in it. */
function allText(tokens) {
  if (texts.has(tokens)) return texts.get(tokens);
  const text = commandsOf(tokens).flatMap((command) => [
    ...command.settings.map((word) => word.text),
    ...textOf(command),
    ...wordsOf(command).flatMap((word) => word.inner.map(allText)),
  ]).join(" ");
  texts.set(tokens, text);
  return text;
}

/** A command list split into its pipelines: commands joined by `|` or `|&`. */
function pipelinesOf(commands) {
  const pipelines = [];
  let current = [];
  for (const command of commands) {
    current.push(command);
    if (!["|", "|&"].includes(command.after)) {
      pipelines.push(current);
      current = [];
    }
  }
  if (current.length) pipelines.push(current);
  return pipelines;
}

/** Every command list: the top one, and those of the substitutions inside it, with how deep each sits. */
function* everyList(commands, nested = false) {
  yield { commands, nested };
  for (const command of commands) {
    for (const word of wordsOf(command)) {
      for (const inner of word.inner) yield* everyList(commandsOf(inner), true);
    }
  }
}


/** Whether pflag reads a boolean flag's values as on: bare, or a true value. */
const isOn = (values) => {
  // pflag keeps the last value given: `--help --help=false` is off.
  const last = values?.[values.length - 1];
  return values?.length > 0 && (last === null || ["1", "t", "T", "true", "TRUE", "True"].includes(last));
};
/** Whether pflag reads a boolean flag as off: the last value it was given is false. */
const isOff = (values) => {
  const last = values?.[values.length - 1];
  return values?.length > 0 && last !== null && ["0", "f", "F", "false", "FALSE", "False"].includes(last);
};

/** gh's flags that take a value, for each command: the long name, and its short one if it has one. */
const VALUED = {
  create: { "--title": "-t", "--body": "-b", "--body-file": "-F", "--base": "-B", "--head": "-H", "--assignee": "-a", "--label": "-l", "--milestone": "-m", "--project": "-p", "--reviewer": "-r", "--repo": "-R", "--template": "-T", "--recover": null },
  merge: { "--author-email": "-A", "--body": "-b", "--body-file": "-F", "--subject": "-t", "--match-head-commit": null, "--repo": "-R" },
  ready: { "--repo": "-R" },
};

/**
 * A command's flags and the words that aren't flags, each flag read with its
 * value (`--x y`, `--x=y`, `-x y`, `-xy`, `-x=y`), so a value is never taken
 * for a flag: a body that says `--repo=x` is a body. Flags by their long
 * names. A flag that takes no value keeps one given with `=` (`--help=false`).
 */
export function parseWords(words, action) {
  const long = VALUED[action];
  const short = Object.fromEntries(Object.entries(long).filter(([, letter]) => letter).map(([name, letter]) => [letter, name]));
  const flags = new Map();
  const positional = [];
  const add = (name, value) => flags.set(name, [...(flags.get(name) ?? []), value]);
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === "--") {
      for (const rest of words.slice(i + 1)) positional.push({ word: rest, at: (i += 1) });
      break;
    }
    if (word.startsWith("--") && word.length > 2) {
      const eq = word.indexOf("=");
      const name = eq > 0 ? word.slice(0, eq) : word;
      if (Object.hasOwn(long, name)) add(name, eq > 0 ? word.slice(eq + 1) : (words[(i += 1)] ?? ""));
      else add(name, eq > 0 ? word.slice(eq + 1) : null);
    } else if (word.startsWith("-") && word.length > 1) {
      // A group of short flags (`-dB main`), as gh reads it: each letter is
      // a flag until one takes a value, which is the rest of the group (an
      // `=` before it dropped) or the next word.
      for (let at = 1; at < word.length; at += 1) {
        const letter = `-${word[at]}`;
        const glued = word.slice(at + 1);
        if (short[letter]) {
          add(short[letter], glued ? glued.replace(/^=/, "") : (words[(i += 1)] ?? ""));
          break;
        }
        // -h is --help's short name: one flag, so the last of either wins.
        const named = letter === "-h" ? "--help" : letter;
        if (glued.startsWith("=")) {
          add(named, glued.slice(1));
          break;
        }
        add(named, null);
      }
    } else {
      positional.push({ word, at: i });
    }
  }
  return { flags, positional };
}

/** A word as the shell hands it over: quotes taken off, escapes undone. */
export function unquote(word) {
  return tokenize(word).find((token) => "word" in token)?.word.text ?? "";
}

const stop = (why) => ({ fail: why });

/** The pattern inOrder finds a word by, compiled once per word. */
const patterns = new Map();
function patternFor(word) {
  if (!patterns.has(word)) {
    patterns.set(word, word === "gh"
      ? new RegExp(String.raw`(?<![\w.])(?:[gG][hH](?:\.[eE][xX][eE])?|${UNKNOWN})(?![\w./-])`, "g")
      : new RegExp(String.raw`(?<![\w./-])${word}(?![\w./-])`, "g"));
  }
  return patterns.get(word);
}

/**
 * Whether `words` come in this order in `text`, each a word of its own:
 * the text check for what programs may run, main's rule for exotic syntax,
 * and the answer when the reader can't read a command at all.
 */
function inOrder(text, words) {
  // A line continued is one line, and quotes and escapes come out, as the
  // shell would: `g''h` is gh.
  text = text
    .replace(/\\\n/g, "")
    // Escapes as printf and echo -e decode them: `g\x68` is gh.
    .replace(/\\(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|([0-7]{1,3}))/g, (_, hex, unicode, octal) => String.fromCharCode(parseInt(hex ?? unicode ?? octal, hex || unicode ? 16 : 8)))
    .replace(/["'\\]/g, "");
  let from = 0;
  for (const word of words) {
    // A word not inside a longer name (fix/gh-pr-create-flags isn't one:
    // nothing it holds is followed by - / or .), whatever else is beside it:
    // blanks, brackets, commas, backticks, a `${u:-gh}`. gh may end a path
    // (`/usr/bin/gh`), be gh.exe in any case, or be a word the gate can't read.
    const found = patternFor(word);
    found.lastIndex = from;
    const hit = found.exec(text);
    if (!hit) return false;
    from = hit.index + hit[0].length;
  }
  return true;
}

/** Keywords whose commands the reader can't follow as bash does. */
const EXOTIC_WORDS = new Set(["eval", "exec", "case", "coproc", "function"]);

/**
 * Syntax where the reader's quoting could part from bash's: there the gate
 * also keeps main's rule, gh, pr and the action as words in order in the
 * text (`inOrder`), so it's never less strict than main was (#925).
 * Ordinary commands (quotes, $(…), here-documents, pipes) don't need it.
 * Whether a command has exotic syntax: what the reader noted reading it
 * (`${…}`, `$'…'`, backticks, arithmetic, `<(…)`, `$"…"`), or a keyword as
 * an unquoted command word (`--subject "the empty case"` is text).
 */
function exotic(read, lists) {
  if (read) return true;
  return lists.some(({ commands }) => commands.some((command) => command.leading.includes("coproc") || command.words.slice(0, 2).some((word, at) => word.known && !word.quoted && EXOTIC_WORDS.has(word.text) && (at === 0 || ["command", "builtin", "env", "sudo"].includes(command.words[0].text)))));
}


/** Text with its comments taken out, quotes kept: a comment is nothing bash runs. */
function withoutComments(text) {
  let out = "";
  for (let at = 0; at < text.length; at += 1) {
    const past = pastQuoted(text, at);
    if (past !== at) {
      if (text[at] !== "#") out += text.slice(at, past + 1);
      at = past;
    } else out += text[at];
  }
  return out;
}

/** Where a command's own words, settings and redirection targets sit in the text it was read from. */
function spanOf(command) {
  const words = wordsOf(command);
  return { from: Math.min(...words.map((word) => word.from)), to: Math.max(...words.map((word) => word.to)) };
}

/**
 * From the command at `from`, where the run of commands joined by `joins`
 * ends: the index of its last command and the operator that ends it (`;`,
 * `&`, a new line, or null at the end). Subshells and compound commands
 * opened on the way are followed through to their close.
 */
function endOf(commands, from, joins) {
  let depth = 0;
  for (let index = from; index < commands.length; index += 1) {
    const command = commands[index];
    if (index > from) depth += opens(command);
    if (command.after === "(") depth += 1;
    else if (command.after === ")") depth -= 1;
    else if (depth <= 0 && !joins.includes(command.after)) return { last: index, by: command.after };
  }
  return { last: commands.length - 1, by: null };
}

/** How a command moves compound-command depth: +1 opening one, -1 closing one. */
function opens(command) {
  const [first] = command.words;
  if (command.leading.some((word) => ["while", "until", "if", "{"].includes(word)) || (first?.known && ["for", "case", "select"].includes(first.text))) return 1;
  return first?.known && CLOSERS.includes(first.text) ? -1 : 0;
}

/** A step before the command the gate can follow: `cd <folder>` or `git push …`. */
function stepOf(command) {
  const { words, settings, leading } = command;
  if (settings.length || leading.length || !words.every((word) => word.known)) return null;
  // Its redirections plain too: a substitution there would run before gh does.
  if (!command.redirects.every((token) => token.target.known && !token.target.inner.length && token.body === undefined)) return null;
  const texts = words.map((word) => word.text);
  // A ~ quoted, or another user's, isn't the home folder the gate would take it for.
  if (texts[0] === "cd" && texts.length === 2 && texts[1].startsWith("~") && (words[1].quoted || /^~[^/]/.test(texts[1]))) return { tilde: true };
  if (texts[0] === "cd") return texts.length === 2 ? { dir: texts[1] } : texts.length === 1 ? { dir: "" } : { odd: true };
  if (texts[0] === "git" && texts[1] === "push") return { push: true };
  return null;
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
  try {
    return readTokensOf(command, action);
  } catch (error) {
    if (!(error instanceof Unreadable) && !(error instanceof RangeError)) throw error;
    // Text the reader can't read (bash's error or not, or nesting too deep to
    // follow): if it might be the command, it's stopped rather than guessed.
    return inOrder(command, ["gh", "pr", action]) ? stop(`it can't be read as the shell would (${error.message})`) : null;
  }
}

/** readCommand's work, on a command the reader can read. */
function readTokensOf(command, action) {
  const tokens = tokenize(command);
  const odd = budget.exotic;
  const commands = commandsOf(tokens);
  const lists = [...everyList(commands)];
  const found = lists.flatMap(({ commands: list, nested }) => list.map((entry) => ({ command: entry, nested, kind: classify(entry, action) }))).filter((entry) => entry.kind);
  const exact = found.filter((entry) => entry.kind === "exact");
  const target = exact.length === 1 && !exact[0].nested ? exact[0].command : null;
  // Once exec points a stream at a file, what any program prints may land
  // in a script, so no program's words are data. So does a write on a group,
  // subshell or loop (`{ echo …; } > f`, `( … ) > f`, `done > f`): the
  // redirection sits on its closing word.
  const closes = (command) => !command.words.length || (command.words.length === 1 && command.words[0].known && CLOSERS.includes(command.words[0].text));
  const trusting = !lists.some(({ commands: list }) => list.some((command) => (command.words.slice(0, 2).some((word) => word.known && word.text === "exec") && command.redirects.length) || (closes(command) && command.redirects.some(writesFile))));
  // Stored text (a commit message) can come back through a pipe, a
  // substitution or a file, so when anything here may run text, each
  // command's own text is checked, as main's rule did. Commands made only
  // of data-only and read-only programs, steps and loop words keep the
  // precise reading.
  const runsText = (command) => command !== target && command.words.length > 0 && !inert(command) && !readsOnly(command) && !stepOf(command) && !(command.words[0].known && LOOP.has(command.words[0].text));
  const fed = lists.some(({ commands: list }) => list.some(runsText));
  // The reviewed command's own body (`--body "$(cat <<'EOF' …)"`) isn't stored text.
  const own = new Set(target ? wordsOf(target).flatMap((word) => word.inner).flatMap((tokens) => [...everyList(commandsOf(tokens), true)].map((entry) => entry.commands)) : []);
  // Its own body is out of the text check only when everything in it only
  // reads: `"$(echo '…' | sh)"` runs what it pipes.
  const quiet = (list) => own.has(list) && list.every(readsOnly);
  const stored = fed && lists.filter(({ commands: list }) => !quiet(list)).some(({ commands: list }) => list.some((command) => command !== target && inOrder([...command.settings.map((word) => word.text), ...textOf(command)].join(" "), ["gh", "pr", action])));
  const carried = stored || lists.filter(({ commands: list }) => !quiet(list)).some(({ commands: list }) => pipelinesOf(list).some((pipeline) => inOrder(pipelineText(pipeline, target, trusting), ["gh", "pr", action])));
  // Exotic syntax: main's rule too, outside the reviewed command's own words.
  if (exotic(odd, lists)) {
    const span = target ? spanOf(target) : null;
    // The reviewed command's own words, and the here-documents it reads,
    // are its own: a body that names the command isn't a second one.
    const cuts = span ? [span, ...target.redirects.filter((token) => token.bodyFrom !== undefined).map((token) => ({ from: token.bodyFrom, to: token.bodyTo }))].sort((a, b) => a.from - b.from) : [];
    let outside = "";
    let at = 0;
    for (const cut of cuts) {
      outside += command.slice(at, Math.max(at, cut.from)) + " ";
      at = Math.max(at, cut.to);
    }
    outside += command.slice(at);
    if (inOrder(withoutComments(outside), ["gh", "pr", action])) return stop(`it holds \`gh pr ${action}\` in syntax the gate can't be sure it reads as bash does; write it plainly, the body in --body-file`);
  }
  if (!found.length && !carried) return null;
  if (found.some((entry) => entry.kind === "maybe") || carried) return stop(`it might run \`gh pr ${action}\` in a form the gate can't read exactly (a word it can't follow, or text another program runs)`);
  if (exact.length > 1) return stop(`it runs \`gh pr ${action}\` more than once`);
  if (!target) return stop(`it runs \`gh pr ${action}\` inside a substitution`);
  if (target.leading.length) return stop(`it runs \`gh pr ${action}\` inside a compound command (\`${target.leading[0]}\`)`);

  // Before it: only `cd <folder> &&` and `git push … &&`, so the gate knows
  // which folder, and so which branch, the command runs in. Joined by `&&`:
  // after `;`, a folder that isn't there leaves gh running in another.
  const at = commands.indexOf(target);
  const dirs = [];
  let pushes = false;
  let first = 0;
  while (first < at && !commands[first].words.length && !commands[first].settings.length && !commands[first].redirects.length && !commands[first].leading.length && commands[first].after === "\n") first += 1;
  for (let index = first; index < at; index += 1) {
    const step = stepOf(commands[index]);
    const shown = commands[index].words.map((word) => word.text.replaceAll(UNKNOWN, "…")).join(" ");
    if (!step) return stop(`something runs before \`gh pr ${action}\` that the gate doesn't read (\`${shown.slice(0, 60)}\`)`);
    if (commands[index].after !== "&&") return stop(`\`${shown.slice(0, 60)}\` is followed by \`${commands[index].after === "\n" ? "a new line" : commands[index].after}\`, not \`&&\`, so gh would run whether it worked or not`);
    if (step.tilde) return stop("it changes to a folder with a `~` bash won't expand as the gate would (quoted, or another user's home)");
    if (step.push) pushes = true;
    else if (step.odd) return stop("it changes folder in a form the gate doesn't follow; use `cd <folder>`");
    else if (step.dir === "-" || step.dir === "") return stop("it changes folder with `cd -`, or with `cd` and no folder");
    else dirs.push(step.dir);
  }

  const env = {};
  for (const setting of target.settings) {
    const eq = setting.text.indexOf("=");
    const [, name, appends] = /^([A-Za-z_]\w*)(?:\[[^\]]*\])?(\+?)$/.exec(setting.text.slice(0, eq)) ?? [];
    // Added to (`+=`), it's whatever was there before too; an array's
    // element (`GH_REPO[0]=`) isn't passed to gh at all, so which one gh
    // uses can't be read.
    const subscripted = setting.text.slice(0, eq).includes("[");
    env[name] = setting.known && !appends && !subscripted ? setting.text.slice(eq + 1) : UNKNOWN;
  }

  // Its own words after `gh pr <action>`, as gh gets them. One that may be
  // several (an unquoted variable, a glob) could be any flag; a double-quoted
  // substitution is one, and safe as a flag's value.
  const args = target.words.slice(3);
  if (args.some((word) => !word.single)) return stop(`a word after \`gh pr ${action}\` may be several (an unquoted variable or glob); quote it, or the body in --body-file`);
  const { flags, positional } = parseWords(args.map((word) => word.text), action);
  if ([...flags.keys()].some((name) => name.includes(UNKNOWN))) return stop(`a flag after \`gh pr ${action}\` can't be read`);
  if (isOn(flags.get("--help"))) return null;
  // Back to a draft takes a pull request away from review; nothing to gate.
  if (action === "ready" && isOn(flags.get("--undo"))) return null;
  for (const name of ["--repo", "--base", "--head"]) {
    if ((flags.get(name) ?? []).some((value) => value.includes(UNKNOWN))) return stop(`its \`${name}\` can't be read`);
  }

  const repos = new Set(flags.get("--repo") ?? []);
  if (env.GH_REPO !== undefined) repos.add(env.GH_REPO);
  if (repos.has("") || repos.has(UNKNOWN) || repos.size > 1) return stop("which repository it's for can't be read");
  const read = { action, dirs, selector: null, base: null, repo: [...repos][0] ?? null };
  if (action === "create") {
    if (positional.length) return stop("a word after `gh pr create` isn't one of its flags or their values (it may be a whole flag, like `--head=…`)");
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
  // Nor one that may run at the same time, or before gh inside the command's
  // own substitutions: what runs there must only read (#932 binds the merge
  // to the reviewed commit itself).
  const reading = (lists) => lists.every(({ commands: list }) => list.every(readsOnly));
  // In the background, whatever follows runs beside it: an agent has no
  // need of that, so it's stopped rather than followed.
  if (endOf(commands, at, ["&&", "||", "|", "|&"]).by === "&") return stop(`it runs \`gh pr ${action}\` in the background; run it in the foreground, on its own`);
  // The rest of its pipeline runs beside it.
  const pipeline = endOf(commands, at, ["|", "|&"]);
  const alongside = commands.slice(at + 1, pipeline.last + 1);
  if (!reading([...everyList(alongside)])) return stop(`something runs alongside \`gh pr ${action}\` that could change the pull request while it's merged; run it on its own`);
  const inside = wordsOf(target).flatMap((word) => word.inner);
  if (!inside.every((tokens) => reading([...everyList(commandsOf(tokens), true)]))) return stop(`a substitution in \`gh pr ${action}\` runs something that could change the pull request first; put it in a file, and the file in the command`);
  if (action === "merge" && flags.has("--auto") && !isOff(flags.get("--auto"))) {
    return stop("`--auto` merges commits pushed after the review");
  }

  // The pull request, if named, is the first word after the command. Named
  // anywhere else, the gate can't be sure which word it is.
  if (positional.length > 1 || (positional.length === 1 && positional[0].at !== 0)) {
    return stop(`the pull request isn't the first word after \`gh pr ${action}\``);
  }
  read.selector = positional[0]?.word ?? null;
  // Named, so nothing in the command can change which pull request gh picks
  // from the branch (AGENTS.md: the number right after `gh pr merge`).
  if (action === "merge" && read.selector === null) return stop("name the pull request: `gh pr merge <number>`");
  if (read.selector?.includes(UNKNOWN)) return stop(`which pull request \`gh pr ${action}\` is for can't be read`);
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
      message: `Stopped before review: ${read.fail}. A fresh review runs before a pull request ${VERB[action]} (#917, AGENTS.md), and the gate stops a command it can't read rather than guess. Run it as a command of its own: \`gh pr ${action}${action === "merge" ? " <number>" : ""} …\`, with only \`cd <folder> &&\`${action === "create" ? " or \`git push … &&\`" : ""} in front${action === "create" ? "" : "; push first, on its own"}.`,
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
