#!/usr/bin/env bash
# Screenshots of the iPhone's share window (#820) in each of its states, on
# the iPhone Simulator: the real ShareView and ShareModel with sample
# conversations and photos (client/tests/share-window-preview), built with
# swiftc and shown as the share sheet shows it, at the usual text size and at
# the biggest. macOS with Xcode only; share-window.yml runs it on GitHub's Mac
# and keeps the pictures.
#
#   scripts/share-window-shots.sh <folder for the pictures>
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:?usage: share-window-shots.sh <folder>}"
mkdir -p "$out"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

ext="$root/client/src-tauri/gen/apple/ShareExtension"
app="$work/SharePreview.app"
mkdir -p "$app"
sdk="$(xcrun --sdk iphonesimulator --show-sdk-path)"
xcrun --sdk iphonesimulator swiftc -parse-as-library -D SHARE_PREVIEW \
  -target arm64-apple-ios16.0-simulator -sdk "$sdk" \
  -o "$app/SharePreview" \
  "$root/client/tests/share-window-preview/PreviewApp.swift" \
  "$ext/ShareView.swift" "$ext/ShareModel.swift" "$ext/ShareList.swift" "$ext/ShareStore.swift" "$ext/ShareSender.swift"
cat >"$app/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>im.linger.share-preview</string>
  <key>CFBundleExecutable</key><string>SharePreview</string>
  <key>CFBundleName</key><string>SharePreview</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSRequiresIPhoneOS</key><true/>
  <key>MinimumOSVersion</key><string>16.0</string>
  <key>UIDeviceFamily</key><array><integer>1</integer></array>
  <key>UILaunchScreen</key><dict/>
</dict>
</plist>
PLIST
codesign --force --sign - "$app"

# An iPhone to show it on: the newest the runner has.
device="$(xcrun simctl list devices available -j | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const all = Object.values(JSON.parse(s).devices).flat().filter(d => /^iPhone \d+ Pro$/.test(d.name));
    if (!all.length) process.exit(1);
    console.log(all[all.length - 1].udid);
  })')"
xcrun simctl boot "$device" 2>/dev/null || true
xcrun simctl bootstatus "$device" -b >/dev/null
xcrun simctl status_bar "$device" override --time 9:41 --batteryLevel 100 --cellularBars 4 2>/dev/null || true
xcrun simctl install "$device" "$app"

shoot() {
  local state="$1" name="$2"
  xcrun simctl terminate "$device" im.linger.share-preview 2>/dev/null || true
  xcrun simctl launch "$device" im.linger.share-preview "$state" >/dev/null
  sleep 3
  xcrun simctl io "$device" screenshot "$out/$name.png" >/dev/null
}

for state in picking first one files chosen sending sent failed search note gathering blocked; do
  shoot "$state" "$state"
done
# The iPhone's biggest text size (#690): the window follows it.
if xcrun simctl ui "$device" content_size extra-extra-extra-large 2>/dev/null; then
  shoot picking big-text-picking
  shoot chosen big-text-chosen
  xcrun simctl ui "$device" content_size large 2>/dev/null || true
fi
ls "$out"
