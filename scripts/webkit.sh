#!/usr/bin/env bash
# The WebKit browser tests on this machine (#325), with WebKit inside
# Playwright's own Ubuntu image. Playwright's WebKit is built for Ubuntu and
# Debian and won't start elsewhere (Arch, Omarchy, Fedora), which left WebKit
# failures to be found by pushing and waiting for CI.
#
# Only the browser runs in the container. The tests and the page server stay
# on this machine, so nothing in the repository is written as root. The
# container shares this machine's network, so the browser loads the pages
# from Vite directly: tunnelled through Playwright's connection instead
# (exposeNetwork), a Settings test that opens thirty pages ran past its time
# limit 16 times in 20 with every worker busy. Linux only, which is the only
# place this is needed: Playwright's WebKit runs natively on macOS and
# Windows. The image version is the client's Playwright version, so it
# matches what CI installs.
#
# Usage: scripts/webkit.sh [playwright test arguments]
#   scripts/webkit.sh                                      every WebKit test
#   scripts/webkit.sh tests/browser/next-media.spec.ts     one file
#   scripts/webkit.sh -g "knock" --repeat-each=10          by name, repeated
# Needs Docker. The image, about 3.5 GB, downloads on first use.
set -euo pipefail
cd "$(dirname "$0")/../client"

if [ "$(uname -s)" != Linux ]; then
  echo "Playwright's WebKit runs natively here: cd client && pnpm test:browser --project=webkit" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "webkit.sh needs Docker, and it isn't reachable (not installed, not running," >&2
  echo "or this user isn't allowed to use it). docs/development.md has the setup." >&2
  exit 1
fi

version="$(node -p 'require("@playwright/test/package.json").version')"
# playwright-core from the client's own install, so the server in the
# container speaks exactly the client's protocol version.
core="$(node -e '
  const { dirname } = require("node:path");
  const test = dirname(require.resolve("@playwright/test/package.json"));
  const pw = dirname(require.resolve("playwright/package.json", { paths: [test] }));
  console.log(dirname(require.resolve("playwright-core/package.json", { paths: [pw] })));
')"
image="mcr.microsoft.com/playwright:v${version}-noble"
port="$(node -e 'const s = require("node:net").createServer().listen(0, "127.0.0.1", () => { console.log(s.address().port); s.close(); })')"
name="linger-webkit-$$"

if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "downloading $image (about 3.5 GB, once)"
  docker pull -q "$image" >/dev/null
fi
docker run -d --rm --init --name "$name" --user pwuser --workdir /home/pwuser \
  --network host -v "$core:/opt/playwright-core:ro" "$image" \
  node /opt/playwright-core/cli.js run-server --port "$port" --host 127.0.0.1 >/dev/null
trap 'docker stop "$name" >/dev/null 2>&1 || true' EXIT
for _ in $(seq 1 60); do
  docker logs "$name" 2>&1 | grep -q "Listening on" && break
  sleep 0.5
done
docker logs "$name" 2>&1 | grep -q "Listening on" || { docker logs "$name" >&2; exit 1; }

# The browser in the container runs on UTC, as CI does. The tests' own clock
# has to agree, or a test that works out a date expects the wrong day.
TZ=UTC LINGER_WEBKIT_WS="ws://127.0.0.1:$port/" pnpm exec playwright test --project=webkit "$@"
