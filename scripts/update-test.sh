#!/usr/bin/env bash
# deploy/update.sh against a stand-in `docker` (#312).
#
# The stand-in records every call and answers from a few files, so each case
# can check what the script ran and in which order: pull before stop, the
# backup before start, the relay kept, old backups trimmed, the way back
# printed when the new server never answers. No Docker needed; CI's deploy
# job also runs the script against real containers (update-docker-test.sh).
set -euo pipefail
cd "$(dirname "$0")/.."
repo="$PWD"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# --- The stand-in ---------------------------------------------------------------

mkdir -p "$work/bin"
cat >"$work/bin/docker" <<'FAKE'
#!/usr/bin/env bash
# Answers from $FAKE: config, relay, running, running_image, tag_image,
# remote_image, broken. Image ids sha256:old and sha256:new are 0.4.3 and 0.4.4.
set -euo pipefail
S="$FAKE"
echo "docker $*" >>"$S/log"
version_of() { case "$1" in sha256:old) echo 0.4.3 ;; sha256:new) echo 0.4.4 ;; esac; }
args=("$@")
if [[ "${args[0]}" == compose ]]; then
  args=("${args[@]:1}")
  if [[ "${args[0]:-}" == --profile ]]; then args=("${args[@]:2}"); fi
fi
case "${args[*]}" in
  info | version) ;;
  config) cat "$S/config" ;;
  "ps -a --services")
    printf 'caddy\nlinger\n'
    if [[ -f "$S/relay" ]]; then echo coturn; fi ;;
  "ps -q linger") if [[ -f "$S/running" ]]; then echo cid-linger; fi ;;
  "inspect --format {{.Image}} cid-linger") cat "$S/running_image" ;;
  "image inspect --format {{.Id}} "*) cat "$S/tag_image" ;;
  pull) cp "$S/remote_image" "$S/tag_image" ;;
  "stop linger") rm -f "$S/running" ;;
  "start linger") touch "$S/running" ;;
  "up -d")
    cp "$S/tag_image" "$S/running_image"
    touch "$S/running" ;;
  "exec -T linger bash -c "*)
    [[ -f "$S/running" ]] || exit 1
    # The server's health is under /api/v1, like the rest of its API; any
    # other address gets an empty 404, as the real one does.
    if [[ "${args[*]}" != *"GET /api/v1/health "* ]]; then
      printf 'HTTP/1.0 404 Not Found\r\ncontent-length: 0\r\n\r\n'
      exit 0
    fi
    image="$(cat "$S/running_image")"
    if [[ -f "$S/broken" && "$image" == "$(cat "$S/remote_image")" ]]; then exit 1; fi
    printf 'HTTP/1.0 200 OK\r\ncontent-type: application/json\r\n\r\n{"ok":true,"version":"%s"}' \
      "$(version_of "$image")" ;;
  "logs --tail 30 linger") echo "linger-1  | the new server's last words" ;;
  "image rm "*) ;;
  *) echo "stand-in docker: unexpected call: docker $*" >&2; exit 99 ;;
esac
FAKE
chmod +x "$work/bin/docker"

config() { # voice address, image, and the domain line (a domain unless told otherwise)
  cat <<EOF
name: linger
services:
  caddy:
    image: caddy:2
  linger:
    environment:
      LINGER_DATA_DIR: /data
${3-      LINGER_DOMAIN: linger.example.com}
$1
    image: $2
    volumes:
      - ./data:/data
EOF
}
readonly VOICE="      LINGER_VOICE_ADDRESS: 203.0.113.7"

# A host's linger folder, and the stand-in's state: 0.4.3 running, 0.4.4 out.
setup() {
  local name="$1"
  dir="$work/$name"
  FAKE="$work/$name.state"
  export FAKE
  mkdir -p "$dir/data" "$FAKE"
  cp "$repo/deploy/update.sh" "$dir/"
  echo "services: {}" >"$dir/compose.yaml"
  echo "a database" >"$dir/data/linger.db"
  config "$VOICE" ghcr.io/itsmattguenther/linger:latest >"$FAKE/config"
  echo sha256:old >"$FAKE/running_image"
  echo sha256:old >"$FAKE/tag_image"
  echo sha256:new >"$FAKE/remote_image"
  touch "$FAKE/running" "$FAKE/log"
}
run() { # runs the script; its output lands in $out, its exit code in $code
  set +e
  out="$(PATH="$work/bin:$PATH" LINGER_UPDATE_WAIT=6 "$dir/update.sh" 2>&1)"
  code=$?
  set -e
}

failures=0
check() { # description, then a command that must succeed
  local what="$1"
  shift
  if "$@"; then
    echo "ok    $what"
  else
    echo "FAIL  $what"
    failures=$((failures + 1))
  fi
}
has() { grep -qF -- "$1" <<<"$out"; }
lacks() { ! grep -qF -- "$1" <<<"$out"; }
called() { grep -qxF -- "$1" "$FAKE/log"; }
never() { ! grep -qF -- "$1" "$FAKE/log"; }
# The line number of the first call matching, for checking order.
at() { grep -nxF -- "$1" "$FAKE/log" | head -1 | cut -d: -f1; }
before() { [[ -n "$(at "$1")" && -n "$(at "$2")" && "$(at "$1")" -lt "$(at "$2")" ]]; }

# --- An update, with old backups to trim ----------------------------------------

setup update
mkdir -p "$dir/backups"
for n in 1 2 3 4 5 6; do
  echo old >"$dir/backups/linger-0.3.$n-2026-01-0$n-000000.tar.gz"
  touch -d "2026-01-0$n" "$dir/backups/linger-0.3.$n-2026-01-0$n-000000.tar.gz"
done
echo "unsaved journal" >"$dir/data/linger.db-wal"
run
check "an update exits 0" test "$code" -eq 0
check "it says both versions" has "Linger is on 0.4.4 (was 0.4.3)."
check "it pulls while the old server is up" before "docker compose pull" "docker compose stop linger"
check "it backs up before starting the new server" before "docker compose stop linger" "docker compose up -d"
backup="$(cd "$dir" && find backups -name 'linger-0.4.3-*.tar.gz' | head -1)"
check "the backup is named for the old version" test -n "$backup"
check "the backup holds the database and its journal" \
  bash -c "tar tzf '$dir/$backup' | sort | tr '\n' ' ' | grep -qx 'linger.db linger.db-wal '"
check "five backups are kept" test "$(find "$dir/backups" -type f | wc -l)" -eq 5
check "the oldest are the ones removed" \
  bash -c "! ls '$dir/backups' | grep -qE 'linger-0\.3\.[12]-'"
check "the newer old ones stay" \
  bash -c "ls '$dir/backups' | grep -cE 'linger-0\.3\.[3-6]-' | grep -qx 4"
check "the old image is removed" called "docker image rm sha256:old"
check "no relay flag where there's no relay" never "--profile voice pull"
check "no voice warning when voice is set" lacks "carries no voice"
check "nothing about the domain's address when one is set" lacks "Voice goes to the address"
check "no relay, no word about the relay's compose.yaml" lacks "#501"

# --- Already the newest ---------------------------------------------------------

setup newest
echo sha256:old >"$FAKE/remote_image"
run
check "already newest exits 0" test "$code" -eq 0
check "it says it's already the newest" has "already the newest version (0.4.3)"
check "it doesn't stop the server" never "stop linger"
check "it makes no backup" test ! -e "$dir/backups"
check "it removes no image" never "image rm"

# --- The relay ------------------------------------------------------------------

setup relay
touch "$FAKE/relay"
run
check "a relay update exits 0" test "$code" -eq 0
check "it says the relay is updated" has "The voice relay is set up here"
check "the relay is pulled" called "docker compose --profile voice pull"
check "the relay is started" called "docker compose --profile voice up -d"
check "an older compose.yaml's relay gets a warning (#501)" has "not just to voice (#501)"
check "with its settings inside, it points at the host guide" has "host-guide.md#updating-the-server"

# --- The relay only carries voice (#501) ----------------------------------------

# The compose.yaml every host downloads: the relay refuses every address but
# the voice address, relays no TCP, holds a person to a few ports at a few
# Mbit/s, and leaves out the option coturn dropped.
shipped="$repo/deploy/compose.yaml"
# shellcheck disable=SC2016 # $$allowed is the text in compose.yaml, not a variable here
for flag in --no-tcp-relay --denied-peer-ip=0.0.0.0-255.255.255.255 \
  --denied-peer-ip=::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff '$$allowed' \
  --user-quota= --max-bps=; do
  check "the shipped relay runs with $flag" grep -qF -- "$flag" "$shipped"
done
check "the voice address reaches the relay" grep -qE '^ +LINGER_VOICE_ADDRESS: \$\{LINGER_VOICE_ADDRESS:-\}$' "$shipped"
check "the shipped relay has no --no-cli" bash -c "! grep -qF -- --no-cli '$shipped'"

setup relaynew
touch "$FAKE/relay"
cp "$repo/deploy/compose.yaml" "$dir/compose.yaml"
run
check "the shipped compose.yaml's relay gets no warning" lacks "#501"

setup relayold
touch "$FAKE/relay"
grep -v -- '--denied-peer-ip' "$repo/deploy/compose.yaml" >"$dir/compose.yaml"
run
check "a relay without the peer rule updates" test "$code" -eq 0
check "it warns about the relay" has "not just to voice (#501)"
check "it says how to get the new compose.yaml" \
  has "curl -fLO https://raw.githubusercontent.com/itsMattGuenther/Linger/main/deploy/compose.yaml"

setup relaypinned
touch "$FAKE/relay"
grep -v -- '--denied-peer-ip' "$repo/deploy/compose.yaml" >"$dir/compose.yaml"
config "$VOICE" ghcr.io/itsmattguenther/linger:0.4.3 >"$FAKE/config"
echo sha256:old >"$FAKE/remote_image"
run
check "a pinned version is kept in the advice" has "to stay on ghcr.io/itsmattguenther/linger:0.4.3, change it back first"

# --- The new server never answers -----------------------------------------------

setup broken
touch "$FAKE/broken"
run
check "a failed update exits 1" test "$code" -eq 1
check "it shows the server's last lines" has "the new server's last words"
check "it prints the way back to the old version" has "To go back to 0.4.3"
check "the way back restores the backup" has "tar xzf backups/linger-0.4.3-"
check "the way back pins the old version" \
  has "sed -i 's#ghcr.io/itsmattguenther/linger:latest#ghcr.io/itsmattguenther/linger:0.4.3#' compose.yaml"
check "it keeps the old image for the way back" never "image rm"

# --- Things it stops for, before touching anything ------------------------------

setup oldname
config "$VOICE" ghcr.io/matthewguenther/linger:latest >"$FAKE/config"
run
check "the old image name stops it" test "$code" -eq 1
check "it says what to change the line to" has "image: ghcr.io/itsmattguenther/linger:latest"
check "it pulls nothing then" never "pull"

setup nodb
rm "$dir/data/linger.db"
run
check "a missing database stops it" test "$code" -eq 1
check "it names the missing file" has "can't find data/linger.db"
check "it pulls nothing then" never "pull"

setup nocompose
rm "$dir/compose.yaml"
run
check "a folder without compose.yaml stops it" test "$code" -eq 1
check "it says where compose.yaml should be" has "there's no compose.yaml in $dir"

# --- Warnings that don't stop it ------------------------------------------------

setup novoice
config "" ghcr.io/itsmattguenther/linger:latest "" >"$FAKE/config"
run
check "no voice address and no domain still updates" test "$code" -eq 0
check "it warns there's no voice" has "carries no voice"

setup voicefromdomain
config "" ghcr.io/itsmattguenther/linger:latest >"$FAKE/config"
run
check "no voice address with a domain updates" test "$code" -eq 0
check "it says voice goes where the domain points (#440)" has "Voice goes to the address linger.example.com points at"
check "and how to turn it off" has "LINGER_VOICE_ADDRESS set to off turns voice off"
check "it doesn't warn there's no voice" lacks "carries no voice"

setup voiceoff
config '      LINGER_VOICE_ADDRESS: "off"' ghcr.io/itsmattguenther/linger:latest >"$FAKE/config"
run
check "voice turned off updates" test "$code" -eq 0
check "it says voice is off" has "Voice is off here"
check "it doesn't say where voice goes" lacks "Voice goes to the address"

setup pinned
config "$VOICE" ghcr.io/itsmattguenther/linger:0.4.3 >"$FAKE/config"
echo sha256:old >"$FAKE/remote_image"
run
check "a pinned version still runs" test "$code" -eq 0
check "it says the version is pinned" has "asks for version 0.4.3, so this keeps you on it"

echo
if ((failures)); then
  echo "update-test: $failures check(s) failed" >&2
  exit 1
fi
echo "update-test: all checks passed"
