#!/usr/bin/env bash
# Tests for `scripts/apt-mirrors.sh`: a mirror that crawls, doesn't answer or
# lacks the index goes behind the first one that sends it, and a list whose
# first mirror is healthy, or where none is, stays exactly as it was.
#
# A stand-in server on this machine plays every kind of mirror: /fast/ sends
# the index and the package it names at once; /slow/ sends a short index at
# 50 KB/s, so it would arrive whole in four seconds and only the speed check
# stops it; /slowpool/ sends its index at once and its package at 50 KB/s, as
# Azure's did on 2026-10-26's nightly; /bare/ has an index naming no package
# big enough to time, which passes on the index alone; /silent/ takes the
# request and never answers; /missing/ has no index. A port with nothing on it
# refuses the connection. No network needed.
set -euo pipefail
cd "$(dirname "$0")/.."

work="$(mktemp -d)"
server=
trap '[ -n "$server" ] && kill "$server" 2>/dev/null; rm -rf "$work"' EXIT

cat > "$work/mirror.mjs" <<'JS'
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
// An index as apt's are: stanzas, a package's file and size in each. A small
// one first, too small to time, then the one the script times.
const stanza = (name, size) => `Package: ${name}\nFilename: pool/main/${name[0]}/${name}/${name}_1_amd64.deb\nSize: ${size}\n\n`;
const named = gzipSync(stanza("tiny", 2_000) + stanza("libwebkit", 500_000) + "Description: padding\n".repeat(80_000));
const bare = gzipSync(stanza("tiny", 2_000) + "Description: padding\n".repeat(80_000));
const pkg = Buffer.alloc(500_000, 2);
const drip = (res, bytes) => {
  res.writeHead(200, { "content-length": bytes.length });
  let sent = 0;
  const timer = setInterval(() => {
    if (res.destroyed || sent >= bytes.length) {
      clearInterval(timer);
      return res.end();
    }
    res.write(bytes.subarray(sent, sent + 5000));
    sent += 5000;
  }, 100);
};
const server = createServer((req, res) => {
  const kind = req.url.split("/")[1];
  const pool = req.url.includes("/pool/");
  if (kind === "silent") return;
  if (kind === "missing") return res.writeHead(404).end();
  if (kind === "slow") return drip(res, Buffer.alloc(200_000, 1));
  if (pool && kind === "slowpool") return drip(res, pkg);
  if (pool) return res.writeHead(200, { "content-length": pkg.length }).end(pkg);
  const index = kind === "bare" ? bare : named;
  res.writeHead(200, { "content-length": index.length }).end(index);
});
server.listen(0, "127.0.0.1", () => writeFileSync(process.argv[2], String(server.address().port)));
JS
node "$work/mirror.mjs" "$work/port" &
server=$!
for _ in $(seq 50); do [ -s "$work/port" ] && break; sleep 0.1; done
port=$(cat "$work/port")
at="http://127.0.0.1:$port"
# A port nothing listens on: one the server had, now closed.
refused="http://127.0.0.1:$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"

export APT_MIRRORS="$work/apt-mirrors.txt" APT_MIRROR_PROBE="dists/test/main/binary-amd64/Packages.gz" APT_MIRROR_SPEED_TIME=1
tab=$'\t'

fails=0
fail() { echo "FAIL: $1" >&2; echo "$out" >&2; fails=$((fails + 1)); }
# The list, then what the script should leave: a run never fails the step.
run() { printf '%s\n' "$@" > "$APT_MIRRORS"; out=$(bash scripts/apt-mirrors.sh 2>&1) || fail "exited with $? on: $*"; }
leaves() { # description, then the lines the list should hold
  local what=$1; shift
  if [ "$(cat "$APT_MIRRORS")" != "$(printf '%s\n' "$@")" ]; then fail "$what: got $(cat "$APT_MIRRORS")"; fi
}
says() { grep -q -- "$2" <<< "$out" || fail "$1: no \"$2\" in the output"; }
quiet() { ! grep -q -- "$2" <<< "$out" || fail "$1: \"$2\" in the output"; }

healthy=("$at/fast/${tab}priority:1" "$at/slow/${tab}priority:2" "$at/silent/${tab}priority:3")
run "${healthy[@]}"
leaves "a healthy first mirror" "${healthy[@]}"
quiet "a healthy first mirror" "::warning"
says "a healthy first mirror" "KB/s"

run "$at/slow/${tab}priority:1" "$at/fast/${tab}priority:2" "$refused/${tab}priority:3"
leaves "a crawling first mirror goes last" "$at/fast/${tab}priority:1" "$refused/${tab}priority:2" "$at/slow/${tab}priority:3"
says "a crawling first mirror" "slower than 100 KB/s"
says "a crawling first mirror" "::warning title=apt mirrors::"

run "$at/silent/${tab}priority:1" "$at/missing/${tab}priority:2" "$at/fast/${tab}priority:3"
leaves "every one before the first to pass follows it, in order" "$at/fast/${tab}priority:1" "$at/silent/${tab}priority:2" "$at/missing/${tab}priority:3"
says "a mirror that never answers" "slower than 100 KB/s"
says "a mirror without the index" "doesn't have dists/test"

run "$refused/${tab}priority:1${tab}arch:amd64" "$at/fast/${tab}arch:amd64"
leaves "other tags stay, and a line without a priority gets one" "$at/fast/${tab}arch:amd64${tab}priority:1" "$refused/${tab}priority:2${tab}arch:amd64"
says "a refused connection" "didn't answer"

run "$at/slowpool/${tab}priority:1" "$at/fast/${tab}priority:2"
leaves "a mirror whose index comes at once and its packages crawl goes last" "$at/fast/${tab}priority:1" "$at/slowpool/${tab}priority:2"
says "a mirror whose packages crawl" "but a package slower than 100 KB/s"
says "a healthy mirror's package" ", a package "

run "$at/bare/${tab}priority:1" "$at/fast/${tab}priority:2"
leaves "an index naming nothing to time passes on its own" "$at/bare/${tab}priority:1" "$at/fast/${tab}priority:2"
quiet "an index naming nothing to time" "::warning"

run "# GitHub's" "" "$at/missing/${tab}priority:1" "$at/fast/${tab}priority:2"
leaves "a comment stays and a blank line goes" "# GitHub's" "$at/fast/${tab}priority:1" "$at/missing/${tab}priority:2"

none=("$at/slow/${tab}priority:1" "$at/missing/${tab}priority:2" "$refused/${tab}priority:3")
run "${none[@]}"
leaves "no mirror passing" "${none[@]}"
says "no mirror passing" "no Ubuntu mirror sent its index"

rm -f "$APT_MIRRORS"
out=$(bash scripts/apt-mirrors.sh 2>&1) || fail "exited with $? with no list"
says "no list" "stay as they are"
[ ! -e "$APT_MIRRORS" ] || fail "no list: one was made"

if [ "$fails" -gt 0 ]; then exit 1; fi
echo "apt-mirrors: all cases pass"
