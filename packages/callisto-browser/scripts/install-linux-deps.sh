#!/usr/bin/env bash
# Install system packages required to compile Chromium / Callisto Browser on Ubuntu.
# Requires sudo (interactive password if needed).
set -euo pipefail

echo "Installing build-essential, pkg-config, and common Chromium libs…"
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y \
  build-essential curl git python3-venv python3-dev pkg-config \
  lld ninja-build \
  libnss3-dev libnspr4-dev libatk-bridge2.0-dev libdrm-dev \
  libxkbcommon-dev libxcomposite-dev libxdamage-dev libxrandr-dev \
  libgbm-dev libasound2-dev libpango1.0-dev libcups2-dev \
  libx11-xcb-dev libxcb-dri3-dev libxss-dev libgtk-3-dev \
  libpulse-dev libffi-dev libdbus-1-dev libxtst-dev

echo
echo "Optional: after Chromium src is checked out, run the official helper:"
echo "  cd \"\$CHROMIUM_SRC/..\" && build/install-build-deps.sh"
echo "Done."
