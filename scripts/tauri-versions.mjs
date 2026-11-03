// Tauri's Rust crates and JavaScript packages on the same version (#788).
// The `tauri` crate and `@tauri-apps/api` are one release in two languages,
// and so are a `tauri-plugin-*` crate and its `@tauri-apps/plugin-*`
// package: from different minor versions, the page can call a command the
// shell doesn't have, or read an answer in a shape it no longer sends. The
// upgrade to 2.12 moves all of them at once (#788), so a half-moved one
// fails here rather than in a build or on a phone.
//
// It reads what's installed, not what's asked for: the lockfiles,
// `client/src-tauri/Cargo.lock` and `client/pnpm-lock.yaml`. Anything in them
// it can't read fails, naming it, rather than being passed over
// (docs/testing-strategy.md).
//
// Usage: node scripts/tauri-versions.mjs   (from anywhere in the repository)
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CARGO_LOCK = "client/src-tauri/Cargo.lock";
export const PNPM_LOCK = "client/pnpm-lock.yaml";

/** Every package in a Cargo.lock, as name → its versions. */
export function cargoPackages(text, file = CARGO_LOCK) {
  const packages = new Map();
  const blocks = text.split(/^\[\[package\]\][ \t]*$/m).slice(1);
  if (!blocks.length) throw new Error(`${file}: no [[package]] in it`);
  for (const block of blocks) {
    const body = block.split(/^\[/m)[0];
    const name = /^name = "([^"]+)"$/m.exec(body)?.[1];
    const version = /^version = "([^"]+)"$/m.exec(body)?.[1];
    if (!name || !version) throw new Error(`${file}: a [[package]] without a name and a version: ${body.trim().split("\n")[0]}`);
    packages.set(name, [...(packages.get(name) ?? []), version]);
  }
  return packages;
}

/** The `.` importer's sections that list packages, and the ones that hold no versions. */
const LISTS = new Set(["dependencies", "devDependencies", "optionalDependencies"]);
const NOT_LISTS = new Set(["dependenciesMeta", "publishDirectory"]);

/**
 * The client's own dependencies in a pnpm-lock.yaml (lockfile version 9), as
 * name → version: the `.` importer's dependencies, devDependencies and
 * optionalDependencies. A peer suffix (`2.12.4(react@19.2.0)`) is dropped.
 * Every line under the importer is one it knows or a failure: a section it
 * doesn't know, or an entry without a version, fails rather than dropping
 * the packages in it (#841's review).
 */
export function pnpmDependencies(text, file = PNPM_LOCK) {
  const lines = text.split("\n");
  const version = /^lockfileVersion: '?([\d.]+)'?/m.exec(text)?.[1];
  if (!version || !version.startsWith("9")) throw new Error(`${file}: lockfile version ${version ?? "missing"}, and this reads 9`);
  const start = lines.findIndex((line) => /^importers:\s*$/.test(line));
  if (start < 0) throw new Error(`${file}: no importers`);
  const dot = lines.findIndex((line, i) => i > start && /^ {2}'?\.'?:\s*$/.test(line));
  if (dot < 0) throw new Error(`${file}: no "." importer`);
  const found = new Map();
  let section = null;
  let entry = null;
  const finish = () => {
    if (entry && entry.version === undefined) throw new Error(`${file}:${entry.line}: ${entry.name} has no version`);
    entry = null;
  };
  for (let i = dot + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // Two spaces in or fewer: the next importer, or the next top-level key.
    if (/^ {0,2}\S/.test(line)) break;
    const key = /^ {4}(\w+):(.*)$/.exec(line);
    if (key) {
      finish();
      section = key[1];
      if (LISTS.has(section) && !key[2].trim()) continue;
      // How packages are installed, not which version: read past them.
      if (NOT_LISTS.has(section)) continue;
      throw new Error(`${file}:${i + 1}: the "." importer has ${JSON.stringify(line.trim())}, which this doesn't know`);
    }
    if (NOT_LISTS.has(section)) continue;
    if (!LISTS.has(section)) throw new Error(`${file}:${i + 1}: can't read ${JSON.stringify(line.trim())}`);
    const dependency = /^ {6}(?:'([^']+)'|"([^"]+)"|([^\s'":]+)):\s*$/.exec(line);
    if (dependency) {
      finish();
      entry = { name: dependency[1] ?? dependency[2] ?? dependency[3], line: i + 1 };
      continue;
    }
    const field = /^ {8}(specifier|version): (.+)$/.exec(line);
    if (field && entry) {
      if (field[1] === "version") {
        entry.version = field[2].replace(/^'|'$/g, "").replace(/\(.*$/, "");
        found.set(entry.name, entry.version);
      }
      continue;
    }
    throw new Error(`${file}:${i + 1}: can't read ${JSON.stringify(line.trim())}`);
  }
  finish();
  return found;
}

const minor = (version) => /^(\d+)\.(\d+)\.\d+/.exec(version)?.slice(1, 3).join(".");

/**
 * What doesn't match, in words: `tauri`, `@tauri-apps/api` and
 * `@tauri-apps/cli` on one major.minor, and each `@tauri-apps/plugin-*` on
 * its crate's. A crate with no package of its own (deep-link, updater) is
 * Rust only and has nothing to match.
 */
export function problems(cargo, pnpm) {
  const found = [];
  const readable = (name, version) => {
    if (minor(version)) return version;
    found.push(`can't read ${name}'s version, ${version}`);
    return null;
  };
  const crate = (name) => {
    const versions = cargo.get(name) ?? [];
    if (versions.length === 1) return readable(name, versions[0]);
    found.push(`${CARGO_LOCK} has ${versions.length ? `${versions.length} versions of ${name} (${versions.join(", ")})` : `no ${name}`}; it needs one`);
    return null;
  };
  const match = (name, version, other, otherVersion) => {
    if (version && otherVersion && minor(version) !== minor(otherVersion))
      found.push(`${name} is ${version} and ${other} is ${otherVersion}: their major.minor must match`);
  };
  const tauri = crate("tauri");
  for (const name of ["@tauri-apps/api", "@tauri-apps/cli"]) {
    if (!pnpm.has(name)) found.push(`${PNPM_LOCK} has no ${name}`);
    else match(name, readable(name, pnpm.get(name)), "the tauri crate", tauri);
  }
  for (const [name, version] of pnpm) {
    const plugin = /^@tauri-apps\/plugin-(.+)$/.exec(name)?.[1];
    if (plugin) match(name, readable(name, version), `the tauri-plugin-${plugin} crate`, crate(`tauri-plugin-${plugin}`));
  }
  return found;
}

function run() {
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const cargo = cargoPackages(readFileSync(join(root, CARGO_LOCK), "utf8"));
  const pnpm = pnpmDependencies(readFileSync(join(root, PNPM_LOCK), "utf8"));
  const found = problems(cargo, pnpm);
  if (found.length) {
    for (const problem of found) console.error(problem);
    process.exit(1);
  }
  console.log(`Tauri's crates and packages match: tauri ${cargo.get("tauri")[0]}, @tauri-apps/api ${pnpm.get("@tauri-apps/api")}, @tauri-apps/cli ${pnpm.get("@tauri-apps/cli")}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
