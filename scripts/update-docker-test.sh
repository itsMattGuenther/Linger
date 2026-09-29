#!/usr/bin/env bash
# deploy/update.sh against real containers (#312): a 0.4.2 server updated to
# 0.4.3, through the published images, then run again with nothing new.
#
# update-test.sh checks the order of things against a stand-in; this checks
# what a stand-in can't: that the script reads real `docker compose config`
# output, asks a real server its version from inside its container, and backs
# up a real database. The 0.4.2 image is tagged locally as 0.4.3, so the pull
# brings a genuinely different server, and neither published image ever
# changes. Needs Docker Engine and Compose, and network access to ghcr.io.
set -euo pipefail
cd "$(dirname "$0")/.."
repo="$PWD"

readonly REPO=ghcr.io/itsmattguenther/linger
dir="$(mktemp -d)/linger-update-test-$$"
mkdir -p "$dir/data"
cp "$repo/deploy/update.sh" "$dir/"
cd "$dir"

cleanup() {
  # The server's files belong to its own user, so they go from inside.
  docker compose run --rm --no-deps --user root --entrypoint sh linger \
    -c 'rm -rf /data/* /data/.[!.]*' >/dev/null 2>&1 || true
  docker compose down --volumes >/dev/null 2>&1 || true
  docker image rm "$REPO:0.4.3" "$REPO:0.4.2" >/dev/null 2>&1 || true
  rm -rf "$(dirname "$dir")"
}
trap cleanup EXIT

cat >compose.yaml <<YAML
services:
  linger:
    image: $REPO:0.4.3
    restart: "no"
    volumes:
      - ./data:/data
    environment:
      LINGER_DOMAIN: linger.test
      LINGER_DATA_DIR: /data
      LINGER_STORAGE: local
      LINGER_VOICE_ADDRESS: 127.0.0.1
YAML

fail() {
  echo "update-docker-test: $*" >&2
  exit 1
}
expect() { grep -qF -- "$1" <<<"$out" || fail "expected \"$1\" in the output:
$out"; }

# The server as 0.4.2, under the name 0.4.3, so the update has something to pull.
docker pull -q "$REPO:0.4.2" >/dev/null
docker tag "$REPO:0.4.2" "$REPO:0.4.3"
docker compose run --rm --user root --entrypoint chown linger linger:linger /data
docker compose up -d
for _ in $(seq 30); do
  [[ -f data/linger.db ]] && break
  sleep 1
done
[[ -f data/linger.db ]] || fail "the 0.4.2 server never made its database"

# The same question update.sh asks, with nothing hidden, so a failure here
# says why rather than leaving the script to time out.
echo "== the 0.4.2 server's version, asked from inside its container"
docker compose exec -T linger bash -c \
  "exec 3<>/dev/tcp/127.0.0.1/8420 && printf 'GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n' >&3 && cat <&3" \
  </dev/null || fail "asking the server for its version failed"
echo

echo "== the update"
out="$(LINGER_UPDATE_WAIT=90 ./update.sh 2>&1)" || fail "update.sh failed:
$out"
echo "$out"
expect "Linger is on 0.4.3 (was 0.4.2)."
expect "asks for version 0.4.3, so this keeps you on it"
grep -qF "carries no voice" <<<"$out" && fail "it warned about voice, which is set"
backup="$(find backups -name 'linger-0.4.2-*.tar.gz' | head -1)"
[[ -n "$backup" ]] || fail "no backup named for 0.4.2 in backups/"
tar tzf "$backup" | grep -qx linger.db || fail "$backup doesn't hold linger.db"

echo "== again, with nothing new"
out="$(LINGER_UPDATE_WAIT=90 ./update.sh 2>&1)" || fail "update.sh failed the second time:
$out"
echo "$out"
expect "already the newest version (0.4.3)"
expect "Linger is on 0.4.3."
[[ "$(find backups -type f | wc -l)" -eq 1 ]] || fail "the second run made another backup"

echo "update-docker-test: passed"
