// Whether a failed iPhone simulator run stopped because Maestro's own driver
// died, not because a flow found something wrong (#857).
//
// Maestro drives the simulator through an XCUITest runner. Any failure
// XCUITest records inside it, such as a screenshot timing out while the
// simulator is slow, tears the runner down, and every flow left fails with
// it, whatever the app did (Maestro's issue 3538). On #856, Photos' share
// sheet was in front and Linger hadn't been reached yet.
//
// It isn't re-run by itself: a frozen app in front can time a screenshot out
// too, and a re-run would hide that. So this says which it was, and which app
// was in front, and a person decides.
//
// Usage: node scripts/maestro-driver.mjs <maestro's --test-output-dir>
//   Prints a GitHub warning when the driver died. Never fails itself.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LINGER = "io.github.itsmattguenther.linger";

/**
 * From the XCUITest runner's log: `{ died: false }`, or the failure that
 * tore it down and the apps Maestro last saw in front.
 */
export function verdict(log) {
  const lines = log.split("\n");
  const at = lines.findIndex((line) => /\btestHttpServer\] : /.test(line));
  if (at < 0) return { died: false };
  const error = lines[at].replace(/^.*\btestHttpServer\] : /, "").trim();
  let front = null;
  for (let i = at; i >= 0 && front === null; i--) {
    const seen = /Detected running apps: \[(.*)\]/.exec(lines[i]);
    if (seen) front = [...seen[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  }
  return { died: true, error, front };
}

/** What the run's log says about it, for a person deciding whether to re-run. */
export function said(result) {
  if (!result.died) return "Maestro's driver was alive to the end: the failure is a flow's own.";
  const front = result.front === null ? "not known" : result.front.length === 0 ? "none" : result.front.map((app) => (app === LINGER ? "Linger" : app)).join(", ");
  const advice = result.front?.includes(LINGER)
    ? "Linger was in front: check it didn't freeze before re-running."
    : "Linger wasn't in front: re-run once (#857).";
  return `::warning title=Maestro's driver died::The run stopped because Maestro's own driver died, not because a flow failed: ${result.error} The app in front: ${front}. ${advice}`;
}

function run() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node scripts/maestro-driver.mjs <maestro's --test-output-dir>");
    process.exitCode = 2;
    return;
  }
  // Maestro writes each run's runner log in a dated folder of its own.
  let logs = [];
  try {
    logs = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => readdirSync(join(dir, entry.name)).filter((name) => /^xctest_runner_.*\.log$/.test(name)).map((name) => join(dir, entry.name, name)));
  } catch {
    // No output at all: Maestro didn't get as far as starting.
  }
  if (logs.length === 0) return console.log("No XCUITest runner log: nothing to say about Maestro's driver.");
  for (const path of logs) console.log(said(verdict(readFileSync(path, "utf8"))));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
