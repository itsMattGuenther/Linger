#!/usr/bin/env bash
# Runs the packaged Linux app on Arch's own WebKitGTK and GStreamer, which is
# what the Arch and Omarchy package gets, in a throwaway Arch container: the
# Buddy list starts, and a shared screen plays (#729, #730). CI's other
# package checks run Ubuntu 22.04's older WebKit, which behaves differently;
# 0.5.2 shipped with watching broken on Arch's.
#
#   scripts/linux-arch-check.sh [--gpu] PROGRAM OUTPUT
#
# PROGRAM is the packaged `linger-client` (the .deb's, as the Arch package
# repackages it); OUTPUT a new folder for the evidence. It runs
# `linux-next-check.mjs` twice: with WebKit's GPU path, where VP8 and H.264
# must both play (the Arch package depends on gst-libav), and as on NVIDIA's
# legacy driver (`GDK_GL=disable`, #229), where the app must say it can't
# play one and not crash.
#
# --gpu hands the container this machine's graphics as well: every
# non-NVIDIA render node, and NVIDIA's CUDA devices and libraries, so
# GStreamer's hardware decoders (nvcodec, VA-API) are there as on a
# person's computer. A runner has no GPU, so CI can't do this; it's a step
# of every release (docs/releasing.md), run on a computer with one.
#
# Needs Docker. Nothing opens on the screen: the app runs on a virtual
# display inside the container.
set -euo pipefail

gpu=0
if [[ ${1:-} == --gpu ]]; then gpu=1; shift; fi
if (($# != 2)); then
  echo "usage: scripts/linux-arch-check.sh [--gpu] PROGRAM OUTPUT" >&2
  exit 2
fi
root=$(cd "$(dirname "$0")/.." && pwd)
program=$(realpath "$1")
output=$(realpath -m "$2")
if [[ -e $output ]]; then
  echo "linux-arch-check: $output already exists; the check writes its evidence into a new folder" >&2
  exit 1
fi
mkdir -p "$output"

devices=()
packages=()
if ((gpu)); then
  for node in /sys/class/drm/renderD*; do
    [[ -e $node ]] || continue
    # NVIDIA's render node needs NVIDIA's own GL and GBM libraries, which
    # aren't in the container; its decoders reach the card through CUDA.
    [[ $(cat "$node/device/vendor") == 0x10de ]] && continue
    devices+=(--device "/dev/dri/$(basename "$node")")
  done
  for dev in /dev/nvidia0 /dev/nvidiactl /dev/nvidia-uvm /dev/nvidia-uvm-tools; do
    [[ -e $dev ]] && devices+=(--device "$dev")
  done
  for lib in libcuda.so.1 libnvcuvid.so.1 libnvidia-ptxjitcompiler.so.1; do
    for dir in /usr/lib /usr/lib64 /usr/lib/x86_64-linux-gnu; do
      if [[ -e $dir/$lib ]]; then devices+=(-v "$(realpath "$dir/$lib"):/usr/lib/$lib:ro"); break; fi
    done
  done
  # VA-API's decoders, and the drivers for AMD's and Intel's cards.
  packages+=(gst-plugin-va libva-mesa-driver intel-media-driver)
fi

# The Arch package's depends (packaging/arch/PKGBUILD), and what the check
# itself needs: a virtual display, D-Bus, a C compiler for its probe module,
# and Node.
depends=$(sed -n "/^depends=(/,/^)/p" "$root/packaging/arch/PKGBUILD" | grep -o "'[^']*'" | tr -d "'" | tr '\n' ' ')

docker run --rm -i \
  -v "$root:/repo:ro" -v "$program:/app/linger-client:ro" -v "$output:/out" \
  "${devices[@]}" \
  -e DEPENDS="$depends" -e EXTRA="${packages[*]}" -e GPU="$gpu" -e OWNER="$(id -u):$(id -g)" \
  archlinux:latest bash -s <<'INSIDE'
set -euo pipefail
pacman -Syu --noconfirm --needed --noprogressbar $DEPENDS $EXTRA \
  xorg-server-xvfb xorg-xauth dbus gcc pkgconf nodejs >/out/pacman.log 2>&1 \
  || { tail -20 /out/pacman.log; exit 1; }
pacman -Q webkit2gtk-4.1 gstreamer gst-libav | tee /out/versions.txt
status=0
node /repo/scripts/linux-next-check.mjs /app/linger-client --webkit-gpu --h264 --output /out/gpu-path || status=1
node /repo/scripts/linux-next-check.mjs /app/linger-client --gdk-gl-disable --output /out/gdk-gl-disable || status=1
if [[ $GPU == 1 ]]; then
  gst-inspect-1.0 2>/dev/null | grep -E "^(nvcodec|va): +[a-z0-9]+dec:" > /out/hardware-decoders.txt || true
  echo "hardware decoders in the container: $(grep -c . /out/hardware-decoders.txt || true)"
fi
chown -R "$OWNER" /out
exit $status
INSIDE
