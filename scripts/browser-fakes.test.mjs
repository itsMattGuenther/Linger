// A browser method a test fakes is faked on its prototype (#843).
//
// `navigator.mediaDevices` is a wrapper WebKit may collect while the page
// runs, and make afresh the next time it's read; a property added to the old
// one goes with it. The screen fixture's fake picker was one, and on a busy
// machine the browser's real picker answered instead, refusing as a headless
// browser does: a test of a failed picker read nothing said, 16 times in 16.
// Faked on `MediaDevices.prototype`, it can't be lost.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TESTS = join(ROOT, "client/tests");

/**
 * The line each way of putting a property on the wrapper itself, rather than
 * its prototype, starts on. Read across lines, since a formatter splits a
 * call or an assignment (#859's review). An alias
 * (`const devices = navigator.mediaDevices`) it can't follow.
 */
export function onTheWrapper(text) {
  const patterns = [
    /navigator\s*\.\s*mediaDevices\s*\.\s*\w+\s*=(?![=>])/g,
    /navigator\s*\.\s*mediaDevices\s*\[[^\]]+\]\s*=(?![=>])/g,
    /Object\s*\.\s*(defineProperty|defineProperties|assign)\s*\(\s*navigator\s*\.\s*mediaDevices\b/g,
  ];
  const lines = new Set();
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) lines.add(text.slice(0, match.index).split("\n").length);
  }
  return [...lines].sort((a, b) => a - b);
}

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx|js|mjs)$/.test(name) ? [path] : [];
  });
}

test("no test fakes a media method on navigator.mediaDevices itself", () => {
  const offenders = files(TESTS).flatMap((path) => onTheWrapper(readFileSync(path, "utf8")).map((line) => `${relative(ROOT, path)}:${line}`));
  assert.deepEqual(offenders, [], "fake it on MediaDevices.prototype instead (#843)");
});

test("each way of putting it on the wrapper is found, and the prototype isn't", () => {
  for (const line of [
    "navigator.mediaDevices.getUserMedia = () => null;",
    "navigator . mediaDevices . getDisplayMedia= async () => x;",
    'navigator.mediaDevices["getUserMedia"] = fake;',
    'Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { value });',
    "Object.assign(navigator.mediaDevices, { getUserMedia });",
    "Object.defineProperties(navigator.mediaDevices, {});",
    // Split by a formatter, across lines: found where it starts.
    'Object.defineProperty(\n  navigator.mediaDevices,\n  "getDisplayMedia",\n  { value: fake },\n);',
    "navigator.mediaDevices\n  .getUserMedia = () => null;",
    "navigator\n  .mediaDevices\n  .getUserMedia\n  = fake;",
    "Object.assign(\n  navigator.mediaDevices,\n  { getUserMedia },\n);",
  ]) assert.deepEqual(onTheWrapper(line), [1], JSON.stringify(line));
  assert.deepEqual(onTheWrapper('const a = 1;\n\nObject.defineProperty(\n  navigator.mediaDevices,\n  "x",\n  {},\n);'), [3], "the line it starts on");
  for (const line of [
    'Object.defineProperty(MediaDevices.prototype, "getDisplayMedia", { value });',
    "if (navigator.mediaDevices.getUserMedia === undefined) return;",
    "const stream = await navigator.mediaDevices.getUserMedia({ audio: true });",
    "if (!navigator.mediaDevices) return;",
    "const same = navigator.mediaDevices.getUserMedia == other;",
    "Object.defineProperty(\n  MediaDevices.prototype,\n  \"getUserMedia\",\n  { value },\n);",
  ]) assert.deepEqual(onTheWrapper(line), [], JSON.stringify(line));
});
