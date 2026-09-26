# Developing Linger

The [README](../README.md)'s Development section has the repository layout, the
three everyday commands and the system libraries the desktop app needs. This is
everything else: the checks beyond `scripts/check.sh`, how the desktop app
starts on Linux, packaging details, and the things that catch people out.
Cutting a release is in [releasing.md](releasing.md).

## Checks

**Before pushing code, run `scripts/check.sh`.** It runs what CI runs, in the
order CI runs it — rules lint, version check, fmt, clippy, workspace tests,
bindings drift, frontend, and the desktop shell. Green there should mean green
in CI. Separate checks need additional services or browser engines:

- `scripts/minio-test.sh` tests S3 against a throwaway MinIO. The workspace
  tests skip S3 without that service. MinIO no longer publishes downloads, so
  build it from source with Go first; the script's header has the command.
- `bash scripts/coturn-test.sh` needs Docker Engine and Compose. It checks
  that the shipped voice relay starts and refuses an empty secret, without
  opening host ports or using your server data. CI runs this too; it does not
  replace the voice checks on separate networks.
- In `client`, run `pnpm exec playwright install --with-deps chromium webkit`
  once, then `pnpm test:browser` for Console layout, panel resizing, interface
  scaling, keyboard use, voice controls, image previews, file downloads and
  temporary knock feedback. Download tests simulate browser
  handoff success and refusal; installed-app downloads still need a real
  desktop check.
  Composer tests also cover ordinary typing and Unicode/multiline insertion;
  browser automation does not exercise Linux dictation drivers. See
  [Linux input checks](linux-input-checks.md) for the isolated native
  comparison (`scripts/linux-input-check.sh`) and its optional developer
  tools. The current AppImage's simulated-typing limitation has a
  [clipboard workaround](user-guide.md#appimage-troubleshooting).
  Playwright is a development-only dependency; its browsers are not shipped
  in Linger. CI tests Chromium and WebKit. These component checks do not replace
  testing a packaged desktop client. The installer may request administrator
  access for system libraries on supported Linux distributions. To use an
  existing Chromium without installing browsers, run
  `LINGER_CHROMIUM_PATH=/usr/bin/chromium pnpm test:browser --project=chromium`.
- To refresh the [Console screenshots](../screenshots/README.md), run
  `node scripts/console-screenshots.mjs` from `client`. It starts and stops its
  own local preview and writes to the root `screenshots/` directory. Set
  `LINGER_CHROMIUM_PATH=/usr/bin/chromium` to use an existing browser. These
  captures use the real UI with fictional people and local test responses,
  not saved accounts or a live server. They do not validate a packaged app.
  Pass an output folder to retain earlier reviews, for example
  `node scripts/console-screenshots.mjs ../screenshots/review-04`. The capture
  also writes `sounds/index.html` and playable WAV samples of the notification
  cues. Open that page to listen; it never autoplays. Samples are rendered
  locally from the app's synthesizer, not downloaded sound assets.
- The [control style guide](style-guide.md) records the approved Console
  controls and their usage. Run `pnpm dev` from `client`
  and open `http://localhost:1420/tests/fixtures/styleguide.html` to try its
  shared buttons and switches in both themes.

For a **documentation-only** change, run `scripts/lint-rules.sh` and
`scripts/version-check.sh`. CI still runs those quick checks, but skips the
Rust, S3, web, desktop, and relay jobs. `scripts/ci-scope.mjs` selects affected
jobs from the full PR: frontend changes run browser and Linux/Windows package
checks; server changes run Rust and real S3 tests; shell changes run its Rust
tests and packages. Shared types, CI changes and unknown paths run everything.
Obsolete PR runs are cancelled. Browser failures retain screenshots and traces
for seven days. Docs-only follow-up commits to a source PR still test its full
scope; a green last commit must not conceal an untested earlier change.

For real desktop interaction, `python3 scripts/desktop-check.py` runs three
isolated Linux clients through live styling, private messages, uploads and a
browser-downloaded export. It needs additional test tools and built debug
binaries; see [desktop checks](desktop-checks.md) for setup and the
[dated results](desktop-check-results.md). It does not replace checks on
separate computers and networks.

## Packaged audio

Notification chimes need the WebView's audio runtime as well as the native
voice engine. AppImages bundle GStreamer playback plugins; DEB/RPM packages
require them through the package manager. Both Windows installers install
WebView2 if it is missing (an internet connection is required for that step).
Build distributable AppImages on Ubuntu 22.04, where Tauri supports bundling
the media runtime. See [packaged audio checks](packaged-audio-checks.md)
for runtime and chime-onset tests. These checks also need Node and installed
client dependencies (`cd client && pnpm install --frozen-lockfile`): the probe
bundles the current sound player before running it inside each package. The same
isolated run checks navigation overflow with real Console components and the
package's shipped CSS, in both themes at all six interface sizes. No test code
is shipped in the app. See [the testing strategy](testing-strategy.md).

## How the desktop app starts on Linux

Linux v0.3.3 selects native Wayland when a Wayland display is available, so
simulated dictation typing avoids the AppImage launcher's X11 path. Other
desktops keep their existing backend. `LINGER_LINUX_BACKEND=x11` or `wayland`
remains an explicit per-launch override. Linux startup also sets
`__NV_DISABLE_EXPLICIT_SYNC=1` unless already set, which stops NVIDIA +
Wayland machines closing on launch with `Error 71`, so `pnpm tauri dev` needs
no prefix. WebKit's GPU display path (GBM) is on under native Wayland for
packages that use the system's WebKit, because turning it off puts every frame
a beat behind the keyboard (#169). It is off in the AppImage, whose bundled
WebKitGTK 2.50.4 aborts creating a GBM display on NVIDIA + Wayland machines
(#187), and off under X11. If a launch that tried it dies before drawing, the
next launch notices and writes `~/.local/state/linger/gbm-off-<webkit version>`,
keeping that WebKit off it (delete the file to try again). An explicit
`WEBKIT_DMABUF_RENDERER_DISABLE_GBM` always wins. These choices happen before
GTK and change no desktop settings.
See [Linux input checks](linux-input-checks.md) for evidence and limits.

## The Buddy list client and today's client

The Buddy list client (`client/src/next/`, [architecture](design/architecture.md),
[design system](design/system.md)) is the app from 0.4.0. Today's client
(`client/src/`, outside `next/`) stays in the build for one release as a
fallback, and gets bug fixes only:

```bash
cd client && pnpm tauri dev                     # the Buddy list
cd client && LINGER_CLASSIC=1 pnpm tauri dev    # today's client
```

`LINGER_CLASSIC=1` works in an installed copy too. Both clients share the
sign-ins in the keyring, the servers and the `linger.*` preferences.

Closing the list window keeps Linger running in the tray (and in voice) until
you pick Quit from the tray menu; Settings → Windows can make closing it quit
instead. On a Linux desktop with no tray (no StatusNotifier host, or no
`libayatana-appindicator`), closing the list quits, since there would be no
way back to it. Only one copy of Linger runs at a time: starting a second one
shows the first one's list, so quit an installed copy before `pnpm tauri dev`.

To look at pieces without the desktop shell, run `pnpm exec vite` in `client/`
and open any of these pages:

- `/tests/fixtures/kit.html`: every component in every state;
- `/tests/fixtures/next-list.html`: the buddy list on the prototype's evening.
  Add `?servers` for the prototype's three servers (the first open, the rest
  folded), with `&folded` or `&open` to start them all one way, `&quiet` to
  quiet the guild, `&awayfail` to have one server refuse an away message, and
  `&voice` to be in voice;
- `/tests/fixtures/next-chat.html`: the chat window on the same evening. Add
  `?voice=mine`, `?voice=elsewhere` or `?voice=off` for the voice strip's
  states, `?tab=d-jules` to open another tab first, `?big` for a room of 5,000
  messages (`&paged` to load it a page at a time), and `?fail` to have every
  send refused;
- `/tests/fixtures/next-list-window.html` (`?one` for a single server): the
  real list window, restoring sign-ins and connecting to three faked
  servers. `?one&signedout` opens it on the sign-in screen (the password
  `wrong` is refused, invite `DEAD` and setup token `used` are spent);
  `?revoked` and `?nokeyring` show its two warnings; `?noinfo` has one
  server never say its name;
- `/tests/fixtures/next-knocks.html` (`?voice`): knocks landing on the list;
- `/tests/fixtures/next-chat-window.html?room=r-general` and
  `/tests/fixtures/next-settings-window.html`: the real chat and Settings
  windows, wired, with the desktop shell, the list window and the server
  faked in the page (`tests/fixtures/next/desktop.ts`). The options are listed
  at the top of each page's `.tsx`;
- `/tests/fixtures/next-chat-parity.html?room=r-general`: the same real chat
  window with the server doing more: files going up (`?holdparts`,
  `?flakystore`, `?uploadrefuse`), older history to page through
  (`?many=1200`), refused edits and deletes (`?refuse`) and a send nobody
  answers (`?hang`), for `next-chat-parity.spec.ts`;
- `/tests/fixtures/next-settings.html`: the Settings window on the same
  evening. Add `?section=invites` (any section) to open on it, `?member` to
  lose Hosting, `?servers` for three servers, `?fail` to have every save
  refused, `?away`, `?long`, and `?devices=none` or `?devices=looking`;
- `/tests/fixtures/next-search.html` and `/tests/fixtures/next-media.html`:
  search and the media collection on the same evening, each a pane in a box
  the page gives it (`?w=340` for a narrow one), with a fake server in the
  page (`tests/fixtures/next/finds.ts`). Add `?servers` for three servers
  (`&start=guild` to open from one), `?loading`, `?fail`, `?failsecond`,
  `?many` for paging and `?long`. Search also takes `?slow`, `?failguild` and
  `?archived`; media takes `?empty`, `?starfail`, `?slowstar` and `?lazy`.
  The full lists are at the top of each page's `.tsx`.

Their Playwright specs (`kit.spec.ts`, `next-list.spec.ts`,
`next-servers.spec.ts`, `next-chat.spec.ts`, `next-settings.spec.ts`,
`next-search.spec.ts`, `next-media.spec.ts`) measure the rules in
`docs/design/system.md`;
`next-chat-window.spec.ts` checks what the chat window asks of the list window
and the server.

## Icons and Windows packaging

The desktop icon comes from the friend group's selected
[porch artwork](<../assets/logo/Linger Pixel Porch Icon Set FINAL.png>).
To regenerate the PNG, Windows ICO and macOS ICNS files after changing that
source, run `python3 scripts/app-icons.py` from the repository root after
`pnpm install` in `client`. It uses the pinned Tauri CLI and adds transparent
padding to make the source square, without cropping or stretching the artwork.
Use `python3 scripts/app-icons.py --check` to verify the committed files without
changing them. The [desktop icon audit](app-icon-checks.md) explains the
package checks and remaining visual checks. Packaging changes run an unsigned
Linux/Windows test build; these artifacts do not ship an update. Published
v0.2.0 includes the porch icon; older v0.1.0 downloads have the previous icon.

The app and installer display name is **Linger**. The MSI upgrade code is
pinned to its original value, so the change from `linger` to `Linger` did not
create a separate Windows application. Windows MSI upgrades preserve renamed,
moved or deleted desktop shortcuts; they refresh the original desktop shortcut
only when it is still present.

The MSI uses `client/src-tauri/windows/main.wxs`, based on the pinned Tauri
CLI's template with a desktop-shortcut preservation condition. When updating
Tauri, compare it with the upstream template named in its header. Windows
package checks install the published 0.3.0 MSI, upgrade to the newly built
package, and check original, renamed, moved and deleted desktop shortcuts,
including uninstall cleanup. See [the update check](windows-update-checks.md).

## Things that catch people out

How the rest fits together is [ARCHITECTURE.md](../ARCHITECTURE.md).

- **Wire types and the color palette are generated, not written.** Both come out
  of `linger-core` when you run `cargo test -p linger-core`, into
  `client/src/generated/`. The output is committed and CI fails if it drifts, so
  commit the regenerated files alongside your change. Never hand-write a type
  that crosses the wire, and never put a hex or `oklch()` literal in the
  frontend — a color is a palette key everywhere.
- **Renaming a wire type leaves an orphan.** `ts-rs` writes files but never
  deletes them, so the old `.ts` stays behind and the drift check will not catch
  it. Delete it by hand.
- **The version number lives in four files** — `client/package.json`,
  `client/src-tauri/Cargo.toml`, `client/src-tauri/tauri.conf.json` and the root
  `Cargo.toml`. Bump all four together; `scripts/version-check.sh` fails if they
  disagree. If they drift, a release ships under the old number and every
  installed copy decides it is already up to date, which looks exactly like
  success.
- **`client/src-tauri` is not in the cargo workspace.** It links against webview
  libraries CI and server boxes do not have, so `cargo fmt`, `clippy` and `test`
  at the root never touch it. Build it with `pnpm tauri`; its own tests are `cd
  client/src-tauri && cargo test`. A few need a real desktop session — an
  unlocked keyring, for one — and are marked `#[ignore]`.
- **There are two content-security policies, and you develop under the loose
  one.** `pnpm tauri dev` may reach `http://localhost:*`; nothing you ship can.
  Tighten one and you must tighten both — `client/src-tauri/tests/csp.rs` fails
  if they drift apart.
- **File names that differ only in case break Windows and macOS.** They are the
  same file on both, so `Foo.tsx` beside `foo.ts` typechecks on Linux and fails
  everywhere else. `scripts/lint-rules.sh` rejects it.
