// Every action a workflow runs is pinned to a full commit SHA, with the version
// it stands for in a comment (#491). A tag or branch is a pointer its owner can
// move to new code, and the release job hands the updater's signing key to the
// code it points at; a moved tag is how tj-actions/changed-files leaked
// secrets from thousands of repositories in March 2025. A SHA names one exact
// commit, so what runs next to a key only changes when this repository
// changes it. GitHub's own actions/* are held to the same rule: it costs
// nothing, and one rule is easier to keep than two.
//
// Reads the workflows without a YAML library: a `uses:` is one line.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

/**
 * What's wrong with one `uses:` value (the rest of its line included), or
 * null when it's fine. Local actions and workflows (`./…`) are this
 * repository's own code and need no pin.
 */
function pinProblem(value) {
  const [, ref, comment] = /^["']?([^"'\s#]+)["']?\s*(?:#\s*(.*?))?\s*$/.exec(value) ?? [];
  if (!ref) return "no action named";
  if (ref.startsWith("./")) return null;
  if (ref.startsWith("docker://")) {
    return /@sha256:[0-9a-f]{64}$/.test(ref) ? null : "a docker:// image needs an @sha256: digest";
  }
  const at = ref.lastIndexOf("@");
  if (at < 0) return "no @ref";
  if (!/^[0-9a-f]{40}$/.test(ref.slice(at + 1))) return "pin a full 40-character commit SHA, not a tag or branch";
  if (!comment) return "say which version the SHA is in a comment: @<sha> # v1.2.3";
  return null;
}

const root = new URL("../", import.meta.url);
const workflows = readdirSync(new URL(".github/workflows/", root))
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, lines: readFileSync(new URL(`.github/workflows/${name}`, root), "utf8").split("\n") }));
const uses = workflows.flatMap(({ name, lines }) =>
  lines.flatMap((line, at) => {
    const match = /^(\s*)(-\s+)?uses:\s*(.*)$/.exec(line);
    if (!match) return [];
    // The column of the step's dash: a line at or left of it ends the step.
    const step = match[2] ? match[1].length : match[1].length - 2;
    return [{ where: `${name}:${at + 1}`, value: match[3], name, at, step }];
  }),
);

test("a tag, a branch or a short SHA is refused; a full SHA with its version is not", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(pinProblem(`tauri-apps/tauri-action@${sha} # v0.6.2`), null);
  assert.equal(pinProblem(`actions/checkout@${sha} # v4.4.0`), null);
  assert.equal(pinProblem(`"docker/login-action@${sha}" # v3.7.0`), null);
  assert.equal(pinProblem(`octo/repo/.github/workflows/build.yml@${sha} # v2.0.0`), null);
  assert.equal(pinProblem("./.github/workflows/ci.yml"), null);
  for (const bad of [
    "tauri-apps/tauri-action@v0",
    "dtolnay/rust-toolchain@stable",
    "actions/checkout@v4 # v4.4.0",
    `actions/checkout@${sha.slice(0, 7)} # v4.4.0`,
    `actions/checkout@${sha.toUpperCase()} # v4.4.0`,
    `actions/checkout@${sha}`,
    `actions/checkout@${sha} #`,
    "actions/checkout",
    "docker://alpine:3.20",
    "",
  ]) {
    assert.notEqual(pinProblem(bad), null, bad);
  }
});

test("the workflows' actions are all found", () => {
  // A reader that finds nothing passes everything; these are known to be there.
  const refs = uses.map((use) => use.value);
  for (const action of ["actions/checkout@", "tauri-apps/tauri-action@", "docker/build-push-action@"]) {
    assert.ok(refs.some((ref) => ref.startsWith(action)), `no ${action} found`);
  }
});

test("every action a workflow uses is pinned to a commit SHA", () => {
  const unpinned = uses.flatMap(({ where, value }) => {
    const problem = pinProblem(value);
    return problem ? [`${where}: ${value.trim()}: ${problem}`] : [];
  });
  assert.deepEqual(unpinned, []);
});

test("a pinned dtolnay/rust-toolchain says which toolchain", () => {
  // Its branches (@stable, @nightly) pick the toolchain by their name. A pinned
  // SHA has to be one of master's commits, since its README says others get
  // garbage-collected, and master has no default: the step fails without one.
  const missing = uses
    .filter(({ value }) => value.startsWith("dtolnay/rust-toolchain@"))
    .filter(({ name, at, step }) => {
      const after = workflows.find((workflow) => workflow.name === name).lines.slice(at + 1);
      const end = after.findIndex((line) => line.trim() && line.search(/\S/) <= step);
      return !after.slice(0, end < 0 ? undefined : end).some((line) => /^\s+toolchain:\s*\S/.test(line));
    })
    .map(({ where }) => where);
  assert.deepEqual(missing, []);
});
