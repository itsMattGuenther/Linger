// The iPhone simulator's flows (client/tests/ios, run by ios-simulator.yml on
// a Mac), checked here where they can't run: every flow is in config.yaml's
// order and every name in the order is a flow, so a new one can't be left
// out or run out of turn, and each names the app it drives. A mistake here
// otherwise shows only after a 30-minute run on GitHub's Mac (#835). And
// docs/development.md's numbered list of them, a second copy of the order,
// says the same.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
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
  const log = workflow.search(/nohup xcrun simctl spawn "\$UDID" log stream [^\n]*\\\n\s+--predicate 'process == "trustd" OR process == "nsurlsessiond"' > "\$OUT\/trustd\.log" 2>&1 &/);
  assert(log > workflow.indexOf("simctl bootstatus") && log < off, "trustd's log kept from before the setting and the restart");
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

