// `all green` is the only required check (docs/testing-strategy.md), so a job
// missing from its `needs` is a job nothing enforces. This reads ci.yml
// without a YAML library: job ids are the two-space keys under `jobs:`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const jobsBlock = ci.slice(ci.indexOf("\njobs:\n"));
const jobs = [...jobsBlock.matchAll(/^ {2}([a-z0-9-]+):\s*$/gm)].map((match) => match[1]);
const gate = jobsBlock.slice(jobsBlock.indexOf("\n  all-green:\n"));
const needs = /^ {4}needs: \[([^\]]*)\]/m.exec(gate)?.[1].split(",").map((name) => name.trim());

test("ci.yml has an all-green job that runs whatever happened above it", () => {
  assert.ok(jobs.includes("all-green"));
  assert.match(gate, /^ {4}if: always\(\)$/m);
  assert.ok(needs?.length, "all-green lists its needs on one line: needs: [a, b]");
});
test("every other job is in all-green's needs, and nothing else is", () => {
  assert.deepEqual([...needs].sort(), jobs.filter((job) => job !== "all-green").sort());
});
