# Linux dictation input: T-928 / T-929

## Default launch correction, 2026-09-23 (#114, #122)

From v0.3.3, startup selects native Wayland when `WAYLAND_DISPLAY` is
nonempty, overriding the AppImage launcher's X11 assignment. Explicit
`LINGER_LINUX_BACKEND=x11` still selects X11; desktops without Wayland keep
the existing fallback. Startup defaults the narrow GBM workaround to `1`
without replacing explicit values. No Voxtype or desktop settings change.
From the fix for #135 it also defaults `__NV_DISABLE_EXPLICIT_SYNC` to `1`:
with system WebKitGTK 2.52 on NVIDIA's 610 driver, Hyprland closed the
Wayland connection at launch (`Error 71 (Protocol error)`). Only NVIDIA's
driver reads the variable; the AppImage's older bundled WebKit was not affected.

Native Wayland also moved the title bar: GTK draws its own there, where the
X11 window had none under Hyprland. From the fix for #130 the shell builds the
window itself (`client/src-tauri/src/window.rs`, with `"create": false` in
`tauri.conf.json`) and leaves the title bar off when `HYPRLAND_INSTANCE_SIGNATURE`
is set or `XDG_CURRENT_DESKTOP` names Hyprland. Every other desktop keeps it,
since GNOME and others draw none of their own.

The earlier results below describe historical builds. Synthetic typing and
paste can validate the input route, but a spoken recording with the normal
shortcut still needs physical input evidence and must not be reported as
passed by a synthetic test. An explicit X11 launch remains affected.

## Finding, 2026-09-17

The reported symptom was numbers and symbols replacing dictated words on
Omarchy. The failure is reproducible **without recording or transcription**:
`wtype` sends a known sentence to a plain GTK field, a plain WebKit textarea,
and Linger's production `Composer`. Native Wayland accepts the sentence;
XWayland does not. Slowing typing from 1 to 30 ms does not repair it.

The downloaded `linger_0.1.0_amd64.AppImage` contains this assignment in
`apprun-hooks/linuxdeploy-plugin-gtk.sh`:

```bash
export GDK_BACKEND=x11
```

That selects XWayland on a Wayland desktop, even if `GDK_BACKEND=wayland` was
set before launching. The launcher cites
[Tauri's AppImage/Wayland compatibility issue](https://github.com/tauri-apps/tauri/issues/8541).
The input driver also has an
[XWayland compatibility report](https://github.com/atx/wtype/issues/62).
These are context, not substitutes for the local reproduction.

The isolated native test produced:

| Input route | GTK field | Plain WebKit | Linger composer |
|---|---|---|---|
| Wayland, wtype at 1 ms | Exact | Exact | Exact |
| Wayland, wtype at 30 ms | Exact | Exact | Exact |
| XWayland, wtype at 1 ms | Changed | Changed | Changed |
| XWayland, wtype at 30 ms | Changed | Changed | Changed |
| Wayland, clipboard + native paste | Exact | Exact | Exact |
| XWayland, clipboard + native paste | Exact | Exact | Exact |

The plain WebKit XWayland test turned `hello world! Voice 123.` into
`122345362784930-14`. This locates the corruption below the composer; changing
the text after receipt would not recover the original words. The composer
paste control also preserves Unicode and multiple lines without submitting.

Environment: GTK 3.24.52, WebKitGTK 2.52.6, wtype 0.4, wl-clipboard 2.3.0,
XWayland 24.1.13, labwc 0.20.2 with wlroots 0.20.2. The installed Voxtype
1.0.1 configuration selects simulated typing. The comparison uses its output
driver directly, not a model or a microphone. Labwc and its missing libraries
were extracted into disposable storage, not installed on the user's system.

## Workaround and limits

Use Voxtype's per-recording clipboard output and **physical Ctrl+V**, as shown
in the [user guide](user-guide.md#appimage-troubleshooting). Its `--clipboard`
and `--no-auto-submit` flags were checked against the installed CLI. The native
test uses `wl-copy` and the widget's paste action. It does not test a physical
key press or a spoken recording, and does not claim those end-to-end checks
passed. Automatic paste still synthesizes keys, so it is not the recommended
control.

T-928 did not rebuild or change the AppImage. A packaged
native Wayland option needs its own startup, input, graphics and update tests,
including computers that needed the documented GBM workaround. Do not remove
the packaging fallback based only on a system-WebKit developer test. T-929
tracks that follow-up. No server change, protocol change, text rewriting or
dictation feature was added to Linger.

## T-929: opt-in packaged backend

New builds accept `LINGER_LINUX_BACKEND=wayland` or `x11`. The binary applies
this after the AppImage launcher, before GTK and worker threads start. An
unset option preserves the current fallback; invalid values stop with a clear
error. A comma-separated fallback list is deliberately not accepted: silently
falling back to X11 could make dictation corrupt again without explanation.

For a **test build containing T-929**, replace the filename below with that
build's path. This command does not work around the old published v0.1.0:

```bash
LINGER_LINUX_BACKEND=wayland /path/to/new-linger.AppImage
```

If graphics fail, quit it and return to the existing X11 route:

```bash
LINGER_LINUX_BACKEND=x11 WEBKIT_DMABUF_RENDERER_DISABLE_GBM=1 /path/to/new-linger.AppImage
```

Use the clipboard workaround on that fallback. Do not globally set these
variables, change Voxtype's normal shortcut, patch extracted package files or
disable updater verification. The choice belongs in the launch command, so
the same command can be used after an update replaces that file. A fresh
download at a different path needs the command's filename adjusted.

The packaged results below establish the opt-in input path. Real graphics,
spoken dictation and signed-update acceptance remain open; the default has
not changed. The older system-WebKit fixture is only a diagnostic control.

### Repeat the packaged check

The developer-only `scripts/appimage-input-check.sh` requires the same private
compositor tools as the native comparison below, plus `grim`. It compiles a
temporary GTK test module against the development headers, then loads that
module into the **unchanged AppImage**. The module focuses and reads only the
empty onboarding field, types a known sentence with `wtype`, and invokes native
paste for a Unicode sample. It never clicks Continue or uses an account. The
package's own WebKit/GTK libraries render the field; this is not the system
WebKit fixture. The module is not part of a Linger build or release.

```bash
# An optional final argument keeps screenshots and results in a NEW directory.
scripts/appimage-input-check.sh /path/to/new-linger.AppImage wayland /tmp/linger-wayland-evidence
scripts/appimage-input-check.sh /path/to/new-linger.AppImage x11 /tmp/linger-x11-evidence
```

It refuses a standalone development executable. Every run gets private
configuration, clipboard, D-Bus and a headless compositor with no physical
input backend. No window names are read. The broad rendering workaround is set
for software-rendered checks. The narrow GBM variable is unset before launch,
and the probe verifies the package sets it to `1`; this does **not** prove
hardware acceleration works. The `default` route must now select Wayland.
Wayland must select `GdkWaylandDisplay` and preserve both samples exactly.
X11 must select `GdkX11Display` and preserve paste; a typing `DIFFERENT` result
is explicitly the known failure, not a passing dictation check. The helper
also captures the app's own icon and window for inspection. Without an evidence
directory it removes temporary files after reporting the results.

The downloaded v0.1.0 AppImage, tested with `default` on 2026-09-17, selected
X11: typing was `DIFFERENT`, Unicode clipboard paste was `MATCH`. A separate
new native-binary control selected Wayland and both samples matched; that
control is not claimed as a packaged pass. The window icon in that native
control was 256×256 and matched the approved porch pixels exactly.

### Actual AppImage evidence, 2026-09-17

The unsigned debug-profile AppImage from [package-check run 35264511433](https://github.com/itsMattGuenther/Linger/actions/runs/35264511433)
contains T-929 at `bb1b0f6`. It packages the production frontend on the normal
Ubuntu 22.04 build runner; it is not a published release. SHA-256:
`887c11b413578b26a6ab3e66fe0e27cdfac4270d8d9a72da60be506a0e90aa04`.
The run's old Linux icon-directory assertion failed after building; all three
Linux packages pass the corrected resource check locally.

| Launch choice | Actual backend | Synthetic typing | Unicode native paste |
|---|---|---|---|
| `wayland` | `GdkWaylandDisplay` | Exact | Exact |
| `x11` | `GdkX11Display` | Corruption reproduced | Exact |
| unset | `GdkX11Display` | Corruption reproduced | Exact |

Both explicit routes open and render the onboarding screen under the private
software-rendered compositor. Their running 256×256 window icons match the
approved porch pixels exactly. An invalid backend exits with status 2 and the
documented error before GTK starts. These checks use the unmodified package,
not an extracted executable or a system-WebKit substitute.

Updater configuration, signature verification and release endpoints are
unchanged. The pinned Tauri restart implementation spawns the replacement
with inherited environment, so the per-launch choice is retained by that
code path. No signed update was installed in this test: test packages do not
publish updater artifacts. HC-1's real update/install acceptance is still
open. Also still needed: spoken Voxtype input, physical Ctrl+V, and normal
accelerated graphics on the machine that required the GBM workaround. No
system package, Voxtype shortcut or desktop setting was changed.

## Repeat the native comparison

This is a Linux developer diagnostic, not an end-user setup step. It needs
the normal client development dependencies, a C compiler, `pkg-config`,
WebKitGTK 4.1 development headers, `labwc`, `Xwayland`, `wtype`, `wl-copy`,
`dbus-run-session`, `timeout`, `curl` and `rg`. It installs nothing. Run from
the repository:

```bash
scripts/linux-input-check.sh
```

The script creates a private, headless compositor, private clipboard and
private configuration directories. It has no physical input backend and
does not read window titles, type into the live desktop, use a real account,
record audio or contact a Linger server. Vite serves the fixture on loopback
port 1422; the production composer uses an API stub that rejects submission.
Temporary processes and files are removed when the comparison ends.

`MATCH` means exact synthetic text and, for the composer, no submission.
`DIFFERENT` under XWayland typing reproduces the compatibility defect; it is
**not** a passing input check. Clipboard and native Wayland must all match.
The script exits nonzero for missing results, a timeout or a failed control.
It prints only results for the owned fixture, not desktop diagnostics.

The ordinary `pnpm test:browser` suite includes a smaller composer regression
for typing and Unicode/multiline insertion in Chromium and WebKit. That test
is useful in CI but bypasses `wtype` and cannot prove this Linux issue fixed.
