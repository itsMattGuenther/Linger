# Packaged notification audio

Since #250, the desktop app plays Linger's own sounds (chimes, knocks, voice
and control sounds) through the shell, on the Speakers picked in Settings:
each cue is rendered by Web Audio's offline renderer in the page and its
samples handed to `sound_play`, which plays them with the same CPAL output as
voice (`src-tauri/src/sounds.rs`). **Web Audio playback is the fallback** when
the shell can't open an output, and what plays outside the app.

The checks below measure that fallback: the probe answers `sound_play` with
"couldn't", so every cue goes through the webview's audio as it did before
#250. The shell path is covered by the Rust tests with stand-in devices
(`sounds.rs`, `voice/device.rs`, `tests/voice.rs`) and by a real-device check:
pick non-default Speakers, press Play on a chime in Settings, and hear it come
out of them, on Linux and on Windows. Voice calls use the same CPAL output and
have separate device and network checks.

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

- `scripts/package-audio-deps.sh BUNDLE_DIR` reads actual DEB/RPM dependency
  metadata and rejects missing playback requirements.
- `scripts/linux-audio-check.py PROGRAM [--appimage] [--output NEW_DIR]`
  loads a test-only GTK module into an unchanged package. It checks GStreamer
  element availability, runs the current production sound player in the packaged
  WebKitGTK, and records a private virtual PulseAudio speaker. Five knocks and
  five DM chimes cover first Preview, repeated Preview, a 35 ms graph-setup
  delay, received-event playback and Preview after a quiet gap. Knock runs
  first on the cold context. The recording must contain all ten complete cues,
  without abrupt sample jumps or clipped attacks. Each knock must retain both
  taps, their 140 ms spacing and full decays. Each cue must also be the sound
  the player made, a millisecond at a time: the probe renders the player's own
  score at the WebView's rate, and the check converts it to the speaker's
  48 kHz ([below](#each-chime-as-the-player-made-it-387-2026-10-02)).
  Each AppImage, extracted DEB executable and extracted RPM executable runs
  separately. This proves playback on the Ubuntu runner, not installation on
  every Linux distribution. When a recording fails only because pieces of the
  sound never reached the speaker, or were held up, the set plays once more and
  must pass; the first recording is kept as `NEW_DIR-lost` ([below](#lost-audio-on-a-paused-runner-384-2026-10-02)).
- `scripts/linux-audio-check.py APPIMAGE --appimage --video` plays a shared
  video's kind of file in the packaged WebKitGTK instead: a 0.8 second 440 Hz
  tone in AAC over a 32 px H.264 picture (`scripts/fixtures/tone-h264-aac.mp4`,
  played by `scripts/video-runtime-probe.js`). It requires `avdec_aac` and
  `avdec_h264` from inside the AppImage and at least 0.6 seconds of the tone at
  the virtual speaker. The AppImage carries the build machine's GStreamer
  plugins, so this fails when the build machine lacks `gstreamer1.0-libav`
  (#358). The DEB and RPM take the decoders from the system, and
  `package-audio-deps.sh` checks they ask for them.
- `scripts/appimage-ffmpeg-check.sh APPIMAGE` checks the AppImage's FFmpeg is
  the trimmed one `scripts/appimage-ffmpeg.sh` builds (H.264, H.265, AAC and MP3
  decoders, about 4 MB): its libraries link nothing but each other and the C
  library, and `libavcodec` is under 6 MB. The video check can't tell the two
  apart, since Ubuntu's full FFmpeg plays video too, at 45 MB more.
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

## Lost audio on a paused runner (#384, 2026-10-02)

On 2026-10-01 the DEB run of the chime check failed once with "Abrupt chime
onset" on `knock-first-preview` (maximum step 0.129) and passed on re-run
(package check run 36915387652). In the recording kept from that run the
first knock lasted 157 ms instead of 238 ms. Compared a millisecond at a time
with a clean knock from the same recording, it was that knock sample for
sample (relative squared difference about 0.0001) with two pieces cut out: it
skipped about 40 ms at 5.5 ms in and about 41 ms more at 20 ms, 81 ms in all.
Nothing was added or changed. The probe's analyser had measured the same cue
whole in the WebView (two 98 ms taps, 140 ms apart), so the sound was lost
between WebKit's audio output and the recorder. The other nine cues, and the
AppImage and RPM runs, were clean.

The CI DEB was then run in an Ubuntu 22.04 container limited to four CPUs.
Twelve runs with eight busy processes competing for those CPUs lost nothing.
Pausing the whole container (`docker pause`) for 40–150 ms at random moments,
as a host pauses a virtual machine, lost audio in every run, on whichever cue
was playing: the sound skipped ahead (one run lost 82 ms of a knock in the CI
failure's pattern), or silence took the place of part of it. PulseAudio
reported underflows of WebKit's stream, whose sink buffers 60 ms. The app
can't prevent this; a desktop stopped that long glitches every program's
sound.

So when the speaker check fails, `lost()` compares each cue with the sound
the player made ([#387](#each-chime-as-the-player-made-it-387-2026-10-02); at
first, with the passing cue of the same kind that had the most sound in it).
Each audible millisecond must be that reference's, in order, allowing 16
samples of drift as the sound server adjusts its resampling. The shift
between them grows where audio was skipped, and steps back, no further than
the quiet before it, where the sound paused and carried on where it stopped.
A millisecond that matches nowhere must sit on a cut. Faint and silent
stretches are read the way that loses least, and silence where the reference
had sound is lost. If that explains every failed cue, the check raises
`LostAudio`, and `run()` renames the output to `NEW_DIR-lost`, prints `LOST`
(a warning annotation on GitHub Actions) and plays the set again on a fresh
app and speaker. The second recording must pass. Anything else fails at
once: a click, a crackle at an onset, a changed level, a missing cue, or
audio lost again. A fault in the app or the package, such as #94's lost
attacks, happens every time, so it still fails.
`scripts/linux-audio-check.test.py` keeps the CI knock and clean cues as
fixtures and runs in CI's rules job.

In the container, with pauses of 40–90 ms, 23 recordings failed and 17 of
them were read as lost audio, among them all 12 failing first plays paused
every one to two seconds. Of the other six, five had no intact cue of a kind
left to compare with, and in one, paused throughout, part of a knock arrived
out of order; those fail. Two limits remained. A sound could lose a piece and
still pass the measurements: of 317 cues that passed in the frozen runs, 44
had lost audio, DM chimes up to 172 ms and knocks up to 18 ms, and four first
plays passed that way. #387 closes that, below. And `--video` has no replay.

## Each chime as the player made it (#387, 2026-10-02)

The measurements can't see every loss. A DM chime peaks around 0.04 of full
scale, so a cut in its quiet tail is no sudden jump, and silence in place of
part of it leaves its length alone.

So each recorded cue must also be the sound the player made. After its run,
the probe renders the knock and the DM chime with `renderChime()` at the
WebView's own rate and the player's volume, the call the player made, so the
same samples. The GTK module adds them to the result as `score`; Windows
doesn't read them. The check converts them to 48 kHz with a windowed sinc
(16 taps each side, cut off at 95% of the lower rate's limit) and `missing()`
must find each cue whole. Rendering at 48 kHz directly does not match: Web
Audio applies scheduled changes on 128-sample blocks, so at another rate the
second note lands differently, and recordings differed from it by 14–22% a
millisecond.

Converted, 21 clean recordings (210 cues: twelve under heavy CPU load, the CI
AppImage run and eight more) matched, the worst millisecond 0.3% different
against the 5% allowed. Rate conversion rings differently at the faint edges
of a sound: the score ran on up to 19 samples past a recording's end and had
up to 15 inside its silences. So a lost end must be more than a millisecond,
and a silent millisecond is lost only where the score had sound in most of it.

Pauses turned out to have a third shape: the sound stops and carries on where
it stopped, held up rather than cut. `missing()` reads that too, and counts
the pause as missing. Against the score, every damaged cue in the frozen runs
reads as lost or held up: 45 that passed the measurements and 83 that failed
them. With this check in the container, six clean runs passed; of eight first
plays paused every one to two seconds, seven lost audio and passed when played
again and one lost none; and two runs paused throughout lost audio twice and
failed.

## Still requires listening

Use Preview in Settings → sound & voice on actual Linux and Windows clients,
then try a live knock/control cue. Check the intended output device, including
after an output-device change. Virtual-speaker and audio-graph checks cannot
prove the hardware route, loudness or listening quality. They do not close
HC-6, HC-8 or HC-9.
