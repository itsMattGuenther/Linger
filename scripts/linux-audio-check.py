#!/usr/bin/env python3
"""Check a packaged Linux WebView against a private, recorded virtual speaker.

No accounts, real desktop, microphone or physical speaker are used. Requires
cc, pkg-config, WebKitGTK/GStreamer headers, Xvfb, D-Bus and PulseAudio tools.
"""

import argparse
import array
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


def stop(process):
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


def check(program, output, appimage):
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
        result_path = output / "result.json"
        env.update(GTK3_MODULES=str(module), LINGER_AUDIO_RESULT=str(result_path),
                   LINGER_AUDIO_SCRIPT=str(ROOT / "scripts/audio-runtime-probe.js"),
                   GST_REGISTRY_1_0=str(output / "gst-registry.bin"))
        if appimage:
            env["APPIMAGE_EXTRACT_AND_RUN"] = "1"
        with (output / "app.log").open("w") as log:
            app = subprocess.Popen(["xvfb-run", "-a", "dbus-run-session", "--", str(program)],
                                   env=env, stdout=log, stderr=log, start_new_session=True)
        processes.append(app)
        result = None
        for _ in range(300):
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
            if peak > 0.005:
                break
            time.sleep(0.1)
        stop(recorder)
        assert peak > 0.005, f"Web Audio ran but no samples reached the virtual speaker: peak={peak}"
        result["speaker_peak"] = peak
        result_path.write_text(json.dumps(result, indent=2) + "\n")
        print(f"PASS {program.name}: packaged Web Audio reached the virtual speaker (peak={peak:.4f})")
    finally:
        for process in reversed(processes):
            stop(process)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("program", type=Path)
    parser.add_argument("--appimage", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.output:
        check(args.program.resolve(), args.output.resolve(), args.appimage)
    else:
        with tempfile.TemporaryDirectory(prefix="linger-audio-") as area:
            check(args.program.resolve(), Path(area) / "check", args.appimage)
