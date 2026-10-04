#!/usr/bin/env bash
# The Android release signing key (T-1604, SPEC §4.15).
#
# Android installs an update over an installed app only when both are signed
# with the same key. Every Linger APK on a GitHub release is signed with this
# one, so two consequences are permanent:
#
#   * Lose it and no later release installs over the one people have. Each of
#     them has to uninstall Linger (losing their sign-ins and settings) and
#     install the new one by hand.
#   * Leak it and whoever has it can make an APK that installs over Linger on
#     every phone that has it.
#
# Google Play can take this same key later ("use my own app signing key"), so
# phones that installed from GitHub keep updating from the store.
#
# So: it is generated once, on a machine you trust, and backed up offline
# before anything ships. This script does the generating part and tells you
# the rest. It never writes the key inside the repo. Its password is made for
# you and kept next to it, readable only by you; back the two up together.
#
# Usage: scripts/android-key.sh
#   LINGER_ANDROID_KEY=/path/to/key.jks scripts/android-key.sh
#
# Running it again when a key already exists prints the fingerprint and the
# checklist again. It will not overwrite an existing key.
set -euo pipefail
cd "$(dirname "$0")/.."
repo="$PWD"

default_dir="${XDG_DATA_HOME:-$HOME/.local/share}/linger"
key="${LINGER_ANDROID_KEY:-$default_dir/android-release.jks}"
password="${key%.jks}.password"
alias_name="linger"
fingerprint_file="client/src-tauri/android-release-cert.sha256"

keytool="keytool"
if ! command -v keytool >/dev/null 2>&1; then
  if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/keytool" ]; then
    keytool="$JAVA_HOME/bin/keytool"
  else
    echo "keytool comes with Java; install the JDK in docs/development.md, or set JAVA_HOME" >&2
    exit 1
  fi
fi

# A key inside the working tree is one `git add -A` away from being public.
key_dir="$(dirname "$key")"
case "$(cd "$key_dir" 2>/dev/null && pwd || echo "$key_dir")" in
  "$repo"|"$repo"/*)
    echo "refusing to write the signing key inside the repository: $key" >&2
    echo "set LINGER_ANDROID_KEY to a path outside $repo" >&2
    exit 1
    ;;
esac

if [ -e "$key" ]; then
  echo "an Android signing key already exists at $key — leaving it alone"
else
  mkdir -p "$key_dir"
  chmod 700 "$key_dir"
  (umask 077 && head -c 32 /dev/urandom | base64 | tr -d '/+=\n' > "$password")
  echo "Generating the Android signing key at $key"
  # RSA 4096, good for 30 years: Google Play wants a key valid past 2033, and
  # this one has to outlive every phone Linger is installed on.
  ANDROID_KEY_PASSWORD="$(cat "$password")" "$keytool" -genkeypair \
    -keystore "$key" -storetype PKCS12 \
    -storepass:env ANDROID_KEY_PASSWORD \
    -alias "$alias_name" -keyalg RSA -keysize 4096 -validity 10950 \
    -dname "CN=Linger, O=Linger" >/dev/null
  chmod 600 "$key"
fi

if [ ! -f "$password" ]; then
  echo "expected the key's password at $password and it is not there" >&2
  exit 1
fi

# The certificate's fingerprint is public (it is in every APK). The release
# checks the key it is given against this file before it signs anything.
fingerprint="$(ANDROID_KEY_PASSWORD="$(cat "$password")" "$keytool" -list -v \
  -keystore "$key" -storepass:env ANDROID_KEY_PASSWORD -alias "$alias_name" |
  sed -n 's/^[[:space:]]*SHA256: //p' | tr -d ':' | tr 'A-F' 'a-f')"
if [ -z "$fingerprint" ]; then
  echo "could not read the key's fingerprint from $key" >&2
  exit 1
fi

if [ -f "$fingerprint_file" ] && [ "$(tr -d '[:space:]' < "$fingerprint_file")" != "$fingerprint" ]; then
  echo "REFUSING: $fingerprint_file names a different key already."
  echo "Replacing it means no installed phone takes the next release as an"
  echo "update. If that is really what you want, edit the file yourself."
  exit 1
fi
echo "$fingerprint" > "$fingerprint_file"
echo "fingerprint: $fingerprint (in $fingerprint_file — commit it)"

cat <<EOF

Before anything ships, all four of these:

  1. Back up $key
     and $password
     somewhere offline: a password manager attachment, an encrypted USB stick
     in a different building. Not a cloud drive that syncs from this machine,
     and not only this machine.
  2. Add two repository secrets on GitHub. From the repository, with gh:
       base64 -w0 "$key" | gh secret set ANDROID_RELEASE_KEYSTORE
       gh secret set ANDROID_RELEASE_KEYSTORE_PASSWORD < "$password"
  3. Commit $fingerprint_file.
  4. Run the release workflow by hand (Actions -> release -> Run workflow):
     its preflight checks the secrets against that fingerprint.

The key and its password never go in git, never go in a chat message, and
never leave this machine except into the backup and the GitHub secrets.
EOF
