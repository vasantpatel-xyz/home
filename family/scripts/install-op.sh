#!/usr/bin/env bash
# Installs the 1Password CLI (op) on a Debian/Ubuntu Linux box such as the
# Claude Code cloud container. Idempotent. Needs network access to
# downloads.1password.com (apt route) or cache.agilebits.com (zip route).
set -euo pipefail

if command -v op >/dev/null 2>&1; then
  echo "op already installed: $(op --version)"; exit 0
fi

SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
ARCH="$(dpkg --print-architecture 2>/dev/null || uname -m)"
case "$ARCH" in x86_64) ARCH=amd64;; aarch64) ARCH=arm64;; esac

# Route 1: official apt repository (always the current release).
if command -v apt-get >/dev/null 2>&1; then
  if curl -fsSL https://downloads.1password.com/linux/keys/1password.asc \
      | $SUDO gpg --dearmor --yes --output /usr/share/keyrings/1password-archive-keyring.gpg 2>/dev/null; then
    echo "deb [arch=$ARCH signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$ARCH stable main" \
      | $SUDO tee /etc/apt/sources.list.d/1password.list >/dev/null
    if $SUDO apt-get update -qq && $SUDO apt-get install -y -qq 1password-cli; then
      echo "op installed via apt: $(op --version)"; exit 0
    fi
    echo "apt route failed, trying direct download…" >&2
  fi
fi

# Route 2: pinned zip from 1Password's CDN. Override with OP_VERSION=x.y.z if needed.
OP_VERSION="${OP_VERSION:-2.31.1}"
TMP="$(mktemp -d)"
URL="https://cache.agilebits.com/dist/1P/op2/pkg/v${OP_VERSION}/op_linux_${ARCH}_v${OP_VERSION}.zip"
echo "Downloading $URL"
curl -fsSL -o "$TMP/op.zip" "$URL"
unzip -q -o "$TMP/op.zip" -d "$TMP"
$SUDO install -m 0755 "$TMP/op" /usr/local/bin/op
rm -rf "$TMP"
echo "op installed: $(op --version)"
