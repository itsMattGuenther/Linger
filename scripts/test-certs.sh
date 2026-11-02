#!/usr/bin/env bash
# A throwaway certificate authority and a certificate for 127.0.0.1 and
# localhost, signed by it, for scripts/https-front.mjs: the iPhone Simulator
# check trusts the authority and reaches a server on the same Mac over https,
# as the installed app reaches a real one (.github/workflows/ios-simulator.yml).
#
# Usage: scripts/test-certs.sh <dir>
# Writes ca.pem (the authority, the one file to trust), cert.pem and key.pem
# (what the front serves). Both last two days.
#
# What each part has is what the iPhone and rustls ask of a server
# certificate: the names in subjectAltName (the common name isn't read), the
# serverAuth extended key usage, and an authority marked as one, with the
# certificate it signs marked as not one. Works with OpenSSL and with the
# LibreSSL macOS has.
set -euo pipefail

dir="${1:?usage: scripts/test-certs.sh <dir>}"
mkdir -p "$dir"
cd "$dir"

cat > ca.cnf <<'EOF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = Linger test authority
[ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
EOF

cat > cert.cnf <<'EOF'
[req]
distinguished_name = dn
prompt = no
[dn]
CN = localhost
[server]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = IP:127.0.0.1, DNS:localhost
authorityKeyIdentifier = keyid
subjectKeyIdentifier = hash
EOF

openssl req -x509 -new -newkey rsa:2048 -nodes -sha256 -days 2 \
  -config ca.cnf -extensions ca -keyout ca.key -out ca.pem
openssl req -new -newkey rsa:2048 -nodes -sha256 \
  -config cert.cnf -keyout key.pem -out cert.csr
openssl x509 -req -sha256 -days 2 -in cert.csr -CA ca.pem -CAkey ca.key -set_serial "0x$(openssl rand -hex 8)" \
  -extfile cert.cnf -extensions server -out cert.pem
rm -f cert.csr ca.key ca.cnf cert.cnf
