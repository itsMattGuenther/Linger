#!/usr/bin/env bash
# Checks the Linux AppImage carries no libwayland of its own (#479).
#
# A bundled libwayland goes ahead of the system's, and a newer Mesa's EGL
# driver can't load against an old one: WebKit then aborts and the window
# stays empty. scripts/appimage-linuxdeploy.sh and the build's
# LINUXDEPLOY_EXCLUDED_LIBRARIES keep it out; this fails the build if one
# gets in anyway, by a change to Tauri, linuxdeploy or its GTK plugin.
#
# Usage: scripts/appimage-wayland-check.sh path/to/Linger.AppImage
set -euo pipefail

appimage="$(realpath "${1:?usage: scripts/appimage-wayland-check.sh path/to/Linger.AppImage}")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

(cd "$work" && "$appimage" --appimage-extract >/dev/null)
found="$(find "$work/squashfs-root" -name 'libwayland-*' -printf '%P\n' | sort)"
if [ -n "$found" ]; then
  echo "The AppImage carries its own libwayland, which breaks newer Mesa (#479):" >&2
  echo "$found" >&2
  exit 1
fi
echo "The AppImage carries no libwayland: the system's is used."
