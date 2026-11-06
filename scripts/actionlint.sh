#!/usr/bin/env bash
# Checks the workflow files with actionlint, which also shellchecks each step.
# A broken workflow doesn't fail; it just doesn't run. CI's rules job and
# check.sh both run this, so they check with the same version, the one named
# here.
#
# The image comes from Docker Hub, and one 502 there failed the rules job of a
# pull request with nothing wrong in it (#874). `docker run` fetches a missing
# image itself with nothing to try again, so the download is its own step: a
# failed try is tried again five times, 1, 2, 4, 8 and 16 s apart, as
# appimage-fetch.sh does, and the log says so. Each try gets
# LINGER_PULL_MAX_TIME seconds (default 90), since a server can also just never
# answer; six of them stay inside the rules job's limit. A Mac has no
# `timeout`, so there a try can wait as long as Docker does.
#
# Only the download is tried again. actionlint runs once, and what it finds
# fails at once. A copy of the image already here is used without asking.
# Ctrl-C stops it, and isn't counted as a failed try: docker can exit on it
# like any other failure, which bash alone would carry on from, so the trap
# says it was stopped, and --foreground keeps `timeout` and docker in the
# group Ctrl-C reaches.
#
# The container has no network, and needs none: on Docker's own network it adds
# a network interface to the machine for a moment, and Chromium in any other
# check.sh running beside this one drops its page loads (#528).
#
# Usage: scripts/actionlint.sh [actionlint's flags, such as -color]
set -euo pipefail
cd "$(dirname "$0")/.."

image=rhysd/actionlint:1.7.12

pull() {
  if command -v timeout >/dev/null; then
    timeout --foreground "${LINGER_PULL_MAX_TIME:-90}" docker pull -q "$image" >/dev/null
  else
    docker pull -q "$image" >/dev/null
  fi
}

trap 'exit 130' INT

if ! docker image inspect "$image" >/dev/null 2>&1; then
  pause=1
  until pull; do
    if [ "$pause" -gt 16 ]; then
      echo "actionlint: couldn't download $image after 6 tries" >&2
      exit 1
    fi
    echo "actionlint: downloading $image failed; trying again in $pause s" >&2
    sleep "$pause"
    pause=$((pause * 2))
  done
fi

docker run --rm --network none -v "$PWD:/repo:ro" -w /repo "$image" "$@"
