#!/usr/bin/env bash
# Build, sign and index Linger's Arch package for one release (#188).
#
# Usage: packaging/arch/build-repo.sh <version> <repo-dir> [path/to/Linger_<version>_amd64.deb]
#
# <repo-dir> holds the pacman repository as it is published now: linger.db,
# linger.files and their signatures, or nothing for the first release. The new
# package, its signature and the updated database are written there, ready to
# upload. Without a .deb path, the release's .deb is downloaded from GitHub.
#
# GPGKEY must name the signing key (its fingerprint) and gpg must hold its
# secret half. makepkg refuses to run as root, so run this as an ordinary user.
set -euo pipefail

version=${1:?usage: build-repo.sh <version> <repo-dir> [deb]}
repo=$(realpath -m "${2:?usage: build-repo.sh <version> <repo-dir> [deb]}")
deb=${3:-}
: "${GPGKEY:?set GPGKEY to the fingerprint of the signing key}"
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
url="https://github.com/itsMattGuenther/Linger/releases/download/v$version/Linger_${version}_amd64.deb"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$repo"

if [ -n "$deb" ]; then
  cp "$deb" "$work/Linger_${version}_amd64.deb"
else
  curl -fsSL --retry 3 -o "$work/Linger_${version}_amd64.deb" "$url"
fi
cp "$here/linger.desktop" "$work/"
# The agent skills (#147), flattened to the names the PKGBUILD lists.
cp "$root/agents/skills/linger-report/SKILL.md" "$work/linger-report.SKILL.md"
cp "$root/agents/skills/linger-report/reporting.md" "$work/linger-report.reporting.md"
cp "$root/agents/skills/linger-contribute/SKILL.md" "$work/linger-contribute.SKILL.md"
cp "$root/agents/link-skills.sh" "$work/link-skills.sh"

# Real checksums in the copy that gets built; the committed PKGBUILD says
# SKIP only because it has no version yet. makepkg -g hashes every source.
sed -e "s/^pkgver=.*/pkgver=$version/" -e '/^sha256sums=(/,/)$/d' \
    "$here/PKGBUILD" > "$work/PKGBUILD"
(cd "$work" && makepkg -g >> PKGBUILD 2>/dev/null)
if grep -q "SKIP" "$work/PKGBUILD" || ! grep -q "^sha256sums=" "$work/PKGBUILD"; then
  echo "checksums were not filled in" >&2
  exit 1
fi

# --nodeps: nothing is compiled, only repackaged, so the build machine does not
# need Linger's runtime dependencies installed. They are still recorded in the
# package, and pacman installs them for the user.
(cd "$work" && makepkg --clean --nodeps --sign --key "$GPGKEY" --noconfirm >&2)
pkg=$(cd "$work" && ls linger-"$version"-*.pkg.tar.zst)
cp "$work/$pkg" "$work/$pkg.sig" "$repo/"

cd "$repo"
# The published database is a plain file named linger.db. repo-add works on
# the .tar.zst name and makes linger.db a symlink to it, so rebuild that pair.
for part in db files; do
  if [ -f "linger.$part" ] && [ ! -L "linger.$part" ]; then
    mv -f "linger.$part" "linger.$part.tar.zst"
    if [ -f "linger.$part.sig" ]; then mv -f "linger.$part.sig" "linger.$part.tar.zst.sig"; fi
  fi
done
repo-add --sign --key "$GPGKEY" --remove linger.db.tar.zst "$pkg" >&2
# Plain copies again: a GitHub release asset cannot be a symlink.
for part in db files; do
  rm -f "linger.$part" "linger.$part.sig"
  cp "linger.$part.tar.zst" "linger.$part"
  cp "linger.$part.tar.zst.sig" "linger.$part.sig"
done
echo "$pkg"
