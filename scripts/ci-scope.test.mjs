import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "./ci-scope.mjs";

const active = (paths) => Object.entries(classify(paths)).filter(([, value]) => value).map(([key]) => key);
for (const paths of [["README.md"], ["docs/testing.md", "LICENSE"], ["docs/screenshots/example.png"]])
  test(`documentation only: ${paths}`, () => assert.deepEqual(active(paths), []));
for (const paths of [[], ["unexpected.conf"], ["Cargo.lock"], [".github/workflows/ci.yml"], ["crates/linger-core/src/lib.rs"]])
  test(`conservative fallback: ${paths}`, () => assert.equal(active(paths).length, 6));
test("UI changes test both browser and native packages, not unrelated server jobs", () => {
  assert.deepEqual(active(["client/src/app.css"]), ["web", "packages"]);
});
test("browser assertions alone need no package rebuild", () => {
  assert.deepEqual(active(["client/tests/browser/console.spec.ts"]), ["web"]);
});
test("server changes include real storage tests", () => {
  assert.deepEqual(active(["crates/linger-server/src/storage.rs"]), ["rust", "s3"]);
});
test("desktop changes test the separately built shell and packages", () => {
  assert.deepEqual(active(["client/src-tauri/Cargo.lock"]), ["shell", "packages"]);
});
test("union retains every affected domain, including deletion side of a rename", () => {
  assert.deepEqual(active(["client/src/app.css", "docs/old.css", "deploy/Dockerfile"]),
    ["rust", "s3", "web", "coturn", "packages"]);
});
