#!/usr/bin/env node
// Whether a part of the iPhone app is signed with the App Group (#811), and,
// for the app itself, with Apple's push service (#889).
//
// ios.yml runs it on the app and each extension, with what
// `codesign -d --entitlements - --xml` prints for each:
//
//   node scripts/ios-app-group.mjs <entitlements.xml> <group> <name> [<aps-environment>]
//
// It prints the part's App Groups, and fails unless <group> is one of them.
// Given an <aps-environment>, it prints the part's too, and fails unless it's
// that one: a TestFlight build signed for Apple's sandbox gets addresses the
// relay sends to Apple's own service, which refuses them, so its
// notifications would never arrive.
// The share extension reached TestFlight signed without it, so it couldn't open
// the folder a share goes in. The first version of this check was a line of
// shell that read the key with `plutil -extract`, whose key paths split on the
// dots in `com.apple.security.application-groups`, so it would have failed
// every build (#812). It runs only on a Mac, after the build, so it lives here,
// where `ios-app-group.test.mjs` runs it on this build's real output first.
//
// A file it can't read as entitlements fails, naming what's wrong, rather than
// read as "no App Group" (docs/testing-strategy.md, "What reviews have taught").

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KEY = "com.apple.security.application-groups";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function text(raw) {
  return raw.replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => ENTITIES[name]).trim();
}

/** The App Groups an entitlements property list holds, `[]` when it has
 *  none. Throws on anything it can't read as one. */
export function appGroups(xml) {
  const start = xml.indexOf("<plist");
  const end = xml.lastIndexOf("</plist>");
  if (start < 0 || end < start) {
    throw new Error("not an XML property list (codesign needs --xml)");
  }
  const body = xml.slice(start, end).replace(/<!--[\s\S]*?-->/g, "");
  if (!/<dict\s*\/>|<dict>/.test(body)) {
    throw new Error("a property list with no dictionary in it");
  }
  const keys = [...body.matchAll(/<key>([\s\S]*?)<\/key>/g)].filter((m) => text(m[1]) === KEY);
  if (keys.length === 0) return [];
  if (keys.length > 1) throw new Error(`${KEY} is in it more than once`);
  const rest = body.slice(keys[0].index + keys[0][0].length).trimStart();
  if (/^<array\s*\/>/.test(rest)) return [];
  const array = /^<array>([\s\S]*?)<\/array>/.exec(rest);
  if (!array) throw new Error(`${KEY} isn't a list`);
  const strings = /<string>([\s\S]*?)<\/string>/g;
  const leftover = array[1].replace(strings, "").trim();
  if (leftover) throw new Error(`${KEY} holds something that isn't a name: ${leftover.slice(0, 60)}`);
  return [...array[1].matchAll(strings)].map((m) => text(m[1]));
}

const PUSH = "aps-environment";

/** Which of Apple's push services an entitlements property list signs for
 *  (`development` or `production`), `null` when it signs for none. Throws on
 *  anything it can't read as one. */
export function pushEnvironment(xml) {
  const start = xml.indexOf("<plist");
  const end = xml.lastIndexOf("</plist>");
  if (start < 0 || end < start) {
    throw new Error("not an XML property list (codesign needs --xml)");
  }
  const body = xml.slice(start, end).replace(/<!--[\s\S]*?-->/g, "");
  const keys = [...body.matchAll(/<key>([\s\S]*?)<\/key>/g)].filter((m) => text(m[1]) === PUSH);
  if (keys.length === 0) return null;
  if (keys.length > 1) throw new Error(`${PUSH} is in it more than once`);
  const rest = body.slice(keys[0].index + keys[0][0].length).trimStart();
  const value = /^<string>([\s\S]*?)<\/string>/.exec(rest);
  if (!value) throw new Error(`${PUSH} isn't a name`);
  return text(value[1]);
}

function main([file, group, name, push]) {
  if (!file || !group || !name) {
    console.error("usage: ios-app-group.mjs <entitlements.xml> <group> <name> [<aps-environment>]");
    return 2;
  }
  let groups;
  let environment;
  try {
    const xml = readFileSync(file, "utf8");
    groups = appGroups(xml);
    environment = pushEnvironment(xml);
  } catch (error) {
    console.log(`::error::couldn't read ${name}'s entitlements (${file}): ${error.message}`);
    return 1;
  }
  console.log(`${name}: ${groups.length ? groups.join(", ") : "no App Group"}`);
  if (!groups.includes(group)) {
    console.log(`::error::${name} isn't signed with the App Group ${group} (#811)`);
    return 1;
  }
  if (push) {
    console.log(`${name}: ${PUSH} ${environment ?? "missing"}`);
    if (environment !== push) {
      console.log(`::error::${name} is signed for Apple's push service ${environment ?? "not at all"}, not ${push} (#889)`);
      return 1;
    }
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
