#!/usr/bin/env bash
# The linuxdeploy the Linux AppImage is built with, newer than Tauri's own
# (#479).
#
# Tauri 2.11's AppImage bundler downloads a linuxdeploy from July 2024, which
# copies the build machine's libwayland (Ubuntu 22.04's 1.20) into the
# AppImage, ahead of the system's. Mesa 26.2's EGL driver needs functions
# libwayland only gained later, so on a newer Mesa (an AMD or Intel GPU on
# Arch, Omarchy, Fedora) it fails to load, WebKit can't create its EGL display
# ("Could not create default EGL display: EGL_BAD_PARAMETER") and its page
# process aborts: an empty window, every launch. Every Linux desktop that runs
# this AppImage has its own libwayland, as GTK needs it, so the AppImage
# shouldn't carry one.
#
# Tauri's fix (tauri-apps/tauri#15976, merged as #16062 on 2026-09-25) moves
# to linuxdeploy at commit 07333c6, which leaves libwayland-client out and
# takes LINUXDEPLOY_EXCLUDED_LIBRARIES; it isn't in a Tauri release yet. This
# puts that same linuxdeploy where Tauri 2.11's bundler looks before it
# downloads its own (~/.cache/tauri), so it builds with it. The build step
# sets LINUXDEPLOY_EXCLUDED_LIBRARIES=libwayland-* for the other three
# (server, cursor, egl), and scripts/appimage-wayland-check.sh checks none got
# in. A Tauri with the fix looks for a differently named file and fetches the
# same build itself, so this then does nothing and can go.
#
# Usage: scripts/appimage-linuxdeploy.sh
# Needs curl and sha256sum.
set -euo pipefail

COMMIT=07333c6
SHA256=36a2d7e274d12e1050d0e9ecfe11d339ed54720b2bec464c286d53f8b07f5c62
URL="https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy-$COMMIT/linuxdeploy-x86_64.AppImage"

tools="${XDG_CACHE_HOME:-$HOME/.cache}/tauri"
mkdir -p "$tools"
target="$tools/linuxdeploy-x86_64.AppImage"
download="$(mktemp "$tools/linuxdeploy.XXXXXX")"
trap 'rm -f "$download"' EXIT

curl -sSfL --retry 3 -o "$download" "$URL"
echo "$SHA256  $download" | sha256sum --check --quiet
chmod +x "$download"
mv "$download" "$target"
echo "linuxdeploy $COMMIT at $target"
