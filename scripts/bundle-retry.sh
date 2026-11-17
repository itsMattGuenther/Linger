#!/usr/bin/env bash
# Runs a command (`pnpm tauri build`) and runs it again when it failed while
# Tauri's bundler was downloading one of its tools (#916).
#
# On Windows the bundler fetches WiX, NSIS and nsis_tauri_utils.dll from
# GitHub releases whenever its folder doesn't have them, and tries each once:
# one 504 threw away a 15-minute package build. GitHub's cache keeps that
# folder between runs (package-check.yml), so this is for the run that has
# to fetch them. The bundler says `Downloading <address>` before each; when
# that's the last thing it said before the bundle failed, the build is tried
# once more. Any other failure fails at once. Another try is all of
# `tauri build` again: the frontend and the Rust are mostly cached by then,
# but it's minutes, not seconds, so it's one more try, not several.
#
#   scripts/bundle-retry.sh <command> [args…]
#
# BUNDLE_RETRY_TRIES (default 2) and BUNDLE_RETRY_WAIT (seconds before the
# next try, doubled after each; default 30) are for its test.
set -uo pipefail

tries="${BUNDLE_RETRY_TRIES:-2}"
wait="${BUNDLE_RETRY_WAIT:-30}"
# Whole numbers, read as decimal whatever zeros lead them (bash takes 08 for octal).
if ! [[ "$tries" =~ ^[0-9]+$ ]] || (( 10#$tries < 1 )); then
  echo "bundle-retry: BUNDLE_RETRY_TRIES is $tries; it must be a whole number, 1 or more" >&2
  exit 2
fi
if ! [[ "$wait" =~ ^[0-9]+$ ]]; then
  echo "bundle-retry: BUNDLE_RETRY_WAIT is $wait; it must be a whole number of seconds" >&2
  exit 2
fi
tries=$((10#$tries))
wait=$((10#$wait))
log="$(mktemp)"
trap 'rm -f "$log"' EXIT
# Ctrl-C, or a cancelled job, stops it rather than counting as a failed try.
trap 'exit 130' INT TERM

# Colours and Windows line ends, spelled by bash so any sed reads them (a
# Mac's doesn't know \x1b or \r).
esc=$'\x1b'
cr=$'\r'

# Whether it failed on a download: of the bundler's steps (a word like
# Downloading, Bundling or Running at the start of a line), the last before
# its "failed to bundle project" is Downloading. Other lines between, such
# as a warning, a progress count or an error's causes, don't count either
# way. Colours and Windows line ends are taken off first.
failed_downloading() {
  sed -e "s/${esc}\[[0-9;]*[A-Za-z]//g" -e "s/${cr}\$//" "$1" | awk '
    /failed to bundle project/ { if (step == "Downloading") found = 1 }
    match($0, /^[[:space:]]*(Info[[:space:]]+)?(Downloading|Bundling|Running|Finished|Built|Compiling|Signing|Packaging|Patching|Extracting|Verifying|Installing)[[:space:]]/) {
      line = $0
      sub(/^[[:space:]]*(Info[[:space:]]+)?/, "", line)
      split(line, words, /[[:space:]]+/)
      step = words[1]
    }
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
\x1b'
cr=

# Whether it failed on a download: of the bundler's steps (a word like
# Downloading, Bundling or Running at the start of a line), the last before
# its "failed to bundle project" is Downloading. Other lines between, such
# as a warning, a progress count or an error's causes, don't count either
# way. Colours and Windows line ends are taken off first.
failed_downloading() {
  sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g' -e 's/\r$//' "$1" | awk '
    /failed to bundle project/ { if (step == "Downloading") found = 1 }
    match($0, /^[[:space:]]*(Info[[:space:]]+)?(Downloading|Bundling|Running|Finished|Built|Compiling|Signing|Packaging|Patching|Extracting|Verifying|Installing)[[:space:]]/) {
      line = $0
      sub(/^[[:space:]]*(Info[[:space:]]+)?/, "", line)
      split(line, words, /[[:space:]]+/)
      step = words[1]
    }
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
\r'

# Whether it failed on a download: of the bundler's steps (a word like
# Downloading, Bundling or Running at the start of a line), the last before
# its "failed to bundle project" is Downloading. Other lines between, such
# as a warning, a progress count or an error's causes, don't count either
# way. Colours and Windows line ends are taken off first.
failed_downloading() {
  sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g' -e 's/\r$//' "$1" | awk '
    /failed to bundle project/ { if (step == "Downloading") found = 1 }
    match($0, /^[[:space:]]*(Info[[:space:]]+)?(Downloading|Bundling|Running|Finished|Built|Compiling|Signing|Packaging|Patching|Extracting|Verifying|Installing)[[:space:]]/) {
      line = $0
      sub(/^[[:space:]]*(Info[[:space:]]+)?/, "", line)
      split(line, words, /[[:space:]]+/)
      step = words[1]
    }
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
