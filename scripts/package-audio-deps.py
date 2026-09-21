#!/usr/bin/env python3
"""Verify required audio plugins in the actual DEB/RPM dependency metadata."""
import argparse
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("bundle", type=Path)
args = parser.parse_args()
deb, = (args.bundle / "deb").glob("*.deb")
rpm, = (args.bundle / "rpm").glob("*.rpm")
deb_requires = subprocess.check_output(["dpkg-deb", "-f", str(deb), "Depends"], text=True)
for name in ("gstreamer1.0-plugins-base", "gstreamer1.0-plugins-good", "gstreamer1.0-pulseaudio"):
    assert name in {part.strip().split()[0] for part in deb_requires.split(",")}, f"DEB missing {name}"
rpm_requires = subprocess.check_output(["rpm", "-qp", "--requires", str(rpm)], text=True).splitlines()
# File dependencies work with Fedora and openSUSE's different package names.
for plugin in ("app", "audioconvert", "audioresample", "coreelements", "interleave", "autodetect", "pulseaudio"):
    path = f"/usr/lib64/gstreamer-1.0/libgst{plugin}.so"
    assert path in rpm_requires, f"RPM missing {path}"
print("PASS DEB and RPM declare all required audio playback plugins")
