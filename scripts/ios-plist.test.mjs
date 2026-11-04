// The iPhone app's own additions to its Info.plist (client/src-tauri/Info.ios.plist),
// checked here, since the app only runs on a Mac. `tauri ios build` merges
// that file into every build, so what Linger needs from the Info.plist is
// written there, not left to a build script. The deep-link plugin writes the
// `linger://` scheme into gen/apple's Info.plist only when its build script
// runs, which a cached build skips: CI's simulator build, restored from the
// cache, came out with no scheme, and iOS refused the link
// (LSApplicationWorkspaceErrorDomain 115, #835).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const text = (raw) => raw.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITIES[name]);

/**
 * An XML property list as plain values: dict, array, string, integer, true
 * and false, the kinds Linger's plists hold. Anything else fails, naming it,
 * rather than being read as nothing.
 */
export function parsePlist(xml) {
  const body = xml.replace(/<!--[\s\S]*?-->/g, "").replace(/<\?xml[^>]*\?>/, "").replace(/<!DOCTYPE[^>]*>/, "");
  const tokens = (body.match(/<[^>]+>|[^<]+/g) ?? []).map((token) => token.trim()).filter(Boolean);
  let at = 0;
  const take = () => {
    if (at >= tokens.length) throw new Error("the property list ends too soon");
    return tokens[at++];
  };
  const expect = (tag) => {
    const found = take();
    if (found !== tag) throw new Error(`expected ${tag}, found ${found}`);
  };
  const words = (close) => {
    if (tokens[at] === close) { at++; return ""; }
    const found = take();
    if (found.startsWith("<")) throw new Error(`expected words before ${close}, found ${found}`);
    expect(close);
    return text(found);
  };
  const value = () => {
    const tag = take();
    if (tag === "<dict/>") return {};
    if (tag === "<array/>") return [];
    if (tag === "<true/>") return true;
    if (tag === "<false/>") return false;
    if (tag === "<string>") return words("</string>");
    if (tag === "<integer>") {
      const number = Number(words("</integer>"));
      if (!Number.isInteger(number)) throw new Error("an <integer> that isn't one");
      return number;
    }
    if (tag === "<array>") {
      const list = [];
      while (tokens[at] !== "</array>") list.push(value());
      at++;
      return list;
    }
    if (tag === "<dict>") {
      const dict = {};
      while (tokens[at] !== "</dict>") {
        expect("<key>");
        const key = words("</key>");
        if (!key || key in dict) throw new Error(`a key that's empty or there twice: ${JSON.stringify(key)}`);
        dict[key] = value();
      }
      at++;
      return dict;
    }
    throw new Error(`can't read ${tag}`);
  };
  expect('<plist version="1.0">');
  const root = value();
  expect("</plist>");
  if (at !== tokens.length) throw new Error(`something after </plist>: ${tokens[at]}`);
  return root;
}

/** The URL schemes a property list's CFBundleURLTypes declares. */
export const urlSchemes = (plist) =>
  (plist.CFBundleURLTypes ?? []).flatMap((type) => {
    assert(Array.isArray(type.CFBundleURLSchemes), "each CFBundleURLTypes entry has a CFBundleURLSchemes list");
    return type.CFBundleURLSchemes;
  });

test("Info.ios.plist declares every scheme the deep-link plugin opens on a phone", () => {
  const config = JSON.parse(read("client/src-tauri/tauri.conf.json"));
  const wanted = (config.plugins?.["deep-link"]?.mobile ?? [])
    .filter((entry) => !entry.appLink)
    .flatMap((entry) => entry.scheme)
    .filter((scheme) => scheme !== "http" && scheme !== "https");
  assert.deepEqual(wanted, ["linger"], "tauri.conf.json's phone schemes, as this test knows them");
  const declared = urlSchemes(parsePlist(read("client/src-tauri/Info.ios.plist")));
  assert.deepEqual(wanted.filter((scheme) => !declared.includes(scheme)), [], "schemes missing from Info.ios.plist's CFBundleURLTypes");
});

// In voice with the phone locked (#851): WebKit mutes a hidden page's
// microphone unless the app declares background audio, and voice runs in
// the page on a phone. Only audio: voip asks iOS, and App Review, for
// waking on an incoming call, which needs push (SPEC §4.15 has none).
test("Info.ios.plist keeps voice going in the background with audio, and asks for nothing more", () => {
  assert.deepEqual(parsePlist(read("client/src-tauri/Info.ios.plist")).UIBackgroundModes, ["audio"]);
  // gen/apple's own Info.plist declares none, so the merged one says only this.
  assert.equal(parsePlist(read("client/src-tauri/gen/apple/linger-client_iOS/Info.plist")).UIBackgroundModes, undefined);
});

test("a property list is read in each form Linger's take, and anything else fails", () => {
  const plist = (inner) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${inner}
</plist>`;
  assert.deepEqual(parsePlist(plist(`<dict>
  <!-- a note -->
  <key>A</key><string>a &amp; b</string>
  <key>B</key><false/>
  <key>C</key><array><string>x</string><string></string></array>
  <key>D</key><dict/>
  <key>E</key><integer>15</integer>
  <key>F</key><array/>
  <key>G</key><true/>
</dict>`)), { A: "a & b", B: false, C: ["x", ""], D: {}, E: 15, F: [], G: true });
  assert.deepEqual(urlSchemes(parsePlist(plist(`<dict><key>CFBundleURLTypes</key><array>
    <dict><key>CFBundleURLName</key><string>linger</string>
    <key>CFBundleURLSchemes</key><array><string>linger</string></array></dict>
  </array></dict>`))), ["linger"]);
  assert.deepEqual(urlSchemes(parsePlist(plist("<dict/>"))), []);
  for (const [inner, error] of [
    ["<dict><key>A</key><real>1.5</real></dict>", /can't read <real>/],
    ["<dict><key>A</key><string>a</string><key>A</key><string>b</string></dict>", /there twice/],
    ["<dict><key>A</key></dict>", /can't read <\/dict>/],
    ["<dict><string>a</string></dict>", /expected <key>/],
    ["<dict><key>A</key><string>a</string></dict><dict/>", /expected <\/plist>/],
    ["<dict><key>A</key><integer>x</integer></dict>", /isn't one/],
  ]) assert.throws(() => parsePlist(plist(inner)), error, inner);
  assert.throws(() => parsePlist("<plist version=\"1.0\"><dict>"), /ends too soon/);
  assert.throws(() => urlSchemes({ CFBundleURLTypes: [{ CFBundleURLName: "linger" }] }), /CFBundleURLSchemes list/);
});

test("gen/apple's own Info.plist and the share extension's read too", () => {
  for (const path of ["client/src-tauri/gen/apple/linger-client_iOS/Info.plist", "client/src-tauri/gen/apple/ShareExtension/Info.plist"])
    assert.equal(typeof parsePlist(read(path)), "object", path);
});
