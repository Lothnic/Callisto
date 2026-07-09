#!/usr/bin/env bash
# Sync BrowserOS packages/browseros into a local work tree, overlay Callisto branding.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BROWSEROS_SRC="${BROWSEROS_SRC:-$HOME/src/BrowserOS/packages/browseros}"
# Fallbacks for older machines
if [[ ! -d "$BROWSEROS_SRC" && -d "$HOME/Desktop/OpenSource/BrowserOS/packages/browseros" ]]; then
  BROWSEROS_SRC="$HOME/Desktop/OpenSource/BrowserOS/packages/browseros"
fi
WORK="${CALLISTO_BROWSER_WORK:-$ROOT/.work/browseros}"

if [[ ! -d "$BROWSEROS_SRC" ]]; then
  echo "error: BROWSEROS_SRC not found: $BROWSEROS_SRC" >&2
  echo "Clone: git clone https://github.com/browseros-ai/BrowserOS.git ~/src/BrowserOS" >&2
  exit 1
fi

mkdir -p "$(dirname "$WORK")"
echo "→ syncing $BROWSEROS_SRC → $WORK"
rsync -a --delete \
  --exclude '.git' \
  --exclude '__pycache__' \
  --exclude '*.pyc' \
  --exclude '.work' \
  --exclude '.venv' \
  "$BROWSEROS_SRC/" "$WORK/"

echo "→ overlay Callisto version pins"
if [[ -f "$ROOT/CHROMIUM_VERSION" ]]; then
  cp -f "$ROOT/CHROMIUM_VERSION" "$WORK/CHROMIUM_VERSION"
fi
if [[ -f "$ROOT/CALLISTO_BROWSER_VERSION" ]]; then
  mkdir -p "$WORK/resources"
  cp -f "$ROOT/CALLISTO_BROWSER_VERSION" "$WORK/resources/CALLISTO_BROWSER_VERSION"
fi

echo "→ overlay branding files"
if [[ -d "$ROOT/branding" ]]; then
  mkdir -p "$WORK/chromium_files/chrome/app/theme/chromium"
  cp -f "$ROOT/branding/BRANDING.release" \
    "$WORK/chromium_files/chrome/app/theme/chromium/BRANDING.callisto-release" 2>/dev/null || true
  cp -f "$ROOT/branding/BRANDING.debug" \
    "$WORK/chromium_files/chrome/app/theme/chromium/BRANDING.callisto-debug" 2>/dev/null || true
fi

echo "→ copy Callisto-only patches (if any)"
if [[ -d "$ROOT/chromium_patches" ]]; then
  mkdir -p "$WORK/chromium_patches_callisto"
  rsync -a "$ROOT/chromium_patches/" "$WORK/chromium_patches_callisto/" \
    --exclude 'README.md' || true
fi

cat > "$WORK/CALLISTO_OVERLAY.json" <<EOF
{
  "synced_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "browseros_src": "$BROWSEROS_SRC",
  "callisto_browser": "$ROOT",
  "work": "$WORK"
}
EOF

echo
echo "Sync complete: $WORK"
