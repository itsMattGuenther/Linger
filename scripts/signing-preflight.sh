#!/usr/bin/env bash
# Does the release signing key actually work, and is it the right one? (T-701)
#
# Two secrets have to be correct before a tag can ship anything:
#
#   TAURI_SIGNING_PRIVATE_KEY           the contents of the key file
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD  its password
#
# "Correct" is not "present". A key that signs fine but is not the mate of the
# public key compiled into the app produces a release that builds green, uploads
# cleanly, and that no installed copy will accept — every one of them rejects the
# bundle as unsigned. That failure looks exactly like success right up until
# somebody tries to update, which is the worst time to find out.
#
# So this signs a throwaway file for real and checks that the key id in the
# signature matches the key id in `tauri.conf.json`. It is fast, it runs before
# anything is built, and it needs no bundle.
#
# Usage: scripts/signing-preflight.sh [path/to/tauri.conf.json]
set -euo pipefail
cd "$(dirname "$0")/.."

conf="${1:-client/src-tauri/tauri.conf.json}"

if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "FAIL: TAURI_SIGNING_PRIVATE_KEY is not set."
  echo "      Run scripts/updater-key.sh, then:"
  echo "        gh secret set TAURI_SIGNING_PRIVATE_KEY --env release < ~/.local/share/linger/updater.key"
  exit 1
fi

probe="$(mktemp -d)"
trap 'rm -rf "$probe"' EXIT
echo "linger signing preflight" > "$probe/probe.txt"

if ! (cd client && pnpm tauri signer sign "$probe/probe.txt") > "$probe/out.log" 2>&1; then
  echo "FAIL: the key would not sign a file."
  echo "      Usually the password secret is missing or wrong."
  echo "      TAURI_SIGNING_PRIVATE_KEY_PASSWORD must be the password you chose"
  echo "      when the key was generated. The key itself cannot be reset."
  sed 's/^/      /' "$probe/out.log"
  exit 1
fi

python3 - "$conf" "$probe/probe.txt.sig" <<'PY'
import base64
import json
import sys

conf_path, sig_path = sys.argv[1], sys.argv[2]


def key_id(blob):
    """minisign layout: algorithm[2] then the 8-byte key id, in both files."""
    return blob[2:10].hex()


def unwrap(text):
    """Tauri base64-wraps whole minisign files. Unwrap, then take the payload line."""
    inner = base64.b64decode(text.strip()).decode()
    return base64.b64decode(inner.strip().splitlines()[1])


pubkey = json.load(open(conf_path, encoding="utf-8"))["plugins"]["updater"]["pubkey"]
if not pubkey.strip():
    print("FAIL: no pubkey in", conf_path)
    print("      Run scripts/updater-key.sh and commit the change it makes.")
    sys.exit(1)

expected = key_id(unwrap(pubkey))
signed_by = key_id(unwrap(open(sig_path, encoding="utf-8").read()))

if expected != signed_by:
    print("FAIL: the signing key is not the one this app trusts.")
    print(f"      {conf_path} trusts key  {expected}")
    print(f"      TAURI_SIGNING_PRIVATE_KEY is key {signed_by}")
    print("      A release signed with it would install on nothing. Set the")
    print("      secret from the key whose public half is committed, or if that")
    print("      key is genuinely gone, understand that changing the committed")
    print("      one orphans every copy already installed.")
    sys.exit(1)

print(f"signing preflight: key {expected} signs, and it is the key the app trusts")
PY
