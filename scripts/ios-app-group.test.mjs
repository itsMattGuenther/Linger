// scripts/ios-app-group.mjs: whether a part of the iPhone app is signed with
// the App Group (#811), from what `codesign -d --entitlements - --xml` prints.
// Its first version, a line of shell in ios.yml, could only run on a Mac after
// a build and would have failed every build (#812), so these run it here on
// the real output of TestFlight build 0.5.3 (5.1) and the other ways it can
// be written.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { appGroups, pushEnvironment } from "./ios-app-group.mjs";

const GROUP = "group.io.github.itsmattguenther.linger";
const HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`;

// Build 0.5.3 (5.1)'s app, as signed: with the App Group.
const APP_5_1 = `${HEAD}
<plist version="1.0">
<dict>
	<key>application-identifier</key>
	<string>SFTT38V54H.io.github.itsmattguenther.linger</string>
	<key>beta-reports-active</key>
	<true/>
	<key>com.apple.developer.team-identifier</key>
	<string>SFTT38V54H</string>
	<key>com.apple.security.application-groups</key>
	<array>
		<string>group.io.github.itsmattguenther.linger</string>
	</array>
	<key>get-task-allow</key>
	<false/>
</dict>
</plist>
`;

// Its share extension, as signed: without it (#811).
const SHARE_5_1 = `${HEAD}
<plist version="1.0">
<dict>
	<key>application-identifier</key>
	<string>SFTT38V54H.io.github.itsmattguenther.linger.share</string>
	<key>beta-reports-active</key>
	<true/>
	<key>com.apple.developer.team-identifier</key>
	<string>SFTT38V54H</string>
	<key>get-task-allow</key>
	<false/>
</dict>
</plist>
`;

test("build 5.1's app has the App Group, and its share extension hasn't", () => {
  assert.deepEqual(appGroups(APP_5_1), [GROUP]);
  assert.deepEqual(appGroups(SHARE_5_1), []);
});

test("every way the list can be written", () => {
  const plist = (dict) => `${HEAD}<plist version="1.0"><dict>${dict}</dict></plist>`;
  const key = "<key>com.apple.security.application-groups</key>";
  const cases = [
    ["on one line", `${key}<array><string>${GROUP}</string></array>`, [GROUP]],
    ["after another group", `${key}<array><string>group.other</string>\n<string>${GROUP}</string></array>`, ["group.other", GROUP]],
    ["an empty list", `${key}<array></array>`, []],
    ["an empty list, closed in its tag", `${key}<array/>`, []],
    ["with a comment", `<!-- signed ad hoc -->${key}\n<!-- the group -->\n<array>\n<string>${GROUP}</string>\n</array>`, [GROUP]],
    ["with spaces in the key and the name", `<key> com.apple.security.application-groups </key><array><string> ${GROUP} </string></array>`, [GROUP]],
    ["with an entity", `${key}<array><string>group.a&amp;b</string></array>`, ["group.a&b"]],
    ["after other lists", `<key>keychain-access-groups</key><array><string>SFTT38V54H.x</string></array>${key}<array><string>${GROUP}</string></array>`, [GROUP]],
    ["a group only in another key", `<key>keychain-access-groups</key><array><string>${GROUP}</string></array>`, []],
  ];
  for (const [name, dict, groups] of cases) {
    assert.deepEqual(appGroups(plist(dict)), groups, name);
  }
});

test("what it can't read fails, naming why, rather than read as no App Group", () => {
  const key = "<key>com.apple.security.application-groups</key>";
  const cases = [
    ["codesign without --xml", "[Dict]\n\t[Key] com.apple.security.application-groups\n", /not an XML property list/],
    ["nothing at all", "", /not an XML property list/],
    ["no dictionary", `${HEAD}<plist version="1.0"><array/></plist>`, /no dictionary/],
    ["not a list", `${HEAD}<plist><dict>${key}<true/></dict></plist>`, /isn't a list/],
    ["a list of something else", `${HEAD}<plist><dict>${key}<array><integer>1</integer></array></dict></plist>`, /isn't a name/],
    ["the key twice", `${HEAD}<plist><dict>${key}<array/>${key}<array/></dict></plist>`, /more than once/],
  ];
  for (const [name, xml, error] of cases) {
    assert.throws(() => appGroups(xml), error, name);
  }
});

test("run as ios.yml runs it: passes with the group, fails without it or unread", () => {
  const dir = mkdtempSync(join(tmpdir(), "ios-app-group-"));
  const script = fileURLToPath(new URL("./ios-app-group.mjs", import.meta.url));
  const run = (xml, name) => {
    const file = join(dir, `${name}.plist`);
    writeFileSync(file, xml);
    return spawnSync(process.execPath, [script, file, GROUP, name], { encoding: "utf8" });
  };

  const app = run(APP_5_1, "Linger.app");
  assert.equal(app.status, 0, app.stdout + app.stderr);
  assert.match(app.stdout, /^Linger\.app: group\.io\.github\.itsmattguenther\.linger$/m);

  const share = run(SHARE_5_1, "LingerShare.appex");
  assert.equal(share.status, 1);
  assert.match(share.stdout, /LingerShare\.appex: no App Group/);
  assert.match(share.stdout, /::error::LingerShare\.appex isn't signed with the App Group/);

  const unread = run("[Dict]", "LingerShare.appex");
  assert.equal(unread.status, 1);
  assert.match(unread.stdout, /::error::couldn't read LingerShare\.appex's entitlements/);

  const usage = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(usage.status, 2);
});

// The app as a TestFlight build with notifications should be signed (#889):
// build 5.1's, with Apple's own push service.
const APP_PUSH = APP_5_1.replace(
  "<key>beta-reports-active</key>",
  "<key>aps-environment</key>\n\t<string>production</string>\n\t<key>beta-reports-active</key>",
);

test("which of Apple's push services the app is signed for", () => {
  assert.equal(pushEnvironment(APP_PUSH), "production");
  assert.equal(pushEnvironment(APP_5_1), null, "build 5.1 had none");
  const plist = (dict) => `${HEAD}<plist version="1.0"><dict>${dict}</dict></plist>`;
  assert.equal(pushEnvironment(plist("<key>aps-environment</key><string>development</string>")), "development");
  assert.equal(pushEnvironment(plist("<!-- x --><key> aps-environment </key>\n<string> production </string>")), "production");
  assert.throws(() => pushEnvironment(plist("<key>aps-environment</key><true/>")), /isn't a name/);
  assert.throws(
    () => pushEnvironment(plist("<key>aps-environment</key><string>a</string><key>aps-environment</key><string>b</string>")),
    /more than once/,
  );
  assert.throws(() => pushEnvironment("[Dict]"), /not an XML property list/);
});

test("run as ios.yml runs it on the app: passes signed for production, fails for the sandbox or none", () => {
  const dir = mkdtempSync(join(tmpdir(), "ios-app-group-push-"));
  const script = fileURLToPath(new URL("./ios-app-group.mjs", import.meta.url));
  const run = (xml) => {
    const file = join(dir, "app.plist");
    writeFileSync(file, xml);
    return spawnSync(process.execPath, [script, file, GROUP, "Linger.app", "production"], { encoding: "utf8" });
  };

  const signed = run(APP_PUSH);
  assert.equal(signed.status, 0, signed.stdout + signed.stderr);
  assert.match(signed.stdout, /^Linger\.app: aps-environment production$/m);

  const sandbox = run(APP_PUSH.replace("<string>production</string>", "<string>development</string>"));
  assert.equal(sandbox.status, 1);
  assert.match(sandbox.stdout, /::error::Linger\.app is signed for Apple's push service development, not production/);

  const none = run(APP_5_1);
  assert.equal(none.status, 1);
  assert.match(none.stdout, /Linger\.app: aps-environment missing/);
  assert.match(none.stdout, /::error::Linger\.app is signed for Apple's push service not at all, not production/);
});
