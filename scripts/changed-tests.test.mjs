import assert from "node:assert/strict";
import { test } from "node:test";
import { selectTests, touchedLines } from "./changed-tests.mjs";

const lines = (diff) => Object.fromEntries([...touchedLines(diff)].map(([file, set]) => [file, [...set].sort((a, b) => a - b)]));

test("a spec's added and changed lines are touched; other files aren't", () => {
  assert.deepEqual(lines([
    "diff --git client/tests/browser/a.spec.ts client/tests/browser/a.spec.ts",
    "--- client/tests/browser/a.spec.ts",
    "+++ client/tests/browser/a.spec.ts",
    "@@ -10,2 +10,3 @@ test(\"x\", () => {",
    "@@ -40 +41 @@",
    "+++ client/tests/browser/helpers.ts",
    "@@ -1 +1 @@",
    "+++ client/src/next/app.tsx",
    "@@ -1 +1 @@",
  ].join("\n")), { "client/tests/browser/a.spec.ts": [10, 11, 12, 41] });
});
test("a deletion touches the lines either side of it", () => {
  assert.deepEqual(lines("+++ client/tests/browser/a.spec.ts\n@@ -20,3 +19,0 @@"),
    { "client/tests/browser/a.spec.ts": [19, 20] });
});
test("a deleted spec selects nothing", () => {
  assert.deepEqual(lines("--- client/tests/browser/a.spec.ts\n+++ /dev/null\n@@ -1,9 +0,0 @@"), {});
});
test("a line inside a test selects it and the one after", () => {
  assert.deepEqual(selectTests([10, 30, 50, 70], new Set([35])), [30, 50]);
});
test("the last test selects only itself", () => {
  assert.deepEqual(selectTests([10, 30, 50], new Set([60])), [50]);
});
test("a line above every test (imports, helpers, hooks) selects the whole file", () => {
  assert.deepEqual(selectTests([10, 30, 50], new Set([3, 35])), [10, 30, 50]);
});
test("tests made in a loop share a line and are selected together", () => {
  assert.deepEqual(selectTests([10, 10, 10, 40], new Set([12])), [10, 40]);
});
test("nothing touched, or no tests, selects nothing", () => {
  assert.deepEqual(selectTests([10, 20], new Set()), []);
  assert.deepEqual(selectTests([], new Set([5])), []);
});
