# Developing Linger

The [README](../README.md)'s Development section has the repository layout and
the three everyday commands. This is everything else: the system packages,
the checks beyond `scripts/check.sh`, how the desktop app starts on Linux,
packaging details, and the things that catch people out. Cutting a release is
in [releasing.md](releasing.md).

## System packages

Only the desktop app needs system libraries: a webview, ALSA headers for the
microphone, cmake for the bundled Opus codec, the GStreamer plugins for sound
and for shared videos (libav decodes their AAC sound and H.264 picture; without
it a video plays silent, or not at all, #358), and the appindicator library for the tray icon (without it the app runs, but
closing the list quits instead of hiding it in the tray).

```bash
# Debian/Ubuntu
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev \
                 libayatana-appindicator3-dev librsvg2-dev libasound2-dev cmake \
                 gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-pulseaudio \
                 gstreamer1.0-libav
# Arch
sudo pacman -S webkit2gtk-4.1 gtk3 librsvg alsa-lib cmake gst-plugins-base gst-plugins-good \
               gst-libav libayatana-appindicator
```

## Checks

**Before pushing, run `scripts/check.sh`.** It runs what CI runs for your
branch's changes, sorted the way CI sorts them. Besides Rust and Node, it needs
`python3`: the packaged audio check (`scripts/linux-audio-check.py`) is the one
check still in Python, and `check.sh` runs its tests every time. A docs change
runs the rules lint in under a second; a client change adds the typecheck, unit tests,
Chromium browser tests (and any the branch added or edited, ten times) and the
build's CSP check; a server change adds fmt,
clippy, the Rust tests and bindings drift. `--all` runs everything. Green there
should mean green in CI. The [testing strategy](testing-strategy.md) has what
runs where, and which kind of test a change needs. Separate checks need
additional services or browser engines:

- `scripts/minio-test.sh` tests S3 against a throwaway MinIO. The workspace
  tests skip S3 without that service. MinIO no longer publishes downloads, so
  build it from source with Go first; the script's header has the command.
- `bash scripts/coturn-test.sh` needs Docker Engine and Compose. It checks
  that the shipped voice relay starts, carries packets to the voice address
  and refuses any other (#501), carries nothing when it has no voice address,
  and refuses an empty secret, without opening host ports or using your
  server data. CI runs this too; it does not replace the voice checks on
  separate networks.
- `bash scripts/update-docker-test.sh` needs Docker and network access to
  ghcr.io. It runs `deploy/update.sh` on a real 0.4.2 server, checks it comes
  back as 0.4.3 with a database backup, then runs it again with nothing new.
  `scripts/update-test.sh`, in `check.sh`, covers the rest against a stand-in
  `docker`. CI runs both, and shellcheck on all three.
- In `client`, run `pnpm exec playwright install --with-deps chromium webkit`
  once (`check.sh` needs Chromium), then `pnpm test:browser` for the browser
  tests: layout at every interface size, keyboard use, the list, chat,
  Settings, Search and Media windows, voice controls, downloads and knocks, on
  fixture pages with the desktop shell and the servers faked. They don't
  exercise Linux dictation drivers; see
  [Linux input checks](linux-input-checks.md) for the native comparison
  (`scripts/linux-input-check.sh`). Playwright is a development-only
  dependency; its browsers are not shipped in Linger. CI tests Chromium and
  WebKit. To use an existing Chromium, run
  `LINGER_CHROMIUM_PATH=/usr/bin/chromium pnpm test:browser --project=chromium`.
  None of this replaces trying a packaged app on a real desktop.
- On Linux, Playwright's WebKit won't start outside Debian and Ubuntu (it
  needs their libraries), so `scripts/webkit.sh` runs it in Playwright's own
  Ubuntu image and the tests against it; `check.sh` does this whenever Docker
  works. On macOS and Windows it runs natively. It
  needs Docker Engine and permission to use it: on most Linux systems,
  `sudo usermod -aG docker $USER`, then sign out and back in (membership of
  that group amounts to root on the machine; rootless Docker works too). The
  image is about 3.5 GB, downloaded on first use.

CI picks its jobs with the same sorting (`scripts/ci-scope.mjs`), from the
whole PR rather than its last commit, so a docs-only follow-up to a code PR
still tests the code. The
[testing strategy](testing-strategy.md#what-a-change-sets-off) has the table.
Obsolete PR runs are cancelled. Browser failures retain screenshots and traces
for seven days.

There is no automated signed-in desktop check yet. The three-person
walk-through that drove the previous client (`scripts/desktop-check.py`) was
retired with it (#306); a Buddy list version is T-1820. Until then, the
packaged checks below prove the app starts and plays sound, and the rest is
tried by hand in the real app.

## Packaged audio

Notification chimes need the WebView's audio runtime as well as the native
voice engine. AppImages bundle GStreamer playback plugins; DEB/RPM packages
require them through the package manager. Both Windows installers install
WebView2 if it is missing (an internet connection is required for that step).
Build distributable AppImages on Ubuntu 22.04, where Tauri supports bundling
the media runtime. The AppImage plays shared videos with the libav GStreamer
plugin on a trimmed FFmpeg (#358): install `gstreamer1.0-libav` and `nasm`, run
`scripts/appimage-ffmpeg.sh /tmp/ffmpeg`, and build with
`LD_LIBRARY_PATH=/tmp/ffmpeg/lib`, or the AppImage takes Ubuntu's full FFmpeg
and grows by about 45 MB (`scripts/appimage-ffmpeg-check.sh` catches it). Run
`scripts/appimage-linuxdeploy.sh` too, and build with
`LINUXDEPLOY_EXCLUDED_LIBRARIES='libwayland-*'`: Tauri 2.11's own linuxdeploy
copies Ubuntu 22.04's libwayland into the AppImage, and on a newer Mesa (an AMD
or Intel GPU on Arch or Omarchy) the window then stays empty (#479;
`scripts/appimage-wayland-check.sh` catches it). See
[packaged audio checks](packaged-audio-checks.md)
for runtime and chime-onset tests. These checks also need Node and installed
client dependencies (`cd client && pnpm install --frozen-lockfile`): the probe
bundles the current sound player before running it inside each package.
`scripts/linux-next-check.mjs` and `client/scripts/windows-next-check.mjs` check
the Buddy list client itself starts in the packaged app, signed in nowhere,
and the Windows one keeps a screenshot of it. The Windows check also opens
Settings and a conversation's own window the way the list does and waits for each to draw:
a window built from a synchronous command deadlocks WebView2 (#205), so every
window-building command in `src-tauri/src/window.rs` is `async`. No test code
is shipped in the app. See [the testing strategy](testing-strategy.md).

## Voice at raid size (#197)

`crates/linger-sfu/tests/load.rs` puts 50 stand-in people in one voice room on
the forwarding server, joining at once, then measures ten seconds with three
talking, at the quality the server's offers ask for (96 kbit/s at fifty, 128
at twenty or fewer, #431): once with everybody else sending silence, as apps
before 0.4.9 do, and once with them sending nothing, as the apps now do. Each
talker says how loud it is, each a little quieter than the last, and the
server passes on only the six loudest and never silence (#197). It prints the
forwarding thread's CPU (from /proc, so Linux), the packets a second it
delivered, the worst share any listener heard of the voices passed on to it,
and the longest answer to an offer. It's ignored in ordinary runs:

```bash
cargo test -p linger-sfu --release --test load -- --ignored --nocapture
LINGER_LOAD_PEOPLE=60 LINGER_LOAD_TALKERS=5 cargo test -p linger-sfu --release --test load -- --ignored --nocapture
```

It measures the server's share of the work on this machine, not how a raid
sounds across real networks.

`crates/linger-server/examples/voice_load.rs` is the same room against a real
server somewhere else. It signs the stand-ins up on a fresh server, joins them
through the gateway and sends their voice over UDP from this machine, the way
the app does, each talker saying how loud it is. It prints how much of the
voices passed on every listener heard (up to six, the most a room passes on,
#197), how many voices each heard, and how long a packet took from here,
through the server and back, overall and five seconds at a time. It needs a server with `LINGER_VOICE_ADDRESS` set, no data
yet, and its port 8420 reachable over plain HTTP, so use a throwaway one and
never a real server. Give it the setup token from that server's log:

```bash
LINGER_LOAD_SERVER=http://203.0.113.7:8420 LINGER_LOAD_SETUP=<token> \
  cargo run -p linger-server --release --example voice_load
```

`LINGER_LOAD_PEOPLE` (50), `LINGER_LOAD_TALKERS` (8), `LINGER_LOAD_SECONDS`
(60) and `LINGER_LOAD_OLD` (0, people on an app from before 0.4.9 sending
silence) change the room. It can't see the server's CPU; watch that on the
server itself (`top`) while it runs.

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
keeping that WebKit off it (delete the file to try again). A second copy
started while Linger runs (`pnpm tauri dev` included) hands over to the running
one and quits, and leaves that record alone, because the running copy holds
`running.lock` there (#447). An explicit
`WEBKIT_DMABUF_RENDERER_DISABLE_GBM` always wins. With GBM off on a computer
with two GPUs, the page can draw on a different GPU from the window, which then
stays grey (#433), so startup also sets `WEBKIT_DMABUF_RENDERER_FORCE_SHM=1`
there unless it is set: frames go to the window in ordinary memory. On
NVIDIA's legacy driver (the 580 branch and older), startup also sets
`GDK_GL=disable`, because GTK's GL drawing crashed there when a Linger window
was resized with another open (#229); WebKit then paints on the CPU. An
explicit `GDK_GL` always wins. These choices happen before GTK and change no
desktop settings.
See [Linux input checks](linux-input-checks.md) for evidence and limits.

## The Buddy list client

The app is the Buddy list client (`client/src/next/`,
[architecture](design/architecture.md), [design system](design/system.md)),
from 0.4.0. `client/src/lib/` is the logic its windows share, and
`client/src/generated/` the wire types. The previous client, kept behind
`LINGER_CLASSIC=1` through 0.4.3, was deleted (#306); that variable does
nothing now.

```bash
cd client && pnpm tauri dev
```

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
- `/tests/fixtures/next-chat.html`: the conversations' view on the same evening. Add
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
`next-chat-window.spec.ts` checks what a conversation's own window asks of the
list window and the server, and `next-side.spec.ts` the tabs beside the list in
the real list window: unfolding, folding and the window's size (#337).

## The emoji list (#359)

`client/src/lib/emoji/data.ts` is every Unicode emoji with its shortcodes,
made from Emojibase (a dev dependency; only what the script writes ships):

```bash
cd client && node scripts/emoji-data.mjs
```

Run it after updating `emojibase-data` for a new Unicode emoji version, and
commit the result. The app loads the list the first time the picker or a `:`
in the message box wants it.

## Icons and Windows packaging

The desktop icon comes from the friend group's selected
[porch artwork](<../assets/logo/Linger Pixel Porch Icon Set FINAL.png>).
To regenerate the PNG, Windows ICO and macOS ICNS files after changing that
source, run `node scripts/app-icons.mjs` from the repository root after
`pnpm install` in `client`. It uses the pinned Tauri CLI and adds transparent
padding to make the source square, without cropping or stretching the artwork.
The same script writes the phone app's Android launcher icons into
`client/src-tauri/gen/android/app/src/main/res`: the artwork over the window's
color (`--night-2`), which Android cuts to the phone's own icon shape.
Use `node scripts/app-icons.mjs --check` to verify the committed files without
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

## The phone app (Android)

The phone app is built from the same `client/src-tauri` crate (SPEC §4.15,
`TASKS.md` §Mobile). Desktop-only code is behind `#[cfg(desktop)]`, phone
builds register only what `phone_app` in `src/lib.rs` lists, and
`capabilities/phone.json` is the phone's one capability file. The Android
project Tauri generated is `client/src-tauri/gen/android`; the phone
identifier, `io.github.itsmattguenther.linger`, is in
`tauri.android.conf.json` and `tauri.ios.conf.json`.

Android builds on Linux. iPhone builds need a Mac and aren't set up yet.

1. Install [Android Studio](https://developer.android.com/studio) (Arch: `yay
   -S android-studio`) and run its setup once (Standard). Then, in **SDK
   Manager → SDK Tools**, tick **NDK (Side by side)** and **Android SDK
   Command-line Tools**.
2. Install a **Java 21** JDK (Arch: `sudo pacman -S jdk21-openjdk`). Android
   Studio brings Java 25, which the Gradle in `gen/android` can't run on:
   the build stops at `Unsupported class file major version 69`.
3. Add the Rust targets: `rustup target add aarch64-linux-android
   armv7-linux-androideabi i686-linux-android x86_64-linux-android`.
4. Point the tools at all of it, in your shell's startup file:

   ```bash
   export JAVA_HOME=/usr/lib/jvm/java-21-openjdk   # wherever your Java 21 is
   export ANDROID_HOME="$HOME/Android/Sdk"
   export NDK_HOME="$(ls -d "$ANDROID_HOME"/ndk/* | sort -V | tail -1)"
   export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
   ```

5. Start a virtual phone (Android Studio's **Device Manager**, or
   `emulator -list-avds` then `emulator -avd <name>`), or plug in a phone with
   USB debugging on. Then, in `client/`: `pnpm tauri android dev`. The first
   build downloads Gradle and its plugins and takes a few minutes.

A server on this computer is reachable from the virtual phone after
`adb reverse tcp:8420 tcp:8420`, as `http://localhost:8420`. Dev builds may use
`http://localhost`; release builds can't, as on desktop.

**If `adb` starts crashing every few seconds** during `pnpm tauri android dev`
(seen on one machine, 2026-10-02: one core dump of `adb -L tcp:5037
fork-server server` every ~2.5 s, from the CLI checking whether the app is
still running), stop the CLI. The installed dev build still works without it:
run `pnpm dev --host 127.0.0.1`, then `adb reverse tcp:1420 tcp:1420`, and open
Linger on the phone.

**The phone's layout in a browser:** add `?shell=phone` to the page's address
(`core/phone.ts`) and make the window phone-sized;
`tests/browser/next-phone.spec.ts` does that. To look inside the page on a
phone or emulator, a debug build can be inspected from Chrome's
`chrome://inspect`.

On a virtual phone with an NVIDIA card, the emulator may switch itself to
drawing on the CPU ("Your GPU drivers may have a bug"). It works, but the
phone's graphics driver crashed the app once when it was reinstalled while
running; opening it again was fine.

**The release key (T-1604).** A release's `.apk` is signed with one key, kept
off the repo, so each release installs over the last on people's phones. A
debug build is signed with Android's debug key instead, so it won't install
over a release (or the other way round): uninstall first, which signs you out.

- `scripts/android-key.sh` makes the key once, in
  `~/.local/share/linger/android-release.jks` with its password beside it,
  writes the key's public fingerprint to
  `client/src-tauri/android-release-cert.sha256` (committed), and prints the
  backups to make and the two GitHub secrets to set
  (`ANDROID_RELEASE_KEYSTORE`, `ANDROID_RELEASE_KEYSTORE_PASSWORD`). It never
  replaces a key, or a committed fingerprint for a different one.
- The release workflow's `android` job runs `scripts/android-signing.sh`:
  `check` (also in preflight), then `setup`, which writes
  `gen/android/keystore.properties` for `build.gradle.kts` (git ignores it),
  then `verify` on the built `.apk` before adding it to the draft as
  `Linger_<version>_android-arm64.apk`. `scripts/android-signing-test.sh`
  (CI's rules job) feeds `verify` what real apksigners print.
- If that job fails once the desktop draft is up, build the `.apk` from the
  tagged commit with the key (below), check it with
  `scripts/android-signing.sh verify`, and add it to the draft with
  `gh release upload v<version> Linger_<version>_android-arm64.apk`.
- To sign a release build on your own machine, with the key: export the two
  secrets' values and run `scripts/android-signing.sh setup`, then
  `pnpm tauri android build --target aarch64 --apk`. Without a
  `keystore.properties` the release build comes out unsigned.

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
