#!/usr/bin/env bash
# One-time setup for Linger on Arch and Omarchy (#188).
#
#   curl -fsSL https://raw.githubusercontent.com/itsMattGuenther/Linger/main/packaging/arch/setup.sh | bash
#
# Adds Linger's package repository to pacman and installs Linger. After this,
# Linger updates with the rest of the system: Update in the Omarchy menu, or
# `sudo pacman -Syu`. Safe to run again.
#
# What it changes, all of it undoable:
#   - trusts the Linger packages signing key in pacman's keyring
#     (undo: sudo pacman-key --delete A539799132574CE3EB51B01AB5FA9838135B10DF)
#   - adds a [linger] section to /etc/pacman.conf (undo: delete those lines)
#   - installs the `linger` package (undo: sudo pacman -R linger)
#   - removes the menu entry an old Linger AppImage made for itself
set -euo pipefail

repo=https://github.com/itsMattGuenther/Linger/releases/download/arch
fingerprint=A539799132574CE3EB51B01AB5FA9838135B10DF

if ! command -v pacman >/dev/null; then
  echo "This is for Arch-based systems like Omarchy; pacman was not found." >&2
  exit 1
fi

key=$(mktemp)
trap 'rm -f "$key"' EXIT
curl -fsSL "$repo/linger.asc" -o "$key"
# Trust the key only if it is the one this script names, whatever was served.
got=$(gpg --show-keys --with-colons "$key" 2>/dev/null | awk -F: '/^fpr/{print $10; exit}')
if [ "$got" != "$fingerprint" ]; then
  echo "The downloaded key is not Linger's ($got); stopping." >&2
  exit 1
fi

echo "Trusting the Linger packages key (sudo)..."
sudo pacman-key --add "$key" >/dev/null
sudo pacman-key --lsign-key "$fingerprint" >/dev/null

if ! grep -q '^\[linger\]' /etc/pacman.conf; then
  echo "Adding the Linger repository to /etc/pacman.conf..."
  printf '\n[linger]\nServer = %s\n' "$repo" | sudo tee -a /etc/pacman.conf >/dev/null
fi

echo "Installing Linger..."
sudo pacman -Sy --needed --noconfirm linger

# An AppImage wrote its own menu entry under the same name; left in place it
# would keep opening the old AppImage. Only removed if it points at one.
old="${XDG_DATA_HOME:-$HOME/.local/share}/applications/com.linger.desktop.desktop"
if [ -f "$old" ] && grep -q '^Exec=.*\.AppImage' "$old"; then
  rm -f "$old"
fi

echo "Done. Open Linger from your app menu. It now updates with your system."
