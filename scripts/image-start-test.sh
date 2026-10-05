#!/usr/bin/env bash
# The server image starts as it ships (#440). Into a data folder owned by
# root, as Docker makes one, it has to come up and answer, run the server as
# `linger` and never as root, leave nothing in the folder that isn't the
# server's, and take voice's address from LINGER_DOMAIN. CI's image job runs
# it on the image it just built; locally, give it any image:
#
#   docker build -f deploy/Dockerfile -t linger:test . && scripts/image-start-test.sh linger:test
set -euo pipefail

image="${1:?usage: scripts/image-start-test.sh IMAGE}"
name="linger-image-test-$$"
volume="$name-data"

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm -f "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() {
  echo "image-start-test: $*" >&2
  docker logs "$name" 2>&1 | tail -20 >&2 || true
  exit 1
}
# The server's log, without its colors.
log() { docker logs "$name" 2>&1 | sed 's/\x1b\[[0-9;]*m//g'; }

docker run --rm -v "$volume:/data" --entrypoint sh "$image" -c 'chown root:root /data'
docker run -d --name "$name" -v "$volume:/data" -e LINGER_DOMAIN=203.0.113.7 "$image" >/dev/null ||
  fail "the container didn't start"

healthy=""
for _ in $(seq 30); do
  if docker exec "$name" bash -c \
    "exec 3<>/dev/tcp/127.0.0.1/8420 && printf 'GET /api/v1/health HTTP/1.0\r\n\r\n' >&3 && cat <&3" \
    2>/dev/null | grep -q '"ok":true'; then
    healthy=yes
    break
  fi
  sleep 1
done
[[ -n "$healthy" ]] || fail "the server never answered its health check"

uid="$(docker top "$name" -o pid,uid,comm | awk '$3 == "linger-server" { print $2 }')"
[[ -n "$uid" && "$uid" != 0 && "$uid" != root ]] ||
  fail "the server runs as ${uid:-nobody}, not as linger"
docker exec "$name" sh -c '[ -z "$(find /data ! -user linger)" ]' ||
  fail "something in the data folder isn't the server's"
log | grep -qF "voice forwarding is on: clients send voice to this address address=203.0.113.7:3479" ||
  fail "voice didn't take its address from LINGER_DOMAIN"

echo "image-start-test: it starts as linger in a folder made for root, and voice goes where its domain points"
