#!/usr/bin/env bash
# Checks the Linux AppImage carries Linger's AppStream metainfo, and that the
# screenshots it names are in this repository where it says they are.
#
# App catalogs read the metainfo for Linger's summary, description and
# pictures. The AppImage catalog (appimage.github.io) shows its default
# screenshot on Linger's page; without one it shows the picture its own test
# takes, of the screen asking for a server. That page links to the address,
# so a picture renamed or deleted on main leaves the page with none.
#
# Validates the whole AppImage with appstreamcli when it's installed, as the
# catalog's test does: the metainfo, and the menu entry it launches (an empty
# Categories there fails it). Offline, so a screenshot not on main yet, as on
# the pull request that adds it, isn't a failure; the files are checked above.
#
# Usage: scripts/appimage-appstream-check.sh path/to/Linger.AppImage
set -euo pipefail

appimage="$(realpath "${1:?usage: scripts/appimage-appstream-check.sh path/to/Linger.AppImage}")"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

(cd "$work" && "$appimage" --appimage-extract >/dev/null)
root="$work/squashfs-root"
metainfo="$root/usr/share/metainfo/im.linger.Linger.appdata.xml"
if [ ! -f "$metainfo" ]; then
  echo "The AppImage has no usr/share/metainfo/im.linger.Linger.appdata.xml, so catalogs show no screenshot of Linger's own." >&2
  echo "tauri.conf.json puts it in (bundle > linux > appimage > files)." >&2
  exit 1
fi

launchable="$(sed -n 's|.*<launchable type="desktop-id">\(.*\)</launchable>.*|\1|p' "$metainfo")"
if [ ! -f "$root/usr/share/applications/$launchable" ]; then
  echo "The metainfo launches $launchable, which the AppImage doesn't have:" >&2
  ls "$root/usr/share/applications" >&2
  exit 1
fi
# Newer appstreamcli fails an empty one, older (Ubuntu 22.04's) doesn't.
if ! grep -q '^Categories=..*' "$root/usr/share/applications/$launchable"; then
  echo "$launchable lists no Categories, which fails appstreamcli validate-tree (client/src-tauri/linux/linger.desktop.hbs)." >&2
  exit 1
fi

prefix="https://raw.githubusercontent.com/itsMattGuenther/Linger/main/"
images="$(grep -o '<image[^>]*>[^<]*</image>' "$metainfo" || true)"
if [ -z "$images" ]; then
  echo "The metainfo names no screenshot." >&2
  exit 1
fi
failed=0
while IFS= read -r image; do
  url="$(sed 's|<image[^>]*>\(.*\)</image>|\1|' <<<"$image")"
  width="$(sed -n 's|.* width="\([0-9]*\)".*|\1|p' <<<"$image")"
  height="$(sed -n 's|.* height="\([0-9]*\)".*|\1|p' <<<"$image")"
  path="${url#"$prefix"}"
  if [ "$path" = "$url" ]; then
    echo "$url isn't a file on main ($prefix…)." >&2
    failed=1
  elif [ ! -f "$repo/$path" ]; then
    echo "$url names $path, which isn't in the repository." >&2
    failed=1
  elif ! file "$repo/$path" | grep -q "PNG image data, $width x $height,"; then
    echo "$path isn't a ${width}×${height} PNG, as the metainfo says: $(file -b "$repo/$path")" >&2
    failed=1
  fi
done <<<"$images"
[ "$failed" -eq 0 ] || exit 1

if command -v appstreamcli >/dev/null; then
  appstreamcli validate-tree --no-net "$root"
else
  echo "appstreamcli isn't installed: the metainfo wasn't validated."
fi
echo "The AppImage carries its AppStream metainfo, and the $(wc -l <<<"$images") screenshots it names are in the repository."
