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
  element availability, runs the current production sound player in the packaged
  WebKitGTK, and records a private virtual PulseAudio speaker. Five knocks and
  five DM chimes cover first Preview, repeated Preview, a 35 ms graph-setup
  delay, received-event playback and Preview after a quiet gap. Knock runs
  first on the cold context. The recording must contain all ten complete cues,
  without abrupt sample jumps or clipped attacks. Each knock must retain both
  taps, their 140 ms spacing and full decays.
  Each AppImage, extracted DEB executable and extracted RPM executable runs
  separately. This proves playback on the Ubuntu runner, not installation on
  every Linux distribution.
- `scripts/windows-icon-check.ps1` also runs the installed NSIS executable
  and MSI-extracted executable with separate empty WebView2 profiles. A real
  button click starts the same ten-cue probe. Its analyser checks peak level,
  sample continuity and both complete knock taps in the realtime graph. Debugging is enabled only
  for those disposable processes; it is not enabled in shipped app settings.
  WebView2 150+ ignores environment overrides for elevated hosts. GitHub's
  administrator runner therefore uses temporary, executable-specific HKLM
  `AdditionalBrowserArguments` and `UserDataFolder` policies, removed in
  `finally`. The script refuses to replace existing values or run outside
  GitHub Actions. See Microsoft's [elevated-host override rules](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security#for-an-elevated-host-app-use-appropriate-override-flags).

Both runners bundle `scripts/audio-runtime-probe.js` with the production
`sound.ts` and `chimes.ts`, using the existing Vite dependency. Node and
installed client dependencies are required. This injected test script is not
a shipped asset. It exercises the current checkout's player in the selected
package's WebView; selecting an old package does not select its old player.
For a before/after comparison, use the corresponding source revision too.

The Linux check also needs `cc`, `pkg-config`, WebKitGTK/GStreamer development
headers, `xvfb`, `xauth`, `dbus-x11`, `pulseaudio` and `pulseaudio-utils`.
Dependency inspection also needs `dpkg-deb` and `rpm`. On Debian/Ubuntu:

```sh
sudo apt install libunwind-dev libgstreamer1.0-dev xvfb xauth dbus-x11 pulseaudio pulseaudio-utils rpm
(cd client && pnpm install --frozen-lockfile)
python3 scripts/linux-audio-check.py /path/to/Linger.AppImage --appimage --output /tmp/linger-audio-check
```

The script uses an empty profile, private display, private D-Bus session and
private sound server. It never connects to an account, microphone, the user's
desktop, or physical speakers. With `--output`, logs, the JSON result and the
virtual speaker's raw float32 audio remain for inspection. The Windows check
belongs on an ephemeral runner; it installs the test package there.

The probe leaves its audio context open after generating the short tone. The
host ends the disposable process after checking the result. Closing the context
as soon as its analyser sees samples can discard audio still queued for output.
A controlled local comparison with one second of output delay reproduced a
silent recording with immediate closure and recorded the same tone with the
context kept open. This changes only the test: Linger already keeps one audio
context for the lifetime of the app.

The Linux host also waits for the recorder's first samples before launching
the app. Starting the recorder process does not prove its monitor stream is
ready, and a short cue can finish before it attaches. A controlled comparison
delaying recorder startup by four seconds missed the cue without this wait and
captured it with the wait, using the same 0.3.1 DEB executable in both runs.

On Linux, `web-audio.json` is the intermediate graph result; only `result.json`
with a nonzero `speaker_peak` establishes that the virtual speaker received
audio. They are separate files so the WebView poller cannot overwrite the
completed recording result.

## Notification onset and knock correction (#94/#95, 2026-09-22)

The 0.3.1 player reproduced truncated attacks in an unchanged 0.3.1 AppImage
using an isolated virtual speaker on Linux. A repeated DM cue reached a
sample jump of 0.0298 (full scale is 1) and a peak of 0.0397 in its first
5 ms. Its audible duration fell from about 423 ms to 412 ms. The smooth
reference clip did not have that onset. This is evidence of a playback-path
fault; it does not establish the exact internal WebKit/GStreamer cause or
prove that the physical-device report has only this cause.

Rendering the existing score into a buffer alone did not fix the capture.
Adding 50 ms of zero samples **inside that buffer** did: all five cues in the
regression run lasted about 423 ms, with first-5-ms peaks of 0.0164 and maximum
sample steps below 0.0047. The Linux check rejects steps at or above 0.01,
first-5-ms peaks at or above 0.02, or an audible duration outside 415–440 ms.
These bounds are specific to the unchanged DM score and a 48 kHz monitor.
The zero samples give the output path time to start before the attack; merely
scheduling a source farther ahead does not send those samples to the output.
There is no continuous background source, added asset or new audio library.

Browser checks compare all twelve prepared cues against the existing score
at 44.1 and 48 kHz, including silent leading/trailing samples. Policy tests
cover preparation failures, simultaneous requests, and changes to mute,
context state or cue age while preparation is pending.

The related #95 capture showed the original knock's second tap peaking around
0.046 instead of 0.104, shortened taps and abrupt onsets on repeated playback.
With the same buffer correction, five knock captures each contain two taps of
about 98 ms, separated by 140 ms, with maximum sample steps below 0.0041.
The combined package check requires two separate spans per knock, each lasting
90–105 ms and peaking above 0.07, with spacing within 5 ms of the score.
The existing notes, two-tap pattern, preferences and server rate limits are
unchanged. Neither a measured tap nor a scheduled oscillator substitutes for
listening to Preview and an actual received knock on the affected installation.

A separate diagnostic that explicitly called `AudioContext.suspend()` then
`resume()` produced no resumed cue with either the original or corrected
player in this Linux package. Linger does not explicitly suspend this context.
That diagnostic is not a passed sleep/wake check; OS sleep/wake and device
changes still require real-client verification. The combined check uses an
idle but open context, matching the player's normal lifetime.

## Still requires listening

Use Preview in Settings → sound & voice on actual Linux and Windows clients,
then try a live knock/control cue. Check the intended output device, including
after an output-device change. Virtual-speaker and audio-graph checks cannot
prove the hardware route, loudness or listening quality. They do not close
HC-6, HC-8 or HC-9.
