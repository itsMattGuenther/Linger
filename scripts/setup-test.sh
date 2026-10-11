#!/usr/bin/env bash
# deploy/setup.sh against stand-ins (#440).
# The stand-ins' bodies are written out as they are, to expand when they run.
# shellcheck disable=SC2016
#
# Stand-ins for docker, curl, getent, ip, ufw, df and id record every call
# and answer from a few files, so each case can check what the script did, in
# which order, and what it wrote: the .env, the ports, the setup link, and
# what it refused to touch. GitHub's answer about the newest release is a file
# too. The files it "downloads" are the repository's own deploy/ files,
# whatever address it asked for; the log holds the address. No Docker or
# network needed.
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
  "-fsSL --max-time 20 https://api.github.com/repos/itsMattGuenther/Linger/releases/latest")
    if [[ -f "$S/release" ]]; then cat "$S/release"; else exit 22; fi ;;
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

# GitHub's answer to "which release is the newest", cut down to the lines
# setup.sh reads and laid out the way the API lays it out.
release_answer() { # tag, whether it's a pre-release
  printf '{\n  "html_url": "https://github.com/itsMattGuenther/Linger/releases/tag/%s",\n  "tag_name": "%s",\n  "target_commitish": "main",\n  "draft": false,\n  "prerelease": %s,\n  "body": "Linger \\"%s\\""\n}\n' \
    "$1" "$1" "$2" "$1" >"$FAKE/release"
}
raw=https://raw.githubusercontent.com/itsMattGuenther/Linger

# A fresh folder holding only setup.sh, and the stand-ins' world: a machine at
# 203.0.113.7 that both names point at, ufw on, root, a 50 GB disk, a 0.4.9
# image, a newest release of v0.4.10, a server that prints its link and a
# Caddy that answers.
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
  release_answer v0.4.10 false
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
  check "$file comes from the newest release, v0.4.10 (#507)" \
    called "curl -fsSL -o $file $raw/v0.4.10/deploy/$file"
done
check "it asks GitHub which release is the newest" \
  called "curl -fsSL --max-time 20 https://api.github.com/repos/itsMattGuenther/Linger/releases/latest"
check "nothing comes from main" never "/main/"
check "it says which release the files are from" has "Linger v0.4.10"
check "update.sh can run" test -x "$dir/update.sh"
check "the name is tidied into a bare name" in_env "LINGER_DOMAIN=linger.example.com"
check "the relay gets a fresh 64-character secret" in_env "LINGER_TURN_SECRET=[0-9a-f]{64}"
check "the relay starts with everything else" in_env "COMPOSE_PROFILES=voice"
check "a 50 GB disk gets a 10 GB pool" in_env "LINGER_POOL_BYTES=10GB"
check "nobody has to write a voice address" bash -c "! grep -q '^LINGER_VOICE_ADDRESS=' '$dir/.env'"
check ".env is the owner's alone" test "$(stat -c %a "$dir/.env")" = 600
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

# --- Where the files come from (#507) -----------------------------------------------
# The image is `latest`, the newest release, so the files are that release's
# too: files from main can ask for something the image doesn't have yet.

setup mainfiles
run "${answers[@]}" LINGER_SETUP_REF=main
check "LINGER_SETUP_REF=main sets up" test "$code" -eq 0
for file in compose.yaml Caddyfile update.sh .env.example; do
  check "LINGER_SETUP_REF=main fetches $file from main" called "curl -fsSL -o $file $raw/main/deploy/$file"
done
check "LINGER_SETUP_REF asks GitHub nothing" never "api.github.com"
check "it says the files are main's" has "Files from main, as LINGER_SETUP_REF says."
check "it says main can be ahead of the image" has "main's files can ask for something it doesn't have yet"

setup oldtag
run "${answers[@]}" LINGER_SETUP_REF=v0.4.9
check "LINGER_SETUP_REF=v0.4.9 sets up" test "$code" -eq 0
check "LINGER_SETUP_REF=v0.4.9 fetches that release's files" \
  called "curl -fsSL -o compose.yaml $raw/v0.4.9/deploy/compose.yaml"
check "a release named there asks GitHub nothing" never "api.github.com"

setup elsewherefiles
run "${answers[@]}" LINGER_SETUP_FROM=https://example.org/linger/deploy LINGER_SETUP_REF=main
check "LINGER_SETUP_FROM sets up" test "$code" -eq 0
check "LINGER_SETUP_FROM is where the files come from" \
  called "curl -fsSL -o compose.yaml https://example.org/linger/deploy/compose.yaml"
check "LINGER_SETUP_FROM wins over LINGER_SETUP_REF" never "/main/"
check "LINGER_SETUP_FROM asks GitHub nothing" never "api.github.com"

setup kept
for file in compose.yaml Caddyfile update.sh .env.example; do cp "$repo/deploy/$file" "$dir/"; done
run "${answers[@]}"
check "files already here set up" test "$code" -eq 0
check "files already here need no release" never "api.github.com"

setup archlatest
release_answer arch true
run "${answers[@]}"
check "the arch package repository is never taken for a release" test "$code" -eq 1
check "it says the answer isn't a release" has "GitHub gave \"arch\" (a pre-release) as the newest release"
check "it says how to name one" has "  LINGER_SETUP_REF=v0.4.10 bash setup.sh"
check "it downloads nothing then" never "curl -fsSL -o"
check "it writes no .env then (arch)" test ! -e "$dir/.env"

setup prerelease
release_answer v0.5.0 true
run "${answers[@]}"
check "a pre-release is never taken for a release" test "$code" -eq 1
check "it says it's a pre-release" has "GitHub gave \"v0.5.0\" (a pre-release)"
check "it downloads nothing for a pre-release" never "curl -fsSL -o"

# Kept out by its name alone, too, should it ever stop being a pre-release.
setup archrelease
release_answer arch false
run "${answers[@]}"
check "arch is never taken for a release, pre-release or not" test "$code" -eq 1
check "it downloads nothing for arch" never "curl -fsSL -o"

setup nogithub
rm "$FAKE/release"
run "${answers[@]}"
check "no answer from GitHub stops it" test "$code" -eq 1
check "it says it couldn't ask GitHub" has "couldn't ask GitHub which release is the newest"
check "it downloads nothing without an answer" never "curl -fsSL -o"

setup badref
run "${answers[@]}" LINGER_SETUP_REF='v0.4.10?x=1'
check "a LINGER_SETUP_REF that isn't a name stops it" test "$code" -eq 1
check "it downloads nothing for a bad LINGER_SETUP_REF" never "curl -fsSL -o"

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
