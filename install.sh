#!/bin/sh
# Keyturn installer for a Linux server, where your AI assistant runs (server mode).
#   curl -fsSL https://keys.aiforge.uk/install.sh | sh
# Installs for this Linux account only (no root). Running it again updates Keyturn.
# Optional: KEYTURN_NAME="Service Assistant" sets the name your phone shows (default: this server's hostname).
# Your vault (~/.local/share/keyturn) and this server's key (~/.local/state/keyturn) are never touched.
set -eu

VERSION='1.1.0'
TAR_SHA256='1f2ada448288cdd646fe4e46f003a607730082fb5cc9d69004fa4d980a2a405a'
TAR_URL="https://github.com/VincentPorquet777/keyturn/releases/download/v$VERSION/keyturn-$VERSION-server.tar.gz"
NODE_VERSION='v24.22.3'

DIR="${KEYTURN_HOME:-$HOME/.local/share/keyturn-app}"
BIN="${KEYTURN_BIN:-$HOME/.local/bin}"
NAME="${KEYTURN_NAME:-$(hostname)}"
SYSTEM="${KEYTURN_NO_SYSTEM:-}"   # tests: no systemd unit, nothing started

say() { printf '%s\n' "$*"; }
die() { printf 'Keyturn: %s\n' "$*" >&2; exit 1; }
sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
fetch() { curl -fsSL --proto '=https' --tlsv1.2 -o "$2" "$1"; }

say ""
say "Keyturn $VERSION (server mode)"
[ "$(uname -s)" = Linux ] || die "this installer is for Linux. On Windows: irm https://keys.aiforge.uk/install.ps1 | iex"
command -v curl >/dev/null 2>&1 || die "curl is needed"
case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) die "unsupported processor $(uname -m)" ;; esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1. Keyturn itself, checked against the fingerprint in this installer.
say "Downloading Keyturn $VERSION..."
fetch "$TAR_URL" "$TMP/keyturn.tar.gz"
[ "$(sha256 "$TMP/keyturn.tar.gz")" = "$TAR_SHA256" ] || die "the download does not match its fingerprint. Nothing was installed."
mkdir -p "$TMP/new" && tar -xzf "$TMP/keyturn.tar.gz" -C "$TMP/new"

# 2. Its own copy of Node.js (from nodejs.org, checked against nodejs.org's list), so nothing else is needed.
NODE="$DIR/node/bin/node"
if [ ! -x "$NODE" ] || [ "$("$NODE" --version 2>/dev/null)" != "$NODE_VERSION" ]; then
  say "Downloading Node.js $NODE_VERSION ($ARCH)..."
  NODE_NAME="node-$NODE_VERSION-linux-$ARCH"
  fetch "https://nodejs.org/dist/$NODE_VERSION/$NODE_NAME.tar.xz" "$TMP/node.tar.xz"
  fetch "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" "$TMP/SHASUMS256.txt"
  WANT="$(grep " $NODE_NAME.tar.xz\$" "$TMP/SHASUMS256.txt" | cut -d' ' -f1)"
  [ -n "$WANT" ] && [ "$(sha256 "$TMP/node.tar.xz")" = "$WANT" ] || die "the Node.js download does not match nodejs.org. Nothing was installed."
  mkdir -p "$TMP/node" && tar -xJf "$TMP/node.tar.xz" -C "$TMP/node" --strip-components=1
  NEW_NODE=1
fi

# 3. Swap the files in (stopping the running copy only now). The vault and this server's key live elsewhere.
umask 077
mkdir -p "$DIR" "$BIN"
if [ -z "$SYSTEM" ] && command -v systemctl >/dev/null 2>&1; then systemctl --user stop keyturn 2>/dev/null || true; fi
rm -rf "$DIR/app" && mv "$TMP/new/app" "$DIR/app"
for f in README.md LICENSE; do [ -f "$TMP/new/$f" ] && cp "$TMP/new/$f" "$DIR/$f"; done
if [ "${NEW_NODE:-}" = 1 ]; then rm -rf "$DIR/node" && mv "$TMP/node" "$DIR/node"; fi
chmod -R go-rwx "$DIR"

cat > "$BIN/keyturn" <<EOF
#!/bin/sh
exec "$NODE" "$DIR/app/keyturn.js" "\$@"
EOF
chmod 700 "$BIN/keyturn"

# 4. Run it as a service of this account, started with the server.
if [ -z "$SYSTEM" ]; then
  if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
    UNIT="$HOME/.config/systemd/user"
    mkdir -p "$UNIT"
    cat > "$UNIT/keyturn.service" <<EOF
[Unit]
Description=Keyturn: secrets vault, opened by your phone
After=network-online.target

[Service]
ExecStart=$NODE $DIR/app/server.js
Environment=KEYTURN_PC_NAME=$NAME
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now keyturn >/dev/null 2>&1
    command -v loginctl >/dev/null 2>&1 && [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" != yes ] && \
      say "Note: to keep Keyturn running while you are logged out, an admin runs: loginctl enable-linger $(id -un)"
  else
    say "No systemd user session here. Start Keyturn with:  KEYTURN_PC_NAME=\"$NAME\" $NODE $DIR/app/server.js &"
  fi
fi

say ""
say "Keyturn $VERSION is installed: $BIN/keyturn"
case ":$PATH:" in *":$BIN:"*) ;; *) say "Add $BIN to your PATH to use the keyturn command." ;; esac
say "Next: your assistant runs 'keyturn setup' and sends you the link."
