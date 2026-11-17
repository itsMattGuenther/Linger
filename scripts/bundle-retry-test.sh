#!/usr/bin/env bash
# Tests for `scripts/bundle-retry.sh` (#916): a build that failed while the
# bundler downloaded a tool is tried again, up to the limit, and keeps its
# status when it never works; a build that fails any other way, or works,
# runs once. A stand-in build prints what Tauri's bundler does, coloured and
# with Windows line ends as well as plain. Also that the Windows package
# check builds through it and keeps the bundler's tools between runs.
set -euo pipefail
cd "$(dirname "$0")/.."

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export BUNDLE_RETRY_WAIT=0

# It reads as a script at all: a syntax error after its loop would pass every
# case below, since the loop always exits first (#916's review).
bash -n scripts/bundle-retry.sh || { echo "FAIL: scripts/bundle-retry.sh doesn't parse"; exit 1; }

# The stand-in: fails the way it's told for its first runs, then builds.
cat > "$work/build.sh" <<'SH'
#!/usr/bin/env bash
count="$1" how="$2" failing="$3"
n=$(( $(cat "$count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$count"
echo "    Finished \`dev\` profile [unoptimized + debuginfo] target(s) in 10m"
if [ "$how" = args ]; then printf 'given: %s\n' "$4"; exit 0; fi
if [ "$n" -le "$failing" ]; then
  case "$how" in
    download) printf '    Bundling Linger_0.5.4_x64_en-US.msi\n Downloading https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll\nfailed to bundle project: `http status: 504`\n' ;;
    coloured) printf '\033[32m Downloading\033[0m https://github.com/x/y.zip\r\n\033[31mfailed to bundle project\033[0m: `io: connection reset`\r\n' ;;
    info) printf '        Info Downloading https://github.com/x/y.zip\n\nfailed to bundle project: `timed out`\n' >&2 ;;
    later) printf ' Downloading https://github.com/x/y.zip\n    Bundling Linger.msi\n     Running light.exe\nfailed to bundle project: `light.exe failed`\n' ;;
    between) printf ' Downloading https://github.com/x/y.zip\n        Warn the server was slow\n  45%% 12 MB\nfailed to bundle project: `http status: 502`\nCaused by:\n    0: http status: 502\n' ;;
    broken) printf ' Downloading https://github.com/x/wix314-binaries.zip\n        Info validating hash\n        Info extracting WIX\nfailed to bundle project: `invalid zip archive`\n' ;;
    template) printf ' Downloading https://github.com/x/wix314-binaries.zip\n        Info validating hash\nfailed to bundle project: `failed to render main.wxs`\n' ;;
    chain) printf ' Downloading https://github.com/x/nsis.zip\n       Error failed to bundle project:\n    - http status: 504\n' ;;
    wording) printf ' Downloading https://github.com/x/nsis.zip\nfailed to bundle project: https://github.com/x/nsis.zip: status code 503\n' ;;
    stalled) printf ' Downloading https://github.com/x/nsis.zip\nfailed to bundle project: timeout: recv_response\n' ;;
    windows) printf ' Downloading https://github.com/x/wix.zip\nfailed to bundle project: io: An existing connection was forcibly closed by the remote host. (os error 10054)\n' ;;
    cutoff) printf ' Downloading https://github.com/x/wix.zip\nfailed to bundle project: io: peer closed connection without sending TLS close_notify\n' ;;
    winnohost) printf ' Downloading https://github.com/x/wix.zip\nfailed to bundle project: io: No such host is known. (os error 11001)\n' ;;
    linuxdns) printf ' Downloading https://github.com/x/AppRun\nfailed to bundle project: failed to lookup address information: Temporary failure in name resolution\n' ;;
    nohost) printf ' Downloading https://github.com/x/wix.zip\nfailed to bundle project: host not found\n' ;;
    zipgone) printf ' Downloading https://github.com/x/wix314-binaries.zip\nfailed to bundle project: https://github.com/x/wix314-binaries.zip: status code 404\n' ;;
    denied) printf ' Downloading https://github.com/x/wix314-binaries.zip\n        Info extracting WIX\nfailed to bundle project: io: Access is denied. (os error 5)\n' ;;
    gone) printf ' Downloading https://github.com/x/nsis.zip\nfailed to bundle project: `http status: 404`\n' ;;
    signed) printf ' Downloading https://github.com/x/y.zip\n     Signing Linger.msi\nfailed to bundle project: `signtool failed`\n' ;;
    compile) printf 'error[E0308]: mismatched types\n' ;;
  esac
  exit 7
fi
echo "    Finished 2 bundles"
SH

fail() { echo "FAIL: $*"; cat "$work/out"; exit 1; }
run() {
  rm -f "$work/count"
  set +e
  bash scripts/bundle-retry.sh bash "$work/build.sh" "$work/count" "$@" >"$work/out" 2>&1
  status=$?
  set -e
  runs="$(cat "$work/count" 2>/dev/null || true)"
}

run download 0
[ "$status" -eq 0 ] && [ "$runs" -eq 1 ] || fail "a build that works runs once ($status, $runs)"
run download 1
[ "$status" -eq 0 ] && [ "$runs" -eq 2 ] || fail "a failed download, then it works ($status, $runs)"
grep -q "trying again" "$work/out" || fail "the log says it's trying again"
run download 9
[ "$status" -eq 7 ] && [ "$runs" -eq 2 ] || fail "two tries, then the build's own status ($status, $runs)"
BUNDLE_RETRY_TRIES=3 run download 2
[ "$status" -eq 0 ] && [ "$runs" -eq 3 ] || fail "three tries when asked ($status, $runs)"
run between 1
[ "$status" -eq 0 ] && [ "$runs" -eq 2 ] || fail "a warning, a progress count and causes after it don't hide the download ($status, $runs)"
run broken 1
[ "$status" -eq 7 ] && [ "$runs" -eq 1 ] || fail "a download that arrived broken isn't a network's failure ($status, $runs)"
run zipgone 1
[ "$status" -eq 7 ] && [ "$runs" -eq 1 ] || fail "a 404 for a .zip isn't retried because its address says zip ($status, $runs)"
run denied 1
[ "$status" -eq 7 ] && [ "$runs" -eq 1 ] || fail "a file that can't be written isn't the network's ($status, $runs)"
run template 1
[ "$status" -eq 7 ] && [ "$runs" -eq 1 ] || fail "a failure after a download that worked, not a network's, runs once ($status, $runs)"
run chain 1
[ "$status" -eq 0 ] && [ "$runs" -eq 2 ] || fail "a reason on the cause line after the failure is read ($status, $runs)"
run wording 1
[ "$status" -eq 0 ] && [ "$runs" -eq 2 ] || fail "another client's wording of a 503 is read ($status, $runs)"
for how in stalled windows cutoff winnohost linuxdns nohost; do
  run "$how" 1
  [ "$status" -eq 0 ] && [ "$runs" -eq 2 ] || fail "$how: the HTTP client's own wording of a network failure is tried again ($status, $runs)"
done
run gone 1
[ "$status" -eq 7 ] && [ "$runs" -eq 1 ] || fail "a 404 isn't tried again: another try won't mend it ($status, $runs)"
run signed 1
[ "$status" -eq 7 ] && [ "$runs" -eq 1 ] || fail "a failure in a later step, signing, isn't the download's ($status, $runs)"
# A setting that isn't a whole number is refused before anything runs,
# rather than tried for ever; an empty one is the default.
for bad in three -1 0 1.5; do
  BUNDLE_RETRY_TRIES="$bad" run download 9
  [ "$status" -eq 2 ] && [ -z "$runs" ] || fail "BUNDLE_RETRY_TRIES=$bad is refused ($status, $runs)"
done
BUNDLE_RETRY_TRIES="" run download 9
[ "$status" -eq 7 ] && [ "$runs" -eq 2 ] || fail "an empty BUNDLE_RETRY_TRIES is the default, two tries ($status, $runs)"
run coloured 1
[ "$status" -eq 0 ] && [ "$runs" -eq 2 ] || fail "coloured, with Windows line ends ($status, $runs)"
run info 1
[ "$status" -eq 0 ] && [ "$runs" -eq 2 ] || fail "on stderr, with an Info label and a blank line ($status, $runs)"
run later 1
[ "$status" -eq 7 ] && [ "$runs" -eq 1 ] || fail "a failure after the download finished isn't the download's ($status, $runs)"
run compile 1
[ "$status" -eq 7 ] && [ "$runs" -eq 1 ] || fail "a compile error runs once ($status, $runs)"
BUNDLE_RETRY_TRIES=1 run download 1
[ "$status" -eq 7 ] && [ "$runs" -eq 1 ] || fail "one try allowed is one try ($status, $runs)"
run args 0 '{"bundle":{"createUpdaterArtifacts":false}}'
grep -qF 'given: {"bundle":{"createUpdaterArtifacts":false}}' "$work/out" || fail "a JSON argument arrives as written"

# Checked out with LF on Windows too: Git Bash reads a CRLF script as
# `pipefail\r` and fails before it starts.
if git rev-parse --git-dir >/dev/null 2>&1; then
  git check-attr eol -- scripts/bundle-retry.sh | grep -q "eol: lf$" || fail "scripts/bundle-retry.sh is checked out with LF everywhere (.gitattributes)"
fi

# The Windows package check builds through it, and keeps the tools.
workflow=.github/workflows/package-check.yml
grep -qE "^ +bash \.\./scripts/bundle-retry\.sh pnpm tauri build --debug" "$workflow" || fail "$workflow builds through bundle-retry.sh, on a line of its own"
grep -qE "^ +pnpm tauri build" "$workflow" && fail "$workflow builds once without bundle-retry.sh as well"
grep -q "path: ~/AppData/Local/tauri" "$workflow" || fail "$workflow keeps the bundler's tools folder between runs"
grep -q "steps.tauri-cli.outputs.version" "$workflow" || fail "$workflow keys the tools on the Tauri CLI's version"
grep -qF 'key: ${{ steps.tauri-tools.outputs.cache-primary-key }}' "$workflow" || fail "$workflow saves the tools under the key it restored them by, straight after the build"

# No command is refused, rather than passing as a build that worked.
set +e; bash scripts/bundle-retry.sh >/dev/null 2>&1; none=$?; set -e
[ "$none" -eq 2 ] || fail "no command is refused ($none)"

# A wait with a leading zero is decimal, not octal (08 isn't an octal number).
BUNDLE_RETRY_WAIT=00 run download 1
[ "$status" -eq 0 ] && [ "$runs" -eq 2 ] || fail "BUNDLE_RETRY_WAIT=00 waits no time ($status, $runs)"
BUNDLE_RETRY_WAIT=x run download 1
[ "$status" -eq 2 ] && [ -z "$runs" ] || fail "BUNDLE_RETRY_WAIT=x is refused before anything runs ($status, $runs)"
echo "bundle-retry: ok"
