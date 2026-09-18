#!/usr/bin/env bash
# One version number, in four files (T-701, T-703).
#
# The updater compares the version in the running bundle against the version in
# the release manifest. If `tauri.conf.json` says 0.1.0 while the tag says
# v0.2.0, the release ships as 0.1.0 and every installed copy decides it is
# already up to date — a silent no-op that looks exactly like success. This is
# the check that stops that, and the release workflow runs it before it builds
# anything.
#
# The fourth file is the root `Cargo.toml`, which is the server's version: a
# tag also publishes `ghcr.io/itsmattguenther/linger:<tag>`, and that image's
# `GET /health` reports whatever this number says. A host reading it to find
# out what they are running deserves an answer that is true.
#
# Usage: scripts/version-check.sh [tag]
#   With a tag (v0.2.0 or 0.2.0), the tag has to agree with the files too.
set -euo pipefail
cd "$(dirname "$0")/.."

conf=$(python3 -c 'import json;print(json.load(open("client/src-tauri/tauri.conf.json"))["version"])')
pkg=$(python3 -c 'import json;print(json.load(open("client/package.json"))["version"])')
crate=$(sed -n 's/^version = "\(.*\)"$/\1/p' client/src-tauri/Cargo.toml | head -1)
server=$(sed -n 's/^version = "\(.*\)"$/\1/p' Cargo.toml | head -1)

fail=0
report() { echo "FAIL: $1"; fail=1; }

[ "$conf" = "$pkg" ] || report "client/package.json says $pkg, tauri.conf.json says $conf"
[ "$conf" = "$crate" ] || report "client/src-tauri/Cargo.toml says $crate, tauri.conf.json says $conf"
[ "$conf" = "$server" ] || report "Cargo.toml (the server) says $server, tauri.conf.json says $conf"

if [ -n "${1:-}" ]; then
  tag="${1#refs/tags/}"
  tag="${tag#v}"
  [ "$tag" = "$conf" ] || report "the tag says $tag, tauri.conf.json says $conf"
fi

if [ "$fail" -eq 0 ]; then
  echo "version check: $conf everywhere"
else
  echo "Bump all four together, then tag."
fi
exit "$fail"
