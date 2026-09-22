#!/usr/bin/env bash
# The whole local gate, in the order CI runs it. Green here should mean green there.
# Usage: scripts/check.sh [base-ref]
#   Pass a base ref (e.g. origin/main) to also lint your branch's commits.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== rules lint =="
scripts/lint-rules.sh "${1:-}"

echo "== version check =="
scripts/version-check.sh
node --test scripts/ci-scope.test.mjs

echo "== rust: fmt =="
cargo fmt --all --check
echo "== rust: clippy =="
cargo clippy --workspace --all-targets -- -D warnings
echo "== rust: tests (also regenerates TS bindings) =="
cargo test --workspace
echo "== bindings drift =="
git diff --exit-code client/src/generated

echo "== client: typecheck + tests =="
(cd client && pnpm check && pnpm test)

echo "== desktop shell (outside the workspace, needs GUI deps) =="
if pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
  mkdir -p client/dist
  (cd client/src-tauri && cargo clippy --all-targets -- -D warnings && cargo test)
else
  echo "skipped: system webview deps not installed here (CI still runs this pass)"
fi

echo "all green"
