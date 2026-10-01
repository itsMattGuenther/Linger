#!/usr/bin/env python3
"""Verify required audio and video plugins in the actual DEB/RPM dependency metadata."""
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
# gstreamer1.0-libav: the AAC and H.264 decoders shared videos need (#358).
# Recommended, not required: an in-app update installs the .deb with dpkg,
# which can't fetch a new requirement and leaves apt broken without it (#377).
deb_recommends = subprocess.check_output(["dpkg-deb", "-f", str(deb), "Recommends"], text=True)
assert "gstreamer1.0-libav" in {part.strip().split()[0] for part in deb_recommends.split(",") if part.strip()}, "DEB doesn't recommend gstreamer1.0-libav"
assert "gstreamer1.0-libav" not in deb_requires, "DEB requires gstreamer1.0-libav outright"
rpm_requires = subprocess.check_output(["rpm", "-qp", "--requires", str(rpm)], text=True).splitlines()
# File dependencies work with Fedora and openSUSE's different package names.
for plugin in ("app", "audioconvert", "audioresample", "coreelements", "interleave", "autodetect", "pulseaudio"):
    path = f"/usr/lib64/gstreamer-1.0/libgst{plugin}.so"
    assert path in rpm_requires, f"RPM missing {path}"
# Recommended, not required: Fedora has it as gstreamer1-plugin-libav, and
# other RPM distributions name it differently or keep it elsewhere, where a
# hard requirement would stop Linger installing at all (#358).
rpm_recommends = subprocess.check_output(["rpm", "-qp", "--recommends", str(rpm)], text=True).splitlines()
assert "gstreamer1-plugin-libav" in rpm_recommends, "RPM doesn't recommend gstreamer1-plugin-libav"
print("PASS DEB and RPM declare all required audio and video playback plugins")
