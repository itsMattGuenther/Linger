#!/usr/bin/env python3
"""Check a packaged Linux WebView against a private, recorded virtual speaker.

By default it plays Linger's own sounds. With --video it plays a shared
video's kind of file instead, H.264 with AAC sound, and requires the libav
decoders that play it (#358).

No accounts, real desktop, microphone or physical speaker are used. Requires
cc, pkg-config, WebKitGTK/GStreamer headers, Xvfb, D-Bus and PulseAudio tools.
"""

import argparse
import array
import base64
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
# Under a second of a 440 Hz tone in AAC, over a 32 px H.264 picture: what a
# phone or a screen recorder makes, in miniature.
VIDEO_CLIP = ROOT / "scripts/fixtures/tone-h264-aac.mp4"
VIDEO_DECODERS = "avdec_aac,avdec_h264"


def stop(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


def segments(samples, gap=4800):
    """Join notes into cues, or split the two knock taps with a shorter gap."""
    spans = []
    for index, sample in enumerate(samples):
        if abs(sample) <= 0.00001:
            continue
        if not spans or index - spans[-1][1] > gap:
            spans.append([index, index])
        else:
            spans[-1][1] = index
    return spans


class LostAudio(AssertionError):
    """The speaker got the right sound with pieces missing, lost on its way there (#384)."""


def judge(samples, cues):
    """Each recorded cue against the score: their measurements, or an
    AssertionError for the first that fails."""
    spans = segments(samples)
    assert len(spans) == len(cues), f"Missing/extra chimes at speaker: {len(spans)}"
    return [judge_cue(samples, cue, start, end) for cue, (start, end) in zip(cues, spans)]


def judge_cue(samples, cue, start, end):
    clip = samples[max(0, start - 1):end + 2]
    step = max(abs(b - a) for a, b in zip(clip, clip[1:]))
    attack = max(abs(v) for v in samples[start:start + 240])
    duration = (end - start) / 48000
    onset = dict(label=cue["label"], max_step=step, first_5ms_peak=attack, duration=duration)
    assert step < 0.01, f"Abrupt chime onset: {onset}"
    if cue["cue"] == "dm":
        assert attack < 0.02 and 0.415 < duration < 0.44, f"Damaged DM onset: {onset}"
    else:
        taps = segments(clip, gap=960)
        assert len(taps) == 2, f"Expected two knock taps: {onset}"
        spacing = (taps[1][0] - taps[0][0]) / 48000
        assert abs(spacing - 0.14) < 0.005, f"Knock spacing changed: {spacing}"
        for index, (tap_start, tap_end) in enumerate(taps):
            tap_duration = (tap_end - tap_start) / 48000
            tap_peak = max(abs(v) for v in clip[tap_start:tap_end + 1])
            assert 0.09 < tap_duration < 0.105 and tap_peak > 0.07, f"Clipped tap {index}: {tap_duration}, {tap_peak}"
        onset["tap_spacing"] = spacing
        onset["taps"] = len(taps)
    return onset


BLOCK = 48  # 1 ms at the monitor's rate
MATCH = 0.05  # relative squared difference under which a millisecond is the reference's
# Fainter than this, a millisecond is too quiet to say where in a sound it
# came from, and is compared as if it were this loud: the rounding in a
# fading tail is no difference anybody hears, and a click is a hundred times
# louder.
FLOOR = BLOCK * 0.001 ** 2
DRIFT = 16  # samples a recording wanders from its reference within a sound
SKIP = BLOCK // 2  # samples a sound must jump by to have skipped


def missing(recorded, reference):
    """How many samples of `reference` never reached `recorded`, when that is
    all that is wrong with it; otherwise None.

    A machine that stops for longer than its audio buffers hold, such as a CI
    runner paused by its host, loses part of a sound on the way to the
    speaker (#384). Either the sound skips ahead, or silence takes the place
    of part of it and the sound carries on where it would have been. Both
    times every millisecond that arrived is the reference's, in order, except
    one or two where a cut falls. A click, a crackle or a changed level is
    not, and neither is a sound that arrived whole.
    """
    padded = array.array("f", reference)
    padded.extend([0.0] * (len(recorded) + BLOCK))

    def error(block, energy, at, bound):
        """The block's difference from the reference at `at`, or inf once over `bound`."""
        if at < 0:
            return float("inf")
        limit = bound * energy
        total = 0.0
        for a, b in zip(block, padded[at:at + BLOCK]):
            total += (a - b) * (a - b)
            if total > limit:
                return float("inf")
        return total / energy

    def find(block, energy, at, start, stop):
        """The shift from `start` to `stop` that best makes the block the reference's."""
        best, shift = MATCH, None
        for candidate in range(max(start, -at), min(stop, len(reference) - BLOCK - at + 1)):
            difference = error(block, energy, at + candidate, best)
            if difference < best:
                best, shift = difference, candidate
        return shift

    # One mark per millisecond, the last overlapping the one before:
    # [kind, shift, where]. A recorded sample at `at` is the reference's at
    # `at + shift`. Only audible milliseconds say what the shift is. It
    # drifts by a few samples as the sound server adjusts its resampling, so
    # a millisecond that stops matching is looked for nearby first, and only
    # then further on, where a skip would have put it. Audio never repeats.
    starts = list(range(0, len(recorded) - BLOCK + 1, BLOCK))
    if len(recorded) % BLOCK and len(recorded) > BLOCK:
        starts.append(len(recorded) - BLOCK)
    marks = []
    shift = 0
    for at in starts:
        block = recorded[at:at + BLOCK]
        energy = sum(v * v for v in block)
        if energy < FLOOR:
            marks.append(["faint", None, at])
        elif error(block, energy, at + shift, MATCH) < MATCH:
            marks.append(["match", shift, at])
        else:
            found = find(block, energy, at, shift - DRIFT, shift + DRIFT + 1)
            if found is None:
                found = find(block, energy, at, shift + DRIFT + 1, len(reference))
            if found is not None:
                shift = found
                marks.append(["match", shift, at])
            elif len(marks) >= 2 and marks[-1][0] == marks[-2][0] == "seam":
                return None  # three in a row is no cut
            else:
                marks.append(["seam", shift, at])
    matched = [index for index, (kind, _, _) in enumerate(marks) if kind == "match"]
    if not matched:
        return None

    def shift_before(index):
        return next((marks[m][1] for m in reversed(matched) if m < index), 0)

    def shift_after(index):
        return next((marks[m][1] for m in matched if m >= index), None)

    def silenced(index, shift):
        """Whether the reference had sound here that the recording lacks:
        any at all where the recording is silent, as the checks above count
        sound, or else audible and over four times the recording's energy."""
        at = marks[index][2]
        here = recorded[at:at + BLOCK]
        there = padded[max(0, at + shift):max(0, at + shift + BLOCK)]
        if max(abs(v) for v in here) <= 0.00001:
            # More than drift could put across the edge of a sound.
            return sum(abs(v) > 0.00001 for v in there) > DRIFT
        had = sum(v * v for v in there)
        return had >= MATCH * FLOOR and had > 4 * sum(v * v for v in here)

    # A faint stretch lies between two places in the reference, and a skip
    # may fall anywhere in it, so it is read the way that loses least: each
    # millisecond is "quiet" where the reference was as quiet, and "lost"
    # where silence took the place of sound.
    first = 0
    while first < len(marks):
        if marks[first][0] != "faint":
            first += 1
            continue
        end = first
        while end < len(marks) and marks[end][0] == "faint":
            end += 1
        early = shift_before(first)
        late = shift_after(end)
        late = early if late is None else late
        early_lost = [silenced(m, early) for m in range(first, end)]
        late_lost = [silenced(m, late) for m in range(first, end)]
        split = min(range(end - first + 1), key=lambda k: sum(early_lost[:k]) + sum(late_lost[k:]))
        for offset, m in enumerate(range(first, end)):
            gone = early_lost[offset] if offset < split else late_lost[offset]
            marks[m][0] = "lost" if gone else "quiet"
        first = end
    # The reference carries on past the recording's end.
    tail_lost = any(abs(v) > 0.00001 for v in reference[len(recorded) + shift + DRIFT:])

    def cut_inside(index, shift, leading):
        """Whether silence ends (`leading`) or starts inside this millisecond
        where the reference had sound, and the rest of it is the reference's."""
        at = marks[index][2]
        block = recorded[at:at + BLOCK]
        there = padded[max(0, at + shift):max(0, at + shift + BLOCK)]
        if at + shift < 0 or len(there) < BLOCK:
            return False
        order = range(BLOCK) if leading else range(BLOCK - 1, -1, -1)
        hushed = []
        for i in order:
            if abs(block[i]) > 0.00001:
                break
            hushed.append(i)
        rest = [i for i in range(BLOCK) if i not in hushed]
        if not hushed or not any(abs(there[i]) > 0.00001 for i in hushed):
            return False
        energy = max(sum(block[i] * block[i] for i in rest), FLOOR)
        return sum((block[i] - there[i]) ** 2 for i in rest) < MATCH * energy

    # A millisecond that matches nowhere must sit on a cut: the reference
    # skips ahead across it, or it borders silence that took the place of
    # sound, or silence ends or starts inside it where the reference had
    # sound, or it ends a recording the reference carries on past. At most
    # two in a row. Before the first, the sound should have started at the
    # reference's start, so a crackle there is not a cut.
    first = 0
    while first < len(marks):
        if marks[first][0] != "seam":
            first += 1
            continue
        end = first
        while end < len(marks) and marks[end][0] == "seam":
            end += 1
        if end - first > 2:
            return None
        before, later = shift_before(first), shift_after(end)
        cut = (later is not None and later - before > SKIP
               or first > 0 and marks[first - 1][0] == "lost"
               or end < len(marks) and marks[end][0] == "lost"
               or first > 0 and marks[first - 1][0] == "quiet" and later is not None
               and cut_inside(first, later, leading=True)
               or end < len(marks) and marks[end][0] == "quiet" and cut_inside(end - 1, before, leading=False)
               or end == len(marks) and tail_lost)
        if not cut:
            return None
        first = end
    # Something has to be missing: the start, a skip, a stretch of silence
    # in place of sound, a cut inside a millisecond, or the end.
    shifts = [marks[m][1] for m in matched]
    skipped = shifts[0] > SKIP or any(b - a > SKIP for a, b in zip(shifts, shifts[1:]))
    if not (skipped or tail_lost or any(kind in ("lost", "seam") for kind, _, _ in marks)):
        return None
    arrived = BLOCK * sum(kind in ("match", "quiet") for kind, _, _ in marks)
    return max(len(reference) - arrived, 1)


def lost(samples, cues):
    """What the speaker lost, when losing it is all that failed: a list of
    (label, milliseconds), else None (#384).

    Each failed cue is compared with one of the same kind that passed, from
    the same recording: the one with the most sound in it, since a DM chime
    can lose a stretch too quiet for the checks above to notice, and lost
    audio only ever takes sound away. Silence in place of part of a sound
    can split it in two, so cues are found here with a longer gap than the
    check's own.
    """
    spans = segments(samples, gap=12000)
    if len(spans) != len(cues):
        return None
    clean = {}
    failed = []
    for cue, (start, end) in zip(cues, spans):
        recorded = samples[start:end + 1]
        try:
            judge_cue(samples, cue, start, end)
        except AssertionError:
            failed.append((cue, recorded))
        else:
            energy = sum(v * v for v in recorded)
            if energy > clean.get(cue["cue"], (0, None))[0]:
                clean[cue["cue"]] = (energy, recorded)
    damage = []
    for cue, recorded in failed:
        reference = clean.get(cue["cue"], (0, None))[1]
        gone = None if reference is None else missing(recorded, reference)
        if gone is None:
            return None
        damage.append((cue["label"], gone / 48))
    return damage or None


def heard(recorder, output, result, program):
    """The clip's tone reached the virtual speaker, whole: about 0.8 seconds."""
    tone = 0
    peak = 0
    for _ in range(50):
        assert recorder.poll() is None, "Virtual-speaker recorder exited; see record.log"
        samples = array.array("f")
        data = (output / "output.f32").read_bytes()
        samples.frombytes(data[:len(data) // 4 * 4])
        if sys.byteorder != "little":
            samples.byteswap()
        peak = max((abs(sample) for sample in samples), default=0)
        tone = max(((end - start) / 48000 for start, end in segments(samples)), default=0)
        if peak > 0.05 and tone >= 0.6:
            break
        time.sleep(0.1)
    stop(recorder)
    assert peak > 0.05, f"The video played but its sound didn't reach the virtual speaker: peak={peak}; see {output}"
    assert tone >= 0.6, f"Only {tone:.2f} s of the video's 0.8 s tone reached the virtual speaker; see {output}"
    result["speaker_peak"] = peak
    result["speaker_tone_seconds"] = tone
    (output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(f"PASS {program.name}: a shared video's H.264 and AAC played, and its sound reached the virtual speaker "
          f"({tone:.2f} s, peak={peak:.4f})")


def check(program, output, appimage, video=False):
    output.mkdir(parents=True, exist_ok=False)
    env = dict(os.environ)
    for key in tuple(env):
        if key.startswith(("GST_", "PULSE_", "APPIMAGE", "APPDIR", "GTK3_MODULES")):
            env.pop(key)
    for key in ("DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "DBUS_SESSION_BUS_ADDRESS", "LD_LIBRARY_PATH"):
        env.pop(key, None)
    for kind in ("config", "data", "cache", "state", "runtime"):
        path = output / kind
        path.mkdir(mode=0o700)
        env[f"XDG_{kind.upper()}_HOME" if kind != "runtime" else "XDG_RUNTIME_DIR"] = str(path)
    env.update(GDK_BACKEND="x11", LINGER_LINUX_BACKEND="x11", NO_AT_BRIDGE="1", XDG_CURRENT_DESKTOP="GNOME",
               WEBKIT_DISABLE_DMABUF_RENDERER="1", WEBKIT_DISABLE_COMPOSITING_MODE="1")
    script = output / "probe.js"
    if video:
        clip = base64.b64encode(VIDEO_CLIP.read_bytes()).decode()
        script.write_text((ROOT / "scripts/video-runtime-probe.js").read_text().replace("__LINGER_VIDEO_CLIP__", clip))
        env["LINGER_AUDIO_REQUIRE"] = VIDEO_DECODERS
    else:
        subprocess.run(["node", str(ROOT / "client/scripts/build-audio-probe.mjs"), str(script)], check=True)
    module = output / "probe.so"
    flags = shlex.split(subprocess.check_output(
        ["pkg-config", "--cflags", "--libs", "webkit2gtk-4.1", "gstreamer-1.0"], text=True))
    subprocess.run(["cc", "-Wall", "-Wextra", "-Werror", "-shared", "-fPIC",
                    str(ROOT / "scripts/linux-audio-check.c"), "-o", str(module), *flags], check=True)
    pulse_socket = output / "runtime/pulse.sock"
    pulse_config = output / "pulse.pa"
    pulse_config.write_text(
        "load-module module-null-sink sink_name=linger_audio_check rate=48000 channels=1\n"
        "set-default-sink linger_audio_check\n"
        f"load-module module-native-protocol-unix socket={pulse_socket} auth-anonymous=1\n")
    env["PULSE_SERVER"] = f"unix:{pulse_socket}"
    processes = []
    try:
        with (output / "pulse.log").open("w") as log:
            pulse = subprocess.Popen(["pulseaudio", "-n", "--daemonize=no", "--use-pid-file=no",
                                      "--exit-idle-time=-1", f"--file={pulse_config}"], env=env,
                                     stdout=log, stderr=log, start_new_session=True)
        processes.append(pulse)
        for _ in range(100):
            if pulse_socket.exists():
                break
            assert pulse.poll() is None, "Private PulseAudio exited; see pulse.log"
            time.sleep(0.1)
        assert pulse_socket.exists(), "Private PulseAudio did not open its socket"
        with (output / "output.f32").open("wb") as samples, (output / "record.log").open("w") as log:
            recorder = subprocess.Popen(["parec", "--device=linger_audio_check.monitor", "--raw",
                                         "--format=float32le", "--rate=48000", "--channels=1", "--latency-msec=20"],
                                        env=env, stdout=samples, stderr=log, start_new_session=True)
        processes.append(recorder)
        # The monitor needs to be recording before a short cue can be observed.
        # A live process alone does not mean PulseAudio attached its stream.
        for _ in range(100):
            assert recorder.poll() is None, "Virtual-speaker recorder exited; see record.log"
            if (output / "output.f32").stat().st_size >= 4:
                break
            time.sleep(0.1)
        assert (output / "output.f32").stat().st_size >= 4, "Virtual-speaker recorder did not become ready"
        result_path = output / "web-audio.json"
        env.update(GTK3_MODULES=str(module), LINGER_AUDIO_RESULT=str(result_path),
                   LINGER_AUDIO_SCRIPT=str(script),
                   GST_REGISTRY_1_0=str(output / "gst-registry.bin"))
        if appimage:
            env["APPIMAGE_EXTRACT_AND_RUN"] = "1"
        with (output / "app.log").open("w") as log:
            app = subprocess.Popen(["xvfb-run", "-a", "dbus-run-session", "--", str(program)],
                                   env=env, stdout=log, stderr=log, start_new_session=True)
        processes.append(app)
        result = None
        for _ in range(600):
            if result_path.exists():
                try:
                    result = json.loads(result_path.read_text())
                except json.JSONDecodeError:
                    pass  # The GTK callback may be replacing the file.
                if result and result.get("status") != "pending":
                    break
            assert app.poll() is None, "Packaged client exited; see app.log"
            time.sleep(0.1)
        assert result and result.get("status") == "passed", f"Packaged audio failed: {result}; see {output}"
        if video:
            heard(recorder, output, result, program)
            return
        # PulseAudio's recording transport may deliver after the Web Audio
        # callback finishes. Wait for samples, not an arbitrary short sleep.
        peak = 0
        for _ in range(50):
            assert recorder.poll() is None, "Virtual-speaker recorder exited; see record.log"
            samples = array.array("f")
            data = (output / "output.f32").read_bytes()
            samples.frombytes(data[:len(data) // 4 * 4])
            if sys.byteorder != "little":
                samples.byteswap()
            peak = max((abs(sample) for sample in samples), default=0)
            spans = segments(samples)
            # A delayed backend may only have started the final cue. Require
            # its trailing silence too before judging the recorded duration.
            if (peak > 0.005 and len(spans) == len(result["cues"])
                    and len(samples) - spans[-1][1] >= 4800):
                break
            time.sleep(0.1)
        stop(recorder)
        assert peak > 0.005, f"Web Audio ran but no samples reached the virtual speaker: peak={peak}"
        try:
            onsets = judge(samples, result["cues"])
        except AssertionError as failure:
            damage = lost(samples, result["cues"])
            if damage is None:
                raise
            result["speaker_lost"] = [dict(label=label, lost_ms=ms) for label, ms in damage]
            (output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
            raise LostAudio(f"{failure}. It is the right sound with pieces missing: "
                            + ", ".join(f"{label} lost {ms:.0f} ms" for label, ms in damage)
                            + "; everything that arrived matches a clean cue from the same recording") from failure
        result["speaker_onsets"] = onsets
        result["speaker_peak"] = peak
        (output / "result.json").write_text(json.dumps(result, indent=2) + "\n")
        print(f"PASS {program.name}: packaged Web Audio reached the virtual speaker (peak={peak:.4f})")
    finally:
        for process in reversed(processes):
            stop(process)


def run(program, output, appimage, video):
    """Check, and only when the speaker lost audio, check once more (#384).

    A shared CI runner can stop for longer than the audio buffers hold, and
    part of a sound never reaches the speaker. When everything that did
    arrive is the right sound, the set plays again on a fresh app and
    speaker, and that recording has to pass. A click, a changed level or
    anything else fails at once, and so does audio lost twice: a fault in
    the app or the package happens every time. The first recording stays
    beside the second, in OUTPUT-lost.
    """
    try:
        check(program, output, appimage, video)
    except LostAudio as first:
        kept = output.with_name(output.name + "-lost")
        output.rename(kept)
        note = "::warning title=Audio lost on the way to the speaker::" if os.environ.get("GITHUB_ACTIONS") else ""
        print(f"{note}LOST {program.name}: {first}. Playing the set again once; the first recording is in {kept}",
              flush=True)
        try:
            check(program, output, appimage, video)
        except LostAudio as again:
            raise AssertionError(f"Audio was lost again on the second play, so it isn't a one-off pause: {again}") from again


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("program", type=Path)
    parser.add_argument("--appimage", action="store_true")
    parser.add_argument("--video", action="store_true", help="play an H.264 and AAC clip instead of Linger's sounds")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.output:
        run(args.program.resolve(), args.output.resolve(), args.appimage, args.video)
    else:
        with tempfile.TemporaryDirectory(prefix="linger-audio-") as area:
            run(args.program.resolve(), Path(area) / "check", args.appimage, args.video)
