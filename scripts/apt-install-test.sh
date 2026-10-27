#!/usr/bin/env bash
# Tests for `scripts/apt-install.sh`: packages are fetched, then installed,
# and kept where they're asked to be; a fetch or a list that runs out of time
# sends the mirror it used to the back and is tried once more, from the next;
# a second time fails the step, and nothing is installed half way.
#
# A stand-in apt-get on this machine writes what it was asked to a log, and
# hangs, as a crawling mirror does, as many times as it's told to; a
# stand-in for scripts/apt-mirrors.sh only writes down that it ran. No
# network, no root, no real packages.
set -euo pipefail
cd "$(dirname "$0")/.."

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cat > "$work/apt-get" <<'SH'
#!/usr/bin/env bash
# What it was asked, then: hang if this kind of ask is to hang this time.
echo "apt-get $*" >> "$WORK/log"
kind=$1
if [[ $kind == install && " $* " == *" --download-only "* ]]; then kind=fetch; fi
hangs=$(cat "$WORK/hang-$kind" 2>/dev/null || echo 0)
if (( hangs > 0 )); then
  echo $((hangs - 1)) > "$WORK/hang-$kind"
  sleep 30
fi
if [[ $kind == fetch ]]; then
  archives=
  for arg in "$@"; do
    if [[ $arg == Dir::Cache::Archives=* ]]; then archives=${arg#*=}; fi
  done
  for arg in "$@"; do
    if [[ -n $archives && $arg != -* && $arg != install && $arg != Dir::* && $arg != APT::* && $arg != Dpkg::* ]]; then
      touch "$archives/${arg}_1_amd64.deb"
    fi
  done
fi
SH
cat > "$work/mirrors.sh" <<'SH'
echo "mirrors $*" >> "$WORK/log"
SH
chmod +x "$work/apt-get"

export WORK="$work" APT_GET="$work/apt-get" APT_AS="" APT_MIRRORS_SH="$work/mirrors.sh" APT_UPDATE_SECONDS=1 APT_FETCH_SECONDS=1

fails=0
fail() { echo "FAIL: $1" >&2; cat "$work/log" >&2 2>/dev/null; echo "$out" >&2; fails=$((fails + 1)); }
# The asks, one a line, by their first words: mirrors, update, fetch, install, autoclean.
asked() {
  sed -E 's/^apt-get install .*--download-only.*/fetch/; s/^apt-get install .*/install/; s/^apt-get update.*/update/; s/^apt-get autoclean.*/autoclean/; s/^mirrors $/mirrors/; s/^mirrors --first-is-slow$/mirrors --first-is-slow/' "$work/log" | paste -sd' '
}
fresh() { rm -f "$work/log" "$work"/hang-*; rm -rf "$work/debs"; : > "$work/out"; }
hang() { echo "$2" > "$work/hang-$1"; }

fresh
out=$(APT_DEBS="$work/debs" GITHUB_OUTPUT="$work/out" bash scripts/apt-install.sh ffmpeg libgtk-3-dev 2>&1) || fail "healthy: exited with $?"
[ "$(asked)" = "mirrors update fetch install autoclean" ] || fail "healthy: asked $(asked)"
if [ ! -e "$work/debs/ffmpeg_1_amd64.deb" ] || [ ! -e "$work/debs/libgtk-3-dev_1_amd64.deb" ]; then fail "healthy: the packages weren't kept where asked"; fi
grep -q -- "Dir::Cache::Archives=$work/debs" "$work/log" || fail "healthy: apt wasn't told where to keep them"
grep -q -- "--no-install-recommends" "$work/log" && fail "healthy: recommends left out unasked"
[ ! -e "$work/debs/partial" ] || fail "healthy: half-fetched files left for the cache"
grep -qE '^key=[0-9a-f]{16}$' "$work/out" || fail "healthy: no key for the action"
first_key=$(cat "$work/out")
: > "$work/out"
APT_DEBS="$work/debs" GITHUB_OUTPUT="$work/out" bash scripts/apt-install.sh ffmpeg libgtk-3-dev > /dev/null 2>&1
[ "$(cat "$work/out")" = "$first_key" ] || fail "the same packages: a different key"

fresh
hang fetch 1
out=$(bash scripts/apt-install.sh ffmpeg 2>&1) || fail "a fetch that ran out of time once: exited with $?"
[ "$(asked)" = "mirrors update fetch mirrors --first-is-slow update fetch install" ] || fail "a fetch out of time once: asked $(asked)"
grep -q "::warning title=apt install::apt-get install was still going after 1s" <<< "$out" || fail "a fetch out of time once: not said"

fresh
hang update 1
out=$(bash scripts/apt-install.sh ffmpeg 2>&1) || fail "lists that ran out of time once: exited with $?"
[ "$(asked)" = "mirrors update mirrors --first-is-slow update fetch install" ] || fail "lists out of time once: asked $(asked)"

fresh
hang fetch 2
if out=$(bash scripts/apt-install.sh ffmpeg 2>&1); then fail "a fetch out of time twice: the step passed"; fi
[ "$(asked)" = "mirrors update fetch mirrors --first-is-slow update fetch" ] || fail "a fetch out of time twice: asked $(asked)"

fresh
out=$(bash scripts/apt-install.sh --no-update appstream 2>&1) || fail "--no-update: exited with $?"
[ "$(asked)" = "mirrors fetch install" ] || fail "--no-update: asked $(asked)"

fresh
out=$(bash scripts/apt-install.sh --no-recommends ffmpeg 2>&1) || fail "--no-recommends: exited with $?"
[ "$(grep -c -- "--no-install-recommends" "$work/log")" = 2 ] || fail "--no-recommends: not passed to the fetch and the install"

fresh
if out=$(bash scripts/apt-install.sh 2>&1); then fail "no packages named: the step passed"; fi
if out=$(bash scripts/apt-install.sh --sideways ffmpeg 2>&1); then fail "a flag it doesn't know: the step passed"; fi

if [ "$fails" -gt 0 ]; then exit 1; fi
echo "apt-install: all cases pass"
