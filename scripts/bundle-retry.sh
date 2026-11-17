#!/usr/bin/env bash
# Runs a command (`pnpm tauri build`) and runs it again when it failed while
# Tauri's bundler was downloading one of its tools (#916).
#
# On Windows the bundler fetches WiX, NSIS and nsis_tauri_utils.dll from
# GitHub releases whenever its folder doesn't have them, and tries each once:
# one 504 threw away a 15-minute package build. GitHub's cache keeps that
# folder between runs (package-check.yml), so this is for the run that has
# to fetch them. The bundler says `Downloading <address>` just before each,
# and a failed one fails the bundle on the next line; only that failure is
# tried again. The build itself is done by then, so another try costs the
# bundling, not the job.
#
#   scripts/bundle-retry.sh <command> [args…]
#
# BUNDLE_RETRY_TRIES (default 3) and BUNDLE_RETRY_WAIT (seconds before the
# second try, doubled after each; default 30) are for its test.
set -uo pipefail

tries="${BUNDLE_RETRY_TRIES:-3}"
wait="${BUNDLE_RETRY_WAIT:-30}"
log="$(mktemp)"
trap 'rm -f "$log"' EXIT

# Whether it failed on a download: the last line with anything on it before
# the bundler's "failed to bundle project" says Downloading, with colours
# and Windows line ends taken off first.
failed_downloading() {
  sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g' -e 's/\r$//' "$1" | awk '
    /failed to bundle project/ { if (last ~ /^[[:space:]]*(Info[[:space:]]+)?Downloading[[:space:]]/) found = 1 }
    NF { last = $0 }
    END { exit found ? 0 : 1 }'
}

for ((try = 1; ; try++)); do
  "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  [ "$status" -eq 0 ] && exit 0
  if [ "$try" -ge "$tries" ] || ! failed_downloading "$log"; then
    exit "$status"
  fi
  echo "bundle-retry: a bundler download failed (try $try of $tries); trying again in ${wait}s (#916)" >&2
  sleep "$wait"
  wait=$((wait * 2))
done
