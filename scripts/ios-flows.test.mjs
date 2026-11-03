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

/** The names under executionOrder.flowsOrder, failing on anything else in the list. */
export function flowsOrder(text) {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^ {2}flowsOrder:\s*$/.test(line));
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

test("the order is read strictly", () => {
  assert.deepEqual(flowsOrder("executionOrder:\n  flowsOrder:\n    - a\n    # a note\n    - b-c\n\nother: 1\n"), ["a", "b-c"]);
  assert.throws(() => flowsOrder("executionOrder:\n  flowsOrder:\n    - a\n      - nested\n"), /can't read/);
  assert.throws(() => flowsOrder("executionOrder:\n  continueOnFailure: false\n"), /no executionOrder\.flowsOrder/);
});
