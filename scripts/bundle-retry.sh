#!/usr/bin/env bash
# Runs a command (`pnpm tauri build`) and runs it once more when it failed
# while Tauri's bundler was downloading one of its tools (#916).
#
# On Windows the bundler fetches WiX, NSIS and nsis_tauri_utils.dll from
# GitHub releases whenever its folder doesn't have them, and tries each once:
# one 504 threw away a Windows package build. GitHub's cache keeps that
# folder between runs (package-check.yml), so this is for a run that has to
# fetch them; on Linux it covers the AppImage bundler's own downloads the
# same way. The bundler says `Downloading <address>` before each; when
# that's its last step before the bundle failed, the build is tried again.
# Checking or unpacking what came (Tauri's lowercase "validating hash",
# "extracting") isn't a step of its own, but only a network's failure is
# tried again. Any other failure fails at once. Another try is all of
# `tauri build` again: the frontend and the Rust are mostly cached by then,
# but it's minutes, not seconds, so it's one more try, not several.
#
#   scripts/bundle-retry.sh <command> [args…]
#
# BUNDLE_RETRY_TRIES (default 2) and BUNDLE_RETRY_WAIT (seconds between
# tries; default 30) are for its test.
set -uo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/bundle-retry.sh <command> [args…]" >&2
  exit 2
fi

tries="${BUNDLE_RETRY_TRIES:-2}"
pause="${BUNDLE_RETRY_WAIT:-30}"
# Whole numbers, read as decimal whatever zeros lead them (bash takes 08 for octal).
if ! [[ "$tries" =~ ^[0-9]+$ ]] || (( 10#$tries < 1 )); then
  echo "bundle-retry: BUNDLE_RETRY_TRIES is $tries; it must be a whole number, 1 or more" >&2
  exit 2
fi
if ! [[ "$pause" =~ ^[0-9]+$ ]]; then
  echo "bundle-retry: BUNDLE_RETRY_WAIT is $pause; it must be a whole number of seconds" >&2
  exit 2
fi
tries=$((10#$tries))
pause=$((10#$pause))

log="$(mktemp)"
trap 'rm -f "$log"' EXIT
# Ctrl-C stops it rather than counting as a failed try. (No TERM trap: one
# would wait for the build to finish before a cancelled job could stop.)
trap 'exit 130' INT

# Colours and Windows line ends, spelled by bash so any sed reads them (a
# Mac's doesn't know \x1b or \r).
esc=$'\x1b'
cr=$'\r'

# Whether it failed on a download: of the bundler's steps (a capitalised
# word like Downloading, Bundling or Running starting a line, after any
# "Info"), the last before its "failed to bundle project" is Downloading,
# and the failure, on its line or the cause lines after it, is a network's:
# a server's 5xx, 408 or 429, a timeout, or a connection dropped, refused or
# not found. Not a 404, which another try won't mend, nor a file that came
# broken, nor, say, a template that wouldn't render after the download.
# Other lines between (a warning, a progress count, an error's causes, a
# lowercase "Info validating hash") don't count either way. Colours and
# Windows line ends are taken off first.
failed_downloading() {
  sed -e "s/${esc}\[[0-9;]*[A-Za-z]//g" -e "s/${cr}\$//" "$1" | awk '
    # The reason is on the failure line or the cause lines after it, to the
    # end: the build stopped there. Only words a network uses count, never a
    # loose one an address or a path could hold (L-31: no blanket retries).
    /failed to bundle project/ { reading = (step == "Downloading") }
    reading && tolower($0) ~ /(http status|status code):? *(5[0-9][0-9]|408|429)([^0-9]|$)|timed out|timeout: |connection (reset|refused|failed|closed)|forcibly closed|close_notify|unexpected end of file|os error 100(54|60|61)|host not found|dns failed|error sending request/ { found = 1 }
    { word = ($1 == "Info") ? $2 : $1; if (word ~ /^(Downloading|Bundling|Running|Finished|Built|Compiling|Signing|Packaging|Patching|Installing)$/) step = word }
    END { exit found ? 0 : 1 }'
}

for ((try = 1; ; try++)); do
  "$@" 2>&1 | tee "$log"
  status=${PIPESTATUS[0]}
  [ "$status" -eq 0 ] && exit 0
  if [ "$try" -ge "$tries" ] || ! failed_downloading "$log"; then
    exit "$status"
  fi
  echo "bundle-retry: a bundler download failed (try $try of $tries); trying again in ${pause}s (#916)" >&2
  sleep "$pause"
done
