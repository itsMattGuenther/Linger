#!/usr/bin/env bash
# Update this Linger server to the newest release, in one command (#312).
#
# Keep this file in the folder with your compose.yaml (the `linger` folder from
# docs/host-guide.md) and run it from there, or from anywhere as
# `~/linger/update.sh`:
#
#   ./update.sh
#
# In order, it:
#   1. downloads the new images while the server is still up;
#   2. if there's a new server, stops it for a few seconds and copies the
#      database into backups/, keeping the last five (uploaded files are not
#      copied: they can be many GB, and no update changes them);
#   3. starts everything again, the voice relay too if it was set up;
#   4. waits for the server to answer, and prints the version before and after.
#
# If the new server doesn't come back, it prints the commands that put the
# backup and the previous version back. Nothing updates on its own: this runs
# when you run it, and it sends nothing anywhere except Docker downloading the
# images.
set -euo pipefail

readonly IMAGE_REPO=ghcr.io/itsmattguenther/linger
readonly KEEP_BACKUPS=5
# How long the new server gets to answer. The tests shorten it.
readonly WAIT_SECONDS="${LINGER_UPDATE_WAIT:-120}"

cd "$(dirname "$(readlink -f "$0")")"
here="$PWD"

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
fail() {
  printf '\nupdate.sh: %s\n' "$*" >&2
  exit 1
}

# --- Before touching anything -------------------------------------------------

[[ -f compose.yaml ]] ||
  fail "there's no compose.yaml in $here. Keep update.sh in the folder with your compose.yaml."
command -v docker >/dev/null 2>&1 ||
  fail "Docker isn't installed on this machine."
docker compose version >/dev/null 2>&1 ||
  fail "the 'docker compose' command isn't installed. The host guide's first step installs it."
docker info >/dev/null 2>&1 ||
  fail "can't reach Docker. If you type sudo before docker commands, run: sudo $0"

config="$(docker compose config 2>&1)" ||
  fail "Docker can't read compose.yaml:
$config"

# The image the linger service is configured with, from the resolved config.
linger_image() {
  awk '/^services:/ { s = 1; next }
       s && /^[^ ]/ { s = 0 }
       s && /^  linger:/ { l = 1; next }
       l && /^  [^ ]/ { l = 0 }
       l && /^    image:/ { print $2; exit }' <<<"$config"
}

# `latest` follows every release; a version number stays put, which is a
# choice worth saying out loud.
image="$(linger_image)"
case "$image" in
  "$IMAGE_REPO" | "$IMAGE_REPO:latest") ;;
  *matthewguenther*)
    fail "compose.yaml still says $image, a name that no longer exists. Change that line to
  image: $IMAGE_REPO:latest
then run this again." ;;
  "$IMAGE_REPO":*)
    say "Note: compose.yaml asks for version ${image##*:}, so this keeps you on it. To follow every"
    say "release, change the image line to $IMAGE_REPO:latest." ;;
  *)
    say "Note: compose.yaml runs ${image:-no image} for the server, not $IMAGE_REPO; updating it anyway." ;;
esac

if ! grep -Eq '^[[:space:]]+LINGER_VOICE_ADDRESS:[[:space:]]*"?[^[:space:]"]' <<<"$config"; then
  say "Warning: LINGER_VOICE_ADDRESS isn't set, so this server carries no voice. To turn voice"
  say "on, see https://github.com/itsMattGuenther/Linger/blob/main/docs/host-guide.md#voice"
fi

[[ -f data/linger.db ]] ||
  fail "can't find data/linger.db here. This script expects the data folder next to compose.yaml,
as the standard compose.yaml sets it up."

# The relay is behind the `voice` profile, and a command without the profile
# leaves it on its old version. It's set up here if its container exists,
# running or not.
profiles=()
if docker compose --profile voice ps -a --services 2>/dev/null | grep -qx coturn; then
  profiles=(--profile voice)
fi
compose() { docker compose ${profiles[@]+"${profiles[@]}"} "$@"; }

# The port the server listens on inside its container.
port="$(sed -En 's/^[[:space:]]+LINGER_BIND:[[:space:]]*"?[^"]*:([0-9]+)"?[[:space:]]*$/\1/p' <<<"$config" | head -1)"
port="${port:-8420}"

# The server's own /health answer, asked from inside its container, so it works
# whatever the DNS or the router does. The image has bash and no curl, so the
# request is written by hand. What went wrong with the last try is kept in
# $health_errors, for the report when the server never answers.
health_errors="$(mktemp)"
trap 'rm -f "$health_errors"' EXIT
health() {
  timeout 10 docker compose exec -T linger bash -c \
    "exec 3<>/dev/tcp/127.0.0.1/$port && printf 'GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n' >&3 && cat <&3" \
    2>"$health_errors" </dev/null || true
}
version_in() { sed -n 's/.*"version":"\([^"]*\)".*/\1/p' | head -1; }

old_container="$(docker compose ps -q linger 2>/dev/null || true)"
old_image_id=""
before=""
if [[ -n "$old_container" ]]; then
  old_image_id="$(docker inspect --format '{{.Image}}' "$old_container" 2>/dev/null || true)"
  before="$(health | version_in)"
  if [[ -z "$before" ]]; then
    before="$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' \
      "$old_container" 2>/dev/null || true)"
  fi
fi

# --- Download -----------------------------------------------------------------

step "Downloading the new version (the server stays up meanwhile)"
if ((${#profiles[@]})); then
  say "The voice relay is set up here, so it's updated too."
fi
compose pull

new_image_id="$(docker image inspect --format '{{.Id}}' "$image" 2>/dev/null || true)"

# --- Back up, only when the server itself is new ------------------------------

backup=""
if [[ -n "$old_image_id" && "$old_image_id" == "$new_image_id" ]]; then
  say "The server is already the newest version${before:+ ($before)}. Nothing to back up."
else
  step "Backing up the database (the server is down for a few seconds)"
  mkdir -p backups
  backup="backups/linger-${before:-unknown}-$(date +%Y-%m-%d-%H%M%S).tar.gz"
  compose stop linger
  # Stopped cleanly, SQLite has folded its journal back into linger.db. The
  # -wal and -shm files are copied too whenever they're there, since
  # linger.db without its -wal can be missing the newest messages.
  files=(linger.db)
  for extra in linger.db-wal linger.db-shm; do
    if [[ -e "data/$extra" ]]; then files+=("$extra"); fi
  done
  if ! tar czf "$backup" -C data "${files[@]}"; then
    rm -f "$backup"
    # The old server's container is still there, on its old image.
    compose start linger >/dev/null 2>&1 || true
    fail "couldn't copy the database into backups/, so nothing was updated and the server is
running its old version again. If you type sudo before docker commands, run: sudo $0"
  fi
  say "Saved $backup"
  # Keep the newest few. Their names start with the version, so go by age.
  mapfile -t stale < <(find backups -maxdepth 1 -name 'linger-*.tar.gz' -printf '%T@ %p\n' |
    sort -rn | tail -n +$((KEEP_BACKUPS + 1)) | cut -d' ' -f2-)
  for old in ${stale[@]+"${stale[@]}"}; do
    rm -f -- "$old"
    say "Removed the old backup $old"
  done
fi

# --- Start and check ----------------------------------------------------------

step "Starting the server"
after=""
deadline=$((SECONDS + WAIT_SECONDS))
if ! compose up -d; then
  deadline=0
fi
while ((SECONDS < deadline)); do
  answer="$(health)"
  if grep -q '"ok":true' <<<"$answer"; then
    after="$(version_in <<<"$answer")"
    break
  fi
  sleep 3
done

if [[ -z "$after" ]]; then
  printf '\nupdate.sh: the server did not start and answer within %s seconds. Its last lines:\n\n' \
    "$WAIT_SECONDS" >&2
  compose logs --tail 30 linger >&2 || true
  if [[ -s "$health_errors" ]]; then
    printf '\nAsking it for its version said:\n%s\n' "$(tail -5 "$health_errors")" >&2
  fi
  if [[ -n "$backup" && -n "$before" ]]; then
    if [[ "$image" == "$IMAGE_REPO:latest" ]]; then
      pin="sed -i 's#$IMAGE_REPO:latest#$IMAGE_REPO:$before#' compose.yaml"
    else
      pin="nano compose.yaml    (make the image line: image: $IMAGE_REPO:$before)"
    fi
    cat >&2 <<GOBACK

To go back to $before with the backup you just made, run:

  cd $here
  docker compose stop linger
  rm -f data/linger.db-wal data/linger.db-shm
  tar xzf $backup -C data
  $pin
  docker compose ${profiles[*]:+${profiles[*]} }up -d

Later, change the image line back to $IMAGE_REPO:latest to follow new releases.
GOBACK
  fi
  exit 1
fi

# The image the old server ran is spare now. Removing it keeps a small disk
# from filling up one release at a time; going back downloads it again.
if [[ -n "$old_image_id" && "$old_image_id" != "$new_image_id" ]]; then
  docker image rm "$old_image_id" >/dev/null 2>&1 || true
fi

step "Done"
if [[ -n "$before" && "$before" != "$after" ]]; then
  say "Linger is on $after (was $before)."
else
  say "Linger is on $after."
fi
if [[ -n "$backup" ]]; then
  say "The database from before is in $backup."
fi
