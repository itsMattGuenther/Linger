#!/usr/bin/env bash
# The Tauri updater signing key (T-701; ARCHITECTURE §7, baseline 8).
#
# Every update Linger installs is verified against one minisign public key that
# is compiled into the app. Whoever holds the matching private key can ship an
# update to every machine running Linger, and nobody else can. Two consequences,
# both permanent:
#
#   * Lose the private key and you can never ship an update again. Not to your
#     own machines, not to anyone's. The only way out is to hand-install a new
#     build carrying a new public key, on every computer.
#   * Leak the private key and whoever has it can push code to every machine
#     running Linger.
#
# So: it is generated once, on a machine you trust, with a password, and backed
# up offline before anything ships. This script does the generating part and
# tells you the rest. It never writes the private key inside the repo.
#
# Usage: scripts/updater-key.sh
#   LINGER_UPDATER_KEY=/path/to/updater.key scripts/updater-key.sh
#
# Running it again when a key already exists prints the public key and the
# checklist again. It will not overwrite an existing key — that is the one
# mistake this script exists to make impossible.
set -euo pipefail
cd "$(dirname "$0")/.."
repo="$PWD"

default_dir="${XDG_DATA_HOME:-$HOME/.local/share}/linger"
key="${LINGER_UPDATER_KEY:-$default_dir/updater.key}"
pub="$key.pub"
conf="client/src-tauri/tauri.conf.json"

# A private key inside the working tree is one `git add -A` away from being
# public. .gitignore covers `*.key`, but a rule you are relying on is a rule
# somebody will change.
key_dir="$(dirname "$key")"
case "$(cd "$key_dir" 2>/dev/null && pwd || echo "$key_dir")" in
  "$repo"|"$repo"/*)
    echo "refusing to write the signing key inside the repository: $key" >&2
    echo "set LINGER_UPDATER_KEY to a path outside $repo" >&2
    exit 1
    ;;
esac

if [ -e "$key" ]; then
  echo "a signing key already exists at $key — leaving it alone"
else
  if [ ! -d client/node_modules ]; then
    echo "the Tauri CLI comes from client/node_modules; run 'pnpm install' in client/ first" >&2
    exit 1
  fi
  mkdir -p "$key_dir"
  chmod 700 "$key_dir"
  echo "Generating the updater signing key at $key"
  echo "Choose a password you can retrieve from your password manager in five"
  echo "years. It goes into the release workflow as a secret, and there is no"
  echo "way to reset it."
  echo
  (cd client && pnpm tauri signer generate -w "$key")
  chmod 600 "$key"
fi

if [ ! -f "$pub" ]; then
  echo "expected the public key at $pub and it is not there" >&2
  exit 1
fi

pubkey="$(tr -d '\n' < "$pub")"

# The public key is public — it belongs in the committed config, which is the
# only place the running app looks for it.
python3 - "$conf" "$pubkey" <<'PY'
import json
import sys

conf_path, pubkey = sys.argv[1], sys.argv[2]
with open(conf_path, encoding="utf-8") as handle:
    text = handle.read()
current = json.loads(text)["plugins"]["updater"]["pubkey"]
if current == pubkey:
    print(f"{conf_path} already carries this public key")
    sys.exit(0)
if current:
    print(f"REFUSING: {conf_path} carries a different public key already.")
    print("Replacing it orphans every installed copy — they will reject the")
    print("update as unsigned and have to be reinstalled by hand. If that is")
    print("really what you want, edit the file yourself.")
    sys.exit(1)
# Rewritten as text, not re-dumped, so the file keeps its formatting.
with open(conf_path, "w", encoding="utf-8") as handle:
    handle.write(text.replace('"pubkey": ""', f'"pubkey": "{pubkey}"', 1))
print(f"wrote the public key into {conf_path} — commit that change")
PY

cat <<EOF

Before anything ships, all four of these:

  1. Back up $key somewhere offline. A password manager
     attachment, a printed copy in a drawer, an encrypted USB stick in a
     different building. Not a cloud drive that syncs from this machine, and
     not only this machine.
  2. Back up the password the same way, separately.
  3. Add two secrets to the `release` environment on GitHub
     (Settings -> Environments -> release), never to the repository:
       TAURI_SIGNING_PRIVATE_KEY           the contents of $key
       TAURI_SIGNING_PRIVATE_KEY_PASSWORD  the password you just chose
  4. Commit the public key in $conf.

The private key never goes in git, never goes in a chat message, and never
leaves this machine except into the backup and the GitHub secret.
EOF
