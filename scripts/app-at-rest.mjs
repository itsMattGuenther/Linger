// Whether the iPhone app, left alone in the simulator, leaves the processor
// alone (#901).
//
// Its main loop once woke itself for good on the iPhone: Linger asked for
// its windows on every event, and there a copy of a window wakes the loop
// (`client/src-tauri/src/phone_scene.rs`). The main thread then used a whole
// processor for as long as the app was open, which on a phone is heat and
// battery, and on GitHub's Mac was one of its three processors gone for
// every flow. No flow fails on that, so this looks at it: the app is started
// again (signed in by then, connected to its server), given half a minute to
// finish starting, and looked at for twenty seconds, up to three times. One
// quiet look passes it, since a busy Mac can make an idle app late but can't
// make it work. Measured there: 0.04 to 0.05 s of processor in twenty at
// rest, and 19.9 to 20.2 with its main loop awake.
//
// Usage: node scripts/app-at-rest.mjs <simulator's UDID> <bundle id>
//   Exits 1, with a GitHub error, when the app never rested, when the launch
//   gave no process, or when the process went away: a check that can't
//   measure hasn't passed.
// AT_REST_SETTLE_MS and AT_REST_LOOK_MS shorten its waits, for its tests.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/** How many looks it gets. */
export const LOOKS = 3;
/** A look that used less than this share of its time is the app at rest: a fifth. */
export const BUSY_SHARE = 0.2;

/**
 * The process id `xcrun simctl launch` printed ("io.github.itsmattguenther.linger: 48943"),
 * or null when what it printed doesn't end in one.
 */
export function launchedPid(printed) {
  const found = /:\s*(\d+)\s*$/.exec(printed.trim());
  return found ? Number(found[1]) : null;
}

/**
 * The processor time a process has used, in seconds, from `ps -o time=`:
 * minutes:seconds.hundredths ("0:14.73"), with hours in front once there are
 * any ("1:02:03.45"), and days before those ("1-02:03:04"). Null for
 * anything else, which is what `ps` prints for a process that's gone:
 * nothing.
 */
export function processorSeconds(printed) {
  const found = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:[.,]\d+)?)$/.exec(printed.trim());
  if (!found) return null;
  const [, days = "0", hours = "0", minutes, seconds] = found;
  return ((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds.replace(",", "."));
}

/** Whether a look found the app at rest: what it used of the time it was looked at. */
export function rested(spentSeconds, lookSeconds) {
  return spentSeconds < lookSeconds * BUSY_SHARE;
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function main([udid, bundle]) {
  if (!udid || !bundle) {
    console.error("usage: node scripts/app-at-rest.mjs <simulator's UDID> <bundle id>");
    return 2;
  }
  const settleMs = Number(process.env.AT_REST_SETTLE_MS ?? 30_000);
  const lookMs = Number(process.env.AT_REST_LOOK_MS ?? 20_000);
  // Started again, so it's in front and what's measured is the app, not
  // whatever the last flow left it doing. It may not be running: that's fine.
  spawnSync("xcrun", ["simctl", "terminate", udid, bundle], { stdio: "ignore" });
  const launch = spawnSync("xcrun", ["simctl", "launch", udid, bundle], { encoding: "utf8" });
  const pid = launch.status === 0 ? launchedPid(launch.stdout) : null;
  if (pid === null) {
    console.log(`::error::the app didn't start, so there's nothing to measure: ${`${launch.stdout ?? ""}${launch.stderr ?? ""}`.trim() || "simctl said nothing"}`);
    return 1;
  }
  const used = () => processorSeconds(spawnSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "");
  await wait(settleMs);
  for (let look = 1; look <= LOOKS; look++) {
    const before = used();
    await wait(lookMs);
    const after = used();
    if (before === null || after === null) {
      console.log(`::error::the app (process ${pid}) is gone, so there's nothing to measure`);
      return 1;
    }
    const spent = after - before;
    console.log(`look ${look}: ${spent.toFixed(2)} s of processor in ${(lookMs / 1000).toFixed(0)} s at rest`);
    if (rested(spent, lookMs / 1000)) return 0;
  }
  // Which of its threads it is, for whoever reads the run.
  console.log(spawnSync("ps", ["-M", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "");
  console.log(`::error::the app never rested: a fifth or more of a processor in each of ${LOOKS} looks with nobody using it. Something keeps its main loop awake (#901).`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
