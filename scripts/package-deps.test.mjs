// What the Linux packages ask the system for, read straight from their
// definitions, so a missing media plugin fails on the machine that removed it
// rather than as a silent video on somebody else's (#358). The built .deb and
// .rpm are checked again in CI's package check (scripts/package-audio-deps.py).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const linux = JSON.parse(readFileSync(new URL("../client/src-tauri/tauri.conf.json", import.meta.url), "utf8")).bundle.linux;
const pkgbuild = readFileSync(new URL("../packaging/arch/PKGBUILD", import.meta.url), "utf8");

/** The names in the PKGBUILD's `depends=( … )`, comments left out. */
function archDepends(text) {
  const block = /^depends=\(([\s\S]*?)^\)/m.exec(text);
  assert.ok(block, "the PKGBUILD has no depends=( … )");
  return block[1]
    .split("\n")
    .map((line) => line.replace(/#.*/, "").trim())
    .flatMap((line) => line.split(/\s+/))
    .filter(Boolean)
    .map((name) => name.replace(/^'|'$/g, ""));
}

test("the Arch package asks for the decoders shared videos need: AAC sound and H.264 pictures (#358)", () => {
  const depends = archDepends(pkgbuild);
  for (const name of ["gst-plugins-base", "gst-plugins-good", "gst-libav"]) assert.ok(depends.includes(name), `PKGBUILD depends lacks ${name}`);
});

test("the .deb asks for them too", () => {
  for (const name of ["gstreamer1.0-plugins-base", "gstreamer1.0-plugins-good", "gstreamer1.0-libav"]) {
    assert.ok(linux.deb.depends.includes(name), `deb depends lacks ${name}`);
  }
});

test("the .rpm recommends them, rather than requiring a name other RPM distributions don't have", () => {
  assert.ok(linux.rpm.recommends.includes("gstreamer1-plugin-libav"), "rpm recommends lacks gstreamer1-plugin-libav");
  assert.ok(!linux.rpm.depends.some((name) => /libav/.test(name)), "rpm requires libav outright");
});
