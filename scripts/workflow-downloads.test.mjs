// Every download a workflow makes is tried again when it fails (#761). One
// slow moment at ffmpeg.org failed a package build (#753): with nothing to
// try again, any slow server is a red job, and in a release a release that
// stops half way.
//
// A download is a curl that keeps what it fetched: written to a file (-o,
// -O, --output, --remote-name, > file) or handed on (|). One that throws it
// away (-o /dev/null) is a check, retried by the loop it sits in. It must say
// --retry and --retry-all-errors: by default curl tries again only after a
// timeout or a 5xx, not a dropped or refused connection. wget isn't used: one
// tool, one rule.
//
// Reads the workflows and the repository's own actions without a YAML
// library: a command continued with a trailing backslash is joined into one
// line first.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

/**
 * The commands on one line, split where the shell would: at ;, &&, || and |,
 * outside quotes, with or without spaces around them, and stopping at a
 * comment. Each says whether its output is piped on.
 */
export function commandsOf(line) {
  const out = [];
  let command = "";
  let quote = null;
  for (let at = 0; at < line.length; at += 1) {
    const char = line[at];
    if (quote !== null) {
      command += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      command += char;
      continue;
    }
    if (char === "#" && (at === 0 || /\s/.test(line[at - 1]))) break;
    const two = line.slice(at, at + 2);
    if (two === "&&" || two === "||") {
      out.push({ command, piped: false });
      command = "";
      at += 1;
      continue;
    }
    if (char === ";" || char === "|") {
      out.push({ command, piped: char === "|" });
      command = "";
      continue;
    }
    command += char;
  }
  out.push({ command, piped: false });
  return out;
}

/** `/dev/null`, quoted or not: an answer thrown away. */
const NULL = String.raw`["']?\/dev\/null["']?(?:\s|$)`;

/** What's wrong with one command, or null when it's fine. */
function commandProblem({ command, piped }) {
  // A wget run, not one named in a list of packages: an option or an address follows.
  if (/(?:^|[\s(])wget\s+(?:-|https?:|["'$])/.test(command)) return "use curl, with --retry 5 --retry-all-errors";
  if (!/(?:^|[\s(])curl\s/.test(command)) return null;
  const toFile =
    /\s-[a-zA-Z]*O(?:\s|$)/.test(command) ||
    /\s--remote-name\b/.test(command) ||
    new RegExp(String.raw`\s(?:-[a-zA-Z]*o|--output)(?:\s+|=)(?!${NULL})\S`).test(command) ||
    // Standard output into a file; not 2> (errors), not >&2.
    new RegExp(String.raw`(?:^|[^0-9&])>{1,2}\s*(?!${NULL}|&)\S`).test(command);
  if (!toFile && !piped) return null;
  if (!/\s--retry\s+[1-9]/.test(command)) return "a download without --retry";
  if (!/\s--retry-all-errors\b/.test(command)) return "a download without --retry-all-errors";
  return null;
}

/** What's wrong with one shell line, every command on it, or null when it's fine. */
export function downloadProblem(line) {
  for (const command of commandsOf(line)) {
    const problem = commandProblem(command);
    if (problem !== null) return problem;
  }
  return null;
}

const root = new URL("../", import.meta.url);
const files = [
  ...readdirSync(new URL(".github/workflows/", root))
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => ({ name, text: readFileSync(new URL(`.github/workflows/${name}`, root), "utf8") })),
  ...readdirSync(new URL(".github/actions/", root)).map((dir) => ({
    name: `actions/${dir}/action.yml`,
    text: readFileSync(new URL(`.github/actions/${dir}/action.yml`, root), "utf8"),
  })),
];

/** Each file's lines, a backslash-continued command joined into its first line. */
function commands({ name, text }) {
  const joined = [];
  for (const [at, line] of text.split("\n").entries()) {
    const last = joined[joined.length - 1];
    if (last?.continues) {
      last.line += ` ${line.trim()}`;
      last.continues = /\\\s*$/.test(line);
      if (!last.continues) last.line = last.line.replace(/\s*\\\s*/g, " ");
      continue;
    }
    joined.push({ where: `${name}:${at + 1}`, line, continues: /\\\s*$/.test(line) });
  }
  return joined.map(({ where, line }) => ({ where, line: line.replace(/\s*\\\s*/g, " ") }));
}

const lines = files.flatMap(commands);

test("a download without retries is refused; a check, a package list or a retried download is not", () => {
  const fine = [
    'curl -fsSL --retry 5 --retry-all-errors --connect-timeout 30 -o "$RUNNER_TEMP/pepk.jar" "$PEPK_URL"',
    'curl -fL --no-progress-meter --retry 5 --retry-all-errors -o "$part" "$url"',
    'curl -fsS -o /dev/null "$LINGER_TEST_S3_ENDPOINT/minio/health/live" && exit 0',
    "curl --version",
    "librsvg2-dev libasound2-dev build-essential curl wget file libxdo-dev patchelf",
    "sudo apt-get install -y curl wget",
    "# curl -o old.jar https://example.com/old.jar",
    'curl -fsS -o "/dev/null" "$HEALTH"',
    "curl -fsS -o '/dev/null' \"$HEALTH\" 2>&1 || exit 1",
    'curl -fsS --output=/dev/null "$HEALTH" >&2',
    'echo "the | in here is words" ; curl --version',
  ];
  for (const line of fine) assert.equal(downloadProblem(line), null, line);
  const bad = [
    'curl -fsSL -o "$RUNNER_TEMP/pepk.jar" "$PEPK_URL"',
    'curl -sSfL --retry 3 -o "$download" "$URL"',
    "curl -sSfLO https://example.com/tool.tar.gz",
    "curl -fsSL --remote-name https://example.com/tool.tar.gz",
    "curl -fsSL https://example.com/install.sh | sh",
    "curl -fsSL https://example.com/tool.tar.gz > tool.tar.gz",
    "curl -fsSL --output=tool.tar.gz https://example.com/tool.tar.gz",
    "set -e; curl -fsSLo tool.tar.gz https://example.com/tool.tar.gz && tar -xf tool.tar.gz",
    "wget https://example.com/tool.tar.gz",
    'curl -fsS -o /dev/null "$HEALTH" && curl -fsSL -o tool.jar "$URL"',
    'curl -fsSL "$URL"|sh',
    'curl -fsSL "$URL" >tool.tar.gz',
    'curl -fsSL --retry 5 --retry-all-errors -o a.jar "$A";curl -fsSL -o b.jar "$B"',
  ];
  for (const line of bad) assert.notEqual(downloadProblem(line), null, line);
});

test("a command continued over several lines is read whole", () => {
  const joined = commands({ name: "x.yml", text: 'run: |\n  curl -fsSL \\\n    --retry 5 \\\n    -o out "$URL"\n  echo done\n' });
  assert.equal(joined[1]?.line.trim(), 'curl -fsSL --retry 5 -o out "$URL"');
  assert.equal(downloadProblem(joined[1]?.line ?? ""), "a download without --retry-all-errors");
});

test("the workflows' downloads are all found", () => {
  // A reader that finds nothing passes everything; this one is known to be there.
  assert.ok(lines.some(({ where, line }) => where.startsWith("play.yml:") && /curl .*pepk\.jar/.test(line)), "play.yml's pepk.jar download not found");
});

test("every download a workflow makes is tried again when it fails", () => {
  const problems = lines.flatMap(({ where, line }) => {
    const problem = downloadProblem(line);
    return problem ? [`${where}: ${line.trim()}: ${problem}`] : [];
  });
  assert.deepEqual(problems, []);
});
