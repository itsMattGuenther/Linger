# Packaged notification audio

Notification chimes use Web Audio. Voice calls use Rust/CPAL/Opus and have
separate device and network checks. A working voice call does not prove that
notification playback is packaged correctly.

## Runtime requirements

| Package | How the playback runtime arrives |
|---|---|
| Linux AppImage | `bundle.linux.appimage.bundleMediaFramework` includes GStreamer plugins and their libraries. Ubuntu builders explicitly install the base, good and PulseAudio plugin packages. |
| DEB | Required dependencies: `gstreamer1.0-plugins-base`, `gstreamer1.0-plugins-good`, `gstreamer1.0-pulseaudio`. |
| RPM | Required plugin file paths under `/usr/lib64/gstreamer-1.0/`, so Fedora and openSUSE can resolve their differently named packages. Current published RPMs target x86-64. |
| Windows EXE and MSI | WebView2 supplies Web Audio. Both installers retain Tauri's runtime detection and bootstrapper download, explicitly configured instead of relying on a default. A missing runtime requires internet during installation. No GStreamer DLLs belong in these packages. |

Tauri's [AppImage documentation](https://v2.tauri.app/distribute/appimage/#multimedia-support-via-gstreamer)
requires the media option for audio/video and an Ubuntu build environment.
Its [Windows installer documentation](https://v2.tauri.app/distribute/windows-installer/#webview2-installation-options)
describes runtime installation. These are runtime dependencies, not new sound
assets or a change to the sound design.

## What failed in 0.3.0

On 2026-09-21, the running AppImage matched the published 0.3.0 SHA-256. Mute
and quiet hours were off. Its launcher set `GST_PLUGIN_SYSTEM_PATH_1_0` to
`$APPDIR/usr/lib/gstreamer-1.0`, but that directory was absent. GStreamer core
libraries existed, but none of the required playback elements loaded in the
package's environment. The earlier gesture-unlock fix was present; it cannot
replace missing native playback plugins. Browser tests and offline WAV
rendering had not exercised this packaged dependency path.

## Automated checks

The unsigned Linux/Windows package workflow runs these checks:

- `scripts/package-audio-deps.py BUNDLE_DIR` reads actual DEB/RPM dependency
  metadata and rejects missing playback requirements.
- `scripts/linux-audio-check.py PROGRAM [--appimage] [--output NEW_DIR]`
  loads a test-only GTK module into an unchanged package. It checks GStreamer
  element availability, runs a realtime oscillator in the packaged WebKitGTK,
  and verifies nonzero samples reach a private virtual PulseAudio speaker.
  Each AppImage, extracted DEB executable and extracted RPM executable runs
  separately. This proves playback on the Ubuntu runner, not installation on
  every Linux distribution.
- `scripts/windows-icon-check.ps1` also runs the installed NSIS executable
  and MSI-extracted executable with separate empty WebView2 profiles. A real
  button click starts the shared realtime audio probe. Its clock must advance
  and its analyser must receive nonzero samples. Debugging is enabled only
  for those disposable processes; it is not enabled in shipped app settings.
  WebView2 150+ ignores environment overrides for elevated hosts. GitHub's
  administrator runner therefore uses temporary, executable-specific HKLM
  `AdditionalBrowserArguments` and `UserDataFolder` policies, removed in
  `finally`. The script refuses to replace existing values or run outside
  GitHub Actions. See Microsoft's [elevated-host override rules](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security#for-an-elevated-host-app-use-appropriate-override-flags).

The Linux check needs `cc`, `pkg-config`, WebKitGTK/GStreamer development
headers, `xvfb`, `xauth`, `dbus-x11`, `pulseaudio` and `pulseaudio-utils`.
Dependency inspection also needs `dpkg-deb` and `rpm`. On Debian/Ubuntu:

```sh
sudo apt install libunwind-dev libgstreamer1.0-dev xvfb xauth dbus-x11 pulseaudio pulseaudio-utils rpm
python3 scripts/linux-audio-check.py /path/to/Linger.AppImage --appimage --output /tmp/linger-audio-check
```

The script uses an empty profile, private display, private D-Bus session and
private sound server. It never connects to an account, microphone, the user's
desktop, or physical speakers. With `--output`, logs, the JSON result and the
virtual speaker's raw float32 audio remain for inspection. The Windows check
belongs on an ephemeral runner; it installs the test package there.

## Still requires listening

Use Preview in Settings → sound & voice on actual Linux and Windows clients,
then try a live knock/control cue. Check the intended output device, including
after an output-device change. Virtual-speaker and audio-graph checks cannot
prove the hardware route, loudness or listening quality. They do not close
HC-6, HC-8 or HC-9.
