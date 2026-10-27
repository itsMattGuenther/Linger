#!/usr/bin/env bash
# Installs Ubuntu packages on a CI runner without waiting out a crawling
# mirror. Every Linux job that installs packages comes through here, most
# through .github/actions/apt-install, which keeps the packages between runs.
#
# Some nights the first mirror on GitHub's list, Azure's, didn't fail but sent
# a few kilobytes a second, and apt, which moves on only from a mirror that
# fails, sat on it until the job's time ran out (#717, and twice on
# 2026-10-26). scripts/apt-mirrors.sh checks the mirrors before anything is
# fetched; a mirror can still turn slow after that check, so here every fetch
# has a time limit too. A fetch that runs out of time puts the mirror it was
# using at the back of the list and tries again, once, from the next.
#
# Packages are fetched first and installed after (`--download-only`), so the
# limit only ever stops a download: an install stopped half way would leave
# dpkg in pieces.
#
#   scripts/apt-install.sh [--no-update] [--no-recommends] package...
#
# --no-update installs from the lists an earlier step already fetched;
# --no-recommends leaves out what the packages only recommend, as apt's own
# flag does.
# APT_DEBS is where the packages are fetched to and kept, the directory
# .github/actions/apt-install keeps between runs; without it, apt's own. Once
# they're in, the script writes `key=` with a hash of what's there to
# $GITHUB_OUTPUT, so the action keeps a new copy only when it changed.
#
# APT_GET, APT_AS, APT_MIRRORS_SH, APT_UPDATE_SECONDS and APT_FETCH_SECONDS
# are for its test, scripts/apt-install-test.sh.
set -euo pipefail

update=1 recommends=1
while [[ ${1:-} == --* ]]; do
  case $1 in
    --no-update) update=0 ;;
    --no-recommends) recommends=0 ;;
    *) echo "apt-install: $1 isn't one of its flags" >&2; exit 2 ;;
  esac
  shift
done
if (($# == 0)); then
  echo "apt-install: name the packages to install" >&2
  exit 2
fi

apt_get=${APT_GET:-apt-get}
read -r -a as <<< "${APT_AS-sudo}"
mirrors=${APT_MIRRORS_SH:-$(dirname "$0")/apt-mirrors.sh}
update_seconds=${APT_UPDATE_SECONDS:-240}
fetch_seconds=${APT_FETCH_SECONDS:-480}

options=(-y -q -o Dpkg::Use-Pty=0)
if ((!recommends)); then options+=(--no-install-recommends); fi
if [[ -n ${APT_DEBS:-} ]]; then
  mkdir -p "$APT_DEBS/partial"
  # The kept packages are apt's own archive; fetched as root, since the
  # runner owns the directory and apt's sandbox user can't write to it.
  options+=(-o "Dir::Cache::Archives=$APT_DEBS" -o APT::Sandbox::User=root)
fi

# Runs `apt-get ...` within `seconds`; true if it finished in time and
# worked. A run past its time is stopped, and says so.
within() {
  local seconds=$1 status=0
  shift
  "${as[@]}" timeout --kill-after=30 "$seconds" "$apt_get" "$@" || status=$?
  if ((status == 124 || status == 137)); then
    echo "::warning title=apt install::apt-get $1 was still going after ${seconds}s; trying the next mirror"
  fi
  return "$status"
}

# After a fetch that ran out of time, or failed: the mirror it was using
# goes to the back, and the lists come again, from the next. The fetch is
# then tried once more; a second failure fails the step.
next_mirror() {
  bash "$mirrors" --first-is-slow
  within "$update_seconds" update -q
}

bash "$mirrors"
if ((update)); then
  within "$update_seconds" update -q || next_mirror
fi
within "$fetch_seconds" install --download-only "${options[@]}" "$@" \
  || { next_mirror && within "$fetch_seconds" install --download-only "${options[@]}" "$@"; }
# Everything's here now: installing touches no mirror.
"${as[@]}" "$apt_get" install "${options[@]}" "$@"

if [[ -n ${APT_DEBS:-} ]]; then
  # Versions the mirrors no longer have go, so the copy kept doesn't grow
  # with every update Ubuntu ships. Then it's the runner's again, apt's lock
  # and half-fetched files left out, for GitHub's cache to read.
  "${as[@]}" "$apt_get" autoclean -q -o "Dir::Cache::Archives=$APT_DEBS" || true
  "${as[@]}" rm -rf "$APT_DEBS/lock" "$APT_DEBS/partial"
  "${as[@]}" chown -R "$(id -u):$(id -g)" "$APT_DEBS"
fi
if [[ -n ${APT_DEBS:-} && -n ${GITHUB_OUTPUT:-} ]]; then
  key=$(find "$APT_DEBS" -maxdepth 1 -name '*.deb' -printf '%f\n' | sort | sha256sum | cut -c1-16)
  echo "key=$key" >> "$GITHUB_OUTPUT"
fi
