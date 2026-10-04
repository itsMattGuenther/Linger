#!/usr/bin/env bash
# The Android release key, in the release workflow (T-1604; scripts/android-key.sh
# makes the key).
#
# Every APK on a release has to be signed with the same key, or a phone that
# has Linger won't take the new one as an update. "The secrets are set" is not
# enough: a different key signs just as happily, and the release would look
# fine until somebody tried to update. So each step checks the key against the
# fingerprint committed in client/src-tauri/android-release-cert.sha256.
#
#   check         the secrets open, and are the committed key (preflight)
#   setup         check, then write the key out for Gradle: a keystore in
#                 $RUNNER_TEMP (or a temp dir) and gen/android/keystore.properties,
#                 which build.gradle.kts reads and git ignores
#   verify APK    the built APK is signed with that key and nothing else
#
# Secrets, from the environment:
#   ANDROID_RELEASE_KEYSTORE           the key file, base64
#   ANDROID_RELEASE_KEYSTORE_PASSWORD  its password
set -euo pipefail
cd "$(dirname "$0")/.."

alias_name="linger"
fingerprint_file="client/src-tauri/android-release-cert.sha256"
properties="client/src-tauri/gen/android/keystore.properties"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

expected() {
  [ -f "$fingerprint_file" ] || fail "$fingerprint_file is missing; run scripts/android-key.sh and commit it"
  tr -d '[:space:]' < "$fingerprint_file"
}

keytool_bin() {
  if command -v keytool >/dev/null 2>&1; then
    echo keytool
  elif [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/keytool" ]; then
    echo "$JAVA_HOME/bin/keytool"
  else
    fail "keytool not found: it comes with Java"
  fi
}

# Decode the key to $1 and check it against the committed fingerprint.
decode_and_check() {
  local store="$1"
  [ -n "${ANDROID_RELEASE_KEYSTORE:-}" ] || fail "ANDROID_RELEASE_KEYSTORE is not set (scripts/android-key.sh says how)"
  [ -n "${ANDROID_RELEASE_KEYSTORE_PASSWORD:-}" ] || fail "ANDROID_RELEASE_KEYSTORE_PASSWORD is not set"
  (umask 077 && printf '%s' "$ANDROID_RELEASE_KEYSTORE" | base64 -d > "$store") ||
    fail "ANDROID_RELEASE_KEYSTORE isn't base64 of a key file"
  local listed
  listed="$("$(keytool_bin)" -list -v -keystore "$store" -storepass:env ANDROID_RELEASE_KEYSTORE_PASSWORD -alias "$alias_name" 2>&1)" ||
    fail "the key wouldn't open: the password secret is wrong, or the key has no '$alias_name' entry"
  local actual
  actual="$(printf '%s\n' "$listed" | sed -n 's/^[[:space:]]*SHA256: //p' | tr -d ':' | tr 'A-F' 'a-f')"
  [ "$actual" = "$(expected)" ] ||
    fail "the key in the secrets is not the one every release is signed with ($actual, expected $(expected)). A release signed with it would not install over Linger on anybody's phone."
}

apksigner_bin() {
  local sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
  [ -n "$sdk" ] || fail "ANDROID_HOME is not set"
  local tools
  tools="$(ls -d "$sdk"/build-tools/* 2>/dev/null | sort -V | tail -1)"
  [ -x "$tools/apksigner" ] || fail "apksigner not found under $sdk/build-tools"
  echo "$tools/apksigner"
}

case "${1:-}" in
  check)
    scratch="$(mktemp -d)"
    trap 'rm -rf "$scratch"' EXIT
    decode_and_check "$scratch/release.jks"
    echo "the Android key opens and is the one every release is signed with"
    ;;
  setup)
    store="${RUNNER_TEMP:-$(mktemp -d)}/linger-android-release.jks"
    decode_and_check "$store"
    (
      umask 077
      {
        echo "password=$ANDROID_RELEASE_KEYSTORE_PASSWORD"
        echo "keyAlias=$alias_name"
        echo "storeFile=$store"
      } > "$properties"
    )
    echo "the Android key is ready for the release build"
    ;;
  verify)
    apk="${2:-}"
    [ -f "$apk" ] || fail "no APK at '$apk'"
    printed="$("$(apksigner_bin)" verify --print-certs "$apk" 2>&1)" || fail "apksigner rejected $apk: $printed"
    signers="$(printf '%s\n' "$printed" | sed -n 's/^Signer #[0-9]* certificate SHA-256 digest: //p')"
    [ "$signers" = "$(expected)" ] ||
      fail "$apk is signed by '$signers', not only by the release key $(expected)"
    echo "$apk is signed with the release key"
    ;;
  *)
    echo "usage: scripts/android-signing.sh check | setup | verify APK" >&2
    exit 2
    ;;
esac
