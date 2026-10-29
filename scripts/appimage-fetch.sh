#!/usr/bin/env bash
# Downloads a file the AppImage build pins by its checksum, through a slow or
# failing server, and keeps a copy so the next build needn't ask (#753).
#
# One slow moment at ffmpeg.org failed a package build: curl waited 133 s to
# connect, gave up, and nothing tried again. Here each try gets 30 s to
# connect and LINGER_FETCH_MAX_TIME seconds (default 300) to finish, and a
# failed one is tried again five times, 1, 2, 4, 8 and 16 s apart. Any error
# counts, a reset connection or a 503 as much as a timeout; the checksum makes
# sure what came is the file pinned, whichever try it came on. curl says each
# retry in the log.
#
# The copy is kept in LINGER_DOWNLOADS (default ~/.cache/linger-downloads)
# under its checksum, and checked again before every use, so a copy restored
# from CI's cache is never trusted for its name. The workflows keep that
# directory between runs.
#
# Usage: scripts/appimage-fetch.sh URL SHA256 DEST
# Needs curl 7.71 or later and sha256sum.
set -euo pipefail

usage="usage: scripts/appimage-fetch.sh URL SHA256 DEST"
url="${1:?$usage}"
sha256="${2:?$usage}"
dest="${3:?$usage}"

store="${LINGER_DOWNLOADS:-${XDG_CACHE_HOME:-$HOME/.cache}/linger-downloads}"
mkdir -p "$store"
kept="$store/$sha256"

pinned() { echo "$sha256  $1" | sha256sum --check --status 2>/dev/null; }

if [[ -f $kept ]] && pinned "$kept"; then
  echo "$(basename "$url"): the copy kept in $store"
else
  rm -f "$kept"
  part="$(mktemp "$store/.part.XXXXXX")"
  trap 'rm -f "$part"' EXIT
  curl -fL --no-progress-meter --retry 5 --retry-all-errors --connect-timeout 30 \
    --max-time "${LINGER_FETCH_MAX_TIME:-300}" -o "$part" "$url"
  if ! pinned "$part"; then
    echo "appimage-fetch: $url isn't the file pinned (sha256 $sha256)" >&2
    exit 1
  fi
  mv "$part" "$kept"
  echo "$(basename "$url"): downloaded"
fi
cp "$kept" "$dest"
