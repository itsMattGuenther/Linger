#!/usr/bin/env bash
# Tests for `scripts/apt-mirrors.sh`: a mirror that crawls, doesn't answer or
# lacks the index goes behind the first one that sends it, and a list whose
# first mirror is healthy, or where none is, stays exactly as it was.
#
# A stand-in server on this machine plays every kind of mirror: /fast/ sends
# the index at once; /slow/ sends a short one at 50 KB/s, so it would arrive
# whole in four seconds and only the speed check stops it; /silent/ takes the
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
const index = Buffer.alloc(2_000_000, 1);
const server = createServer((req, res) => {
  const kind = req.url.split("/")[1];
  if (kind === "silent") return;
  if (kind === "missing") return res.writeHead(404).end();
  if (kind === "fast") return res.writeHead(200, { "content-length": index.length }).end(index);
  const short = index.subarray(0, 200_000);
  res.writeHead(200, { "content-length": short.length });
  let sent = 0;
  const drip = setInterval(() => {
    if (res.destroyed || sent >= short.length) {
      clearInterval(drip);
      return res.end();
    }
    res.write(short.subarray(sent, sent + 5000));
    sent += 5000;
  }, 100);
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
