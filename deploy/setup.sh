#!/usr/bin/env bash
# Set up a Linger server on this machine, in one command (#440).
#
# On a server with Docker installed (docs/host-guide.md, step 1) and two
# names pointing at it (step 2), in an empty folder:
#
#   curl -fLO https://raw.githubusercontent.com/itsMattGuenther/Linger/main/deploy/setup.sh
#   bash setup.sh
#
# In order, it:
#   1. downloads compose.yaml, the Caddyfile, update.sh and .env.example next
#      to itself, unless they're here already;
#   2. asks for your server's name, and whether to run the voice relay;
#   3. finds this machine's public address and checks both names point at it;
#   4. writes .env: the name, a fresh relay secret, a file pool that fits the
#      disk (an .env already here is kept as it is);
#   5. opens the ports in this machine's firewall if ufw is on, and says which
#      to forward when a router or a cloud network sits in front of it;
#   6. starts the server and prints the one-time setup link.
#
# It sends nothing anywhere except GitHub for the files, api.ipify.org to
# learn this machine's public address (the host guide's own way), and Docker
# downloading the images. A folder that already runs a server is left alone:
# ./update.sh updates that.
#
# Answers can come from the environment instead of questions, for scripts:
# LINGER_SETUP_DOMAIN, LINGER_SETUP_RELAY (yes or no), and LINGER_SETUP_YES=1
# to carry on past a name that points somewhere else.
set -euo pipefail

readonly FILES_FROM="${LINGER_SETUP_FROM:-https://raw.githubusercontent.com/itsMattGuenther/Linger/main/deploy}"
readonly IMAGE=ghcr.io/itsmattguenther/linger:latest
# How long the server gets to print its setup link, and Caddy to answer.
# The tests shorten them.
readonly WAIT_SECONDS="${LINGER_SETUP_WAIT:-90}"

cd "$(dirname "$(readlink -f "$0")")"
here="$PWD"

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
fail() {
  printf '\nsetup.sh: %s\n' "$*" >&2
  exit 1
}

# A question, or its answer from the environment. The terminal is asked
# directly, so `curl ... | bash` can still ask.
ask() { # variable holding a ready answer, the question
  local ready="${!1:-}"
  if [[ -n "$ready" ]]; then
    printf '%s\n' "$ready"
    return
  fi
  local answer=""
  if [[ -r /dev/tty ]]; then
    read -r -p "$2" answer </dev/tty || true
  fi
  printf '%s\n' "$answer"
}
yes_to() { [[ "$1" =~ ^([yY]([eE][sS])?)?$ ]]; }

# --- Before touching anything -------------------------------------------------

command -v docker >/dev/null 2>&1 ||
  fail "Docker isn't installed on this machine. The host guide's first step installs it."
docker compose version >/dev/null 2>&1 ||
  fail "the 'docker compose' command isn't installed. The host guide's first step installs it."
docker info >/dev/null 2>&1 ||
  fail "can't reach Docker. If you type sudo before docker commands, run: sudo bash $0"

if [[ -f data/linger.db ]]; then
  fail "this folder already runs a Linger server ($here/data/linger.db is here), so there's
nothing to set up. ./update.sh updates it."
fi
# A server keeps its data folder to itself (#506), so from another account the
# database can't be seen, only a folder that won't open.
if [[ -d data && ! -x data ]]; then
  fail "this folder already runs a Linger server ($here/data is its data folder, which only
the server and root can open), so there's nothing to set up. sudo ./update.sh updates it."
fi

# --- 1. The files -------------------------------------------------------------

step "Getting the server's files"
for file in compose.yaml Caddyfile update.sh .env.example; do
  if [[ -f "$file" ]]; then
    say "$file is here already."
  else
    curl -fsSL -o "$file" "$FILES_FROM/$file" ||
      fail "couldn't download $file from $FILES_FROM/$file."
    say "Downloaded $file."
  fi
done
chmod +x update.sh
grep -q '^ *env_file: .env' compose.yaml ||
  fail "the compose.yaml here is from before setup.sh, with the settings written into it.
Move it aside (mv compose.yaml compose.yaml.old) and run this again, or follow
the host guide's steps by hand."

# --- 2. The questions ---------------------------------------------------------

domain=""
relay=yes
if [[ -f .env ]]; then
  domain="$(sed -n 's/^LINGER_DOMAIN=//p' .env | tail -1)"
  [[ -n "$domain" ]] ||
    fail "the .env here has no LINGER_DOMAIN. Put your server's name in it, or delete it and run this again."
  grep -q '^COMPOSE_PROFILES=.*voice' .env || relay=no
  say
  say "Keeping the .env that's here: $domain."
else
  step "Your server"
  say "Your server's name is the one you pointed at this machine, such as linger.example.com."
  domain="$(ask LINGER_SETUP_DOMAIN "Your server's name: ")"
  domain="$(tr -d '[:space:]' <<<"$domain")"
  domain="${domain#https://}"
  domain="${domain#http://}"
  domain="${domain%%/*}"
  domain="$(tr '[:upper:]' '[:lower:]' <<<"$domain")"
  [[ "$domain" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]] ||
    fail "\"$domain\" isn't a name like linger.example.com."
  say
  say "The voice relay carries voice for people whose network blocks it (some offices and"
  say "public wifi). It needs a few more open ports, and you can add it later."
  yes_to "$(ask LINGER_SETUP_RELAY "Run the voice relay? [Y/n] ")" || relay=no
fi

# --- 3. Where this machine is, and where the names point -----------------------

step "Checking ${domain} and cdn.${domain} point at this machine"
public="$(curl -4fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
behind=""
if [[ ! "$public" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  public=""
  say "Couldn't ask api.ipify.org for this machine's public address, so the names can't be"
  say "checked. Carrying on."
else
  say "This machine's public address is $public."
  # A machine whose public address is on its own network card is reached
  # directly. One whose isn't sits behind something that has to let the
  # ports through: a home router, or a cloud network (AWS, Google, Azure).
  ip -4 -o addr show 2>/dev/null | grep -q " $public/" || behind=yes
  for name in "$domain" "cdn.$domain"; do
    points="$(getent ahostsv4 "$name" 2>/dev/null | awk '{ print $1 }' | sort -u | paste -sd' ' || true)"
    if [[ -z "$points" ]]; then
      fail "$name doesn't point anywhere yet. Add its A record (host guide, step 2); a new
record can take a few minutes to show. Then run this again."
    elif [[ " $points " != *" $public "* ]]; then
      say "$name points at $points, not at this machine ($public)."
      say "Fix its A record (host guide, step 2) and run this again. A name behind Cloudflare's"
      say "proxy points elsewhere on purpose: then say yes, and set LINGER_VOICE_ADDRESS=$public"
      say "in .env afterwards, since voice can't go through the proxy."
      answer="$(ask LINGER_SETUP_YES "Carry on anyway? [y/N] ")"
      [[ "$answer" =~ ^([yY]([eE][sS])?|1)$ ]] ||
        fail "stopped, so you can fix $name first."
    else
      say "$name points here."
    fi
  done
fi

# --- 4. .env --------------------------------------------------------------------

if [[ ! -f .env ]]; then
  step "Writing .env"
  if command -v openssl >/dev/null 2>&1; then
    secret="$(openssl rand -hex 32)"
  else
    secret="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
  fi
  # The pool leaves room for the system, Docker and an export (which copies
  # every file once more): on a 50 GB disk, 10 GB, as the host guide says.
  disk="$(df -BG --output=size . | tail -1 | tr -dc 0-9)"
  pool=$(((${disk:-0} - 20) / 3))
  ((pool >= 5)) || pool=5
  sed -e "s|^LINGER_DOMAIN=.*|LINGER_DOMAIN=$domain|" .env.example >.env.new
  if [[ "$relay" == yes ]]; then
    sed -i -e "s|^LINGER_TURN_SECRET=.*|LINGER_TURN_SECRET=$secret|" \
      -e "s|^# COMPOSE_PROFILES=voice|COMPOSE_PROFILES=voice|" .env.new
    if [[ -n "$behind" ]]; then
      sed -i -e "s|^# LINGER_RELAY_EXTERNAL_IP=.*|LINGER_RELAY_EXTERNAL_IP=$public|" .env.new
    fi
  fi
  if ((pool < 50)); then
    sed -i -e "s|^# LINGER_POOL_BYTES=.*|LINGER_POOL_BYTES=${pool}GB|" .env.new
  fi
  chmod 600 .env.new
  mv .env.new .env
  say "Your server is $domain."
  if [[ "$relay" == yes ]]; then say "The relay is on, with a new secret."; else say "No relay."; fi
  if ((pool < 50)); then say "Files can take up to ${pool} GB of this ${disk} GB disk."; fi
fi

# --- 5. Ports -------------------------------------------------------------------

ports=("80/tcp" "443/tcp" "3479/udp")
if [[ "$relay" == yes ]]; then ports+=("3478/tcp" "3478/udp" "49160:49200/udp"); fi

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  step "Opening the ports in this machine's firewall"
  if [[ "$(id -u)" == 0 ]]; then
    for port in "${ports[@]}"; do ufw allow "$port" >/dev/null && say "Allowed $port."; done
  else
    say "ufw is on, and changing it needs sudo. Run:"
    for port in "${ports[@]}"; do say "  sudo ufw allow $port"; done
  fi
fi

if [[ -n "$behind" ]]; then
  local_address="$(ip -4 -o route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
  step "Something sits between this machine and the internet"
  say "Its public address, $public, belongs to a router or your cloud's network, not to this"
  say "machine${local_address:+ ($local_address)}. Let these ports through to it: at home, forward them in your"
  say "router; in a cloud, allow them in its firewall or security group."
  for port in "${ports[@]}"; do say "  ${port/:/–}"; done
fi

# --- 6. Start -------------------------------------------------------------------

step "Starting the server"
docker compose pull
# What version the server is: one from before 0.4.9 can't work out its own
# voice address, and can't write a data folder Docker made for root.
version="$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.version"}}' "$IMAGE" 2>/dev/null || true)"
older() { [[ "$(printf '%s\n%s\n' "$1" 0.4.9 | sort -V | head -1)" != 0.4.9 ]]; }
# Private from the start (#506), even under a server too old to make it so.
mkdir -p -m 700 data
if [[ -z "$version" ]] || older "$version"; then
  docker compose run --rm --no-deps --user root --entrypoint chown linger linger:linger /data
  if [[ -n "$public" ]] && ! grep -q '^LINGER_VOICE_ADDRESS=' .env; then
    printf '\n# Linger %s needs the address written down (0.4.9 works it out).\nLINGER_VOICE_ADDRESS=%s\n' \
      "${version:-before 0.4.9}" "$public" >>.env
    say "This version of the server needs voice's address written down: LINGER_VOICE_ADDRESS=$public."
  fi
fi
docker compose up -d

say
say "Waiting for the server's setup link…"
link=""
deadline=$((SECONDS + WAIT_SECONDS))
while ((SECONDS < deadline)); do
  link="$(docker compose logs --no-color linger 2>/dev/null | grep -o 'https\?://[^ ]*/setup?token=[0-9a-f]*' | tail -1 || true)"
  [[ -n "$link" ]] && break
  sleep 2
done
[[ -n "$link" ]] || {
  docker compose logs --no-color --tail 30 linger >&2 || true
  fail "the server didn't print its setup link within $WAIT_SECONDS seconds. Its last lines are above."
}

# Caddy fetches the certificate on the first visit; this is that visit.
answered=""
deadline=$((SECONDS + WAIT_SECONDS))
while ((SECONDS < deadline)); do
  if curl -fsS --max-time 10 "https://$domain/api/v1/health" >/dev/null 2>&1; then
    answered=yes
    break
  fi
  sleep 3
done

step "Done"
if [[ -n "$answered" ]]; then
  say "https://$domain answers."
else
  say "https://$domain didn't answer from here yet. Caddy may still be getting its certificate,"
  say "or ports 80 and 443 aren't reachable (and some home routers can't reach their own"
  say "address from inside: try from another network). The host guide's \"The app cannot"
  say "reach the server\" goes through it. The link below works once it answers."
fi
cat <<DONE

Your one-time setup link:

  $link

Install the Linger app on your own computer, paste the whole link into its
"Server or link" box and press Continue: into the app, not a browser. Keep it
private: whoever uses it first becomes the host. It stops working once used,
or if the server restarts first (docker compose logs linger then prints a new
one).

If your provider has a firewall of its own (DigitalOcean's Cloud Firewalls,
say), open these ports there too: ${ports[*]}.
Updating later is ./update.sh, from this folder.
DONE
