// CI runs the browser tests in Playwright's own image (ci.yml, nightly.yml),
// whose browsers are built for one Playwright version. Bump @playwright/test
// without the image and the tests look for browsers the image hasn't got, and
// every browser job fails before a test runs. `scripts/webkit.sh` works the
// image out from the client's version, so it can't drift; the workflows name
// it, so this holds them to it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const client = JSON.parse(readFileSync(new URL("client/package.json", root), "utf8"));
const playwright = client.devDependencies["@playwright/test"];

const workflows = readdirSync(new URL(".github/workflows/", root))
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, text: readFileSync(new URL(`.github/workflows/${name}`, root), "utf8") }));
const images = workflows.flatMap(({ name, text }) =>
  [...text.matchAll(/mcr\.microsoft\.com\/playwright:v([^\s-]+)-/g)].map((m) => ({ name, version: m[1] })),
);

test("the client pins one exact Playwright version", () => {
  assert.match(playwright, /^\d+\.\d+\.\d+$/, `@playwright/test is "${playwright}", not an exact version`);
});

test("the browser jobs run in Playwright's image", () => {
  const names = new Set(images.map((i) => i.name));
  assert.ok(names.has("ci.yml"), "ci.yml names no Playwright image");
  assert.ok(names.has("nightly.yml"), "nightly.yml names no Playwright image");
});

test("a job in Playwright's image runs its steps with bash", () => {
  // In a container, GitHub runs a step with sh unless the job says otherwise,
  // and the browser jobs' steps are bash: under sh, picking the tests to
  // repeat failed with "mapfile: not found" and its (( )) limits never ran.
  for (const { name, text } of workflows) {
    for (const job of text.split(/\n(?=  [\w-]+:\n)/)) {
      if (!job.includes("mcr.microsoft.com/playwright:")) continue;
      const id = job.trim().split(":")[0];
      assert.match(job, /\n {8}shell: bash\n/, `${name}'s ${id} runs in Playwright's image without shell: bash`);
    }
  }
});

test("every Playwright image is the client's Playwright version", () => {
  for (const { name, version } of images) {
    assert.equal(version, playwright, `${name} runs the v${version} image, and the client has Playwright ${playwright}`);
  }
});

test("the local gate's containers never join Docker's own network", () => {
  // A container on Docker's network adds a network interface to the machine
  // while it runs, and Chromium drops every page load in flight when one comes
  // or goes (net::ERR_NETWORK_CHANGED). check.sh's actionlint ran that way, so
  // each check.sh that started blanked pages in the others' browser tests
  // (#528). The containers check.sh and webkit.sh start have no network or
  // share the machine's.
  for (const script of ["scripts/check.sh", "scripts/webkit.sh"]) {
    const text = readFileSync(new URL(script, root), "utf8").replace(/\\\n\s*/g, " ");
    const runs = text.split("\n").filter((line) => /^\s*docker run\b/.test(line));
    assert.ok(runs.length > 0, `${script} starts no container any more; drop it from this test`);
    for (const run of runs) {
      assert.match(run, /--network (none|host)\b/, `${script} starts a container on Docker's network: ${run.trim()}`);
    }
  }
});
