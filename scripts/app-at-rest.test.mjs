// scripts/app-at-rest.mjs (#901): what `simctl` and `ps` print on GitHub's
// Mac, read right, and the script run with stand-ins for both on PATH: an
// app at rest, one whose main loop never sleeps, one still starting, one
// that's gone, and a launch that gave no process.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { launchedPid, processorSeconds, rested } from "./app-at-rest.mjs";

const SCRIPT = fileURLToPath(new URL("./app-at-rest.mjs", import.meta.url));

test("the process id is read from what simctl prints on launch", () => {
  assert.equal(launchedPid("io.github.itsmattguenther.linger: 48943\n"), 48943);
  assert.equal(launchedPid("io.github.itsmattguenther.linger: 7"), 7);
  // What it prints when it can't: no id at the end.
  assert.equal(launchedPid("An error was encountered processing the command (domain=NSPOSIXErrorDomain, code=3):\n"), null);
  assert.equal(launchedPid("Unable to lookup in current state: Shutdown\n"), null);
  assert.equal(launchedPid(""), null);
});

test("processor time is read as seconds, whatever its length", () => {
  // As `ps -M` on the runner showed the app: 0:14.73 user and 0:02.66 system.
  assert.equal(processorSeconds("  0:14.73\n"), 14.73);
  assert.equal(processorSeconds("0:00.05"), 0.05);
  assert.equal(processorSeconds("12:03.50"), 723.5);
  assert.equal(processorSeconds("1:02:03.45"), 3723.45);
  assert.equal(processorSeconds("1-02:03:04"), 93784);
  // A locale that writes a comma.
  assert.equal(processorSeconds("0:14,73"), 14.73);
  // A process that's gone: `ps` prints nothing. And anything that isn't a time.
  assert.equal(processorSeconds(""), null);
  assert.equal(processorSeconds("\n"), null);
  assert.equal(processorSeconds("TIME"), null);
  assert.equal(processorSeconds("14.73"), null);
});

test("at rest is under a fifth of the time looked at", () => {
  // Measured on GitHub's Mac: 0.04 to 0.05 s at rest, 19.9 to 20.2 awake.
  assert.equal(rested(0.05, 20), true);
  assert.equal(rested(3.99, 20), true);
  assert.equal(rested(4, 20), false);
  assert.equal(rested(19.92, 20), false);
});

/**
 * Run the script with `xcrun` and `ps` standing in on PATH. `xcrun` prints
 * `launch` for a launch (and nothing for a terminate); `ps -o time=` prints
 * the next of `times` each time it's asked, and nothing once they run out,
 * as for a process that's gone.
 */
function run({ launch = "io.github.itsmattguenther.linger: 4242", launchStatus = 0, times }) {
  const dir = mkdtempSync(join(tmpdir(), "at-rest-"));
  try {
    const stand = (name, body) => {
      writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    };
    writeFileSync(join(dir, "times"), times.join("\n") + (times.length ? "\n" : ""));
    writeFileSync(join(dir, "asked"), "");
    stand("xcrun", `echo "$*" >> "${dir}/asked"\nif [ "$2" = launch ]; then printf '%s\\n' '${launch}'; exit ${launchStatus}; fi\nexit 0`);
    stand(
      "ps",
      `echo "ps $*" >> "${dir}/asked"\nif [ "$1" = "-M" ]; then echo "USER PID TT %CPU STAT PRI STIME UTIME COMMAND"; exit 0; fi\nline="$(head -n 1 "${dir}/times")"\n[ -n "$line" ] || exit 1\nsed -i.bak 1d "${dir}/times"\nprintf '  %s\\n' "$line"`,
    );
    const ran = spawnSync(process.execPath, [SCRIPT, "UDID-1", "io.github.itsmattguenther.linger"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, AT_REST_SETTLE_MS: "5", AT_REST_LOOK_MS: "20" },
    });
    return { status: ran.status, out: ran.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A look is 20 ms in these, so a fifth of it is 0.004 s of processor.
test("an app at rest passes on the first look", () => {
  const { status, out } = run({ times: ["0:03.100", "0:03.100"] });
  assert.equal(status, 0, out);
  assert.match(out, /^look 1: 0\.00 s of processor in 0 s at rest\n$/);
});

test("an app whose main loop never sleeps fails after three looks, and says so", () => {
  const { status, out } = run({ times: ["0:01.00", "0:01.02", "0:01.02", "0:01.04", "0:01.04", "0:01.06"] });
  assert.equal(status, 1, out);
  assert.equal(out.match(/^look \d: 0\.02 s/gm)?.length, 3);
  assert.match(out, /::error::the app never rested: .*Something keeps its main loop awake \(#901\)\./);
  // And which thread it is, for whoever reads the run.
  assert.match(out, /USER PID TT %CPU/);
});

test("an app still starting at the first look passes once it rests", () => {
  const { status, out } = run({ times: ["0:01.00", "0:01.02", "0:01.02", "0:01.02"] });
  assert.equal(status, 0, out);
  assert.match(out, /look 1: 0\.02 s[^\n]*\nlook 2: 0\.00 s/);
  assert.doesNotMatch(out, /::error::/);
});

test("an app that's gone fails: nothing to measure isn't a pass", () => {
  for (const times of [[], ["0:01.00"]]) {
    const { status, out } = run({ times });
    assert.equal(status, 1, out);
    assert.match(out, /::error::the app \(process 4242\) is gone, so there's nothing to measure/);
  }
});

test("a launch that gave no process fails, with what simctl said", () => {
  const refused = run({ launch: "Unable to lookup in current state: Shutdown", launchStatus: 149, times: ["0:01.00", "0:01.00"] });
  assert.equal(refused.status, 1, refused.out);
  assert.match(refused.out, /::error::the app didn't start, so there's nothing to measure: Unable to lookup in current state: Shutdown/);
  // It printed something and no id, and said it worked.
  const odd = run({ launch: "launched", times: ["0:01.00", "0:01.00"] });
  assert.equal(odd.status, 1, odd.out);
});

test("it asks for the simulator and the app it was given, and says how it's used without them", () => {
  const none = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /usage: node scripts\/app-at-rest\.mjs/);
});
