// The iPhone simulator's flows (client/tests/ios, run by ios-simulator.yml on
// a Mac), checked here where they can't run: every flow is in config.yaml's
// order and every name in the order is a flow, so a new one can't be left
// out or run out of turn, and each names the app it drives. A mistake here
// otherwise shows only after a 30-minute run on GitHub's Mac (#835). And
// docs/development.md's numbered list of them, a second copy of the order,
// says the same.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL("../client/tests/ios/", import.meta.url));
const GUIDE = fileURLToPath(new URL("../docs/development.md", import.meta.url));

/**
 * The names under executionOrder.flowsOrder, failing on anything else in the
 * list. Only under executionOrder: a flowsOrder anywhere else is one Maestro
 * doesn't read (#841's review).
 */
export function flowsOrder(text) {
  const lines = text.split("\n");
  const parent = lines.findIndex((line) => /^executionOrder:\s*$/.test(line));
  let start = -1;
  for (let i = parent + 1; parent >= 0 && i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && !/^#/.test(lines[i])) break;
    if (/^ {2}flowsOrder:\s*$/.test(lines[i])) { start = i; break; }
  }
  assert(start >= 0, "config.yaml has no executionOrder.flowsOrder");
  const names = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = /^ {4}- ([\w-]+)\s*$/.exec(line);
    if (item) { names.push(item[1]); continue; }
    assert(/^ {0,2}\S/.test(line), `config.yaml: can't read ${JSON.stringify(line)} in flowsOrder`);
    break;
  }
  return names;
}

const flows = readdirSync(DIR).filter((name) => name.endsWith(".yaml") && name !== "config.yaml").map((name) => name.slice(0, -5)).sort();

test("every flow is in config.yaml's order, once, and every name in it is a flow", () => {
  const order = flowsOrder(readFileSync(join(DIR, "config.yaml"), "utf8"));
  assert.deepEqual([...order].sort(), flows);
  assert.equal(new Set(order).size, order.length, "a flow is in the order twice");
  assert.equal(order[0], "first-screen", "the first flow is the one that starts the app");
});

test("each flow names the app it drives (Linger's, or Photos for a share), then its commands", () => {
  for (const name of flows) {
    const text = readFileSync(join(DIR, `${name}.yaml`), "utf8");
    assert.match(text, /^appId: (io\.github\.itsmattguenther\.linger|com\.apple\.mobileslideshow)$/m, `${name}.yaml drives no app it knows`);
    assert.match(text, /^appId: .*\n---$/m, `${name}.yaml has no --- right after its appId`);
  }
});

test("docs/development.md lists the flows in config.yaml's order", () => {
  const order = flowsOrder(readFileSync(join(DIR, "config.yaml"), "utf8"));
  const listed = [...readFileSync(GUIDE, "utf8").matchAll(/^(\d+)\. `([\w-]+)\.yaml`/gm)];
  assert.deepEqual(listed.map((match) => match[2]), order, "the guide's list of flows, under \"What it does\"");
  assert.deepEqual(listed.map((match) => Number(match[1])), order.map((_, i) => i + 1), "numbered from 1, in order");
});

// iOS asks before an app opens a link from outside it ("Open in "Linger"?"),
// and the link only arrives once somebody taps Open. The link flows' first
// run waited for a link that was still waiting on that question (#835). The
// workflow approves linger:// ahead so iOS doesn't ask (#847), and the tap
// stays for when it asks anyway.
test("every linger:// link a flow opens answers iOS's question about opening it", () => {
  for (const name of flows) {
    const commands = readFileSync(join(DIR, `${name}.yaml`), "utf8").split(/^---$/m)[1].split(/^- /m).slice(1);
    commands.forEach((command, i) => {
      if (!/^openLink:\s*"?linger:/.test(command)) return;
      const next = commands[i + 1] ?? "";
      assert.match(next, /^tapOn:\s*\n\s+text: "Open"\n\s+optional: true/, `${name}.yaml: the command after opening a linger:// link taps iOS's Open`);
    });
  }
});

// Maestro's typing has lost all but its first letter under load (#863), so a
// flow types through subflows/type.yaml, which waits for the field to hold
// the text and types once more when it doesn't. Two can't be read back and
// type directly: a password's field shows dots, and the share window is out
// of Maestro's sight.
test("the flows type through the check that the typing arrived, but where it can't be read back", () => {
  const unread = new Set(["set-up: ${HOST_PASSWORD}", 'share-photo: "From the share sheet."']);
  const direct = [];
  let checked = 0;
  for (const name of flows) {
    const flow = readFileSync(join(DIR, `${name}.yaml`), "utf8");
    for (const match of flow.matchAll(/^- inputText: (.+)$/gm)) direct.push(`${name}: ${match[1]}`);
    checked += [...flow.matchAll(/^- runFlow:\n {4}file: subflows\/type\.yaml\n {4}env:\n {6}TEXT: \S/gm)].length;
  }
  assert.deepEqual(direct.sort(), [...unread].sort(), "only the password and the share window's message type directly");
  assert(checked >= 6, `${checked} typing steps through the check`);

  // The subflow, command by command: type; wait for the field to hold it,
  // giving late keys time; only if it doesn't, erase and type once more;
  // then wait again, and fail if it still doesn't.
  const sub = readFileSync(join(DIR, "subflows/type.yaml"), "utf8").split(/^---$/m)[1];
  const commands = sub.split(/^- /m).slice(1).map((command) => command.replace(/^\s*#.*\n/gm, "").trimEnd());
  const holds = "visible:\n      text: \\$\\{TEXT\\}\n      focused: true\n    timeout: \\d+";
  assert.equal(commands.length, 4, "four commands");
  assert.match(commands[0], /^inputText: \$\{TEXT\}$/, "types");
  assert.match(commands[1], new RegExp(`^extendedWaitUntil:\\n    ${holds}\\n    optional: true$`), "waits for the field to hold it, without failing yet");
  assert.match(commands[2], /^runFlow:\n    when:\n      notVisible:\n        text: \$\{TEXT\}\n        focused: true\n    commands:\n      - eraseText: \d+\n      - inputText: \$\{TEXT\}$/, "erases and types once more, only when it doesn't");
  assert.match(commands[3], new RegExp(`^extendedWaitUntil:\\n    ${holds}$`), "then waits again, and fails when it still doesn't");
});

test("the order is read strictly", () => {
  assert.deepEqual(flowsOrder("executionOrder:\n  flowsOrder:\n    - a\n    # a note\n    - b-c\n\nother: 1\n"), ["a", "b-c"]);
  assert.throws(() => flowsOrder("executionOrder:\n  flowsOrder:\n    - a\n      - nested\n"), /can't read/);
  assert.throws(() => flowsOrder("executionOrder:\n  continueOnFailure: false\n"), /no executionOrder\.flowsOrder/);
  assert.deepEqual(flowsOrder("executionOrder:\n  continueOnFailure: false\n# a note\n  flowsOrder:\n    - a\n"), ["a"]);
  // #841's review: a list under another key isn't the order Maestro reads.
  assert.throws(() => flowsOrder("settings:\n  flowsOrder:\n    - a\nexecutionOrder:\n  continueOnFailure: false\n"), /no executionOrder\.flowsOrder/);
  assert.throws(() => flowsOrder("executionOrder:\n  continueOnFailure: false\nsettings:\n  flowsOrder:\n    - a\n"), /no executionOrder\.flowsOrder/);
});

// While XCUITest drove the simulator, iOS sometimes held its question, or
// the link after it, until the driver let go, and a link flow timed out
// (#847). The workflow approves the scheme ahead, for the app, the way
// answering Open once does; this keeps that approval naming the scheme
// and the app the iPhone build has.
test("the simulator approves the app's own scheme for the app, before the flows open a link", () => {
  const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/ios-simulator.yml", import.meta.url)), "utf8");
  const tauri = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`../client/src-tauri/${name}`, import.meta.url)), "utf8"));
  const schemes = tauri("tauri.conf.json").plugins["deep-link"].mobile.flatMap((entry) => entry.scheme);
  const app = tauri("tauri.ios.conf.json").identifier;
  assert.deepEqual(schemes, ["linger"], "tauri.conf.json's phone schemes, as this test knows them");
  const approvals = [...workflow.matchAll(/defaults write com\.apple\.launchservices\.schemeapproval \\\n\s*"com\.apple\.CoreSimulator\.CoreSimulatorBridge-->([\w.+-]+)" -string ([\w.-]+)\n/g)];
  assert.deepEqual(approvals.map((match) => [match[1], match[2]]), schemes.map((scheme) => [scheme, app]), "one approval per scheme, for the iPhone app's identifier");
  const at = (text) => workflow.indexOf(text);
  assert(at("schemeapproval") > at("simctl bootstatus") && at("schemeapproval") < at("maestro test"), "after the iPhone has booted, before the flows");
});

// The simulator's certificate service sometimes took over a minute on its
// first check of the test certificate, longer than the app waits, and the
// set-up flow failed with nothing wrong in Linger (#848). The run has
// Safari ask first and waits for that handshake, between trusting the test
// authority and the flows; this keeps it there.
test("the simulator's first certificate check is done before the flows, after the authority is trusted", () => {
  const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/ios-simulator.yml", import.meta.url)), "utf8");
  const at = (text) => {
    const index = workflow.indexOf(text);
    assert(index >= 0, `ios-simulator.yml has ${text}`);
    return index;
  };
  const warm = at("- name: the simulator's first certificate check, out of the way");
  assert(at("add-root-cert") < warm, "after the test authority is trusted");
  assert(warm < at("maestro test"), "before the flows");
  assert.match(workflow.slice(warm, at("- name: the app, installed")), /xcrun simctl openurl "\$UDID" "https:\/\/127\.0\.0\.1:\$FRONT_PORT\//, "a request from inside the simulator to the https front");
  // Waits for one more finished handshake than before Safari's request: the
  // run's own check from the Mac already finished one (#858's review).
  const step = workflow.slice(warm, at("- name: the app, installed"));
  const counted = step.indexOf(`done_before="$(grep -c 'TLS done' "$OUT/server/front.log" || true)"`);
  const asked = step.indexOf("xcrun simctl openurl");
  assert(counted >= 0 && counted < asked, "the handshakes counted just before Safari's request");
  assert(step.includes(`until [ "$(grep -c 'TLS done' "$OUT/server/front.log" || true)" -gt "$done_before" ]; do`), "waits until there's one more than that");
});

// Photos' "What's New" sheet comes up in its own time, past 30 seconds once,
// over the photo (#861). The share flow closes it before each tap in Photos:
// inside the loop that opens the photo, and before Share. Each place it's
// looked for presses Continue until it's gone: a look that closes nothing
// doesn't count.
test("the share flow closes Photos' What's New sheet before opening the photo and before Share", () => {
  const flow = readFileSync(join(DIR, "share-photo.yaml"), "utf8");
  const closes = [...flow.matchAll(/^( *)- runFlow:\n\1 {4}when:\n\1 {6}visible: "What\.s New in Photos"\n/gm)]
    .filter((match) => {
      // The block: every line after the condition indented past "- runFlow:".
      const rest = flow.slice(match.index + match[0].length).split("\n");
      const end = rest.findIndex((line) => line.trim() !== "" && line.search(/\S/) <= match[1].length);
      const block = rest.slice(0, end < 0 ? rest.length : end).join("\n");
      return /- repeat:\n\s+while:\n\s+visible: "Continue"\n(?:\s+.*\n)*?\s+- tapOn:\n\s+text: "Continue"/.test(block);
    })
    .map((match) => match.index);
  const opening = flow.indexOf("while:\n      notVisible: \"Share\"");
  const share = flow.indexOf('text: "Share"', flow.indexOf("12-the-photo"));
  assert(opening >= 0 && share >= 0, "the photo-opening loop and the Share tap");
  assert(closes.some((at) => at > opening && at < flow.indexOf('tapOn:\n          text: "Photo, ', opening)), "inside the loop, before tapping the photo");
  assert(closes.some((at) => at > flow.indexOf("12-the-photo") && at < share), "before Share");
});

// Until Photos has drawn its first screen, iOS still counts Linger as the
// app in front, and Maestro reads Linger's screen. On a slow GitHub Mac,
// Photos drew 54 seconds after it started, past the flow's first wait of 45
// (#869). That wait is for Photos itself and ends once it shows, so it has
// room past the slowest seen.
test("the share flow's first wait for Photos outlasts its slowest start", () => {
  const flow = readFileSync(join(DIR, "share-photo.yaml"), "utf8");
  const commands = flow.split(/^---$/m)[1].split(/^- /m).slice(1).map((command) => command.replace(/^\s*#.*\n/gm, "").trimEnd());
  assert.match(commands[0], /^launchApp:\n {4}appId: com\.apple\.mobileslideshow$/, "the flow starts by opening Photos");
  const wait = /^extendedWaitUntil:\n {4}visible: "\(What\.s New in Photos\|Photo, .*"\n {4}timeout: (\d+)$/.exec(commands[1]);
  assert(wait, "then waits for its sheet or its photos");
  assert(Number(wait[1]) >= 90_000, `for at least 90 seconds, not ${wait[1]} ms`);
});

// A tap on Share once left the share sheet unopened, and the flow's way to
// Linger when it's not among the first apps, More, took Photos' own More
// (#866). Share is tapped until the sheet's title shows, and the flow goes
// on only once it has.
test("the share flow taps Share until the share sheet is open, and looks for More only in it", () => {
  const flow = readFileSync(join(DIR, "share-photo.yaml"), "utf8");
  const commands = flow.split(/^---$/m)[1].split(/^- /m).slice(1).map((command) => command.replace(/^\s*#.*\n/gm, "").trimEnd());
  const loop = commands.findIndex((command) => /^repeat:\n    while:\n      notVisible: "1 Photo Selected"\n/.test(command));
  assert(loop >= 0, "a loop that runs while the sheet isn't open");
  assert.match(commands[loop], /\n    times: [2-5]\n/, "a few times, not forever");
  assert.match(commands[loop], /\n    commands:\n      - tapOn:\n          text: "Share"\n          optional: true\n      - extendedWaitUntil:\n          visible: "1 Photo Selected"\n          timeout: \d+\n          optional: true$/, "each time, Share tapped, then a wait for the sheet");
  assert.match(commands[loop + 1], /^extendedWaitUntil:\n    visible: "1 Photo Selected"\n    timeout: \d+$/, "then the sheet waited for, failing if it never opened");
  const more = commands.findIndex((command) => /tapOn: "More"/.test(command));
  assert(more > loop + 1, "More looked for only after the sheet is open");
  assert.equal(commands.filter((command) => /text: "Share"|tapOn: "Share"/.test(command)).length, 1, "Share tapped only in the loop");
});

// Maestro's runner dies on any failure XCUITest records inside it, failing
// the flows whatever the app did (#857). A failed run says whether that's
// what happened, and which app was in front; this keeps the step there.
test("a failed run says whether Maestro's driver died, after the flows", () => {
  const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/ios-simulator.yml", import.meta.url)), "utf8");
  const step = workflow.indexOf("- name: whether Maestro's driver died");
  assert(step > workflow.indexOf("maestro test"), "after the flows");
  const body = workflow.slice(step, workflow.indexOf("\n      - name:", step + 1));
  assert.match(body, /\n {8}if: failure\(\)\n/, "only when the run failed");
  assert.match(body, /run: node scripts\/maestro-driver\.mjs "\$OUT\/maestro" "\$OUT\/app\.log"/, "reading Maestro's output, and the app's log for its share window");
});

// trustd's update of Apple's revocation list held its database locked for
// minutes, and the app's first request gave up waiting for its certificate
// check (#848). The run turns the update off right after boot, before
// anything checks a certificate, and restarts trustd to read it.
test("the simulator's certificate service has its revocation list update off, before anything checks a certificate", () => {
  const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/ios-simulator.yml", import.meta.url)), "utf8");
  const off = workflow.indexOf("defaults write com.apple.security ValidUpdateEnabled -bool NO");
  const restart = workflow.indexOf("launchctl kill TERM system/com.apple.trustd");
  assert(off > workflow.indexOf("simctl bootstatus"), "after the phone has booted");
  assert(off < restart, "then trustd restarted, to read it");
  assert(restart < workflow.indexOf("add-root-cert") && restart < workflow.indexOf("simctl openurl"), "before the test authority, the warm-up and the flows");
  // Its log starts before the restart, so it has "skipping update", and
  // runs past the warm-up, so a stall there has its lines too.
  const predicate = workflow.indexOf(`predicate='process == "trustd" OR process == "nsurlsessiond"'`);
  const kept = workflow.indexOf('xcrun simctl spawn "$UDID" log show --style compact --predicate "$predicate" > "$OUT/trustd.log"');
  const log = workflow.search(/nohup xcrun simctl spawn "\$UDID" log stream [^\n]*\\\n\s+--predicate "\$predicate" >> "\$OUT\/trustd\.log" 2>&1 &/);
  assert(predicate > workflow.indexOf("simctl bootstatus") && kept > predicate, "trustd's and nsurlsessiond's lines since boot first, since the phone booted during the builds");
  assert(log > kept && log < off, "then trustd's log kept, added to them, from before the setting and the restart");
});

// The setting comes too late for trustd's first start, which has already
// scheduled a download of the whole list; applied when it landed, it held
// the database again (#848, run 41802536391). The list's server is made
// unreachable before the simulator boots, for both kinds of address.
test("Apple's revocation list server is unreachable before the simulator boots", () => {
  const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/ios-simulator.yml", import.meta.url)), "utf8");
  const blocked = workflow.indexOf("printf '127.0.0.1 valid.apple.com\\n::1 valid.apple.com\\n' | sudo tee -a /etc/hosts");
  const boot = workflow.indexOf('xcrun simctl boot "$udid"');
  assert(blocked >= 0, "valid.apple.com, by IPv4 and IPv6, in the Mac's hosts file");
  assert(boot > blocked, "before the simulator boots");
  const between = workflow.slice(blocked, boot);
  assert.match(between, /sudo dscacheutil -flushcache\n/, "with the Mac's name cache flushed");
  assert.match(between, /sudo killall -HUP mDNSResponder/, "and its resolver told to read the file again");
});


// On GitHub's Xcode 27 Mac, the newest iOS (27.1) had only the iPhone Duo,
// without Photos, and the share flow failed to open Photos there (#839). The
// workflow's pick, run here on made-up device lists: the plain iPhone, the
// model share-photo.yaml's taps were measured on, on the newest iOS that has
// one.
test("the simulator picks the plain iPhone on the newest iOS that has one, not a newer iOS without one", () => {
  const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/ios-simulator.yml", import.meta.url)), "utf8");
  const script = /read -r udid runtime name < <\(node -e '\n([\s\S]*?)\n\s*' "\$RUNNER_TEMP\/devices\.json"\)/.exec(workflow)?.[1];
  assert(script, "the workflow's pick, a node script over devices.json");
  const dir = mkdtempSync(join(tmpdir(), "ios-pick-"));
  const pick = (devices) => {
    const file = join(dir, "devices.json");
    writeFileSync(file, JSON.stringify({ devices }));
    return spawnSync(process.execPath, ["-e", script, file], { encoding: "utf8" });
  };
  const runtime = (version) => `com.apple.CoreSimulator.SimRuntime.iOS-${version}`;
  const phones = (...names) => names.map((name) => ({ name, udid: `${name}-udid` }));
  try {
    const xcode27 = {
      [runtime("27-0")]: phones("iPhone 17", "iPhone 17e", "iPhone 18 Pro", "iPhone Air", "iPad (A16)"),
      [runtime("27-1")]: phones("iPhone Duo"),
      "com.apple.CoreSimulator.SimRuntime.watchOS-27-0": phones("Apple Watch SE 3 (40mm)"),
    };
    assert.equal(pick(xcode27).stdout.trim(), `iPhone 17-udid ${runtime("27-0")} iPhone 17`, "iOS 27.0's iPhone 17, not iOS 27.1's iPhone Duo");
    const later = { ...xcode27, [runtime("27-2")]: phones("iPhone 18 Pro", "iPhone 17", "iPhone Duo") };
    assert.equal(pick(later).stdout.trim(), `iPhone 17-udid ${runtime("27-2")} iPhone 17`, "the newest iOS with a plain iPhone");
    const tens = { [runtime("26-9")]: phones("iPhone 17"), [runtime("26-10")]: phones("iPhone 17") };
    assert.match(pick(tens).stdout, /iOS-26-10 /, "versions compared as numbers, 26.10 after 26.9");
    const none = pick({ [runtime("27-1")]: phones("iPhone Duo", "iPhone 18 Pro") });
    assert.notEqual(none.status, 0, "no plain iPhone anywhere fails");
    assert.match(none.stderr, /no plain iPhone/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The share flow starts in Photos. A phone without it fails when it boots,
// saying so, not minutes later in the last flow (#839).
test("the simulator stops before the flows when Photos, which the share flow opens, isn't on the iPhone", () => {
  const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/ios-simulator.yml", import.meta.url)), "utf8");
  const flow = readFileSync(join(DIR, "share-photo.yaml"), "utf8");
  const photos = /^- launchApp:\n {4}appId: ([\w.]+)$/m.exec(flow.split(/^---$/m)[1])?.[1];
  assert.equal(photos, "com.apple.mobileslideshow", "the share flow opens Photos");
  const check = workflow.indexOf(`grep -qx ${photos} "$OUT/apps.txt"`);
  assert(check >= 0, "the workflow looks for Photos among the iPhone's apps");
  assert(workflow.indexOf('xcrun simctl listapps "$UDID"') < check, "in the list of what's installed");
  assert(workflow.indexOf("simctl bootstatus") < check && check < workflow.indexOf("maestro test"), "once booted, before the flows");
});

// The TestFlight build, the simulator's flows and the share window's builds
// use one Xcode (#779, #839): a check that passes on another Xcode says
// nothing about the build testers get. Bumped in one place, this fails until
// it's bumped in all of them.
test("every iPhone build uses the same Xcode, on the image that has it", () => {
  const read = (name) => readFileSync(fileURLToPath(new URL(`../.github/workflows/${name}`, import.meta.url)), "utf8");
  const chosen = {};
  for (const name of ["ios.yml", "ios-simulator.yml"]) {
    const workflow = read(name);
    const input = /\n {6}xcode:\n(?: {8}.*\n)*? {8}default: "([\d.]+)"\n/.exec(workflow)?.[1];
    assert(input, `${name} takes the Xcode by hand, with a default`);
    // Where no input reaches (a pull request, the nightly run), the same one.
    const fallbacks = [...workflow.matchAll(/inputs\.xcode \|\| '([\d.]+)'/g)].map((match) => match[1]);
    assert(fallbacks.length >= 3, `${name} falls back to its default for the image, the cache and the Xcode`);
    assert.deepEqual([...new Set(fallbacks)], [input], `${name}'s fallbacks are its default`);
    assert.match(workflow, /runs-on: \$\{\{ startsWith\(inputs\.xcode \|\| '[\d.]+', '26'\) && 'macos-26' \|\| 'xcode-27' \}\}/, `${name} runs Xcode 27 on the xcode-27 image`);
    assert.match(workflow, /sudo xcode-select -s "\/Applications\/Xcode_\$XCODE\.app"/, `${name} selects the chosen Xcode`);
    chosen[name] = input;
  }
  const share = read("share-window.yml");
  const selected = [...share.matchAll(/sudo xcode-select -s \/Applications\/Xcode_([\d.]+)\.app/g)].map((match) => match[1]);
  const macs = [...share.matchAll(/runs-on: (\S+)/g)].map((match) => match[1]).filter((image) => image !== "ubuntu-latest");
  assert.equal(selected.length, macs.length, "each of share-window.yml's Mac jobs selects its Xcode");
  assert(macs.every((image) => image === "xcode-27"), "on the xcode-27 image");
  chosen["share-window.yml"] = [...new Set(selected)].join(", ");
  assert.equal(new Set(Object.values(chosen)).size, 1, `one Xcode for every iPhone build: ${JSON.stringify(chosen)}`);
});

// The share window's first start took 42 seconds to be in place on iOS 27.0
// against 7 on iOS 26.5, and the 6 seconds the flow gave it let every tap
// land on the empty sheet (#839, run 41857567919). Maestro can't see inside
// the window, so the flow asks scripts/share-window-ready.mjs, which reads
// iOS's log. Real lines from both runs.
const SET_27 = "2026-11-04 16:06:42.704 Df LingerShare[65788:2bc51] [com.apple.UIKit:ViewServices] <_UIViewServiceRootViewController: 0x106134400>: Set materialized view controller: <ShareViewController: 0x106134000>";
const INSTALLED_27 = "2026-11-04 16:06:43.108 Df LingerShare[65788:2bc51] [com.apple.UIKit:ViewServices] <_UIViewServiceRootViewController: 0x106134400>: Installed materialized view controller in hierarchy: <ShareViewController: 0x106134000>";
const INSTALLED_26 = "2026-11-04 09:47:22.011 Df LingerShare[50355:21e35] [com.apple.UIKit:ViewServices] <_UIViewServiceRootViewController: 0x103528c00>: Installed materialized view controller in hierarchy: <ShareViewController: 0x103528800>";

test("the share window counts as up once iOS logs it in place, from its own process", async () => {
  const { windowUp } = await import("./share-window-ready.mjs");
  assert.equal(windowUp(""), false, "nothing logged yet");
  assert.equal(windowUp(SET_27), false, "set, not yet in the hierarchy");
  assert.equal(windowUp(`${SET_27}\n${INSTALLED_27}\n`), true, "iOS 27.0's line");
  assert.equal(windowUp(INSTALLED_26), true, "iOS 26.5's line, the same");
  assert.equal(windowUp(INSTALLED_27.replace("LingerShare[65788:2bc51]", "MobileSlideshow[63074:2bc51]")), false, "only from the share window's own process");
  assert.equal(windowUp(INSTALLED_27.replace("<ShareViewController", "<SomeOtherController")), false, "only for Linger's window");
});

test("share-window-ready answers over http, from the log as it is at each question, and fails when it can't read it", async () => {
  const { server } = await import("./share-window-ready.mjs");
  const dir = mkdtempSync(join(tmpdir(), "share-window-ready-"));
  const log = join(dir, "app.log");
  const running = server(log);
  await new Promise((done) => running.listen(0, "127.0.0.1", done));
  const ask = async () => {
    const answer = await fetch(`http://127.0.0.1:${running.address().port}/`);
    return [answer.status, await answer.text()];
  };
  try {
    const [status, body] = await ask();
    assert.equal(status, 500, "no log to read is an error, not a no");
    assert.match(body, /can't read/);
    writeFileSync(log, `${SET_27}\n`);
    assert.deepEqual(await ask(), [200, "not yet"]);
    writeFileSync(log, `${SET_27}\n${INSTALLED_27}\n`);
    assert.deepEqual(await ask(), [200, "up"], "read afresh: the line written since is seen");
  } finally {
    await new Promise((done) => running.close(done));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the share flow waits for the share window before its first tap inside it, and fails if it never comes", () => {
  const flow = readFileSync(join(DIR, "share-photo.yaml"), "utf8");
  const commands = flow.split(/^---$/m)[1].split(/^- /m).slice(1).map((command) => command.replace(/^\s*#.*\n/gm, "").trimEnd());
  const linger = commands.findIndex((command) => command === 'tapOn: "Linger"');
  const firstPoint = commands.findIndex((command) => /^tapOn:\n {4}point: /.test(command));
  assert(linger >= 0 && firstPoint > linger, "Linger tapped in the share sheet, then taps by position");
  const between = commands.slice(linger + 1, firstPoint);
  const asked = between.findIndex((command) => command === "runScript:\n    file: window-up.js");
  const loop = between.findIndex((command) => /^repeat:\n {4}while:\n {6}true: \$\{!output\.windowUp\}\n {4}times: (\d+)\n/.test(command));
  const sure = between.findIndex((command) => command === "assertTrue: ${output.windowUp}");
  assert(asked >= 0 && loop > asked && sure > loop, "asked once, then again while it isn't up, then it must be");
  const times = Number(/times: (\d+)/.exec(between[loop])[1]);
  const pause = Number(/timeout: (\d+)/.exec(between[loop])?.[1]);
  assert.match(between[loop], /runScript:\n {10}file: window-up\.js/, "each time round, it asks again");
  assert(times * pause >= 90_000 && times * pause <= 300_000, `up to 1.5 to 5 minutes, not ${times * pause} ms`);
  const script = readFileSync(join(DIR, "window-up.js"), "utf8");
  assert.match(script, /http\.get\(WINDOW_READY\)/, "window-up.js asks share-window-ready");
  assert.match(script, /answer\.status !== 200\) throw/, "and fails on anything but an answer");
});

test("the workflow starts share-window-ready on the flows' app.log before the flows, and tells them where", () => {
  const workflow = readFileSync(fileURLToPath(new URL("../.github/workflows/ios-simulator.yml", import.meta.url)), "utf8");
  const config = readFileSync(join(DIR, "config.yaml"), "utf8");
  const log = workflow.indexOf('--predicate \'process == "Linger" OR process == "LingerShare"');
  const ready = workflow.indexOf('node scripts/share-window-ready.mjs "$OUT/app.log" "$READY_PORT"');
  const listening = workflow.indexOf("until grep -q '^listening' \"$OUT/share-window-ready.log\"");
  const flows = workflow.indexOf("maestro test");
  assert(log >= 0 && ready > log, "on the log the share window's lines go to, once it's being kept");
  assert(listening > ready && flows > listening, "ready for questions before the flows start");
  assert.match(workflow.slice(flows, workflow.indexOf("client/tests/ios\n", flows)), /-e "WINDOW_READY=http:\/\/127\.0\.0\.1:\$READY_PORT\/"/, "its address passed to the flows");
  assert.match(workflow, /\n {6}READY_PORT: \d+\n/, "on a port of its own");
  assert.match(config, /^# {3}WINDOW_READY /m, "config.yaml lists it with what the flows need");
});
