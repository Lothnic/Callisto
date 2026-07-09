#!/usr/bin/env bash
# Sync BrowserOS packages/browseros into a local work tree, then overlay Callisto branding.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BROWSEROS_SRC="${BROWSEROS_SRC:-$HOME/Desktop/OpenSource/BrowserOS/packages/browseros}"
WORK="${CALLISTO_BROWSER_WORK:-$ROOT/.work/browseros}"

if [[ ! -d "$BROWSEROS_SRC" ]]; then
  echo "error: BROWSEROS_SRC not found: $BROWSEROS_SRC" >&2
  echo "Set BROWSEROS_SRC or clone BrowserOS to ~/Desktop/OpenSource/BrowserOS" >&2
  exit 1
fi

mkdir -p "$(dirname "$WORK")"
echo "→ syncing $BROWSEROS_SRC → $WORK"
rsync -a --delete \
  --exclude '.git' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude '.work' \
  "$BROWSEROS_SRC/" "$WORK/"

echo "→ overlay Callisto version pins"
cp -f "$ROOT/CHROMIUM_VERSION" "$WORK/CHROMIUM_VERSION" 2>/dev/null || true
cp -f "$ROOT/CALLISTO_BROWSER_VERSION" "$WORK/resources/CALLISTO_BROWSER_VERSION"

echo "→ overlay branding files"
mkdir -p "$WORK/chromium_files/chrome/app/theme/chromium"
# Map Callisto BRANDING into the paths BrowserOS packaging expects when present.
if [[ -f "$ROOT/branding/BRANDING.release" ]]; then
  # BrowserOS uses BRANDING.release under theme/chromium/ — write Callisto values
  # as a drop-in companion for operators applying string_replaces later.
  cp -f "$ROOT/branding/BRANDING.release" "$WORK/chromium_files/chrome/app/theme/chromium/BRANDING.callisto-release"
  cp -f "$ROOT/branding/BRANDING.debug" "$WORK/chromium_files/chrome/app/theme/chromium/BRANDING.callisto-debug"
fi

echo "→ copy Callisto-only patches (if any)"
if [[ -d "$ROOT/chromium_patches" ]]; then
  mkdir -p "$WORK/chromium_patches_callisto"
  rsync -a "$ROOT/chromium_patches/" "$WORK/chromium_patches_callisto/" \
    --exclude 'README.md'
fi

echo "→ write overlay stamp"
cat > "$WORK/CALLISTO_OVERLAY.json" <<EOF
{
  "synced_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "browseros_src": "$BROWSEROS_SRC",
  "callisto_browser": "$ROOT",
  "work": "$WORK"
}
EOF

echo
echo "Sync complete."
echo "  work tree: $WORK"
echo "  next: ./scripts/build-linux.sh --chromium-src \"\$CHROMIUM_SRC\""
echo "  or:   cd $WORK && pip install -e . && browseros build --help"
