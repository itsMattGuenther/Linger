#!/usr/bin/env bash
# Moves a crawling Ubuntu mirror to the back of a CI runner's list, so apt
# fetches from one that isn't. Run it before `apt-get update`.
#
# GitHub's Ubuntu runners fetch packages through a failover list,
# /etc/apt/apt-mirrors.txt: Azure's own mirror first, then archive.ubuntu.com,
# then security.ubuntu.com. apt only moves down that list when a mirror fails,
# and on 2026-10-26 Azure's didn't fail: it took 13 s to answer and then sent
# about 40 KB/s, and three jobs spent their whole time limit installing build
# tools (#717). This downloads one index, about 1.8 MB, from each mirror in
# turn until one sends it at 100 KB/s or better. Any that came before it go to
# the back of the list. A healthy first mirror, the usual case, costs one
# download of under a second and changes nothing. The packages are the same
# from every mirror, and apt checks their signatures whichever one sent them.
#
# It never fails the step. A list it can't read, or no mirror passing, leaves
# the list as it was.
#
#   scripts/apt-mirrors.sh
#
# APT_MIRRORS, APT_MIRROR_PROBE and APT_MIRROR_SPEED_TIME are for its test,
# scripts/apt-mirrors-test.sh.
set -uo pipefail

list=${APT_MIRRORS:-/etc/apt/apt-mirrors.txt}
min_speed=100000
# Seconds below min_speed before a download counts as crawling. A healthy
# mirror has sent the whole index by then.
speed_time=${APT_MIRROR_SPEED_TIME:-5}

if [[ ! -r $list ]]; then
  echo "apt-mirrors: no $list on this machine, so apt's sources stay as they are"
  exit 0
fi

probe=${APT_MIRROR_PROBE:-}
if [[ -z $probe ]]; then
  # shellcheck source=/dev/null
  codename=$(. /etc/os-release 2>/dev/null && echo "${VERSION_CODENAME:-}")
  arch=$(dpkg --print-architecture 2>/dev/null)
  if [[ -z $codename || -z $arch ]]; then
    echo "apt-mirrors: can't tell this machine's Ubuntu release, so the list stays as it is"
    exit 0
  fi
  probe="dists/$codename/main/binary-$arch/Packages.gz"
fi

comments=() mirrors=()
while IFS= read -r line || [[ -n $line ]]; do
  if [[ -z ${line//[[:space:]]/} ]]; then continue; fi
  if [[ $line == \#* ]]; then comments+=("$line"); else mirrors+=("$line"); fi
done < "$list"

# Downloads the index from one mirror. Prints how it went; fails if it was
# slower than min_speed or didn't come.
try() {
  local url=$1 speed status
  speed=$(curl -fsS -o /dev/null --connect-timeout 5 --max-time 30 \
    --speed-limit "$min_speed" --speed-time "$speed_time" \
    -w '%{speed_download}' "${url%/}/$probe" 2>/dev/null)
  status=$?
  speed=${speed%%[.,]*}
  speed=$(( ${speed:-0} / 1000 ))
  case $status in
    0) echo "${speed} KB/s" ;;
    28) echo "slower than $((min_speed / 1000)) KB/s"; return 1 ;;
    22) echo "doesn't have $probe"; return 1 ;;
    *) echo "didn't answer (curl $status)"; return 1 ;;
  esac
}

host() { local rest=${1#*://}; echo "${rest%%[/[:space:]]*}"; }

passed=-1 behind=()
for i in "${!mirrors[@]}"; do
  url=${mirrors[i]%%[[:space:]]*}
  if said=$(try "$url"); then
    echo "apt-mirrors: $(host "$url"): $said"
    passed=$i
    break
  fi
  echo "apt-mirrors: $(host "$url"): $said"
  behind+=("${mirrors[i]}")
done

if (( passed <= 0 )); then
  if (( passed < 0 && ${#mirrors[@]} > 0 )); then
    echo "::warning title=apt mirrors::no Ubuntu mirror sent its index at $((min_speed / 1000)) KB/s; the list stays as it was"
  fi
  exit 0
fi

# The first mirror that passed and the ones after it keep their order; the
# ones before it follow. apt goes by each line's priority, so they're numbered
# again in that order, and a line's other tags stay.
ordered=("${mirrors[@]:passed}" "${behind[@]}")
out=("${comments[@]}")
n=0
for line in "${ordered[@]}"; do
  n=$((n + 1))
  IFS=$'\t' read -r -a fields <<< "$line"
  numbered="${fields[0]}" placed=0
  for tag in "${fields[@]:1}"; do
    if [[ $tag == priority:* ]]; then tag="priority:$n" placed=1; fi
    numbered+=$'\t'"$tag"
  done
  if (( !placed )); then numbered+=$'\t'"priority:$n"; fi
  out+=("$numbered")
done

tmp=$(mktemp) || { echo "apt-mirrors: can't write a new list, so it stays as it is"; exit 0; }
trap 'rm -f "$tmp"' EXIT
printf '%s\n' "${out[@]}" > "$tmp"
if [[ -w $(dirname "$list") ]]; then as=(); else as=(sudo); fi
# A new file renamed over the old one: apt never reads half a list.
if ! { "${as[@]}" install -m 644 "$tmp" "$list.new" && "${as[@]}" mv -f "$list.new" "$list"; }; then
  "${as[@]}" rm -f "$list.new"
  echo "apt-mirrors: can't replace $list, so it stays as it is"
  exit 0
fi
first=$(host "${ordered[0]}")
echo "::warning title=apt mirrors::$(host "${mirrors[0]}") is slow or not answering; apt tries $first first in this job"
