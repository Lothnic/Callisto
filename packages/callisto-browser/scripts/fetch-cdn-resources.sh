#!/usr/bin/env bash
# Fetch BrowserOS server resource bundles from the public CDN (no R2 keys).
# Populates packages/callisto-browser/.work/browseros/resources/binaries/…
# so builds can use --no-download.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${CALLISTO_BROWSER_WORK:-$ROOT/.work/browseros}"
CDN="${BROWSEROS_CDN:-https://cdn.browseros.com}"
TMP="${TMPDIR:-/tmp}/browseros-cdn-resources"
ARCH="${1:-linux-x64}"  # linux-x64 | linux-arm64 | …

case "$ARCH" in
  linux-x64) OS_ARCH_KEY=linux-x64; CLAW_KEY=linux-x64 ;;
  linux-arm64) OS_ARCH_KEY=linux-arm64; CLAW_KEY=linux-arm64 ;;
  *) echo "usage: $0 [linux-x64|linux-arm64]" >&2; exit 1 ;;
esac

if [[ ! -d "$WORK/bos_build" ]]; then
  echo "error: work tree missing at $WORK — run scripts/sync-upstream.sh first" >&2
  exit 1
fi

mkdir -p "$TMP" "$WORK/resources/binaries"
# shellcheck disable=SC1091
source "${CALLISTO_BROWSER_VENV:-$HOME/src/browseros-venv}/bin/activate"

extract() {
  local key="$1" dest="$2"
  local zip="$TMP/$(basename "$key")"
  echo "→ $CDN/$key"
  curl -fL --retry 3 --retry-delay 2 -o "$zip" "$CDN/$key"
  rm -rf "$dest"
  mkdir -p "$dest"
  python3 -c "
from pathlib import Path
from bos_build.steps.storage.download import extract_artifact_zip
extract_artifact_zip(Path('$zip'), Path('$dest'))
print('  extracted → $dest')
"
}

extract "artifacts/server/latest/browseros-server-resources-${OS_ARCH_KEY}.zip" \
  "$WORK/resources/binaries/browseros_server/${OS_ARCH_KEY}"
extract "claw-server/prod-resources/latest/browseros-claw-server-resources-${CLAW_KEY}.zip" \
  "$WORK/resources/binaries/browseros_claw_server/${CLAW_KEY}"
extract "claw-onboard/prod-resources/latest/browseros-claw-onboard-resources.zip" \
  "$WORK/resources/binaries/browseros_claw_onboard"

echo "Done. Binaries under $WORK/resources/binaries"
du -sh "$WORK/resources/binaries"/*
