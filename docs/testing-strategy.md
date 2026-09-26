# Testing strategy

Keep fast, repeatable checks in CI. Use real packages for platform behavior,
and reserve human time for things automation cannot hear or reproduce.

## Fixes need regression evidence

For each bug, link the issue and PR and add a check for the reported behavior.
Where practical, run it against the old behavior first and record that it
fails. Assert the result a person needs, not just a class name or implementation
detail. Shared CSS fixes must cover both rendering engines and both desktop
platforms, including short windows, long names and the supported interface sizes.
Test the combined release candidate: separately green PRs can disagree.

## Layers

| Check | What it proves | What it does not prove |
| --- | --- | --- |
| Rust/TypeScript tests | Logic, real HTTP/temp SQLite, forced gateway reconnect, palette contrast, generated types | Desktop rendering or physical audio |
| Chromium + WebKit browser tests | Real components with synthetic people, keyboard/pointer behavior and geometry | Installed WebView2/WebKitGTK behavior |
| Linux/Windows package checks | Installation, icons, recorded chimes, Windows shortcut upgrades, native navigation layout, knock and sending | Every distro, physical speakers, real-network voice |
| Short two-person release check | Your installed clients, actual update path, listening and interaction | Exhaustive platform coverage |

The existing package audio harness also injects a test-only bundle of the real
Console fixture. It deliberately discards that bundle's CSS: measurements use
the package's shipped stylesheet. It tests long server/room/DM names, a reserved
vertical scrollbar gutter, short scroll areas, both themes and all six interface
sizes in WebView2 and WebKitGTK. The synthetic fixture replaces the empty test
page only; it never loads personal accounts. Layout results are retained beside
audio results. The same native fixture tests a second knock and immediate
composer clearing in rooms and DMs while a send is held, preserving the next draft.
This is not a live-server or full-app startup test.
The Linux harness disables overlay scrollbars only in its isolated test process
using [GTK's scrollbar setting](https://docs.gtk.org/gtk3/property.Settings.gtk-overlay-scrolling.html).
The test requires a measurable native gutter and rejects the negative-margin
scroll box that caused #100, as well as checking actual text and row bounds.

Run the existing `scripts/linux-audio-check.py` and Windows package scripts as
documented in [packaged audio checks](packaged-audio-checks.md). They require a
fresh isolated profile. Windows checks are restricted to disposable CI runners.
Release builds run these checks again against the signed updater artifacts.

## Efficient gates

`node --test scripts/ci-scope.test.mjs` verifies test selection. The classifier
uses the whole PR diff, counts both sides of renames and runs everything if Git
cannot compare revisions. Docs-only PRs keep rules/version checks. Frontend-only
changes avoid unrelated server/S3/relay jobs. Browser-test-only changes avoid a
package rebuild. Shared types, workflow changes, unknown paths and manual package
runs select the full relevant gate. Cancelling superseded PR runs avoids paying
for obsolete candidates. Nothing is skipped solely because the latest commit
only changes documentation.

Use `scripts/check.sh` before pushing and `pnpm test:browser` in `client` for
browser coverage. S3 and relay checks still need their documented services.
When a browser test fails, inspect its screenshot/trace artifact before changing
code. Do not add blanket retries to hide a failing test.

## Release and human checks

Merge only after the combined candidate is green. Bump all four version files
and both Rust lockfiles together. Tag once, wait for signed packages and the
server image, inspect the draft and updater manifest, then publish. Never move a
published version tag to fix a failed release; use the next patch version.

Use [the 0.4.0 checklist](releases/0.4.0.md#checks-on-installed-clients) for this release. Record OS,
package type, previous/new version, interface size and reproduction steps when
reporting a failure. Do not capture private conversations in evidence.

The real-world checks in [release-checks.md](tasks/release-checks.md) are
closed only by people using the published app on real computers and networks.
Passing these automated checks does not close them.
