import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { allowsData, blockedDataUrls, directiveFor, parseCsp } from "./csp-assets.mjs";

const shipped = JSON.parse(readFileSync(new URL("../client/src-tauri/tauri.conf.json", import.meta.url), "utf8"))
  .app.security.csp;

test("an embedded font is refused by the shipped policy (#318)", () => {
  const css = "@font-face{font-family:Silkscreen;src:url(data:font/woff2;base64,d09GMgABAAAA)}";
  assert.deepEqual(blockedDataUrls(shipped, [{ name: "assets/next.css", text: css }]), [
    { file: "assets/next.css", mime: "font/woff2", count: 1 },
  ]);
});

test("an embedded sound is refused by the shipped policy", () => {
  const js = 'const chime = "data:audio/wav;base64,UklGRg"; const tap = "data:audio/ogg;base64,T2dn"';
  assert.deepEqual(blockedDataUrls(shipped, [{ name: "assets/next.js", text: js }]), [
    { file: "assets/next.js", mime: "audio/wav", count: 1 },
    { file: "assets/next.js", mime: "audio/ogg", count: 1 },
  ]);
});

test("an embedded image is allowed, because img-src lists data:", () => {
  const css = ".mark{background:url(data:image/svg+xml;base64,PHN2Zz4)}";
  assert.deepEqual(blockedDataUrls(shipped, [{ name: "a.css", text: css }]), []);
});

test("a build with nothing embedded passes", () => {
  const css = '@font-face{font-family:Silkscreen;src:url("/assets/silkscreen-0-abc.woff2")}';
  assert.deepEqual(blockedDataUrls(shipped, [{ name: "a.css", text: css }]), []);
});

test("each embedded font is counted, per file", () => {
  const css = "src:url(data:font/woff2;base64,AA)} src:url(data:font/woff2;base64,BB)}";
  assert.deepEqual(blockedDataUrls(shipped, [{ name: "a.css", text: css }]), [
    { file: "a.css", mime: "font/woff2", count: 2 },
  ]);
});

test("a type's own directive decides, then default-src", () => {
  const withFonts = parseCsp("default-src 'self'; font-src 'self' data:");
  assert.equal(allowsData(withFonts, "font/woff2"), true);
  assert.equal(allowsData(withFonts, "audio/wav"), false, "no media-src: default-src decides");
  assert.equal(allowsData(parseCsp("img-src data:"), "font/woff"), true, "nothing restricts fonts");
});

test("types no directive here covers are left alone", () => {
  assert.equal(directiveFor("text/plain"), null);
  assert.equal(directiveFor("application/json"), null);
  assert.equal(directiveFor("application/font-woff"), "font-src");
  assert.equal(directiveFor("video/mp4"), "media-src");
});

test("the first of a repeated directive wins, as in a browser", () => {
  const directives = parseCsp("font-src 'self'; font-src data:");
  assert.equal(allowsData(directives, "font/woff2"), false);
});
