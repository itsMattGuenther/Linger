#!/usr/bin/env python3
"""The AppImage carries Linger's trimmed FFmpeg, not the build machine's.

scripts/appimage-ffmpeg.sh builds FFmpeg with only the decoders a shared
video needs, about 4 MB (#358). Built without it, or with it off the bundler's
LD_LIBRARY_PATH, the AppImage takes Ubuntu's FFmpeg instead, which links
encoders, speech voices and the rest and made the AppImage 45 MB bigger. That
AppImage still plays video, so the video check can't tell; this can.

Usage: scripts/appimage-ffmpeg-check.py LINGER.AppImage
Needs readelf (binutils).
"""

import subprocess
import sys
import tempfile
from pathlib import Path

LIBS = ("libavcodec.so.58", "libavformat.so.58", "libavfilter.so.7", "libavutil.so.56")
# What the trimmed build links: itself, and the C library.
ALLOWED = ("libavcodec.so", "libavformat.so", "libavfilter.so", "libavutil.so", "libswresample.so",
           "libm.so.6", "libc.so.6")
AVCODEC_LIMIT = 6_000_000  # Ours is about 3 MB; Ubuntu's is 15.


def needed(library):
    dynamic = subprocess.run(["readelf", "-d", str(library)], check=True, capture_output=True, text=True).stdout
    return [line.split("[", 1)[1].rstrip("]") for line in dynamic.splitlines() if "(NEEDED)" in line]


def check(appimage):
    with tempfile.TemporaryDirectory(prefix="linger-appimage-") as area:
        subprocess.run([str(appimage), "--appimage-extract"], cwd=area, check=True, stdout=subprocess.DEVNULL)
        lib = Path(area) / "squashfs-root/usr/lib"
        plugin = next(lib.glob("**/gstreamer-1.0/libgstlibav.so"), None)
        assert plugin, "The AppImage has no libav GStreamer plugin: shared videos' H.264 and AAC won't play"
        problems = []
        for name in LIBS:
            path = lib / name
            if not path.exists():
                problems.append(f"{name} is missing")
                continue
            extra = [dep for dep in needed(path) if not dep.startswith(ALLOWED)]
            if extra:
                problems.append(f"{name} links {', '.join(extra)}: it's the build machine's FFmpeg, not the trimmed one")
        avcodec = lib / "libavcodec.so.58"
        if avcodec.exists() and avcodec.stat().st_size > AVCODEC_LIMIT:
            problems.append(f"libavcodec.so.58 is {avcodec.stat().st_size / 1e6:.1f} MB, over {AVCODEC_LIMIT / 1e6:.0f}")
        assert not problems, "The AppImage's FFmpeg isn't scripts/appimage-ffmpeg.sh's:\n  " + "\n  ".join(problems)
        sizes = sum((lib / name).stat().st_size for name in LIBS)
        print(f"PASS {appimage.name}: the trimmed FFmpeg, {sizes / 1e6:.1f} MB, with the libav plugin")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    check(Path(sys.argv[1]).resolve())
