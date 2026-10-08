# Desktop icon audit

The approved artwork is `assets/logo/Linger Pixel Porch Icon Set FINAL.png`.
Do not replace it or stretch it to a square. `scripts/app-icons.mjs` pads it
transparently and generates the desktop formats with the pinned Tauri CLI.

## Finding, 2026-09-17

The published **v0.1.0** packages were built on September 5 at `35bffe53`.
The porch artwork was committed on September 8 at `54a4e1e`. The published
AppImage's icon matches the pre-porch source exactly. The extracted Windows
application also embeds the old ICO images. This is a stale
release, not evidence that clearing an icon cache will fix those packages.
No replacement release has been published by this audit.

Current source has the approved icons. One additional quality issue was found:
Tauri uses the **first PNG** in `bundle.icon` for the Linux window icon, and
that was the 32-pixel version. The 256-pixel version now comes first, avoiding
upscaling the smallest icon on high-density displays. Windows uses `icon.ico`.
See [Tauri's icon documentation](https://v2.tauri.app/develop/icons/).

The NSIS installer had no explicit installer/uninstaller icon configuration;
the published installer embeds neither the old application ICO nor the porch
ICO. Both installer surfaces now explicitly use the porch ICO too.

## Repeatable checks

```bash
# Requires the existing client development dependencies; changes no assets.
node scripts/app-icons.mjs --check

# After extracting a Debian, RPM or AppImage package:
node scripts/package-icons.mjs --linux-root /path/to/extracted/package

# An extracted Windows app and its NSIS installer:
node scripts/package-icons.mjs --pe /path/to/linger-client.exe --pe /path/to/setup.exe
```

The source check regenerates all six formats in temporary storage and compares
them. ICNS chunk ordering is ignored because its writer does not guarantee it.
The package check compares installed PNGs byte-for-byte, validates the launcher
and X11 identity, and reads Windows PE icon resources without executing them.
It accepts Tauri's `256x256@2` directory for the `128x128@2x.png` asset as well
as an unscaled `256x256` directory; it still requires exact artwork bytes.
It rejects both downloaded v0.1.0 application icons as expected; the Windows
application passes when compared with its own tag's old artwork. The installer
is a separate missing-configuration defect.

The **package check** workflow builds unsigned Linux and Windows test packages
when packaging or artwork changes. It never uses signing keys, creates a tag,
publishes a release or changes the updater channel. Its Windows runner installs
the NSIS package, checks shortcut targets, verifies the MSI application's icon
resources independently, and reads the running app's own window icon. Tauri
stamps the bundle format into each executable, so MSI and NSIS application
bytes legitimately differ; a whole-file equality check would be incorrect.
`running-window-icon.png` is saved with the test artifacts for visual review.
The script is for disposable runners, not an end-user install command.
An empty shortcut icon path uses the target application's first icon, as
specified by [NSIS](https://nsis.sourceforge.io/Docs/Chapter4.html#createshortcut).
The check accepts WScript's `,0` representation of that default, but still
rejects a different icon source.
The running-window probe reads `ICON_SMALL`, which Tao's window-icon setter
uses. `ICON_BIG` is a separate taskbar override and may be absent; its absence
does not establish a missing caption icon. The saved image proves the caption
artwork, not Windows' final taskbar rendering or cache behavior.

## Evidence and remaining surfaces

| Package/surface | Evidence |
|---|---|
| Published v0.1.0 AppImage PNGs and launcher | Old artwork confirmed; launcher points to `linger-client` |
| Published v0.1.0 Windows application resources | Old artwork confirmed against the release tag |
| Published v0.1.0 NSIS installer resources | Neither application ICO is embedded; explicit configuration added |
| Current source, all six desktop formats | Regeneration check; no replacement artwork |
| Current Linux window icon | Native context regression requires at least 256 pixels |
| New Debian, RPM and AppImage contents | Linux job in [run 35265250714](https://github.com/itsMattGuenther/Linger/actions/runs/35265250714) passes all three exact-artwork and launcher checks |
| New Windows NSIS installer, installed app, uninstaller and MSI app | Windows job in [run 35266385334](https://github.com/itsMattGuenther/Linger/actions/runs/35266385334) passes all four six-frame resource checks plus both installed shortcut targets |
| New running Linux AppImage | T-929's actual CI AppImage opens on Wayland and X11; both 256×256 window icons match porch pixels exactly; [PR #78](https://github.com/itsMattGuenther/Linger/pull/78) records the input evidence and package hash |
| New running Windows caption | [Run 35266385334](https://github.com/itsMattGuenther/Linger/actions/runs/35266385334), unsigned v0.1.0 test package at `b0fe88c`: captured PNG visually inspected and matches approved `32x32.png` RGBA pixels exactly |
| Real Windows taskbar/Start menu and Omarchy launcher | Still need visual confirmation after installing the next release; cache behavior is not proved by resource checks |
| macOS | No distributable exists; no platform pass claimed |

For a remaining wrong icon, first record the installed version, package and
surface. Quit any older copy and launch the new one. A pinned shortcut may still
point to an old executable. Only investigate icon caching after confirming the
package contains the porch artwork and the shortcut points to that package.
Do not delete broad icon caches as a first step.
