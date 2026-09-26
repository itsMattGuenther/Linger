#!/usr/bin/env python3
"""Check the Buddy list client starts in a packaged Linux WebView (T-1812).

Runs the unchanged package on a private virtual display with an empty profile
and no account, injects client/scripts/next-smoke-probe.js through the same
test-only GTK module the audio check uses, and waits for its verdict. Requires
cc, pkg-config, WebKitGTK/GStreamer headers, Xvfb and D-Bus.
"""

import argparse
import json
import os
from pathlib import Path
import shlex
import signal
import subprocess
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
        if key.startswith(("GST_", "PULSE_", "APPIMAGE", "APPDIR", "GTK3_MODULES", "LINGER_")):
            env.pop(key)
    for key in ("DISPLAY", "WAYLAND_DISPLAY", "WAYLAND_SOCKET", "DBUS_SESSION_BUS_ADDRESS", "LD_LIBRARY_PATH"):
        env.pop(key, None)
    for kind in ("config", "data", "cache", "state", "runtime"):
        path = output / kind
        path.mkdir(mode=0o700)
        env[f"XDG_{kind.upper()}_HOME" if kind != "runtime" else "XDG_RUNTIME_DIR"] = str(path)
    env.update(GDK_BACKEND="x11", LINGER_LINUX_BACKEND="x11", NO_AT_BRIDGE="1", XDG_CURRENT_DESKTOP="GNOME",
               GTK_OVERLAY_SCROLLING="0", WEBKIT_DISABLE_DMABUF_RENDERER="1", WEBKIT_DISABLE_COMPOSITING_MODE="1")
    module = output / "probe.so"
    flags = shlex.split(subprocess.check_output(
        ["pkg-config", "--cflags", "--libs", "webkit2gtk-4.1", "gstreamer-1.0"], text=True))
    subprocess.run(["cc", "-Wall", "-Wextra", "-Werror", "-shared", "-fPIC",
                    str(ROOT / "scripts/linux-audio-check.c"), "-o", str(module), *flags], check=True)
    result_path = output / "result.json"
    env.update(GTK3_MODULES=str(module), LINGER_AUDIO_RESULT=str(result_path),
               LINGER_AUDIO_SCRIPT=str(ROOT / "client/scripts/next-smoke-probe.js"),
               GST_REGISTRY_1_0=str(output / "gst-registry.bin"))
    if appimage:
        env["APPIMAGE_EXTRACT_AND_RUN"] = "1"
    with (output / "app.log").open("w") as log:
        app = subprocess.Popen(["xvfb-run", "-a", "-s", "-screen 0 1280x900x24", "dbus-run-session", "--", str(program)],
                               env=env, stdout=log, stderr=log, start_new_session=True)
    try:
        result = None
        for _ in range(900):
            if result_path.exists():
                try:
                    result = json.loads(result_path.read_text())
                except json.JSONDecodeError:
                    pass
                if result and result.get("status") != "pending":
                    break
            assert app.poll() is None, "Packaged client exited; see app.log"
            time.sleep(0.1)
        assert result and result.get("status") == "passed", f"The Buddy list didn't start: {result}; see {output}"
        print(f"PASS {program.name}: the Buddy list starts in the packaged WebView: {json.dumps(result['checks'])}")
    finally:
        stop(app)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("program", type=Path)
    parser.add_argument("--appimage", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    check(args.program.resolve(), args.output.resolve(), args.appimage)
