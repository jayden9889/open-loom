#!/usr/bin/env bash
# Give the installed OpenLoom.app a STABLE code signature so macOS stops
# dropping Screen Recording and keychain access on every update.
#
# Why this exists: TCC (the permissions system) pins every grant to the exact
# code signature it approved. A build with no signing identity (no Apple
# Developer account) presents a new ad-hoc signature every time it is packaged,
# so after each update - and after some macOS updates - System Settings keeps
# showing the Screen Recording switch ON while the OS refuses the binary
# underneath. The same mechanism breaks safeStorage (keychain), which is why
# the app forgets API keys and the YouTube connection after updates.
#
# Signing every build with ONE long-lived local certificate gives the app a
# stable identity, so grants and keychain access survive updates. The
# certificate is self-signed and lives only in your login keychain: it does
# not notarise the app or change anything for other people's downloads.
#
# Run after every install/update of OpenLoom.app:
#   bash scripts/mac-sign-local.sh
# The first run creates the certificate; macOS will ask for your login
# password once or twice (trust settings + key access) - that is expected.
set -euo pipefail

CERT_NAME="OpenLoom Local Signing"
APP="${1:-/Applications/OpenLoom.app}"
BUNDLE_ID="org.openloom.app"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

[[ "$(uname)" == "Darwin" ]] || { echo "This script is macOS-only."; exit 1; }
[[ -d "$APP" ]] || { echo "App not found at $APP"; exit 1; }

if ! security find-identity -v -p codesigning | grep -q "$CERT_NAME"; then
  echo "Creating local code-signing certificate '$CERT_NAME' (one-time)..."
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  cat > "$TMP/ext.cnf" <<'EOF'
[req]
distinguished_name = dn
[dn]
[v3]
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
basicConstraints = critical,CA:false
EOF
  openssl req -x509 -newkey rsa:2048 -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
    -days 3650 -nodes -subj "/CN=$CERT_NAME" -extensions v3 -config "$TMP/ext.cnf" 2>/dev/null
  openssl pkcs12 -export -out "$TMP/cert.p12" -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
    -passout pass:openloom-local
  security import "$TMP/cert.p12" -k "$KEYCHAIN" -P openloom-local -T /usr/bin/codesign
  # Trust it for code signing in the user domain (GUI may ask for your password).
  security add-trusted-cert -p codeSign -k "$KEYCHAIN" "$TMP/cert.pem"
fi

echo "Signing $APP with '$CERT_NAME'..."
# If codesign asks for keychain access, click "Always Allow" so future runs are silent.
codesign --force --deep --sign "$CERT_NAME" "$APP"
codesign --verify --deep --strict "$APP"
echo "Signature OK: $(codesign -dv "$APP" 2>&1 | grep '^Authority' | head -1 || echo 'signed')"

echo "Clearing the stale Screen Recording entry so it can be granted fresh..."
tccutil reset ScreenCapture "$BUNDLE_ID" || true

open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" || true

cat <<'EOF'

Done. Two steps left, in the Settings pane that just opened:

 1. Screen Recording list: tick OpenLoom ON.
    (If it already shows ticked, untick it, then tick it again.)
 2. Quit and reopen OpenLoom.

First launch after signing may ask for keychain access
("OpenLoom Safe Storage") - click Always Allow so your API key and
YouTube connection survive updates too.
EOF
