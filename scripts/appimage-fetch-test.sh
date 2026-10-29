#!/usr/bin/env bash
# Tests for `scripts/appimage-fetch.sh`: a download that fails once, by a reset
# connection, a 503 or a server that never answers, is tried again and
# arrives; a file that isn't the one pinned is refused and nothing of it is
# kept; a kept copy is used without asking, and a damaged one is fetched
# again (#753). Also that the AppImage scripts download only through it.
#
# A stand-in server on this machine plays ffmpeg.org: /reset/ drops the first
# connection, /busy/ answers the first request 503, /hang/ never answers the
# first, and each sends the file after; /wrong/ sends another file; /file/
# always sends it. It counts the requests for each. No network needed.
set -euo pipefail
cd "$(dirname "$0")/.."

work="$(mktemp -d)"
server=
trap '[ -n "$server" ] && kill "$server" 2>/dev/null; rm -rf "$work"' EXIT

cat > "$work/server.mjs" <<'JS'
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
const file = Buffer.alloc(300_000, 7);
const other = Buffer.alloc(300_000, 8);
const asked = {};
const send = (res, bytes) => res.writeHead(200, { "content-length": bytes.length }).end(bytes);
const server = createServer((req, res) => {
  const kind = req.url.split("/")[1];
  if (kind === "asked") return res.end(String(asked[req.url.split("/")[2]] ?? 0));
  asked[kind] = (asked[kind] ?? 0) + 1;
  const first = asked[kind] === 1;
  if (kind === "reset" && first) return req.socket.destroy();
  if (kind === "busy" && first) return res.writeHead(503).end();
  if (kind === "hang" && first) return;
  send(res, kind === "wrong" ? other : file);
});
server.listen(0, "127.0.0.1", () => writeFileSync(process.argv[2], String(server.address().port)));
JS
node "$work/server.mjs" "$work/port" &
server=$!
for _ in $(seq 50); do [ -s "$work/port" ] && break; sleep 0.1; done
at="http://127.0.0.1:$(cat "$work/port")"
pinned=$(node -e 'console.log(require("crypto").createHash("sha256").update(Buffer.alloc(300_000, 7)).digest("hex"))')

export LINGER_DOWNLOADS="$work/kept" LINGER_FETCH_MAX_TIME=2
failures=0
check() {
  local name="$1"; shift
  if "$@"; then echo "ok    $name"; else echo "FAIL  $name"; failures=$((failures + 1)); fi
}
fetch() { scripts/appimage-fetch.sh "$at/$1/ffmpeg.tar.xz" "$pinned" "$work/out" >"$work/log" 2>&1; }
arrived() { [ -f "$work/out" ] && echo "$pinned  $work/out" | sha256sum --check --status; }
asked() { [ "$(curl -fsS "$at/asked/$1")" = "$2" ]; }
refused() { ! fetch "$1"; }
# No line that isn't a comment runs curl or wget.
fetches_nothing_itself() { ! grep -nE "^[^#]*\b(curl|wget)\b" "$@"; }
fresh() { rm -rf "$work/kept" "$work/out"; }

for kind in reset busy hang; do
  fresh
  check "a $kind on the first try is tried again, and the file arrives" fetch "$kind"
  check "  ... and it's the file pinned" arrived
  check "  ... and the log says it retried" grep -q "retries left" "$work/log"
  check "  ... asked twice" asked "$kind" 2
done

fresh
check "a file that isn't the one pinned is refused" refused wrong
check "  ... and says so" grep -q "isn't the file pinned" "$work/log"
check "  ... and isn't handed on" test ! -e "$work/out"
check "  ... and nothing of it is kept" test -z "$(ls -A "$work/kept")"

fresh
fetch file
check "a kept copy is used without asking" fetch file
check "  ... and it's the file pinned" arrived
check "  ... asked once for both" asked file 1
check "  ... and the log says so" grep -q "the copy kept in" "$work/log"
printf 'damaged' > "$work/kept/$pinned"
check "a damaged copy is fetched again" fetch file
check "  ... and it's the file pinned" arrived
check "  ... asked once more" asked file 2

check "the AppImage scripts download only through appimage-fetch.sh" \
  fetches_nothing_itself scripts/appimage-ffmpeg.sh scripts/appimage-linuxdeploy.sh

[ "$failures" -eq 0 ] || { echo "$failures failed"; exit 1; }
