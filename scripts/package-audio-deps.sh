#!/usr/bin/env bash
# The .deb and .rpm ask for the sound and video plugins Linger plays with (#87),
# read from the packages' own metadata, as a package manager reads them. What
# it can't play without is required; FFmpeg's decoders are only recommended
# (#358, #377).
#
# Usage: scripts/package-audio-deps.sh BUNDLE_DIR   (target/<profile>/bundle)
# Needs dpkg-deb and rpm.
set -euo pipefail

bundle=${1:?usage: scripts/package-audio-deps.sh BUNDLE_DIR}
shopt -s nullglob
debs=("$bundle"/deb/*.deb)
rpms=("$bundle"/rpm/*.rpm)
[ "${#debs[@]}" -eq 1 ] || { echo "FAIL: expected one .deb in $bundle/deb, found ${#debs[@]}"; exit 1; }
[ "${#rpms[@]}" -eq 1 ] || { echo "FAIL: expected one .rpm in $bundle/rpm, found ${#rpms[@]}"; exit 1; }
deb=${debs[0]}
rpm=${rpms[0]}

fail=0
report() { echo "FAIL: $1"; fail=1; }

# A Depends or Recommends field as package names, one a line: the first word of
# each comma-separated part, so a version or an alternative doesn't hide it.
names() { tr ',' '\n' | awk 'NF { print $1 }'; }

deb_requires=$(dpkg-deb -f "$deb" Depends)
for name in gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-pulseaudio; do
  names <<<"$deb_requires" | grep -qxF "$name" || report "DEB missing $name"
done
# gstreamer1.0-libav: the AAC and H.264 decoders shared videos need (#358).
# Recommended, not required: an in-app update installs the .deb with dpkg,
# which can't fetch a new requirement and leaves apt broken without it (#377).
dpkg-deb -f "$deb" Recommends | names | grep -qxF gstreamer1.0-libav || report "DEB doesn't recommend gstreamer1.0-libav"
if grep -qF gstreamer1.0-libav <<<"$deb_requires"; then report "DEB requires gstreamer1.0-libav outright"; fi

rpm_requires=$(rpm -qp --requires "$rpm")
# File dependencies work with Fedora and openSUSE's different package names.
for plugin in app audioconvert audioresample coreelements interleave autodetect pulseaudio; do
  path="/usr/lib64/gstreamer-1.0/libgst$plugin.so"
  grep -qxF "$path" <<<"$rpm_requires" || report "RPM missing $path"
done
# Recommended, not required: Fedora has it as gstreamer1-plugin-libav, and
# other RPM distributions name it differently or keep it elsewhere, where a
# hard requirement would stop Linger installing at all (#358).
rpm -qp --recommends "$rpm" | grep -qxF gstreamer1-plugin-libav || report "RPM doesn't recommend gstreamer1-plugin-libav"

[ "$fail" -eq 0 ] || exit 1
echo "PASS DEB and RPM declare all required audio and video playback plugins"
