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

cleanup() {
  compose down --volumes >/dev/null
  rm -rf "$dir"
}
trap cleanup EXIT

compose pull coturn
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
