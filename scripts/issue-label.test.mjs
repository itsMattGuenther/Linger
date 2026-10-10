// node --test scripts/issue-label.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { labelFor } from "./issue-label.mjs";

const SKILL_BUG = `## What happened

The 0.4.10 AppImage opens an empty window and never shows the app.

## Expected

The Buddy list.

## Steps to reproduce

1. Run it.

## Where

- Linger: 0.4.10 AppImage`;

test("the skill's marker says which, whatever the body looks like", () => {
  assert.equal(labelFor(`<!-- linger-report: bug -->\nIt broke.`), "bug");
  assert.equal(labelFor(`<!--linger-report:IDEA-->\nA thought.`), "enhancement");
  // The marker wins over a shape that says otherwise.
  assert.equal(labelFor(`<!-- linger-report: idea -->\n## The idea\n\n## What happened\n\n## Expected`), "enhancement");
});

test("a bug drafted with the skill's shape, before the marker, is a bug (#479)", () => {
  assert.equal(labelFor(SKILL_BUG), "bug");
});

test("the bug form's own headings read as a bug", () => {
  assert.equal(labelFor(`### What happened\n\nIt froze.\n\n### What you expected\n\nIt not to.\n\n### Steps to reproduce\n\n1. Open it`), "bug");
});

test("an idea, from the form or drafted the same way, is an enhancement", () => {
  assert.equal(labelFor(`### The idea\n\nPolls.\n\n### What happens today\n\nCounting by hand.`), "enhancement");
  assert.equal(labelFor(`## The idea\n\nA quiet line when somebody joins voice.`), "enhancement");
});

test("anything else is left for a person", () => {
  assert.equal(labelFor("The app is great, thanks!"), null);
  assert.equal(labelFor(""), null);
  assert.equal(labelFor(undefined), null);
  // The words in a sentence aren't headings.
  assert.equal(labelFor("What happened was odd. Steps to reproduce: none."), null);
  // "What happened" alone could be anything.
  assert.equal(labelFor("## What happened\n\nWe talked about it."), null);
});

test("run as the workflow runs it: the label on its own line, or nothing", () => {
  const script = fileURLToPath(new URL("./issue-label.mjs", import.meta.url));
  const run = (body) => execFileSync(process.execPath, [script], { env: { ...process.env, ISSUE_BODY: body } }).toString();
  assert.equal(run(SKILL_BUG), "bug\n");
  assert.equal(run("Just saying hi."), "");
});
