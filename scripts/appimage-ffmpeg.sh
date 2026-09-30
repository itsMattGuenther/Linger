#!/usr/bin/env bash
# The FFmpeg the Linux AppImage carries, with only the decoders a shared video
# needs (#358).
#
# The AppImage carries the build machine's GStreamer plugins
# (bundleMediaFramework), and GStreamer's H.264 and AAC decoders are the libav
# plugin (gstreamer1.0-libav), which runs on FFmpeg's libraries. Ubuntu builds
# FFmpeg with everything, and all of it came along: 45 MB more AppImage for an
# H.265 encoder, a ham radio codec, speech synthesis voices and the like. This
# builds the same FFmpeg release as Ubuntu 22.04's (4.4.2, so Ubuntu's libav
# plugin runs on it unchanged) with the decoders for phone videos, screen
# recordings and MP4s and nothing else: about 4 MB, about 1 MB compressed.
# WebM (VP8, VP9, Opus, Vorbis) doesn't need it; plugins-good and -base play it.
#
# No GPL parts are enabled, so this build is LGPL 2.1 or later. Its source is
# the release tarball below, fetched from ffmpeg.org and checked against a
# checksum pinned here (the tarball's signature by FFmpeg's release key,
# FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8, was checked when it was
# pinned), plus these configure flags.
#
# Usage: scripts/appimage-ffmpeg.sh PREFIX
#   Builds into PREFIX/lib. Put PREFIX/lib on LD_LIBRARY_PATH for `tauri build`,
#   so the AppImage bundler takes these libraries instead of the system's.
# Needs a C compiler, make, nasm and curl.
set -euo pipefail

VERSION=4.4.2
SHA256=af419a7f88adbc56c758ab19b4c708afbcae15ef09606b82b855291f6a6faa93

prefix="${1:?usage: scripts/appimage-ffmpeg.sh PREFIX}"
mkdir -p "$prefix"
prefix="$(cd "$prefix" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -fsSL "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz" -o "$work/ffmpeg.tar.xz"
echo "$SHA256  $work/ffmpeg.tar.xz" | sha256sum -c --quiet
tar -xJf "$work/ffmpeg.tar.xz" -C "$work"
cd "$work/ffmpeg-$VERSION"

# Only what the libav plugin links (avcodec, avformat, avfilter, avutil, and
# swresample under avcodec), with nothing in them but the decoders and their
# parsers. avformat has no demuxers: WebKit's GStreamer uses its own.
# yadif and its buffers keep the plugin's deinterlacer whole.
./configure --prefix="$prefix" --enable-shared --disable-static \
  --disable-programs --disable-doc --disable-everything --disable-autodetect \
  --disable-network --disable-avdevice --disable-swscale --disable-postproc \
  --enable-decoder=h264,hevc,aac,aac_latm,mp3,mp3float \
  --enable-parser=h264,hevc,aac,aac_latm,mpegaudio \
  --enable-filter=yadif,buffer,buffersink,abuffer,abuffersink \
  >"$work/configure.log" || { cat "$work/configure.log" >&2; exit 1; }
make -j"$(nproc)" >"$work/make.log" 2>&1 || { tail -50 "$work/make.log" >&2; exit 1; }
make install >/dev/null
echo "FFmpeg $VERSION for the AppImage, in $prefix/lib:"
du -b "$prefix"/lib/lib*.so.*.*.* | awk '{ printf "  %5.2f MB  %s\n", $1 / 1e6, $2 }'
