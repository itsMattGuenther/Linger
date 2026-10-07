#!/usr/bin/env bash
# Tests for `scripts/android-signing.sh verify`: it reads the signer from
# whatever apksigner prints, and lets an APK through only when every signer is
# the release key. A stand-in apksigner prints what real ones have printed, so
# this runs anywhere, with no Android SDK.
#
# 0.4.8's and 0.4.9's release runs refused rightly signed APKs because the
# runner's apksigner said "V2 Signer: certificate SHA-256 digest: …" and the
# check only read "Signer #1 certificate SHA-256 digest: …".
set -euo pipefail
cd "$(dirname "$0")/.."

key="$(tr -d '[:space:]' < client/src-tauri/android-release-cert.sha256)"
other="0000000000000000000000000000000000000000000000000000000000000001"

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/sdk/build-tools/99.0.0"
stand_in="$scratch/sdk/build-tools/99.0.0/apksigner"
# Prints $APKSIGNER_SAYS and exits with $APKSIGNER_EXIT, as apksigner would.
cat > "$stand_in" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$APKSIGNER_SAYS"
exit "${APKSIGNER_EXIT:-0}"
SH
chmod +x "$stand_in"
apk="$scratch/app.apk"
: > "$apk"

failures=0
run() {
  ANDROID_HOME="$scratch/sdk" APKSIGNER_SAYS="$1" APKSIGNER_EXIT="${2:-0}" \
    scripts/android-signing.sh verify "$apk" >/dev/null 2>&1
}
passes() {
  if run "$2"; then echo "ok: $1"; else echo "FAIL: $1 (refused)"; failures=$((failures + 1)); fi
}
refuses() {
  if run "$2" "${3:-0}"; then echo "FAIL: $1 (let through)"; failures=$((failures + 1)); else echo "ok: $1"; fi
}

passes "build-tools 35 and 36: Signer #1" "Signer #1 certificate DN: CN=Linger, O=Linger
Signer #1 certificate SHA-256 digest: $key
Signer #1 certificate SHA-1 digest: b51231b838ae94a1d58dd86edc124c3a56c8c35b
Signer #1 certificate MD5 digest: 04e94cdf962d0f6056db2bdaf66292e9"

passes "the release runner, 0.4.9: V2 Signer" "V2 Signer: certificate DN: CN=Linger, O=Linger
V2 Signer: certificate SHA-256 digest: $key
V2 Signer: certificate SHA-1 digest: b51231b838ae94a1d58dd86edc124c3a56c8c35b
V2 Signer: certificate MD5 digest: 04e94cdf962d0f6056db2bdaf66292e9"

passes "one key under two schemes" "V2 Signer: certificate SHA-256 digest: $key
V3 Signer: certificate SHA-256 digest: $key"

passes "the digest in capitals, with colons" "Signer #1 certificate SHA-256 digest: $(printf '%s' "$key" | tr 'a-f' 'A-F' | sed 's/../&:/g; s/:$//')"

refuses "another key" "V2 Signer: certificate SHA-256 digest: $other"

refuses "the release key and another" "Signer #1 certificate SHA-256 digest: $key
Signer #2 certificate SHA-256 digest: $other"

refuses "no signer line at all" "Verifies"

refuses "apksigner rejects the APK" "DOES NOT VERIFY" 1

rm -f "$apk"
refuses "no APK" "Signer #1 certificate SHA-256 digest: $key"

if [ "$failures" -gt 0 ]; then
  echo "$failures android-signing check(s) failed" >&2
  exit 1
fi
echo "android-signing: all checks passed"
