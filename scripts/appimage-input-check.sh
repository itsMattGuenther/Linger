#!/usr/bin/env bash
# Actual package, private compositor, synthetic input. Installs nothing.
set -euo pipefail

if [[ ${1:-} == --inside ]]; then
  [[ ${LINGER_PRIVATE_INPUT_DISPLAY:-} == 1 && $WLR_BACKENDS == headless ]]
  [[ $XDG_RUNTIME_DIR == "$LINGER_CHECK_AREA/runtime" ]]
  input_app_pid=
  wtype -k Shift_L -s 120000 &
  input_keyboard_pid=$!
  cleanup_session() {
    [[ -z $input_app_pid ]] || kill "$input_app_pid" 2>/dev/null || true
    kill "$input_keyboard_pid" 2>/dev/null || true
  }
  trap cleanup_session EXIT
  [[ $LINGER_CHECK_BACKEND == default ]] || export LINGER_LINUX_BACKEND="$LINGER_CHECK_BACKEND"
  export GTK3_MODULES="$LINGER_CHECK_AREA/probe.so" APPIMAGE_EXTRACT_AND_RUN=1
  "$LINGER_CHECK_PACKAGE" >"$LINGER_CHECK_AREA/app.log" 2>&1 &
  input_app_pid=$!
  for ((attempt=0; attempt<150; attempt++)); do
    [[ ! -f $LINGER_CHECK_AREA/completed ]] || break
    kill -0 "$input_app_pid" 2>/dev/null || exit 1
    sleep 0.2
  done
  [[ -f $LINGER_CHECK_AREA/completed ]] || exit 1
  grim "$LINGER_CHECK_AREA/window.png"
  exit 0
fi

[[ $# -ge 1 && $# -le 3 ]] || { echo 'Usage: scripts/appimage-input-check.sh APPIMAGE [wayland|x11|default] [NEW-EVIDENCE-DIR]' >&2; exit 1; }
input_package=$(realpath "$1")
[[ -f $input_package && -x $input_package ]] || { echo 'Supply an executable AppImage.' >&2; exit 1; }
[[ $(od -An -j8 -N3 -tx1 "$input_package" | tr -d ' \n') == 414902 ]] || {
  echo 'This check requires a type-2 AppImage, not a standalone development binary.' >&2; exit 1;
}
input_backend=${2:-wayland}
[[ $input_backend == wayland || $input_backend == x11 || $input_backend == default ]] || exit 1
for input_tool in cc pkg-config labwc Xwayland wtype wl-copy dbus-run-session timeout grim rg; do
  command -v "$input_tool" >/dev/null || { echo "Missing test tool: $input_tool" >&2; exit 1; }
done
input_repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
input_keep=false
if [[ $# == 3 ]]; then
  [[ ! -e $3 ]] || { echo 'Evidence directory must not already exist.' >&2; exit 1; }
  mkdir -m 700 -- "$3"
  input_area=$(realpath "$3")
  input_keep=true
else
  input_area=$(mktemp -d /tmp/linger-packaged-input.XXXXXX)
fi
cleanup() { if [[ $input_keep == false ]]; then rm -r -- "$input_area"; fi; }
trap cleanup EXIT
mkdir -p "$input_area"/{runtime,config,data,cache,state}
chmod 700 "$input_area/runtime"
# shellcheck disable=SC2046
cc -Wall -Wextra -Werror -shared -fPIC "$input_repo/scripts/appimage-input-check.c" \
  -o "$input_area/probe.so" $(pkg-config --cflags --libs webkit2gtk-4.1)
printf -v input_session 'bash %q --inside' "$input_repo/scripts/appimage-input-check.sh"
input_result=0
env -u WAYLAND_DISPLAY -u WAYLAND_SOCKET -u DISPLAY -u HYPRLAND_INSTANCE_SIGNATURE \
  -u DBUS_SESSION_BUS_ADDRESS -u GDK_BACKEND -u LINGER_LINUX_BACKEND -u GTK3_MODULES \
  -u WEBKIT_DMABUF_RENDERER_DISABLE_GBM \
  XDG_RUNTIME_DIR="$input_area/runtime" XDG_CONFIG_HOME="$input_area/config" XDG_CONFIG_DIRS="$input_area/config" \
  XDG_DATA_HOME="$input_area/data" XDG_STATE_HOME="$input_area/state" XDG_CACHE_HOME="$input_area/cache" \
  XDG_CURRENT_DESKTOP=labwc WLR_BACKENDS=headless WLR_RENDERER=pixman NO_AT_BRIDGE=1 \
  WEBKIT_DISABLE_DMABUF_RENDERER=1 \
  LINGER_PRIVATE_INPUT_DISPLAY=1 LINGER_CHECK_AREA="$input_area" \
  LINGER_CHECK_PACKAGE="$input_package" LINGER_CHECK_BACKEND="$input_backend" \
  dbus-run-session -- labwc -C "$input_area/config" -S "$input_session" \
  >"$input_area/session.log" 2>"$input_area/desktop.log" || input_result=$?
[[ $input_keep == false ]] || echo "Evidence: $input_area"
[[ $input_result == 0 && -f $input_area/completed ]] || { echo 'Packaged check did not finish.' >&2; exit 1; }
rg '^packaged (typing|clipboard): (MATCH|DIFFERENT)$' "$input_area/probe.log"
[[ $(wc -l < "$input_area/probe.log") == 2 ]] || exit 1
rg -qx 'packaged clipboard: MATCH' "$input_area/probe.log"
[[ $(<"$input_area/gbm") == 1 ]]
if [[ $input_backend == wayland || $input_backend == default ]]; then
  [[ $(<"$input_area/backend") == GdkWaylandDisplay ]]
  rg -qx 'packaged typing: MATCH' "$input_area/probe.log"
else
  [[ $(<"$input_area/backend") == GdkX11Display ]]
  # DIFFERENT is a reproduced XWayland failure, not a passing typing result.
fi
