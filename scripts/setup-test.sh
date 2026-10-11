#!/usr/bin/env bash
# deploy/setup.sh against stand-ins (#440).
# The stand-ins' bodies are written out as they are, to expand when they run.
# shellcheck disable=SC2016
#
# Stand-ins for docker, curl, getent, ip, ufw, df and id record every call
# and answer from a few files, so each case can check what the script did, in
# which order, and what it wrote: the .env, the ports, the setup link, and
# what it refused to touch. The files it "downloads" are the repository's
# own deploy/ files. No Docker or network needed.
set -euo pipefail
cd "$(dirname "$0")/.."
repo="$PWD"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# --- The stand-ins ----------------------------------------------------------------

mkdir -p "$work/bin"
stand_in() { # name, body
  printf '#!/usr/bin/env bash\nset -euo pipefail\nS="$FAKE"\necho "%s $*" >>"$S/log"\n%s\n' "$1" "$2" >"$work/bin/$1"
  chmod +x "$work/bin/$1"
}
stand_in docker '
args=("$@")
[[ "${args[0]}" == compose ]] && args=("${args[@]:1}")
case "${args[*]}" in
  info | version) ;;
  pull) ;;
  "image inspect --format "*) cat "$S/version" ;;
  "run --rm --no-deps --user root --entrypoint chown linger linger:linger /data") ;;
  "up -d") touch "$S/running" ;;
  "logs --no-color linger")
    if [[ -f "$S/running" && ! -f "$S/nolink" ]]; then
      echo "linger-1  |   │  Open:  https://linger.example.com/setup?token=0123456789abcdef"
    fi ;;
  "logs --no-color --tail 30 linger") echo "linger-1  | the last words" ;;
  *) echo "stand-in docker: unexpected call: docker $*" >&2; exit 99 ;;
esac'
stand_in curl '
case "$*" in
  "-fsSL -o "*) cp "'"$repo"'/deploy/$(basename "$4")" "$3" ;;
  "-4fsS --max-time 10 https://api.ipify.org") cat "$S/public" ;;
  "-fsS --max-time 10 https://"*/api/v1/health) [[ -f "$S/answers" ]] ;;
  *) echo "stand-in curl: unexpected call: curl $*" >&2; exit 99 ;;
esac'
stand_in getent '
[[ "$1" == ahostsv4 ]] || exit 99
grep "^$2 " "$S/dns" | while read -r _ address; do echo "$address STREAM $2"; done'
stand_in ip '
case "$*" in
  "-4 -o addr show") cat "$S/addrs" ;;
  "-4 -o route get 1.1.1.1") echo "1.1.1.1 via 192.168.1.1 dev eth0 src 192.168.1.50 uid 0" ;;
  *) exit 99 ;;
esac'
stand_in ufw '
case "$1" in
  status) if [[ -f "$S/ufw" ]]; then echo "Status: active"; else echo "Status: inactive"; fi ;;
  allow) ;;
  *) exit 99 ;;
esac'
stand_in df 'printf "  Size\n %sG\n" "$(cat "$S/disk")"'
stand_in id '[[ "$1" == -u ]] && cat "$S/uid"'

# A fresh folder holding only setup.sh, and the stand-ins' world: a machine at
# 203.0.113.7 that both names point at, ufw on, root, a 50 GB disk, a 0.4.9
# image, a server that prints its link and a Caddy that answers.
setup() {
  local name="$1"
  dir="$work/$name"
  FAKE="$work/$name.state"
  export FAKE
  mkdir -p "$dir" "$FAKE"
  cp "$repo/deploy/setup.sh" "$dir/"
  echo 203.0.113.7 >"$FAKE/public"
  printf 'linger.example.com 203.0.113.7\ncdn.linger.example.com 203.0.113.7\n' >"$FAKE/dns"
  echo "2: eth0    inet 203.0.113.7/20 metric 100 brd 203.0.127.255 scope global eth0" >"$FAKE/addrs"
  touch "$FAKE/ufw" "$FAKE/answers" "$FAKE/log"
  echo 0 >"$FAKE/uid"
  echo 50 >"$FAKE/disk"
  echo 0.4.9 >"$FAKE/version"
}
run() { # runs the script with the given answers; output in $out, exit code in $code
  set +e
  out="$(env PATH="$work/bin:$PATH" LINGER_SETUP_WAIT=2 "$@" bash "$dir/setup.sh" 2>&1 </dev/null)"
  code=$?
  set -e
}
answers=(LINGER_SETUP_DOMAIN=linger.example.com LINGER_SETUP_RELAY=yes)

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
in_env() { grep -qxE -- "$1" "$dir/.env"; }
at() { grep -nxF -- "$1" "$FAKE/log" | head -1 | cut -d: -f1; }
before() { [[ -n "$(at "$1")" && -n "$(at "$2")" && "$(at "$1")" -lt "$(at "$2")" ]]; }

# --- A fresh server, with the relay ------------------------------------------------

setup fresh
run LINGER_SETUP_DOMAIN=" https://Linger.Example.com/ " LINGER_SETUP_RELAY=yes
check "a fresh setup succeeds" test "$code" -eq 0
for file in compose.yaml Caddyfile update.sh .env.example; do
  check "it downloads $file" cmp -s "$dir/$file" "$repo/deploy/$file"
done
check "update.sh can run" test -x "$dir/update.sh"
check "the name is tidied into a bare name" in_env "LINGER_DOMAIN=linger.example.com"
check "the relay gets a fresh 64-character secret" in_env "LINGER_TURN_SECRET=[0-9a-f]{64}"
check "the relay starts with everything else" in_env "COMPOSE_PROFILES=voice"
check "a 50 GB disk gets a 10 GB pool" in_env "LINGER_POOL_BYTES=10GB"
check "nobody has to write a voice address" bash -c "! grep -q '^LINGER_VOICE_ADDRESS=' '$dir/.env'"
check ".env is the owner's alone" test "$(stat -c %a "$dir/.env")" = 600
check "so is the data folder, from the start (#506)" test "$(stat -c %a "$dir/data")" = 700
for port in 80/tcp 443/tcp 3479/udp 3478/tcp 3478/udp 49160:49200/udp; do
  check "ufw allows $port" called "ufw allow $port"
done
check "a 0.4.9 server needs no chown" never "--entrypoint chown"
check "it pulls before it starts" before "docker compose pull" "docker compose up -d"
check "it prints the setup link" has "https://linger.example.com/setup?token=0123456789abcdef"
check "it says the server answers" has "https://linger.example.com answers."
check "nothing sits in front of a machine holding its own address" lacks "Something sits between"
check "a relay on its own address needs no external address" in_env "# LINGER_RELAY_EXTERNAL_IP=.*"

# --- Choices and surroundings ----------------------------------------------------

setup norelay
run LINGER_SETUP_DOMAIN=linger.example.com LINGER_SETUP_RELAY=no
check "no relay succeeds" test "$code" -eq 0
check "no relay, no secret" in_env "LINGER_TURN_SECRET="
check "no relay, the profile stays off" in_env "# COMPOSE_PROFILES=voice"
check "no relay, its ports stay shut" never "ufw allow 3478"
check "voice's own port is still opened" called "ufw allow 3479/udp"

setup router
echo "2: eth0    inet 192.168.1.50/24 brd 192.168.1.255 scope global eth0" >"$FAKE/addrs"
run "${answers[@]}"
check "behind a router succeeds" test "$code" -eq 0
check "it says something sits in front" has "Something sits between this machine and the internet"
check "it names this machine's own address" has "(192.168.1.50)"
check "it lists the relay's range to let through" has "49160–49200/udp"
check "the relay is told its public address" in_env "LINGER_RELAY_EXTERNAL_IP=203.0.113.7"

setup bigdisk
echo 200 >"$FAKE/disk"
run "${answers[@]}"
check "a big disk keeps the default pool" in_env "# LINGER_POOL_BYTES=10GB"

setup notroot
echo 1000 >"$FAKE/uid"
run "${answers[@]}"
check "not root still sets up" test "$code" -eq 0
check "not root, it says how to open the ports" has "  sudo ufw allow 3479/udp"
check "not root, it changes no firewall" never "ufw allow"

setup oldimage
echo 0.4.8 >"$FAKE/version"
run "${answers[@]}"
check "today's 0.4.8 image still sets up" test "$code" -eq 0
check "0.4.8 needs the voice address written down" in_env "LINGER_VOICE_ADDRESS=203.0.113.7"
check "0.4.8 gets the data folder chowned before it starts" \
  before "docker compose run --rm --no-deps --user root --entrypoint chown linger linger:linger /data" "docker compose up -d"

setup keptenv
cp "$repo/deploy/.env.example" "$dir/.env"
sed -i 's/^LINGER_DOMAIN=.*/LINGER_DOMAIN=linger.example.com/' "$dir/.env"
kept="$(cat "$dir/.env")"
run
check "an .env already here needs no answers" test "$code" -eq 0
check "it says it keeps the .env" has "Keeping the .env that's here: linger.example.com."
check "the .env is left as it was" test "$(cat "$dir/.env")" = "$kept"
check "its relay choice is kept: no relay ports" never "ufw allow 3478"

setup noanswer
rm "$FAKE/answers"
run "${answers[@]}"
check "a Caddy that doesn't answer yet isn't a failure" test "$code" -eq 0
check "it says why it might not answer" has "didn't answer from here yet"
check "the link is printed anyway" has "/setup?token=0123456789abcdef"

# --- What stops it ----------------------------------------------------------------

setup elsewhere
printf 'linger.example.com 203.0.113.7\ncdn.linger.example.com 198.51.100.9\n' >"$FAKE/dns"
run "${answers[@]}" LINGER_SETUP_YES=no
check "a name pointing elsewhere stops it" test "$code" -eq 1
check "it says where the name points" has "cdn.linger.example.com points at 198.51.100.9, not at this machine (203.0.113.7)."
check "it writes no .env then" test ! -e "$dir/.env"
check "it starts nothing then" never "up -d"
setup elsewhereyes
printf 'linger.example.com 198.51.100.9\ncdn.linger.example.com 198.51.100.9\n' >"$FAKE/dns"
run "${answers[@]}" LINGER_SETUP_YES=1
check "saying yes carries on (a Cloudflare proxy)" test "$code" -eq 0

setup nowhere
printf 'linger.example.com 203.0.113.7\n' >"$FAKE/dns"
run "${answers[@]}"
check "a name pointing nowhere stops it" test "$code" -eq 1
check "it says to add the record" has "cdn.linger.example.com doesn't point anywhere yet"

setup running
mkdir -p "$dir/data"
echo "a database" >"$dir/data/linger.db"
run "${answers[@]}"
check "a folder running a server is refused" test "$code" -eq 1
check "it points at update.sh" has "./update.sh updates it."
check "it downloads nothing there" never "curl"
check "it starts nothing there" never "up -d"

# From an account that isn't root, a server's data folder won't open (#506),
# so the database inside can't be seen. Root opens any folder, so this case
# needs an account that isn't.
if ((EUID != 0)); then
  setup runningprivate
  mkdir -p "$dir/data"
  echo "a database" >"$dir/data/linger.db"
  chmod 600 "$dir/data"
  run "${answers[@]}"
  chmod 700 "$dir/data"
  check "a folder running a server it can't open is refused" test "$code" -eq 1
  check "it points at sudo ./update.sh" has "sudo ./update.sh updates it."
  check "it downloads nothing there either" never "curl"
  check "it starts nothing there either" never "up -d"
fi

setup oldcompose
printf 'services:\n  linger:\n    environment:\n      LINGER_DOMAIN: linger.example.com\n' >"$dir/compose.yaml"
run "${answers[@]}"
check "an old-style compose.yaml stops it" test "$code" -eq 1
check "it says how to move it aside" has "mv compose.yaml compose.yaml.old"

setup badname
run LINGER_SETUP_DOMAIN="my_server" LINGER_SETUP_RELAY=yes
check "a name that isn't one stops it" test "$code" -eq 1
check "it says what a name looks like" has "isn't a name like linger.example.com"

setup nolink
touch "$FAKE/nolink"
run "${answers[@]}"
check "a server that never prints its link fails" test "$code" -eq 1
check "it shows the server's last lines" has "the last words"

echo
if ((failures)); then
  echo "setup-test: $failures check(s) failed" >&2
  exit 1
fi
echo "setup-test: all checks passed"
