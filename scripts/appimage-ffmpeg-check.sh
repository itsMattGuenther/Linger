#!/usr/bin/env bash
# The AppImage carries Linger's trimmed FFmpeg, not the build machine's.
#
# scripts/appimage-ffmpeg.sh builds FFmpeg with only the decoders a shared
# video needs, about 4 MB (#358). Built without it, or with it off the bundler's
# LD_LIBRARY_PATH, the AppImage takes Ubuntu's FFmpeg instead, which links
# encoders, speech voices and the rest and made the AppImage 45 MB bigger. That
# AppImage still plays video, so the video check can't tell; this can.
#
# Usage: scripts/appimage-ffmpeg-check.sh LINGER.AppImage
# Needs readelf (binutils).
set -euo pipefail

[ "$#" -eq 1 ] || { sed -n '2,11s/^# \{0,1\}//p' "$0"; exit 1; }
appimage=$(realpath "$1")

LIBS=(libavcodec.so.58 libavformat.so.58 libavfilter.so.7 libavutil.so.56)
# What the trimmed build links: itself, and the C library.
ALLOWED='^(libavcodec\.so|libavformat\.so|libavfilter\.so|libavutil\.so|libswresample\.so|libm\.so\.6|libc\.so\.6)'
AVCODEC_LIMIT=6000000 # Ours is about 3 MB; Ubuntu's is 15.

area=$(mktemp -d -t linger-appimage-XXXXXX)
trap 'rm -rf "$area"' EXIT
(cd "$area" && "$appimage" --appimage-extract >/dev/null)
lib="$area/squashfs-root/usr/lib"

if [ -z "$(find "$lib" -path '*/gstreamer-1.0/libgstlibav.so' -print -quit)" ]; then
  echo "FAIL: The AppImage has no libav GStreamer plugin: shared videos' H.264 and AAC won't play"
  exit 1
fi

problems=()
for name in "${LIBS[@]}"; do
  if [ ! -e "$lib/$name" ]; then
    problems+=("$name is missing")
    continue
  fi
  # The libraries it asks the loader for: readelf's "(NEEDED) ... [libfoo.so.1]".
  extra=$(readelf -d "$lib/$name" | sed -n 's/.*(NEEDED).*\[\(.*\)\]$/\1/p' | grep -Ev "$ALLOWED" | paste -sd, - | sed 's/,/, /g' || true)
  [ -z "$extra" ] || problems+=("$name links $extra: it's the build machine's FFmpeg, not the trimmed one")
done
if [ -e "$lib/libavcodec.so.58" ]; then
  size=$(stat -c %s "$lib/libavcodec.so.58")
  [ "$size" -le "$AVCODEC_LIMIT" ] || problems+=("libavcodec.so.58 is $(awk "BEGIN { printf \"%.1f\", $size / 1e6 }") MB, over $((AVCODEC_LIMIT / 1000000))")
fi
if [ "${#problems[@]}" -gt 0 ]; then
  echo "FAIL: The AppImage's FFmpeg isn't scripts/appimage-ffmpeg.sh's:"
  printf '  %s\n' "${problems[@]}"
  exit 1
fi

total=0
for name in "${LIBS[@]}"; do total=$((total + $(stat -c %s "$lib/$name"))); done
echo "PASS $(basename "$appimage"): the trimmed FFmpeg, $(awk "BEGIN { printf \"%.1f\", $total / 1e6 }") MB, with the libav plugin"
