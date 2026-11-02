#!/usr/bin/env bash
# The iPhone share window's sender (#820,
# client/src-tauri/gen/apple/ShareExtension/ShareSender.swift), run on Linux in
# Swift's Docker image against a real Linger server built from this checkout:
# client/tests/share-sender. The sender uses Foundation alone, so the same file
# runs here as in the share extension.
#
#   scripts/share-sender-test.sh
#
# Needs Docker and cargo. LINGER_SWIFT_IMAGE picks another Swift image.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
image="${LINGER_SWIFT_IMAGE:-swift:6.1-noble}"
work="$(mktemp -d)"
server=""
cleanup() {
  if [ -n "$server" ]; then
    kill "$server" 2>/dev/null || true
    wait "$server" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

command -v docker >/dev/null || { echo "share-sender-test: needs Docker" >&2; exit 1; }

cargo build -q -p linger-server --manifest-path "$root/Cargo.toml"
port=$((20000 + RANDOM % 20000))
base="http://127.0.0.1:$port"
LINGER_DATA_DIR="$work/data" LINGER_BIND="127.0.0.1:$port" "$root/target/debug/linger-server" >"$work/server.log" 2>&1 &
server=$!

for _ in $(seq 1 150); do
  grep -q 'setup?token=' "$work/server.log" && break
  sleep 0.1
done
token="$(grep -o 'setup?token=[A-Za-z0-9_-]*' "$work/server.log" | head -1 | cut -d= -f2 || true)"
if [ -z "$token" ]; then
  cat "$work/server.log" >&2
  echo "share-sender-test: the server gave no setup token" >&2
  exit 1
fi

# The host, a room, and what the tests need, read with Node (no new Python, docs/decisions.md).
auth="$(curl -fsS -X POST "$base/api/v1/setup" -H 'Content-Type: application/json' \
  -d "{\"token\":\"$token\",\"server_name\":\"Share test\",\"username\":\"matt\",\"display_name\":\"Matt\",\"password\":\"correct horse battery\"}")"
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s)[process.argv[1]];if(v===undefined)process.exit(1);console.log(v)})' "$1"; }
access="$(field access_token <<<"$auth")"
refresh="$(field refresh_token <<<"$auth")"
room_json="$(curl -fsS -X POST "$base/api/v1/rooms" -H 'Content-Type: application/json' -H "Authorization: Bearer $access" \
  -d '{"slug":"shared","name":"shared"}')"
room="$(field id <<<"$room_json")"

# Built in the container's own folder, so nothing root-owned lands in the checkout.
docker run --rm --network host -v "$root:/src:ro" -w /src/client/tests/share-sender \
  -e LINGER_TEST_SERVER="$base" -e LINGER_TEST_ACCESS="$access" -e LINGER_TEST_REFRESH="$refresh" -e LINGER_TEST_ROOM="$room" \
  "$image" swift test --scratch-path /tmp/share-sender-build
