#!/usr/bin/env bash
# The local gate: what CI runs for this branch's changes, sorted the same way
# CI sorts them (scripts/ci-scope.mjs). Green here should mean green there.
# docs/testing-strategy.md has the whole picture.
#
# Usage: scripts/check.sh [--all] [base-ref]
#   Checks what the branch changed since it left base-ref (default origin/main):
#   its commits, plus uncommitted edits and new files. The branch's commits
#   are linted too. --all checks everything, whatever changed; so does a
#   branch with nothing to compare.
set -euo pipefail
cd "$(dirname "$0")/.."

all=0
webkit_here=0
if [ "${1:-}" = "--all" ]; then all=1; shift; fi
base="${1:-}"
if [ -z "$base" ]; then
  for ref in origin/main main; do
    if git rev-parse -q --verify "$ref^{commit}" >/dev/null; then base="$ref"; break; fi
  done
fi

if [ "$all" = 1 ] || [ -z "$base" ]; then
  scope=$'changed=0\nrust=true\ns3=true\nweb=true\nshell=true\ncoturn=true\npackages=true\nios=true'
else
  scope="$(node scripts/ci-scope.mjs --local "$base")"
fi
on() { grep -qx "$1=true" <<<"$scope"; }
changed="$(sed -n 's/^changed=//p' <<<"$scope")"
if [ "$all" = 1 ]; then
  echo "checking everything (--all)"
elif [ "$changed" = 0 ]; then
  echo "nothing changed since ${base:-a base branch}; checking everything"
else
  echo "$changed file(s) changed since $base; checking: rules$(for d in rust web shell coturn; do on "$d" && printf ', %s' "$d"; done)"
fi

echo "== rules lint =="
scripts/lint-rules.sh "$base"

echo "== version check, and the checks' own tests =="
scripts/version-check.sh
node --test --test-reporter=dot scripts/ci-scope.test.mjs scripts/ci-gate.test.mjs scripts/changed-tests.test.mjs scripts/action-pins.test.mjs scripts/workflow-downloads.test.mjs
node --test --test-reporter=dot scripts/csp-assets.test.mjs scripts/doc-paths.test.mjs scripts/overview-docs.test.mjs scripts/ios-app-group.test.mjs scripts/https-front.test.mjs scripts/linux-next-env.test.mjs scripts/package-deps.test.mjs scripts/playwright-image.test.mjs scripts/issue-label.test.mjs scripts/startup-time.test.mjs scripts/updater-urls.test.mjs scripts/release-draft.test.mjs client/scripts/webview2-wait.test.mjs
node --test --test-reporter=dot scripts/pr-questions.test.mjs scripts/review-catches.test.mjs scripts/tauri-versions.test.mjs scripts/ios-flows.test.mjs scripts/ios-plist.test.mjs scripts/upstream-fixes.test.mjs scripts/android-jni.test.mjs scripts/installed-packages.test.mjs scripts/maestro-driver.test.mjs scripts/browser-fakes.test.mjs
echo "== Tauri's Rust crates and JavaScript packages on one version =="
node scripts/tauri-versions.mjs
python3 scripts/linux-audio-check.test.py -q
bash scripts/android-signing-test.sh >/dev/null
bash scripts/tidy-branches-test.sh >/dev/null
bash scripts/apt-mirrors-test.sh >/dev/null
bash scripts/apt-install-test.sh >/dev/null
bash scripts/appimage-fetch-test.sh >/dev/null
if docker info >/dev/null 2>&1; then
  echo "== workflow files =="
  # No network: on Docker's own network the container adds a network
  # interface to this machine for a moment, and Chromium in any other
  # check.sh running beside this one drops its page loads (#528).
  docker run --rm --network none -v "$PWD:/repo:ro" -w /repo rhysd/actionlint:1.7.12 -no-color
fi

if on web || on shell || on packages; then
  # The client's checks run on the packages already installed, and this
  # never installs any: after the lockfile changes, they'd test the old ones
  # and fail, or pass, somewhere that doesn't say why (#852).
  echo "== the client's packages are the lockfile's =="
  node scripts/installed-packages.mjs client
fi

if on rust; then
  echo "== rust: fmt =="
  cargo fmt --all --check
  echo "== rust: clippy =="
  cargo clippy --workspace --all-targets -- -D warnings
  echo "== rust: tests (also regenerates TS bindings) =="
  cargo test --workspace
  echo "== bindings drift =="
  git diff --exit-code client/src/generated
fi

if on coturn; then
  echo "== update and setup scripts =="
  bash scripts/update-test.sh
  bash scripts/setup-test.sh
fi

if on web; then
  echo "== client: typecheck + unit tests =="
  (cd client && pnpm check && pnpm test)
  echo "== client: browser tests (Chromium) =="
  # First time: `cd client && pnpm exec playwright install chromium`, or point
  # LINGER_CHROMIUM_PATH at a Chromium you already have.
  (cd client && pnpm exec playwright test --project=chromium --forbid-only --reporter=dot)
  # L-31: a test this branch adds or edits runs ten times before it lands; CI
  # does the same in both engines. Four at a time: ten copies of one heavy
  # test at once (a Settings sweep opens thirty pages) exhaust the local page
  # server, which says nothing about the test (#328).
  new_tests=()
  if [ -n "$base" ]; then mapfile -t new_tests < <(node scripts/changed-tests.mjs "$base"); fi
  if [ "${#new_tests[@]}" -gt 0 ]; then
    echo "== client: the ${#new_tests[@]} browser test(s) this branch added or edited, ten times =="
    (cd client && pnpm exec playwright test --project=chromium --retries=0 --repeat-each=10 --workers=4 --reporter=dot "${new_tests[@]}")
  fi
  # WebKit, in Playwright's Ubuntu image, on Linux where Docker works (#325).
  if [ "$(uname -s)" = Linux ] && docker info >/dev/null 2>&1; then
    webkit_here=1
    echo "== client: browser tests (WebKit, in a container) =="
    scripts/webkit.sh --forbid-only --reporter=dot
    if [ "${#new_tests[@]}" -gt 0 ]; then
      echo "== client: the ${#new_tests[@]} added or edited, ten times in WebKit =="
      scripts/webkit.sh --retries=0 --repeat-each=10 --workers=4 --reporter=dot "${new_tests[@]}"
    fi
  fi
  echo "== client: the build embeds nothing the shipped CSP refuses =="
  (cd client && pnpm exec vite build --logLevel warn && node ../scripts/csp-assets.mjs dist)
fi

if on packages; then
  # The icons are what the pinned Tauri CLI makes from the approved artwork.
  # CI's package check asked this alone, so a Tauri upgrade that draws them
  # differently only showed there (#836).
  echo "== the app icons are the pinned Tauri CLI's, from the approved artwork =="
  icons="$(node scripts/app-icons.mjs --check 2>&1)" || { grep -v " Creating " <<<"$icons"; exit 1; }
fi

if on shell; then
  echo "== desktop shell (outside the workspace, needs GUI deps) =="
  if pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
    mkdir -p client/dist
    (cd client/src-tauri && cargo clippy --all-targets -- -D warnings && cargo test)
  else
    echo "skipped: system webview deps not installed here (CI still runs this pass)"
  fi
fi

extra=()
on s3 && extra+=("the S3 storage tests (scripts/minio-test.sh runs them here)")
on coturn && extra+=("the relay and a real server update, in Docker (docs/development.md)")
if on web && [ "$webkit_here" = 0 ]; then
  extra+=("the WebKit browser tests, and this branch's new or edited ones ten times (scripts/webkit.sh runs them here, with Docker)")
fi
on packages && extra+=("the desktop packages on Linux and Windows")
on ios && extra+=("the iPhone app in the simulator, on a Mac (ios-simulator.yml)")
if [ "${#extra[@]}" -gt 0 ]; then
  echo "== CI also runs =="
  printf '  %s\n' "${extra[@]}"
fi
echo "== before you open a pull request =="
echo "  node scripts/pr-questions.mjs prints the questions for what this branch changed"
echo "all green"
