# Desktop release checks

`scripts/desktop-check.py` drives three real Tauri/WebKitGTK clients against a
throwaway Rust server. Registration, messages, file selection, uploads, settings,
DMs, search and export use the running application. Tauri commands and gateway
connections are not mocked. Only fixture invitations use direct HTTP.

Each client has its own X display, private D-Bus session, configuration, cache
and empty browser profile. The script never connects to a saved Linger server
or reads the normal desktop. Chromium is registered as the default browser
only inside those disposable directories. No user desktop settings change.

## Run on Linux

Install the normal [build dependencies](../README.md), plus Python 3,
Xvfb, `dbus-run-session`, Chromium and the native WebKit driver. For example,
Debian/Ubuntu package names are `python3 xvfb dbus-x11 chromium
webkit2gtk-driver` (Chromium packaging varies by distribution). Install the
[Tauri test driver](https://v2.tauri.app/develop/tests/webdriver/):

```bash
cargo install tauri-driver --version 2.0.6 --locked
cargo build -p linger-server
cargo build --manifest-path client/src-tauri/Cargo.toml
(cd client && pnpm install)
python3 scripts/desktop-check.py
```

All test tools must be on `PATH`. Some distributions do not include
`WebKitWebDriver` with their WebKitGTK development package; install the separate
driver before running this check. Keep machine-specific extraction paths and
library overrides in personal setup notes, not in this repository.

Stop an existing `pnpm dev` first: the check owns port 1420. Other ports and
isolated displays are allocated automatically. Use a plain `cargo build` for
the client, as above. `pnpm tauri build` enables the packaged protocol and
requires HTTPS; this local check uses the debug client's development policy.
Do not rebuild or package the same executable while the check is running.

The default evidence directory is printed at startup. For a named directory:

```bash
python3 scripts/desktop-check.py --output /tmp/linger-desktop-check
```

The directory must not already exist. Processes stop on completion or failure;
screenshots, `results.json`, browser-downloaded ZIPs and disposable server data
remain for inspection. The directory is private to the current user because
its server log contains the disposable setup link. Share selected screenshots
and results, not the whole raw directory.

## What a passing run proves

- A message and an uploaded image cross real native gateway connections.
- A second client renders a gradient name in Newsreader with shimmer. Both
  themes render; normalization removes the styling; compact and IRC stop
  animation. A controlled hour in the test WebView exercises evening warmth
  without changing the machine's clock.
- A DM appears in its recipient's rail and supports a reply and a private
  image. An outsider cannot find the conversation in the rail, media or search.
- The export control builds an archive and hands it through Tauri's native
  opener to Chromium. A separate ZIP reader verifies the downloaded public
  room and image, inclusion of the recipient's DM, and exclusion of that DM
  and its file from the outsider's archive. Asking again shows the cooldown.

The script records the outsider's presence wording separately. The existing
`in_room` entry with a hidden room ID currently renders as “in a room”; HC-7
expects “around”. This mismatch remains open even when content isolation passes.

This is evidence for HC-5 and the local desktop portions of HC-4 and HC-7.
It does not prove installer updates, production TLS/media domains, behavior
on Windows/macOS, physical audio devices, independent networks or how voice
sounds. It is an optional desktop gate alongside `scripts/check.sh`, not a
replacement for the remaining [release checks](../TASKS.md#human-checks--things-only-you-can-do).
