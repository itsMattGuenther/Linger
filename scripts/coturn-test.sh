#!/usr/bin/env bash
# Exercise the shipped image, entrypoint and command, not a second copy of them.
# Requires Docker Engine + Compose. No host ports, real secrets or server data.
set -euo pipefail
cd "$(dirname "$0")/.."

project="linger-coturn-test-$$"
# Override any caller's settings; do not read deploy/.env. compose.yaml needs
# a domain for Caddy's names and the relay's realm (#440).
export LINGER_TURN_SECRET=linger-startup-test-only-not-a-real-secret
export LINGER_DOMAIN=relay.test
# compose.yaml reads the server's settings from the .env beside it (#440),
# and some Compose versions refuse a project whose .env is missing, so it
# runs from a folder of its own with an empty one.
dir="$(mktemp -d)"
cp deploy/compose.yaml "$dir/"
: >"$dir/.env"
compose() {
  timeout 120s docker compose --env-file /dev/null --project-name "$project" \
    -f "$dir/compose.yaml" -f - --profile voice "$@" <<'YAML'
services:
  coturn:
    # Isolate the test from the host network; publish no ports.
    network_mode: bridge
    restart: "no"
YAML
}

# Two stand-in peers on Docker's own network, each echoing what it gets
# (turnutils_peer, from the same image): one plays this server's voice
# address, the other any other machine the relay could reach (#501).
voice_peer="$project-voice"
other_peer="$project-other"
spare=""
cleanup() {
  docker rm -f "$voice_peer" "$other_peer" ${spare:+"$spare"} >/dev/null 2>&1 || true
  compose down --volumes >/dev/null
  rm -rf "$dir"
}
trap cleanup EXIT

address_of() { docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$1"; }

compose pull coturn
image="$(compose config --images coturn)"
for peer in "$voice_peer" "$other_peer"; do
  docker run -d --name "$peer" --entrypoint turnutils_peer "$image" -L 0.0.0.0 >/dev/null
done
LINGER_VOICE_ADDRESS="$(address_of "$voice_peer")"
export LINGER_VOICE_ADDRESS
other="$(address_of "$other_peer")"

compose up -d --no-deps coturn
container="$(compose ps -a -q coturn)"
if [[ -z "$container" ]]; then
  echo "coturn container was not created" >&2
  exit 1
fi
docker image inspect "$(docker inspect --format '{{.Image}}' "$container")" \
  --format 'tested image: {{json .RepoDigests}}'

# `up -d` can succeed just before the process exits. Watch beyond startup.
for _ in {1..15}; do
  state="$(docker inspect --format '{{.State.Status}} {{.RestartCount}}' "$container")"
  if [[ "$state" != "running 0" ]]; then
    echo "coturn did not stay running: $state" >&2
    compose logs --no-color coturn >&2
    exit 1
  fi
  sleep 1
done
echo "coturn stayed running without restarts"

# The command the relay runs carries none of the options it dropped (#501):
# --no-cli is gone from coturn and logs an error on every start.
logs="$(compose logs --no-color coturn)"
if grep -q 'no-cli option is deprecated' <<<"$logs"; then
  echo "coturn was started with --no-cli" >&2
  exit 1
fi
if ! grep -qF "the relay carries voice to $LINGER_VOICE_ADDRESS and nowhere else" <<<"$logs"; then
  printf 'coturn did not say where it carries voice:\n%s\n' "$logs" >&2
  exit 1
fi

# A member with a relay password, sending through the relay (#501): to the
# voice address it goes and comes back; to any other address, private like
# this one, coturn refuses (403 Forbidden) and nothing is sent.
relay() { # relay address, peer address
  timeout 60s docker run --rm --entrypoint turnutils_uclient "$image" \
    -W "$LINGER_TURN_SECRET" -u member -e "$2" -r 3480 -n 5 -m 1 -c "$1" 2>&1 || true
}
coturn_address="$(address_of "$container")"
output="$(relay "$coturn_address" "$LINGER_VOICE_ADDRESS")"
if ! grep -qE 'tot_recv_msgs=[1-9]' <<<"$output"; then
  printf 'the relay did not carry voice to the voice address:\n%s\n' "$output" >&2
  compose logs --no-color coturn >&2
  exit 1
fi
echo "coturn carried packets to the voice address and back"
output="$(relay "$coturn_address" "$other")"
if ! grep -q 'error 403' <<<"$output" || grep -qE 'tot_recv_msgs=[1-9]' <<<"$output"; then
  printf 'the relay did not refuse another address:\n%s\n' "$output" >&2
  exit 1
fi
echo "coturn refused another address (403)"

# With no address to go on (the name doesn't point anywhere, as relay.test
# doesn't), the relay carries nothing at all rather than anything at all.
spare="$(compose run -d --no-deps -e LINGER_VOICE_ADDRESS= coturn)"
# It looks the name up first, then starts: wait for it to be listening.
logs=""
for _ in {1..30}; do
  logs="$(docker logs "$spare" 2>&1)"
  if grep -q 'Total auth threads' <<<"$logs"; then break; fi
  sleep 1
done
if ! grep -q 'so the relay carries nothing' <<<"$logs"; then
  printf "a relay with no voice address didn't say so:\n%s\n" "$logs" >&2
  exit 1
fi
output="$(relay "$(address_of "$spare")" "$LINGER_VOICE_ADDRESS")"
if ! grep -q 'error 403' <<<"$output" || grep -qE 'tot_recv_msgs=[1-9]' <<<"$output"; then
  printf 'a relay with no voice address still carried something:\n%s\n' "$output" >&2
  exit 1
fi
echo "coturn with no voice address refused everything (403)"

# The same entrypoint must still reject a missing shared secret.
if output="$(compose run --rm --no-deps -e LINGER_TURN_SECRET= coturn 2>&1)"; then
  echo "coturn accepted an empty secret" >&2
  exit 1
fi
if [[ "$output" != *"coturn: LINGER_TURN_SECRET is empty."* ]]; then
  printf 'unexpected empty-secret failure:\n%s\n' "$output" >&2
  exit 1
fi
echo "coturn refused an empty secret"
