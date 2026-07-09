#!/usr/bin/env bash
# Build Callisto Browser for Linux using the BrowserOS build CLI on a synced work tree.
#
# Prerequisites:
#   - ./scripts/sync-upstream.sh
#   - CHROMIUM_SRC pointing at Chromium src @ CHROMIUM_VERSION pin
#   - ~100GB disk, Python 3.12+, depot_tools, Chromium Linux deps
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${CALLISTO_BROWSER_WORK:-$ROOT/.work/browseros}"
CONFIG="build/config/release.linux.yaml"

usage() {
  cat <<EOF
Usage: $0 --chromium-src DIR [options]

Options:
  --chromium-src DIR   Chromium src checkout (required for compile)
  --sync               Run sync-upstream.sh first
  --prep-only          Sync + install CLI only (no compile)
  --list               List browseros build modules
  -h, --help           Show help
EOF
}

CHROMIUM_SRC="${CHROMIUM_SRC:-}"
DO_SYNC=0
PREP_ONLY=0
LIST=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --chromium-src) CHROMIUM_SRC="$2"; shift 2 ;;
    --sync) DO_SYNC=1; shift ;;
    --prep-only) PREP_ONLY=1; shift ;;
    --list) LIST=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 1 ;;
  esac
done

"$ROOT/scripts/check-env.sh" || true

if (( DO_SYNC )) || [[ ! -d "$WORK" ]]; then
  "$ROOT/scripts/sync-upstream.sh"
fi

if [[ ! -d "$WORK" ]]; then
  echo "error: work tree missing; run sync-upstream.sh" >&2
  exit 1
fi

echo "→ install BrowserOS build CLI from work tree"
python3 -m pip install -e "$WORK" -q

if (( LIST )); then
  (cd "$WORK" && browseros build --list) || (cd "$WORK" && python3 -m build.browseros build --list)
  exit 0
fi

if (( PREP_ONLY )); then
  echo "Prep complete. Work tree: $WORK"
  echo "Install OK. When ready:"
  echo "  export CHROMIUM_SRC=/path/to/chromium/src"
  echo "  $0 --chromium-src \"\$CHROMIUM_SRC\""
  exit 0
fi

if [[ -z "$CHROMIUM_SRC" || ! -d "$CHROMIUM_SRC" ]]; then
  echo "error: --chromium-src DIR is required for a full build" >&2
  echo "Hint: first-time setup is multi-hour. Use --prep-only until CHROMIUM_SRC exists." >&2
  exit 1
fi

echo "→ building Callisto Browser (BrowserOS pipeline + Callisto overlay)"
echo "  WORK=$WORK"
echo "  CHROMIUM_SRC=$CHROMIUM_SRC"
echo "  CONFIG=$CONFIG"

cd "$WORK"
if command -v browseros >/dev/null; then
  browseros build --config "$CONFIG" --chromium-src "$CHROMIUM_SRC"
else
  python3 -m build.browseros build --config "$CONFIG" --chromium-src "$CHROMIUM_SRC"
fi

echo
echo "Build finished (if no errors)."
echo "Linux binary is typically: \$CHROMIUM_SRC/out/Default_*/callisto or browseros"
echo "Set CALLISTO_BROWSER_PATH to that binary for Mini/run.sh."
