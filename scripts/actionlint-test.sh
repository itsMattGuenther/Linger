#!/usr/bin/env bash
# Tests for `scripts/actionlint.sh`: a Docker Hub error, or one that never
# answers, is tried again until the image arrives; actionlint's own findings
# fail at once, with no retry (#874). Also that nothing else in CI or check.sh
# runs actionlint, so nothing skips the retries or names another version.
#
# A stand-in `docker` plays the daemon: $PULLS says how each pull goes, in
# order (ok, fail or hang), $RUN_EXIT what actionlint exits with. Like the real
# one, `docker run` fails when the image hasn't arrived, so a run that didn't
# wait for the download shows. A stand-in `sleep` writes down each pause and
# doesn't wait. No Docker or network needed.
set -euo pipefail
cd "$(dirname "$0")/.."

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

REAL_SLEEP="$(command -v sleep)"
STANDIN="$work/state"
export REAL_SLEEP STANDIN

mkdir "$work/bin"
# Only bash's own commands, so these run with nothing else on the PATH.
cat >"$work/bin/docker" <<'SH'
#!/usr/bin/env bash
bump() { local n; read -r n <"$STANDIN/$1"; n=$((n + 1)); echo "$n" >"$STANDIN/$1"; echo "$n"; }
case "$1" in
  image) [ -f "$STANDIN/here" ] ;;
  pull)
    n="$(bump pulls)"
    read -ra plan <<<"${PULLS:-}"
    case "${plan[n - 1]:-fail}" in
      ok) : >"$STANDIN/here" ;;
      hang) exec "$REAL_SLEEP" 30 ;;
      *) echo "docker: Error response from daemon: unexpected status: 502 Bad Gateway" >&2; exit 1 ;;
    esac
    ;;
  run)
    bump runs >/dev/null
    echo "$*" >"$STANDIN/run"
    if [ ! -f "$STANDIN/here" ]; then
      echo "docker: failed to resolve reference: 502 Bad Gateway" >&2
      exit 125
    fi
    exit "${RUN_EXIT:-0}"
    ;;
  *) echo "the stand-in docker doesn't know: $*" >&2; exit 99 ;;
esac
SH
cat >"$work/bin/sleep" <<'SH'
#!/usr/bin/env bash
echo -n "$1 " >>"$STANDIN/pauses"
SH
chmod +x "$work/bin/docker" "$work/bin/sleep"

failures=0
check() {
  local name="$1"; shift
  if "$@"; then echo "ok    $name"; else echo "FAIL  $name" >&2; failures=$((failures + 1)); fi
}
fresh() {
  rm -rf "$STANDIN"
  mkdir "$STANDIN"
  echo 0 >"$STANDIN/pulls"
  echo 0 >"$STANDIN/runs"
  : >"$STANDIN/pauses"
}
# Runs the script with the stand-ins first on the PATH, keeping its exit status.
lint() {
  status=0
  PATH="$work/bin:$PATH" bash scripts/actionlint.sh "$@" >"$work/log" 2>&1 || status=$?
}
exited() { [ "$status" = "$1" ]; }
pulled() { [ "$(cat "$STANDIN/pulls")" = "$1" ]; }
ran() { [ "$(cat "$STANDIN/runs")" = "$1" ]; }
paused() { [ "$(cat "$STANDIN/pauses")" = "$1" ]; }
said() { grep -qF -- "$1" "$work/log"; }
quiet() { ! grep -q "trying again" "$work/log"; }

fresh
PULLS="fail ok" lint -color
check "a Docker Hub error on the first try is tried again, and actionlint runs" exited 0
check "  ... asked twice" pulled 2
check "  ... actionlint ran once" ran 1
check "  ... the log says it retried" said "trying again in 1 s"
check "  ... the log says why" said "502 Bad Gateway"

fresh
PULLS="fail fail fail fail fail ok" lint
check "the sixth try is the last that can work" exited 0
check "  ... asked six times" pulled 6
check "  ... 1, 2, 4, 8 and 16 s apart" paused "1 2 4 8 16 "

fresh
PULLS="fail fail fail fail fail fail ok" lint
check "six failures fail the step" exited 1
check "  ... with no seventh try" pulled 6
check "  ... and no pause after the last" paused "1 2 4 8 16 "
check "  ... actionlint never starts" ran 0
check "  ... and it says so" said "couldn't download rhysd/actionlint"

# Without `timeout` on the machine a try can't be cut off; the next check covers that.
if command -v timeout >/dev/null; then
  fresh
  LINGER_PULL_MAX_TIME=1 PULLS="hang ok" lint
  check "a download that never answers is cut off and tried again" exited 0
  check "  ... asked twice" pulled 2
  check "  ... the log says it retried" said "trying again in 1 s"
fi

# A Mac has no `timeout`: nothing on this PATH but bash, dirname and the stand-ins.
bare="$work/bare"
mkdir "$bare"
ln -s "$work/bin/docker" "$work/bin/sleep" "$bare/"
ln -s "$(command -v bash)" "$(command -v dirname)" "$bare/"
fresh
status=0
PULLS="fail ok" PATH="$bare" "$(command -v bash)" scripts/actionlint.sh >"$work/log" 2>&1 || status=$?
check "a machine with no timeout command still downloads, and tries again" exited 0
check "  ... asked twice" pulled 2
check "  ... actionlint ran" ran 1

fresh
PULLS="ok" RUN_EXIT=1 lint
check "what actionlint finds fails the step" exited 1
check "  ... downloaded once" pulled 1
check "  ... run once, not tried again" ran 1
check "  ... with no pause" paused ""
check "  ... and no word of retrying" quiet

fresh
PULLS="ok" RUN_EXIT=125 lint
check "docker failing to start the container fails at once too" exited 125
check "  ... run once, not tried again" ran 1

fresh
: >"$STANDIN/here"
lint
check "a copy already here is used" exited 0
check "  ... without asking Docker Hub" pulled 0
check "  ... and actionlint ran" ran 1

fresh
: >"$STANDIN/here"
RUN_EXIT=1 lint
check "what actionlint finds with a copy already here fails too" exited 1
check "  ... run once" ran 1

fresh
PULLS="ok" lint -color
run_args="$(cat "$STANDIN/run")"
has() { [[ $run_args == *"$1"* ]]; }
check "the container has no network (#528)" has "--network none"
check "actionlint gets the flags it was given" has "rhysd/actionlint:1.7.12 -color"
check "the repository is mounted read-only" has ":/repo:ro"

names_no_image() { ! grep -n "rhysd/actionlint" "$@"; }
uses_it() { grep -q "bash scripts/actionlint.sh" "$1"; }
check "CI runs actionlint through this script" uses_it .github/workflows/ci.yml
check "check.sh runs actionlint through this script" uses_it scripts/check.sh
check "nothing else names the image" names_no_image .github/workflows/*.yml scripts/check.sh scripts/webkit.sh

[ "$failures" -eq 0 ] || { echo "$failures failed" >&2; exit 1; }
